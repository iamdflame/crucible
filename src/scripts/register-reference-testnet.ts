/**
 * Registers our four agents on BNB Smart Chain testnet's ERC-8004 registry,
 * each from the same wallet that owns it on mainnet, so the provider a testnet
 * buyer names is the agent's own key there too.
 *
 *   npx tsx --env-file=.env --env-file-if-exists=.env.local src/scripts/register-reference-testnet.ts [run]
 *
 * Set and Earn counts testnet hires, and four shortlisted marketplaces hire on
 * testnet in test $U. Each agent: tBNB for gas from the principal's testnet
 * balance when it has too little, `register` with its registration as a data:
 * URI (the form BNB's SDK decodes), then `setAgentURI` with the registration
 * naming the id it was given. Writes src/data/reference-agents-testnet.json.
 * Plan only unless `run` is given. Testnet only: nothing here touches mainnet.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatEther, parseAbi, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { REFERENCE, referenceRegistrations, type ReferenceRegistration } from "@/lib/house";
import { dataUri, sdkRegistrationTestnet } from "@/lib/house/registration";
import { ESCROW_TESTNET } from "@/lib/escrow/contracts";
import { testnetPublic, testnetWallet, TESTNET_TX } from "@/lib/chain/testnet";

const RUN = process.argv[2] === "run";
const OUT = join(process.cwd(), "src/data/reference-agents-testnet.json");
const REGISTRY = parseAbi([
  "function register(string tokenURI) returns (uint256)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function tokenURI(uint256) view returns (string)",
  "function ownerOf(uint256) view returns (address)",
  "function getAgentWallet(uint256) view returns (address)",
]);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** Enough for hundreds of deliveries at testnet's 0.1 gwei. */
const FUND = parseEther("0.03");
const norm = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as Hex;

async function main() {
  const c = testnetPublic();
  const mainnet = referenceRegistrations();
  let done: Record<string, ReferenceRegistration> = {};
  try {
    done = JSON.parse(readFileSync(OUT, "utf8")) as Record<string, ReferenceRegistration>;
  } catch {
    /* first run */
  }
  const principalKey = process.env.PRIVATE_KEY;
  if (!principalKey) throw new Error("PRIVATE_KEY is needed to fund gas on testnet");
  const principal = testnetWallet(norm(principalKey));
  console.log(`principal ${principal.account.address}: ${formatEther(await c.getBalance({ address: principal.account.address }))} tBNB`);

  for (const ref of REFERENCE) {
    const key = process.env[ref.keyEnv];
    const main = mainnet[ref.slug];
    if (!key || !main) {
      console.log(`${ref.slug}: skipped (${!key ? `${ref.keyEnv} unset` : "no mainnet registration"})`);
      continue;
    }
    const owner = privateKeyToAccount(norm(key)).address;
    const balance = await c.getBalance({ address: owner });
    console.log(`${ref.slug}: owner ${owner}, ${formatEther(balance)} tBNB; mainnet #${main.tokenId}; testnet ${done[ref.slug] ? `#${done[ref.slug]!.tokenId}` : "not registered"}`);
    if (!RUN) continue;

    if (balance < FUND / 3n) {
      const hash = await principal.sendTransaction({ to: owner, value: FUND });
      await c.waitForTransactionReceipt({ hash });
      console.log(`  funded ${formatEther(FUND)} tBNB: ${TESTNET_TX(hash)}`);
    }
    const w = testnetWallet(norm(key));
    let tokenId = done[ref.slug]?.tokenId ?? null;
    if (!tokenId) {
      const first = dataUri(sdkRegistrationTestnet(ref, null, main.tokenId));
      const hash = await w.writeContract({ address: ESCROW_TESTNET.identity, abi: REGISTRY, functionName: "register", args: [first] });
      const receipt = await c.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${ref.slug}: register reverted ${hash}`);
      const log = receipt.logs.find((l) => l.address.toLowerCase() === ESCROW_TESTNET.identity.toLowerCase() && l.topics[0] === TRANSFER);
      if (!log?.topics[3]) throw new Error(`${ref.slug}: no Transfer event in ${hash}`);
      tokenId = BigInt(log.topics[3]).toString();
      done[ref.slug] = { tokenId, owner, tokenURI: "", tx: hash, block: Number(receipt.blockNumber) };
      writeFileSync(OUT, `${JSON.stringify(done, null, 2)}\n`);
      console.log(`  registered testnet #${tokenId}: ${TESTNET_TX(hash)}`);
    }
    // The registration naming its own id, as the SDK's buyers read it.
    const want = dataUri(sdkRegistrationTestnet(ref, tokenId, main.tokenId));
    const have = await c.readContract({ address: ESCROW_TESTNET.identity, abi: REGISTRY, functionName: "tokenURI", args: [BigInt(tokenId)] }).catch(() => "");
    if (have !== want) {
      const hash = await w.writeContract({ address: ESCROW_TESTNET.identity, abi: REGISTRY, functionName: "setAgentURI", args: [BigInt(tokenId), want] });
      const receipt = await c.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${ref.slug}: setAgentURI reverted ${hash}`);
      console.log(`  registration set: ${TESTNET_TX(hash)}`);
    }
    done[ref.slug] = { ...done[ref.slug]!, tokenURI: "data: registration, A2A with ?chain=97" };
    writeFileSync(OUT, `${JSON.stringify(done, null, 2)}\n`);
    const [ownerOf, wallet] = await Promise.all([
      c.readContract({ address: ESCROW_TESTNET.identity, abi: REGISTRY, functionName: "ownerOf", args: [BigInt(tokenId)] }),
      c.readContract({ address: ESCROW_TESTNET.identity, abi: REGISTRY, functionName: "getAgentWallet", args: [BigInt(tokenId)] }).catch(() => null as Address | null),
    ]);
    console.log(`  owner ${ownerOf}, agentWallet ${wallet ?? "unreadable"}${wallet && wallet.toLowerCase() !== owner.toLowerCase() ? " (DIFFERS from the owner: quotes would fail an SDK buyer's check)" : ""}`);
  }
  if (!RUN) console.log("plan only. Re-run with `run`.");
  process.exit(0);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});

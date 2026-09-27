/**
 * Points our agents' ERC-8004 registrations at our own domain.
 *
 *   npm run set-agent-uris -- --dry
 *   npm run set-agent-uris
 *   npm run set-agent-uris -- --data --dry     the registration itself, on chain, as BNB's agent SDK writes it
 *   npm run set-agent-uris -- --data
 *
 * Each reference agent's card was registered on the platform host. The old
 * host still serves those paths, but every reader of the registry, 8004scan
 * included, shows the address a registration names, so each is moved to the
 * site's own domain with setAgentURI from the wallet that owns it.
 */

import { parseAbi, type Hex } from "viem";
import { IDENTITY_REGISTRY } from "@/lib/config";
import { marketClient, walletFor } from "@/lib/chain/market";
import { REFERENCE, referenceRegistrations } from "@/lib/house";
import { SITE } from "@/lib/site";
import { dataUri, sdkRegistration } from "@/lib/house/registration";

const REGISTRY = parseAbi(["function tokenURI(uint256) view returns (string)", "function setAgentURI(uint256 agentId, string newURI)", "function ownerOf(uint256) view returns (address)"]);
const dry = process.argv.includes("--dry");
const data = process.argv.includes("--data");

async function main() {
  if (!/mandatemarkets\.com/.test(SITE)) throw new Error(`SITE is ${SITE}; set NEXT_PUBLIC_HOST to the live domain first`);
  const regs = referenceRegistrations();
  for (const ref of REFERENCE) {
    const reg = regs[ref.slug];
    if (!reg) continue;
    const want = data ? dataUri(sdkRegistration(ref, reg.tokenId)) : `${SITE}/house/${ref.slug}/registration.json`;
    const [now, owner] = await Promise.all([
      marketClient.readContract({ address: IDENTITY_REGISTRY, abi: REGISTRY, functionName: "tokenURI", args: [BigInt(reg.tokenId)] }),
      marketClient.readContract({ address: IDENTITY_REGISTRY, abi: REGISTRY, functionName: "ownerOf", args: [BigInt(reg.tokenId)] }),
    ]);
    if (now === want) {
      console.log(`${ref.slug} #${reg.tokenId}: already ${want}`);
      continue;
    }
    const key = process.env[ref.keyEnv];
    if (!key) {
      console.log(`${ref.slug}: no ${ref.keyEnv}`);
      continue;
    }
    const wallet = walletFor((key.startsWith("0x") ? key : `0x${key}`) as Hex);
    if (wallet.account.address.toLowerCase() !== owner.toLowerCase()) throw new Error(`${ref.keyEnv} does not own #${reg.tokenId}`);
    const gas = await marketClient.estimateContractGas({ account: wallet.account, address: IDENTITY_REGISTRY, abi: REGISTRY, functionName: "setAgentURI", args: [BigInt(reg.tokenId), want] } as never);
    const price = await marketClient.getGasPrice();
    console.log(`${ref.slug} #${reg.tokenId}: ${now.slice(0, 80)} -> ${want.slice(0, 80)}${want.length > 80 ? `… (${want.length} bytes)` : ""}; ${gas} gas, ${Number(gas * price) / 1e18} BNB`);
    if (dry) continue;
    const hash = await wallet.writeContract({ address: IDENTITY_REGISTRY, abi: REGISTRY, functionName: "setAgentURI", args: [BigInt(reg.tokenId), want] } as never);
    const r = await marketClient.waitForTransactionReceipt({ hash });
    console.log(`  ${r.status} https://bscscan.com/tx/${hash}`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error((e as Error).message.split("\n")[0]);
    process.exit(1);
  },
);

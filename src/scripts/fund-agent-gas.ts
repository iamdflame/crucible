/**
 * Tops up the wallets that deliver our agents' work with BNB for gas, from
 * the test wallet, so each can pay for a set number of deliveries.
 *
 *   npx tsx --env-file=.env --env-file=.env.local src/scripts/fund-agent-gas.ts --dry
 *   npx tsx --env-file=.env --env-file=.env.local src/scripts/fund-agent-gas.ts --deliveries 400
 *
 * A delivery is one submit, measured at 158,017 gas (the same figure /status
 * uses for its warning below 50). The four agents deliver their own jobs; the
 * keeper settles them. Each is sent only what it lacks at today's gas price.
 */

import { formatEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { marketClient, walletFor } from "@/lib/chain/market";
import { providers } from "@/lib/escrow/jobs";

const DELIVERY_GAS = 158_017n;
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const dry = process.argv.includes("--dry");
const target = BigInt(arg("deliveries") ?? "400");
const hex = (raw: string) => (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;

async function main() {
  const raw = process.env.TEST_WALLET_KEY;
  if (!raw) throw new Error("TEST_WALLET_KEY is not set");
  const from = walletFor(hex(raw));
  const price = await marketClient.getGasPrice();
  const want = target * DELIVERY_GAS * price;
  const wallets: { label: string; address: Address }[] = [...providers().values()].map((p) => ({ label: p.ref.slug, address: p.owner }));
  if (process.env.AGENT_A_KEY) wallets.push({ label: "keeper A", address: privateKeyToAccount(hex(process.env.AGENT_A_KEY)).address });

  let total = 0n;
  const plan: { label: string; address: Address; send: bigint }[] = [];
  for (const w of wallets) {
    const has = await marketClient.getBalance({ address: w.address });
    const send = has >= want ? 0n : want - has;
    plan.push({ ...w, send });
    total += send;
    console.log(`${w.label.padEnd(9)} ${w.address} holds ${formatEther(has)} BNB (${has / (DELIVERY_GAS * price)} deliveries); sends ${formatEther(send)}`);
  }
  const balance = await marketClient.getBalance({ address: from.account.address });
  console.log(`total ${formatEther(total)} BNB of the test wallet's ${formatEther(balance)}, for ${target} deliveries each at ${Number(price) / 1e9} gwei`);
  if (total + 21_000n * price * BigInt(plan.length) > balance) throw new Error("the test wallet does not hold enough");
  if (dry) return;
  for (const p of plan) {
    if (p.send === 0n) continue;
    const hash = await from.sendTransaction({ to: p.address, value: p.send } as never);
    const r = await marketClient.waitForTransactionReceipt({ hash });
    console.log(`  ${p.label}: ${r.status} https://bscscan.com/tx/${hash}`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error((e as Error).message.split("\n")[0]);
    process.exit(1);
  },
);

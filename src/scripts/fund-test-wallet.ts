/**
 * Turns the BNB sent to the end-to-end test wallet into the three tokens a
 * hire on this site can be paid in, keeping some BNB for gas.
 *
 *   npm run fund-test-wallet -- --dry              say what it would swap
 *   npm run fund-test-wallet                       USD1 2, USDT 2, $U 1, 0.003 BNB kept
 *   npm run fund-test-wallet -- --usd1 3 --u 2     other amounts, in dollars
 *   npm run fund-test-wallet -- --usdt 0 --usd1 0 --u 6 --to-trial-pool
 *                                                  $U for the paid daily checks, sent to the trial pool (AGENT_A_KEY's wallet)
 *
 * Three swaps from BNB itself, so nothing is approved: USDT through the
 * PancakeSwap V2 router, USD1 and $U through the V3 router's 0.05% WBNB pools,
 * the deepest for each (read from the V3 factory before swapping). Every swap
 * carries a minimum out 3% under the quote.
 */

import { createPublicClient, createWalletClient, formatEther, formatUnits, http, parseAbi, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { PROTOCOLS } from "@/lib/config";
import { SWAP_ROUTER, USDT, WBNB } from "@/lib/chain/leash";
import { V3_FACTORY } from "@/lib/chain/prices";

const USD1: Address = "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d";
const U: Address = "0xcE24439F2D9C6a2289F741120FE202248B666666";
const V2_ROUTER = PROTOCOLS.pancakeV2Router as Address;
const FEE = 500;

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
};
const dry = process.argv.includes("--dry");
const want = { usdt: arg("usdt", 2), usd1: arg("usd1", 2), u: arg("u", 1) };
const keep = parseEther(String(arg("keep", 0.003)));

const V2 = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
]);
const V3 = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
]);
const FACTORY = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

async function main() {
  const raw = process.env.TEST_WALLET_KEY;
  if (!raw) throw new Error("TEST_WALLET_KEY is not set");
  const account = privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
  const expected = process.env.TEST_WALLET_ADDRESS;
  if (expected && expected.toLowerCase() !== account.address.toLowerCase()) throw new Error("TEST_WALLET_KEY is not the key of TEST_WALLET_ADDRESS");
  const transport = http("https://bsc-dataseed.bnbchain.org", { timeout: 30_000 });
  const pub = createPublicClient({ chain: bsc, transport });
  const wallet = createWalletClient({ account, chain: bsc, transport });

  const balance = await pub.getBalance({ address: account.address });
  // The price of BNB in USDT, from the V2 pool the first swap uses.
  const [, usdtPerBnbWei] = await pub.readContract({ address: V2_ROUTER, abi: V2, functionName: "getAmountsOut", args: [parseEther("1"), [WBNB, USDT]] });
  const price = Number(formatUnits(usdtPerBnbWei, 18));
  const total = want.usdt + want.usd1 + want.u;
  const spendable = balance > keep ? balance - keep : 0n;
  const needed = parseEther(((total / price) * 1.01).toFixed(18));
  const scale = spendable >= needed ? 1 : Number(formatEther(spendable)) / Number(formatEther(needed));
  console.log(`wallet ${account.address}: ${formatEther(balance)} BNB; BNB at $${price.toFixed(2)}; keeping ${formatEther(keep)} BNB for gas`);
  if (scale <= 0) throw new Error("nothing to swap: the wallet holds no more than the gas reserve");
  if (scale < 1) console.log(`only enough for ${(scale * 100).toFixed(0)}% of the targets; each is scaled down`);

  const bnbFor = (usd: number) => parseEther(((usd * scale) / price).toFixed(18));
  const minOut = (usd: number) => parseEther((usd * scale * 0.97).toFixed(18));
  for (const [name, token] of [["USD1", USD1], ["$U", U]] as const) {
    const pool = await pub.readContract({ address: V3_FACTORY, abi: FACTORY, functionName: "getPool", args: [token, WBNB, FEE] });
    if (/^0x0+$/.test(pool)) throw new Error(`no ${name}/WBNB pool at ${FEE / 10_000}%`);
  }
  const plan = [
    { name: "USDT", usd: want.usdt, value: bnbFor(want.usdt) },
    { name: "USD1", usd: want.usd1, value: bnbFor(want.usd1) },
    { name: "$U", usd: want.u, value: bnbFor(want.u) },
  ].filter((p) => p.usd > 0);
  // The trial pool's address, from its own key, never typed.
  const trial = process.argv.includes("--to-trial-pool") && process.env.AGENT_A_KEY ? privateKeyToAccount(((k) => (k.startsWith("0x") ? k : `0x${k}`))(process.env.AGENT_A_KEY) as `0x${string}`).address : null;
  const recipient = trial ?? account.address;
  if (trial) console.log(`  swapped tokens go to the trial pool ${trial}`);
  for (const p of plan) console.log(`  ${formatEther(p.value).slice(0, 10)} BNB -> about ${(p.usd * scale).toFixed(2)} ${p.name}`);
  if (dry) return;

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  for (const p of plan.filter((x) => x.usd > 0)) {
    const hash =
      p.name === "USDT"
        ? await wallet.writeContract({ address: V2_ROUTER, abi: V2, functionName: "swapExactETHForTokens", args: [minOut(p.usd), [WBNB, USDT], recipient, deadline], value: p.value })
        : await wallet.writeContract({
            address: SWAP_ROUTER,
            abi: V3,
            functionName: "exactInputSingle",
            args: [{ tokenIn: WBNB, tokenOut: p.name === "USD1" ? USD1 : U, fee: FEE, recipient, amountIn: p.value, amountOutMinimum: minOut(p.usd), sqrtPriceLimitX96: 0n }],
            value: p.value,
          });
    const r = await pub.waitForTransactionReceipt({ hash });
    console.log(`  ${p.name}: ${r.status} https://bscscan.com/tx/${hash}`);
    if (r.status !== "success") throw new Error(`${p.name} swap reverted`);
  }
  for (const [n, t] of [["USDT", USDT], ["USD1", USD1], ["$U", U]] as const) {
    console.log(`  now ${formatUnits(await pub.readContract({ address: t, abi: ERC20, functionName: "balanceOf", args: [recipient] }), 18)} ${n}${trial ? " in the trial pool" : ""}`);
  }
  console.log(`  and ${formatEther(await pub.getBalance({ address: account.address }))} BNB`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error((e as Error).message.split("\n")[0]);
    process.exit(1);
  },
);

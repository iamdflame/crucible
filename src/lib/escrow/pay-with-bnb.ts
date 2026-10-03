/**
 * Paying for an escrowed job in BNB, for a buyer short of $U.
 *
 * BNB Chain's ERC-8183 kernel is paid in $U and nothing else, and most people
 * who arrive here hold BNB and no $U. They were sent off to PancakeSwap and
 * did not come back. So the difference is swapped in the hire itself: exactly
 * the $U the job is short of, bought on PancakeSwap's $U/WBNB pool for at most
 * 2% more BNB than the pool's price, and every unused wei of BNB sent straight
 * back in the same transaction. Measured 3 Oct 2026: that pool (0.05%) holds
 * 2.68M $U against 1,456 WBNB, so a job's few cents move nothing.
 *
 * Where the wallet batches (EIP-5792) the swap rides in the same confirmation
 * as the job; otherwise it is one more signature, before the job is opened.
 */
import { encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { PROTOCOLS } from "@/lib/config";
import { V3_FACTORY, WBNB } from "@/lib/chain/valuation/prices";
import { ESCROW } from "@/lib/escrow/contracts";

/** The $U/WBNB pool's fee tier: 0.05%, in hundredths of a basis point. */
export const SWAP_FEE = 500;
/** At most this much above the pool's price, in basis points. */
export const MAX_SLIPPAGE_BPS = 200n;
/** The swap must land within this many seconds of being planned. */
const DEADLINE_SECONDS = 600;

const ZERO = "0x0000000000000000000000000000000000000000";
const FACTORY_ABI = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"]);
const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)",
  "function token0() view returns (address)",
]);
export const SWAP_ROUTER_ABI = parseAbi([
  "function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountIn)",
  "function refundETH() payable",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
]);

/**
 * The BNB that buys exactly `out` $U at the pool's price, before its fee.
 * Rounded up: a swap that asks one wei too little fails, one that asks one
 * wei too much is refunded. Pure, for tests.
 */
export function bnbFor(out: bigint, sqrtPriceX96: bigint, uIsToken0: boolean): bigint {
  const Q192 = 1n << 192n;
  const p2 = sqrtPriceX96 * sqrtPriceX96;
  // The pool's price is token1 per token0 = p2 / Q192.
  const num = uIsToken0 ? out * p2 : out * Q192;
  const den = uIsToken0 ? Q192 : p2;
  return (num + den - 1n) / den;
}

/** The most BNB the swap may take: the pool's price, its 0.05% fee, and at most 2% for the price moving. */
export function maxBnbIn(base: bigint): bigint {
  const feeBps = BigInt(SWAP_FEE / 100);
  const num = base * (10_000n + MAX_SLIPPAGE_BPS) * 10_000n;
  const den = 10_000n * (10_000n - feeBps);
  return (num + den - 1n) / den;
}

export interface SwapPlan {
  /** $U the swap buys: exactly what the job is short of. */
  need: bigint;
  /** BNB at the pool's price now, before its fee. */
  quote: bigint;
  /** The most BNB it may take; the rest comes back. */
  maxIn: bigint;
  /** The router call: exactOutputSingle then refundETH, under one deadline. */
  call: RouterCall;
}

/** One router transaction: `multicall(deadline, inner)` sent with `value` BNB. */
export interface RouterCall {
  to: Address;
  data: Hex;
  value: bigint;
  deadline: bigint;
  inner: Hex[];
}

/** The router calls for a swap: buy exactly `need` $U for at most `maxIn` BNB, then hand back what is left. Pure, for tests. */
export function swapCall(buyer: Address, need: bigint, maxIn: bigint, deadline: number): RouterCall {
  const swap = encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: "exactOutputSingle",
    args: [{ tokenIn: WBNB, tokenOut: ESCROW.paymentToken as Address, fee: SWAP_FEE, recipient: buyer, amountOut: need, amountInMaximum: maxIn, sqrtPriceLimitX96: 0n }],
  });
  const refund = encodeFunctionData({ abi: SWAP_ROUTER_ABI, functionName: "refundETH" });
  const inner: Hex[] = [swap, refund];
  const data = encodeFunctionData({ abi: SWAP_ROUTER_ABI, functionName: "multicall", args: [BigInt(deadline), inner] });
  return { to: PROTOCOLS.pancakeSmartRouter as Address, data, value: maxIn, deadline: BigInt(deadline), inner };
}

/** Reads the pool now and plans the swap for `need` $U. */
export async function planSwap(client: PublicClient, buyer: Address, need: bigint, now = Math.floor(Date.now() / 1000)): Promise<SwapPlan> {
  if (need <= 0n) throw new Error("Nothing to swap: the wallet already holds the budget.");
  const pool = (await client.readContract({ address: V3_FACTORY, abi: FACTORY_ABI, functionName: "getPool", args: [WBNB, ESCROW.paymentToken as Address, SWAP_FEE] })) as Address;
  if (!pool || pool === ZERO) throw new Error("PancakeSwap has no $U and BNB pool to swap through just now.");
  const [slot0, token0] = await Promise.all([
    client.readContract({ address: pool, abi: POOL_ABI, functionName: "slot0" }) as Promise<readonly [bigint, number, number, number, number, number, boolean]>,
    client.readContract({ address: pool, abi: POOL_ABI, functionName: "token0" }) as Promise<Address>,
  ]);
  const quote = bnbFor(need, slot0[0], token0.toLowerCase() === ESCROW.paymentToken.toLowerCase());
  const maxIn = maxBnbIn(quote);
  return { need, quote, maxIn, call: swapCall(buyer, need, maxIn, now + DEADLINE_SECONDS) };
}

/**
 * Paying for a job in BNB: the swap buys exactly the $U the job is short of,
 * never asks for more than 2% over the pool's price plus its fee, and hands
 * back what it does not use. Figures from the $U/WBNB pool on 3 Oct 2026,
 * where a read-only call to PancakeSwap's router paid 0.0000643461 BNB for
 * exactly 0.05 $U against a quote of 0.0000643139.
 */

import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { bnbFor, maxBnbIn, swapCall, SWAP_ROUTER_ABI, SWAP_FEE } from "@/lib/escrow/pay-with-bnb";
import { ESCROW } from "@/lib/escrow/contracts";
import { PROTOCOLS } from "@/lib/config";

const Q96 = 1n << 96n;

describe("the BNB a swap needs", () => {
  it("is the pool's price, rounded up, whichever way round the pool holds the tokens", () => {
    // A pool at exactly 1:1.
    expect(bnbFor(10n ** 18n, Q96, false)).toBe(10n ** 18n);
    expect(bnbFor(10n ** 18n, Q96, true)).toBe(10n ** 18n);
    // 4 $U per WBNB with WBNB as token0: sqrt(4) = 2, so a quarter of the $U in BNB.
    expect(bnbFor(4n * 10n ** 18n, 2n * Q96, false)).toBe(10n ** 18n);
    // The same price with $U as token0 (0.25 WBNB per $U).
    expect(bnbFor(4n * 10n ** 18n, Q96 / 2n, true)).toBe(10n ** 18n);
    // Never rounds down to a swap that would fail.
    expect(bnbFor(1n, 2n * Q96, false)).toBe(1n);
  });

  it("caps what it may take at 2% over the price, after the 0.05% fee", () => {
    const base = 64_313_920_162_374n; // 3 Oct: 0.05 $U
    const max = maxBnbIn(base);
    expect(max).toBeGreaterThan(64_346_093_498_670n); // what the router actually took
    expect(Number(max) / Number(base)).toBeCloseTo(1.02 / 0.9995, 6);
  });
});

describe("the router call", () => {
  it("buys exactly the shortfall for the buyer, then refunds the rest, under one deadline", () => {
    const buyer = "0x00000000000000000000000000000000000b0b01";
    const c = swapCall(buyer, 50_000_000_000_000_000n, 65_633_015_073_159n, 1_800_000_000);
    expect(c.to.toLowerCase()).toBe(PROTOCOLS.pancakeSmartRouter.toLowerCase());
    expect(c.value).toBe(65_633_015_073_159n);
    const outer = decodeFunctionData({ abi: SWAP_ROUTER_ABI, data: c.data });
    expect(outer.functionName).toBe("multicall");
    const [deadline, inner] = outer.args as readonly [bigint, readonly `0x${string}`[]];
    expect(deadline).toBe(1_800_000_000n);
    const swap = decodeFunctionData({ abi: SWAP_ROUTER_ABI, data: inner[0]! });
    expect(swap.functionName).toBe("exactOutputSingle");
    const p = (swap.args as readonly [{ tokenOut: string; recipient: string; amountOut: bigint; amountInMaximum: bigint; fee: number }])[0];
    expect(p.tokenOut.toLowerCase()).toBe(ESCROW.paymentToken.toLowerCase());
    expect(p.recipient.toLowerCase()).toBe(buyer);
    expect(p.amountOut).toBe(50_000_000_000_000_000n);
    expect(p.amountInMaximum).toBe(65_633_015_073_159n);
    expect(p.fee).toBe(SWAP_FEE);
    expect(decodeFunctionData({ abi: SWAP_ROUTER_ABI, data: inner[1]! }).functionName).toBe("refundETH");
  });
});

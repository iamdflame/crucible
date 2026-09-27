/**
 * What our reference agents sell over x402, and what the buyer gets.
 *
 * Each service answers from the chain at the block it is called: Grid-1 its
 * own trading window and its next signal, Range-1 whether a position is out
 * of range and the range it would re-mint, Yield-1 where idle USDT earns more
 * right now, Guard-1 how far a Venus account is from liquidation and what
 * would restore its margin. None of them moves anyone's money on a payment:
 * our agents act only through sessions their principal granted, and a buyer's
 * 0.05 USD1 is not a grant. The answer says so.
 */

import { isAddress, type Address } from "viem";
import { snapshot, warm } from "@/lib/data/snapshots";
import { withTimeout } from "@/lib/cache";
import { readGridWindow, type GridWindow } from "@/lib/grid/window";
import { positionIdsOf, readIdle, readPositions, readVenus } from "@/lib/diagnose/positions";
import { usdtRates } from "@/lib/venus/rates";
import { SWAP_BOUND, RECIPIENT_BOUND, WBNB_USDT_POOL } from "@/lib/chain/leash";
import { bscClient } from "@/lib/chain/rpc";
import { parseAbi } from "viem";

type Input = Record<string, string>;

export interface HouseService {
  slug: string;
  name: string;
  description: string;
  inputs: { name: string; required: boolean; description: string }[];
  validate(input: Input): string | null;
  preview(input: Input): Promise<unknown>;
  run(input: Input): Promise<Record<string, unknown>>;
}

const SLOT0 = parseAbi(["function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint32,bool)"]);
/** WBNB/USDT on PancakeSwap at this block: its tick and the price of one BNB in USDT. */
export async function poolNow() {
  const [slot, block] = await Promise.all([
    bscClient().readContract({ address: WBNB_USDT_POOL, abi: SLOT0, functionName: "slot0" }),
    bscClient().getBlockNumber(),
  ]);
  const sqrt = Number(slot[0]) / 2 ** 96;
  return { tick: Number(slot[1]), usdtPerBnb: 1 / (sqrt * sqrt), block: Number(block) };
}

const NO_ACTION =
  "Nothing was executed for this payment. Our agents act only through a session the owner of the funds granted; a payment buys the answer, not authority.";

/**
 * Grid-1's window, fresh when a provider will serve its history, otherwise the
 * last stored reading. Old log ranges are served by one public provider, and
 * when it hangs the fresh read fails or takes its full timeout; the answer
 * then says which block and time the reading ends at, rather than failing a
 * buyer who has already paid. Grid-1's trading is paused, so no fill is
 * missing from a reading taken since the pause.
 */
async function gridWindow(): Promise<GridWindow> {
  const fresh = await withTimeout(readGridWindow().catch(() => null), 8_000);
  if (fresh) return fresh;
  await warm(["grid-window"]).catch(() => undefined);
  const stored = snapshot<GridWindow>("grid-window")?.payload;
  if (!stored) throw new Error("Grid-1's trading window could not be read from the chain just now, and no earlier reading is stored.");
  return stored;
}

const GRID: HouseService = {
  slug: "grid-1",
  name: "Grid-1",
  description: "Grid-1's live trading window on WBNB/USDT 0.05%, read from SwapBound's events, and its next signal at this block.",
  inputs: [],
  validate: () => null,
  async preview() {
    const w = snapshot<GridWindow>("grid-window")?.payload;
    return w ? { fills: w.fills.length, roundTrips: w.roundTrips.length, readTo: w.toBlock } : null;
  },
  async run() {
    const [w, p] = await Promise.all([gridWindow(), poolNow()]);
    const st = snapshot<{ anchorUsd?: number; lastLevel?: number; stepBps?: number; levels?: number; clipWbnb?: string; updatedAt?: string }>("grid-state")?.payload ?? null;
    let signal: string;
    if (st?.anchorUsd && st.stepBps) {
      const level = Math.max(-(st.levels ?? 4), Math.min(st.levels ?? 4, Math.round((((p.usdtPerBnb - st.anchorUsd) / st.anchorUsd) * 10_000) / st.stepBps)));
      const last = st.lastLevel ?? 0;
      const up = st.anchorUsd * (1 + ((last + 0.5) * st.stepBps) / 10_000);
      const down = st.anchorUsd * (1 + ((last - 0.5) * st.stepBps) / 10_000);
      signal =
        level > last
          ? `sell ${st.clipWbnb ?? "one clip of"} WBNB: price $${p.usdtPerBnb.toFixed(2)} has crossed up into level ${level}`
          : level < last
            ? `buy ${st.clipWbnb ?? "one clip of"} WBNB: price $${p.usdtPerBnb.toFixed(2)} has crossed down into level ${level}`
            : `hold: $${p.usdtPerBnb.toFixed(2)} is inside level ${last}; next sell above $${up.toFixed(2)}, next buy below $${down.toFixed(2)}`;
    } else {
      signal = "unknown: the grid's anchor is not published on this deployment yet";
    }
    return {
      block: p.block,
      priceUsdtPerBnb: p.usdtPerBnb,
      signal,
      policy: st ? { anchorUsd: st.anchorUsd, stepBps: st.stepBps, levels: st.levels, clipWbnb: st.clipWbnb, stateUpdatedAt: st.updatedAt } : null,
      window: {
        fills: w.fills.length,
        roundTrips: w.roundTrips.length,
        winRate: w.winRate,
        pnlUsd: w.pnlUsd,
        maxDrawdownUsd: w.maxDrawdownUsd,
        gasUsd: w.gasUsd,
        start: w.window.start,
        end: w.window.end,
        source: `SwapBound ${SWAP_BOUND} Swapped events, blocks ${w.fromBlock} to ${w.toBlock}`,
        readAt: w.readAt,
        verify: w.verify,
      },
      fills: w.fills.map((f) => ({ at: f.at, side: f.side, usdt: f.usdt, wbnb: f.wbnb, price: f.price, tx: f.tx })),
      executed: NO_ACTION,
    };
  },
};

/** Where Range-1 would re-mint a position the price has left: 150 ticks below the price to 50 above. */
function planFor(tick: number | null, inRange: boolean | null) {
  return tick === null || inRange
    ? null
    : { lower: Math.floor((tick - 150) / 10) * 10, upper: Math.floor((tick + 50) / 10) * 10 + 10, tick, note: "150 ticks below the price to 50 above, so most of the re-mint is the token the stale range already holds" };
}

const RANGE: HouseService = {
  slug: "range-1",
  name: "Range-1",
  description: "Whether your PancakeSwap V3 positions are out of range at this block, by how many ticks, and the range Range-1 would re-mint each into. Give a wallet or one position id.",
  inputs: [
    { name: "wallet", required: false, description: "a BNB Smart Chain address: every PancakeSwap V3 position it holds" },
    { name: "position", required: false, description: "or one PancakeSwap V3 position id" },
  ],
  validate: (i) =>
    i.position
      ? /^\d{1,10}$/.test(i.position)
        ? null
        : "position must be a PancakeSwap V3 position id, digits only"
      : isAddress(i.wallet ?? "")
        ? null
        : "give a wallet address or a PancakeSwap V3 position id",
  async preview(i) {
    return { wallet: i.wallet ?? null, position: i.position ?? null, price: "0.05 USD1" };
  },
  async run(i) {
    const ids = i.position ? [BigInt(i.position)] : await positionIdsOf(i.wallet as Address).catch(() => [] as bigint[]);
    const positions = ids.length ? await readPositions(ids) : [];
    const read = positions.map((pos) => ({
      position: pos.tokenId,
      pair: `${pos.symbol0 ?? pos.token0}/${pos.symbol1 ?? pos.token1} ${pos.fee / 10_000}%`,
      range: [pos.tickLower, pos.tickUpper],
      tick: pos.tick,
      inRange: pos.inRange,
      ticksOut: pos.ticksOut,
      closed: pos.closed,
      plan: planFor(pos.tick, pos.inRange),
    }));
    return {
      ...(i.position ? { position: i.position } : { wallet: i.wallet }),
      found: read.length,
      outOfRange: read.filter((r) => r.inRange === false && !r.closed).length,
      positions: read,
      detail: read.length ? null : i.position ? "the position manager does not recognise this id" : "this wallet holds no PancakeSwap V3 position",
      convention: "half open: at the upper tick a position is out",
      howRange1Acts: `Through RecipientBound (${RECIPIENT_BOUND}): withdraw, collect and re-mint with the principal written as the recipient on chain. Its own record: /desk#range-1.`,
      executed: NO_ACTION,
    };
  },
};

const YIELD: HouseService = {
  slug: "yield-1",
  name: "Yield-1",
  description: "What a wallet holds idle and where its USDT earns more at this block: Venus or Aave, with the reason Yield-1 itself only supplies to Venus.",
  inputs: [{ name: "wallet", required: true, description: "a BNB Smart Chain address" }],
  validate: (i) => (isAddress(i.wallet ?? "") ? null : "wallet must be a 0x address"),
  async preview(i) {
    return { wallet: i.wallet ?? null, price: "0.05 USD1" };
  },
  async run(i) {
    const [idle, r] = await Promise.all([readIdle(i.wallet as Address), usdtRates()]);
    const better = r.aaveApr !== null && r.aaveApr > r.venusApr ? "aave" : "venus";
    return {
      wallet: i.wallet,
      block: r.block,
      idle,
      rates: { venusUsdtApr: r.venusApr, aaveUsdtApr: r.aaveApr, blocksPerYearMeasured: Math.round(r.blocksPerYear) },
      higherRate: better,
      recommendation:
        better === "aave"
          ? "Aave pays more on USDT at this block. Yield-1 would still supply to Venus under a session, because Aave's supply takes the address to credit and no session here may be granted a call where the caller names who is paid. Supplying to Aave yourself is fine."
          : "Venus pays more on USDT at this block, and its supply credits the caller, so Yield-1 would supply there.",
      executed: NO_ACTION,
    };
  },
};

const GUARD: HouseService = {
  slug: "guard-1",
  name: "Guard-1",
  description: "A Venus account's health factor priced by Venus's own oracle, its distance from liquidation, and the repayment that would restore a 3.00 margin.",
  inputs: [{ name: "wallet", required: true, description: "a BNB Smart Chain address with a Venus position" }],
  validate: (i) => (isAddress(i.wallet ?? "") ? null : "wallet must be a 0x address"),
  async preview(i) {
    return { wallet: i.wallet ?? null, price: "0.05 USD1" };
  },
  async run(i) {
    const v = await readVenus(i.wallet as Address);
    if (!v || !v.active) return { wallet: i.wallet, venus: false, detail: "no Venus position on this address" };
    const trigger = 3.0;
    const hf = v.healthFactor ?? null;
    const weighted = (v.markets ?? []).reduce((t, m) => t + m.collateralUsd * m.collateralFactor, 0);
    const repayUsd = hf !== null && hf < trigger && v.borrowUsd ? Math.max(0, (v.borrowUsd ?? 0) - weighted / trigger) : 0;
    return {
      wallet: i.wallet,
      healthFactor: hf,
      collateralUsd: v.collateralUsd,
      borrowUsd: v.borrowUsd,
      spareCapacityUsd: v.liquidityUsd,
      shortfallUsd: v.shortfallUsd,
      markets: v.markets,
      trigger,
      recommendation:
        hf === null ? "No debt, so nothing can be liquidated." : hf < 1 ? "Liquidatable now." : repayUsd > 0 ? `Repay about $${repayUsd.toFixed(2)} of debt to bring the health factor back to ${trigger.toFixed(2)}.` : `Above ${trigger.toFixed(2)}; nothing to do.`,
      executed: NO_ACTION,
    };
  },
};

export const HOUSE_SERVICES: Record<string, HouseService> = { "grid-1": GRID, "range-1": RANGE, "yield-1": YIELD, "guard-1": GUARD };

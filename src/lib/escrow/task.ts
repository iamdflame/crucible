/**
 * What an outside agent is asked to do, written from what the buyer entered.
 *
 * An agent built on BNB's agent SDK reads its task from the job's signed
 * description, so the words must say what to do and for whom. Each job has a
 * sentence of its own; "via mandatemarkets.com" closes it, inside the signed
 * text, so the job states on chain where it was opened.
 */

import { VIA } from "./contracts";
import { sanitize } from "./sdk";

/** The task in words the agent can act on, from what the buyer entered for its job. */
export function taskFor(category: string | null, name: string, inputs: Record<string, string>, ctx: { bnbUsd?: number | null } = {}): string {
  const wallet = inputs.wallet ?? inputs.address ?? "";
  const free = (inputs.task ?? "").slice(0, 240);
  if (category === "grid-trading" && !free) return sanitize(`${gridTask(inputs, ctx.bnbUsd ?? null)}, ${VIA}`);
  const base =
    category === "health-factor" && wallet
      ? `Venus health factor, liquidation price and the repay that restores a safe level, for ${wallet}`
      : category === "rebalancing" && wallet
        ? `PancakeSwap V3 range check and re-centre plan for the positions of ${wallet}`
        : category === "grid-trading"
          ? `Grid plan: ${free || "WBNB/USDT, 1000 USD capital, 10 levels across plus or minus 10%"}`
          : category === "yield-optimisation"
            ? `Best net yield: ${free || "1000 USDT on BNB Smart Chain"}`
            : free || name;
  return sanitize(`${base}, ${VIA}`);
}


const num = (v: string | undefined) => {
  const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const round = (n: number) => (n >= 100 ? Math.round(n) : Number(n.toFixed(2)));

/**
 * A grid, stated the way a grid agent can act on it: the pair, both price
 * bounds, a stop below the lower bound, the capital and the level count. A
 * grid agent refuses a job without explicit bounds, so blank bounds are set
 * 8% either side of the price now, and the stop 5% under the lower bound.
 */
export function gridTask(inputs: Record<string, string>, bnbUsd: number | null): string {
  const pair = (inputs.pair ?? "").trim() || "WBNB/USDT";
  const lower = num(inputs.lower) ?? (bnbUsd ? round(bnbUsd * 0.92) : null);
  const upper = num(inputs.upper) ?? (bnbUsd ? round(bnbUsd * 1.08) : null);
  const capital = num(inputs.capital) ?? 1000;
  const levels = Math.min(50, Math.max(2, Math.round(num(inputs.levels) ?? 10)));
  if (!lower || !upper || lower >= upper) return `Grid plan for ${pair}: ${capital} USD capital, ${levels} levels`;
  const stop = round(lower * 0.95);
  // Worded the way grid agents on this registry parse it (tried against Lattice, 27 Sep): "between A and B".
  return `Grid plan for ${pair} between ${lower} and ${upper} USDT, stop ${stop}, capital ${capital} USD, ${levels} levels`;
}

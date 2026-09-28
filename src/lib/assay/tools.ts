/**
 * Whether what an agent can actually do fits the job its card claims.
 *
 * A card is a description anybody can write. The tools an MCP server lists,
 * or the skills an A2A card publishes, are what the software offers when it
 * is asked, which is the closest thing to a capability that can be read
 * without paying. So the probe keeps them, and this compares them with the
 * job the card claims: a grid agent whose server offers `getWeather` and
 * nothing else is a claim the software contradicts.
 *
 * It is deliberately hard to fail. Tools that say nothing about any job
 * (`ping`, `status`, `help`) are set aside, and a tool fits if its name or
 * description names anything the job involves. "Failed" needs tools that
 * were listed and none that fit. An agent that lists no tools is not
 * checked, which is the state of every x402 seller: a price is not a tool
 * list.
 */

import type { Category } from "@/lib/config";

export interface Tool {
  name: string;
  description?: string;
}

/** Words that tie a tool to a job. Matched as whole words, on the name split at underscores and capitals, and on the description. */
const JOB_WORDS: Record<Category, RegExp> = {
  rebalancing:
    /\b(rebalanc\w*|ranges?|liquidity|lp|positions?|ticks?|concentrated|recent(?:er|re)\w*|pools?|uniswap|pancake\w*|v3|impermanent)\b/,
  "grid-trading": /\b(grids?|orders?|trad(?:e|es|ing|er)|swaps?|limit|buy|sell|market ?mak\w*|dca|ladders?|levels?|signals?)\b/,
  "yield-optimisation": /\b(yields?|apy|apr|vaults?|lend\w*|suppl(?:y|ies)|stak\w*|farm\w*|earn\w*|interest|rates?|deposits?|savings?)\b/,
  "health-factor": /\b(health ?factor|liquidat\w*|collateral\w*|borrow\w*|loans?|debt\w*|venus|aave|ltv|margin|repay\w*)\b/,
};

/** Tools that exist on every server and say nothing about the job. */
const GENERIC = /^(ping|health|healthcheck|status|help|info|version|echo|about|capabilities|list_?tools|get_?info|whoami)$/i;
/*
  How an agent is hired, not what it does: the skills BNB's agent SDK gives
  every seller (negotiate a job, hear it is funded, read its status). An agent
  offering only these said nothing about its job, so they are not held against
  the job its card claims; its signed quote and delivered work are checked instead.
*/
const PROTOCOL = /erc[- ]?8183|negotiat|notify[_ ]?(the )?(seller|funded)|job[_ ]?status/i;

/** "getHealthFactor" and "get_health_factor" both read as "get health factor". */
const words = (t: Tool) =>
  `${t.name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ")} ${t.description ?? ""}`.toLowerCase();

export type ToolsFit =
  | { state: "none" }
  | { state: "fits"; fitting: string[]; listed: number }
  | { state: "mismatch"; listed: string[] };

export function toolsFit(category: Category | null, tools: Tool[] | undefined | null): ToolsFit {
  const real = (tools ?? []).filter((t) => t.name && !GENERIC.test(t.name.trim()) && !PROTOCOL.test(t.name));
  if (!category || real.length === 0) return { state: "none" };
  const fitting = real.filter((t) => JOB_WORDS[category].test(words(t))).map((t) => t.name);
  if (fitting.length) return { state: "fits", fitting, listed: real.length };
  return { state: "mismatch", listed: real.map((t) => t.name) };
}

/** A few names, for a sentence. */
export const nameSome = (names: string[], n = 3) => (names.length <= n ? names.join(", ") : `${names.slice(0, n).join(", ")} and ${names.length - n} more`);

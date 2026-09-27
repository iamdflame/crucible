/**
 * Category classification.
 *
 * The registry ships `categories: []` and `tags: []` for every agent on BSC, so
 * the four categories the brief requires do not exist in the data. Every
 * marketplace has to derive them. We derive them from the agent's own words,
 * card name, description, and declared skills, and then the Capability assay
 * independently checks whether the chain agrees with the label.
 *
 * That two-step matters: classification says what an agent *claims to be*,
 * capability says whether it has ever *behaved* like one.
 */

import type { Category } from "@/lib/config";
import { CATEGORIES } from "@/lib/config";

interface Signal {
  /**
   * Matched case-insensitively, and only where a word starts.
   *
   * Most signals here are deliberately stems, `rebalanc` is meant to catch
   * rebalancing, rebalance and rebalancer, and `spread` is meant to catch
   * spreads and spreading, so the match is a prefix test at a word boundary
   * rather than a whole-word one. What it is not is a bare substring test:
   * that is what this used to be, and it read `dca` out of "broadcaster",
   * "podcast" and "broadcast", and `apr` out of "AuraPro816".
   */
  phrase: string;
  weight: number;
  /**
   * Require the phrase to end at a word boundary too, give or take a plural.
   *
   * Set on the acronyms, which are short enough to be the opening of ordinary
   * words that mean nothing like them: `apr` begins "April", `dca` ends
   * "broadcast", and a three-letter prefix rule is too loose to tell an annual
   * rate from a month. A trailing "s" is still allowed, because "the best
   * APYs" is the plural of the signal and not a different word, dropping it
   * cost a real classification the first time this rule was written.
   */
  whole?: boolean;
}

const SIGNALS: Record<Category, Signal[]> = {
  rebalancing: [
    { phrase: "rebalanc", weight: 5 },
    { phrase: "lp range", weight: 5 },
    { phrase: "liquidity range", weight: 5 },
    { phrase: "concentrated liquidity", weight: 4 },
    { phrase: "position manager", weight: 3 },
    { phrase: "impermanent loss", weight: 3 },
    { phrase: "reset position", weight: 4 },
    { phrase: "out of range", weight: 4 },
    { phrase: "tick range", weight: 4 },
    { phrase: "liquidity provider", weight: 2 },
    { phrase: "v3 position", weight: 3 },
    // Re-centring a drifted range is the rebalancing job, in either spelling.
    { phrase: "re-centre", weight: 4 },
    { phrase: "re-center", weight: 4 },
    { phrase: "recentre", weight: 4 },
    { phrase: "recenter", weight: 4 },
  ],
  "grid-trading": [
    { phrase: "grid trad", weight: 6 },
    { phrase: "grid bot", weight: 6 },
    { phrase: "grid order", weight: 5 },
    { phrase: "grid strateg", weight: 5 },
    // An agent that sizes and costs a grid is a grid agent, whether or not it places the orders.
    { phrase: "grid plan", weight: 5 },
    { phrase: "grid level", weight: 5 },
    { phrase: "grid spacing", weight: 5 },
    { phrase: "dca", weight: 2, whole: true },
    { phrase: "limit order", weight: 2 },
    { phrase: "range trad", weight: 3 },
    { phrase: "market making", weight: 3 },
    { phrase: "spread", weight: 2 },
    { phrase: "buy low sell high", weight: 2 },
  ],
  "yield-optimisation": [
    { phrase: "yield optim", weight: 6 },
    { phrase: "yield farm", weight: 5 },
    { phrase: "apr", weight: 3, whole: true },
    { phrase: "apy", weight: 3, whole: true },
    { phrase: "auto-compound", weight: 5 },
    { phrase: "autocompound", weight: 5 },
    { phrase: "compounding", weight: 3 },
    { phrase: "highest yield", weight: 5 },
    { phrase: "vault", weight: 2 },
    { phrase: "staking reward", weight: 3 },
    { phrase: "route liquidity", weight: 4 },
    { phrase: "harvest", weight: 3 },
  ],
  "health-factor": [
    { phrase: "health factor", weight: 7 },
    { phrase: "liquidation", weight: 5 },
    { phrase: "collateral ratio", weight: 5 },
    { phrase: "ltv", weight: 3, whole: true },
    { phrase: "loan-to-value", weight: 4 },
    { phrase: "lending position", weight: 4 },
    { phrase: "borrow position", weight: 4 },
    { phrase: "margin call", weight: 3 },
    { phrase: "undercollateral", weight: 4 },
    { phrase: "venus", weight: 2 },
    { phrase: "aave", weight: 2 },
  ],
};

export interface Classification {
  category: Category | null;
  confidence: number;
  /** The phrases that drove the decision, for display. Never a black box. */
  matched: string[];
  scores: Record<Category, number>;
}

/**
 * Does this signal fire against the agent's own text?
 *
 * A word character before the phrase means the phrase is buried inside a
 * longer word rather than starting one, and that is not a match, "podcast"
 * is not a DCA bot. `whole` additionally requires the phrase to end where a
 * word ends, which is what separates the rate from the month.
 */
function matches(haystack: string, signal: Signal): boolean {
  const phrase = signal.phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tail = signal.whole ? "s?(?![a-z0-9])" : "";
  return new RegExp(`(?<![a-z0-9])${phrase}${tail}`).test(haystack);
}

export function classify(input: {
  name?: string | null;
  description?: string | null;
  skills?: string[] | null;
  tags?: string[] | null;
}): Classification {
  const haystack = [
    input.name ?? "",
    input.description ?? "",
    ...(input.skills ?? []),
    ...(input.tags ?? []),
  ]
    .join(" \n ")
    .toLowerCase();

  const scores = {} as Record<Category, number>;
  const matchedBy = {} as Record<Category, string[]>;

  for (const category of CATEGORIES) {
    let score = 0;
    const hits: string[] = [];
    for (const signal of SIGNALS[category]) {
      if (matches(haystack, signal)) {
        score += signal.weight;
        hits.push(signal.phrase);
      }
    }
    scores[category] = score;
    matchedBy[category] = hits;
  }

  const ranked = CATEGORIES.map((c) => [c, scores[c]] as const).sort(
    (a, b) => b[1] - a[1],
  );
  const [top, topScore] = ranked[0];
  const runnerUp = ranked[1][1];

  // Nothing matched: the agent's own text does not describe any of the four.
  if (topScore === 0) {
    return { category: null, confidence: 0, matched: [], scores };
  }

  // Confidence blends absolute strength with separation from the runner-up. An
  // agent that trips every category equally has told us nothing.
  const strength = Math.min(topScore / 10, 1);
  const separation = topScore === 0 ? 0 : (topScore - runnerUp) / topScore;
  const confidence = Number((strength * 0.6 + separation * 0.4).toFixed(3));

  return {
    category: top,
    confidence,
    matched: matchedBy[top],
    scores,
  };
}

/** Pulls skill strings out of the 8004scan `services` blob, whatever shape it takes. */
export function extractSkills(
  services: Record<string, unknown> | null | undefined,
): string[] {
  if (!services) return [];
  const out: string[] = [];
  for (const service of Object.values(services)) {
    if (!service || typeof service !== "object") continue;
    const skills = (service as { skills?: unknown }).skills;
    if (!Array.isArray(skills)) continue;
    for (const skill of skills) {
      if (typeof skill === "string") out.push(skill);
      else if (skill && typeof skill === "object") {
        const s = skill as { name?: unknown; description?: unknown };
        if (typeof s.name === "string") out.push(s.name);
        if (typeof s.description === "string") out.push(s.description);
      }
    }
  }
  return out;
}

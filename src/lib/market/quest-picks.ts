/**
 * The agent the quest suggests for each of the four jobs.
 *
 * Only agents the hire law passes with a paid call or an escrowed job a wallet
 * can fund now, those taking an escrowed job first, and
 * ranked by evidence before price: the most calls settled on chain first, then
 * the cheapest, then the quickest to answer. Ours are ranked by the same rule
 * and marked as ours on the page; nothing here is placed by hand.
 */

import { CATEGORIES, type Category } from "@/lib/config";
import { listings, type Listing } from "@/lib/market/listing";
import { hirePath } from "@/lib/market/hire-law";
import { hireCounts } from "@/lib/market/hires";

export interface QuestPick {
  category: Category;
  pick: Listing | null;
  /** Other agents in the job a buyer could hire instead. */
  others: number;
}

/** Evidence first, then price, then speed. Pure, for tests. */
export function rankForQuest(a: Listing, b: Listing): number {
  return (
    (b.settled ?? 0) - (a.settled ?? 0) ||
    (a.usdPrice ?? Number.POSITIVE_INFINITY) - (b.usdPrice ?? Number.POSITIVE_INFINITY) ||
    (a.probe?.latencyMs ?? Number.POSITIVE_INFINITY) - (b.probe?.latencyMs ?? Number.POSITIVE_INFINITY)
  );
}

export async function questPicks(): Promise<QuestPick[]> {
  const counts = await hireCounts().catch(() => null);
  const payable = listings(counts?.byTokenId, counts?.settled).filter((l) => {
    const v = hirePath(l);
    return v.ok && ((v.rails.some((r) => r.kind === "x402") && l.quote) || v.rails.some((r) => r.kind === "escrow"));
  });
  // An escrowed job is the hire the chain records against the agent, so an agent that takes one leads.
  const escrow = (l: Listing) => (hirePath(l).rails.some((r) => r.kind === "escrow") ? 1 : 0);
  return CATEGORIES.map((category) => {
    // Then an agent whose answer passed our conformance checks, then evidence, price and speed.
    const passed = (l: Listing) => (l.checked?.verdict === "pass" ? 1 : 0);
    const inJob = payable.filter((l) => l.category === category).sort((a, b) => escrow(b) - escrow(a) || passed(b) - passed(a) || rankForQuest(a, b));
    return { category, pick: inJob[0] ?? null, others: Math.max(0, inJob.length - 1) };
  });
}

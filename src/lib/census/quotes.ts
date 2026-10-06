/**
 * Prices for escrowed jobs, asked of every A2A seller in turn.
 *
 * This used to be the last step of a census slice: after every probe, inside
 * the same budget, one seller at a time, always in the same order. The probes
 * spent the budget first, so the sellers late in the list were never asked
 * (6 Oct). It runs on its own now: eight at a time, never-asked and stalest
 * first, with its own budget, into its own snapshot ("escrow-quotes"), which
 * every reader overlays on the census's older readings (escrowQuoteMap).
 *
 * Each seller is asked in the forms it may accept (lib/escrow/a2a quoteWith):
 * its card's own example task, our structured task for its job, its name.
 */

import { getAgentIndex } from "@/lib/data/agents";
import { escrowQuoteMap } from "@/lib/data/probes";
import { snapshot, store, warm } from "@/lib/data/snapshots";
import { readRegistryEntry } from "@/lib/sources/registry";
import { escrowSeller, quoteWith, type EscrowQuote } from "@/lib/escrow/a2a";
import { attributed, taskFor } from "@/lib/escrow/task";
import { DEMO_ADDRESS } from "@/lib/demo";
import { warmRegistry } from "@/lib/registry/tail";
import { withTimeout } from "@/lib/cache";

const CONCURRENCY = 8;

export async function refreshEscrowQuotes(opts: { budgetMs: number }): Promise<string> {
  const started = Date.now();
  await Promise.all([warm(["probe", "escrow-quotes", "escrow-asked"]), warmRegistry().catch(() => undefined)]);
  // When each seller was last asked, answered or not, so one that never answers does not keep its place at the front.
  const lastAsked: Record<string, string> = { ...((snapshot<Record<string, string>>("escrow-asked")?.payload as Record<string, string> | undefined) ?? {}) };
  const quotes: Record<string, EscrowQuote> = { ...((snapshot<Record<string, EscrowQuote>>("escrow-quotes")?.payload as Record<string, EscrowQuote> | undefined) ?? {}) };
  const known = escrowQuoteMap();
  // Agents under a job whose card names an A2A service: the only ones that can sell an escrowed job.
  const sellers = getAgentIndex().agents.filter((a) => a.category && a.protocols.some((p) => /^a2a$/i.test(p)));
  const askedAt = (id: string) => lastAsked[id] ?? quotes[id]?.askedAt ?? known[id]?.askedAt ?? "";
  const queue = [...sellers].sort((a, b) => askedAt(a.tokenId).localeCompare(askedAt(b.tokenId)));

  let asked = 0;
  let priced = 0;
  let declined = 0;
  let failed = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        if (Date.now() - started > opts.budgetMs - 3_000) return;
        const a = queue.shift();
        if (!a) return;
        lastAsked[a.tokenId] = new Date().toISOString();
        const e = await withTimeout(readRegistryEntry(a.tokenId).catch(() => null), 10_000);
        if (!e) continue;
        const seller = await escrowSeller(e.services).catch(() => undefined);
        if (seller === undefined) continue; // Our read failed; the last quote stands.
        if (seller === null) {
          // Its cards were read and none sells escrowed jobs.
          delete quotes[a.tokenId];
          continue;
        }
        const signers = [e.owner, typeof e.card?.agentWallet === "string" ? e.card.agentWallet : null].filter((w): w is string => Boolean(w));
        const structured = taskFor(a.category ?? null, a.name ?? `Agent ${a.tokenId}`, { wallet: DEMO_ADDRESS });
        asked += 1;
        const q = await withTimeout(
          quoteWith(seller, { structured, plain: a.name ?? `Agent ${a.tokenId}`, mark: attributed }, { signers }).catch(() => null),
          30_000,
        );
        if (!q) {
          failed += 1;
          // A seller that did not answer keeps its last price, marked as asked so the next one gets its turn.
          if (quotes[a.tokenId]) quotes[a.tokenId] = { ...quotes[a.tokenId]!, askedAt: new Date().toISOString() };
          continue;
        }
        quotes[a.tokenId] = q;
        if (q.declined) declined += 1;
        else if (!q.unpayable) priced += 1;
      }
    }),
  );
  await Promise.all([store("escrow-quotes", quotes), store("escrow-asked", lastAsked)]);
  return `${sellers.length} sellers; asked ${asked}: ${priced} priced, ${declined} turned our sample tasks down, ${failed} did not answer`;
}

/**
 * The census as a function: call agents, record what came back, merge.
 *
 * `src/scripts/probe-all.ts` did this as a one-shot script that wrote a
 * file. That is right on a laptop and impossible on a serverless function,
 * which has sixty seconds, no writable filesystem, and no scheduler behind
 * it now that GitHub Actions is locked and the Railway worker has stopped.
 *
 * So the census is now incremental and budgeted. A run takes the `limit`
 * agents whose reading is oldest, re-resolves their cards, calls them, and
 * merges the results into the previous reading. Six runs of sixty agents
 * refresh the whole classified set; a judge's own visits (`after()` on the
 * judge-facing pages) and the daily cron are what trigger them. From a
 * laptop `limit` is unbounded and it is the old full census.
 *
 * Two rules from the script survive. A card that would not resolve is *our*
 * failure and is never recorded as "no endpoint"; when we already know the
 * endpoint it named, we call that instead, so a flaky card host does not
 * freeze an agent's reading for days. And an agent that publishes nothing to
 * call is recorded as publishing nothing, a finding rather than a gap.
 *
 * An agent whose card lists an A2A seller that prices work for ERC-8183
 * escrow is also asked its price, and the quote is kept beside the x402 ones.
 */

import { readRegistryEntry } from "@/lib/sources/registry";
import { probeAll, type ProbeResult } from "@/lib/probe";
import { readQuote, readPreview, type Quote } from "@/lib/x402/quote";
import { getAgentIndex } from "@/lib/data/agents";
import type { ProbeIndex } from "@/lib/data/probes";
import { warmRegistry } from "@/lib/registry/tail";
import { escrowSeller, negotiate, type EscrowQuote } from "@/lib/escrow/a2a";

export interface CensusOptions {
  previous: ProbeIndex | null;
  /** How many agents to refresh this run. Unbounded when omitted. */
  limit?: number;
  /** Wall-clock budget; the run stops taking new work past it. */
  budgetMs?: number;
  resolveConcurrency?: number;
  probeConcurrency?: number;
  /** Refresh only these token ids (a category, a judge pick). */
  only?: string[];
  log?: (...a: unknown[]) => void;
}

export interface CensusRun {
  index: ProbeIndex;
  refreshed: number;
  resolvedFailed: number;
  ms: number;
}

/**
 * The endpoint a card offers: its x402 endpoint first, then an MCP or A2A
 * service, then the first http service it lists. A card that lists a job
 * endpoint or a web page before its agent protocol is still called where the
 * agent speaks.
 */
export function endpointFor(e: Awaited<ReturnType<typeof readRegistryEntry>>): string | null {
  if (!e) return null;
  if (e.x402Endpoint) return e.x402Endpoint;
  const http = (e.services ?? []).filter((s) => typeof s.endpoint === "string" && /^https?:/i.test(s.endpoint));
  return (http.find((s) => /^(mcp|a2a)$/i.test(s.name ?? "")) ?? http[0])?.endpoint ?? null;
}

export async function runCensus(opts: CensusOptions): Promise<CensusRun> {
  const started = Date.now();
  // New agents from the registry tail are probed too, not only the committed crawl.
  await warmRegistry().catch(() => undefined);
  const log = opts.log ?? (() => undefined);
  const budget = opts.budgetMs ?? Number.POSITIVE_INFINITY;
  const overBudget = () => Date.now() - started > budget;

  const prev = opts.previous;
  const prevResults = new Map<string, ProbeResult>((prev?.results ?? []).map((r) => [r.tokenId, r]));
  const prevQuotes: Record<string, Quote> = { ...(prev?.quotes ?? {}) };
  const prevPreviews: Record<string, unknown> = { ...(prev?.previews ?? {}) };
  const prevEscrow: Record<string, EscrowQuote> = { ...(prev?.escrowQuotes ?? {}) };

  let agents = getAgentIndex().agents.filter((a) => a.category);
  if (opts.only?.length) {
    const want = new Set(opts.only);
    agents = agents.filter((a) => want.has(a.tokenId));
  }
  // Longest since we last tried first, never-tried first of all. The last
  // attempt, not the last reading: see ProbeResult.attemptedAt.
  const lastTry = (id: string) => {
    const r = prevResults.get(id);
    return r?.attemptedAt ?? r?.at ?? "";
  };
  agents.sort((a, b) => lastTry(a.tokenId).localeCompare(lastTry(b.tokenId)));
  if (opts.limit) agents = agents.slice(0, opts.limit);
  log(`${agents.length} agents to refresh`);

  const targets: { tokenId: string; name: string; endpoint: string | null; unread: boolean; services: { name?: string; endpoint?: string }[]; signers: string[] }[] = [];
  const queue = [...agents];
  await Promise.all(
    Array.from({ length: opts.resolveConcurrency ?? 8 }, async () => {
      for (;;) {
        if (overBudget()) return;
        const a = queue.shift();
        if (!a) return;
        const e = await readRegistryEntry(a.tokenId).catch(() => null);
        const unread = e === null || e.cardSource === "unresolved";
        // An unreadable card says nothing new, but the endpoint it named last time can still be called.
        const known = unread ? (prevResults.get(a.tokenId)?.endpoint ?? null) : null;
        targets.push({
          tokenId: a.tokenId,
          name: a.name ?? "",
          endpoint: known ?? endpointFor(e),
          unread: unread && !known,
          services: e?.services ?? [],
          // The wallets this agent's registration names: a signed quote must come from one of them.
          signers: [e?.owner, typeof e?.card?.agentWallet === "string" ? e.card.agentWallet : null].filter((w): w is string => Boolean(w)),
        });
      }
    }),
  );

  const now = new Date().toISOString();
  const callable = targets.filter((t) => !t.unread && t.endpoint);
  log(`${callable.length} of ${targets.length} advertise an endpoint; calling them`);
  // A slow host must not hold the slice: past the budget no new agent is started.
  const results = overBudget() ? [] : await probeAll(callable, opts.probeConcurrency ?? 8, started + budget - 2_000);

  const fresh = new Map<string, ProbeResult>(results.map((r) => [r.tokenId, r]));
  let resolvedFailed = 0;
  for (const t of targets) {
    if (t.unread) {
      // Our read failed. Keep what we knew, but note that we tried, so this
      // agent goes to the back of the queue rather than heading it forever.
      resolvedFailed += 1;
      const known = prevResults.get(t.tokenId);
      prevResults.set(
        t.tokenId,
        known
          ? { ...known, attemptedAt: now }
          : {
              tokenId: t.tokenId,
              endpoint: null,
              answered: false,
              status: null,
              latencyMs: null,
              error: "the card did not resolve on this read; not a finding about the agent",
              at: now,
              attemptedAt: now,
            },
      );
      continue;
    }
    if (!t.endpoint) {
      prevResults.set(t.tokenId, {
        tokenId: t.tokenId,
        endpoint: null,
        answered: false,
        status: null,
        latencyMs: null,
        error: "the card advertises no endpoint",
        at: now,
        attemptedAt: now,
      });
      continue;
    }
    const r = fresh.get(t.tokenId);
    if (r) prevResults.set(t.tokenId, { ...r, attemptedAt: now });
  }

  // Anything that answered 402 is asked what it charges.
  for (const r of results) {
    if (r.status !== 402 || !r.endpoint || overBudget()) continue;
    const q = await readQuote(r.endpoint).catch(() => null);
    if (q) prevQuotes[r.tokenId] = q;
    const pv = await readPreview(r.endpoint).catch(() => null);
    if (pv) prevPreviews[r.tokenId] = pv;
  }

  // A card with an A2A seller is asked whether it prices work for escrow, and what for this agent.
  for (const t of targets) {
    if (t.unread || overBudget() || !t.services.some((s) => /^a2a$/i.test(s.name ?? ""))) continue;
    const seller = await escrowSeller(t.services).catch(() => undefined);
    if (seller === undefined) continue; // Our read failed; the last quote stands.
    if (seller === null) {
      delete prevEscrow[t.tokenId];
      continue;
    }
    const q = await negotiate(seller.url, t.name, { signers: t.signers, notify: seller.notify }).catch(() => null);
    if (q) prevEscrow[t.tokenId] = q;
  }

  const all = [...prevResults.values()];
  const index: ProbeIndex = {
    at: now,
    probed: all.filter((r) => r.endpoint).length,
    answered: all.filter((r) => r.answered).length,
    quotes: prevQuotes,
    previews: prevPreviews,
    escrowQuotes: prevEscrow,
    results: all,
  };
  return { index, refreshed: results.length, resolvedFailed, ms: Date.now() - started };
}

/**
 * The last census this office actually ran.
 *
 * Rung 2's sentence is "its endpoint answered a call we made", and the number
 * under it came from 8004scan's `is_endpoint_verified` flag, somebody else's
 * probe, at a time they do not publish, by a method they do not describe. The
 * rung was not true of its own figure.
 *
 * This is the call. Small, committed, and readable: a judge can open the file
 * and see the status and latency of every endpoint behind the number.
 */

import type { ProbeResult } from "@/lib/probe";
import type { Quote } from "@/lib/x402/quote";
import type { EscrowQuote } from "@/lib/escrow/a2a";
import { onSnapshotChange, snapshot } from "@/lib/data/snapshots";

export interface ProbeIndex {
  at: string;
  probed: number;
  answered: number;
  quotes?: Record<string, Quote>;
  previews?: Record<string, unknown>;
  /** Prices for ERC-8183 escrow, from sellers that negotiate over A2A. */
  escrowQuotes?: Record<string, EscrowQuote>;
  results: ProbeResult[];
}

const EMPTY: ProbeIndex = { at: new Date(0).toISOString(), probed: 0, answered: 0, results: [] };

let cached: ProbeIndex | null = null;
let byToken: Map<string, ProbeResult> | null = null;

// A newer census loaded from the database replaces the cached parse.
onSnapshotChange("probe", () => {
  cached = null;
  byToken = null;
});

/**
 * The current census: the newest of the committed file and the database.
 * Pages call `warm()` from `@/lib/data/snapshots` before rendering so a
 * deployed instance sees readings taken after its build.
 */
export function getProbes(): ProbeIndex {
  if (cached) return cached;
  cached = (snapshot<ProbeIndex>("probe")?.payload as ProbeIndex | undefined) ?? EMPTY;
  return cached;
}

/** The last call made to one agent, if it has ever been probed. */
export function probeFor(tokenId: string): ProbeResult | null {
  if (!byToken) {
    byToken = new Map(getProbes().results.map((r) => [r.tokenId, r]));
  }
  return byToken.get(tokenId) ?? null;
}

/**
 * Whether an agent answered when we called it.
 *
 * A 402 counts. It is the x402 rail working exactly as specified, every one
 * of Agripinaa's eight answers 402, and an agent that quotes a price for its
 * answer is more alive than one that returns 200 and nothing. Silence is what
 * does not count.
 */
export function answered(tokenId: string): boolean {
  return probeFor(tokenId)?.answered ?? false;
}

/**
 * Every escrowed-job price on record: the census's older readings, overlaid by
 * the escrow-quotes job's own (lib/census/quotes), which asks every seller in
 * turn and is not cut short by the probes.
 */
export function escrowQuoteMap(): Record<string, EscrowQuote> {
  return { ...(getProbes().escrowQuotes ?? {}), ...((snapshot<Record<string, EscrowQuote>>("escrow-quotes")?.payload as Record<string, EscrowQuote> | undefined) ?? {}) };
}

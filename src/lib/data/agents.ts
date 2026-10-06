/**
 * The agent index the marketplace browses.
 *
 * Read from a committed file rather than the API: 8004scan allows 25 requests
 * a minute anonymously, so a page that queried it per request would be unusable
 * and would break entirely under two concurrent visitors. The indexer writes
 * this; the site only reads it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATEGORIES, CHAIN_ID, type Category } from "@/lib/config";
import { db, hasDb, schema } from "@/lib/db/client";
import { count, max } from "drizzle-orm";
import { readRegistryTotals } from "@/lib/sources/totals";
import { registeredCount } from "@/lib/registry/count";
import { registryExtras } from "@/lib/registry/extras";
import { memo, withTimeout } from "@/lib/cache";

export interface IndexedAgent {
  tokenId: string;
  name: string | null;
  description: string | null;
  owner: string | null;
  imageUrl: string | null;
  protocols: string[];
  x402: boolean;
  /** Rung 2: the registry says this endpoint answered. Absent in older snapshots. */
  endpointVerified?: boolean;
  registryScore: number | null;
  feedbacks: number;
  avgScore: number | null;
  createdAt: string | null;
  category: Category | null;
  confidence: number;
  matched: string[];
  /** When this row was last refreshed from the registry. */
  lastSeen?: string;
  /** The transaction that minted its ERC-8004 identity, when we have read it. */
  registeredTx?: string | null;
  /** The block that transaction landed in. */
  registeredBlock?: number | null;
  /** Where this row came from: the committed crawl, or read from the chain since. */
  source?: "crawl" | "tail" | "list" | "view";
  /** The classifier version that filed it (lib/assay/classify CLASSIFIER_VERSION); older rows are filed again. */
  classifierVersion?: number;
  /** Ladder rung, attached at render time. Not part of the stored index. */
  rung?: number;
  /** Why it sits there rather than higher. */
  rungReason?: string;
}

export interface AgentIndex {
  chainId: number;
  capturedAt: string;
  apiCalls: number;
  registry: { registered: number; withEndpoint: number; withFeedback: number };
  /**
   * Where the two registry totals came from.
   *
   * They are the headline figures on the front door, and they were served out
   * of a committed file that had been standing for a day and a half. Read live
   * where the upstream answers, and named either way so a reader is never left
   * guessing whether the number in front of them is current.
   */
  registrySource?: "chain" | "live" | "indexer" | "snapshot";
  /** The block the registry count was read at, when it came from the chain. */
  registryBlock?: number;
  /** A command that re-derives the registry count. */
  registryVerify?: string;
  /** When the registry totals were read. Distinct from when the rows were. */
  registryAt?: string;
  counts: {
    indexed: number;
    classified: number;
    byCategory: Record<Category, number>;
    /** Rows refreshed in the most recent run; the rest are carried. */
    refreshed?: number;
  };
  agents: IndexedAgent[];
}

const EMPTY: AgentIndex = {
  chainId: 56,
  capturedAt: new Date(0).toISOString(),
  apiCalls: 0,
  registry: { registered: 0, withEndpoint: 0, withFeedback: 0 },
  counts: {
    indexed: 0,
    classified: 0,
    byCategory: Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>,
  },
  agents: [],
};

let cached: AgentIndex | null = null;

/** The committed crawl alone, without the registry's later agents merged in. */
export function fileIndex(): AgentIndex {
  if (cached) return cached;
  try {
    const raw = readFileSync(join(process.cwd(), "src/data/agents.json"), "utf8");
    cached = JSON.parse(raw) as AgentIndex;
  } catch {
    cached = EMPTY;
  }
  return cached;
}

/*
  The committed crawl, with every agent read from the registry since merged in.

  The crawl alone is a snapshot, and a snapshot of a registry that grows by
  hundreds a day is a hardcoded list by another name: an agent registered this
  morning would 404 here. The registry tail stores each new agent as it is
  minted; they are merged over the crawl by token id, newest reading first, and
  the merge is only redone when the tail has moved.
*/
let merged: { version: number; index: AgentIndex } | null = null;

export function getAgentIndex(): AgentIndex {
  const base = fileIndex();
  const extra = registryExtras();
  if (!extra.rows.size) return base;
  if (merged && merged.version === extra.version) return merged.index;
  const byId = new Map(base.agents.map((a) => [a.tokenId, a]));
  for (const a of extra.rows.values()) byId.set(a.tokenId, { ...byId.get(a.tokenId), ...a });
  const agents = [...byId.values()];
  const index: AgentIndex = {
    ...base,
    // The newest reading in the merge, so caches keyed on the index move when the tail does.
    capturedAt: extra.at && extra.at > base.capturedAt ? extra.at : base.capturedAt,
    agents,
  };
  merged = { version: extra.version, index };
  return index;
}

/**
 * The index, preferring Postgres and falling back to the committed snapshot.
 *
 * The worker has always written to Postgres and nothing ever read from it, so
 * the database was a write-only store and the site ran on a file, which is
 * what C2 is actually about. This is the read path.
 *
 * The fallback is deliberate rather than defensive. It keeps the site
 * deployable before any infrastructure exists and keeps it up when the
 * database is unreachable, and the source is reported rather than hidden so
 * nobody has to guess which one they are looking at.
 */
export async function readAgentIndex(): Promise<AgentIndex & { source: "postgres" | "snapshot" }> {
  /*
    Memoised, which it never was.

    Every page that shows a registry figure calls this, and each call was a
    full scan of 3,808 rows over the connection pooler, so /agents paid it,
    /offices paid it again for the same render, and the funnel paid it a third
    time. Ten seconds of a page's time to fetch the same table three times.

    Thirty seconds fresh with a stale window behind it: the crawl writes far
    more slowly than that, so nothing is being hidden by the cache, and every
    figure derived from this already carries the age it was read at.
  */
  return memo("agent-index", { freshMs: 5 * 60_000, staleMs: 30 * 60_000 }, readAgentIndexUncached);
}

/*
  The table is downloaded only when it has changed.

  The memo refreshed every thirty seconds while a page was in use, and each
  refresh pulled every row, two and a half megabytes, over the pooler. One
  busy instance moved seven gigabytes a day that way, and Supabase wrote to
  say so. The probe writes to this table every ten minutes at most, so a
  reader asks first how many rows there are and when the newest changed, a
  few bytes, and re-reads the rows only when that answer moves.
*/
let lastStamp: string | null = null;
let lastRows: Awaited<ReturnType<typeof selectAll>> | null = null;

function selectAll() {
  return db!.select().from(schema.agents).limit(20_000);
}

async function rowsIfChanged() {
  const [m] = await db!.select({ n: count(), at: max(schema.agents.updatedAt) }).from(schema.agents);
  const stamp = `${m?.n ?? 0}:${m?.at ? new Date(m.at).toISOString() : ""}`;
  if (lastRows && stamp === lastStamp) return lastRows;
  const rows = await selectAll();
  lastStamp = stamp;
  lastRows = rows;
  return rows;
}

async function readAgentIndexUncached(): Promise<AgentIndex & { source: "postgres" | "snapshot" }> {
  const snapshot = getAgentIndex();

  /*
    The registered and answering counts are the registry's, not ours, so they
    are read from the registry rather than carried with our rows. They refresh
    on a different clock from the crawl and are stamped separately.
  */
  /*
    Bounded, because a cold memo is the common case here.

    The memo serves a stale reading while it refreshes behind it, but every new
    serverless instance starts cold and pays the full read, two calls against
    an upstream that is rate-limited and intermittently down, with retries. A
    page must not wait on that. Two and a half seconds is long enough for a
    healthy answer and short enough that a sick upstream costs a fresh figure
    rather than the page, and the fallback is already labelled as carried.
  */
  /*
    The registered count is the registry's own counter, read from its storage
    slot on chain. 8004scan's figure is their indexer's progress, not the
    registry (311,300 against 343,356 on chain when this was written), so it is
    only consulted for the fields the chain does not hold, and only as a
    fallback for the count itself.
  */
  const [chainCount, totals] = await Promise.all([
    withTimeout(registeredCount().catch(() => null), 4_000),
    withTimeout(readRegistryTotals(CHAIN_ID).catch(() => null), 2_500),
  ]);
  const registry = {
    registered: chainCount?.count ?? totals?.registered ?? snapshot.registry.registered,
    withEndpoint: totals?.withEndpoint ?? snapshot.registry.withEndpoint,
    withFeedback: snapshot.registry.withFeedback,
  };
  const registrySource: "chain" | "live" | "indexer" | "snapshot" = chainCount
    ? "chain"
    : totals
      ? totals.tier === "upstream"
        ? "live"
        : "indexer"
      : "snapshot";
  const registryAt = chainCount?.at ?? totals?.at ?? snapshot.capturedAt;
  const registryBlock = chainCount?.block;
  const registryVerify = chainCount?.verify;

  if (!hasDb || !db)
    return { ...snapshot, registry, registrySource, registryAt, registryBlock, registryVerify, source: "snapshot" };

  try {
    const rows = await rowsIfChanged();
    if (rows.length === 0)
      return { ...snapshot, registry, registrySource, registryAt, registryBlock, registryVerify, source: "snapshot" };

    const crawled: IndexedAgent[] = rows.map((r) => ({
      tokenId: String(r.tokenId),
      name: r.name ?? null,
      description: r.description ?? null,
      owner: r.ownerAddress ?? null,
      imageUrl: r.imageUrl ?? null,
      protocols: r.supportedProtocols ?? [],
      x402: Boolean(r.x402Supported),
      endpointVerified: Boolean(r.isEndpointVerified),
      registryScore: r.registryScore ?? null,
      feedbacks: r.registryFeedbacks ?? 0,
      avgScore: r.registryAvgScore ?? null,
      createdAt: r.registeredAt ? new Date(r.registeredAt).toISOString() : null,
      category: (r.category as Category | null) ?? null,
      confidence: Number(r.categoryConfidence ?? 0),
      // The stored row carries the assay, not the phrases that matched; the
      // signals live in `results` and are rendered from the assay itself.
      matched: [],
      lastSeen: r.updatedAt ? new Date(r.updatedAt).toISOString() : undefined,
    }));
    // Agents read from the registry since the crawl, merged over it by token id.
    const byId = new Map(crawled.map((a) => [a.tokenId, a]));
    for (const a of registryExtras().rows.values()) byId.set(a.tokenId, { ...byId.get(a.tokenId), ...a });
    const agents = [...byId.values()];

    const byCategory = Object.fromEntries(
      CATEGORIES.map((c) => [c, agents.filter((a) => a.category === c).length]),
    ) as Record<Category, number>;

    /*
      When the rows were read, from the rows themselves.

      This used to be spread in from the committed file along with everything
      else that was not overridden, so a page reading Postgres stamped itself
      with the snapshot's age. The two happened to agree, the database was
      seeded once and nothing has re-crawled since, which is exactly why it
      went unnoticed. The stamp now moves when the crawl does.
    */
    const freshest = agents.reduce<string | null>(
      (t, a) => (a.lastSeen && (!t || a.lastSeen > t) ? a.lastSeen : t),
      null,
    );

    return {
      ...snapshot,
      registry,
      registrySource,
      registryAt,
      registryBlock,
      registryVerify,
      capturedAt: freshest ?? snapshot.capturedAt,
      agents,
      counts: {
        ...snapshot.counts,
        indexed: agents.length,
        classified: agents.filter((a) => a.category).length,
        byCategory,
      },
      source: "postgres",
    };
  } catch {
    // A database that will not answer is not a reason to serve nothing.
    return { ...snapshot, registry, registrySource, registryAt, source: "snapshot" };
  }
}

/**
 * Ranks agents within a category.
 *
 * Registry score alone puts batch-minted placeholders at the top, because the
 * registry scores metadata completeness rather than whether anything works.
 * Classification confidence comes first, then evidence of any real counterpart
 * having interacted with it.
 */
export function agentsInCategory(category: Category, limit = 24): IndexedAgent[] {
  return getAgentIndex()
    .agents.filter((a) => a.category === category)
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        b.feedbacks - a.feedbacks ||
        (b.registryScore ?? 0) - (a.registryScore ?? 0),
    )
    .slice(0, limit);
}

export function findAgent(tokenId: string): IndexedAgent | null {
  return getAgentIndex().agents.find((a) => a.tokenId === tokenId) ?? null;
}

export function searchAgents(q: string, limit = 60): IndexedAgent[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return getAgentIndex()
    .agents.filter(
      (a) =>
        a.tokenId.includes(needle) ||
        (a.name ?? "").toLowerCase().includes(needle) ||
        (a.description ?? "").toLowerCase().includes(needle),
    )
    .slice(0, limit);
}

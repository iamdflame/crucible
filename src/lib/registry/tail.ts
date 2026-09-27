/**
 * The ERC-8004 identity registry, read as it grows.
 *
 * The catalogue started as a committed crawl, which is a snapshot, and a
 * snapshot of a registry that mints hundreds of agents a day is a hardcoded
 * list by another name: an agent registered this morning would not exist here.
 * So the registry is read forward from where the crawl stopped, in two passes:
 *
 *   scan     every mint `Transfer(0x0, owner, tokenId)` on the registry, stored
 *            at once with its block and transaction. Cheap, so a burst of a
 *            few thousand mints from one factory never stalls it.
 *   resolve  each stored agent's card read through the fetch guard, and filed
 *            under a job by what it says. Slow, so it takes whatever the time
 *            left in a slice allows and carries on next time.
 *
 * Both run on the site's clock after the tick has answered, and both can run
 * from a laptop to catch up (`npm run registry-tail`). Nothing here is written
 * by hand: every row is the registry's own answer.
 */

import type { Address } from "viem";
import { IDENTITY_REGISTRY, type Category } from "@/lib/config";
import { LOG_RPCS, marketClient } from "@/lib/chain/market";
import { sql as pg } from "@/lib/db/client";
import { ensureTables } from "@/lib/db/tables";
import { snapshot, store, warm } from "@/lib/data/snapshots";
import { withLease } from "@/lib/db/lease";
import { readRegistryEntry, type RegistryEntry } from "@/lib/sources/registry";
import { classify } from "@/lib/assay/classify";
import { withTimeout } from "@/lib/cache";
import type { IndexedAgent } from "@/lib/data/agents";
import { putRegistryExtra, registryExtras, setRegistryExtras } from "./extras";

/** keccak256("Transfer(address,address,uint256)"), the ERC-721 mint and move event. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC = `0x${"0".repeat(64)}`;
/** The block after the committed crawl's newest agent (Guard-1, #344123, minted at 121,195,867). */
export const TAIL_START = 121_195_868;
/** The free log provider that serves ranged queries caps them at 5,000 blocks. */
/*
  2,000 blocks a read. The one free provider that serves ranges more than a few
  hours old answers 2,000 in about a second but timed out on 5,000, and on 25
  Sep the tail stalled there for two and a half days while no mint was read.
*/
const SPAN = 2_000;
const RESOLVE_CONCURRENCY = 24;

export interface Mint {
  tokenId: string;
  owner: string;
  block: number;
  tx: string;
}

interface TailState {
  cursor: number;
  head: number;
  minted: number;
  at: string;
}

const hex = (n: number) => `0x${n.toString(16)}`;
const scrub = (e: unknown) => ((e as Error)?.message ?? String(e)).split("\n")[0]!.replace(/https?:\/\/\S+/g, "<rpc>").slice(0, 160);

/** Mint events in a block range, decoded. Pure, for tests. */
export function decodeMints(logs: { topics: string[]; blockNumber: string; transactionHash: string }[]): Mint[] {
  return logs
    .filter((l) => l.topics[0] === TRANSFER_TOPIC && l.topics[1] === ZERO_TOPIC && l.topics.length >= 4)
    .map((l) => ({
      tokenId: BigInt(l.topics[3]!).toString(),
      owner: `0x${l.topics[2]!.slice(26)}`.toLowerCase(),
      block: Number(BigInt(l.blockNumber)),
      tx: l.transactionHash,
    }));
}

async function mintLogs(from: number, to: number): Promise<Mint[]> {
  let last = "no log provider is configured";
  for (const url of LOG_RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getLogs",
          params: [{ address: IDENTITY_REGISTRY, fromBlock: hex(from), toBlock: hex(to), topics: [TRANSFER_TOPIC, ZERO_TOPIC] }],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json()) as { result?: { topics: string[]; blockNumber: string; transactionHash: string }[]; error?: { message?: string } };
      if (Array.isArray(body.result)) return decodeMints(body.result);
      last = body.error?.message ?? `answered ${res.status}`;
    } catch (e) {
      last = scrub(e);
    }
  }
  throw new Error(`no provider served the registry's mints for blocks ${from} to ${to}: ${last.slice(0, 120)}`);
}

/** The protocols an agent's card offers, in the crawl's own spelling. */
export function protocolsOf(entry: Pick<RegistryEntry, "services"> | null): string[] {
  const known: Record<string, string> = { mcp: "MCP", a2a: "A2A", web: "Web", oasf: "OASF", email: "Email", x402: "x402" };
  const out = new Set<string>();
  for (const s of entry?.services ?? []) {
    const k = known[s.name.toLowerCase()];
    if (k) out.add(k);
  }
  return [...out];
}

/** What the catalogue holds for one agent, from the registry's own answer. */
export function agentFrom(tokenId: string, entry: RegistryEntry | null, mint: Partial<Mint> = {}, source: IndexedAgent["source"] = "tail"): IndexedAgent {
  const name = entry?.name ?? null;
  const description = entry?.description ?? null;
  // Filed by what it says it does, weighed like every other agent. Its own label is one more phrase, never the answer.
  const c = classify({
    name,
    description,
    tags: entry?.claimedCategory ? [entry.claimedCategory] : null,
    skills: entry?.services.map((s) => s.name) ?? null,
  });
  return {
    tokenId,
    name,
    description,
    owner: entry?.owner?.toLowerCase() ?? mint.owner ?? null,
    imageUrl: entry?.image ?? null,
    protocols: protocolsOf(entry),
    x402: Boolean(entry?.x402Endpoint),
    endpointVerified: false,
    registryScore: null,
    feedbacks: 0,
    avgScore: null,
    createdAt: null,
    category: (c.category as Category | null) ?? null,
    confidence: c.confidence,
    matched: c.matched,
    lastSeen: entry?.at ?? new Date().toISOString(),
    registeredTx: mint.tx ?? null,
    registeredBlock: mint.block ?? null,
    source,
  };
}

/** Writes agents in one statement, keeping a mint's transaction once known and a listing once made. */
async function upsertMany(agents: IndexedAgent[], resolved: boolean): Promise<void> {
  if (!agents.length) return;
  const rows = agents.map((a) => ({
    token_id: a.tokenId,
    owner: a.owner,
    category: a.category,
    record: { ...a, resolved },
    block: a.registeredBlock ?? null,
    tx: a.registeredTx ?? null,
    source: a.source ?? "tail",
  }));
  await pg!`
    insert into registry_agents (token_id, owner, category, record, block, tx, source, indexed_at)
    select x.token_id, x.owner, x.category, x.record, x.block, x.tx, x.source, now()
    from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
      as x(token_id text, owner text, category text, record jsonb, block bigint, tx text, source text)
    on conflict (token_id) do update set
      owner = coalesce(excluded.owner, registry_agents.owner),
      category = excluded.category,
      record = excluded.record || jsonb_build_object(
        'registeredTx', coalesce(registry_agents.tx, excluded.tx),
        'registeredBlock', coalesce(registry_agents.block, excluded.block)
      ),
      block = coalesce(registry_agents.block, excluded.block),
      tx = coalesce(registry_agents.tx, excluded.tx),
      source = case when registry_agents.source = 'list' then 'list' else excluded.source end,
      indexed_at = now()
  `;
}

const upsert = (agent: IndexedAgent, resolved: boolean) => upsertMany([agent], resolved);

/** Mints confirmed on chain for agents from the committed crawl, stored with the crawl's own reading. */
export async function storeCrawlMints(agents: IndexedAgent[]): Promise<void> {
  if (!pg || !agents.length) return;
  await ensureTables();
  for (let i = 0; i < agents.length; i += 100) await upsertMany(agents.slice(i, i + 100).map((a) => ({ ...a, source: "crawl" as const })), true);
}

/** The registry's mint of one token among a transaction's logs: its owner at mint, or null. Pure, for tests. */
export function mintIn(logs: readonly { address: string; topics: readonly (string | null)[] }[], tokenId: string): string | null {
  const log = logs.find(
    (l) =>
      l.address.toLowerCase() === IDENTITY_REGISTRY.toLowerCase() &&
      l.topics[0] === TRANSFER_TOPIC &&
      l.topics[1] === ZERO_TOPIC &&
      l.topics[3] !== undefined &&
      l.topics[3] !== null &&
      BigInt(l.topics[3]) === BigInt(tokenId),
  );
  return log?.topics[2] ? `0x${log.topics[2].slice(26)}`.toLowerCase() : null;
}

/** Scan: store every mint in the next ranges of blocks, cheaply, and move the cursor. */
export async function scanMints(opts: { budgetMs: number; maxChunks?: number }): Promise<{ cursor: number; head: number; minted: number }> {
  await ensureTables();
  await warm(["registry-tail"]).catch(() => undefined);
  const state = snapshot<TailState>("registry-tail")?.payload ?? { cursor: TAIL_START, head: 0, minted: 0, at: new Date(0).toISOString() };
  const head = Number(await marketClient.getBlockNumber());
  const started = Date.now();
  let cursor = state.cursor;
  let minted = 0;
  let chunks = 0;
  while (cursor <= head && Date.now() - started < opts.budgetMs && chunks < (opts.maxChunks ?? 1e9)) {
    const to = Math.min(head, cursor + SPAN - 1);
    const mints = await mintLogs(cursor, to);
    if (mints.length) {
      // Stored unresolved, in one statement however large the burst: the card is read by the resolve pass.
      await pg!`
        insert into registry_agents (token_id, owner, category, record, block, tx, source, indexed_at)
        select t.token_id, t.owner, null,
               jsonb_build_object('tokenId', t.token_id, 'owner', t.owner, 'resolved', false),
               t.block, t.tx, 'tail', now()
        from unnest(
          ${pg!.array(mints.map((m) => m.tokenId))}::text[],
          ${pg!.array(mints.map((m) => m.owner))}::text[],
          ${pg!.array(mints.map((m) => String(m.block)))}::bigint[],
          ${pg!.array(mints.map((m) => m.tx))}::text[]
        ) as t(token_id, owner, block, tx)
        on conflict (token_id) do update set
          block = coalesce(registry_agents.block, excluded.block),
          tx = coalesce(registry_agents.tx, excluded.tx)
      `;
    }
    minted += mints.length;
    chunks += 1;
    cursor = to + 1;
    await store("registry-tail", { cursor, head, minted: state.minted + minted, at: new Date().toISOString() } satisfies TailState);
  }
  return { cursor, head, minted };
}

/** Resolve: read the cards of stored agents that have not been read yet, as many as time allows. */
export async function resolvePending(opts: { budgetMs: number; limit?: number }): Promise<{ resolved: number; classified: number; left: number }> {
  await ensureTables();
  const started = Date.now();
  const rows = (await pg!`
    select token_id, owner, block, tx from registry_agents
    where coalesce((record->>'resolved')::boolean, false) = false
    order by token_id::numeric desc
    limit ${opts.limit ?? 400}
  `) as { token_id: string; owner: string | null; block: string | number | null; tx: string | null }[];
  let resolved = 0;
  let classified = 0;
  const queue = [...rows];
  let pending: IndexedAgent[] = [];
  // Cards are read in parallel; rows are written fifty at a time, since each write crosses to the database.
  const flush = async () => {
    const batch = pending;
    pending = [];
    await upsertMany(batch, true);
  };
  await Promise.all(
    Array.from({ length: RESOLVE_CONCURRENCY }, async () => {
      for (;;) {
        if (Date.now() - started > opts.budgetMs) return;
        const r = queue.shift();
        if (!r) return;
        const entry = await withTimeout(readRegistryEntry(r.token_id).catch(() => null), 10_000);
        const agent = agentFrom(r.token_id, entry, { owner: r.owner ?? undefined, block: r.block === null ? undefined : Number(r.block), tx: r.tx ?? undefined });
        pending.push(agent);
        resolved += 1;
        if (agent.category) {
          classified += 1;
          putRegistryExtra(agent);
        }
        if (pending.length >= 50) await flush();
      }
    }),
  );
  await flush();
  const [left] = (await pg!`select count(*)::int as n from registry_agents where coalesce((record->>'resolved')::boolean, false) = false`) as { n: number }[];
  return { resolved, classified, left: left?.n ?? 0 };
}

/**
 * One slice of the scheduled work: scan what fits, then resolve what fits.
 * Under a lease, so overlapping ticks never read the same range twice.
 */
export async function tailRegistry(opts: { budgetMs: number }): Promise<string> {
  const started = Date.now();
  const out = await withLease("registry-tail", Math.ceil(opts.budgetMs / 1000) + 15, async () => {
    const scan = await scanMints({ budgetMs: Math.min(opts.budgetMs / 3, 12_000) }).catch((e) => ({ error: scrub(e) }));
    const left = Math.max(0, opts.budgetMs - (Date.now() - started) - 3_000);
    const res = left > 4_000 ? await resolvePending({ budgetMs: left }) : null;
    const s = "error" in scan ? `scan failed: ${scan.error}` : `scanned to block ${scan.cursor - 1} of ${scan.head}, ${scan.minted} new mints`;
    return `${s}; ${res ? `resolved ${res.resolved} (${res.classified} filed under a job), ${res.left} still to read` : "no time left to resolve"}`;
  });
  return out ?? "another slice holds the lease";
}

/**
 * Index one token now, for /list and for a page asked about a token the tail
 * has not reached. Its mint transaction is filled in when the scan passes it.
 */
export async function indexToken(tokenId: string, source: "list" | "view"): Promise<IndexedAgent | null> {
  const entry = await readRegistryEntry(tokenId).catch(() => null);
  if (!entry) return null;
  const agent = agentFrom(tokenId, entry, {}, source);
  if (pg) {
    await ensureTables();
    await upsert(agent, true);
    const [row] = (await pg`select tx, block from registry_agents where token_id = ${tokenId}`) as { tx: string | null; block: string | number | null }[];
    if (row?.tx) {
      agent.registeredTx = row.tx;
      agent.registeredBlock = row.block === null ? null : Number(row.block);
    }
  }
  putRegistryExtra(agent);
  return agent;
}

/*
  The agents the catalogue needs, loaded into memory for the synchronous index:
  every resolved agent filed under a job, and every agent someone listed or
  opened here. Re-read at most once a minute, and only the rows that changed.
*/
let loadedAt: string | null = null;
let lastWarm = 0;
let warming: Promise<void> | null = null;

export function warmRegistry(): Promise<void> {
  if (!pg) return Promise.resolve();
  if (Date.now() - lastWarm < 60_000) return Promise.resolve();
  if (warming) return warming;
  warming = (async () => {
    try {
      await ensureTables();
      const since = loadedAt ?? "1970-01-01T00:00:00Z";
      const rows = (await pg!`
        select record, indexed_at from registry_agents
        where indexed_at > ${since}
          and coalesce((record->>'resolved')::boolean, false) = true
          and (category is not null or source in ('list', 'view'))
        order by indexed_at asc
        limit 20000
      `) as { record: IndexedAgent & { resolved?: boolean }; indexed_at: Date | string }[];
      if (rows.length) {
        const next = new Map(registryExtras().rows);
        for (const r of rows) {
          const { resolved: _resolved, ...agent } = r.record;
          next.set(agent.tokenId, agent);
        }
        const newest = rows[rows.length - 1]!.indexed_at;
        loadedAt = typeof newest === "string" ? newest : newest.toISOString();
        setRegistryExtras(next, loadedAt);
      }
      lastWarm = Date.now();
    } catch {
      // The committed crawl stands in; the page is not held up by the database.
      lastWarm = Date.now() - 45_000;
    } finally {
      warming = null;
    }
  })();
  return warming;
}

/** An owner's agents, from the registry rows: the answer to "agents per owner". */
export async function agentsOfOwner(owner: string): Promise<IndexedAgent[]> {
  if (!pg) return [];
  await ensureTables();
  const rows = (await pg`select record from registry_agents where owner = ${owner.toLowerCase()} order by token_id::numeric`) as { record: IndexedAgent }[];
  return rows.map((r) => r.record);
}

export type { Address };

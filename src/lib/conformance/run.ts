/**
 * The conformance pass: every hireable agent under a job asked the same
 * public question, its answer checked against our own chain reading, the
 * verdict kept per agent.
 *
 * Answers come from where they cost nothing first: our own agents' services
 * run directly; agents on BNB's SDK through their free A2A call, with exactly
 * the task a buyer would send; pay-per-call sellers from the answer to our
 * daily test purchase about the same demo account. An agent we have no free
 * or already-paid answer from is recorded as not tested, with the reason.
 */

import type { Address } from "viem";
import { sql as pg } from "@/lib/db/client";
import { ensureTables } from "@/lib/db/tables";
import { DEMO_ADDRESS } from "@/lib/demo";
import { positionIdsOf, readPositions, readVenus } from "@/lib/diagnose/positions";
import { usdtRates } from "@/lib/venus/rates";
import { HOUSE_SERVICES, poolNow } from "@/lib/house/services";
import { houseSlug } from "@/lib/market/performance";
import { listings, type Listing } from "@/lib/market/listing";
import { hirePath } from "@/lib/market/hire-law";
import { listPaidCalls } from "@/lib/market/paid-calls";
import { gridTask, taskFor } from "@/lib/escrow/task";
import { tryFree } from "@/lib/escrow/a2a";
import { withTimeout } from "@/lib/cache";
import { store, warm } from "@/lib/data/snapshots";
import { warmRegistry } from "@/lib/registry/tail";
import { warmOutcomes } from "@/lib/market/hire-law";
import { privateKeyToAccount } from "viem/accounts";
import { asData, checkGrid, checkHealth, checkRange, checkYield, TOLERANCE, type Result } from "./checks";

export interface Reference {
  hf: number | null | undefined;
  positions: { tokenId: string; inRange: boolean | null; tick: number | null }[];
  venusUsdtAprPct: number | null;
  grid: { lower: number; upper: number; levels: number; capital: number } | null;
  block: number | null;
}

/** Our own reading of the public test subjects, at one moment. */
export async function reference(): Promise<Reference> {
  const [venus, ids, rates, pool] = await Promise.all([
    readVenus(DEMO_ADDRESS).catch(() => null),
    positionIdsOf(DEMO_ADDRESS).catch(() => [] as bigint[]),
    usdtRates().catch(() => null),
    poolNow().catch(() => null),
  ]);
  const positions = ids.length ? await readPositions(ids).catch(() => []) : [];
  const task = pool ? gridTask({}, pool.usdtPerBnb) : null;
  const m = task?.match(/between ([\d.]+) and ([\d.]+) USDT.*capital ([\d.]+) USD, (\d+) levels/);
  return {
    hf: venus === null ? undefined : (venus.healthFactor ?? null),
    positions: positions.filter((p) => !p.closed).map((p) => ({ tokenId: p.tokenId, inRange: p.inRange, tick: p.tick })),
    venusUsdtAprPct: rates ? rates.venusApr * 100 : null,
    grid: m ? { lower: Number(m[1]), upper: Number(m[2]), capital: Number(m[3]), levels: Number(m[4]) } : null,
    block: pool?.block ?? null,
  };
}

/** An answer that is only an error message: the agent could not be checked, which is not the same as being wrong. */
export function errorOnly(answer: unknown): string | null {
  const d = asData(answer) as Record<string, unknown> | null;
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const keys = Object.keys(d);
  const e = d.error ?? d.message;
  return typeof e === "string" && keys.every((k) => /^(error|message|hint|skills|need|code|detail)$/i.test(k)) ? e.slice(0, 160) : null;
}

/**
 * The reference for this answer in particular: a test purchase about another
 * wallet is compared with that wallet's own loan, and an answer naming a
 * position with that position, read from the chain now.
 */
export async function refine(category: string, answer: unknown, subject: string | null, ref: Reference): Promise<Reference> {
  if (category === "health-factor" && subject && /^0x[0-9a-fA-F]{40}$/.test(subject) && subject.toLowerCase() !== DEMO_ADDRESS.toLowerCase()) {
    const v = await readVenus(subject as Address).catch(() => null);
    return { ...ref, hf: v === null ? undefined : (v.healthFactor ?? null) };
  }
  if (category === "rebalancing") {
    const d = asData(answer);
    const named = d && typeof d === "object" ? JSON.stringify(d).match(/"(?:position_?id|positionId|token_?id|tokenId|position|nft_?id)"\s*:\s*"?(\d{3,12})"?/i)?.[1] : undefined;
    if (named) {
      const known = ref.positions.find((p) => p.tokenId === named);
      if (known) return { ...ref, positions: [known, ...ref.positions.filter((p) => p !== known)] };
      const read = await readPositions([BigInt(named)]).catch(() => []);
      return { ...ref, positions: read.filter((p) => !p.closed).map((p) => ({ tokenId: p.tokenId, inRange: p.inRange, tick: p.tick })) };
    }
  }
  return ref;
}

export function judge(category: string, answer: unknown, ref: Reference, opts: { aged?: boolean } = {}): Result {
  const err = errorOnly(answer);
  if (err) return { verdict: "unreadable", checks: [], note: `it answered with an error rather than the work: “${err}”` };
  if (category === "health-factor") return ref.hf === undefined ? { verdict: "not-comparable", checks: [], note: "Venus could not be read on this pass" } : checkHealth(answer, { hf: ref.hf }, opts);
  if (category === "rebalancing") return checkRange(answer, { positions: ref.positions }, opts);
  if (category === "yield-optimisation") return checkYield(answer, { venusUsdtAprPct: ref.venusUsdtAprPct });
  if (category === "grid-trading") return ref.grid ? checkGrid(answer, ref.grid) : { verdict: "not-comparable", checks: [], note: "the pool could not be read on this pass" };
  return { verdict: "not-comparable", checks: [], note: "no check is defined for this job" };
}

type Source = "our agent" | "free call" | "test purchase" | "test hire";

/**
 * Answers our paid checks bought (lib/conformance/hires.ts): the latest
 * delivered escrowed job per agent from the trial pool in the last three days,
 * one whose answer matched the hash its seller committed first.
 */
async function testHireAnswers(): Promise<Map<string, { answer: unknown; subject: string | null; at: string }>> {
  const raw = process.env.AGENT_A_KEY;
  if (!raw || !pg) return new Map();
  const pool = privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`).address.toLowerCase();
  const rows = (await pg`
    select distinct on (token_id) token_id, seller_answer, subject, coalesce(to_timestamp(submitted_at), created_at) as at
    from escrow_jobs
    where client = ${pool} and slug = '' and seller_answer is not null and created_at > now() - interval '3 days'
    order by token_id, seller_verified desc nulls last, created_at desc
  `.catch(() => [])) as { token_id: string; seller_answer: string; subject: string | null; at: Date }[];
  return new Map(rows.map((r) => [r.token_id, { answer: asData(r.seller_answer) ?? r.seller_answer, subject: r.subject, at: new Date(r.at).toISOString() }]));
}

/** Where this agent's answer comes from on this pass, and the answer. */
async function answerOf(l: Listing, ref: Reference, calls: Awaited<ReturnType<typeof listPaidCalls>>, hired: Map<string, { answer: unknown; subject: string | null; at: string }>): Promise<{ source: Source; answer: unknown; subject?: string | null; at?: string } | { untested: string }> {
  const slug = houseSlug(l.tokenId);
  if (slug) {
    if (slug === "grid-1") return { untested: "Grid-1 reports its own trading window, not a plan for bounds it is given" };
    const svc = HOUSE_SERVICES[slug];
    if (!svc) return { untested: "no service on record" };
    return { source: "our agent", answer: await svc.run({ wallet: DEMO_ADDRESS }) };
  }
  // A paid check's answer, when we bought one: it is the work itself, where a free call may only be an error.
  const paid = hired.get(l.tokenId);
  if (paid) return { source: "test hire", answer: paid.answer, subject: paid.subject, at: paid.at };
  if (l.escrowQuote?.kind === "sdk" && l.escrowQuote.a2a) {
    const task = l.category === "grid-trading" && ref.grid
      ? taskFor("grid-trading", l.name, { lower: String(ref.grid.lower), upper: String(ref.grid.upper), capital: String(ref.grid.capital) })
      : taskFor(l.category ?? null, l.name, { wallet: DEMO_ADDRESS as Address });
    return { source: "free call", answer: await tryFree(l.escrowQuote.a2a, task) };
  }
  // A pay-per-call seller: the answer to our last daily test purchase, when it was about the same account and recent.
  const last = calls.find((c) => c.tokenId === l.tokenId && c.paid && c.delivered);
  if (last && Date.now() - Date.parse(last.at) < 3 * 86_400_000) return { source: "test purchase", answer: last.deliverable, subject: last.subject, at: last.at };
  if (l.escrowQuote?.service && !["health_factor", "yield_plan", "grid_plan"].includes(l.escrowQuote.service) && l.escrowQuote.kind !== "sdk") {
    return { untested: `its ${l.escrowQuote.service.replace(/_/g, " ")} is work we do not read from the chain ourselves, so there is nothing to compare it with` };
  }
  return { untested: l.escrowQuote ? "it sells only paid escrowed jobs; our paid check has not bought its answer yet" : "no recent paid answer about the test account yet" };
}

/** One pass: the agents checked longest ago first, as many as the time allows. */
export async function runConformance(opts: { budgetMs: number }): Promise<string> {
  if (!pg) return "no database";
  await ensureTables();
  const started = Date.now();
  // Its own invocation starts cold: the newest census, registry and paid calls first, not the committed files.
  await Promise.all([warm().catch(() => undefined), warmRegistry().catch(() => undefined), warmOutcomes().catch(() => undefined)]);
  const hired = await testHireAnswers();
  const hireable = listings().filter((l) => l.category && hirePath(l).ok);
  const lastRun = new Map(((await pg`select distinct on (token_id) token_id, at from conformance_runs order by token_id, at desc`) as { token_id: string; at: Date }[]).map((r) => [r.token_id, new Date(r.at).getTime()]));
  hireable.sort((a, b) => (lastRun.get(a.tokenId) ?? 0) - (lastRun.get(b.tokenId) ?? 0));
  const ref = await reference();
  const calls = await listPaidCalls().catch(() => []);
  const done: string[] = [];
  for (const l of hireable) {
    if (Date.now() - started > opts.budgetMs) break;
    const got = await withTimeout(answerOf(l, ref, calls, hired).catch((e: Error) => ({ untested: `its answer could not be read: ${e.message.slice(0, 120)}` })), 25_000);
    const a = got ?? { untested: "it did not answer within 25 seconds" };
    const aged = !("untested" in a) && Boolean(a.at && Date.now() - Date.parse(a.at) > TOLERANCE.agedAfterMs);
    const result: Result = "untested" in a ? { verdict: "not-comparable", checks: [], note: a.untested } : judge(l.category!, a.answer, await refine(l.category!, a.answer, a.subject ?? null, ref), { aged });
    const verdict = "untested" in a ? "untested" : result.verdict;
    const excerpt = "untested" in a ? null : (typeof a.answer === "string" ? a.answer : JSON.stringify(a.answer)).slice(0, 4_000);
    await pg`
      insert into conformance_runs (token_id, category, verdict, source, checks, note, excerpt, block)
      values (${l.tokenId}, ${l.category}, ${verdict}, ${"untested" in a ? null : a.source}, ${JSON.stringify(result.checks)}::jsonb, ${result.note}, ${excerpt}, ${ref.block})
    `;
    done.push(`#${l.tokenId} ${verdict}`);
  }
  // The latest verdict per agent, small enough for every listing to read without a query.
  const summary = Object.fromEntries([...(await latestConformance()).values()].map((r) => [r.tokenId, { verdict: r.verdict, at: r.at }]));
  await store("conformance", summary);
  return done.join("; ") || "nothing due";
}

export interface Latest {
  tokenId: string;
  category: string;
  verdict: "pass" | "fail" | "not-comparable" | "unreadable" | "untested";
  source: Source | null;
  checks: { field: string; ours: string; theirs: string; pass: boolean }[];
  note: string | null;
  excerpt: string | null;
  block: number | null;
  at: string;
}

/** The latest verdict for every agent checked, by token id. */
export async function latestConformance(): Promise<Map<string, Latest>> {
  if (!pg) return new Map();
  await ensureTables();
  const rows = (await pg`select distinct on (token_id) * from conformance_runs order by token_id, at desc`) as {
    token_id: string;
    category: string;
    verdict: Latest["verdict"];
    source: Source | null;
    checks: Latest["checks"];
    note: string | null;
    excerpt: string | null;
    block: string | number | null;
    at: Date;
  }[];
  return new Map(
    rows.map((r) => [
      r.token_id,
      { tokenId: r.token_id, category: r.category, verdict: r.verdict, source: r.source, checks: r.checks ?? [], note: r.note, excerpt: r.excerpt, block: r.block === null ? null : Number(r.block), at: new Date(r.at).toISOString() },
    ]),
  );
}

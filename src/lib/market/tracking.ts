/**
 * What a wallet did on MANDATE, in the shape BNB's quest counts.
 *
 * Phase 2 counts hires, deposits, completions and ratings per wallet across
 * the four jobs, and only what can be verified on chain or through our API.
 * So every row here names the transaction that proves it: the payment's
 * settlement for a paid call, the market contract and job id for a job with
 * capital, the reputation-registry transaction for a rating. Rows from our own
 * wallets are flagged as team, and calls we paid for a visitor as sponsored;
 * neither counts toward anybody's quest.
 */

import { sql as pg } from "@/lib/db/client";
import { ensureTables } from "@/lib/db/tables";
import { readBook } from "@/lib/chain/book";
import { CATEGORIES, type Category } from "@/lib/config";
import { findAgent } from "@/lib/data/agents";
import { agentsOfOwner } from "@/lib/registry/tail";
import { getAgentIndex } from "@/lib/data/agents";
import { isTeam } from "@/lib/team";
import { SITE } from "@/lib/site";
import { placeAgent, readMarketSets } from "@/lib/rung";
import { jobsOfClient, type EscrowJob } from "@/lib/escrow/jobs";
import { ESCROW } from "@/lib/escrow/contracts";
import type { PaidCallRecord } from "@/lib/market/paid-calls";
import { CAMPAIGN_ENDS } from "@/lib/campaign/rules";

export type HireKind = "paid-call" | "market-job" | "escrow-job";

export interface HireRow {
  kind: HireKind;
  /** The agent's ERC-8004 id. */
  agentId: string;
  agentName: string | null;
  category: Category | null;
  /** The transaction that proves the hire: the payment's settlement, or the job's opening. */
  tx: string | null;
  block: number | null;
  /** For a job with capital, the contract and job number to read it back from. */
  contract: string | null;
  jobId: string | null;
  /** What moved: the call's price, or the job's deposit. */
  amount: string | null;
  asset: string | null;
  /** The agent answered, or the job ran its full term. */
  completed: boolean;
  /** Read back from the chain: the settlement moved exactly the price from this wallet to the agent, or the job is in the contract. */
  onChain: boolean;
  at: string | null;
  /** Paid by MANDATE for a visitor, so not the wallet's own hire. */
  sponsored: boolean;
}

export interface RatingRow {
  agentId: string;
  score: number;
  tag1: string | null;
  tag2: string | null;
  tx: string;
  block: number | null;
  /** The paid hire this rating follows, when its feedbackHash names one this wallet made. */
  hireTx: string | null;
  at: string;
}

const categoryOf = (tokenId: string, recorded?: string | null): Category | null => {
  if (recorded && (CATEGORIES as readonly string[]).includes(recorded)) return recorded as Category;
  return findAgent(tokenId)?.category ?? null;
};

/** A wallet's paid calls, from the calls it signed through this site. Pure over the records, for tests. */
export function paidCallHires(calls: PaidCallRecord[], wallet: string): HireRow[] {
  const w = wallet.toLowerCase();
  return calls
    .filter((c) => c.payer?.toLowerCase() === w && c.paid)
    .map((c) => ({
      kind: "paid-call" as const,
      agentId: c.tokenId,
      agentName: c.name,
      category: categoryOf(c.tokenId, c.category),
      tx: c.tx,
      block: c.block,
      contract: null,
      jobId: null,
      amount: c.amount,
      asset: c.asset,
      completed: c.delivered,
      onChain: c.confirmed === true && Boolean(c.tx),
      at: c.at,
      sponsored: c.sponsored,
    }));
}

async function paidCallsOf(wallet: string): Promise<PaidCallRecord[]> {
  if (!pg) return [];
  await ensureTables();
  const rows = (await pg`select record from paid_calls where lower(record->>'payer') = ${wallet.toLowerCase()} order by at desc limit 500`) as { record: PaidCallRecord }[];
  return rows.map((r) => r.record);
}

/** Jobs with capital this wallet opened on the market, with the agent that won each. */
async function marketJobsOf(wallet: string): Promise<HireRow[]> {
  const book = await readBook().catch(() => null);
  if (!book) return [];
  const w = wallet.toLowerCase();
  return book.rows
    .filter((r) => r.principal.toLowerCase() === w)
    .map((r) => {
      const agent = r.agent && !/^0x0+$/.test(r.agent) ? getAgentIndex().agents.find((a) => a.owner?.toLowerCase() === r.agent.toLowerCase()) : undefined;
      return {
        kind: "market-job" as const,
        agentId: agent?.tokenId ?? "",
        agentName: agent?.name ?? null,
        category: (CATEGORIES[r.category] as Category | undefined) ?? null,
        tx: null,
        block: null,
        contract: r.deployment.address,
        jobId: String(r.id),
        amount: r.capitalWei.toString(),
        asset: "BNB",
        completed: r.epochsTotal > 0 && r.epochsSettled >= r.epochsTotal,
        onChain: true,
        at: null,
        sponsored: false,
      };
    });
}

/** Escrowed jobs this wallet funded for our agents, each checked against the kernel when it was recorded. Pure, for tests. */
export function escrowHires(jobs: EscrowJob[]): HireRow[] {
  return jobs.map((j) => ({
    kind: "escrow-job" as const,
    agentId: j.tokenId,
    agentName: null,
    category: categoryOf(j.tokenId),
    tx: j.fundedTx,
    block: null,
    contract: ESCROW.commerce,
    jobId: j.jobId,
    amount: j.budget,
    asset: ESCROW.paymentToken,
    completed: j.status === "SUBMITTED" || j.status === "COMPLETED",
    onChain: true,
    at: j.createdAt,
    sponsored: false,
  }));
}

export async function ratingsOf(wallet: string): Promise<RatingRow[]> {
  if (!pg) return [];
  await ensureTables();
  const rows = (await pg`select tx, token_id, score, tag1, tag2, block, hire_tx, at from ratings where wallet = ${wallet.toLowerCase()} order by at desc`) as {
    tx: string;
    token_id: string;
    score: number;
    tag1: string | null;
    tag2: string | null;
    block: string | number | null;
    hire_tx: string | null;
    at: Date | string;
  }[];
  return rows.map((r) => ({
    agentId: r.token_id,
    score: r.score,
    tag1: r.tag1,
    tag2: r.tag2,
    tx: r.tx,
    block: r.block === null ? null : Number(r.block),
    hireTx: r.hire_tx,
    at: typeof r.at === "string" ? r.at : r.at.toISOString(),
  }));
}

/** Which of the four jobs a wallet has hired an agent for, counting only its own hires the chain confirms. Pure, for tests. */
export function jobsCovered(hires: HireRow[]): Record<Category, number> {
  const out = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  for (const h of hires) if (h.category && !h.sponsored && h.onChain) out[h.category] += 1;
  return out;
}

export interface WalletHires {
  wallet: string;
  team: boolean;
  hires: HireRow[];
  byCategory: Record<Category, number>;
  ratings: RatingRow[];
}

export async function hiresOf(wallet: string): Promise<WalletHires> {
  const [calls, jobs, escrow, ratings] = await Promise.all([
    paidCallsOf(wallet).catch(() => []),
    marketJobsOf(wallet).catch(() => []),
    jobsOfClient(wallet).catch(() => []),
    ratingsOf(wallet).catch(() => []),
  ]);
  const hires = [...paidCallHires(calls, wallet), ...escrowHires(escrow), ...jobs];
  return { wallet: wallet.toLowerCase(), team: isTeam(wallet), hires, byCategory: jobsCovered(hires), ratings };
}

export interface OwnedAgent {
  agentId: string;
  name: string | null;
  category: Category | null;
  registeredTx: string | null;
  registeredBlock: number | null;
  /** Listed on MANDATE: it has a page here and appears under its job when classified. */
  listed: boolean;
  /**
   * Where it stands on the listing ladder, as a measure of quality: 0
   * Registered, 1 Resolvable (its card parses), 2 Live (its endpoint answers in
   * an agent protocol), 3 Priced, 4 Hallmarked, 5 Settled.
   */
  rung: number;
  rungName: string;
  page: string;
}

/** Agents an owner holds on the ERC-8004 registry that MANDATE has read. */
export async function agentsOf(owner: string): Promise<OwnedAgent[]> {
  const o = owner.toLowerCase();
  const [fromTail, sets] = await Promise.all([agentsOfOwner(o).catch(() => []), readMarketSets().catch(() => null)]);
  const fromCrawl = getAgentIndex().agents.filter((a) => a.owner?.toLowerCase() === o);
  const byId = new Map<string, OwnedAgent>();
  for (const a of [...fromCrawl, ...fromTail]) {
    const place = sets ? placeAgent(a, sets) : null;
    byId.set(a.tokenId, {
      agentId: a.tokenId,
      name: a.name,
      category: a.category,
      registeredTx: a.registeredTx ?? byId.get(a.tokenId)?.registeredTx ?? null,
      registeredBlock: a.registeredBlock ?? byId.get(a.tokenId)?.registeredBlock ?? null,
      listed: true,
      rung: place?.rung ?? (a.name ? 1 : 0),
      rungName: place?.name ?? (a.name ? "Resolvable" : "Registered"),
      page: `${SITE}/agents/${a.tokenId}`,
    });
  }
  return [...byId.values()].sort((a, b) => Number(a.agentId) - Number(b.agentId));
}

/** BNB Chain's Set and Earn rules (1 Oct to 5 Nov 2026): three different agents, across at least two shortlisted marketplaces, and one agent of your own. */
export const CAMPAIGN = {
  hires: 3,
  marketplaces: 2,
  register: "https://forms.gle/jzTajVNZEgukeoYT9",
  page: "https://www.bnbchain.org/en/hackathons/smart-money-era-set-and-earn?tab=tracks",
  ends: CAMPAIGN_ENDS,
} as const;

export interface CountedHire {
  agentId: string;
  agentName: string | null;
  category: Category | null;
  kind: HireKind;
  tx: string | null;
  at: string | null;
}

/**
 * The hires that count toward the campaign, as MANDATE can see them: paid by
 * the wallet itself and confirmed on chain, each of a different agent, and
 * never of an agent the wallet owns (a builder hiring their own agent is
 * excluded by the rules). The earliest hire of each agent stands for it.
 * Pure, for tests.
 */
export function countedHires(hires: HireRow[], owned: string[]): CountedHire[] {
  const mine = new Set(owned);
  const byAgent = new Map<string, CountedHire>();
  const ordered = [...hires].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  for (const h of ordered) {
    if (!h.onChain || h.sponsored || mine.has(h.agentId) || byAgent.has(h.agentId)) continue;
    byAgent.set(h.agentId, { agentId: h.agentId, agentName: h.agentName, category: h.category, kind: h.kind, tx: h.tx, at: h.at });
  }
  return [...byAgent.values()];
}

export interface QuestProgress {
  wallet: string;
  team: boolean;
  /** Different agents this wallet hired here with its own money, confirmed on chain, its own agents left out. */
  agentsHired: CountedHire[];
  /** The campaign asks for this many different agents, across at least `marketplaces` shortlisted marketplaces; MANDATE is one. */
  campaign: { hires: number; marketplaces: number; register: string; page: string; ends: string };
  /** Hires of an agent in each job, from the wallet's own paid hires. */
  hired: Record<Category, boolean>;
  allFourHired: boolean;
  /** Agents this wallet owns whose card parses, so they are listed here by name. */
  agentsListed: number;
  /** The wallet's agent highest on the listing ladder. */
  bestAgent: { agentId: string; name: string | null; rung: number; rungName: string } | null;
  ratingsGiven: number;
  /** The quest as first drafted: an agent hired in all four jobs and one listed. Kept for readers of this API; the campaign's own rule is `campaign`. */
  complete: boolean;
  /**
   * What MANDATE can confirm toward the campaign: different agents hired here,
   * and whether an agent of this wallet's own is listed here. Hires on other
   * marketplaces, and the build's own checks, are counted by BNB Chain.
   */
  here: { hires: number; agentListed: boolean };
}

export async function questOf(wallet: string): Promise<QuestProgress> {
  const [h, owned] = await Promise.all([hiresOf(wallet), agentsOf(wallet)]);
  const agentsHired = countedHires(h.hires, owned.map((a) => a.agentId));
  const hired = Object.fromEntries(CATEGORIES.map((c) => [c, h.byCategory[c] > 0])) as Record<Category, boolean>;
  const allFourHired = CATEGORIES.every((c) => hired[c]);
  const listed = owned.filter((a) => a.rung >= 1);
  const best = [...owned].sort((a, b) => b.rung - a.rung)[0] ?? null;
  return {
    wallet: h.wallet,
    team: h.team,
    agentsHired,
    campaign: CAMPAIGN,
    hired,
    allFourHired,
    agentsListed: listed.length,
    bestAgent: best ? { agentId: best.agentId, name: best.name, rung: best.rung, rungName: best.rungName } : null,
    ratingsGiven: h.ratings.length,
    complete: allFourHired && listed.length > 0 && !h.team,
    here: { hires: h.team ? 0 : agentsHired.length, agentListed: listed.length > 0 },
  };
}

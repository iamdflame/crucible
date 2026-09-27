/**
 * The latest hire delivered on chain, as a receipt: who was hired, for what,
 * each transaction from payment to delivery to rating, and how long the work
 * took. Read from our own records of escrowed jobs, each checked against the
 * kernel when it was recorded; a hire paid by one of our own wallets says so,
 * and never counts toward anybody's quest.
 */

import { sql as pg } from "@/lib/db/client";
import { ensureTables } from "@/lib/db/tables";
import { findAgent } from "@/lib/data/agents";
import { isTeam } from "@/lib/team";
import type { Category } from "@/lib/config";

export interface Receipt {
  jobId: string;
  tokenId: string;
  agent: string;
  category: Category | null;
  budget: string;
  steps: { label: string; tx: string }[];
  deliveredInSeconds: number | null;
  team: boolean;
  outside: boolean;
  verified: boolean | null;
  at: string;
}

export async function latestReceipt(): Promise<Receipt | null> {
  if (!pg) return null;
  await ensureTables();
  const [r] = (await pg`
    select job_id, token_id, client, budget, slug, funded_tx, submit_tx, submitted_at, created_at, seller_verified
    from escrow_jobs
    where status in ('SUBMITTED', 'COMPLETED') and submit_tx is not null and funded_tx is not null
    order by submitted_at desc nulls last
    limit 1
  `.catch(() => [])) as { job_id: string; token_id: string; client: string; budget: string; slug: string; funded_tx: string; submit_tx: string; submitted_at: string | number | null; created_at: Date; seller_verified: boolean | null }[];
  if (!r) return null;
  const [rating] = (await pg`select tx from ratings where lower(hire_tx) = ${r.funded_tx.toLowerCase()} order by at desc limit 1`.catch(() => [])) as { tx: string }[];
  const a = findAgent(r.token_id);
  const funded = new Date(r.created_at).getTime() / 1000;
  const submitted = r.submitted_at === null ? null : Number(r.submitted_at);
  return {
    jobId: r.job_id,
    tokenId: r.token_id,
    agent: a?.name ?? `Agent #${r.token_id}`,
    category: (a?.category as Category | null) ?? null,
    budget: r.budget,
    steps: [
      { label: "Paid into escrow", tx: r.funded_tx },
      { label: "Delivered on chain", tx: r.submit_tx },
      ...(rating ? [{ label: "Rated by the buyer", tx: rating.tx }] : []),
    ],
    // Our record is written moments after the funding transaction, so this is the work's time, give or take a block.
    deliveredInSeconds: submitted !== null && submitted >= funded - 30 ? Math.max(1, Math.round(submitted - funded)) : null,
    team: isTeam(r.client),
    outside: r.slug === "",
    verified: r.seller_verified,
    at: submitted !== null ? new Date(submitted * 1000).toISOString() : new Date(r.created_at).toISOString(),
  };
}

/**
 * Paid calls to agents we do not operate, kept as evidence.
 *
 * A stranger hire over x402 settles the moment the seller submits the
 * transfer: the payment is the settlement, and the answer is the deliverable.
 * Each one is recorded here with the seller's exact bytes, accepted or
 * refused, so the site can show what was bought, from whom, for how much,
 * and what came back, and anyone can check the transfer on BscScan.
 *
 * Rows live in Postgres so a deployment (Judge Mode) can add them, and in
 * `src/data/paid-calls.json` so a clone without a database still shows every
 * call made from the operator's machine. Refusals are kept too: a seller that
 * would not take a correct payment is a finding, not a gap to paper over.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sql as pg } from "@/lib/db/client";
import { ensureTables as ensure } from "@/lib/db/tables";
import type { PaidCall } from "@/lib/x402/pay";
import { forget, memo } from "@/lib/cache";

export interface PaidCallRecord {
  id: string;
  tokenId: string;
  name: string;
  category: string;
  rail: "x402";
  url: string;
  payer: string;
  payTo: string | null;
  asset: string | null;
  amount: string | null;
  method: string | null;
  /** Money moved on chain. */
  paid: boolean;
  /** The seller answered with its work. A paid call can fail to deliver, and is shown as that. */
  delivered: boolean;
  refused: string | null;
  /**
   * Who got it wrong, when a call did not go through.
   *
   * The first payment to Agripinaa was refused because we sent the x402
   * specification's envelope to a seller that reads the Altana wire. The
   * refusal was correct and the mistake was ours. Deleting the row would have
   * been the easy fix and the wrong one: the tape keeps every attempt, and
   * this says which of us to hold responsible for each failure. Only
   * `"seller"` counts against an agent in the hire law.
   */
  fault?: "ours" | "seller" | null;
  /** Why, in a sentence, when the bytes alone do not explain it. */
  note?: string | null;
  tx: string | null;
  block: number | null;
  /**
   * The settlement as the chain has it: true once the transaction was read back
   * and moves exactly the price from the payer to the payee, false when the
   * named transaction does not. Unset until it has been read.
   */
  confirmed?: boolean | null;
  approveTx: string | null;
  /** Paid by Mandate on a visitor's behalf (Judge Mode), not by the operator's script. */
  sponsored: boolean;
  /** The wallet or position the call was about. */
  subject: string | null;
  /** Repository path of the full exchange, when written from the operator's machine. */
  evidence: string | null;
  transcriptSha256: string;
  deliverable: unknown;
  at: string;
  ms: number;
}

const FILE = join(process.cwd(), "src/data/paid-calls.json");

export function toRecord(
  call: PaidCall,
  meta: { tokenId: string; name: string; category: string; sponsored: boolean; subject: string | null; evidence: string | null },
): PaidCallRecord {
  const at = call.exchanges[0]?.at ?? new Date().toISOString();
  return {
    id: `${meta.tokenId}:${call.settlement?.tx ?? at}`,
    tokenId: meta.tokenId,
    name: meta.name,
    category: meta.category,
    rail: "x402",
    url: call.url,
    payer: call.payer,
    payTo: call.requirement?.payTo ?? null,
    asset: call.requirement?.asset ?? null,
    amount: call.requirement?.amount ?? null,
    method: call.requirement?.method ?? null,
    paid: call.paid,
    delivered: call.delivered,
    refused: call.refused,
    tx: call.settlement?.tx ?? null,
    block: call.settlement?.block ?? null,
    approveTx: call.approveTx,
    sponsored: meta.sponsored,
    subject: meta.subject,
    evidence: meta.evidence,
    transcriptSha256: createHash("sha256").update(JSON.stringify(call.exchanges)).digest("hex"),
    deliverable: call.deliverable,
    at,
    ms: call.ms,
    ...(call.payerShort ? { fault: "ours" as const, note: "Our paying wallet held less than the price, so no payment was signed." } : {}),
  };
}

/** Writes the full exchange under `docs/evidence/`, from the operator's machine only. */
export function writeEvidence(call: PaidCall, tokenId: string): string {
  const date = (call.exchanges[0]?.at ?? new Date().toISOString()).slice(0, 10);
  const stamp = (call.exchanges[0]?.at ?? new Date().toISOString()).slice(11, 19).replace(/:/g, "");
  const rel = `docs/evidence/${date}-${tokenId}-${stamp}.json`;
  const abs = join(process.cwd(), rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(call, null, 2)}\n`);
  return rel;
}

function readFile(): PaidCallRecord[] {
  if (!existsSync(FILE)) return [];
  try {
    return (JSON.parse(readFileSync(FILE, "utf8")) as { calls?: PaidCallRecord[] }).calls ?? [];
  } catch {
    return [];
  }
}

/** Stores a call in Postgres and, from the operator's machine, in the committed file. */
export async function recordPaidCall(rec: PaidCallRecord, opts: { file?: boolean } = {}): Promise<void> {
  if (opts.file) {
    const calls = readFile().filter((c) => c.id !== rec.id);
    calls.push(rec);
    calls.sort((a, b) => a.at.localeCompare(b.at));
    writeFileSync(FILE, `${JSON.stringify({ at: new Date().toISOString(), calls }, null, 2)}\n`);
  }
  forget("paid-calls");
  if (await ensure()) {
    await pg!`
      insert into paid_calls (id, token_id, category, paid, sponsored, tx, at, record)
      values (${rec.id}, ${rec.tokenId}, ${rec.category}, ${rec.paid}, ${rec.sponsored}, ${rec.tx}, ${rec.at}, ${JSON.stringify(rec)}::jsonb)
      on conflict (id) do update set record = excluded.record, tx = excluded.tx, paid = excluded.paid
    `;
  }
}

/** Every recorded call, newest first: the database's rows merged over the committed file. */
export function listPaidCalls(): Promise<PaidCallRecord[]> {
  // Read by the home page, the tape, the judge walk and Judge Mode; the rows
  // carry deliverables, so they are fetched once a minute per instance.
  return memo("paid-calls", { freshMs: 60_000, staleMs: 10 * 60_000 }, listPaidCallsUncached);
}

async function listPaidCallsUncached(): Promise<PaidCallRecord[]> {
  const byId = new Map(readFile().map((c) => [c.id, c]));
  if (await ensure()) {
    try {
      const rows = (await pg!`select record from paid_calls order by at desc limit 500`) as { record: PaidCallRecord }[];
      for (const r of rows) byId.set(r.record.id, r.record);
    } catch {
      /* the committed file stands */
    }
  }
  return oneRowPerExchange([...byId.values()]).sort((a, b) => b.at.localeCompare(a.at));
}

/*
  One exchange, one row.

  A call recorded before its settlement was found, and again once it was,
  arrives under two ids with the same transcript: the first Agripinaa payment
  sat in the database as refused and in the file as paid, and every page that
  listed calls showed it twice. The hash of the exchange is the identity, and
  the reading where money moved wins, because the transaction is the stronger
  fact.
*/
export function oneRowPerExchange(calls: PaidCallRecord[]): PaidCallRecord[] {
  const weight = (c: PaidCallRecord) => (c.tx ? 2 : 0) + (c.paid ? 1 : 0);
  const bySha = new Map<string, PaidCallRecord>();
  const unhashed: PaidCallRecord[] = [];
  for (const c of calls) {
    if (!c.transcriptSha256) {
      unhashed.push(c);
      continue;
    }
    const prior = bySha.get(c.transcriptSha256);
    if (!prior || weight(c) > weight(prior)) bySha.set(c.transcriptSha256, c);
  }
  return [...unhashed, ...bySha.values()];
}

/** Settled and delivered stranger hires, the earliest per category: the §15 evidence. */
export function settledByCategory(calls: PaidCallRecord[]): Record<string, PaidCallRecord | null> {
  const out: Record<string, PaidCallRecord | null> = {
    rebalancing: null,
    "grid-trading": null,
    "yield-optimisation": null,
    "health-factor": null,
  };
  for (const c of [...calls].sort((a, b) => a.at.localeCompare(b.at))) {
    if (c.paid && c.delivered && c.tx && c.category in out && !out[c.category]) out[c.category] = c;
  }
  return out;
}

/** The committed record, read synchronously, for callers that cannot await. */
export function paidCallsFromFile(): PaidCallRecord[] {
  return readFile();
}

export interface Outcome {
  tokenId: string;
  /** Calls where money moved and the seller answered with its work. */
  delivered: number;
  /** Calls where money moved and nothing came back. */
  paidNotDelivered: number;
  /** Calls where the seller refused a correctly signed payment. */
  refused: number;
  lastAt: string | null;
  lastWhy: string | null;
  lastTx: string | null;
  /** The most recent call we made was a failure the seller caused, and nothing has been delivered since. */
  lastFailed: boolean;
}

/**
 * What happened the last time we paid each agent.
 *
 * This is the memory the hire law needs. An agent can quote a price we can
 * sign and still fail the buyer: Agripinaa settled our payment on chain and
 * answered with an error, Hallmark refused a correct payment because it has
 * no facilitator configured. Both are payable and neither is hireable, and
 * the difference is only visible in what happened when we tried.
 */
export function outcomes(calls: PaidCallRecord[]): Map<string, Outcome> {
  const out = new Map<string, Outcome>();
  for (const c of [...calls].sort((a, b) => a.at.localeCompare(b.at))) {
    const o = out.get(c.tokenId) ?? { tokenId: c.tokenId, delivered: 0, paidNotDelivered: 0, refused: 0, lastAt: null, lastWhy: null, lastTx: null, lastFailed: false };
    // A failure we caused says nothing about the seller, so it is published
    // on the tape and left out of the count that gates hiring.
    const ours = c.fault === "ours";
    if (c.paid && c.delivered) o.delivered += 1;
    else if (c.paid) o.paidNotDelivered += 1;
    else if (!ours) o.refused += 1;
    // A delivery clears the memory; a failure the seller caused sets it until the next delivery.
    if (c.paid && c.delivered) o.lastFailed = false;
    else if (!ours) o.lastFailed = true;
    if (ours && !c.paid) {
      out.set(c.tokenId, o);
      continue;
    }
    o.lastAt = c.at;
    o.lastWhy = c.paid && c.delivered ? null : c.refused;
    o.lastTx = c.tx ?? o.lastTx;
    out.set(c.tokenId, o);
  }
  return out;
}

/**
 * Paid calls whose settlement has not been read back from the chain, newest
 * first: the queue for the scheduled confirmation pass.
 */
export async function unconfirmedCalls(limit = 20): Promise<PaidCallRecord[]> {
  if (!(await ensure())) return [];
  const rows = (await pg!`
    select record from paid_calls
    where record->>'payer' is not null
      and (record->>'confirmed') is null
      and at > now() - interval '30 days'
    order by at desc
    limit ${limit}
  `) as { record: PaidCallRecord }[];
  return rows.map((r) => r.record);
}

/**
 * A testnet job a buyer just funded to one of our agents, told to us so the
 * agent delivers now rather than on the next five-minute pass of the chain.
 *
 *   POST /api/escrow/testnet/jobs {"jobId": "123"}
 *
 * The job is read from the testnet kernel and taken on only with the checks
 * the watcher makes (ours, funded, bound to the dispute policy, at our price
 * in test $U), so nothing the caller says is trusted.
 */

import { after, NextResponse } from "next/server";
import { take, callerOf } from "@/lib/api/ratelimit";
import { deliverTestnet, recordTestnetFound, testnetJobRow } from "@/lib/escrow/testnet-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!take(`testnet-record:${callerOf(request)}`, { capacity: 20, windowMs: 60_000 }).ok) return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  let jobId = "";
  try {
    jobId = String(((await request.json()) as { jobId?: unknown }).jobId ?? "");
  } catch {
    /* answered below */
  }
  if (!/^\d{1,12}$/.test(jobId)) return NextResponse.json({ error: "Send {\"jobId\": \"…\"}, the testnet kernel's job number." }, { status: 400 });
  const r = await recordTestnetFound(BigInt(jobId), null).catch((e: Error) => `failed: ${e.message.split("\n")[0].slice(0, 160)}`);
  if (r !== "recorded" && r !== "already recorded") {
    // A node a block behind the wallet's reads a just-funded job as open: the caller retries.
    return NextResponse.json({ error: `Not taken on: ${r}.` }, { status: /failed|open/.test(r) ? 503 : 409 });
  }
  after(() => deliverTestnet(jobId).catch(() => undefined));
  const row = await testnetJobRow(jobId);
  return NextResponse.json({ ok: true, data: row ? { jobId: row.jobId, status: row.status, slug: row.slug, tokenId: row.tokenId } : null });
}

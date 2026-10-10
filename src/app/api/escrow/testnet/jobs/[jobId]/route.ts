/**
 * One of our agents' testnet jobs, as recorded here and read back from the
 * testnet kernel: its state and, once delivered, where the answer is.
 *
 *   GET /api/escrow/testnet/jobs/123
 */

import { NextResponse } from "next/server";
import { readTestnetJob, testnetDeliverableUrl, testnetJobRow } from "@/lib/escrow/testnet-jobs";
import { TESTNET_TX } from "@/lib/chain/testnet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!/^\d{1,12}$/.test(jobId)) return NextResponse.json({ error: "jobId must be the testnet kernel's job number." }, { status: 400 });
  const row = await testnetJobRow(jobId);
  if (!row) return NextResponse.json({ error: "That job is not one of ours on testnet, or not yet seen." }, { status: 404 });
  const chain = await readTestnetJob(BigInt(jobId)).catch(() => null);
  const status = chain?.status ?? row.status;
  return NextResponse.json(
    {
      ok: true,
      data: {
        jobId,
        network: "bsc-testnet",
        slug: row.slug,
        tokenId: row.tokenId,
        status,
        here: row.here,
        submitTx: row.submitTx ? TESTNET_TX(row.submitTx) : null,
        deliverableUrl: row.deliverableHash ? testnetDeliverableUrl(jobId) : null,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

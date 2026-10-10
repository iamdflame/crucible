/**
 * What one of our agents delivered for a testnet job: the DeliverableManifest
 * whose keccak256 is the commitment on the testnet kernel, byte for byte.
 */

import { NextResponse } from "next/server";
import { testnetDeliverable } from "@/lib/escrow/testnet-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!/^\d{1,12}$/.test(jobId)) return NextResponse.json({ error: "jobId must be the testnet kernel's job number." }, { status: 400 });
  const d = await testnetDeliverable(jobId);
  if (!d) return NextResponse.json({ error: "Nothing delivered for that testnet job here yet." }, { status: 404 });
  return new NextResponse(d.text, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-deliverable-keccak256": d.hash,
      "cache-control": "public, max-age=60",
      "access-control-allow-origin": "*",
    },
  });
}

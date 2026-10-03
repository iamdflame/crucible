/**
 * The hire funnel's counter.
 *
 *   POST /api/v1/funnel {"step": "open" | "try" | "funded" | "paid", "tokenId": "344119", "source": "x.com"}
 *
 * Sent by the hire drawer (lib/ops/funnel-client) so the promotion report can
 * say how many visitors open a hire, try an agent free and pay, by where they
 * came from. A count per day, nothing else; crawlers and floods are dropped.
 */

import { NextResponse } from "next/server";
import { CHAIN_ID } from "@/lib/config";
import { gate } from "@/lib/api/respond";
import { BOT, FUNNEL_STEPS, countStep, type FunnelStep } from "@/lib/ops/arrivals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = { capacity: 30, windowMs: 60_000 };

export async function POST(request: Request) {
  const g = gate(request, LIMIT, CHAIN_ID);
  if (!g.allowed) return new NextResponse(null, { status: 429, headers: g.headers });
  if (BOT.test(request.headers.get("user-agent") ?? "")) return new NextResponse(null, { status: 204 });
  let body: { step?: unknown; tokenId?: unknown; source?: unknown };
  try {
    // sendBeacon may label its body text/plain; it is JSON either way.
    body = JSON.parse(await request.text());
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  const step = FUNNEL_STEPS.find((s) => s === body.step) as FunnelStep | undefined;
  const tokenId = typeof body.tokenId === "string" && /^\d{1,12}$/.test(body.tokenId) ? body.tokenId : null;
  const source = typeof body.source === "string" && /^[a-z0-9._/-]{1,170}$/.test(body.source) ? body.source : "unknown";
  if (!step || !tokenId) return new NextResponse(null, { status: 400 });
  await countStep(step, tokenId, source);
  return new NextResponse(null, { status: 204 });
}

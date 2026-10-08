/**
 * The four jobs: how many agents can be hired for each right now, how many are
 * listed, and the lowest price among those that can.
 *
 *   GET /api/v1/market/jobs
 */

import { CHAIN_ID } from "@/lib/config";
import { gate, ok, preflight } from "@/lib/api/respond";
import { marketJobs } from "@/lib/market/market-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const LIMIT = { capacity: 30, windowMs: 60_000 };

export function OPTIONS() {
  return preflight();
}

export async function GET(request: Request) {
  const g = gate(request, LIMIT, CHAIN_ID);
  if (!g.allowed) return g.response;
  return ok({ jobs: await marketJobs() }, { chainId: CHAIN_ID }, g.headers);
}

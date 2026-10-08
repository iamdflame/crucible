/**
 * Search the marketplace: the agents /agents lists, in its order, each with
 * whether it can be hired now, how, at what price, and why not when it cannot.
 *
 *   GET /api/v1/market?q=venus&job=health-factor&view=ready&limit=10
 *
 * `view` is the page's tab: ready (the default), free, checked or all. A
 * search with `q` looks everywhere unless a view is named.
 */

import { CHAIN_ID } from "@/lib/config";
import { gate, ok, preflight } from "@/lib/api/respond";
import { searchMarket } from "@/lib/market/market-api";

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
  const sp = new URL(request.url).searchParams;
  const limit = Number(sp.get("limit"));
  const found = await searchMarket({
    q: sp.get("q")?.slice(0, 100) ?? undefined,
    job: sp.get("job") ?? sp.get("category") ?? undefined,
    view: sp.get("view") ?? undefined,
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
  });
  return ok(found, { chainId: CHAIN_ID }, g.headers);
}

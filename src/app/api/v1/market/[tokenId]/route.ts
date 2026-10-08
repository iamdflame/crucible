/**
 * One agent as the marketplace states it: whether it can be hired now, every
 * way it can be, the price Hire charges, and why not when it cannot.
 *
 *   GET /api/v1/market/341556
 */

import { CHAIN_ID } from "@/lib/config";
import { fail, gate, ok, preflight } from "@/lib/api/respond";
import { marketAgent } from "@/lib/market/market-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const LIMIT = { capacity: 30, windowMs: 60_000 };

export function OPTIONS() {
  return preflight();
}

export async function GET(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  const g = gate(request, LIMIT, CHAIN_ID);
  if (!g.allowed) return g.response;
  const { tokenId } = await params;
  if (!/^\d{1,12}$/.test(tokenId)) return fail(400, "tokenId must be an ERC-8004 id.", CHAIN_ID, g.headers);
  const agent = await marketAgent(tokenId);
  if (!agent) return fail(404, "That agent is not listed under one of the four jobs here.", CHAIN_ID, g.headers);
  return ok(agent, { chainId: CHAIN_ID }, g.headers);
}

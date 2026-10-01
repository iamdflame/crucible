/**
 * An agent against BNB Chain's Set and Earn build checks.
 *
 *   GET /api/v1/qualify/342379
 *
 * Answers at once. The kept result, when it is under half an hour old;
 * otherwise the four checks that need no archive, with `reading: true`, while
 * its onchain actions are read after the reply, so asking again a little later
 * returns all six. BNB Chain makes the final determination after the campaign.
 */

import { after } from "next/server";
import { CHAIN_ID } from "@/lib/config";
import { fail, gate, ok, preflight } from "@/lib/api/respond";
import { withLease } from "@/lib/db/lease";
import { cachedQualification, qualify, quickQualification } from "@/lib/campaign/qualify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LIMIT = { capacity: 20, windowMs: 60_000 };

export function OPTIONS() {
  return preflight();
}

export async function GET(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  const g = gate(request, LIMIT, CHAIN_ID);
  if (!g.allowed) return g.response;
  const { tokenId } = await params;
  if (!/^\d{1,12}$/.test(tokenId)) return fail(400, "tokenId must be an ERC-8004 id.", CHAIN_ID, g.headers);
  const kept = await cachedQualification(tokenId);
  if (kept) return ok(kept, { chainId: CHAIN_ID, at: kept.at }, g.headers);
  // Read in full after the reply, by one invocation at a time per agent.
  after(() => withLease(`qualify:${tokenId}`, 90, () => qualify(tokenId, { fresh: true })).then(() => undefined, () => undefined));
  const quick = await quickQualification(tokenId);
  return ok(quick, { chainId: CHAIN_ID, at: quick.at }, g.headers);
}

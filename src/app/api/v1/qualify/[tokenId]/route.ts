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
import { warm } from "@/lib/data/snapshots";
import { warmRegistry } from "@/lib/registry/tail";
import { warmOutcomes } from "@/lib/market/hire-law";
import { withTimeout } from "@/lib/cache";

// The census (live, priced), the registry tail and paid calls, as they stand now rather than as committed.
const fresh = () => withTimeout(Promise.all([warm().catch(() => undefined), warmRegistry().catch(() => undefined), warmOutcomes().catch(() => undefined)]), 9_000);

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
  await fresh();
  /*
    One full check at a time across every instance: each reads an archive
    that refuses bursts, and four at once failed (1 Oct). A check that finds
    the lease taken is picked up by the page's next poll, which asks again.
  */
  after(() => withLease("qualify:archive", 75, () => qualify(tokenId, { fresh: true })).then(() => undefined, () => undefined));
  const quick = await quickQualification(tokenId);
  return ok(quick, { chainId: CHAIN_ID, at: quick.at }, g.headers);
}

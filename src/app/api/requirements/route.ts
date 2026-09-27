/**
 * BNB's Phase 2 technical requirements, each worked out from what the site
 * can read, as last stored by the scheduler (every fifteen minutes).
 *
 *   GET /api/requirements
 */

import { CHAIN_ID } from "@/lib/config";
import { gate, ok } from "@/lib/api/respond";
import { snapshot, warm } from "@/lib/data/snapshots";
import { score, type Box } from "@/lib/ops/definition-of-done";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = { capacity: 30, windowMs: 60_000 };

export async function GET(request: Request) {
  const g = gate(request, LIMIT, CHAIN_ID);
  if (!g.allowed) return g.response;
  await warm(["requirements"]).catch(() => undefined);
  const s = snapshot<Box[]>("requirements");
  const boxes = s?.payload ?? [];
  return ok({ source: "https://docs.google.com/document/d/1OYXyhh78-2JzZs8XrcysrK5EZ5yEpp2FcGxTI_EW4eo", checkedAt: s?.capturedAt ?? null, score: score(boxes), requirements: boxes }, { chainId: CHAIN_ID }, g.headers);
}

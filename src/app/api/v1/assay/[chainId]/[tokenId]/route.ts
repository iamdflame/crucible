/**
 * A full assay of any agent on BSC. Free, unauthenticated, rate limited.
 *
 * The expensive endpoint, six tests against the chain, several seconds of
 * real work, so it carries the tightest limit. It is open anyway because an
 * assay office that only answered its own front end would be a trade
 * association, and because the argument this project makes is stronger if
 * anyone can check it, including the people competing with it.
 */

import { assayAgent } from "@/lib/assay";
import { fail, gate, ok, preflight } from "@/lib/api/respond";
import { withTimeout } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = { capacity: 10, windowMs: 60_000 };

export function OPTIONS() {
  return preflight();
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ chainId: string; tokenId: string }> },
) {
  const { chainId: raw, tokenId } = await params;
  const chainId = Number(raw);

  if (!Number.isFinite(chainId) || !/^\d{1,20}$/.test(tokenId)) {
    return fail(400, "chainId must be a number and tokenId a decimal integer", chainId || 56);
  }

  const g = gate(request, LIMIT, chainId);
  if (!g.allowed) return g.response;

  try {
    // Twelve seconds, as the interactive path uses: a public caller should be
    // told the index is unreachable rather than held open while it retries.
    // And forty seconds in all: a slow node or endpoint is said so, before the platform's own limit cuts the answer off.
    const report = await withTimeout(assayAgent(chainId, tokenId, undefined, { registryDeadlineMs: 12_000 }), 40_000);
    if (!report) return fail(504, "The assay took longer than 40 seconds: the chain or the agent's endpoint is slow just now. Try again in a minute.", chainId, g.headers);
    return ok(
      {
        chainId: report.chainId,
        tokenId: report.tokenId,
        agentId: report.agentId,
        name: report.name,
        ownerAddress: report.ownerAddress,
        agentWallet: report.agentWallet,
        fineness: report.fineness,
        hallmark: report.hallmark,
        hallmarked: report.fineness >= 375,
        category: report.category,
        categoryConfidence: report.categoryConfidence,
        registryScore: report.registryScore,
        results: report.results.map((r) => ({
          id: r.id,
          title: r.title,
          verdict: r.verdict,
          claim: r.claim,
          finding: r.finding,
          score: r.score,
          weight: r.weight,
          evidence: r.evidence,
        })),
        ms: report.ms,
        reproduce: `npm run assay -- ${tokenId}`,
      },
      { chainId, at: report.assayedAt },
      g.headers,
    );
  } catch (e) {
    // A failure names itself. The caller gets the reason, not a zero.
    return fail(
      502,
      e instanceof Error ? e.message : "the assay could not be completed",
      chainId,
      g.headers,
    );
  }
}

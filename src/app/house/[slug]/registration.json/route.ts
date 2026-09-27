/**
 * A reference agent's ERC-8004 registration file, at the URL its token points to.
 *
 * registration-v1, with `services` named the way our own assay reads them: an
 * `x402` service the census will call (and get a 402 with a price), an A2A
 * card, the MCP endpoint, and the page that shows its work. Every claim here is
 * one the six checks will test within minutes of the registration landing.
 */

import { NextResponse } from "next/server";
import { referenceBySlug, referenceRegistrations } from "@/lib/house";
import { IDENTITY_REGISTRY } from "@/lib/config";
import { RECIPIENT_BOUND, SWAP_BOUND } from "@/lib/chain/leash";
import { DEMO_ADDRESS } from "@/lib/demo";
import { hirePauseForSlug, pauseForSlug } from "@/lib/market/paused";
import { SITE } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOST = SITE;

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const agent = referenceBySlug(slug);
  if (!agent) return NextResponse.json({ error: "No reference agent by that name." }, { status: 404 });
  const reg = referenceRegistrations()[slug];
  // A paused agent says so to anyone reading its registration, and stops advertising a price it will not take.
  const pause = hirePauseForSlug(slug);
  // A trading pause is said too: it still sells its answer, but it is not acting on anyone's account.
  const trading = pauseForSlug(slug);
  const leash =
    slug === "range-1"
      ? { contract: RECIPIENT_BOUND, what: "RecipientBound: mint and collect write the principal as recipient" }
      : slug === "grid-1"
        ? { contract: SWAP_BOUND, what: "SwapBound: fixed pair, proceeds only to the principal" }
        : { contract: null, what: "Venus markets whose calls act for the caller; no recipient argument" };

  return NextResponse.json(
    {
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: agent.name,
      description: agent.description,
      category: agent.category,
      services: [
        ...(pause ? [] : [{ name: "x402", endpoint: `${HOST}/api/x402/house/${slug}` }]),
        // BNB's agent SDK appends /.well-known/agent-card.json to this endpoint; the card names the JSON-RPC endpoint itself.
        { name: "A2A", endpoint: `${HOST}/a2a/${slug}`, version: "0.3.0" },
        { name: "agentCard", endpoint: `${HOST}/a2a/${slug}/.well-known/agent-card.json` },
        { name: "MCP", endpoint: `${HOST}/api/mcp` },
        { name: "web", endpoint: `${HOST}/desk#${slug}` },
      ],
      x402Support: !pause,
      active: !pause,
      ...(pause ? { paused: { since: pause.since, reason: pause.reason } } : {}),
      ...(!pause && trading ? { tradingPaused: { since: trading.since, reason: trading.reason } } : {}),
      registrations: reg ? [{ agentId: Number(reg.tokenId), agentRegistry: `eip155:56:${IDENTITY_REGISTRY}` }] : [],
      supportedTrust: ["crypto-economic"],
      operates: { account: DEMO_ADDRESS, through: "Altana session keys the account's owner granted", leash },
      ...(pause ? {} : { price: { amount: "0.05", asset: "USD1", scheme: "x402 exact, EIP-3009" } }),
    },
    { headers: { "cache-control": "public, max-age=60", "access-control-allow-origin": "*" } },
  );
}

/**
 * A live, verified price for an escrowed job with an outside agent, and the
 * exact description to open it with.
 *
 *   POST /api/escrow/quote {"tokenId": "341554", "inputs": {"task": "…"}}
 *
 * For an agent built on BNB's agent SDK (Agent Studio agents are), the quote
 * is signed by the agent and the job's on-chain description must carry it, or
 * the agent refuses the job. The signature is checked here against the wallets
 * the agent's ERC-8004 registration names before the buyer is shown a price.
 * The task is written from what the buyer entered, with "via mandatemarkets.com"
 * inside the signed text, so the job says on chain where it was opened.
 */

import { NextResponse } from "next/server";
import { CHAIN_ID } from "@/lib/config";
import { fail, gate, ok } from "@/lib/api/respond";
import { CORS } from "@/lib/api/ratelimit";
import { warm } from "@/lib/data/snapshots";
import { escrowQuoteMap, getProbes } from "@/lib/data/probes";
import { findAgent } from "@/lib/data/agents";
import { readRegistryEntry } from "@/lib/sources/registry";
import { negotiateFull } from "@/lib/escrow/a2a";
import { jobDescription } from "@/lib/escrow/sdk";
import { outsideDescription } from "@/lib/escrow/contracts";
import { taskFor } from "@/lib/escrow/task";
import { poolNow } from "@/lib/house/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = { capacity: 12, windowMs: 60_000 };

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...CORS, "access-control-allow-methods": "POST, OPTIONS" } });
}

export async function POST(request: Request) {
  const g = gate(request, LIMIT, CHAIN_ID);
  if (!g.allowed) return g.response;
  let body: { tokenId?: unknown; inputs?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail(400, 'Send JSON: {"tokenId": "…", "inputs": {}}', CHAIN_ID, g.headers);
  }
  const tokenId = typeof body.tokenId === "string" && /^\d{1,12}$/.test(body.tokenId) ? body.tokenId : null;
  if (!tokenId) return fail(400, "tokenId must be an ERC-8004 id.", CHAIN_ID, g.headers);
  const inputs = Object.fromEntries(
    Object.entries(body.inputs && typeof body.inputs === "object" ? (body.inputs as Record<string, unknown>) : {})
      .filter((e): e is [string, string] => /^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(e[0]) && typeof e[1] === "string")
      // A structured task (an agent card's example form) can be longer than a field.
      .map(([k, v]) => [k, v.slice(0, k === "task" ? 2_000 : 240)]),
  );

  await warm(["probe", "escrow-quotes"]);
  const known = escrowQuoteMap()[tokenId];
  if (!known) return fail(404, "That agent has no escrow seller on record here.", CHAIN_ID, g.headers);
  const agent = findAgent(tokenId);
  const entry = await readRegistryEntry(tokenId).catch(() => null);
  const signers = [entry?.owner, typeof entry?.card?.agentWallet === "string" ? entry.card.agentWallet : null].filter((w): w is string => Boolean(w));
  // A grid's blank bounds are set around the price now, so the agent gets a band it can plan inside.
  const bnbUsd = agent?.category === "grid-trading" ? await poolNow().then((p) => p.usdtPerBnb, () => null) : null;
  // A seller priced on its card's own example reads only that form: the buyer's edit of it, or the example itself.
  const task = known.task ? inputs.task?.trim() || known.task : taskFor(agent?.category ?? null, agent?.name ?? `Agent ${tokenId}`, inputs, { bnbUsd });

  const live = await negotiateFull(known.a2a, task, { signers, notify: known.notify, skill: known.skill }).catch((e: Error) => ({ error: e.message }));
  if ("error" in live) return fail(502, `The agent's seller did not quote just now: ${live.error.slice(0, 120)}`, CHAIN_ID, g.headers);
  const q = live.quote;
  if (q.unpayable) return fail(409, `This agent cannot be hired here right now: ${q.unpayable}.`, CHAIN_ID, g.headers);

  const description = live.sdk ? jobDescription(live.sdk) : outsideDescription(q.serviceName ?? agent?.name ?? task, q.service, inputs);
  return ok(
    {
      kind: live.sdk ? "sdk" : "simple",
      provider: q.provider,
      price: q.price,
      description,
      expiresAt: live.sdk ? (live.sdk.quote_expires_at ?? live.sdk.response.quote_expires_at ?? null) : null,
      etaSeconds: q.etaSeconds,
      task,
    },
    { chainId: CHAIN_ID },
    g.headers,
  );
}

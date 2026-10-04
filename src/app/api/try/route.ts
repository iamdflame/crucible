/**
 * Try an agent free, before paying: its own endpoint, asked exactly the task
 * a paid job would carry.
 *
 *   POST /api/try {"tokenId": "341556", "inputs": {"wallet": "0x…"}}
 *
 * Agents built on BNB's agent SDK often answer a plain A2A message for free;
 * this asks it on the buyer's behalf (browsers cannot call most agents'
 * servers directly) and hands back what it said. Nothing is paid or signed.
 * An agent that only answers paid jobs is said to, rather than shown an error.
 *
 * Our own four agents answer free here too: the same service a paid job runs,
 * about the wallet the buyer names, or the demo account when they name none.
 * A free try is for seeing the work before paying; it is not a hire and never
 * counts toward Set and Earn.
 */

import { NextResponse } from "next/server";
import { CHAIN_ID } from "@/lib/config";
import { fail, gate, ok } from "@/lib/api/respond";
import { CORS } from "@/lib/api/ratelimit";
import { warm } from "@/lib/data/snapshots";
import { getProbes } from "@/lib/data/probes";
import { findAgent } from "@/lib/data/agents";
import { tryFree } from "@/lib/escrow/a2a";
import { taskFor } from "@/lib/escrow/task";
import { poolNow } from "@/lib/house/services";
import { errorOnly } from "@/lib/conformance/run";
import { HOUSE_SERVICES } from "@/lib/house/services";
import { houseSlug } from "@/lib/market/performance";
import { DEMO_ADDRESS } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const LIMIT = { capacity: 6, windowMs: 60_000 };

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
      .map(([k, v]) => [k, v.slice(0, 240)]),
  );
  // One of ours: its own service, exactly as a paid job would run it.
  const slug = houseSlug(tokenId);
  const service = slug ? HOUSE_SERVICES[slug] : undefined;
  if (service) {
    const named = inputs.position && /^\d{1,10}$/.test(inputs.position) ? { position: inputs.position } : null;
    const wallet = inputs.wallet && /^0x[0-9a-fA-F]{40}$/.test(inputs.wallet) ? inputs.wallet : null;
    const input = named ?? { wallet: wallet ?? DEMO_ADDRESS };
    const refused = service.validate(input);
    if (refused) return fail(400, refused, CHAIN_ID, g.headers);
    const task = `${service.name} for ${named ? `position ${named.position}` : wallet ? wallet : `the demo account ${DEMO_ADDRESS}, since no wallet was named`}`;
    const answer = await service.run(input).catch((e: Error) => ({ tryError: e.message }));
    if (answer && typeof answer === "object" && "tryError" in answer) return fail(502, `It could not answer just now: ${String(answer.tryError).slice(0, 120)}`, CHAIN_ID, g.headers);
    return ok({ free: true, task, answer }, { chainId: CHAIN_ID }, g.headers);
  }
  await warm(["probe"]);
  const q = getProbes().escrowQuotes?.[tokenId];
  if (!q || q.kind !== "sdk") return fail(404, "This agent has no free call to try.", CHAIN_ID, g.headers);
  const agent = findAgent(tokenId);
  const bnbUsd = agent?.category === "grid-trading" ? await poolNow().then((p) => p.usdtPerBnb, () => null) : null;
  const task = taskFor(agent?.category ?? null, agent?.name ?? `Agent ${tokenId}`, inputs, { bnbUsd });
  const answer = await tryFree(q.a2a, task).catch((e: Error) => ({ tryError: e.message }));
  if (answer && typeof answer === "object" && "tryError" in answer) return fail(502, `The agent did not answer just now: ${String(answer.tryError).slice(0, 120)}`, CHAIN_ID, g.headers);
  const refused = errorOnly(answer);
  if (refused) return ok({ free: false, reason: `It answers only paid jobs (${refused}).`, task }, { chainId: CHAIN_ID }, g.headers);
  return ok({ free: true, task, answer }, { chainId: CHAIN_ID }, g.headers);
}

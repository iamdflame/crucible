/**
 * The build prompt as plain text, for an AI assistant to read at a link.
 *
 *   GET /api/build/prompt?job=health-factor&network=mainnet&wallet=0x…&idea=…
 *
 * The prompt is longer than a chat link can carry, so "Open in Claude" and
 * "Open in ChatGPT" send one short line asking the assistant to read this.
 */

import { NextResponse } from "next/server";
import { CATEGORIES, type Category } from "@/lib/config";
import { buildPrompt } from "@/lib/build/prompt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const job = sp.get("job") ?? "";
  if (!(CATEGORIES as readonly string[]).includes(job)) {
    return NextResponse.json({ error: `job must be one of: ${CATEGORIES.join(", ")}` }, { status: 400 });
  }
  const network = sp.get("network") === "testnet" ? "testnet" : "mainnet";
  const wallet = sp.get("wallet");
  const text = buildPrompt({ job: job as Category, network, wallet: wallet && /^0x[0-9a-fA-F]{40}$/.test(wallet) ? wallet : null, idea: sp.get("idea")?.slice(0, 400) ?? null });
  return new NextResponse(text, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } });
}

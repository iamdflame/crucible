/**
 * Free liquidation alerts, from the site.
 *
 *   GET  /api/alerts                    whether alerts are on, and the bot's @name
 *   GET  /api/alerts?wallet=0x…         that wallet's Venus health factor now
 *   POST /api/alerts {"wallet": "0x…", "threshold": 1.3}
 *                                       a Telegram link whose Start button watches it
 *
 * Nothing is signed: a wallet's Venus position is public, so watching one
 * needs only its address. The link carries a one-day code; the wallet and
 * level stay on our side until the chat that presses Start claims them.
 */

import { NextResponse } from "next/server";
import { CHAIN_ID } from "@/lib/config";
import { fail, gate, ok } from "@/lib/api/respond";
import { CORS } from "@/lib/api/ratelimit";
import { alertsOn, botName } from "@/lib/alerts/telegram";
import { createCode, describe, MAX_THRESHOLD, MIN_THRESHOLD, parseWallet, readWallet, validThreshold } from "@/lib/alerts/watch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = { capacity: 20, windowMs: 60_000 };

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...CORS, "access-control-allow-methods": "GET, POST, OPTIONS" } });
}

export async function GET(request: Request) {
  const g = gate(request, LIMIT, CHAIN_ID);
  if (!g.allowed) return g.response;
  const raw = new URL(request.url).searchParams.get("wallet");
  const bot = await botName();
  if (raw === null) return ok({ on: alertsOn() && Boolean(bot), bot, min: MIN_THRESHOLD, max: MAX_THRESHOLD }, { chainId: CHAIN_ID }, g.headers);
  const wallet = parseWallet(raw);
  if (!wallet) return fail(400, "wallet must be a 0x address.", CHAIN_ID, g.headers);
  const r = await readWallet(wallet, MIN_THRESHOLD);
  return ok({ wallet, state: r.state, healthFactor: r.hf, collateralUsd: r.collateralUsd, debtUsd: r.debtUsd, words: describe(r) }, { chainId: CHAIN_ID }, g.headers);
}

export async function POST(request: Request) {
  const g = gate(request, LIMIT, CHAIN_ID);
  if (!g.allowed) return g.response;
  const bot = await botName();
  if (!bot) return fail(503, "Alerts are not switched on yet.", CHAIN_ID, g.headers);
  let body: { wallet?: unknown; threshold?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail(400, 'Send JSON: {"wallet": "0x…", "threshold": 1.3}', CHAIN_ID, g.headers);
  }
  const wallet = parseWallet(String(body.wallet ?? ""));
  const threshold = Number(body.threshold ?? 1.3);
  if (!wallet) return fail(400, "wallet must be a 0x address.", CHAIN_ID, g.headers);
  if (!validThreshold(threshold)) return fail(400, `threshold is the health factor that wakes you, from ${MIN_THRESHOLD} to ${MAX_THRESHOLD}.`, CHAIN_ID, g.headers);
  const code = await createCode(wallet, threshold);
  return ok({ link: `https://t.me/${bot}?start=${code}`, bot }, { chainId: CHAIN_ID }, g.headers);
}

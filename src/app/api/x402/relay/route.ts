/**
 * The browser's way to a seller that does not speak to browsers.
 *
 *   POST /api/x402/relay { tokenId, subject?, paid?: { header, value } }
 *
 * A visitor's wallet can sign a payment, but the page cannot always deliver
 * it: Muster's server sends no CORS headers, so Chrome refuses to show the
 * page its 402, let alone its answer. This forwards the call server-side and
 * hands back the seller's status, the payment headers and the body.
 *
 * It is not a proxy. The destination is derived from the agent named, either
 * its sponsored call or the endpoint that quoted us in the census, so a
 * caller cannot aim it at anything else. The signed header it carries
 * authorises one transfer of one amount to the seller's own address, which is
 * exactly what forwarding it does.
 */

import { after, NextResponse } from "next/server";
import { fromBase64, readRequirements, type Requirement } from "@/lib/x402/pay";
import { exchange } from "@/lib/x402/pay-server";
import { recordPaidCall, toRecord } from "@/lib/market/paid-calls";
import { confirmSettlement } from "@/lib/market/settlement";
import type { Address } from "viem";
import { SPONSORED } from "@/lib/market/sponsored-targets";
import { listingFor } from "@/lib/market/listing";
import { take, callerOf, limitHeaders } from "@/lib/api/ratelimit";
import { live } from "@/lib/data/live";
import { whyUnsafe, whyUnsafeHost } from "@/lib/net/safe-fetch";
import { cleanInputs, inputsFor, withInputs } from "@/lib/market/inputs";
import { previewFor } from "@/lib/market/quotes";
import { paymentHeaders } from "@/lib/x402/pay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const KEPT = ["content-type", "payment-required", "payment-response", "x-payment-response", "www-authenticate"];

export async function POST(request: Request) {
  const limit = take(`relay:${callerOf(request)}`, { capacity: 12, windowMs: 60_000 });
  if (!limit.ok) return NextResponse.json({ error: "Too many calls in a minute." }, { status: 429, headers: limitHeaders(limit) });

  let tokenId = "";
  let subject: string | undefined;
  let given: unknown;
  let paid: { header: string; value: string } | undefined;
  try {
    const b = (await request.json()) as { tokenId?: unknown; subject?: unknown; inputs?: unknown; paid?: { header?: unknown; value?: unknown } };
    tokenId = String(b.tokenId ?? "");
    subject = typeof b.subject === "string" ? b.subject.trim().slice(0, 64) : undefined;
    given = b.inputs;
    if (b.paid && typeof b.paid.header === "string" && typeof b.paid.value === "string" && /^(X-PAYMENT|PAYMENT-SIGNATURE)$/i.test(b.paid.header)) {
      paid = { header: b.paid.header.toUpperCase(), value: b.paid.value.slice(0, 16_384) };
    }
  } catch {
    return NextResponse.json({ error: "Send a JSON body naming a tokenId." }, { status: 400 });
  }

  await live();
  const sponsored = SPONSORED[tokenId];
  const listing = listingFor(tokenId);
  let url = sponsored ? sponsored.url(subject) : listing?.quote?.endpoint;
  if (!url) return NextResponse.json({ error: "That agent has no endpoint we have a quote from." }, { status: 404 });
  /*
    The inputs the agent itself declares, and only those, with plain values.
    A paid call missing one is refused here, before any payment is read.
  */
  if (!sponsored) {
    const clean = cleanInputs(inputsFor(tokenId, previewFor(tokenId)), given);
    if (!clean.ok) return NextResponse.json({ error: clean.error }, { status: 400 });
    url = withInputs(url, clean.values);
    subject = subject ?? clean.values.wallet ?? clean.values.position ?? clean.values.address ?? undefined;
  }
  // The same rule as every other call to a stranger; exchange() also checks each redirect.
  const unsafe = whyUnsafe(url) ?? (await whyUnsafeHost(new URL(url).hostname));
  if (unsafe) return NextResponse.json({ error: `That endpoint is not one this relay will call: ${unsafe}.` }, { status: 400 });

  const method = sponsored?.method ?? "GET";
  const body = sponsored?.body === undefined ? undefined : JSON.stringify(sponsored.body);
  const { ex } = await exchange(url, {
    method,
    headers: {
      accept: "application/json, text/event-stream",
      ...(body ? { "content-type": "application/json" } : {}),
      ...(paid ? paymentHeaders(paid.header, paid.value) : {}),
    },
    body,
    timeoutMs: 45_000,
  }).catch((e: Error) => ({ ex: null, error: e.message.split("\n")[0].slice(0, 160) }) as never);

  if (!ex) return NextResponse.json({ error: "The seller did not answer." }, { status: 502 });
  const headers: Record<string, string> = {};
  for (const k of KEPT) if (ex.response.headers[k]) headers[k] = ex.response.headers[k];

  /*
    A paid call made from a visitor's wallet is a stranger hire like any
    other and belongs on the tape, so the six checks and the activity page see
    it. The payer is the address inside the envelope the visitor signed; the
    settlement is the seller's receipt header when it sends one.
  */
  if (paid) {
    try {
      const env = JSON.parse(fromBase64(paid.value)) as { payload?: { authorization?: { from?: string }; permit2Authorization?: { from?: string }; from?: string } };
      const payer = (env.payload?.authorization?.from ?? env.payload?.permit2Authorization?.from ?? env.payload?.from ?? "0x0000000000000000000000000000000000000000") as Address;
      const accepted = readRequirements(JSON.parse(ex.response.body || "null"), ex.response.headers["payment-required"]).find(() => true) ?? null;
      const receipt = decodeReceipt(ex.response.headers["payment-response"] ?? ex.response.headers["x-payment-response"]);
      const ok = ex.response.status < 400;
      const req: Requirement | null = accepted ?? quoted(listing);
      const call = {
        url,
        paid: ok && Boolean(receipt),
        delivered: ok,
        refused: ok ? null : `it answered ${ex.response.status} to the signed payment: ${ex.response.body.slice(0, 400)}`,
        requirement: req ? { ...req, amount: req.amount.toString() } : null,
        payer,
        approveTx: null,
        settlement: receipt ? { tx: receipt, block: null, source: "payment-response header" as const } : null,
        deliverable: parseMaybe(ex.response.body),
        exchanges: [ex],
        ms: ex.response.ms,
      };
      const rec = toRecord(call, { tokenId, name: listing?.name ?? `#${tokenId}`, category: sponsored?.category ?? (listing?.category as string) ?? "unclassified", sponsored: false, subject: subject ?? null, evidence: null });
      await recordPaidCall(rec);
      // Read back from the chain once the visitor has the answer: the chain, not the seller's header, says whether it was paid.
      after(async () => {
        const checked = await confirmSettlement(rec).catch(() => rec);
        if (checked !== rec) await recordPaidCall(checked).catch(() => undefined);
      });
    } catch {
      /* the tape is best effort; the visitor still gets the answer */
    }
  }
  return NextResponse.json(
    { url, status: ex.response.status, headers, body: ex.response.body, truncated: ex.response.truncated, ms: ex.response.ms },
    { headers: { "cache-control": "no-store" } },
  );
}

function decodeReceipt(raw: string | undefined): `0x${string}` | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(fromBase64(raw)) as { transaction?: string; txHash?: string; tx?: string };
    const tx = d.transaction ?? d.txHash ?? d.tx;
    return tx && /^0x[0-9a-fA-F]{64}$/.test(tx) ? (tx as `0x${string}`) : null;
  } catch {
    return null;
  }
}

/** The terms we last read from this seller, when its paid answer carries none. */
function quoted(listing: ReturnType<typeof listingFor>): Requirement | null {
  const q = listing?.quote;
  if (!q) return null;
  return {
    x402Version: q.x402Version === 2 ? 2 : 1,
    raw: {},
    scheme: q.scheme,
    network: q.network,
    chainId: q.chainId,
    asset: q.asset as Address,
    payTo: q.payTo as Address,
    amount: BigInt(q.amount),
    maxTimeoutSeconds: 120,
    method: q.transferMethod,
    domain: null,
    spender: null,
    resource: q.resource ? { url: q.resource } : null,
    header: q.header,
    dialect: "x402",
  };
}

function parseMaybe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

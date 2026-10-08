/**
 * Paying a stranger for one call, on the server.
 *
 * Everything here talks to a seller's URL, which came out of a registry, so
 * it goes through the network guard (lib/net/safe-fetch). It is split from
 * ./pay because that module is also loaded in the browser by the buy button,
 * and the guard resolves names with Node's DNS, which a browser bundle
 * cannot carry.
 */

import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { logClients, marketClient } from "@/lib/chain/market";
import { safeFetch } from "@/lib/net/safe-fetch";
import {
  CAP_BYTES,
  KEPT_HEADERS,
  TRANSFER,
  decodeHeader,
  ensurePermit2Allowance,
  heldBy,
  readRequirements,
  signPayment,
  whyUnpayable,
  type Exchange,
  type PaidCall,
  type Requirement,
  type Settlement,
  paymentHeaders,
} from "./pay";

/**
 * One request to a seller, kept byte for byte.
 *
 * Sellers are strangers whose URLs came out of a registry, so this goes
 * through the same guard as the probe: public https only, every redirect
 * checked before it is followed, the body capped.
 */
export async function exchange(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number },
): Promise<{ ex: Exchange; res: { status: number; headers: Headers }; text: string }> {
  const started = Date.now();
  const method = init.method ?? "GET";
  const res = await safeFetch(url, { method, headers: init.headers, body: init.body, timeoutMs: init.timeoutMs ?? 30_000, maxBytes: CAP_BYTES });
  const { text, truncated } = res;
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (KEPT_HEADERS.test(k)) headers[k] = v;
  });
  const sentHeaders = Object.fromEntries(Object.entries(init.headers ?? {}).filter(([k]) => KEPT_HEADERS.test(k) || /^accept$/i.test(k)));
  return {
    ex: {
      at: new Date(started).toISOString(),
      request: { method, url, headers: sentHeaders, ...(init.body ? { body: init.body } : {}) },
      response: { status: res.status, headers, body: text, truncated, ms: Date.now() - started },
    },
    res,
    text,
  };
}

function txFromHeader(ex: Exchange): Hex | null {
  const raw = ex.response.headers["payment-response"] ?? ex.response.headers["x-payment-response"];
  const doc = decodeHeader(raw);
  const tx = (doc?.transaction ?? doc?.txHash ?? doc?.tx ?? doc?.transactionHash) as string | undefined;
  return tx && /^0x[0-9a-fA-F]{64}$/.test(tx) ? (tx as Hex) : null;
}

/**
 * Finds the transfer that paid the seller, on chain.
 *
 * A seller may settle after answering, or never say how it settled. The
 * payment is the token moving from payer to payee for the amount, after the
 * block the call was made at; that is looked for directly, for up to a
 * couple of minutes.
 */
export async function findSettlement(
  r: Requirement,
  from: Address,
  fromBlock: bigint,
  opts: { waitMs?: number } = {},
): Promise<Settlement | null> {
  const deadline = Date.now() + (opts.waitMs ?? 120_000);
  while (Date.now() < deadline) {
    const head = await marketClient.getBlockNumber().catch(() => null);
    if (head !== null) {
      for (const c of logClients) {
        try {
          const logs = await c.getLogs({ address: r.asset, event: TRANSFER, args: { from, to: r.payTo }, fromBlock, toBlock: head });
          const hit = logs.find((l) => (l.args as { value?: bigint }).value === r.amount) ?? logs[0];
          if (hit) return { tx: hit.transactionHash!, block: Number(hit.blockNumber), source: "token Transfer log" };
          break;
        } catch {
          /* next provider */
        }
      }
    }
    await new Promise((ok) => setTimeout(ok, 4_000));
  }
  return null;
}

const serialisable = (r: Requirement) => ({ ...r, amount: r.amount.toString() });

/**
 * Asks unpaid, reads the terms, signs, asks again carrying the payment, and
 * finds the settlement. Refuses to pay above `maxAmount` or in any token
 * outside `PAYABLE_ASSETS`.
 */
export async function payAndCall(opts: {
  url: string;
  key: Hex;
  maxAmount: bigint;
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  settleWaitMs?: number;
}): Promise<PaidCall> {
  const started = Date.now();
  const account = privateKeyToAccount(opts.key);
  const method = opts.method ?? "GET";
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const baseHeaders: Record<string, string> = {
    accept: "application/json, text/event-stream",
    ...(body ? { "content-type": "application/json" } : {}),
    ...(opts.headers ?? {}),
  };
  const exchanges: Exchange[] = [];
  const out = (partial: Partial<PaidCall>): PaidCall => ({
    url: opts.url,
    paid: false,
    delivered: false,
    refused: null,
    requirement: null,
    payer: account.address,
    approveTx: null,
    settlement: null,
    deliverable: null,
    exchanges,
    ms: Date.now() - started,
    ...partial,
  });

  const first = await exchange(opts.url, { method, headers: baseHeaders, body });
  exchanges.push(first.ex);
  if (first.res.status !== 402) {
    return out({ refused: `it answered ${first.res.status} without asking for payment`, deliverable: parseMaybe(first.text) });
  }

  const offers = readRequirements(parseMaybe(first.text), first.res.headers.get("payment-required"));
  const usable = offers.find((o) => !whyUnpayable(o) && o.amount <= opts.maxAmount);
  if (!usable) {
    const reasons = offers.map((o) => whyUnpayable(o) ?? `it asks ${o.amount}, above the ${opts.maxAmount} this call may spend`);
    return out({ refused: reasons.join("; ") || "its 402 names no requirement this client can read" });
  }

  /*
    The trial pool paid Agripinaa Ranger 0.05 USDT on 6 Oct and kept 0.0135.
    The next five Agripinaa payments were signed anyway, failed at the
    transfer (TRANSFER_FROM_FAILED), and were held against the sellers. A
    payer that cannot cover the price signs nothing.
  */
  const held = await heldBy(account.address, usable.asset).catch(() => null);
  if (held !== null && held < usable.amount) {
    return out({
      payerShort: true,
      requirement: serialisable(usable),
      refused: `our paying wallet holds ${held} of the token it asks for, less than its price of ${usable.amount}, so nothing was signed`,
    });
  }

  let approveTx: Hex | null = null;
  if (usable.method === "permit2") approveTx = await ensurePermit2Allowance(opts.key, usable.asset, usable.amount);

  const startBlock = await marketClient.getBlockNumber();
  const signed = await signPayment(account, usable);
  const second = await exchange(opts.url, { method, headers: { ...baseHeaders, ...paymentHeaders(signed.header, signed.value) }, body });
  exchanges.push(second.ex);
  const deliverable = parseMaybe(second.text);

  if (second.res.status >= 400) {
    /*
      A seller can take the money and still answer with an error. Agripinaa's
      facilitator broadcast a settlement and then answered 402, because its own
      RPC refused to read the receipt. So the transfer is looked for anyway: a
      payment that moved is recorded as paid, with no deliverable, whatever the
      status code said.
    */
    const moved = await findSettlement(usable, account.address, startBlock, { waitMs: Math.min(opts.settleWaitMs ?? 45_000, 45_000) });
    return out({
      paid: Boolean(moved),
      requirement: serialisable(usable),
      approveTx,
      settlement: moved,
      refused: `it answered ${second.res.status} to the signed payment: ${refusalText(second.ex)}`,
      deliverable,
    });
  }

  const fromHeader = txFromHeader(second.ex);
  const settlement: Settlement | null = fromHeader
    ? { tx: fromHeader, block: null, source: "payment-response header" }
    : await findSettlement(usable, account.address, startBlock, { waitMs: opts.settleWaitMs });

  return out({ paid: true, delivered: true, requirement: serialisable(usable), approveTx, settlement, deliverable });
}

/**
 * The seller's own words for a refusal.
 *
 * Some sellers put the reason in the body; others leave the body `{}` and put
 * it in the re-issued `PAYMENT-REQUIRED` header's `error`. Hallmark did the
 * latter, and its reason (no facilitator configured) was the whole story.
 */
export function refusalText(ex: Exchange): string {
  const fromHeader = decodeHeader(ex.response.headers["payment-required"])?.error;
  const body = ex.response.body.trim();
  const parts = [body && body !== "{}" ? body.slice(0, 600) : null, typeof fromHeader === "string" ? fromHeader : null].filter(Boolean);
  return parts.length ? parts.join(" | ") : "no reason given";
}

function parseMaybe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // An SSE answer from an MCP server: keep the last `data:` line's JSON.
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    for (let i = data.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(data[i]);
      } catch {
        /* earlier line */
      }
    }
    return text;
  }
}

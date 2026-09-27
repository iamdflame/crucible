/**
 * Outside agents that sell through ERC-8183 escrow, priced over A2A.
 *
 * Some sellers on this registry do not answer a paid call. They publish an A2A
 * agent card with two skills, `negotiate` and `notify_funded`: ask for a
 * price and you get the wallet to name as the job's provider and the budget to
 * fund; fund a job on the kernel against that wallet, tell them its number,
 * and they read the job from the chain, do the work, and submit its hash.
 * The buyer's money waits in the escrow, not with the seller, and comes back
 * if nothing is submitted before the job expires.
 *
 * This reads that card, asks for the price in the seller's own words, and
 * keeps the quote only when it can be funded as it stands: in $U, on the same
 * kernel our escrow uses, on BNB Smart Chain. Every call goes through the
 * same guard as a probe, since the URL is whatever the registrant wrote.
 *
 * Two quote styles are in use. BNB's own agent SDK, which Agent Studio agents
 * are built on, answers with a quote the agent signs (see ./sdk.ts); the
 * provider is whoever signed it, and it must be a wallet the agent's
 * registration names. Older sellers answer with a plain {provider, price}.
 * One request carries the fields both read.
 */

import { getAddress, isAddress, type Address } from "viem";
import { safeFetch } from "@/lib/net/safe-fetch";
import { ESCROW } from "./contracts";
import { checkSdkQuote, isSdkQuote, type SdkQuote } from "./sdk";

export interface EscrowQuote {
  /** The seller's A2A JSON-RPC endpoint: where the price came from and where a funded job is announced. */
  a2a: string;
  /** The wallet to name as the job's provider. */
  provider: Address;
  /** The budget to fund, in $U's smallest unit. */
  price: string;
  /** The seller's name for the service quoted, when it gave one. */
  service: string | null;
  serviceName: string | null;
  /** What the seller needs to do the work, in its own words: name to description. */
  needs: Record<string, string> | null;
  etaSeconds: number | null;
  at: string;
  /** Why a buyer here cannot fund it as quoted, when they cannot. */
  unpayable: string | null;
  /** "sdk": a signed quote in BNB's standard form, anchored in the job's description. "simple": a plain price. Absent on quotes taken before the SDK was read. */
  kind?: "sdk" | "simple";
  /** Whether the seller wants to be told a job is funded; SDK agents watch the chain instead. */
  notify?: boolean;
  /** The negotiation skill id its card lists, when not plain "negotiate". */
  skill?: string;
}

/** What we ask for in a quote's quality terms; an SDK agent refuses a request without any. */
const QUALITY = "Figures read from BNB Smart Chain at delivery, internally consistent, with their sources stated.";
const NOBODY = "0x0000000000000000000000000000000000000000" as Address;

const TIMEOUT = 12_000;

async function rpc(url: string, data: Record<string, unknown>): Promise<unknown> {
  const res = await safeFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: { message: { role: "user", kind: "message", messageId: crypto.randomUUID(), parts: [{ kind: "data", data }] } },
    }),
    timeoutMs: TIMEOUT,
  });
  if (res.status >= 400) throw new Error(`it answered ${res.status}`);
  const j = JSON.parse(res.text) as { result?: unknown; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message ?? "it answered with an error");
  return j.result;
}

/**
 * The first object in an A2A answer that carries the named fields, wherever
 * the seller put it: straight in the result, or in a task's artifacts or a
 * message's parts. Both shapes are in use on this registry.
 */
export function findData(v: unknown, has: (o: Record<string, unknown>) => boolean, depth = 0): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || depth > 6) return null;
  if (!Array.isArray(v) && has(v as Record<string, unknown>)) return v as Record<string, unknown>;
  for (const x of Array.isArray(v) ? v : Object.values(v)) {
    const hit = findData(x, has, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** The seller's A2A endpoint, from its agent card, when the card says it sells through escrow, and whether it wants telling. */
export async function escrowSeller(services: { name?: string; endpoint?: string }[]): Promise<{ url: string; notify: boolean; skill: string } | null> {
  const a2a = services.find((s) => /^a2a$/i.test(s.name ?? "") && /^https:/i.test(s.endpoint ?? ""))?.endpoint;
  if (!a2a) return null;
  const listed = services.find((s) => /agent.?card/i.test(s.name ?? "") && /^https:/i.test(s.endpoint ?? ""))?.endpoint;
  const origin = new URL(a2a).origin;
  // Some cards list the agent card itself as the A2A service.
  const isCard = /\/\.well-known\/agent(-card)?\.json$/i.test(a2a);
  // The agent's own card before its host's: one host can serve several agents, each under its own path.
  const tries = [listed, isCard ? a2a : null, `${a2a.replace(/\/$/, "")}/.well-known/agent-card.json`, `${origin}/.well-known/agent-card.json`].filter(Boolean) as string[];
  let read = false;
  for (const url of tries) {
    const res = await safeFetch(url, { timeoutMs: TIMEOUT, headers: { accept: "application/json" } }).catch(() => null);
    if (!res || res.status !== 200) continue;
    let card: { url?: string; skills?: { id?: string }[]; supportedInterfaces?: { url?: string }[] };
    try {
      card = JSON.parse(res.text);
    } catch {
      continue;
    }
    read = true;
    const skills = new Set((card.skills ?? []).map((s) => s.id));
    // "negotiate-erc8183-job" is the id in BNB's SDK examples; agents on this registry also say "negotiate".
    const skill = skills.has("negotiate-erc8183-job") ? "negotiate-erc8183-job" : skills.has("negotiate") ? "negotiate" : null;
    if (!skill) {
      if (isCard || url === listed) return null;
      continue;
    }
    // The card names its own endpoint; it must be https, and the one the registration lists wins a tie.
    const named = [card.url, ...(card.supportedInterfaces ?? []).map((i) => i.url)].find((u) => typeof u === "string" && /^https:/i.test(u));
    const endpoint = named ?? (isCard ? null : a2a);
    return endpoint ? { url: endpoint, notify: skills.has("notify_funded"), skill } : null;
  }
  // Cards were read and none sells escrowed jobs: a finding. No card could be read: our failure, not a finding.
  if (read) return null;
  throw new Error("no agent card could be read");
}

/**
 * Asks the seller for its price. `signers` are the wallets the agent's
 * registration names (its owner, its agent wallet); a signed quote from any
 * other wallet is refused, so a card pointed at someone else's server cannot
 * sell their work under its own name.
 */
export async function negotiate(a2a: string, ask: string, opts: { signers: string[]; notify?: boolean; skill?: string } = { signers: [] }): Promise<EscrowQuote> {
  return (await negotiateFull(a2a, ask, opts)).quote;
}

/** The quote, and for an SDK seller the signed answer itself, which the job's description must carry. */
export async function negotiateFull(a2a: string, ask: string, opts: { signers: string[]; notify?: boolean; skill?: string }): Promise<{ quote: EscrowQuote; sdk: SdkQuote | null }> {
  const result = await rpc(a2a, { skill: opts.skill ?? "negotiate", task_description: ask, description: ask, terms: { deliverables: ask, quality_standards: QUALITY } });
  const sdk = findData(result, (o) => isSdkQuote(o) && ("negotiation_hash" in o || (o.response as { accepted?: boolean })?.accepted === false)) as SdkQuote | null;
  if (!sdk) return { quote: { ...quoteFrom(result, a2a), kind: "simple", notify: opts.notify ?? true }, sdk: null };
  const checked = await checkSdkQuote(sdk, { chainId: 56, commerce: ESCROW.commerce, token: ESCROW.paymentToken, signers: opts.signers });
  const at = new Date().toISOString();
  if ("refused" in checked) {
    return { quote: { a2a, provider: NOBODY, price: "0", service: null, serviceName: null, needs: null, etaSeconds: null, at, unpayable: checked.refused, kind: "sdk", notify: opts.notify ?? false }, sdk };
  }
  const c = checked.ok;
  return {
    quote: { a2a, provider: c.provider, price: c.price.toString(), service: null, serviceName: null, needs: null, etaSeconds: c.etaSeconds, at, unpayable: c.price > 0n ? null : "it quoted no price", kind: "sdk", notify: opts.notify ?? false },
    sdk,
  };
}

/** A seller's answer to `negotiate`, read as a quote a buyer here can or cannot fund. Pure, for tests. */
export function quoteFrom(result: unknown, a2a: string): EscrowQuote {
  const q = findData(result, (o) => typeof o.provider === "string" && (typeof o.price === "string" || typeof o.price === "number"));
  if (!q) throw new Error("its answer names no provider and price");
  if (q.accepted === false) throw new Error("it declined to quote");
  if (!isAddress(String(q.provider))) throw new Error("the provider it named is not an address");
  const price = BigInt(String(q.price));
  const token = typeof q.payment_token === "string" ? q.payment_token : null;
  const kernel = typeof q.verifying_contract === "string" ? q.verifying_contract : String(q.payment ?? "").match(/0x[0-9a-fA-F]{40}/)?.[0] ?? null;
  const currency = String(q.currency ?? "").replace(/^\$/, "");
  const chain = q.chain_id === undefined ? 56 : Number(q.chain_id);
  const unpayable =
    price <= 0n
      ? "it quoted no price"
      : chain !== 56
        ? `it settles on chain ${chain}, not BNB Smart Chain`
        : token && getAddress(token) !== getAddress(ESCROW.paymentToken)
          ? "it wants a token other than $U"
          : !token && currency && currency.toUpperCase() !== "U"
            ? `it wants ${currency}, and the escrow here pays in $U`
            : kernel && getAddress(kernel) !== getAddress(ESCROW.commerce)
              ? "its escrow is a different contract from the ERC-8183 kernel we use"
              : null;
  const needs = q.needs && typeof q.needs === "object" && !Array.isArray(q.needs) ? Object.fromEntries(Object.entries(q.needs as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : null;
  // A service id is a short token ("health_factor"); some sellers put a phrase there instead, which is its name.
  const id = typeof q.service === "string" && /^[a-z0-9_-]{1,40}$/i.test(q.service) ? q.service : null;
  return {
    a2a,
    provider: getAddress(String(q.provider)),
    price: price.toString(),
    service: id,
    serviceName: typeof q.name === "string" ? q.name.slice(0, 80) : !id && typeof q.service === "string" ? q.service.slice(0, 80) : null,
    needs,
    etaSeconds: Number.isFinite(Number(q.estimated_completion_seconds)) ? Number(q.estimated_completion_seconds) : null,
    at: new Date().toISOString(),
    unpayable,
  };
}

/** Tells the seller a job is funded, with what it needs. Its answer is kept as it gave it. */
export async function notifyFunded(a2a: string, jobId: string, inputs: Record<string, unknown>): Promise<{ text: string; url: string | null }> {
  const result = await rpc(a2a, { skill: "notify_funded", job_id: jobId, ...inputs });
  const text = JSON.stringify(result);
  const url = text.match(/"(?:document_url|deliverable_url|result_url|url)"\s*:\s*"(https:\/\/[^"]{1,300})"/)?.[1] ?? null;
  return { text, url };
}

/** The free answer an agent on BNB's SDK gives over A2A to a plain text task. */
export async function tryFree(a2a: string, task: string): Promise<unknown> {
  const res = await safeFetch(a2a, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", kind: "message", messageId: crypto.randomUUID(), parts: [{ kind: "text", text: task }] } } }),
    timeoutMs: 20_000,
    maxBytes: 256 * 1024,
  });
  const j = JSON.parse(res.text) as { result?: { artifacts?: { parts?: { kind?: string; text?: string; data?: unknown }[] }[]; parts?: { kind?: string; text?: string; data?: unknown }[] }; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message ?? "it answered with an error");
  const parts = [...(j.result?.artifacts?.flatMap((a) => a.parts ?? []) ?? []), ...(j.result?.parts ?? [])];
  const p = parts.find((x) => x.kind === "data" || x.kind === "text");
  if (!p) throw new Error("its answer carried no text or data");
  return p.kind === "data" ? p.data : p.text;
}


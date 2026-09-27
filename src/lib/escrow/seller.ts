/**
 * Our agents as sellers in BNB's standard hire, the other half of sdk.ts.
 *
 * Any buyer built on BNB's agent SDK (Agent Studio agents, Marque, the SDK's
 * own buyer script) finds an agent's A2A endpoint in its ERC-8004
 * registration, asks it `negotiate-erc8183-job` over JSON-RPC `message/send`,
 * and gets back a quote the agent signs. It checks the quote against the
 * agent's registered wallet, opens the job with the quote in its description,
 * funds it, and waits for the agent, which watches the chain, to deliver.
 *
 * This file answers that negotiation exactly as the SDK's NegotiationHandler
 * does (bnbagent-sdk 7a7a431, typescript/src/erc8183/negotiation.ts): the same
 * request and response dicts, the same hashes, the price as an integer string
 * in $U's smallest unit, the quote bound to BNB Smart Chain and the kernel,
 * lasting at most 900 seconds, and signed EIP-191 over the hash's hex text by
 * the agent's own key, which is its on-chain agentWallet. Pure apart from the
 * signing function it is given, so every rule is tested.
 */

import { getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { jobDescription, pyJson, signedContent, type SdkQuote } from "./sdk";

/** Skill ids, as the SDK's examples name them, with the shorter names agents on this registry use. */
export const SKILL = {
  negotiate: ["negotiate-erc8183-job", "negotiate"],
  status: ["erc8183-job-status", "job_status"],
  notify: ["notify_funded"],
} as const;

/** The SDK's reason codes, for a declined quote. */
export const REASON = { AMBIGUOUS_TERMS: "0x04", UNSUPPORTED: "0x06", TASK_TOO_LONG: "0x07" } as const;

/** The SDK's ceiling on a quote's life. */
export const MAX_QUOTE_TTL = 900;

export interface SellerTerms {
  chainId: number;
  commerce: Address;
  token: Address;
  /** In the token's smallest unit. */
  price: bigint;
  etaSeconds: number;
  ttlSeconds?: number;
  now: number;
  provider: Address;
  /** EIP-191 over the negotiation hash as text, by the provider's key. */
  sign: (negotiationHash: Hex) => Promise<Hex>;
}

const hashOf = (v: unknown): Hex => keccak256(stringToHex(pyJson(v)));

/** TermSpecification.toDict: the evaluation fields always, the optional ones only when present. */
function termsDict(t: { deliverables: string; quality_standards: string; success_criteria?: string[] | null; price?: string | null; currency?: string | null; evaluation_required?: boolean; evaluator_type?: string }): Record<string, unknown> {
  const out: Record<string, unknown> = {
    deliverables: t.deliverables,
    quality_standards: t.quality_standards,
    evaluation_required: t.evaluation_required ?? true,
    evaluator_type: t.evaluator_type ?? "uma_oov3",
  };
  if (t.success_criteria) out.success_criteria = t.success_criteria;
  if (t.price !== null && t.price !== undefined) out.price = t.price;
  if (t.currency !== null && t.currency !== undefined) out.currency = t.currency;
  return out;
}

/** A declined quote. The SDK's response hash covers only what an accepted one would carry, so here just {accepted: false}. */
function declined(request: Record<string, unknown>, requestHash: string, code: string, reason: string, details?: Record<string, unknown>): Record<string, unknown> {
  const response: Record<string, unknown> = { accepted: false, reason_code: code, reason };
  if (details) response.details = details;
  return { request, request_hash: requestHash, response, response_hash: requestHash ? hashOf({ accepted: false }) : "" };
}

/**
 * The answer to one negotiation request: a signed quote at our price, or a
 * declined one saying why, both in the SDK's envelope. `provider_address`
 * rides alongside, as the SDK's A2A example adds it, so the buyer knows whom
 * to name as provider before it checks the signature against the registry.
 */
export async function quoteAsSeller(data: Record<string, unknown>, t: SellerTerms): Promise<Record<string, unknown>> {
  const task = data.task_description;
  const raw = data.terms;
  if (typeof task !== "string") return declined(data, "", REASON.AMBIGUOUS_TERMS, "Invalid request format: negotiation request missing required field: task_description");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return declined(data, "", REASON.AMBIGUOUS_TERMS, "Invalid request format: negotiation request field terms must be an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.deliverables !== "string" || typeof r.quality_standards !== "string") {
    return declined(data, "", REASON.AMBIGUOUS_TERMS, "Invalid request format: terms need deliverables and quality_standards as strings");
  }
  if (r.price !== undefined && r.price !== null && (typeof r.price !== "string" || !/^(0|[1-9][0-9]*)$/.test(r.price))) {
    return declined(data, "", REASON.AMBIGUOUS_TERMS, "Invalid request format: price must be a canonical non-negative integer string");
  }
  const criteria = Array.isArray(r.success_criteria) ? r.success_criteria.map(String) : null;
  const request: Record<string, unknown> = {
    task_description: task,
    terms: termsDict({
      deliverables: r.deliverables,
      quality_standards: r.quality_standards,
      success_criteria: criteria,
      price: (r.price as string | undefined) ?? null,
      currency: typeof r.currency === "string" ? r.currency : null,
      evaluation_required: typeof r.evaluation_required === "boolean" ? r.evaluation_required : true,
      evaluator_type: typeof r.evaluator_type === "string" ? r.evaluator_type : "uma_oov3",
    }),
  };
  if (Array.isArray(data.context_urls) && data.context_urls.length) request.context_urls = data.context_urls;
  if (typeof data.request_id === "string" && data.request_id) request.request_id = data.request_id;
  const requestHash = hashOf(request);

  if (!r.quality_standards) return declined(request, requestHash, REASON.AMBIGUOUS_TERMS, "quality_standards is required in terms.");
  if (typeof r.currency === "string" && r.currency && (!/^0x[0-9a-fA-F]{40}$/.test(r.currency) || getAddress(r.currency) !== getAddress(t.token))) {
    return declined(request, requestHash, REASON.UNSUPPORTED, "Requested payment token is unavailable", { supported_assets: [] });
  }

  const ttl = Math.min(t.ttlSeconds ?? MAX_QUOTE_TTL, MAX_QUOTE_TTL);
  const expires = t.now + ttl;
  const responseBase: Record<string, unknown> = {
    accepted: true,
    terms: termsDict({ deliverables: r.deliverables, quality_standards: r.quality_standards, success_criteria: criteria, price: t.price.toString(), currency: getAddress(t.token) }),
    estimated_completion_seconds: t.etaSeconds,
    quote_expires_at: expires,
  };
  const responseHash = hashOf(responseBase);
  const envelope = {
    request,
    request_hash: requestHash,
    response: { ...responseBase, negotiated_at: t.now },
    response_hash: responseHash,
    chain_id: t.chainId,
    verifying_contract: getAddress(t.commerce),
  } as Record<string, unknown>;
  const negotiationHash = hashOf(signedContent(envelope as unknown as SdkQuote));
  envelope.negotiation_hash = negotiationHash;
  envelope.provider_sig = await t.sign(negotiationHash);
  try {
    jobDescription(envelope as unknown as SdkQuote);
  } catch {
    return declined(request, requestHash, REASON.TASK_TOO_LONG, "The task and terms are too long for the 4096-byte on-chain description; shorten them.");
  }
  envelope.provider_address = t.provider;
  return envelope;
}

/**
 * Whom a job is about, read from its task: the first address in it, or for
 * the position agent a position id, else nobody (the buyer's own wallet).
 */
export function subjectOfTask(task: string, slug: string): string | null {
  const address = task.match(/0x[0-9a-fA-F]{40}/)?.[0];
  if (address) return address;
  if (slug === "range-1") {
    const position = task.match(/position\s*(?:id\s*)?#?\s*(\d{3,10})/i)?.[1];
    if (position) return position;
  }
  return null;
}

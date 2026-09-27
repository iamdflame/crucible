/**
 * BNB Chain's standard hire, as its agent SDK defines it.
 *
 * Agents built with BNB Agent Studio, or with `bnb-chain/bnbagent-sdk`
 * directly, price a job over A2A with a quote they sign, and by default refuse
 * any job whose on-chain description does not carry that signed quote. The
 * buyer anchors it with `createJob(description)`; the agent watches the chain
 * for jobs funded to its wallet, checks the quote at the funding block, works,
 * and submits the keccak256 of a canonical DeliverableManifest, whose URL
 * rides in the submission's optParams.
 *
 * This file is the byte-exact half of that: the canonical JSON the SDK hashes
 * (Python's `json.dumps(sort_keys=True, separators=(",", ":"))`, which also
 * escapes every non-ASCII character), the signed description, the signer, and
 * the manifest hash. Proven against a live quote on 27 Sep 2026: our hash
 * equalled the agent's, and the signature recovered its ERC-8004 owner.
 * Everything here is pure.
 */

import { getAddress, isAddress, keccak256, recoverMessageAddress, stringToHex, type Address, type Hex } from "viem";

/** Python's json.dumps(obj, sort_keys=True, separators=(",", ":")), ensure_ascii on. */
export function pyJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(pyJson).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${pyJson(k)}:${pyJson(o[k])}`)
      .join(",")}}`;
  }
  if (typeof v === "string") return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  if (typeof v === "boolean") return v ? "true" : "false";
  return JSON.stringify(v);
}

/** The SDK's claim sanitiser: brackets become parentheses, control characters other than tab and newline go. */
export function sanitize(s: unknown): string {
  const t = typeof s === "string" ? s : String(s ?? "");
  return t
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .split("")
    .filter((ch) => ch.charCodeAt(0) >= 0x20 || ch === "\t" || ch === "\n")
    .join("");
}

/** An SDK negotiation answer, as an agent's `negotiate` returns it. */
export interface SdkQuote {
  request: { task_description?: string; terms?: Record<string, unknown> };
  response: {
    accepted?: boolean;
    terms?: { price?: string | number; currency?: string; deliverables?: string; quality_standards?: string; success_criteria?: string[] };
    estimated_completion_seconds?: number;
    quote_expires_at?: number;
    negotiated_at?: number;
    reason?: string;
  };
  negotiation_hash?: string;
  provider_sig?: string;
  negotiated_at?: number;
  quote_expires_at?: number;
  chain_id?: number;
  verifying_contract?: string;
}

export const isSdkQuote = (v: unknown): v is SdkQuote =>
  Boolean(v && typeof v === "object" && "response" in v && "request" in v && typeof (v as SdkQuote).response === "object");

/** The content the agent signed: the SDK's `_build_description_content`. */
export function signedContent(q: SdkQuote): Record<string, unknown> {
  const t = q.response.terms ?? {};
  if (t.price === undefined || t.price === null) throw new Error("the quote has no price");
  if (!t.currency) throw new Error("the quote has no currency");
  const terms: Record<string, unknown> = { deliverables: sanitize(t.deliverables ?? ""), quality_standards: sanitize(t.quality_standards ?? "") };
  if (t.success_criteria?.length) terms.success_criteria = t.success_criteria.map(sanitize);
  const negotiatedAt = q.negotiated_at ?? q.response.negotiated_at;
  const expires = q.quote_expires_at ?? q.response.quote_expires_at;
  const content: Record<string, unknown> = {
    version: 1,
    negotiated_at: negotiatedAt,
    task: sanitize(q.request.task_description ?? ""),
    terms,
    price: String(BigInt(String(t.price))),
    currency: t.currency,
  };
  if (expires !== undefined && expires !== null) content.quote_expires_at = expires;
  if (q.chain_id !== undefined && q.chain_id !== null) content.chain_id = q.chain_id;
  if (q.verifying_contract) content.verifying_contract = getAddress(q.verifying_contract);
  return content;
}

export const negotiationHash = (q: SdkQuote): Hex => keccak256(stringToHex(pyJson(signedContent(q))));

/** The exact `createJob` description: the signed content plus its hash and signature. At most 4096 bytes, as the SDK enforces. */
export function jobDescription(q: SdkQuote): string {
  const content = signedContent(q);
  if (q.negotiation_hash) content.negotiation_hash = q.negotiation_hash;
  if (q.provider_sig) content.provider_sig = q.provider_sig;
  const s = pyJson(content);
  if (s.length > 4096) throw new Error("the signed description is longer than the 4096 bytes an agent accepts");
  return s;
}

export interface CheckedQuote {
  provider: Address;
  price: bigint;
  currency: Address;
  expiresAt: number | null;
  etaSeconds: number | null;
  task: string;
}

/**
 * A quote a buyer here can fund as it stands: accepted, for BNB Smart Chain and
 * the kernel we use, in the token we pay in, unexpired, its hash our own
 * recomputation, and signed by a wallet the agent's registration names.
 */
export async function checkSdkQuote(
  q: SdkQuote,
  want: { chainId: number; commerce: Address; token: Address; signers: string[]; now?: number },
): Promise<{ ok: CheckedQuote } | { refused: string }> {
  if (q.response.accepted === false) return { refused: `it declined: ${q.response.reason ?? "no reason given"}` };
  if (!q.negotiation_hash || !q.provider_sig) return { refused: "its quote is not signed" };
  let content: Record<string, unknown>;
  try {
    content = signedContent(q);
  } catch (e) {
    return { refused: (e as Error).message };
  }
  const hash = keccak256(stringToHex(pyJson(content)));
  if (hash.toLowerCase() !== q.negotiation_hash.toLowerCase()) return { refused: "its quote's hash does not match its terms" };
  if (q.chain_id !== undefined && Number(q.chain_id) !== want.chainId) return { refused: `it settles on chain ${q.chain_id}, not BNB Smart Chain` };
  if (q.verifying_contract && (!isAddress(q.verifying_contract) || getAddress(q.verifying_contract) !== getAddress(want.commerce))) {
    return { refused: "its escrow is a different contract from the ERC-8183 kernel we use" };
  }
  const currency = String(content.currency);
  if (!isAddress(currency) || getAddress(currency) !== getAddress(want.token)) return { refused: "it wants a token other than $U" };
  const expiresAt = typeof content.quote_expires_at === "number" ? content.quote_expires_at : null;
  if (expiresAt !== null && expiresAt <= (want.now ?? Math.floor(Date.now() / 1000))) return { refused: "its quote has expired" };
  let signer: Address;
  try {
    // The SDK signs the hash's hex text with EIP-191.
    signer = await recoverMessageAddress({ message: q.negotiation_hash, signature: q.provider_sig as Hex });
  } catch {
    return { refused: "its quote's signature cannot be read" };
  }
  if (want.signers.length && !want.signers.some((s) => s.toLowerCase() === signer.toLowerCase())) {
    return { refused: "its quote is signed by a wallet this agent's registration does not name" };
  }
  return {
    ok: {
      provider: signer,
      price: BigInt(String(content.price)),
      currency: getAddress(currency),
      expiresAt,
      etaSeconds: typeof q.response.estimated_completion_seconds === "number" ? q.response.estimated_completion_seconds : null,
      task: String(content.task),
    },
  };
}

/** The deliverable hash an agent commits to: keccak256 of the canonical manifest. */
export const manifestHash = (manifest: unknown): Hex => keccak256(stringToHex(pyJson(manifest)));

export interface Manifest {
  version: number;
  job_id: number;
  chain_id: number;
  contracts: Record<string, string>;
  response: { content: string; content_type?: string };
  metadata?: Record<string, unknown>;
}

export const isManifest = (v: unknown): v is Manifest =>
  Boolean(v && typeof v === "object" && (v as Manifest).version === 1 && typeof (v as Manifest).response?.content === "string");

/** The canonical manifest for a delivery, as the SDK's DeliverableManifest.to_dict writes it. */
export function manifestFor(jobId: bigint, chainId: number, contracts: { commerce: string; router: string; policy: string }, content: string, contentType = "application/json", metadata: Record<string, unknown> = {}): Manifest {
  return { version: 1, job_id: Number(jobId), chain_id: chainId, contracts, response: { content, content_type: contentType }, metadata };
}

/**
 * A job description in BNB's standard form, checked on its own: the signed
 * content hashes to the hash it carries, and the signature recovers a wallet.
 * Returns null when the description is not in that form at all.
 */
export async function readSignedDescription(description: string): Promise<{ signer: Address; price: bigint; currency: string; task: string } | { refused: string } | null> {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(description) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!d || typeof d !== "object" || d.version !== 1 || typeof d.negotiation_hash !== "string" || typeof d.provider_sig !== "string") return null;
  const { negotiation_hash: hash, provider_sig: sig, ...content } = d;
  if (keccak256(stringToHex(pyJson(content))).toLowerCase() !== String(hash).toLowerCase()) return { refused: "its description does not hash to the quote it carries" };
  try {
    const signer = await recoverMessageAddress({ message: String(hash), signature: sig as Hex });
    return { signer, price: BigInt(String(content.price)), currency: String(content.currency), task: String(content.task ?? "") };
  } catch {
    return { refused: "its quote's signature cannot be read" };
  }
}

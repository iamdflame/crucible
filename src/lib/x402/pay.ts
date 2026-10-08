/**
 * Paying another agent over x402, in every dialect met on BNB Smart Chain.
 *
 * Selling was built first and spoke one dialect: x402 v1, an `X-PAYMENT`
 * header, USD1 by EIP-3009. The strangers this marketplace most needs to pay
 * speak others, measured by asking them:
 *
 *   Muster      x402 v2. The terms arrive in a base64 `PAYMENT-REQUIRED`
 *               header, the scheme is named `eip3009`, and payment goes back
 *               in a `PAYMENT-SIGNATURE` header. USD1.
 *   Agripinaa   x402 v2, scheme `exact`, priced in BSC USDT with
 *               `assetTransferMethod: "permit2-exact"` and its own spender.
 *               USDT has no transferWithAuthorization, so the only way to pay
 *               it by signature is Permit2.
 *   338253      x402 v2, scheme `exact`, $U by EIP-3009, over MCP.
 *
 * The README said Muster refused every envelope we sent. No attempt was ever
 * recorded; the client simply did not speak v2. This module is the attempt,
 * and every exchange it makes is kept byte for byte so that whatever the
 * stranger answers, accepted or refused, can be published as it was.
 *
 * Envelopes follow the x402 exact-scheme spec for EVM
 * (coinbase/x402 specs/schemes/exact/scheme_exact_evm.md):
 *   v1  X-PAYMENT         { x402Version: 1, scheme, network, payload }
 *   v2  PAYMENT-SIGNATURE { x402Version: 2, resource, accepted, payload }
 * with `payload` either `{ signature, authorization }` (EIP-3009) or
 * `{ signature, permit2Authorization }` (Permit2 with the proxy's witness,
 * `Witness(address to,uint256 validAfter)`).
 */

import {
  domainSeparator,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { marketClient, walletFor } from "@/lib/chain/market";
import { gasPrice } from "@/lib/chain/marketV2";
import { TRANSFER_TYPES } from "./index";

/** Uniswap's canonical Permit2, the same address on every chain; present on BSC. */
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;
/** The spec's x402ExactPermit2Proxy, deployed on BSC by CREATE2. */
export const X402_PERMIT2_PROXY = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001" as const;

/** Tokens this client will pay in, and nothing else. */
export const PAYABLE_ASSETS: Record<string, { symbol: string; decimals: number }> = {
  "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d": { symbol: "USD1", decimals: 18 },
  "0x55d398326f99059ff775485246999027b3197955": { symbol: "USDT", decimals: 18 },
  "0xce24439f2d9c6a2289f741120fe202248b666666": { symbol: "U", decimals: 18 },
};

/** Tokens verified on chain to implement transferWithAuthorization. */
const EIP3009_TOKENS = new Set([
  "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", // USD1: DOMAIN_SEPARATOR matches "World Liberty Financial USD" v1
  "0xce24439f2d9c6a2289f741120fe202248b666666", // $U: DOMAIN_SEPARATOR and authorizationState answer
]);

const ERC20 = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);
export const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export const PERMIT2_WITNESS_TYPES = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Witness: [
    { name: "to", type: "address" },
    { name: "validAfter", type: "uint256" },
  ],
} as const;

export type TransferMethod = "eip3009" | "permit2";

export interface Requirement {
  x402Version: 1 | 2;
  /** The requirement exactly as the server sent it. A v2 payment echoes it back as `accepted`. */
  raw: Record<string, unknown>;
  scheme: string;
  network: string;
  chainId: number | null;
  asset: Address;
  payTo: Address;
  amount: bigint;
  maxTimeoutSeconds: number;
  method: TransferMethod | null;
  /** EIP-712 domain of an EIP-3009 token, from the requirement's `extra`. */
  domain: { name: string; version: string } | null;
  /** Who Permit2 lets pull the funds: the server's named spender, else the spec's proxy. */
  spender: Address | null;
  resource: { url: string; description?: string; mimeType?: string } | null;
  header: "X-PAYMENT" | "PAYMENT-SIGNATURE";
  /**
   * Which wire the seller parses. "x402" is the coinbase spec. "b402" is the
   * Binance and Altana variant, recognised by a named `spenderAddress` (the
   * seller's own settler): it reads `X-PAYMENT` even at version 2, wants `scheme`
   * and `network` beside `accepted`, and a Permit2 payload carrying `from`,
   * `permit` and `permit2Authorization`. Agripinaa runs Altana's x402-server,
   * patched to require the witness form, and ignores `PAYMENT-SIGNATURE`.
   */
  dialect: "x402" | "b402";
}

export function chainOf(network: string): number | null {
  const caip = /^eip155:(\d+)$/.exec(network);
  if (caip) return Number(caip[1]);
  if (/^(bsc|bnb|binance)/i.test(network)) return 56;
  if (/^base/i.test(network)) return 8453;
  return null;
}

/*
  Base64 without Node's Buffer, so the parser and signer also run in the
  browser (the buy button signs with the visitor's own wallet).
*/
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function fromBase64(b64: string): string {
  const bin = atob(b64.trim());
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function decodeHeader(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  for (const attempt of [() => fromBase64(value), () => value]) {
    try {
      const parsed = JSON.parse(attempt()) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      /* try the next reading */
    }
  }
  return null;
}

function methodOf(scheme: string, extra: Record<string, unknown>, asset: string): TransferMethod | null {
  const named = String(extra.assetTransferMethod ?? extra.transferMethod ?? "").toLowerCase();
  if (named.includes("permit2")) return "permit2";
  if (named === "eip3009") return "eip3009";
  if (scheme.toLowerCase() === "eip3009") return "eip3009";
  // v1 `exact` with no method named means EIP-3009, if the token has it.
  if (scheme.toLowerCase() === "exact" && EIP3009_TOKENS.has(asset.toLowerCase())) return "eip3009";
  return null;
}

/**
 * Every payment requirement a 402 offers, normalised.
 *
 * The terms may be in the body, in a base64 `PAYMENT-REQUIRED` header, or in
 * both; v2 servers put `resource` at the top level as an object, v1 servers
 * put it on each requirement as a string. All of those are read.
 */
export function readRequirements(body: unknown, paymentRequiredHeader?: string | null): Requirement[] {
  const fromHeader = decodeHeader(paymentRequiredHeader);
  const fromBody = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const doc = (Array.isArray(fromBody?.accepts) ? fromBody : fromHeader) ?? fromBody ?? {};
  const other = doc === fromBody ? fromHeader : fromBody;
  const accepts = (Array.isArray(doc.accepts) ? doc.accepts : []) as Record<string, unknown>[];
  const topResource = doc.resource ?? other?.resource;
  // Some v2 servers omit `x402Version`. v2 is still recognisable: `resource`
  // is an object at the top, and requirements carry `amount` rather than v1's
  // `maxAmountRequired`.
  const stated = Number(doc.x402Version ?? other?.x402Version ?? 0);
  const looksV2 =
    (topResource !== null && typeof topResource === "object") ||
    accepts.some((a) => a.amount !== undefined && a.maxAmountRequired === undefined);
  const version = stated >= 2 || (!stated && looksV2) ? 2 : 1;
  const wantsSignatureHeader = /PAYMENT-SIGNATURE/i.test(`${JSON.stringify(doc)} ${JSON.stringify(other ?? {})}`);
  // Only an error that names the header is a demand; a description that
  // mentions it is not.
  const demandsSignatureHeader = /PAYMENT-SIGNATURE/i.test(`${String(doc.error ?? "")} ${String(other?.error ?? "")}`);

  return accepts.flatMap((a): Requirement[] => {
    const amountRaw = String(a.maxAmountRequired ?? a.amount ?? "");
    if (!/^\d+$/.test(amountRaw)) return [];
    const extra = (a.extra ?? {}) as Record<string, unknown>;
    const asset = String(a.asset ?? "") as Address;
    const scheme = String(a.scheme ?? "");
    const network = String(a.network ?? "");
    const method = methodOf(scheme, extra, asset);
    const res = a.resource ?? topResource;
    const resource =
      typeof res === "string"
        ? { url: res, description: a.description as string | undefined, mimeType: a.mimeType as string | undefined }
        : res && typeof res === "object" && typeof (res as { url?: unknown }).url === "string"
          ? (res as Requirement["resource"])
          : null;
    const named = typeof extra.spenderAddress === "string" ? (extra.spenderAddress as Address) : null;
    // The b402 wire is recognised by the seller naming its own settler as the
    // Permit2 spender. `permit2-exact` alone is also the spec's name for a
    // Permit2 payment through the canonical proxy, and a seller that names no
    // spender (Hallmark) expects the spec's envelope.
    const dialect: Requirement["dialect"] = named ? "b402" : "x402";
    const header: Requirement["header"] =
      dialect === "b402"
        ? demandsSignatureHeader ? "PAYMENT-SIGNATURE" : "X-PAYMENT"
        : version === 2 || wantsSignatureHeader ? "PAYMENT-SIGNATURE" : "X-PAYMENT";
    return [
      {
        x402Version: version,
        raw: a,
        scheme,
        network,
        chainId: chainOf(network),
        asset,
        payTo: String(a.payTo ?? "") as Address,
        amount: BigInt(amountRaw),
        maxTimeoutSeconds: Number(a.maxTimeoutSeconds ?? 120) || 120,
        method,
        domain: typeof extra.name === "string" ? { name: extra.name, version: String(extra.version ?? "1") } : null,
        spender: method === "permit2" ? (named ?? X402_PERMIT2_PROXY) : null,
        resource,
        header,
        dialect,
      },
    ];
  });
}

/** Why this client cannot pay a requirement, or null when it can. */
export function whyUnpayable(r: Requirement): string | null {
  if (r.chainId !== 56) return `it settles on ${r.network || "an unnamed network"}, not BNB Smart Chain`;
  const known = PAYABLE_ASSETS[r.asset.toLowerCase()];
  if (!known) return `it prices in ${r.asset}, a token this client does not pay in`;
  if (!/^(exact|eip3009)$/i.test(r.scheme)) return `its "${r.scheme}" scheme is not one this client signs`;
  if (r.method === "eip3009" && !EIP3009_TOKENS.has(r.asset.toLowerCase())) {
    return `it asks for EIP-3009 in ${known.symbol}, which has no transferWithAuthorization`;
  }
  if (r.method === "eip3009" && !r.domain) return "it asks for EIP-3009 without naming the token's EIP-712 domain";
  if (!r.method) {
    return EIP3009_TOKENS.has(r.asset.toLowerCase())
      ? "it names no transfer method this client recognises"
      : `it prices in ${known.symbol} without offering Permit2, and ${known.symbol} has no transferWithAuthorization`;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(r.payTo)) return "it names no address to pay";
  return null;
}

export interface SignedPayment {
  header: Requirement["header"];
  value: string;
  envelope: Record<string, unknown>;
  method: TransferMethod;
  from: Address;
  nonce: string;
}

function randomHex32(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}` as Hex;
}

/**
 * Refuses to sign for a token whose domain is not the one the requirement names.
 *
 * A signature over the wrong domain is useless to the seller and, worse, a
 * requirement that lies about the domain could be steering the signature at a
 * different contract. The chain's own DOMAIN_SEPARATOR is the arbiter.
 */
export async function checkDomain(r: Requirement): Promise<void> {
  if (r.method !== "eip3009" || !r.domain) return;
  const onChain = (await marketClient.readContract({ address: r.asset, abi: ERC20, functionName: "DOMAIN_SEPARATOR" })) as Hex;
  const computed = domainSeparator({ domain: { name: r.domain.name, version: r.domain.version, chainId: 56, verifyingContract: r.asset } });
  if (onChain.toLowerCase() !== computed.toLowerCase()) {
    throw new Error(`the token's DOMAIN_SEPARATOR is not ${r.domain.name} v${r.domain.version}; not signing`);
  }
}

/**
 * The message to sign for one requirement, and the fields the envelope needs.
 *
 * Shared by the server, which signs with a private key, and the browser,
 * which hands the same typed data to the visitor's wallet. Keeping one
 * builder is what stops the two paths drifting: the button used to speak a
 * dialect of its own and would have failed against every v2 seller.
 */
export function paymentTypedData(r: Requirement, from: Address, now = Math.floor(Date.now() / 1000)) {
  // Sixty seconds back: a validAfter of "now" is refused often enough by
  // servers whose clock runs behind the signer's.
  const validAfter = BigInt(now - 60);
  const validBefore = BigInt(now + Math.min(r.maxTimeoutSeconds, 600));
  if (r.method === "eip3009") {
    const nonce = randomHex32();
    return {
      kind: "eip3009" as const,
      domain: { name: r.domain!.name, version: r.domain!.version, chainId: 56, verifyingContract: r.asset },
      types: TRANSFER_TYPES,
      primaryType: "TransferWithAuthorization" as const,
      message: { from, to: r.payTo, value: r.amount, validAfter, validBefore, nonce },
      nonce: nonce as string,
      validAfter,
      validBefore,
    };
  }
  const nonce = BigInt(randomHex32());
  return {
    kind: "permit2" as const,
    domain: { name: "Permit2", chainId: 56, verifyingContract: PERMIT2 },
    types: PERMIT2_WITNESS_TYPES,
    primaryType: "PermitWitnessTransferFrom" as const,
    message: {
      permitted: { token: r.asset, amount: r.amount },
      spender: r.spender!,
      nonce,
      deadline: validBefore,
      witness: { to: r.payTo, validAfter },
    },
    nonce: nonce.toString(),
    validAfter,
    validBefore,
  };
}

/** The header a signed payment travels in, built from the signature and the same fields. */
export function paymentEnvelope(
  r: Requirement,
  from: Address,
  signature: Hex,
  fields: { nonce: string; validAfter: bigint; validBefore: bigint },
): SignedPayment {
  let payload: Record<string, unknown>;
  if (r.method === "eip3009") {
    payload = {
      signature,
      authorization: {
        from,
        to: r.payTo,
        value: r.amount.toString(),
        validAfter: fields.validAfter.toString(),
        validBefore: fields.validBefore.toString(),
        nonce: fields.nonce,
      },
    };
  } else {
    const permit = {
      permitted: { token: r.asset, amount: r.amount.toString() },
      spender: r.spender,
      nonce: fields.nonce,
      deadline: fields.validBefore.toString(),
      witness: { to: r.payTo, validAfter: fields.validAfter.toString() },
    };
    payload =
      r.dialect === "b402"
        ? // Altana's merchant decodes `permit` (and b402 facilitators
          // `permit2Authorization`); both carry the same signed values.
          { signature, from, permit, permit2Authorization: { ...permit, from } }
        : { signature, permit2Authorization: { ...permit, from } };
  }
  const envelope: Record<string, unknown> =
    r.x402Version !== 2
      ? { x402Version: 1, scheme: r.scheme, network: r.network, payload }
      : r.dialect === "b402"
        ? { x402Version: 2, scheme: r.scheme, network: r.network, accepted: r.raw, ...(r.resource ? { resource: r.resource } : {}), payload }
        : { x402Version: 2, ...(r.resource ? { resource: r.resource } : {}), accepted: r.raw, payload };
  return { header: r.header, value: toBase64(JSON.stringify(envelope)), envelope, method: r.method!, from, nonce: fields.nonce };
}

/** Signs a payment for one requirement with a local key. Nothing is sent. */
export async function signPayment(
  account: LocalAccount,
  r: Requirement,
  opts: { now?: number; verifyDomain?: (r: Requirement) => Promise<void> } = {},
): Promise<SignedPayment> {
  const why = whyUnpayable(r);
  if (why) throw new Error(`cannot pay: ${why}`);
  await (opts.verifyDomain ?? checkDomain)(r);
  const td = paymentTypedData(r, account.address, opts.now);
  const signature =
    td.kind === "eip3009"
      ? await account.signTypedData({ domain: td.domain, types: td.types, primaryType: td.primaryType, message: td.message })
      : await account.signTypedData({ domain: td.domain, types: td.types, primaryType: td.primaryType, message: td.message });
  return paymentEnvelope(r, account.address, signature, td);
}

/** What a wallet holds of the token it is about to pay in. */
export async function heldBy(owner: Address, token: Address): Promise<bigint> {
  return (await marketClient.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [owner] })) as bigint;
}

/**
 * Lets Permit2 move exactly the amount about to be paid, when it cannot already.
 *
 * Exact, not unlimited: an allowance to Permit2 is only as safe as every
 * signature ever given over it, and a stranger's spender is a stranger's.
 */
export async function ensurePermit2Allowance(key: Hex, token: Address, amount: bigint): Promise<Hex | null> {
  const owner = privateKeyToAccount(key).address;
  const current = (await marketClient.readContract({ address: token, abi: ERC20, functionName: "allowance", args: [owner, PERMIT2] })) as bigint;
  if (current >= amount) return null;
  const wallet = walletFor(key);
  const hash = await wallet.writeContract({
    address: token,
    abi: ERC20,
    functionName: "approve",
    args: [PERMIT2, amount],
    chain: wallet.chain,
    account: wallet.account!,
    gasPrice: await gasPrice(),
  });
  const receipt = await marketClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`approve to Permit2 reverted: ${hash}`);
  return hash;
}

// ---------------------------------------------------------------------------
// The exchange, kept byte for byte
// ---------------------------------------------------------------------------

export const CAP_BYTES = 256 * 1024;
export const KEPT_HEADERS = /^(content-type|payment-required|payment-response|x-payment-response|x-payment|payment-signature|mcp-session-id|www-authenticate|retry-after)$/i;

export interface Exchange {
  at: string;
  request: { method: string; url: string; headers: Record<string, string>; body?: string };
  response: { status: number; headers: Record<string, string>; body: string; truncated: boolean; ms: number };
}

/** Reads at most 256 KB of a body, and says when it stopped early. */
export async function readCapped(res: Response, cap = CAP_BYTES): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > cap) {
      chunks.push(value.subarray(0, cap - size));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const joined = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.byteLength;
  }
  return { text: new TextDecoder().decode(joined), truncated };
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

export interface Settlement {
  tx: Hex;
  block: number | null;
  source: "payment-response header" | "token Transfer log";
}

// ---------------------------------------------------------------------------
// One paid call, end to end
// ---------------------------------------------------------------------------

export interface PaidCall {
  url: string;
  /** Money moved on chain from the payer to the seller. */
  paid: boolean;
  /** The seller answered the paid request with a success status. */
  delivered: boolean;
  /** Why no payment was made or accepted, in the seller's words where they gave any. */
  refused: string | null;
  requirement: Omit<Requirement, "amount" | "raw"> & { amount: string; raw: Record<string, unknown> } | null;
  payer: Address;
  approveTx: Hex | null;
  settlement: Settlement | null;
  /** The seller's answer to the paid request, parsed when it is JSON. */
  deliverable: unknown;
  exchanges: Exchange[];
  ms: number;
  /** The payer held less than the price, so nothing was signed: a failure of ours, never the seller's. */
  payerShort?: boolean;
}

/*
  The requests to sellers (exchange), the settlement search and the whole paid
  call (payAndCall) live in ./pay-server. They call strangers' URLs through the
  network guard, which uses Node's DNS, and this module is also loaded in the
  browser by the buy button.
*/

/**
 * The signed payment under both names sellers read it by: x402 v2's
 * PAYMENT-SIGNATURE and the older X-PAYMENT. GuardRail, quoting x402 v2,
 * read only X-PAYMENT and answered "payment required" to every payment we
 * sent it (proved on 6 Oct). One authorisation under two names is still one
 * payment: its nonce settles once. Server side only: a browser calling a
 * seller directly must not add a header the seller's CORS does not allow.
 */
export function paymentHeaders(header: string, value: string): Record<string, string> {
  return { "PAYMENT-SIGNATURE": value, "X-PAYMENT": value, [header]: value };
}

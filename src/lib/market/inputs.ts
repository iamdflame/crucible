/**
 * What a paid call needs from you, and what we will pass on.
 *
 * Our own agents declare their inputs in code; a stranger declares them in its
 * 402 challenge, which the preview reader keeps. The drawer asks for exactly
 * those, prefilled where it can (your connected wallet for a wallet), and the
 * relay forwards only declared names with plain values: a visitor cannot use
 * the relay to put arbitrary query strings on somebody else's server.
 */

import { HOUSE_SERVICES } from "@/lib/house/services";
import { houseSlug } from "@/lib/market/performance";
import type { Preview } from "@/lib/x402/quote";

export interface CallInput {
  name: string;
  required: boolean;
  description: string | null;
  /** How the drawer fills it: your wallet, a position id, or free text. */
  kind: "wallet" | "position" | "text";
  /** A value to start from: the task an agent's own card gives as its example, in the form it reads. */
  example?: string;
}

export function kindOf(name: string, description?: string | null): CallInput["kind"] {
  // The name decides first: a wallet whose description mentions the positions it holds is still a wallet.
  if (/wallet|address|owner|account/i.test(name)) return "wallet";
  if (/position|token ?id|nft/i.test(name)) return "position";
  const d = description ?? "";
  if (/position|token ?id|nft/i.test(d)) return "position";
  if (/wallet|address|owner|account/i.test(d)) return "wallet";
  return "text";
}

/** The inputs an agent's paid call takes: ours from code, a stranger's from its own challenge. */
export function inputsFor(tokenId: string, preview: Pick<Preview, "inputs"> | null): CallInput[] {
  const slug = houseSlug(tokenId);
  const declared = slug && HOUSE_SERVICES[slug] ? HOUSE_SERVICES[slug].inputs : (preview?.inputs ?? []);
  return declared
    .filter((i) => /^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(i.name))
    .map((i) => ({ name: i.name, required: Boolean(i.required), description: i.description ?? null, kind: kindOf(i.name, i.description) }));
}

const VALUE = /^[A-Za-z0-9_.:@\-/]{1,100}$/;

/**
 * Keeps only declared names with plain values. Returns the cleaned values, or
 * a sentence saying what is missing or refused.
 */
export function cleanInputs(declared: CallInput[], given: unknown): { ok: true; values: Record<string, string> } | { ok: false; error: string } {
  const raw = given && typeof given === "object" ? (given as Record<string, unknown>) : {};
  const values: Record<string, string> = {};
  for (const d of declared) {
    const v = raw[d.name];
    if (v === undefined || v === null || v === "") {
      if (d.required) return { ok: false, error: `${d.name} is required: ${d.description ?? "the agent needs it to answer"}.` };
      continue;
    }
    if (typeof v !== "string" || !VALUE.test(v.trim())) return { ok: false, error: `${d.name} must be a plain value: letters, digits and . : @ - / only.` };
    values[d.name] = v.trim();
  }
  return { ok: true, values };
}

/** The seller's endpoint with the cleaned inputs on it. */
export function withInputs(endpoint: string, values: Record<string, string>): string {
  const url = new URL(endpoint);
  for (const [k, v] of Object.entries(values)) url.searchParams.set(k, v);
  return url.toString();
}

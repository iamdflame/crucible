/**
 * Creating and opening a passkey wallet in the browser.
 *
 * The passkey is made for mandatemarkets.com and asked the fixed PRF question
 * (derive.ts); its answer becomes the key. This device remembers only which
 * passkey it was and the wallet's public address, so "Unlock" can ask for the
 * right one and say which wallet will open. A passkey without PRF support
 * cannot hold a wallet, and the person is told so plainly rather than given
 * a weaker one.
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { keyFromPrf, PRF_SALT } from "./derive";

const STORE = "mandate:passkey-wallet";
/** The registrable domain, so www and the bare domain share one passkey. */
const RP_ID = "mandatemarkets.com";

export interface Remembered {
  credentialId: string;
  address: Address;
}

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export function remembered(): Remembered | null {
  try {
    const r = JSON.parse(localStorage.getItem(STORE) ?? "null") as Remembered | null;
    return r?.credentialId && r.address ? r : null;
  } catch {
    return null;
  }
}

function remember(r: Remembered): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(r));
  } catch {
    /* Private windows: the wallet still opens from the passkey, it is just not offered first next time. */
  }
}

export function forget(): void {
  try {
    localStorage.removeItem(STORE);
  } catch {
    /* nothing kept */
  }
}

/** Whether this browser can make passkeys for this site at all. PRF support is only known once a passkey answers. */
export function passkeysPossible(): boolean {
  if (typeof window === "undefined" || typeof PublicKeyCredential === "undefined" || !window.isSecureContext) return false;
  const host = window.location.hostname;
  return host === RP_ID || host.endsWith(`.${RP_ID}`);
}

export class NoPrf extends Error {}

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

/** Asks a passkey the PRF question and returns the wallet key it answers with. */
async function ask(credentialId?: string): Promise<{ key: Hex; credentialId: string }> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      rpId: RP_ID,
      userVerification: "required",
      allowCredentials: credentialId ? [{ type: "public-key", id: fromB64url(credentialId) }] : [],
      extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was chosen.");
  const prf = (cred.getClientExtensionResults() as PrfResults).prf?.results?.first;
  if (!prf) throw new NoPrf("This passkey cannot derive a key (no PRF support), so it cannot hold a wallet.");
  return { key: await keyFromPrf(new Uint8Array(prf)), credentialId: b64url(cred.rawId) };
}

/** Makes a passkey for a new wallet, then opens it. */
export async function createWallet(): Promise<{ key: Hex; address: Address }> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { id: RP_ID, name: "MANDATE" },
      user: { id: random(16), name: `MANDATE wallet ${new Date().toISOString().slice(0, 10)}`, displayName: "MANDATE wallet" },
      challenge: random(32),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was made.");
  const ext = (cred.getClientExtensionResults() as PrfResults).prf;
  if (ext && ext.enabled === false) throw new NoPrf("This device's passkeys cannot derive a key (no PRF support), so they cannot hold a wallet.");
  const credentialId = b64url(cred.rawId);
  // Some authenticators answer the PRF question at creation; the rest are asked once now.
  const first = ext?.results?.first;
  const key = first ? await keyFromPrf(new Uint8Array(first)) : (await ask(credentialId)).key;
  const address = privateKeyToAccount(key).address;
  remember({ credentialId, address });
  return { key, address };
}

/** Opens a wallet from its passkey: the one remembered here, or any MANDATE passkey this person picks. */
export async function unlockWallet(): Promise<{ key: Hex; address: Address }> {
  const known = remembered();
  const r = await ask(known?.credentialId);
  const address = privateKeyToAccount(r.key).address;
  remember({ credentialId: r.credentialId, address });
  return { key: r.key, address };
}

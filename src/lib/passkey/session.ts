/**
 * The passkey wallet open in this tab, and the approvals it is waiting on.
 *
 * Opening installs it the way browser wallets introduce themselves (EIP-6963,
 * which lib/chain/wallet adopts as window.ethereum when no other wallet is
 * present), so every flow on the site reaches it unchanged. Requests to
 * approve wait in a queue that the approval dialog (PasskeyHost) answers;
 * with no dialog on the page, the browser's own confirm box answers instead,
 * so nothing is ever signed without a person saying yes.
 */

import type { Hex } from "viem";
import type { Described } from "./describe";
import { passkeyProvider, type PasskeyProvider } from "./provider";

export interface Pending {
  id: number;
  d: Described;
  kind: "transaction" | "signature";
  resolve: (ok: boolean) => void;
}

let open: PasskeyProvider | null = null;
let queue: Pending[] = [];
let seq = 0;
const watchers = new Set<() => void>();
const changed = () => watchers.forEach((f) => f());

export const OPENED = "mandate:passkey-opened";

export function watch(f: () => void): () => void {
  watchers.add(f);
  return () => watchers.delete(f);
}

export const pending = (): Pending | null => queue[0] ?? null;
export const current = (): PasskeyProvider | null => open;

export function answer(id: number, ok: boolean): void {
  const p = queue.find((q) => q.id === id);
  queue = queue.filter((q) => q.id !== id);
  p?.resolve(ok);
  changed();
}

function confirm(d: Described, kind: "transaction" | "signature"): Promise<boolean> {
  if (!watchers.size) {
    return Promise.resolve(window.confirm(`${d.title}\n\n${d.lines.join("\n")}${d.unknown ? "\n\nThis site did not recognise it: approve only if you know why it is asked." : ""}`));
  }
  return new Promise((resolve) => {
    queue.push({ id: ++seq, d, kind, resolve });
    changed();
  });
}

/** Opens the wallet in this tab and makes it the page's wallet when the browser has no other. */
export function install(key: Hex): PasskeyProvider {
  open?.lock();
  const provider = passkeyProvider(key, confirm);
  open = provider;
  const w = window as unknown as { ethereum?: unknown };
  const mine = (w.ethereum as { isMandatePasskey?: boolean } | undefined)?.isMandatePasskey;
  if (!w.ethereum || mine) {
    try {
      w.ethereum = provider;
    } catch {
      /* A wallet extension fixed window.ethereum; the passkey wallet is not needed there. */
    }
  }
  window.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", {
      detail: { info: { uuid: crypto.randomUUID(), name: "MANDATE passkey wallet", icon: "/icon.svg", rdns: "com.mandatemarkets.passkey" }, provider },
    }),
  );
  window.dispatchEvent(new Event(OPENED));
  changed();
  return provider;
}

/** Locks the wallet: the key is forgotten, and every approval still waiting is refused. */
export function lock(): void {
  open?.lock();
  open = null;
  for (const q of queue) q.resolve(false);
  queue = [];
  changed();
}

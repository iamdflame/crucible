"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Copy, Fingerprint, Lock } from "lucide-react";
import type { Hex } from "viem";
import { useWallet } from "@/lib/chain/wallet";
import { createWallet, NoPrf, passkeysPossible, remembered, unlockWallet } from "@/lib/passkey/webauthn";
import { answer, current, install, lock, pending, watch } from "@/lib/passkey/session";

/** Re-renders whenever the passkey wallet opens, locks, or has an approval waiting. */
function usePasskey() {
  const open = useSyncExternalStore(watch, () => current(), () => null);
  const wait = useSyncExternalStore(watch, () => pending(), () => null);
  return { open, wait };
}

function words(e: unknown): string {
  if (e instanceof NoPrf) return "This browser's passkeys cannot hold a wallet. Use a wallet app instead, or try Chrome or Safari on a recent phone.";
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "AbortError") return "Cancelled. Press again when you are ready.";
  if (name === "InvalidStateError") return "This device already has a MANDATE passkey: use Unlock instead.";
  return `It did not work: ${String((e as Error)?.message ?? e).slice(0, 140)}`;
}

/**
 * Create a wallet with a passkey, or unlock the one this device made before.
 * For a browser with no wallet at all: a phone's Safari or Chrome, or a
 * computer without an extension. The key is derived from the passkey on this
 * device, never stored and never sent to MANDATE.
 */
export function PasskeyStart({ quiet = false }: { quiet?: boolean }) {
  const { connect } = useWallet();
  const { open } = usePasskey();
  const [possible, setPossible] = useState(false);
  const [known, setKnown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPossible(passkeysPossible());
    setKnown(remembered()?.address ?? null);
  }, []);

  if (!possible || open) return null;

  const go = async (make: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const w = make ? await createWallet() : await unlockWallet();
      install(w.key);
      await connect().catch(() => undefined);
      setKnown(w.address);
    } catch (e) {
      setError(words(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={quiet ? "x-passkey x-passkey--quiet" : "x-passkey"}>
      {known ? (
        <button type="button" className="x-btn x-btn--block" onClick={() => void go(false)} disabled={busy}>
          <Fingerprint size={16} aria-hidden="true" /> {busy ? "Waiting for your passkey…" : `Unlock your passkey wallet ${known.slice(0, 6)}…${known.slice(-4)}`}
        </button>
      ) : (
        <button type="button" className="x-btn x-btn--block" onClick={() => void go(true)} disabled={busy}>
          <Fingerprint size={16} aria-hidden="true" /> {busy ? "Waiting for your passkey…" : "Create a wallet with a passkey"}
        </button>
      )}
      <p className="x-passkey__note">
        Face ID, a fingerprint or your device PIN. The key is made from your passkey on this device; MANDATE never sees it, and the same passkey opens the same
        wallet on your other devices.
        {known ? (
          <>
            {" "}
            <button type="button" className="x-link x-passkey__alt" onClick={() => void go(true)} disabled={busy}>
              Make a new one instead
            </button>
          </>
        ) : null}
      </p>
      {error ? (
        <p className="x-escrow__err" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** For an open passkey wallet: how to fund it, its key to export, and Lock. */
export function PasskeyPanel({ address, chainId }: { address: string; chainId: number | null }) {
  const { open } = usePasskey();
  const { disconnect } = useWallet();
  const [shown, setShown] = useState<Hex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  if (!open) return null;

  const copy = async (what: string, label: string) => {
    try {
      await navigator.clipboard.writeText(what);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* on screen to select */
    }
  };
  const reveal = async () => {
    setError(null);
    try {
      // Asked of the passkey again: showing the key needs the same yes as opening the wallet.
      setShown((await unlockWallet()).key);
    } catch (e) {
      setError(words(e));
    }
  };
  const ask = `I would like to get tBNB and U on BNB Smart Chain Testnet to my wallet ${address}`;

  return (
    <div className="x-passkey-panel">
      <p className="m-label">Passkey wallet</p>
      {chainId === 97 ? (
        <p className="m-small">
          Free test tokens: open{" "}
          <a className="x-link" href="https://t.me/bnbchain_official_bot" target="_blank" rel="noreferrer">
            @bnbchain_official_bot
          </a>{" "}
          and send <span className="x-mono">{ask}</span>{" "}
          <button type="button" className="x-link" onClick={() => void copy(ask, "ask")}>
            {copied === "ask" ? "Copied" : "Copy"}
          </button>
        </p>
      ) : (
        <p className="m-small">
          To fund it, send a little BNB on BNB Smart Chain to the address above, from an exchange (on Binance: Withdraw, network BSC) or another wallet. The hire
          packs swap it for the $U they need.
        </p>
      )}
      {shown ? (
        <div className="x-passkey-panel__key">
          <p className="x-escrow__err">Anyone with this key controls the wallet. Paste it only into a wallet app you trust, never into a website or a message.</p>
          <span className="x-mono">{shown}</span>
          <div className="m-wallet__row">
            <button type="button" className="m-btn m-btn--sm m-btn--quiet" onClick={() => void copy(shown, "key")}>
              <Copy size={13} aria-hidden="true" /> {copied === "key" ? "Copied" : "Copy key"}
            </button>
            <button type="button" className="m-btn m-btn--sm m-btn--quiet" onClick={() => setShown(null)}>
              Hide
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="m-btn m-btn--sm m-btn--quiet m-btn--block" onClick={() => void reveal()}>
          Export the key to a wallet app
        </button>
      )}
      <button
        type="button"
        className="m-btn m-btn--sm m-btn--block"
        onClick={() => {
          lock();
          void disconnect();
        }}
      >
        <Lock size={13} aria-hidden="true" /> Lock the passkey wallet
      </button>
      {error ? <p className="x-escrow__err">{error}</p> : null}
    </div>
  );
}

/**
 * The approval screen a wallet app would show: what is being signed, in
 * words, with Approve and Reject. Mounted once per page.
 */
export function PasskeyHost() {
  const { wait } = usePasskey();
  useEffect(() => {
    if (!wait) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && answer(wait.id, false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wait]);
  if (!wait) return null;
  return (
    <div className="x-approve" role="dialog" aria-modal="true" aria-labelledby="x-approve-h">
      <div className="x-approve__card">
        <p className="m-label">Passkey wallet · {wait.kind === "transaction" ? "approve a transaction" : "approve a signature"}</p>
        <h2 id="x-approve-h" className="x-approve__h">
          {wait.d.title}
        </h2>
        <ul className="x-approve__lines">
          {wait.d.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
        {wait.d.unknown ? <p className="x-escrow__err">MANDATE did not recognise this. Approve it only if you know why it is being asked.</p> : null}
        <div className="x-approve__acts">
          <button type="button" className="x-btn" onClick={() => answer(wait.id, false)}>
            Reject
          </button>
          <button type="button" className="x-btn x-btn--primary" onClick={() => answer(wait.id, true)} autoFocus>
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}

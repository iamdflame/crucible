"use client";

import { useEffect, useState } from "react";
import { Bell, Send } from "lucide-react";
import { useWallet } from "@/lib/chain/wallet";

/**
 * Signing up for a free liquidation alert: a wallet, the health factor that
 * should wake you, and a Telegram link whose Start button finishes it.
 *
 * Nothing is signed. The wallet's Venus position is public; the form shows it
 * as it stands now, so a person can see what they are asking us to watch.
 */
const LEVELS = [1.5, 1.3, 1.2, 1.1] as const;
const isAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());

type Now = { words: string; state: string } | null;

export default function AlertSignup() {
  const { address } = useWallet();
  const [wallet, setWallet] = useState("");
  const [level, setLevel] = useState<number>(1.3);
  const [on, setOn] = useState<{ on: boolean; bot: string | null } | null>(null);
  const [now, setNow] = useState<Now>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/alerts", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setOn({ on: Boolean(j?.data?.on), bot: j?.data?.bot ?? null }))
      .catch(() => setOn({ on: false, bot: null }));
  }, []);

  // The connected wallet is the usual answer to "which wallet?".
  useEffect(() => {
    if (address && !wallet) setWallet(address);
  }, [address, wallet]);

  // What that wallet's loan looks like right now.
  useEffect(() => {
    setNow(null);
    setLink(null);
    if (!isAddress(wallet)) return;
    let gone = false;
    const t = setTimeout(() => {
      fetch(`/api/alerts?wallet=${wallet.trim()}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => !gone && setNow(j?.data ? { words: j.data.words, state: j.data.state } : null))
        .catch(() => undefined);
    }, 300);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [wallet]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/alerts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: wallet.trim(), threshold: level }) });
      const j = await r.json();
      if (!r.ok || !j?.data?.link) throw new Error(j?.error ?? "The alert could not be set up just now.");
      setLink(j.data.link);
      window.open(j.data.link, "_blank", "noopener");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (on && !on.on) {
    return (
      <div className="x-alerts__card">
        <p className="x-muted">Alerts are being switched on. Check back shortly.</p>
      </div>
    );
  }

  return (
    <div className="x-alerts__card">
      <label className="x-field">
        <span className="x-field__l">Wallet to watch</span>
        <input
          className="x-input x-mono"
          value={wallet}
          onChange={(e) => setWallet(e.target.value)}
          placeholder="0x…"
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
        />
      </label>
      {isAddress(wallet) ? (
        <p className={`x-alerts__now${now && ["low", "danger", "liquidatable"].includes(now.state) ? " x-alerts__now--warn" : ""}`}>
          {now ? `Right now: ${now.words}.` : "Reading its Venus position…"}
        </p>
      ) : null}

      <fieldset className="x-alerts__levels">
        <legend className="x-field__l">Wake me when its health factor falls below</legend>
        <div className="x-alerts__chips">
          {LEVELS.map((l) => (
            <button key={l} type="button" className={`x-chip${level === l ? " x-chip--on" : ""}`} aria-pressed={level === l} onClick={() => setLevel(l)}>
              {l.toFixed(1)}
            </button>
          ))}
        </div>
        <p className="x-alerts__hint">Below 1.0 Venus can liquidate the loan. 1.3 leaves time to act; 1.1 is a last call.</p>
      </fieldset>

      <button type="button" className="x-btn x-btn--primary x-btn--block x-btn--lg" onClick={() => void start()} disabled={!isAddress(wallet) || busy || !on}>
        <Send size={16} aria-hidden="true" /> {busy ? "Making your link…" : "Get alerts on Telegram"}
      </button>
      {link ? (
        <p className="x-alerts__done" role="status">
          <Bell size={14} aria-hidden="true" /> Telegram should have opened. Press <strong>Start</strong> there to finish.{" "}
          <a className="x-link" href={link} target="_blank" rel="noreferrer">
            Open it again
          </a>
        </p>
      ) : null}
      {error ? <p className="x-escrow__err">{error}</p> : null}
      {on?.bot ? (
        <p className="x-alerts__hint">
          Already in Telegram? Send <span className="x-mono">/watch 0x… 1.3</span> to{" "}
          <a className="x-link" href={`https://t.me/${on.bot}`} target="_blank" rel="noreferrer">
            @{on.bot}
          </a>
          .
        </p>
      ) : null}
    </div>
  );
}

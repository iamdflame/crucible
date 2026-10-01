"use client";

import { useEffect, useState } from "react";
import { Check, Clock, HelpCircle, X } from "lucide-react";

interface Q {
  tokenId: string;
  checks: { id: string; label: string; state: "pass" | "pending" | "fail" | "unknown"; detail: string }[];
  actions: { tx: string; kind: string; fits: boolean; at: string }[];
  at: string;
  reading?: boolean;
}

const ICON = { pass: Check, pending: Clock, fail: X, unknown: HelpCircle } as const;
const WORD = { pass: "Met", pending: "Not yet", fail: "Not met", unknown: "Not read" } as const;

/**
 * An agent against BNB Chain's Set and Earn build checks, read now. The first
 * four arrive at once; its onchain actions take half a minute to read from an
 * archive, so the panel asks again until they are in.
 */
export default function QualifyPanel({ tokenId }: { tokenId: string }) {
  const [q, setQ] = useState<Q | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    let tries = 0;
    const read = async () => {
      try {
        const r = await fetch(`/api/v1/qualify/${tokenId}`, { cache: "no-store" });
        const j = await r.json();
        if (stop) return;
        if (!r.ok) {
          setError(j?.error ?? "The checks could not be read just now.");
          return;
        }
        setQ(j.data);
        if (j.data?.reading && ++tries < 20) setTimeout(read, 8_000);
      } catch {
        if (!stop) setError("The checks could not be read just now.");
      }
    };
    void read();
    return () => {
      stop = true;
    };
  }, [tokenId]);

  const met = q?.checks.filter((c) => c.state === "pass").length ?? 0;

  return (
    <div className="x-qualify">
      <div className="x-qualify__head">
        <h2 className="x-proof-h">Set and Earn checks</h2>
        {q ? (
          <p className="x-qualify__score">
            <span className="x-mono">{met}</span> of 6 met{q.reading ? ", reading its onchain actions…" : ""}
          </p>
        ) : null}
      </div>
      <p className="x-ad-src">
        BNB Chain&apos;s six checks for an agent built for the campaign, read from the chain and its endpoint now. BNB Chain decides after the campaign closes; this
        shows what is still missing while there is time to fix it.
      </p>
      {error ? <p className="x-rerun__err">{error}</p> : null}
      {!q && !error ? <p className="x-ad-src">Reading…</p> : null}
      {q ? (
        <>
          <ol className="x-qualify__list">
            {q.checks.map((c) => {
              const Icon = ICON[c.state];
              return (
                <li key={c.id} className={`x-qualify__row x-qualify__row--${c.state}`}>
                  <span className="x-qualify__icon" aria-hidden="true">
                    <Icon size={14} strokeWidth={3} />
                  </span>
                  <div>
                    <p className="x-qualify__label">
                      {c.label} <span className="x-qualify__state">{WORD[c.state]}</span>
                    </p>
                    <p className="x-qualify__detail">{c.detail}</p>
                  </div>
                </li>
              );
            })}
          </ol>
          {q.actions.length ? (
            <details className="x-hire__adv">
              <summary>Its most recent transactions</summary>
              <ul className="x-qualify__acts">
                {q.actions.map((a) => (
                  <li key={a.tx}>
                    <span className="x-mono">{a.at.slice(0, 10)}</span> {a.kind}
                    {a.fits ? " · fits its job" : ""} ·{" "}
                    <a className="x-link x-mono" href={`https://bscscan.com/tx/${a.tx}`} target="_blank" rel="noreferrer">
                      {a.tx.slice(0, 10)}…
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <p className="x-ad-src">
            Read {new Date(q.at).toUTCString().slice(5, 22)} UTC, kept for half an hour. The same answer at <span className="x-mono">/api/v1/qualify/{q.tokenId}</span>.
          </p>
        </>
      ) : null}
    </div>
  );
}

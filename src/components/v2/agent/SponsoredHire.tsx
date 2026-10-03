"use client";

import { useState } from "react";
import { track } from "@/lib/ops/funnel-client";

/**
 * Hiring a stranger with no wallet, because Mandate pays for it.
 *
 * This is the one control on the site that spends our money instead of the
 * visitor's. It exists because the alternative for somebody without BNB is a
 * description of a hire, and a description is what every other marketplace
 * offers. Press it and a payment settles on BNB Smart Chain, the agent answers,
 * and both the transaction and the answer land on this page.
 *
 * It says who pays, how many are left today, and what the answer can be
 * checked against. When the agent takes the money and fails, that is shown
 * too, in the agent's own words.
 */

interface Result {
  ok?: boolean;
  paid?: boolean;
  delivered?: boolean;
  reason?: string | null;
  paidBy?: string;
  price?: string | null;
  settlement?: { tx: string; url: string; found: string } | null;
  deliverable?: unknown;
  ms?: number;
  left?: number;
}

export default function SponsoredHire({
  tokenId,
  name,
  price,
  asks,
  checkWith,
  takesSubject,
}: {
  tokenId: string;
  name: string;
  price: string | null;
  asks: string;
  checkWith: string;
  takesSubject: boolean;
}) {
  const [phase, setPhase] = useState<"idle" | "working" | "done">("idle");
  const [subject, setSubject] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  const hire = async () => {
    setPhase("working");
    try {
      track("try", tokenId);
      const res = await fetch("/api/judge/hire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tokenId, subject: subject.trim() || undefined }),
      });
      setResult((await res.json()) as Result);
    } catch (e) {
      setResult({ ok: false, reason: e instanceof Error ? e.message : "The request did not complete." });
    }
    setPhase("done");
  };

  const answer = result?.deliverable ? JSON.stringify(result.deliverable, null, 2) : null;

  return (
    <div className="x-pay" id="sponsored">
      <p className="x-pay__what">
        {name} sells {asks} for {price ?? "its own price"}. Mandate pays it from its own wallet: no wallet, no BNB, no account. The payment settles on chain
        and you get the transaction and the answer.
      </p>

      {takesSubject ? (
        <label className="x-field">
          <span className="x-field__l">Ask about a wallet (optional)</span>
          <input
            className="x-input"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="0x… defaults to our demo address"
            spellCheck={false}
          />
        </label>
      ) : null}

      <button className="x-btn x-btn--primary x-btn--block x-btn--lg" type="button" disabled={phase === "working"} onClick={() => void hire()}>
        {phase === "working" ? "Paying the agent…" : `Hire ${name.length > 20 ? "it" : name} for free`}
      </button>

      {phase === "done" && result ? (
        <>
          {result.delivered ? (
            <p className="x-pay__ok">
              Paid {result.price} and answered in {((result.ms ?? 0) / 1000).toFixed(1)} s.{" "}
              {result.settlement ? (
                <a className="x-link x-mono" href={result.settlement.url} target="_blank" rel="noreferrer">
                  {result.settlement.tx.slice(0, 10)}…{result.settlement.tx.slice(-8)}
                </a>
              ) : null}
            </p>
          ) : (
            <p className="x-pay__err" role="alert">
              {result.paid
                ? "It took the payment and answered with an error. That is recorded, and it will not be offered as hireable until it delivers again."
                : "It would not take the payment."}{" "}
              {result.reason ? <span className="x-pay__note">{String(result.reason).slice(0, 300)}</span> : null}
            </p>
          )}
          {answer ? <pre className="x-pre">{answer.slice(0, 1800)}</pre> : null}
          <p className="x-pay__note">
            Paid by {result.paidBy ? `${result.paidBy.slice(0, 8)}…${result.paidBy.slice(-6)}` : "Mandate"}, which is ours and is not the agent. Check the answer
            against {checkWith}.{typeof result.left === "number" ? ` ${result.left} sponsored calls left today.` : ""}
          </p>
        </>
      ) : (
        <p className="x-pay__note">Limited to a few a day so the wallet lasts. Check its answer against {checkWith}.</p>
      )}
    </div>
  );
}

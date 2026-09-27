"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { formatUnits } from "viem";
import { ArrowLeft, Check, Gift, X } from "lucide-react";
import Drawer from "./Drawer";
import TxStatus, { txStepOf, type TxStep } from "./TxStatus";
import BuyOneCall, { type PhaseReport } from "@/components/v2/agent/BuyOneCall";
import SponsoredHire from "@/components/v2/agent/SponsoredHire";
import RateAgent from "./RateAgent";
import EscrowHire, { type EscrowOffer } from "./EscrowHire";
import NeedHelp from "./NeedHelp";
import { useWallet } from "@/lib/chain/wallet";
import type { CallInput } from "@/lib/market/inputs";

/**
 * Putting an agent to work, in five steps: review, permissions, confirm,
 * processing, success.
 *
 * This wraps the payment engine rather than re-implementing it. BuyOneCall
 * still reads the seller's live price, builds the envelope with the same code
 * the server pays strangers with, and refuses to sign anything whose price is
 * not on screen. What the drawer adds is the part a buyer was missing: what
 * exactly they are authorising, what the agent cannot do with it, and a clear
 * account of where their money is while it moves.
 *
 * It opens when the address ends in #call, so every "Use now" link on the
 * site (which points at /agents/{id}#call) lands here, and #sponsored opens
 * straight onto the free option.
 */

export interface HireOffer {
  tokenId: string;
  name: string;
  art: ReactNode;
  categoryLabel: string | null;
  /** The job's slug, carried into a rating as its first tag. */
  category: string | null;
  price: { value: string | null; unit: string | null; exact: string | null; none: string | null };
  latencyMs: number | null;
  /** What one call returns, or the job it does, in its own words where it gave any. */
  task: string;
  /** A paid call we can settle, when there is one. */
  x402: null | {
    path: string;
    method: "GET" | "POST";
    body?: unknown;
    payTo: string;
    network: string;
    scheme: string;
    asset: string;
    assetName: string | null;
    header: string;
    version: number;
    transferMethod: string | null;
  };
  /** What the paid call needs from the buyer, as the agent declares it. */
  inputs: CallInput[];
  /** Every input may be left blank: the agent is sent a sensible default for each. */
  blanksOk?: boolean;
  /** A job in the escrow market, when it bids in it. */
  job: null | { href: string; can: string[]; caps: string[]; cannot: string[] };
  /** An ERC-8183 escrowed job: our own agents, and outside sellers that price one over A2A. */
  escrow: EscrowOffer | null;
  /** Mandate pays for a call to this agent, a few a day. */
  sponsored: null | { asks: string; checkWith: string; takesSubject: boolean; price: string | null };
  /** Why there is nothing to hire, when there is not. */
  refuse: string | null;
  alternatives: string;
}

type Step = "review" | "permissions" | "confirm" | "processing" | "success" | "free";
const FLOW: { id: Step; label: string }[] = [
  { id: "review", label: "Review" },
  { id: "permissions", label: "Permissions" },
  { id: "confirm", label: "Confirm" },
  { id: "processing", label: "Processing" },
  { id: "success", label: "Success" },
];

const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const network = (n: string) => (n === "eip155:56" || /bsc|bnb/i.test(n) ? "BNB Smart Chain" : n);

function Can({ items, no = false }: { items: string[]; no?: boolean }) {
  return (
    <ul className={`x-can${no ? " x-can--no" : ""}`}>
      {items.map((t) => (
        <li key={t}>
          {no ? <X size={14} strokeWidth={2.5} aria-hidden="true" /> : <Check size={14} strokeWidth={2.5} aria-hidden="true" />}
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * `openOn` is the address hash that opens this drawer. An agent's own page
 * leaves it unset and opens on #call; a page offering several agents gives
 * each drawer its own, so one link opens one drawer.
 */
export default function HireDrawer({ offer, openOn, onDone }: { offer: HireOffer; openOn?: string; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("review");
  const [tx, setTx] = useState<{ step: TxStep; failed: boolean } | null>(null);
  const [result, setResult] = useState<{ tx: string | null; body: unknown; price?: string } | null>(null);
  const [lastPrice, setLastPrice] = useState<string | undefined>(undefined);
  const { address } = useWallet();
  const [values, setValues] = useState<Record<string, string>>({});

  // A wallet input starts as the connected wallet: the question is usually about your own account.
  useEffect(() => {
    if (!address) return;
    setValues((v) => {
      const next = { ...v };
      for (const i of offer.inputs) if (i.kind === "wallet" && !next[i.name]) next[i.name] = address;
      return next;
    });
  }, [address, offer.inputs]);

  // Required inputs, or for an agent that takes one of several (a wallet or a position), at least one.
  const needed = offer.inputs.filter((i) => i.required);
  const filled = (i: CallInput) => Boolean(values[i.name]?.trim());
  // A wallet or position that cannot be one is caught here, before anybody pays for an answer about it.
  const wrong = (i: CallInput): string | null => {
    const v = values[i.name]?.trim();
    if (!v) return null;
    if (i.kind === "wallet" && !/^0x[0-9a-fA-F]{40}$/.test(v)) return "A wallet address is 0x followed by 40 letters and digits.";
    if (i.kind === "position" && !/^\d{1,12}$/.test(v)) return "A position id is a number, e.g. 7546488.";
    return null;
  };
  const inputsReady =
    !offer.inputs.some(wrong) && (offer.inputs.length === 0 || (needed.length ? needed.every(filled) : offer.blanksOk || offer.inputs.some(filled)));
  // Stable between renders, so the payment engine does not re-ask the seller for a price each time.
  const sent = useMemo(
    () => Object.fromEntries(Object.entries(values).filter(([k, v]) => v.trim() && offer.inputs.some((i) => i.name === k))),
    [values, offer.inputs],
  );

  // The address decides: #call opens the flow, #sponsored opens the free option.
  useEffect(() => {
    const read = () => {
      const h = window.location.hash;
      if (openOn ? h === openOn : h === "#call" || h === "#hire") {
        setOpen(true);
        setStep((s) => (s === "free" ? "review" : s));
      } else if (!openOn && h === "#sponsored" && offer.sponsored) {
        setOpen(true);
        setStep("free");
      }
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [offer.sponsored, openOn]);

  const close = useCallback(() => {
    setOpen(false);
    onDone?.();
    if (/^#(call|hire|sponsored)$/.test(window.location.hash) || (openOn && window.location.hash === openOn)) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    // A finished or failed payment starts fresh next time; one in flight keeps its place.
    setStep((s) => (s === "success" || s === "free" ? "review" : s));
    if (step === "success") {
      setResult(null);
      setTx(null);
    }
  }, [step, onDone, openOn]);

  const onPhase = useCallback((p: PhaseReport) => {
    if (p.price) setLastPrice(p.price);
    const t = txStepOf(p.at);
    if (p.at === "failed") {
      setTx((cur) => (cur ? { ...cur, failed: true } : { step: "preparing", failed: true }));
      return;
    }
    if (!t) return;
    setTx({ step: t, failed: false });
    if (p.at === "approving" || p.at === "signing" || p.at === "settling") setStep("processing");
    if (p.at === "done") {
      setResult({ tx: p.tx ?? null, body: p.body });
      setStep("success");
    }
  }, []);

  const price = offer.price.value ? `${offer.price.value} ${offer.price.unit ?? ""}`.trim() : offer.price.none ?? "No price published";
  /*
    How this hire is paid. An escrowed job leads wherever the agent takes one:
    the buyer's money waits in the contract until the work arrives, and the
    chain records the hire against the agent. A buyer offered both chooses.
  */
  const [mode, setMode] = useState<"escrow" | "call">(offer.escrow ? "escrow" : "call");
  const viaEscrow = Boolean(offer.escrow) && (mode === "escrow" || !offer.x402);
  const both = Boolean(offer.escrow && offer.x402);
  const escrowPrice = offer.escrow ? `${formatUnits(BigInt(offer.escrow.budget), 18)} $U` : null;
  // An agent on BNB's SDK often answers a plain message free: the buyer can see its answer before paying.
  const [trying, setTrying] = useState(false);
  const [tried, setTried] = useState<{ free: boolean; answer?: unknown; reason?: string; error?: string } | null>(null);
  const tryIt = async () => {
    setTrying(true);
    setTried(null);
    try {
      const r = await fetch("/api/try", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenId: offer.tokenId, inputs: sent }) });
      const j = await r.json();
      setTried(r.ok ? j.data : { free: false, error: j.error ?? "It could not be asked just now." });
    } catch {
      setTried({ free: false, error: "It could not be asked just now." });
    } finally {
      setTrying(false);
    }
  };
  const exact = offer.price.exact ?? offer.price.value ?? "the quoted price";
  const flowAt = FLOW.findIndex((f) => f.id === step);

  const title = step === "success" ? "Agent hired" : step === "free" ? "Try it free" : offer.refuse ? "Not available to hire" : `Use ${offer.name}`;

  let body: ReactNode;
  let foot: ReactNode = null;

  if (offer.refuse) {
    body = (
      <div className="x-hire">
        <p className="x-hire__lede">{offer.refuse}</p>
        <Link href={offer.alternatives} className="x-btn x-btn--primary x-btn--block" onClick={close}>
          See agents that can do this
        </Link>
      </div>
    );
  } else if (step === "free" && offer.sponsored) {
    body = (
      <div className="x-hire">
        <button type="button" className="x-hire__back" onClick={() => setStep("review")}>
          <ArrowLeft size={14} aria-hidden="true" /> Back to paying it yourself
        </button>
        <SponsoredHire
          tokenId={offer.tokenId}
          name={offer.name}
          price={offer.sponsored.price}
          asks={offer.sponsored.asks}
          checkWith={offer.sponsored.checkWith}
          takesSubject={offer.sponsored.takesSubject}
        />
      </div>
    );
  } else if (step === "review") {
    body = (
      <div className="x-hire">
        <div className="x-hire__agent">
          <span className="x-hire__art" aria-hidden="true">
            {offer.art}
          </span>
          <span>
            <span className="x-hire__name">{offer.name}</span>
            {offer.categoryLabel ? <span className="x-hire__cat">{offer.categoryLabel}</span> : null}
          </span>
        </div>
        <dl className="x-kv">
          <div>
            <dt>Task</dt>
            <dd>{offer.task}</dd>
          </div>
          <div>
            <dt>Price</dt>
            <dd>
              <strong>{viaEscrow ? `${escrowPrice} a job` : price}</strong>
              {!viaEscrow && offer.price.exact && offer.price.exact !== offer.price.value ? <span className="x-hire__sub x-mono">{offer.price.exact}</span> : null}
            </dd>
          </div>
          {viaEscrow ? (
            // A job is worked after it is funded; the handshake's speed says nothing about that.
            <div>
              <dt>Delivery</dt>
              <dd>
                {offer.escrow!.outside?.etaSeconds
                  ? `About ${Math.max(1, Math.round(offer.escrow!.outside.etaSeconds / 60))} min after you fund it, as its seller quotes`
                  : "Within minutes of funding, or you take the money back"}
              </dd>
            </div>
          ) : offer.latencyMs !== null ? (
            <div>
              <dt>Expected response</dt>
              <dd className="x-mono">~{offer.latencyMs} ms</dd>
            </div>
          ) : null}
          {viaEscrow ? (
            <div>
              <dt>Paid through</dt>
              <dd>ERC-8183 escrow, released to {short(offer.escrow!.provider)} after it delivers</dd>
            </div>
          ) : offer.x402 ? (
            <div>
              <dt>Pays to</dt>
              <dd className="x-mono" title={offer.x402.payTo}>
                {short(offer.x402.payTo)}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Settled on</dt>
            <dd>{offer.x402 && !viaEscrow ? network(offer.x402.network) : "BNB Smart Chain"}</dd>
          </div>
        </dl>

        {both ? (
          <fieldset className="x-hire__modes">
            <legend className="x-hire__h">How to pay</legend>
            <label className={mode === "escrow" ? "x-hire__mode x-hire__mode--on" : "x-hire__mode"}>
              <input type="radio" name={`pay-${offer.tokenId}`} checked={mode === "escrow"} onChange={() => setMode("escrow")} />
              <span>
                <span className="x-hire__mode-t">
                  Escrowed job, {escrowPrice} <span className="x-tag">Recommended</span>
                </span>
                <span className="x-hire__mode-d">
                  Your $U waits in the ERC-8183 escrow until the agent delivers, and comes back if it does not. Recorded on chain as a hire of this agent.
                  Five transactions and a little BNB for gas.
                </span>
              </span>
            </label>
            <label className={mode === "call" ? "x-hire__mode x-hire__mode--on" : "x-hire__mode"}>
              <input type="radio" name={`pay-${offer.tokenId}`} checked={mode === "call"} onChange={() => setMode("call")} />
              <span>
                <span className="x-hire__mode-t">Pay per call, {offer.price.exact ?? price}</span>
                <span className="x-hire__mode-d">
                  {offer.x402!.transferMethod === "permit2"
                    ? "One approval and one signature for exactly the price. The answer comes back at once."
                    : "One signature for exactly the price, and no gas. The answer comes back at once."}
                </span>
              </span>
            </label>
          </fieldset>
        ) : null}

        {offer.inputs.length ? (
          <fieldset className="x-hire__inputs">
            <legend className="x-hire__h">What it needs from you</legend>
            {offer.inputs.map((i) => (
              <label key={i.name} className="x-field">
                <span className="x-field__l">
                  {i.name}
                  {i.required ? "" : " (optional)"}
                  {i.description ? <span className="x-hire__sub"> {i.description}</span> : null}
                </span>
                <input
                  className="x-input x-mono"
                  value={values[i.name] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))}
                  placeholder={i.kind === "wallet" ? "0x…" : i.kind === "position" ? "e.g. 7546488" : ""}
                  inputMode={i.kind === "position" ? "numeric" : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={wrong(i) ? true : undefined}
                />
                {wrong(i) ? <span className="x-hire__bad">{wrong(i)}</span> : null}
              </label>
            ))}
            {needed.length === 0 && offer.inputs.length > 1 && !offer.blanksOk ? <p className="x-hire__sub">Fill in one of these.</p> : null}
          </fieldset>
        ) : null}

        {offer.escrow?.outside?.tryable && viaEscrow ? (
          <div className="x-hire__try">
            <div className="x-hire__try-row">
              <button type="button" className="x-btn x-btn--sm" onClick={() => void tryIt()} disabled={trying || !inputsReady}>
                {trying ? "Asking it…" : "Try it free first"}
              </button>
              <span className="x-hire__sub">Runs your task on the agent&apos;s own server. Nothing is paid or signed.</span>
            </div>
            {tried ? (
              tried.free ? (
                <details className="x-hire__adv" open>
                  <summary>Its free answer</summary>
                  <pre className="x-pre">{typeof tried.answer === "string" ? tried.answer.slice(0, 4000) : JSON.stringify(tried.answer, null, 2).slice(0, 4000)}</pre>
                </details>
              ) : (
                <p className="x-hire__sub">{tried.reason ?? tried.error}</p>
              )
            ) : null}
          </div>
        ) : null}

        {offer.sponsored ? (
          <div className="x-hire__free">
            <Gift size={18} aria-hidden="true" />
            <div>
              <p className="x-hire__free-t">Try it free, we pay</p>
              <p className="x-hire__free-p">Mandate pays for this call from its own wallet. No wallet needed. A few a day.</p>
            </div>
            <button type="button" className="x-btn x-btn--sm" onClick={() => setStep("free")}>
              Try free
            </button>
          </div>
        ) : null}

        {offer.job && offer.x402 ? (
          <p className="x-hire__alt">
            Want it to run a strategy with your capital instead?{" "}
            <Link className="x-link" href={offer.job.href}>
              Hire it for a job
            </Link>
          </p>
        ) : null}
      </div>
    );
    foot = (
      <button type="button" className="x-btn x-btn--primary x-btn--block x-btn--lg" onClick={() => setStep("permissions")} disabled={!inputsReady}>
        {inputsReady ? "Continue" : "Fill in what it needs"}
      </button>
    );
  } else if (step === "permissions") {
    if (offer.x402 && !viaEscrow) {
      const permit2 = offer.x402.transferMethod === "permit2";
      body = (
        <div className="x-hire">
          <p className="x-hire__lede">This is everything the payment allows. Read it once; it does not change after you sign.</p>
          <h3 className="x-hire__h">It can</h3>
          <Can items={[`Move exactly ${exact} from your wallet to ${short(offer.x402.payTo)}, once`, "Send you its answer"]} />
          <h3 className="x-hire__h">It cannot</h3>
          <Can no items={["Move any other funds", "Act for you after this call", "Charge you again without a new signature"]} />
          <dl className="x-kv">
            <div>
              <dt>Spend cap</dt>
              <dd>Exactly {exact}</dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>Within 10 minutes of signing, and it can be spent once</dd>
            </div>
            <div>
              <dt>Gas</dt>
              <dd>{permit2 ? "One approval for exactly this amount" : "None. The seller pays it"}</dd>
            </div>
          </dl>
          <details className="x-hire__adv">
            <summary>Advanced</summary>
            <dl className="x-kv">
              <div>
                <dt>Scheme</dt>
                <dd className="x-mono">{offer.x402.scheme}</dd>
              </div>
              <div>
                <dt>Transfer</dt>
                <dd className="x-mono">{permit2 ? "Permit2" : "EIP-3009 authorisation"}</dd>
              </div>
              <div>
                <dt>Asset</dt>
                <dd className="x-mono">
                  {offer.x402.assetName ? `${offer.x402.assetName} ` : ""}
                  {offer.x402.asset}
                </dd>
              </div>
              <div>
                <dt>Pays to</dt>
                <dd className="x-mono">{offer.x402.payTo}</dd>
              </div>
              <div>
                <dt>Network</dt>
                <dd className="x-mono">{offer.x402.network}</dd>
              </div>
              <div>
                <dt>Header</dt>
                <dd className="x-mono">
                  {offer.x402.header} · x402 v{offer.x402.version}
                </dd>
              </div>
            </dl>
          </details>
        </div>
      );
      foot = (
        <div className="x-hire__nav">
          <button type="button" className="x-btn x-btn--ghost" onClick={() => setStep("review")}>
            Back
          </button>
          <button type="button" className="x-btn x-btn--primary x-btn--lg" onClick={() => setStep("confirm")}>
            Continue
          </button>
        </div>
      );
    } else if (offer.job && !viaEscrow) {
      body = (
        <div className="x-hire">
          <p className="x-hire__lede">
            A job gives the agent a scoped session on your account for a term you choose. It posts a bond it loses if it falls short of your benchmark.
          </p>
          {offer.job.can.length ? (
            <>
              <h3 className="x-hire__h">It can</h3>
              <Can items={offer.job.can} />
            </>
          ) : null}
          <h3 className="x-hire__h">It cannot</h3>
          <Can no items={offer.job.cannot} />
          {offer.job.caps.length ? (
            <dl className="x-kv">
              <div>
                <dt>Daily cap</dt>
                <dd>{offer.job.caps.join(", ")}</dd>
              </div>
            </dl>
          ) : null}
        </div>
      );
      foot = (
        <div className="x-hire__nav">
          <button type="button" className="x-btn x-btn--ghost" onClick={() => setStep("review")}>
            Back
          </button>
          <Link href={offer.job.href} className="x-btn x-btn--primary x-btn--lg">
            Set the terms
          </Link>
        </div>
      );
    } else if (viaEscrow) {
      const e = offer.escrow!;
      body = (
        <div className="x-hire">
          <p className="x-hire__lede">Your $U waits in the ERC-8183 escrow contract, not with the agent or with us, until the work is on chain.</p>
          <h3 className="x-hire__h">It can</h3>
          <Can items={[`Receive exactly ${escrowPrice} from the escrow, once it delivers and the dispute window passes`, "Send you its answer"]} />
          <h3 className="x-hire__h">It cannot</h3>
          <Can no items={["Move any other funds", "Keep the budget if it does not deliver in time: you claim it back", "Act for you after this job"]} />
          <dl className="x-kv">
            <div>
              <dt>Budget</dt>
              <dd>Exactly {escrowPrice}</dd>
            </div>
            <div>
              <dt>Provider</dt>
              <dd className="x-mono" title={e.provider}>
                {short(e.provider)}
              </dd>
            </div>
            <div>
              <dt>Signatures</dt>
              <dd>Five transactions, each shown before you sign. About 0.0001 BNB of gas covers all five.</dd>
            </div>
          </dl>
        </div>
      );
      foot = (
        <div className="x-hire__nav">
          <button type="button" className="x-btn x-btn--ghost" onClick={() => setStep("review")}>
            Back
          </button>
          <button type="button" className="x-btn x-btn--primary x-btn--lg" onClick={() => setStep("confirm")}>
            Continue
          </button>
        </div>
      );
    }
  }

  // An escrow-only seller's five transactions run in one component, which stays mounted from here.
  if (viaEscrow && step !== "review" && step !== "permissions" && step !== "free") {
    body = (
      <div className="x-hire">
        <p className="x-hire__lede">Nothing moves until you sign each step.</p>
        <EscrowHire offer={offer.escrow!} subject={sent.position ?? sent.wallet ?? sent.address ?? null} inputs={sent} category={offer.category} />
      </div>
    );
    foot = (
      <button type="button" className="x-btn x-btn--ghost x-btn--block" onClick={close}>
        Close
      </button>
    );
  }

  // Confirm, processing and success share one payment engine, which must stay
  // mounted while money is moving, so it is rendered once here and hidden when done.
  const paying = offer.x402 && !viaEscrow && (step === "confirm" || step === "processing" || step === "success");
  if (paying) {
    body = (
      <div className="x-hire">
        {step === "confirm" ? <p className="x-hire__lede">Nothing happens until you sign. The price below is read from the seller again, now.</p> : null}
        {tx && step !== "confirm" ? <TxStatus step={tx.step} failed={tx.failed} /> : null}
        <div hidden={step === "success"}>
          <BuyOneCall
            path={offer.x402!.path}
            method={offer.x402!.method}
            body={offer.x402!.body}
            tokenId={offer.tokenId}
            inputs={sent}
            what={offer.task}
            onPhase={onPhase}
            autoQuote
            quiet
          />
        </div>
        {step === "success" && result ? (
          <div className="x-hire__done">
            <p className="x-hire__ok">
              <Check size={18} strokeWidth={3} aria-hidden="true" />
              {result.tx ? "Paid, and the agent answered." : "The agent answered without charging."}
            </p>
            <dl className="x-kv">
              {result.tx ? (
                <div>
                  <dt>Transaction</dt>
                  <dd className="x-mono">
                    <a className="x-link" href={`https://bscscan.com/tx/${result.tx}`} target="_blank" rel="noreferrer">
                      {short(result.tx)}
                    </a>
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>Cost</dt>
                <dd>{result.tx ? (lastPrice ?? exact) : "Nothing"}</dd>
              </div>
              <div>
                <dt>Agent</dt>
                <dd>{offer.name}</dd>
              </div>
              <div>
                <dt>Scope</dt>
                <dd>One call. Nothing else was authorised.</dd>
              </div>
            </dl>
            <details className="x-hire__adv" open>
              <summary>The answer</summary>
              <pre className="x-pre">{typeof result.body === "string" ? result.body.slice(0, 6000) : JSON.stringify(result.body, null, 2).slice(0, 6000)}</pre>
            </details>
            {result.tx ? <RateAgent tokenId={offer.tokenId} name={offer.name} category={offer.category} hireTx={result.tx} /> : null}
          </div>
        ) : null}
      </div>
    );
    foot =
      step === "success" ? (
        <div className="x-hire__nav">
          <Link href="/activity" className="x-btn x-btn--ghost">
            View activity
          </Link>
          <button type="button" className="x-btn x-btn--primary x-btn--lg" onClick={close}>
            Done
          </button>
        </div>
      ) : step === "confirm" ? (
        <button type="button" className="x-btn x-btn--ghost x-btn--block" onClick={() => setStep("permissions")}>
          Back to permissions
        </button>
      ) : null;
  }

  return (
    <Drawer
      open={open}
      onClose={close}
      title={title}
      footer={
        <>
          {foot}
          <NeedHelp compact />
        </>
      }
    >
      {!offer.refuse && offer.x402 && !viaEscrow && step !== "free" ? (
        <ol className="x-steps" aria-label="Steps">
          {FLOW.map((f, i) => (
            <li key={f.id} className={i < flowAt ? "x-steps__done" : i === flowAt ? "x-steps__now" : undefined} aria-current={i === flowAt ? "step" : undefined}>
              <span className="x-steps__n" aria-hidden="true">
                {i < flowAt ? <Check size={12} strokeWidth={3} /> : i + 1}
              </span>
              <span className="x-steps__t">{f.label}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {body}
    </Drawer>
  );
}

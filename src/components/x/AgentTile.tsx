import Link from "next/link";
import { Check, X } from "lucide-react";
import { CATEGORY_LABEL } from "@/lib/config";
import type { Listing } from "@/lib/market/listing";
import { hireHref, hirePath, primaryRail } from "@/lib/market/hire-law";
import { tryFreeKind } from "@/lib/market/catalogue";
import { assayFor } from "@/lib/market/assays";
import { trustOf } from "@/lib/market/trust";
import AgentArtwork from "./AgentArtwork";
import AgentSeal from "./AgentSeal";
import Status from "./Status";
import { priceParts } from "./Price";
import CompareToggle from "./CompareToggle";

/**
 * One agent on the shelf: its face, its name and standing, what it does in a
 * line, then three figures a buyer compares (price, how fast it delivers,
 * how much paid work it has done) and the actions.
 *
 * Everything shown is a fact we hold. The price is the one Hire will charge,
 * on the rail it uses; "delivers" is the median of the escrowed jobs bought
 * here, or how fast it answered our last call; "done" is paid work delivered.
 * The standing line is the hire law's verdict: hireable, with the strongest
 * thing a check has proved, or the reason it is not. Hire appears only when
 * the hire law finds a rail we can settle, and Try free only where a free try
 * exists.
 */

// Short, so the rail fits under the price; the agent page spells them out.
const RAIL: Record<string, string> = { x402: "x402", escrow: "escrow", mandate: "job with capital" };
// The chip sits on the art beside "Ours"; the full name is on the agent page.
const SHORT: Record<string, string> = { "health-factor": "Health Factor" };

/** Seconds as a person says them: "9 s", "3 min", "2 h". */
export function took(seconds: number): string {
  if (seconds < 1) return "<1 s";
  if (seconds < 120) return `${Math.round(seconds)} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

export default function AgentTile({ l, forPosition }: { l: Listing; forPosition?: string }) {
  const verdict = hirePath(l);
  const href = hireHref(l.tokenId, verdict);
  const trust = trustOf(l, assayFor(l.tokenId));
  const lead = primaryRail(verdict);
  const rail = (lead ? RAIL[lead.kind] : null) ?? (l.quote || l.declaresPayment ? "x402" : null);
  const price = priceParts(l, lead);
  // Try it before paying: we pay for a call to it, or it answers its task free (BNB's SDK).
  const free = tryFreeKind(l, verdict);
  const tryHref = free === "sponsored" ? `/agents/${l.tokenId}#sponsored` : free === "sdk" ? `/agents/${l.tokenId}#try` : null;
  const detail = `/agents/${l.tokenId}${forPosition ? `?about=${encodeURIComponent(forPosition)}` : ""}`;
  // An answer we checked against the chain ourselves outranks any other proof.
  const proof = l.checked?.verdict === "pass" ? "Passed MANDATE checks" : (trust.badges[0] ?? null);

  // How fast: our own record of its escrowed jobs first, then its answer to our call, then the seller's own estimate.
  const speed = l.deliveredIn
    ? { v: took(l.deliveredIn.seconds), n: l.deliveredIn.jobs === 1 ? "1 job here" : `median, ${l.deliveredIn.jobs} jobs` }
    : lead?.kind === "x402" && l.probe?.answered && l.probe.latencyMs != null
      ? { v: took(l.probe.latencyMs / 1000), n: "to answer" }
      : l.escrowQuote?.etaSeconds
        ? { v: took(l.escrowQuote.etaSeconds), n: "its estimate" }
        : { v: "Not yet", n: "no job here yet" };

  return (
    <article className={`x-agent${verdict.ok ? "" : " x-agent--dim"}`} data-agent={l.tokenId}>
      <div className="x-agent__art">
        <AgentArtwork category={l.category} seed={`${l.tokenId}:${l.name}`} />
        <div className="x-agent__over">
          <Status liveness={l.liveness} at={l.probe?.at} />
        </div>
        <div className="x-agent__under">
          {l.category ? (
            <span className="x-catchip">
              <span className={`x-dotcat x-dotcat--${l.category}`} aria-hidden="true" />
              {SHORT[l.category] ?? CATEGORY_LABEL[l.category]}
            </span>
          ) : null}
          {verdict.ours ? (
            <span className="x-catchip x-catchip--ref" title="One of Mandate's own reference agents, listed with the same checks as everyone else">
              Ours
            </span>
          ) : null}
        </div>
      </div>

      <div className="x-agent__cmp">
        <CompareToggle tokenId={l.tokenId} name={l.name} />
      </div>

      <div className="x-agent__body">
        <div className="x-agent__id">
          <AgentSeal className="x-agent__seal" tokenId={l.tokenId} name={l.name} category={l.category} size={44} />
          <div className="x-agent__idt">
            <Link href={detail} className="x-agent__name">
              {l.name}
            </Link>
            {verdict.ok ? (
              <p className="x-agent__state x-agent__state--ok">
                <Check size={13} strokeWidth={2.5} aria-hidden="true" />
                <span>{proof ? `Hireable · ${proof}` : "Hireable"}</span>
              </p>
            ) : (
              <p className="x-agent__state x-agent__state--no" title={verdict.reason ?? undefined}>
                <X size={13} strokeWidth={2.5} aria-hidden="true" />
                <span>{verdict.short ?? "Not available to hire"}</span>
              </p>
            )}
          </div>
        </div>

        <p className="x-agent__what">{l.what ?? "Published no description of what it does."}</p>

        <dl className="x-agent__stats">
          <div title={price.exact ?? undefined}>
            <dt>Price</dt>
            <dd>
              {price.value ? (
                <>
                  <strong className="x-agent__fig">{price.value}</strong>
                  <span className="x-agent__cap">
                    {price.unit === "/ job" ? "per job" : "per call"}
                    {rail ? ` · ${rail}` : ""}
                  </span>
                </>
              ) : (
                <>
                  <strong className="x-agent__fig x-agent__fig--none">None yet</strong>
                  <span className="x-agent__cap">{price.none ?? "No price published"}</span>
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>Delivers</dt>
            <dd>
              <strong className={`x-agent__fig${speed.v === "Not yet" ? " x-agent__fig--none" : ""}`}>{speed.v}</strong>
              <span className="x-agent__cap">{speed.n}</span>
            </dd>
          </div>
          <div>
            <dt>Done</dt>
            <dd>
              <strong className={`x-agent__fig${l.settled ? "" : " x-agent__fig--none"}`}>{l.settled ? l.settled.toLocaleString("en-US") : "New"}</strong>
              <span className="x-agent__cap">{l.settled ? (l.settled === 1 ? "paid job" : "paid jobs") : "no paid work yet"}</span>
            </dd>
          </div>
        </dl>

        {verdict.ok && href ? (
          <div className={`x-agent__acts${tryHref ? " x-agent__acts--two" : ""}`}>
            {tryHref ? (
              <Link href={tryHref} className="x-btn x-btn--sm x-agent__try">
                Try free
              </Link>
            ) : null}
            <Link href={href} className="x-btn x-btn--sm x-btn--primary x-agent__hire">
              Hire
            </Link>
          </div>
        ) : (
          <Link href={detail} className="x-btn x-btn--sm x-btn--ghost x-agent__see">
            See why
          </Link>
        )}
      </div>
    </article>
  );
}

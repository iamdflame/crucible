import Link from "next/link";
import { Check } from "lucide-react";
import { CATEGORY_LABEL } from "@/lib/config";
import type { Listing } from "@/lib/market/listing";
import { hireHref, hirePath } from "@/lib/market/hire-law";
import { assayFor } from "@/lib/market/assays";
import { trustOf } from "@/lib/market/trust";
import AgentArtwork from "./AgentArtwork";
import Status from "./Status";
import Price from "./Price";
import CompareToggle from "./CompareToggle";

/**
 * One agent on the shelf, in five things: the picture with its status, the
 * name, what it does in a line, what it costs, and one action.
 *
 * Everything shown is a fact we hold: the status is our own call with its age,
 * the price is read from its own 402, and the single check mark is the
 * strongest thing a check has proved about it. Latency, the rail, the token
 * amount and every other proof are on the agent's page, one tap away. Hire
 * appears only when the hire law finds a rail we can settle; otherwise the
 * reason sits there.
 */

const RAIL: Record<string, string> = { x402: "x402", escrow: "ERC-8183 escrow", mandate: "job with capital" };
// The chip sits on the art beside "Ours"; the full name is on the agent page.
const SHORT: Record<string, string> = { "health-factor": "Health Factor" };

export default function AgentTile({ l, forPosition }: { l: Listing; forPosition?: string }) {
  const verdict = hirePath(l);
  const href = hireHref(l.tokenId, verdict);
  const trust = trustOf(l, assayFor(l.tokenId));
  const rail = verdict.rails.map((r) => RAIL[r.kind]).find(Boolean) ?? (l.quote || l.declaresPayment ? "x402" : null);
  const detail = `/agents/${l.tokenId}${forPosition ? `?about=${encodeURIComponent(forPosition)}` : ""}`;
  // An answer we checked against the chain ourselves outranks any other proof.
  const proof = l.checked?.verdict === "pass" ? "Passed MANDATE checks" : (trust.badges[0] ?? null);

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
        <Link href={detail} className="x-agent__name">
          {l.name}
        </Link>
        <p className="x-agent__what">{l.what ?? "Published no description of what it does."}</p>

        <div className="x-agent__buy">
          <Price l={l} rail={rail} />
          {proof ? (
            <span className="x-agent__proof">
              <Check size={13} strokeWidth={2.5} aria-hidden="true" />
              {proof}
            </span>
          ) : null}
        </div>

        {verdict.ok && href ? (
          <Link href={href} className="x-btn x-btn--sm x-btn--primary x-btn--block x-agent__hire">
            Hire
          </Link>
        ) : verdict.short ? (
          <p className="x-agent__why" title={verdict.reason ?? undefined}>
            {verdict.short}
          </p>
        ) : null}
      </div>
    </article>
  );
}

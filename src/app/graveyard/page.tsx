import Link from "next/link";
import type { Metadata } from "next";
import AppShell from "@/components/v2/shell/AppShell";
import Source from "@/components/x/Source";
import Empty from "@/components/x/Empty";
import { listPaidCalls, type PaidCallRecord } from "@/lib/market/paid-calls";
import { strangerHires } from "@/lib/market/stranger-hires";
import { assetSymbol } from "@/lib/market/listing";
import { graveAnchor, graveyard, type Grave, type GraveKind } from "@/lib/market/graveyard";
import { withTimeout } from "@/lib/cache";

export const metadata: Metadata = {
  title: "Graveyard | MANDATE",
  description: "Agents that took payment on BNB Smart Chain and did not deliver, and payments refused after being quoted. Kept permanently, with the seller's own words.",
};

export const revalidate = 300;

const REPO = "https://github.com/iamdflame/mandate-bnb/blob/main";
const bscTx = (h: string) => `https://bscscan.com/tx/${h}`;
const shortTx = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

const SECTIONS: { kind: GraveKind; title: string; note: string }[] = [
  {
    kind: "took",
    title: "Took the money, returned nothing",
    note: "The payment settled on chain. The work did not arrive, or arrived as an error. The transaction is the proof that it happened.",
  },
  {
    kind: "refused",
    title: "Refused a payment it had quoted",
    note: "No money moved. The seller published a price, we signed exactly that, and it would not take it. Where the fault was ours, the row says so and it counts against nobody.",
  },
  {
    kind: "unchecked",
    title: "Delivered something nobody can check",
    note: "An escrowed job whose deliverable does not hash to the commitment the provider made on chain. We will not settle these, and we will not quietly drop them either.",
  },
];

function what(g: Grave): string {
  const price = g.amount !== null ? `${g.amount} ${assetSymbol(g.asset) ?? "tokens"}` : null;
  const job = g.subject ?? "a call";
  if (g.kind === "took") return `We paid ${price ?? "it"} for ${job}, and it ${g.said ? "answered with an error" : "returned nothing"}.`;
  if (g.kind === "refused") return `We signed exactly the ${price ?? "price"} it quoted for ${job}, and it would not take it.`;
  return `We funded ${g.id.replace("job:", "job ")} with ${g.budget ?? "its budget"} in escrow. The deliverable it submitted does not hash to what it committed.`;
}

function Row({ g }: { g: Grave }) {
  return (
    <li className="x-grave" id={graveAnchor(g)} data-ours={g.ours ? "true" : undefined}>
      <div className="x-grave__who">
        <Link className="x-grave__name" href={`/agents/${g.tokenId}`}>
          {g.name}
        </Link>
        <span className="x-mono x-dim">#{g.tokenId}</span>
        {g.ours ? <span className="x-grave__ours">Our mistake, not theirs</span> : null}
      </div>
      <p className="x-grave__what">{what(g)}</p>
      {g.said ? (
        <blockquote className="x-grave__said">
          <p className="x-mono">{g.said}</p>
        </blockquote>
      ) : null}
      {g.note ? <p className="x-grave__note">{g.note}</p> : null}
      <p className="x-grave__foot">
        {g.tx ? (
          <a className="x-link x-mono" href={bscTx(g.tx)} target="_blank" rel="noreferrer">
            {g.kind === "unchecked" ? "funding" : "payment"} {shortTx(g.tx)}
          </a>
        ) : null}
        {g.disputeTx ? (
          <a className="x-link x-mono" href={bscTx(g.disputeTx)} target="_blank" rel="noreferrer">
            our dispute {shortTx(g.disputeTx)}
          </a>
        ) : null}
        {g.sha256 ? (
          <span className="x-mono x-dim" title="sha256 of the full request and response">
            sha256 {g.sha256.slice(0, 12)}…
          </span>
        ) : null}
        {g.evidence ? (
          <a
            className="x-link"
            href={g.evidence.startsWith("http") ? g.evidence : `${REPO}/${g.evidence}`}
            target="_blank"
            rel="noreferrer"
          >
            {g.kind === "unchecked" ? "the deliverable" : "the full exchange"}
          </a>
        ) : null}
      </p>
      <Source kind={g.kind === "took" ? "chain" : "record"} block={g.block} at={g.at} verb="recorded" />
    </li>
  );
}

/**
 * The agents that failed, kept permanently.
 *
 * Every marketplace publishes its successes. This is the page that makes them
 * mean anything: agents that took money on mainnet and returned nothing,
 * agents that refused a payment they had quoted themselves, and escrowed work
 * that does not match its own commitment.
 *
 * Two rules keep it honest rather than vindictive. A failure we caused is
 * published too and says it was ours: the first payment to Agripinaa was
 * refused because we sent the specification's envelope to a seller that
 * reads a different dialect, and deleting that row would have been the easy
 * fix and the wrong one. And nothing is summarised away: each row carries the
 * transaction, the seller's own words and the hash of the full exchange, so
 * anyone who thinks we are being unfair can check.
 */
export default async function GraveyardPage() {
  const calls = (await withTimeout(listPaidCalls().catch(() => [] as PaidCallRecord[]), 6_000)) ?? [];
  const graves = graveyard(calls, strangerHires());
  const ours = graves.filter((g) => g.ours).length;

  return (
    <AppShell>
      <section className="x-wrap x-mkt-head">
        <div className="x-mkt-head__row">
          <h1 className="x-mkt-head__h">Graveyard</h1>
          <p className="x-mkt-head__sub">Agents that took money and did not deliver, and payments refused after being quoted. Kept permanently.</p>
        </div>
        <p className="x-proof-lede">
          Nothing here is removed when it becomes inconvenient, including the failures that were ours. An agent whose latest paid call failed is not offered for hire
          until it delivers one again, with the sentence its own server sent as the reason. Its row here stays for good.
        </p>
        {graves.length ? (
          <ul className="x-score" aria-label="What is recorded">
            {SECTIONS.map((s) => (
              <li key={s.kind} className="x-score__item">
                <span className="x-score__n x-mono">{graves.filter((g) => g.kind === s.kind).length}</span> {s.kind === "took" ? "took and failed" : s.kind === "refused" ? "refused" : "unverifiable"}
              </li>
            ))}
            <li className="x-score__item">
              <span className="x-score__n x-mono">{ours}</span> ours
            </li>
          </ul>
        ) : null}
      </section>

      {graves.length === 0 ? (
        <div className="x-wrap x-section--tight">
          <Empty
            title="Nothing has failed yet."
            action={
              <Link className="x-btn x-btn--primary" href="/agents?hireable=1">
                See who can be hired
              </Link>
            }
          >
            That is not a boast. It means we have not paid enough strangers for this page to be interesting, and the answer is to hire more of them.
          </Empty>
        </div>
      ) : null}

      {SECTIONS.map((s) => {
        const rows = graves.filter((g) => g.kind === s.kind);
        if (!rows.length) return null;
        return (
          <section key={s.kind} className="x-wrap x-section--tight" aria-labelledby={`h-${s.kind}`}>
            <h2 id={`h-${s.kind}`} className="x-proof-h">
              {s.title} <span className="x-chip__n">{rows.length}</span>
            </h2>
            <p className="x-ad-src">{s.note}</p>
            <ul className="x-graves">
              {rows.map((g) => (
                <Row key={g.id} g={g} />
              ))}
            </ul>
          </section>
        );
      })}

      <section className="x-wrap x-section--tight">
        <p className="x-ad-src">
          Everything here is also on{" "}
          <Link className="x-link" href="/activity?kind=payments">
            the live market
          </Link>
          , next to the calls that worked. What hiring an agent is worth against doing it yourself, losses included, is on{" "}
          <Link className="x-link" href="/proof">
            Proof
          </Link>
          .
        </p>
      </section>
    </AppShell>
  );
}

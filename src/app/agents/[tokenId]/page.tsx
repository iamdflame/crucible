import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ArrowUpRight, Check, ChevronRight, Gift, HelpCircle, Zap } from "lucide-react";
import AppShell from "@/components/v2/shell/AppShell";
import AgentArtwork from "@/components/x/AgentArtwork";
import Status from "@/components/x/Status";
import Price, { priceParts } from "@/components/x/Price";
import Proof, { ProofGlyph } from "@/components/x/Proof";
import Ago from "@/components/x/Ago";
import CompareToggle from "@/components/x/CompareToggle";
import HireDrawer from "@/components/x/HireDrawer";
import { offerFor } from "@/components/x/offer";
import TrustPanel from "@/components/v2/agent/TrustPanel";
import { CATEGORY_LABEL, CHAIN_ID, IDENTITY_REGISTRY } from "@/lib/config";
import { findAgent } from "@/lib/data/agents";
import { REVIEW_CAVEAT, assetSymbol, listingFor, type Listing } from "@/lib/market/listing";
import { assayFor, assaySnapshot } from "@/lib/market/assays";
import { previewFor } from "@/lib/market/quotes";
import { live } from "@/lib/data/live";
import { describeStatus, strangerHiresLive } from "@/lib/market/stranger-hires";
import { jobsOfAgent, type EscrowJob } from "@/lib/escrow/jobs";
import { hirePath } from "@/lib/market/hire-law";
import { hireCounts } from "@/lib/market/hires";
import { SPONSORED } from "@/lib/market/sponsored-targets";
import { STATE_WORD, trustOf, type ProofState } from "@/lib/market/trust";
import { houseSlug, performanceOf } from "@/lib/market/performance";
import { houseActivity } from "@/lib/house/runs";
import { indexToken } from "@/lib/registry/tail";
import { listPaidCalls } from "@/lib/market/paid-calls";
import { buriedFor, graveAnchor, graveyard } from "@/lib/market/graveyard";
import { HOUSE_LEASHES } from "@/lib/chain/house";

export const revalidate = 300;
// Room for the census slice that runs after the response (see lib/census/refresh).
export const maxDuration = 60;

export async function generateMetadata({ params }: { params: Promise<{ tokenId: string }> }): Promise<Metadata> {
  const { tokenId } = await params;
  const a = findAgent(tokenId);
  if (!a) return { title: "Agent not found | MANDATE" };
  const name = a.name?.trim() || `Agent ${tokenId}`;
  return {
    title: `${name} | MANDATE`,
    description: (a.description ?? "").slice(0, 180) || `Agent ${tokenId} on BNB Smart Chain.`,
  };
}

const RAIL: Record<string, string> = { x402: "x402", escrow: "ERC-8183 escrow", mandate: "job with capital" };

/** Its own words as separate sentences, untouched, for the "What it can do" list. */
function sentences(text: string | null): string[] {
  if (!text) return [];
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

const COUNT_ORDER: ProofState[] = ["proven", "unproven", "failed", "nodata"];

/** What became of an escrowed job bought here, from the kernel's status as last recorded. */
function jobWords(j: EscrowJob): string {
  switch (j.status) {
    case "SUBMITTED":
      return "delivered on chain; paid to the agent once the seven-day dispute window passes";
    case "COMPLETED":
      return "delivered on chain and paid";
    case "EXPIRED":
      return "not delivered; the budget went back to the buyer";
    case "REJECTED":
      return "disputed; the budget went back to the buyer";
    default:
      return j.expiredAt && Date.now() / 1000 > j.expiredAt ? "not delivered by its deadline; the buyer can take the budget back" : "funded, waiting for the agent to deliver";
  }
}

/**
 * One agent, as a product page.
 *
 * The first screen answers what a buyer asks first: what is it, what does it
 * cost, is it alive, and how do I use it. Then what it can do, in its own
 * words. Then what we have proven about it, row by row, with every state
 * explained. Then the record and the raw facts, for anyone who wants to check
 * our work. The action follows the reader down the page: a sticky panel on a
 * desktop, a bar at the bottom of a phone.
 *
 * Nothing here is invented. A price is its own 402, a response time is our
 * own call, a proof is a check that passed, and where there is no record the
 * page says so rather than drawing one.
 */
export default async function AgentPage({ params }: { params: Promise<{ tokenId: string }> }) {
  const { tokenId } = await params;
  const paidJobs = (await strangerHiresLive().catch(() => [])).filter((h) => h.tokenId === tokenId);
  // Escrowed jobs bought on this site, from its own record; the filed September hires are shown above them once.
  const siteJobs = (await jobsOfAgent(tokenId).catch(() => [])).filter((j) => !paidJobs.some((h) => h.jobId === j.jobId));
  await live();
  /*
    Every agent on the registry has a page, including one minted a minute ago
    that the tail has not reached yet: it is read from the chain now, indexed,
    and shown. Only a token the registry does not hold is a 404.
  */
  const agent = findAgent(tokenId) ?? (/^\d{1,20}$/.test(tokenId) ? await indexToken(tokenId, "view").catch(() => null) : null);
  if (!agent) notFound();

  const hc = await hireCounts();
  const hires = hc.byTokenId.get(tokenId) ?? 0;
  const l: Listing = listingFor(tokenId, hires, (hc.settled.get(tokenId) ?? 0) + hires) ?? notFound();
  const snapshot = assaySnapshot();
  const stored = assayFor(l.tokenId);
  const trust = trustOf(l, stored);
  const slugOf = houseSlug(l.tokenId);
  const action = slugOf ? ((await houseActivity().catch(() => null))?.[slugOf]?.action ?? null) : null;
  const perf = performanceOf(l.tokenId, l.settled, action);
  const ownCalls = (await listPaidCalls().catch(() => [])).filter((c) => c.tokenId === l.tokenId);
  const calls = ownCalls.slice(0, 8);
  // Its own failure on record, if any; one of ours never counts against it.
  const grave = buriedFor(l.tokenId, graveyard(ownCalls, paidJobs));
  const preview = previewFor(l.tokenId);

  /*
    What this page may offer is decided by the hire law, not here: a paid call
    only when the agent quoted a price we can settle, a job only for an agent
    that bids in this market, and neither on a stale or silent agent.
  */
  const verdict = hirePath(l);
  const perCall = verdict.rails.find((r) => r.kind === "x402");
  const jobRail = verdict.rails.some((r) => r.kind === "mandate");
  const sponsor = verdict.ok ? SPONSORED[l.tokenId] : undefined;
  const rail = verdict.rails.map((r) => RAIL[r.kind]).find(Boolean) ?? (l.quote || l.declaresPayment ? "x402" : null);
  const cat = l.category ? CATEGORY_LABEL[l.category] : null;
  const slug = slugOf;
  const leash = slug ? HOUSE_LEASHES.find((h) => h.slug === slug) : undefined;
  const pp = priceParts(l);
  const said = sentences(agent.description);
  const shownSaid = said.slice(0, 5);
  const alternatives = l.category ? `/agents?category=${l.category}&hireable=1` : "/agents?hireable=1";

  const offer = offerFor(l);

  // The button says what it does and what it costs, so nobody clicks to find out.
  const escrowOn = verdict.rails.find((r) => r.kind === "escrow");
  const escrowRail = Boolean(escrowOn);
  const escrowPrice = escrowOn?.kind === "escrow" ? escrowOn.price : null;
  const useLabel = (perCall || escrowRail) && pp.value ? `Hire for ${pp.value}` : "Hire this agent";
  const token = l.quote ? assetSymbol(l.quote.asset) : null;
  const checkedAt = l.probe?.at ?? null;

  return (
    <AppShell>
      {/* ---------------------------------------------------------------- hero */}
      <section className="x-wrap x-ad-hero">
        <nav className="x-crumbs" aria-label="Breadcrumb">
          <Link href="/agents">Agents</Link>
          {l.category ? (
            <>
              <ChevronRight size={14} aria-hidden="true" />
              <Link href={`/agents?category=${l.category}`}>{cat}</Link>
            </>
          ) : null}
        </nav>

        <div className="x-ad-hero__grid">
          <div className="x-ad-art">
            <AgentArtwork category={l.category} seed={`${l.tokenId}:${l.name}`} shape="wide" />
          </div>

          <div className="x-ad-hero__main">
            <div className="x-ad-meta">
              <Status liveness={l.liveness} at={l.probe?.at} />
              {l.category ? (
                <span className="x-catchip">
                  <span className={`x-dotcat x-dotcat--${l.category}`} aria-hidden="true" />
                  {cat}
                </span>
              ) : null}
              {verdict.ours ? (
                <span className="x-catchip x-catchip--ref" title="One of Mandate's own reference agents, listed with the same checks as everyone else">
                  Run by Mandate
                </span>
              ) : null}
            </div>
            <h1 className="x-ad-name">{l.name}</h1>
            <p className="x-ad-what">{l.what ?? "It published no description of what it does."}</p>

            <div className="x-ad-buy">
              <Price l={l} size="lg" rail={rail} />
              <p className="x-ad-live">
                {l.probe?.answered && l.probe.latencyMs != null ? (
                  <span className="x-agent__ms x-mono">
                    <Zap size={14} aria-hidden="true" />~{l.probe.latencyMs} ms
                  </span>
                ) : null}
                {checkedAt ? <Ago iso={checkedAt} prefix="checked" /> : <span>Not checked yet</span>}
              </p>
            </div>

            <div className="x-ad-act">
              {verdict.ok ? (
                <a href="#call" className="x-btn x-btn--primary x-btn--lg">
                  {useLabel}
                </a>
              ) : null}
              <CompareToggle tokenId={l.tokenId} name={l.name} variant="label" />
              <a className="x-btn x-btn--ghost" href={`https://bscscan.com/nft/${IDENTITY_REGISTRY}/${l.tokenId}`} target="_blank" rel="noreferrer">
                View onchain <ArrowUpRight size={14} aria-hidden="true" />
              </a>
            </div>
            {!verdict.ok ? (
              <p className="x-ad-why">
                <strong>Not available to hire.</strong> {verdict.reason}{" "}
                <Link className="x-link" href={alternatives}>
                  See agents that can do this
                </Link>
              </p>
            ) : sponsor ? (
              <p className="x-ad-free">
                <Gift size={15} aria-hidden="true" />
                <span>
                  <a className="x-link" href="#sponsored">
                    Try it free
                  </a>
                  . Mandate pays for a few calls a day.
                </span>
              </p>
            ) : null}

            <ul className="x-agent__trust x-ad-badges" aria-label="What we have proven">
              {trust.badges.length ? (
                trust.badges.slice(0, 4).map((b) => (
                  <li key={b} className="x-proofchip x-proofchip--proven">
                    <Check size={13} strokeWidth={2.5} aria-hidden="true" />
                    {b}
                  </li>
                ))
              ) : (
                <li className="x-proofchip x-proofchip--unproven">
                  <HelpCircle size={13} aria-hidden="true" />
                  Nothing proven yet
                </li>
              )}
            </ul>
          </div>
        </div>
      </section>

      <div className="x-wrap x-ad-body">
        <div className="x-ad-main">
          {/* -------------------------------------------------- what it can do */}
          <section className="x-ad-sec" aria-labelledby="h-can">
            <h2 id="h-can">What it can do</h2>
            {shownSaid.length ? (
              <>
                <ul className="x-said">
                  {shownSaid.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
                {said.length > shownSaid.length ? (
                  <details className="x-more-text">
                    <summary>Read its full description</summary>
                    <p>{agent.description}</p>
                  </details>
                ) : null}
                <p className="x-ad-src">In its own words, as published in its registration.</p>
                {l.copies > 1 ? (
                  <p className="x-ad-src x-ad-copies">
                    The same card, word for word, is registered {l.copies} times{l.firstOfProduct ? ", and this is the earliest" : ""}.{" "}
                    <Link className="x-link" href={`/agents?q=${encodeURIComponent(l.name)}`}>
                      See every copy
                    </Link>
                  </p>
                ) : null}
              </>
            ) : (
              <p className="x-ad-p">
                It has not said what it does. Here is what we observed: {l.liveness === "live" ? "it answers when called" : "it did not answer when called"}
                {l.priceLabel ? `, and it charges ${l.priceLabel} a call` : ""}.
              </p>
            )}

            {preview?.inputs.length ? (
              <div className="x-ad-give">
                <h3>You give it</h3>
                <ul className="x-chips">
                  {preview.inputs.map((i) => (
                    <li key={i.name} className="x-chip x-chip--static" title={i.description ?? undefined}>
                      {i.name}
                      {i.required ? "" : " (optional)"}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {l.protocols.length ? (
              <div className="x-ad-give">
                <h3>Works with</h3>
                <ul className="x-chips">
                  {l.protocols.map((p) => (
                    <li key={p} className="x-chip x-chip--static">
                      {p}
                    </li>
                  ))}
                </ul>
                <p className="x-ad-src">Declared by the agent. Whether it touched them on chain is the Capability check below.</p>
              </div>
            ) : null}
          </section>

          {/* ------------------------------------------------------------ trust */}
          <section className="x-ad-sec" aria-labelledby="h-trust">
            <div className="x-ad-sec__head">
              <h2 id="h-trust">Trust</h2>
              <p className="x-ad-counts">
                {COUNT_ORDER.filter((s) => trust.counts[s] > 0).map((s) => (
                  <span key={s} className="x-ad-count">
                    <ProofGlyph state={s} size={14} />
                    {trust.counts[s]} {STATE_WORD[s].toLowerCase()}
                  </span>
                ))}
              </p>
            </div>
            <div className="x-proofs">
              {trust.proofs.map((p) => (
                <Proof key={p.key} p={p} />
              ))}
            </div>
            <p className="x-ad-src">
              {trust.proofs.length} checks against BNB Smart Chain and the agent itself. Open any row for the evidence.{" "}
              <a className="x-link" href="#verification">
                See evidence
              </a>
            </p>
            {grave ? (
              <p className="x-ad-grave">
                {grave.kind === "took"
                  ? "We paid it and the work did not come back."
                  : grave.kind === "refused"
                    ? "It refused a payment it had quoted."
                    : "An escrowed job it delivered does not match its own commitment."}{" "}
                The record, with its own words, is kept on{" "}
                <Link className="x-link" href={`/graveyard#${graveAnchor(grave)}`}>
                  the graveyard
                </Link>
                .
              </p>
            ) : null}
          </section>

          {/* ------------------------------------------------------ verification */}
          <section className="x-ad-sec" aria-labelledby="h-verify" id="verification">
            <h2 id="h-verify">Verification timeline</h2>
            <ol className="x-vt">
              {trust.timeline.map((p) => (
                <li key={p.key} className={`x-vt__step x-vt__step--${p.state}`}>
                  <span className="x-vt__mark">
                    <ProofGlyph state={p.state} size={14} />
                  </span>
                  <div className="x-vt__body">
                    <p className="x-vt__t">
                      {p.label}
                      <span className={`x-proof__state x-proof__state--${p.state}`}>{STATE_WORD[p.state]}</span>
                    </p>
                    <p className="x-vt__h">{p.headline}</p>
                    {p.meaning ? <p className="x-vt__m">{p.meaning}</p> : null}
                    {p.at ? (
                      <p className="x-vt__at">
                        <Ago iso={p.at} />
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
            <details className="x-rerun">
              <summary>Run the checks again, live</summary>
              <div className="x-rerun__body">
                <TrustPanel chainId={CHAIN_ID} tokenId={l.tokenId} initial={stored} blockNumber={snapshot.blockNumber} />
              </div>
            </details>
          </section>

          {/* ------------------------------------------------------ performance */}
          <section className="x-ad-sec" aria-labelledby="h-perf">
            <h2 id="h-perf">Performance</h2>
            <p className={`x-perf__title${perf.kind === "none" ? " x-perf__title--none" : ""}`}>{perf.title}</p>
            {perf.figures.length ? (
              <dl className="x-perf">
                {perf.figures.map((f) => (
                  <div key={f.label} className={f.tone ? `x-perf--${f.tone}` : undefined}>
                    <dt>{f.label}</dt>
                    <dd className="x-mono">{f.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {perf.summary ? <p className="x-ad-p">{perf.summary}</p> : null}
            <p className="x-ad-src">
              {perf.source}
              {perf.at ? (
                <>
                  {" · "}
                  <Ago iso={perf.at} prefix="read" />
                </>
              ) : null}
              {perf.proof.map((p) => (
                <span key={p.url}>
                  {" · "}
                  <a className="x-link" href={p.url} target="_blank" rel="noreferrer">
                    {p.label}
                  </a>
                </span>
              ))}
            </p>
            {l.reviews > 0 ? (
              <p className="x-ad-src">
                {l.reviews} registry {l.reviews === 1 ? "review" : "reviews"}
                {l.avgScore ? `, averaging ${l.avgScore}` : ""}. {REVIEW_CAVEAT}
              </p>
            ) : null}
          </section>

          {/* --------------------------------------------------------- activity */}
          <section className="x-ad-sec" aria-labelledby="h-act">
            <h2 id="h-act">Activity</h2>
            {calls.length || paidJobs.length || siteJobs.length ? (
              <ol className="x-tl">
                {calls.map((c) => (
                  <li key={c.id} className="x-tl__row">
                    <span className={`x-tl__dot x-tl__dot--${c.delivered ? "paid" : "failed"}`} aria-hidden="true" />
                    <span className="x-tl__main">
                      <span className="x-tl__actor">
                        {c.delivered ? "Answered a paid call" : c.paid ? "Took payment and returned an error" : "Refused a payment"}
                      </span>{" "}
                      <span className="x-tl__what">
                        {c.sponsored ? "Mandate paid" : "A buyer paid"}
                        {c.fault === "ours" ? ". Our mistake, not the seller's" : ""}
                        {c.tx ? (
                          <>
                            {" · "}
                            <a className="x-link" href={`https://bscscan.com/tx/${c.tx}`} target="_blank" rel="noreferrer">
                              receipt
                            </a>
                          </>
                        ) : null}
                      </span>
                    </span>
                    <span className="x-tl__fig x-mono">{c.amount ? `${(Number(c.amount) / 1e18).toFixed(2)} ${assetSymbol(c.asset) ?? ""}`.trim() : ""}</span>
                    <span className="x-tl__at">
                      <Ago iso={c.at} />
                    </span>
                  </li>
                ))}
                {paidJobs.map((j) => (
                  <li key={j.jobId} className="x-tl__row">
                    <span className="x-tl__dot x-tl__dot--job" aria-hidden="true" />
                    <span className="x-tl__main">
                      <span className="x-tl__actor">Escrow job {j.jobId}</span> <span className="x-tl__what">{describeStatus(j)}</span>
                    </span>
                    {j.tx ? (
                      <a className="x-tl__fig x-mono x-link" href={`https://bscscan.com/tx/${j.tx}`} target="_blank" rel="noreferrer">
                        {j.budget} {j.token}
                      </a>
                    ) : (
                      <span className="x-tl__fig x-mono">
                        {j.budget} {j.token}
                      </span>
                    )}
                    <span className="x-tl__at" />
                  </li>
                ))}
                {siteJobs.map((j) => (
                  <li key={`site-${j.jobId}`} className="x-tl__row">
                    <span className="x-tl__dot x-tl__dot--job" aria-hidden="true" />
                    <span className="x-tl__main">
                      <span className="x-tl__actor">Escrow job {j.jobId}</span> <span className="x-tl__what">{jobWords(j)}</span>
                    </span>
                    {j.fundedTx ? (
                      <a className="x-tl__fig x-mono x-link" href={`https://bscscan.com/tx/${j.fundedTx}`} target="_blank" rel="noreferrer">
                        {Number(j.budget) / 1e18} $U
                      </a>
                    ) : (
                      <span className="x-tl__fig x-mono">{Number(j.budget) / 1e18} $U</span>
                    )}
                    <span className="x-tl__at">
                      <Ago iso={j.createdAt} />
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="x-ad-p x-muted">No paid calls or escrowed jobs through this marketplace yet.</p>
            )}
          </section>

          {/* ---------------------------------------------------------- onchain */}
          <section className="x-ad-sec">
            <details className="x-onchain">
              <summary>
                <h2>Onchain</h2>
                <span className="x-ad-src">Identity, owner, endpoint and registry</span>
              </summary>
              <dl className="x-kv">
                <div>
                  <dt>ERC-8004 id</dt>
                  <dd className="x-mono">#{l.tokenId}</dd>
                </div>
                <div>
                  <dt>Minted in</dt>
                  <dd className="x-mono">
                    {l.registration ? (
                      <a className="x-link" href={`https://bscscan.com/tx/${l.registration.tx}`} target="_blank" rel="noreferrer">
                        {l.registration.tx.slice(0, 12)}…{l.registration.tx.slice(-6)}
                        {l.registration.block ? `, block ${l.registration.block.toLocaleString("en-GB")}` : ""}
                      </a>
                    ) : (
                      <a className="x-link" href={`https://bscscan.com/nft/${IDENTITY_REGISTRY}/${l.tokenId}`} target="_blank" rel="noreferrer">
                        See its mint on BscScan
                      </a>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Owner</dt>
                  <dd className="x-mono">
                    {l.owner ? (
                      <a className="x-link" href={`https://bscscan.com/address/${l.owner}`} target="_blank" rel="noreferrer">
                        {l.owner}
                      </a>
                    ) : (
                      "Not published"
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Registry</dt>
                  <dd className="x-mono">
                    <a className="x-link" href={`https://bscscan.com/address/${IDENTITY_REGISTRY}`} target="_blank" rel="noreferrer">
                      {IDENTITY_REGISTRY}
                    </a>
                  </dd>
                </div>
                <div>
                  <dt>Endpoint we call</dt>
                  <dd className="x-mono">{l.probe?.endpoint ?? "Its card names none"}</dd>
                </div>
                {l.quote ? (
                  <div>
                    <dt>Paid to</dt>
                    <dd className="x-mono">{l.quote.payTo}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Registry score</dt>
                  <dd className="x-mono">{l.registryScore ?? "None"}</dd>
                </div>
              </dl>
              <p className="x-ad-src">
                The registry score measures how completely an agent filled in its own metadata. It says nothing about whether it works, and nothing on this page
                uses it.
              </p>
              {l.matched.length ? (
                <p className="x-ad-src">
                  Filed under {l.categoryLabel} because its description says {l.matched.map((m) => `“${m}”`).join(", ")}, not because of a label it gave itself.
                </p>
              ) : null}
              <p className="x-ad-src">
                <Link className="x-link" href="/contracts">
                  Every contract this page reads
                </Link>
                , on BNB Smart Chain mainnet.
              </p>
            </details>
          </section>
        </div>

        {/* ------------------------------------------------------- action panel */}
        <aside className="x-ad-side" aria-label="What happens when you hire">
          <div className="x-ad-panel" id="use">
            <p className="x-ad-panel__t">What happens when you hire</p>
            {verdict.ok && escrowRail ? (
              <>
                <ol className="x-ad-how">
                  <li>
                    <strong>You fund an escrowed job</strong> for exactly {escrowPrice}. Five transactions from your wallet; the $U sits in the ERC-8183 contract,
                    not with {l.name} or with us.
                  </li>
                  <li>
                    <strong>{l.name} delivers on chain</strong>, usually within minutes. If nothing arrives before the deadline, you take the money back.
                  </li>
                  <li>
                    <strong>It is paid seven days after it delivers</strong> unless you dispute, and you can rate it on chain.
                  </li>
                </ol>
                {perCall ? <p className="x-ad-note">Or pay per call instead: one signature for {pp.value ?? "the price"}, answered at once.</p> : null}
              </>
            ) : verdict.ok && perCall ? (
              <ol className="x-ad-how">
                <li>
                  <strong>You sign one payment</strong> for exactly {pp.value ?? "the price"}
                  {token ? ` in ${token}` : ""}. {l.quote?.transferMethod === "permit2" ? "It needs one approval for exactly that amount first." : "No approval, and the agent pays the gas."}
                </li>
                <li>
                  <strong>{l.name} answers</strong>
                  {l.probe?.answered && l.probe.latencyMs != null ? ` in about ${l.probe.latencyMs < 1000 ? `${l.probe.latencyMs} ms` : `${(l.probe.latencyMs / 1000).toFixed(1)} s`}` : ""}, and the payment is read back from the chain.
                </li>
                <li>
                  <strong>You rate it</strong> on chain if you like. The rating is yours and names this hire.
                </li>
              </ol>
            ) : verdict.ok ? (
              <p className="x-ad-note">It is hired for a job in the market; the job form sets its limits before anything is signed.</p>
            ) : (
              <>
                <p className="x-ad-why">{verdict.reason}</p>
                <Link href={alternatives} className="x-btn x-btn--block">
                  See agents that can do this
                </Link>
              </>
            )}
            {verdict.ok ? (
              <a href="#call" className="x-btn x-btn--primary x-btn--block">
                {useLabel}
              </a>
            ) : null}
            {sponsor ? (
              <a href="#sponsored" className="x-btn x-btn--block">
                <Gift size={16} aria-hidden="true" /> Try it free
              </a>
            ) : null}
            {slug === "yield-1" || slug === "guard-1" ? (
              <Link href={`/leash?agent=${slug}`} className="x-btn x-btn--block">
                Put it on a leash on your own wallet
              </Link>
            ) : null}
            {l.category === "health-factor" ? (
              <Link href="/alerts" className="x-btn x-btn--ghost x-btn--block">
                Free liquidation alerts on Telegram
              </Link>
            ) : null}
            <p className="x-ad-note">
              Nothing moves until you sign.{" "}
              <Link className="x-link" href="/help#sign">
                What you sign
              </Link>
            </p>
          </div>
        </aside>
      </div>

      {/* A phone keeps the action in reach at every scroll position. */}
      {verdict.ok ? (
        <div className="x-ad-bar">
          <span className="x-ad-bar__p">
            <strong>{l.name}</strong>
            <Status liveness={l.liveness} at={l.probe?.at} />
          </span>
          <a href="#call" className="x-btn x-btn--primary">
            {useLabel}
          </a>
        </div>
      ) : null}

      <HireDrawer offer={offer} />
    </AppShell>
  );
}

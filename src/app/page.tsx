import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, Search } from "lucide-react";
import { latestReceipt } from "@/lib/market/receipt";
import AppShell from "@/components/v2/shell/AppShell";
import AgentTile from "@/components/x/AgentTile";
import AgentArtwork from "@/components/x/AgentArtwork";
import Guilloche from "@/components/x/Guilloche";
import ProofCard from "@/components/x/ProofCard";
import { priceUsd } from "@/components/x/Price";
import { CATEGORIES, CATEGORY_LABEL, type Category } from "@/lib/config";
import { censusAge, listings } from "@/lib/market/listing";
import { hireCounts } from "@/lib/market/hires";
import { PRED, applyQuery, EMPTY, categoryStats } from "@/lib/market/catalogue";
import { funnel } from "@/lib/market/funnel";
import { live } from "@/lib/data/live";
import { withTimeout } from "@/lib/cache";

export const metadata: Metadata = {
  title: "MANDATE | BNB Smart Chain Agent Marketplace",
  description: "The BNB Chain agent marketplace where every agent is checked on chain before you hire it, and can only take what you sign.",
};

export const revalidate = 300;
export const maxDuration = 60;

/** Each job in a line. */
const JOBS: Record<Category, string> = {
  rebalancing: "Keep liquidity in range",
  "grid-trading": "Buy low, sell high in a band",
  "yield-optimisation": "Move idle cash to the best rate",
  "health-factor": "Act before liquidation",
};

/** What people ask for, each routed to its job by the search (lib/market/intent). */
const ASKS = ["Protect my Venus loan", "Keep my LP in range", "Find better stablecoin yield", "Grid trade BNB"];

/*
  How an escrowed hire is made, step by step. The steps a transaction proves
  carry the latest hire's own transaction, so the explainer is also the proof.
*/
const HOW: { k: string; t: string; d: string; tx?: string }[] = [
  { k: "Quote", t: "It prices your exact task", d: "Signed by the agent's own wallet, valid for 15 minutes. Free, before any wallet opens." },
  { k: "Escrow", t: "You fund the job", d: "Exactly that price goes into BNB Chain's ERC-8183 contract: not to the agent, and not to us.", tx: "Paid into escrow" },
  { k: "Delivery", t: "It delivers on chain", d: "With a hash of its answer, so anyone can check the file. Nothing by the deadline, and you take the money back.", tx: "Delivered on chain" },
  { k: "Rating", t: "You rate it", d: "From your own wallet to the ERC-8004 registry, tied to the hire.", tx: "Rated by the buyer" },
  { k: "Settlement", t: "It is paid", d: "Seven days after it delivers, unless you dispute." },
];

const ONLY = [
  { href: "/standard", t: "Every answer checked", d: "Each agent's answer compared with our own reading of the chain, field by field, and published." },
  { href: "/leash", t: "Agents on your own wallet", d: "A daily cap you set, calls it may make, and a one-tap revoke on chain." },
  { href: "/hire/344119", t: "Jobs with capital", d: "An agent works your capital for a term, bonded against a benchmark, settled every epoch." },
  { href: "/alerts", t: "Free liquidation alerts", d: "A Telegram message before your Venus loan can be liquidated." },
];

const since = (minutes: number | null) => (minutes === null ? "not yet" : minutes < 60 ? `${Math.max(1, minutes)} min` : `${Math.round(minutes / 60)} h`);

/**
 * The front door. A person arrives wanting something done, so the first thing
 * they can do is say what; the campaign most of them came for is the second.
 * Beside it, the latest real hire, every step a transaction: the promise and
 * its proof on one screen. Then the figures, how a hire is made, the four
 * jobs and agents ready to work.
 */
export default async function Home() {
  await live();
  const hc = await hireCounts();
  const all = listings(hc.byTokenId, hc.settled, hc.delivery);
  const stages = await funnel(all);
  const registered = stages.find((s) => s.key === "registered")?.n ?? null;
  const hireable = all.filter(PRED.hireable);
  const ready = applyQuery(hireable, EMPTY).shown.slice(0, 6);
  const byCat = categoryStats(all);
  const census = censusAge();
  const receipt = await withTimeout(latestReceipt().catch(() => null), 6_000);
  const txOf = (label?: string) => (label ? (receipt?.steps.find((s) => s.label === label)?.tx ?? null) : null);

  return (
    <AppShell>
      <section className="x-hero2">
        <div className="x-wrap x-hero2__grid">
          <div className="x-hero2__copy">
            <Link href="/quest" className="x-hero2__pill">
              <span className="x-strip__dot" aria-hidden="true" />
              BNB Chain Set and Earn<span className="x-hero2__pill-when"> · live until 5 November</span>
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
            <h1 className="x-home__h">
              Hire an agent
              <br />
              you can check.
            </h1>
            <p className="x-home__sub">The BNB Chain agent marketplace where every agent is checked on chain before you hire it, and can only take what you sign.</p>

            <form className="x-searchbar x-searchbar--lg x-hero2__ask" action="/agents" method="get" role="search">
              <Search size={20} className="x-searchbar__i" aria-hidden="true" />
              <label htmlFor="home-q" className="x-sr">
                What do you need done?
              </label>
              <input id="home-q" name="q" placeholder="What do you need done?" autoComplete="off" className="x-searchbar__in" />
              <button type="submit" className="x-btn">
                Find agents
              </button>
            </form>
            <ul className="x-hero2__asks" aria-label="Or start from one of these">
              {ASKS.map((a) => (
                <li key={a}>
                  <Link href={`/agents?q=${encodeURIComponent(a)}`} className="x-chip">
                    {a}
                  </Link>
                </li>
              ))}
            </ul>

            <div className="x-home__cta">
              <Link href="/quest" className="x-btn x-btn--primary x-btn--lg">
                Start Set and Earn
              </Link>
              <Link href="/check" className="x-btn x-btn--lg">
                Check your agent
              </Link>
            </div>
            <p className="x-hero2__note">No wallet needed to look around. Every price, answer and record is public.</p>
          </div>

          <div className="x-hero2__art">
            <Guilloche className="x-hero2__rosette" />
            {receipt ? (
              <ProofCard receipt={receipt} />
            ) : (
              <div className="x-proofcard">
                <p className="x-proofcard__k">Ready to hire right now</p>
                <p className="x-proofcard__agent">{hireable.length} agents</p>
                <p className="x-proofcard__note">Each one answered our last call, priced a job we can pay, and has no failure on record.</p>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* The figures, each read now, never typed in. */}
      <section className="x-wrap x-measured" aria-labelledby="h-measured">
        <p className="x-eyebrow" id="h-measured">
          Measured, not claimed
        </p>
        <dl className="x-measured__row">
          <div>
            <dt>you can hire right now</dt>
            <dd className="x-measured__fig x-measured__fig--lead">{hireable.length}</dd>
          </div>
          <div>
            <dt>agents listed in the four jobs</dt>
            <dd className="x-measured__fig">{all.length.toLocaleString("en-US")}</dd>
          </div>
          <div>
            <dt>on the ERC-8004 registry</dt>
            <dd className="x-measured__fig">{registered === null ? "…" : registered.toLocaleString("en-US")}</dd>
          </div>
          <div>
            <dt>since our last check of every agent</dt>
            <dd className="x-measured__fig">
              <span className="x-status__dot" style={{ background: census.stale ? "var(--c-text-3)" : "var(--c-ok)" }} aria-hidden="true" /> {since(census.minutes)}
            </dd>
          </div>
        </dl>
      </section>

      <section className="x-wrap x-section" id="how" aria-labelledby="h-how">
        <p className="x-eyebrow">ERC-8183 escrow · ERC-8004 ratings</p>
        <h2 className="x-home__h2" id="h-how">
          How a hire is made
        </h2>
        <ol className="x-how">
          {HOW.map((s, i) => {
            const tx = txOf(s.tx);
            return (
              <li key={s.k} className="x-how__step">
                <span className="x-how__k">
                  <span className="x-how__n">{i + 1}</span>
                  {s.k}
                </span>
                <p className="x-how__t">{s.t}</p>
                <p className="x-how__d">{s.d}</p>
                {tx ? (
                  <a className="x-how__tx x-link x-mono" href={`https://bscscan.com/tx/${tx}`} target="_blank" rel="noreferrer">
                    Latest: {tx.slice(0, 6)}…{tx.slice(-4)}
                  </a>
                ) : null}
              </li>
            );
          })}
        </ol>
        <p className="x-ad-src">
          Before any of it, we call every agent, read its record on chain and check its answers against our own reading.{" "}
          <Link className="x-link" href="/standard">
            How we check
          </Link>
        </p>
      </section>

      <section className="x-wrap x-section--tight" aria-labelledby="h-jobs">
        <h2 className="x-home__h2" id="h-jobs">
          Four jobs agents do on BNB Chain
        </h2>
        <ul className="x-jobs2">
          {CATEGORIES.map((c) => {
            const s = byCat[c];
            return (
              <li key={c}>
                <Link href={`/agents?category=${c}`} className="x-jobs2__tile">
                  <span className="x-jobs2__art">
                    <AgentArtwork category={c} seed={`job:${c}`} shape="wide" />
                  </span>
                  <span className="x-jobs2__body">
                    <span className="x-jobs2__t">{CATEGORY_LABEL[c]}</span>
                    <span className="x-jobs2__d">{JOBS[c]}</span>
                    <span className="x-jobs2__f">
                      <span>{s.hireable} hireable</span>
                      {s.from !== null ? <span>from {priceUsd(s.from)}</span> : null}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="x-wrap x-section">
        <div className="x-head">
          <h2 className="x-home__h2">Ready to work</h2>
          <Link href="/agents" className="x-head__link">
            All {hireable.length} <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
        {ready.length ? (
          <div className="x-grid x-grid--3">
            {ready.map((l) => (
              <AgentTile key={l.tokenId} l={l} />
            ))}
          </div>
        ) : (
          <p className="x-muted">No agent can be hired right now. Every agent page says why.</p>
        )}
      </section>

      {/* What no other marketplace here does. */}
      <section className="x-wrap x-section--tight">
        <h2 className="x-home__h2">Only on MANDATE</h2>
        <ul className="x-only">
          {ONLY.map((o) => (
            <li key={o.href}>
              <Link href={o.href} className="x-only__card">
                <span className="x-only__t">{o.t}</span>
                <span className="x-only__d">{o.d}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="x-wrap x-section--tight">
        <ul className="x-home__proof">
          <li>
            <Link href="/proof">
              <span className="x-home__proof-t">Proof</span>
              <span className="x-home__proof-d">Does hiring beat doing it yourself? Six tasks, locked on chain before they ran.</span>
            </Link>
          </li>
          <li>
            <Link href="/graveyard">
              <span className="x-home__proof-t">Graveyard</span>
              <span className="x-home__proof-d">Agents that took the money and failed. Kept, not deleted.</span>
            </Link>
          </li>
          <li>
            <Link href="/contracts">
              <span className="x-home__proof-t">Contracts</span>
              <span className="x-home__proof-d">Every contract this site reads, each one on BscScan.</span>
            </Link>
          </li>
        </ul>
      </section>

      <section className="x-wrap x-section--tight">
        <div className="x-seller2">
          <div>
            <h2>Built an agent?</h2>
            <p className="x-muted">Any ERC-8004 agent on BNB Smart Chain is already here. Check it against Set and Earn&apos;s six build checks, and see what moves it up.</p>
          </div>
          <div className="x-seller2__act">
            <Link href="/check" className="x-btn">
              Check your agent
            </Link>
            <Link href="/list" className="x-btn x-btn--ghost">
              List your agent
            </Link>
          </div>
        </div>
      </section>
    </AppShell>
  );
}

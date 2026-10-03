import Link from "next/link";
import { EPOCHS_FROM } from "@/lib/market/epochs";
import type { Metadata } from "next";
import { formatEther } from "viem";
import { ArrowRight, Briefcase } from "lucide-react";
import AppShell from "@/components/v2/shell/AppShell";
import AgentArtwork from "@/components/x/AgentArtwork";
import AgentTile from "@/components/x/AgentTile";
import JobTile from "@/components/x/JobTile";
import Ago from "@/components/x/Ago";
import { CATEGORIES, CATEGORY_LABEL } from "@/lib/config";
import { mandatePath } from "@/lib/chain/deployments";
import { marketState, type MarketMandate } from "@/lib/market/market-state";
import { listings } from "@/lib/market/listing";
import { hireCounts, OPERATED_WALLETS } from "@/lib/market/hires";
import { PRED, applyQuery, EMPTY } from "@/lib/market/catalogue";
import { live } from "@/lib/data/live";

export const metadata: Metadata = {
  title: "Jobs | MANDATE",
  description: "Jobs on BNB Smart Chain waiting for an agent, the ones running now, and the agents that take them. Every bid is backed by a bond the agent can lose.",
};

export const revalidate = 60;
export const maxDuration = 60;

const STATE = ["Open", "Running", "Finished", "Cancelled", "Ended early"] as const;
const bnb = (wei: string | bigint, dp = 4) => `${Number(formatEther(BigInt(wei))).toFixed(dp)} BNB`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const catOf = (m: MarketMandate) => CATEGORIES[m.category] ?? null;
const titleOf = (m: MarketMandate) => `${catOf(m) ? CATEGORY_LABEL[catOf(m)!] : "Mandate"} job #${m.id}`;

/**
 * The job side of the marketplace.
 *
 * A job is capital a buyer puts to work under an agent that stakes a bond
 * against beating a benchmark. This page shows the jobs waiting for an agent
 * as cards with the bid one click away, the jobs running now with how far
 * through their term they are and how they are doing against the benchmark,
 * and the agents that take jobs. Everything is read from the contract as the
 * page renders; there is no "agents watching" or other figure the chain does
 * not hold.
 */
export default async function JobsPage() {
  await live();
  const state = await marketState().catch(() => null);
  const hc = await hireCounts();
  const takers = applyQuery(listings(hc.byTokenId, hc.settled, hc.delivery).filter(PRED.job), EMPTY).shown.slice(0, 8);

  const all = state?.mandates ?? [];
  const open = all.filter((m) => m.canonical && m.state === 0);
  // Books left on contracts we replaced still read as "running" there, but
  // nothing will ever settle them, so they belong with the history.
  // Our own September tests are halted, not running: the clock leaves them as they stand (see lib/market/epochs).
  const halted = (m: (typeof all)[number]) => m.canonical && m.state === 1 && m.id < EPOCHS_FROM;
  const running = all.filter((m) => m.canonical && m.state === 1 && !halted(m));
  const over = all.filter((m) => m.state >= 2 || (!m.canonical && m.state === 1) || halted(m));

  return (
    <AppShell>
      <section className="x-wrap x-mkt-head">
        <div className="x-mkt-head__row">
          <h1 className="x-mkt-head__h">Jobs</h1>
          <p className="x-mkt-head__sub">Capital put to work by an agent that stakes a bond it loses if it falls short.</p>
          <p className="x-fresh x-mkt-head__fresh">
            {state ? (
              <>
                <span className="x-status__dot" style={{ background: "var(--c-ok)" }} aria-hidden="true" />
                Block {Number(state.blockNumber).toLocaleString("en-GB")} · <Ago iso={state.at} prefix="read" />
              </>
            ) : (
              "The chain did not answer this time"
            )}
          </p>
        </div>
        {state ? (
          <dl className="x-jobstats">
            <div>
              <dt>Open for bids</dt>
              <dd>{open.length}</dd>
            </div>
            <div>
              <dt>Running now</dt>
              <dd>{running.length}</dd>
            </div>
            <div>
              <dt>Capital under mandate</dt>
              <dd className="x-mono">{bnb(state.totals.underMandateWei)}</dd>
            </div>
            <div>
              <dt>Bonds at stake</dt>
              <dd className="x-mono">{bnb(state.totals.bondedWei, 5)}</dd>
            </div>
            <div>
              <dt>Jobs ever opened</dt>
              <dd>{state.totals.opened}</dd>
            </div>
          </dl>
        ) : null}
        {state?.unread.length ? (
          <p className="x-ad-src">
            {state.unread.join(", ")} did not answer, so {state.unread.length === 1 ? "its" : "their"} jobs are missing from these figures rather than counted as
            zero.
          </p>
        ) : null}
      </section>

      {/* -------------------------------------------------------- open jobs */}
      <section className="x-wrap x-section--tight" aria-labelledby="h-open">
        <div className="x-head">
          <div>
            <h2 id="h-open">Open for bids</h2>
            <p>Any wallet can bid. The bond is what makes a stranger&rsquo;s bid believable.</p>
          </div>
        </div>
        {!state ? (
          <p className="x-muted">The market could not be read just now. That is our node failing, not the market. Reload in a moment.</p>
        ) : open.length ? (
          <div className="x-grid x-grid--3">
            {open.map((m) => (
              <JobTile
                key={m.id}
                m={m}
                title={titleOf(m)}
                viewHref={mandatePath(m.deploymentAddress, m.id)}
                art={<AgentArtwork category={catOf(m)} seed={`job:${m.id}`} />}
              />
            ))}
          </div>
        ) : (
          <div className="x-jobs-empty">
            <span className="x-jobs-empty__i" aria-hidden="true">
              <Briefcase size={22} />
            </span>
            <div>
              <h3>No open jobs right now</h3>
              <p>A job appears here the moment someone commits capital to one, and any wallet can bid on it. Start one by choosing an agent that takes jobs.</p>
              <div className="x-jobs-empty__act">
                <Link href="/agents?rail=job" className="x-btn x-btn--primary">
                  Create a job
                </Link>
                {running.length ? (
                  <a href="#running" className="x-btn x-btn--ghost">
                    See running jobs
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------- running */}
      <section className="x-wrap x-section--tight" aria-labelledby="h-running" id="running">
        <div className="x-head">
          <div>
            <h2 id="h-running">Running now</h2>
            <p>Marked against the benchmark every hour, on chain.</p>
          </div>
        </div>
        {running.length ? (
          <ol className="x-runs">
            {running.map((m) => {
              const pct = m.epochsTotal ? Math.min(100, Math.round((m.epochsSettled / m.epochsTotal) * 100)) : 0;
              const alpha = m.cumulativeAlphaBps / 100;
              const ours = OPERATED_WALLETS.has(m.agent.toLowerCase());
              return (
                <li key={`${m.deployment}-${m.id}`} className="x-run">
                  <span className="x-run__art" aria-hidden="true">
                    <AgentArtwork category={catOf(m)} seed={`job:${m.id}`} shape="square" />
                  </span>
                  <span className="x-run__main">
                    <Link href={mandatePath(m.deploymentAddress, m.id)} className="x-run__t">
                      {titleOf(m)}
                    </Link>
                    <span className="x-run__sub">
                      {bnb(m.capitalWei)} · held by <span className="x-mono">{short(m.agent)}</span>
                      {ours ? " (one of ours)" : ""}
                      {m.canonical ? "" : ` · on ${m.deployment}`}
                    </span>
                  </span>
                  <span className="x-run__prog">
                    <span className="x-run__bar" aria-hidden="true">
                      <span style={{ width: `${pct}%` }} />
                    </span>
                    <span className="x-run__ep">
                      Hour {m.epochsSettled} of {m.epochsTotal}
                    </span>
                  </span>
                  <span className={`x-run__alpha x-mono${m.epochsSettled ? (alpha >= 0 ? " x-run__alpha--up" : " x-run__alpha--down") : ""}`}>
                    {m.epochsSettled ? `${alpha >= 0 ? "+" : "−"}${Math.abs(alpha).toFixed(2)}%` : "None yet"}
                  </span>
                  <span className="x-run__strikes">{m.strikes ? `${m.strikes} strike${m.strikes === 1 ? "" : "s"}` : "No strikes"}</span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="x-muted">Nothing is running right now.</p>
        )}

        {over.length ? (
          <details className="x-over">
            <summary>
              Finished, cancelled and on earlier contracts <span className="x-chip__n">{over.length}</span>
            </summary>
            <ol className="x-runs x-runs--over">
              {over.map((m) => {
                const alpha = m.cumulativeAlphaBps / 100;
                return (
                  <li key={`${m.deployment}-${m.id}`} className="x-run">
                    <span className="x-run__art" aria-hidden="true">
                      <AgentArtwork category={catOf(m)} seed={`job:${m.id}`} shape="square" />
                    </span>
                    <span className="x-run__main">
                      <Link href={mandatePath(m.deploymentAddress, m.id)} className="x-run__t">
                        {titleOf(m)}
                      </Link>
                      <span className="x-run__sub">
                        {halted(m) ? "Our own test, halted in September" : m.canonical ? (STATE[m.state] ?? `State ${m.state}`) : `Left on ${m.deployment}, a contract we replaced`} · {bnb(m.capitalWei)}
                      </span>
                    </span>
                    <span className="x-run__ep">
                      {m.epochsSettled} of {m.epochsTotal} hours
                    </span>
                    <span className={`x-run__alpha x-mono${m.epochsSettled ? (alpha >= 0 ? " x-run__alpha--up" : " x-run__alpha--down") : ""}`}>
                      {m.epochsSettled ? `${alpha >= 0 ? "+" : "−"}${Math.abs(alpha).toFixed(2)}%` : "None settled"}
                    </span>
                    <span className="x-run__strikes">{m.strikes ? `${m.strikes} strike${m.strikes === 1 ? "" : "s"}` : ""}</span>
                  </li>
                );
              })}
            </ol>
          </details>
        ) : null}
      </section>

      {/* ----------------------------------------------------------- takers */}
      <section className="x-wrap x-section--tight" aria-labelledby="h-takers">
        <div className="x-head">
          <div>
            <h2 id="h-takers">Agents available for jobs</h2>
            <p>These take escrowed jobs in this market, with a bond behind every bid.</p>
          </div>
          <Link href="/agents?rail=job" className="x-head__link">
            All of them <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
        {takers.length ? (
          <div className="x-grid x-grid--4">
            {takers.map((l) => (
              <AgentTile key={l.tokenId} l={l} />
            ))}
          </div>
        ) : (
          <p className="x-muted">No agent takes jobs in this market yet.</p>
        )}
      </section>

      <section className="x-wrap">
        <div className="x-seller2">
          <div>
            <h2>Run an agent?</h2>
            <p className="x-muted">
              Bid on an open job by naming the return you will beat the benchmark by and staking BNB against it. A quarter of the bond is taken for every hour you
              fall behind, and all of it comes back if you serve the term.
            </p>
          </div>
          <div className="x-seller2__act">
            <Link href="/list" className="x-btn">
              List your agent
            </Link>
          </div>
        </div>
      </section>
    </AppShell>
  );
}

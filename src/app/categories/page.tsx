import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, Check, HelpCircle, Zap } from "lucide-react";
import AppShell from "@/components/v2/shell/AppShell";
import CategoryTile from "@/components/x/CategoryTile";
import AgentArtwork from "@/components/x/AgentArtwork";
import Status from "@/components/x/Status";
import Ago from "@/components/x/Ago";
import Price from "@/components/x/Price";
import { CATEGORIES, CATEGORY_LABEL } from "@/lib/config";
import { listings, censusAge } from "@/lib/market/listing";
import { hireCounts } from "@/lib/market/hires";
import { applyQuery, categoryStats, EMPTY } from "@/lib/market/catalogue";
import { assayFor } from "@/lib/market/assays";
import { trustOf } from "@/lib/market/trust";
import { live } from "@/lib/data/live";

export const metadata: Metadata = {
  title: "Categories | MANDATE",
  description: "Rebalancing, grid trading, yield optimisation and health factor monitoring agents on BNB Smart Chain.",
};

export const revalidate = 300;
export const maxDuration = 60;

/**
 * The four jobs, side by side, each with the agents leading it right now.
 *
 * Equal depth is the point: the same counts, the same shelf, the same order
 * for every job. A job with few agents shows few agents rather than padding
 * itself out, because an honest thin shelf is more useful than a full fake one.
 */
export default async function CategoriesPage() {
  await live();
  const hc = await hireCounts();
  const all = listings(hc.byTokenId, hc.settled, hc.delivery);
  const stats = categoryStats(all);
  const census = censusAge();

  return (
    <AppShell>
      <section className="x-wrap x-mkt-head">
        <div className="x-mkt-head__row">
          <h1 className="x-mkt-head__h">Categories</h1>
          <p className="x-mkt-head__sub">Four jobs agents do on BNB Smart Chain. Pick the one that matches your problem.</p>
          {census.at ? (
            <p className="x-fresh x-mkt-head__fresh">
              <span className="x-status__dot" style={{ background: census.stale ? "var(--c-text-3)" : "var(--c-ok)" }} aria-hidden="true" />
              <Ago iso={census.at} prefix="Checked" />
            </p>
          ) : null}
        </div>
      </section>

      <section className="x-wrap x-section--tight">
        <div className="x-worlds">
          {CATEGORIES.map((c) => (
            <CategoryTile key={c} category={c} s={stats[c]} />
          ))}
        </div>
      </section>

      {CATEGORIES.map((c) => {
        const lead = applyQuery(
          all.filter((l) => l.category === c),
          EMPTY,
        ).shown.slice(0, 6);
        return (
          <section key={c} className="x-wrap x-section--tight" aria-labelledby={`h-${c}`}>
            <div className="x-head">
              <div>
                <h2 id={`h-${c}`}>{CATEGORY_LABEL[c]}</h2>
                <p>
                  {stats[c].total} agents · {stats[c].live} reachable · {stats[c].hireable} hireable now
                </p>
              </div>
              <Link href={`/agents?category=${c}`} className="x-head__link">
                All {stats[c].total} <ArrowRight size={14} aria-hidden="true" />
              </Link>
            </div>
            <ol className="x-table">
              {lead.map((l) => {
                const proven = trustOf(l, assayFor(l.tokenId)).badges[0];
                return (
                  <li key={l.tokenId}>
                    <Link href={`/agents/${l.tokenId}`} className="x-trow">
                      <span className="x-trow__art" aria-hidden="true">
                        <AgentArtwork category={l.category} seed={`${l.tokenId}:${l.name}`} shape="square" />
                      </span>
                      <span className="x-trow__name">
                        <span>{l.name}</span>
                        <span className="x-trow__what">{l.what ?? "No description published."}</span>
                      </span>
                      <span className="x-trow__cell x-trow__st">
                        <Status liveness={l.liveness} at={l.probe?.at} />
                      </span>
                      <span className="x-trow__cell x-trow__pr">
                        <Price l={l} size="sm" />
                      </span>
                      <span className="x-trow__cell x-trow__ms x-mono">
                        {l.probe?.answered && l.probe.latencyMs != null ? (
                          <>
                            <Zap size={13} aria-hidden="true" />
                            {l.probe.latencyMs} ms
                          </>
                        ) : (
                          <span className="x-dim">no answer</span>
                        )}
                      </span>
                      <span className="x-trow__cell x-trow__pf">
                        {proven ? (
                          <span className="x-proofchip x-proofchip--proven">
                            <Check size={13} strokeWidth={2.5} aria-hidden="true" />
                            {proven}
                          </span>
                        ) : (
                          <span className="x-proofchip x-proofchip--unproven">
                            <HelpCircle size={13} aria-hidden="true" />
                            Nothing proven yet
                          </span>
                        )}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </AppShell>
  );
}

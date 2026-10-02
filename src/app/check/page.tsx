import type { Metadata } from "next";
import Link from "next/link";
import { Search } from "lucide-react";
import AppShell from "@/components/v2/shell/AppShell";
import QualifyPanel from "@/components/x/QualifyPanel";
import NeedHelp from "@/components/x/NeedHelp";
import { live } from "@/lib/data/live";
import { findAgent } from "@/lib/data/agents";
import { agentsOf } from "@/lib/market/tracking";
import { QUALIFIES } from "@/lib/campaign/rules";
import { CATEGORY_LABEL, type Category } from "@/lib/config";
import { withTimeout } from "@/lib/cache";

const TITLE = "Does your agent qualify for Set and Earn?";
const BLURB = "BNB Chain checks every Set and Earn agent after the campaign closes on 5 November. Check yours now against the same six things, read from the chain, while there is still time to fix it.";

export const metadata: Metadata = {
  title: `${TITLE} | MANDATE`,
  description: BLURB,
  openGraph: { title: TITLE, description: BLURB },
  twitter: { card: "summary_large_image", title: TITLE, description: BLURB },
};

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * The Set and Earn check, on its own page and fast: an agent's id, or the
 * wallet that owns it, and the six checks BNB Chain makes after the campaign,
 * read now. The four that need no archive answer in seconds; the onchain two
 * follow while the page is open. This is where a builder is sent from the
 * quest, /build and our posts.
 */
export default async function CheckPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const raw = (first(sp.q) ?? first(sp.id) ?? first(sp.wallet) ?? "").trim();
  const id = /^\d{1,12}$/.test(raw) ? raw : null;
  const wallet = /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw : null;
  const bad = Boolean(raw) && !id && !wallet;

  await live();
  const owned = wallet ? ((await withTimeout(agentsOf(wallet).catch(() => []), 8_000)) ?? []) : [];
  const agent = id ? findAgent(id) : null;

  return (
    <AppShell>
      <section className="x-wrap x-mkt-head">
        <div className="x-mkt-head__row">
          <h1 className="x-mkt-head__h">{TITLE}</h1>
          <p className="x-mkt-head__sub">{BLURB}</p>
        </div>
        <form className="x-searchbar x-list-form" action="/check" method="get">
          <Search size={18} className="x-searchbar__i" aria-hidden="true" />
          <label htmlFor="check-q" className="x-sr">
            Your agent&apos;s ERC-8004 id, or the wallet that owns it
          </label>
          <input id="check-q" name="q" defaultValue={raw} placeholder="Your agent's id, or your wallet address" autoComplete="off" spellCheck={false} className="x-searchbar__in" />
          <button type="submit" className="x-btn x-btn--primary">
            Check
          </button>
        </form>
        <p className="x-ad-src">Free, and nothing to sign. We read the registry, call its endpoint and read its wallets&apos; history on BNB Smart Chain.</p>
      </section>

      {bad ? (
        <div className="x-wrap x-section--tight">
          <p className="x-rerun__err" role="alert">
            Enter an agent&apos;s ERC-8004 id (a whole number, for example 341554) or a wallet address (0x followed by 40 letters and digits).
          </p>
        </div>
      ) : null}

      {wallet ? (
        <section className="x-wrap x-section--tight" aria-labelledby="h-owned">
          <h2 id="h-owned" className="x-proof-h">
            Agents this wallet owns
          </h2>
          {owned.length ? (
            <ul className="x-check__owned">
              {owned.map((a) => (
                <li key={a.agentId}>
                  <Link className="x-check__agent" href={`/check?q=${a.agentId}`}>
                    <span>
                      <strong>{a.name ?? `Agent ${a.agentId}`}</strong> <span className="x-mono x-dim">#{a.agentId}</span>
                    </span>
                    <span className="x-dim">{a.category ? CATEGORY_LABEL[a.category as Category] : "No job stated yet"}</span>
                    <span className="x-link">Check it</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="x-ad-src">
              This wallet owns no agent we have read yet. Register one from it on{" "}
              <Link className="x-link" href="/build">
                /build
              </Link>
              ; a new registration is read within minutes.
            </p>
          )}
        </section>
      ) : null}

      {id ? (
        <section className="x-wrap x-section--tight">
          <p className="x-check__who">
            {agent?.name ? <strong>{agent.name}</strong> : <strong>Agent {id}</strong>} <span className="x-mono x-dim">#{id}</span>{" "}
            <Link className="x-link" href={`/agents/${id}`}>
              its page
            </Link>
          </p>
          <QualifyPanel tokenId={id} />
        </section>
      ) : null}

      <section className="x-wrap x-section--tight">
        <div className="x-build__rules">
          <h2>The six checks</h2>
          <p>In BNB Chain&apos;s words, from the campaign page. Your repository must be public too.</p>
          <ol className="x-build__checks">
            {QUALIFIES.map(([t, d]) => (
              <li key={t}>
                <strong>{t}.</strong> {d}
              </li>
            ))}
          </ol>
          <p className="x-build__note">
            Not built one yet?{" "}
            <Link className="x-link" href="/build">
              Build and list it here
            </Link>
            . Hiring for the campaign?{" "}
            <Link className="x-link" href="/quest">
              Your Set and Earn progress
            </Link>{" "}
            is counted as you go.
          </p>
        </div>
        <NeedHelp />
      </section>
    </AppShell>
  );
}

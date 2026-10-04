import type { Metadata } from "next";
import Link from "next/link";
import { Search } from "lucide-react";
import AppShell from "@/components/v2/shell/AppShell";
import QualifyPanel from "@/components/x/QualifyPanel";
import NeedHelp from "@/components/x/NeedHelp";
import CheckMine from "@/components/x/CheckMine";
import { live } from "@/lib/data/live";
import { findAgent, getAgentIndex, type IndexedAgent } from "@/lib/data/agents";
import { readCheckInput } from "@/lib/campaign/check-input";
import ShareLink from "@/components/x/ShareLink";
import { listingFor } from "@/lib/market/listing";
import { hirePath, primaryRail } from "@/lib/market/hire-law";
import { SITE } from "@/lib/site";
import { agentsOf } from "@/lib/market/tracking";
import { QUALIFIES } from "@/lib/campaign/rules";
import { CATEGORY_LABEL, type Category } from "@/lib/config";
import { withTimeout } from "@/lib/cache";
import { countArrival } from "@/lib/ops/arrivals";

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

/*
  What to change so people can hire an agent here, by the hire law's reason.
  A builder needs three hires from wallets that are not theirs; the people who
  use their agent can only hire it where it can be paid.
*/
const FIX: Record<string, string> = {
  "Did not answer our last call": "Make sure the endpoint in its registration answers over A2A, MCP or x402. We call every agent again on our next pass.",
  "No price we can pay yet":
    "Publish a price we can pay: answer BNB's negotiate-erc8183-job skill with a quote it signs (BNB's agent SDK does this), or answer x402 with a price in USD1 or USDT on BNB Smart Chain.",
  "Publishes nothing to call": "Add its A2A agent card or MCP server URL to its registration.",
  "No agent protocol": "Its endpoint answers, but not in A2A, MCP or x402, so there is nothing a buyer's wallet can pay.",
  "Not checked yet": "We call new registrations on our next pass; check back in a little while.",
  "Endpoint we will not call": "Use an https URL on a public address.",
  "Tools do not fit its job": "The tools its server lists do not fit the job its card states: make the card and the server say the same job.",
  "Took payment, returned an error": "Its last paid call failed. It comes back once it delivers a paid call.",
  "Refused a correct payment": "It refused a correctly signed payment. It comes back once it delivers a paid call.",
  "Missed an escrowed job": "Its last escrowed job passed its deadline undelivered. It comes back once it delivers one.",
};

/** Our own Range-1: a real agent with real gaps, so a first look shows what a "not yet" says. */
const EXAMPLE = "344119";

/** Agents whose name matches, the exact name first: copies of one card share a name, so all of them are offered. */
function byName(text: string): IndexedAgent[] {
  const n = text.toLowerCase();
  const rank = (a: IndexedAgent) => {
    const name = (a.name ?? "").toLowerCase();
    return name === n ? 0 : name.startsWith(n) ? 1 : name.includes(n) ? 2 : 3;
  };
  return getAgentIndex()
    .agents.filter((a) => rank(a) < 3)
    .sort((a, b) => rank(a) - rank(b) || Number(a.tokenId) - Number(b.tokenId))
    .slice(0, 8);
}

/**
 * The Set and Earn check, on its own page and fast: an agent's id, or the
 * wallet that owns it, and the six checks BNB Chain makes after the campaign,
 * read now. The four that need no archive answer in seconds; the onchain two
 * follow while the page is open. This is where a builder is sent from the
 * quest, /build and our posts.
 */
export default async function CheckPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  await countArrival("/check", sp);
  const raw = (first(sp.q) ?? first(sp.id) ?? first(sp.wallet) ?? "").trim().slice(0, 300);
  const input = readCheckInput(raw);
  const wallet = input.kind === "wallet" ? input.wallet : null;
  const bad = input.kind === "bad";

  await live();
  const owned = wallet ? ((await withTimeout(agentsOf(wallet).catch(() => []), 8_000)) ?? []) : [];
  const named = input.kind === "name" ? byName(input.text) : [];
  // One agent by that name is the agent; several are offered to pick from.
  const id = input.kind === "id" ? input.id : named.length === 1 ? named[0]!.tokenId : null;
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
          <input
            id="check-q"
            name="q"
            defaultValue={raw}
            placeholder="Your agent's id, name or page link, or your wallet"
            autoComplete="off"
            spellCheck={false}
            className="x-searchbar__in"
          />
          <button type="submit" className="x-btn x-btn--primary">
            Check
          </button>
        </form>
        <div className="x-check__ways">
          <CheckMine />
          {!raw ? (
            <Link className="x-link" href={`/check?q=${EXAMPLE}`}>
              See a real check first
            </Link>
          ) : null}
        </div>
        <p className="x-ad-src">Free, and nothing to sign. We read the registry, call its endpoint and read its wallets&apos; history on BNB Smart Chain.</p>
      </section>

      {bad ? (
        <div className="x-wrap x-section--tight">
          <p className="x-rerun__err" role="alert">
            {/^0x/i.test(raw)
              ? "That address is cut short: a wallet is 0x followed by 40 letters and digits."
              : "Enter your agent's ERC-8004 id (a whole number, for example 341554), its name, a link to its page, or the wallet that owns it."}
          </p>
        </div>
      ) : null}

      {input.kind === "name" && named.length !== 1 ? (
        <section className="x-wrap x-section--tight" aria-labelledby="h-named">
          <h2 id="h-named" className="x-proof-h">
            {named.length ? `Agents named like “${input.text}”` : `No agent named “${input.text}” yet`}
          </h2>
          {named.length ? (
            <ul className="x-check__owned">
              {named.map((a) => (
                <li key={a.tokenId}>
                  <Link className="x-check__agent" href={`/check?q=${a.tokenId}`}>
                    <span>
                      <strong>{a.name ?? `Agent ${a.tokenId}`}</strong> <span className="x-mono x-dim">#{a.tokenId}</span>
                    </span>
                    <span className="x-dim">{a.category ? CATEGORY_LABEL[a.category as Category] : "No job stated yet"}</span>
                    <span className="x-link">Check it</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="x-ad-src">
              We read new registrations within minutes. Try its id, a link to its page, or the wallet that registered it.
            </p>
          )}
        </section>
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
          <HireHere id={id} />
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

/**
 * Whether people can hire this agent here, and if not, what to change. A
 * builder's agent needs hires from wallets that are not theirs; the people
 * who use it can only hire it where it can be paid, so this says so plainly
 * and hands over the link. It never suggests where the hires should come from.
 */
function HireHere({ id }: { id: string }) {
  const l = listingFor(id);
  const v = l ? hirePath(l) : null;
  const lead = v ? primaryRail(v) : null;
  return (
    <div className="x-hirehere">
      <h2 className="x-proof-h">Can people hire it on MANDATE?</h2>
      {!l ? (
        <p className="x-ad-src">
          Not under a job yet. Its card has to say which job it does (yield, grid trading, rebalancing or health factor) in its own description; we file it from
          those words when we read its registration.
        </p>
      ) : v?.ok ? (
        <>
          <p>
            Yes{lead && "price" in lead ? `, for ${lead.price}` : ""}. Anyone can hire it here, paying into BNB Chain&apos;s escrow, and every hire is read from
            the chain. This is its page to share with the people who use it:
          </p>
          <ShareLink url={`${SITE}/agents/${id}`} />
          <p className="x-ad-src">
            For Set and Earn, only hires from wallets that are not yours and not funded by yours count, and BNB Chain excludes wash activity.
          </p>
        </>
      ) : (
        <>
          <p>
            <strong>Not yet.</strong> {v?.reason}
          </p>
          {v?.short && FIX[v.short] ? <p className="x-ad-src">{FIX[v.short]}</p> : null}
        </>
      )}
    </div>
  );
}

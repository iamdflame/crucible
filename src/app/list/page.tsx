import Link from "next/link";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { Search } from "lucide-react";
import AppShell from "@/components/v2/shell/AppShell";
import Source from "@/components/x/Source";
import { ProofGlyph } from "@/components/x/Proof";
import { CATEGORY_LABEL } from "@/lib/config";
import { take } from "@/lib/api/ratelimit";
import { LIST_RUNGS, type RungCheck } from "@/lib/market/list-ladder";
import { ChainUnread, checkListing, type ListCheck } from "@/lib/market/list-check";
import { SITE } from "@/lib/site";
import QualifyPanel from "@/components/x/QualifyPanel";

export const metadata: Metadata = {
  title: "List your agent | MANDATE",
  description: "Every agent registered on BNB Smart Chain already has a place here. Enter its token id to see which rung it stands on and the one thing that moves it up.",
};

export const dynamic = "force-dynamic";
// A live probe, a quote and an assay, run while the seller waits.
export const maxDuration = 60;

const PROTOCOL: Record<string, string> = { mcp: "MCP", a2a: "A2A", x402: "x402", http: "plain HTTP, no agent protocol" };

function state(r: RungCheck, reached: number): "proven" | "failed" | "unproven" | "nodata" {
  if (r.n <= reached) return "proven";
  if (r.n === reached + 1) return "failed";
  return r.passed ? "unproven" : "nodata";
}

const STATE_WORD = { proven: "Holds", failed: "Next", unproven: "Holds, counts later", nodata: "Not yet" } as const;

function Ladder({ r }: { r: ListCheck }) {
  const reached = r.placement.rung;
  return (
    <ol className="x-rungs">
      {r.placement.rungs.map((g) => {
        const s = state(g, reached);
        return (
          <li key={g.n} className={`x-rung x-rung--${s}`}>
            <ProofGlyph state={s} />
            <span className="x-rung__n x-mono">{g.n}</span>
            <div className="x-rung__body">
              <p className="x-rung__name">
                {g.name} <span className={`x-proof__state x-proof__state--${s}`}>{STATE_WORD[s]}</span>
              </p>
              <p className="x-rung__test">{g.test}</p>
              <p className="x-rung__saw">{g.saw}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The seller's side of the marketplace.
 *
 * A front door with no way in is a wall, and a form would be the wrong way in:
 * every agent in the registry is already listed, because listing is not a
 * favour we grant. What a seller needs is where their agent stands, tested
 * now rather than taken from its card, and the one thing that would move it
 * up. Every read here is live, so a fix shows up the moment it is made.
 */
export default async function ListPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const raw = (Array.isArray(sp.id) ? sp.id[0] : sp.id)?.trim() ?? "";
  const id = /^\d{1,20}$/.test(raw) ? raw : null;

  let result: ListCheck | null = null;
  let error: string | null = null;
  if (raw && !id) error = "A token id is a whole number: the one your agent was given when it registered in ERC-8004.";
  if (id) {
    const who = ((await headers()).get("x-forwarded-for") ?? "").split(",")[0]?.trim() || "anonymous";
    const gate = take(`list:${who}`, { capacity: 4, windowMs: 60_000 });
    if (!gate.ok) error = `Four checks a minute, because each one calls your endpoint and runs an assay. Try again in ${gate.retryAfter} seconds.`;
    else {
      try {
        result = await checkListing(id);
      } catch (e) {
        error = e instanceof ChainUnread ? e.message : "The check could not be completed just now. Try again in a minute.";
      }
    }
  }

  return (
    <AppShell>
      <section className="x-wrap x-mkt-head">
        <div className="x-mkt-head__row">
          <h1 className="x-mkt-head__h">List your agent</h1>
          <p className="x-mkt-head__sub">Every agent registered on BNB Smart Chain already has a place here. This shows where yours stands.</p>
        </div>
        <form className="x-searchbar x-list-form" action="/list" method="get">
          <Search size={18} className="x-searchbar__i" aria-hidden="true" />
          <label htmlFor="list-id" className="x-sr">
            Your agent&apos;s ERC-8004 token id
          </label>
          <input id="list-id" name="id" defaultValue={raw} inputMode="numeric" placeholder="Its ERC-8004 token id, for example 342379" autoComplete="off" className="x-searchbar__in" />
          <button type="submit" className="x-btn x-btn--primary">
            Check it
          </button>
        </form>
        <p className="x-ad-src">We call its endpoint, read its price, run the assay and count its settled work, all now. Nothing is signed and nothing is stored about you.</p>
      </section>

      {error ? (
        <div className="x-wrap x-section--tight">
          <p className="x-rerun__err" role="alert">
            {error}
          </p>
        </div>
      ) : null}

      {result ? (
        <section className="x-wrap x-section--tight" aria-labelledby="h-standing">
          <div className="x-listing">
            <div className="x-task__top">
              <h2 id="h-standing" className="x-listing__who">
                {result.name ?? `Agent ${result.tokenId}`} <span className="x-mono x-dim">#{result.tokenId}</span>
              </h2>
              <span className={`x-verdict x-verdict--${result.hire.ok ? "win" : "inconclusive"}`}>{result.hire.ok ? "Hireable now" : (result.hire.short ?? "Not hireable")}</span>
            </div>
            <p className="x-listing__rung">
              {result.placement.rung < 0 ? "Not in the registry" : `Rung ${result.placement.rung} of ${LIST_RUNGS.length - 1}: ${result.placement.name}`}
            </p>
            <div className="x-listing__next">
              {result.placement.next ? (
                <>
                  <p className="x-listing__next-k">
                    To reach rung {result.placement.next.rung}, {result.placement.next.name}
                  </p>
                  <p className="x-listing__next-t">{result.placement.next.todo}</p>
                </>
              ) : (
                <p className="x-listing__next-t">
                  At the top. Keep it there: an agent whose latest paid call fails is taken off sale until it delivers one again.
                </p>
              )}
            </div>
            <p className="x-listing__hire">
              {result.hire.ok ? "Buyers can hire it on this marketplace now." : `Not offered for hire: ${result.hire.reason ?? "no rail we can settle"}`}
            </p>

            <Ladder r={result} />

            <dl className="x-kv x-listing__kv">
              <div>
                <dt>Category</dt>
                <dd>{result.category ? CATEGORY_LABEL[result.category] : "Not recognised from its card"}</dd>
              </div>
              <div>
                <dt>Endpoint</dt>
                <dd className="x-mono">{result.endpoint ?? "none in its card"}</dd>
              </div>
              <div>
                <dt>Answered in</dt>
                <dd>{result.protocol ? PROTOCOL[result.protocol] ?? result.protocol : "no protocol"}</dd>
              </div>
              {result.tools.length ? (
                <div>
                  <dt>Tools it lists</dt>
                  <dd className="x-mono">
                    {result.tools
                      .slice(0, 8)
                      .map((t) => t.name)
                      .join(", ")}
                    {result.tools.length > 8 ? ` and ${result.tools.length - 8} more` : ""}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>Price</dt>
                <dd>{result.price ?? "none quoted"}</dd>
              </div>
              <div>
                <dt>Assay</dt>
                <dd>
                  {result.fineness === null
                    ? `not available${result.assayError ? `: ${result.assayError}` : ""}`
                    : `fineness ${result.fineness}, ${result.assay === "live" ? "run just now" : "the last one stored, as a live one could not run"}`}
                </dd>
              </div>
              <div>
                <dt>Paid work delivered</dt>
                <dd>{result.settled}</dd>
              </div>
            </dl>

            <p className="x-stakes__links">
              {result.listed ? (
                <Link className="x-link" href={`/agents/${result.tokenId}`}>
                  Its page on this site
                </Link>
              ) : null}
              <Link className="x-link" href={`/list?id=${result.tokenId}`}>
                Check again
              </Link>
            </p>
            <Source kind="chain" block={result.blockNumber ? Number(result.blockNumber) : null} at={result.at}>
              The endpoint, the price and the assay were read at the same time, through the guard every agent&apos;s URL goes through.
            </Source>
          </div>
        </section>
      ) : null}

      {result && result.placement.rung >= 0 ? (
        <section className="x-wrap x-section--tight">
          <QualifyPanel tokenId={result.tokenId} />
        </section>
      ) : null}

      {!result ? (
        <section className="x-wrap x-section--tight" aria-labelledby="h-rungs">
          <h2 id="h-rungs" className="x-proof-h">
            Six rungs, each a test we run
          </h2>
          <p className="x-ad-src">A rung only counts when every rung below it does, because a buyer meets them in this order: a price is worth nothing from an endpoint that does not answer.</p>
          <ol className="x-rungs">
            {LIST_RUNGS.map((r) => (
              <li key={r.n} className="x-rung x-rung--nodata">
                <span className="x-rung__n x-mono">{r.n}</span>
                <div className="x-rung__body">
                  <p className="x-rung__name">{r.name}</p>
                  <p className="x-rung__test">{r.test}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section className="x-wrap x-section--tight">
        <p className="x-ad-src">
          The same check, as data: <span className="x-mono x-src__cmd">{`curl -X POST ${SITE}/api/v1/list -H 'content-type: application/json' -d '{"tokenId":"${id ?? "342379"}"}'`}</span>. How
          every agent is checked is on{" "}
          <Link className="x-link" href="/trust">
            Trust
          </Link>
          .
        </p>
      </section>
    </AppShell>
  );
}

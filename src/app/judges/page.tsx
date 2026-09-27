import Link from "next/link";
import type { Metadata } from "next";
import AppShell from "@/components/v2/shell/AppShell";
import CategoryMark from "@/components/v2/marks/CategoryMark";
import { CATEGORIES, CATEGORY_LABEL, IDENTITY_REGISTRY } from "@/lib/config";
import { judgePicks } from "@/lib/market/judge";
import { hireCounts } from "@/lib/market/hires";
import { censusAge, listingFor } from "@/lib/market/listing";
import { referenceAgents } from "@/lib/market/reference";
import { diagnose } from "@/lib/diagnose";
import { readLadder } from "@/lib/ladder";
import { snapshot } from "@/lib/data/snapshots";
import { readGridWindow, type GridWindow } from "@/lib/grid/window";
import { listSessions } from "@/lib/chain/session-store";
import { COUNTER_SLOT, registeredCount } from "@/lib/registry/count";
import { withTimeout } from "@/lib/cache";
import { live } from "@/lib/data/live";
import { DEMO_ADDRESS, bscscanTx, passkeyRecord, short } from "@/lib/demo";
import { describeStatus, strangerHiresLive } from "@/lib/market/stranger-hires";
import { listPaidCalls } from "@/lib/market/paid-calls";
import { sponsorAddress } from "@/lib/market/judge-mode";

export const metadata: Metadata = {
  title: "Judge walk | Mandate",
  description: "Six beats, each a live control on BNB Smart Chain mainnet. Paste one address and follow it.",
};

export const revalidate = 120;
// Room for the census slice that runs after the response (see lib/census/refresh).
export const maxDuration = 60;

/**
 * The judge walk: six beats, every one a link to a live page and every claim
 * beside it read from the chain at render time. Where a beat is not fully
 * true yet, the page says what is and is not, rather than implying more.
 */
const SPONSOR = (sponsorAddress() ?? "our keeper wallet").toString().slice(0, 10) + "…";

export default async function JudgesPage() {
  await live(["grid-window"]);
  const hires = (await hireCounts().catch(() => null))?.byTokenId;
  const picks = judgePicks(hires);
  const census = censusAge();
  const [diag, ladder, grid, refs, sessions, registry] = await Promise.all([
    withTimeout(diagnose(DEMO_ADDRESS).catch(() => null), 10_000),
    withTimeout(readLadder().catch(() => null), 20_000),
    snapshot<GridWindow>("grid-window")?.payload ?? withTimeout(readGridWindow().catch(() => null), 8_000),
    referenceAgents(),
    listSessions().catch(() => []),
    withTimeout(registeredCount().catch(() => null), 6_000),
  ]);
  const rangerJob = (await strangerHiresLive().catch(() => [])).find((h) => h.tokenId === "269706") ?? null;
  const paidMuster = ((await withTimeout(listPaidCalls().catch(() => []), 6_000)) ?? []).find((c) => c.tokenId === "342377" && c.delivered && c.tx) ?? null;
  const ranger = listingFor("269706");
  const passkey = passkeyRecord();
  const out = diag?.findings.filter((f) => f.kind === "out-of-range").length ?? null;
  const venus = diag?.findings.find((f) => f.pair === "Venus");
  const idle = diag?.findings.find((f) => f.kind === "idle-cash");
  const liveKeys = sessions.filter((s) => !s.revokedAt && s.expiry * 1000 > Date.now());
  const pickByCat = new Map(picks.map((p) => [p.category, p]));
  const rungs = ladder?.rungs ?? [];
  const commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local build";

  return (
    <AppShell>
      <div className="m-wrap m-section--tight" style={{ paddingTop: "clamp(2rem,5vw,3.5rem)" }}>
        <div className="m-cols m-cols--wide-narrow">
          <div>
            <h1 className="m-h1">Six beats, mainnet</h1>
            <p className="m-lede m-lede--wide" style={{ marginTop: "1rem" }}>
              One page. Every beat is a live control, and every receipt is a BscScan or KeyStore link. You need no
              account and no Agent Studio. Start by pasting one address.
            </p>
          </div>
          <div className="m-panel m-panel--sunken">
            <p className="m-small">
              <strong>The demo address.</strong> It holds real positions and a real Venus loan so you do not have to
              find your own:
            </p>
            <p className="m-mono m-small" style={{ marginTop: "0.5rem", wordBreak: "break-all" }}>{DEMO_ADDRESS}</p>
            <p className="m-note" style={{ marginTop: "0.7rem" }}>
              Check it yourself:{" "}
              <span className="m-mono">cast call 0x46A15B0b27311cedF172AB29E4f4766fbE7F4364 &quot;balanceOf(address)&quot; {short(DEMO_ADDRESS)}</span>
            </p>
            <hr className="m-rule" style={{ margin: "0.9rem 0" }} />
            <p className="m-note">
              <Link className="m-link" href="/status">Is every beat working right now →</Link>
            </p>
          </div>
        </div>

        <ol className="m-walkbig">
          <li>
            <span className="m-walkbig__n">1</span>
            <div>
              <h2 className="m-h3">Paste the demo address</h2>
              <p className="m-small">
                <Link className="m-link" href={`/diagnose?q=${DEMO_ADDRESS}`}>/diagnose?q={short(DEMO_ADDRESS)}</Link> reads it from the chain:{" "}
                {diag
                  ? `${out} position${out === 1 ? "" : "s"} out of range, ${venus ? venus.title.toLowerCase() : "no Venus position read"}${idle ? `, and ${idle.title.split(" is ")[0]} idle` : ""}, at block ${Number(diag.blockNumber).toLocaleString("en-GB")}.`
                  : "the chain did not answer this render, so the page will read it when you open it."}
              </p>
            </div>
          </li>
          <li>
            <span className="m-walkbig__n">2</span>
            <div>
              <h2 className="m-h3">Four categories, a reference and a stranger in each</h2>
              <p className="m-small">
                <a className="m-link" href="#categories">The four tiles below</a>: our reference agent with its mainnet receipt, beside
                the third-party agent that answered fastest when we called
                {census.minutes !== null ? ` ${census.minutes} minutes ago` : ""}. A category with no reference yet says so. Every
                agent that answered:{" "}
                <Link className="m-link" href="/agents?live=1">/agents?live=1</Link>.
              </p>
            </div>
          </li>
          <li>
            <span className="m-walkbig__n">3</span>
            <div>
              <h2 className="m-h3">Hire a stranger, here, with no wallet</h2>
              <p className="m-small">
                <Link className="m-link" href="/agents/342377#sponsored">/agents/342377</Link> is Muster&rsquo;s Venus
                health factor watch. We do not run it, it has never met us, and it has taken our money four times and
                answered every time. Press <strong>Hire it now, we pay</strong> on that page: Mandate signs a payment
                from {SPONSOR}, the agent settles it on BNB Smart Chain and returns the health factor, and you get the
                transaction and the answer in a few seconds. No wallet, no BNB, no account.
                {paidMuster ? (
                  <>
                    {" "}Last time: {paidMuster.amount ? `${(Number(paidMuster.amount) / 1e18).toFixed(2)} USD1` : ""}{" "}
                    <a className="m-link m-mono" href={bscscanTx(paidMuster.tx!)} target="_blank" rel="noreferrer">
                      {short(paidMuster.tx!)}
                    </a>
                    .
                  </>
                ) : null}
              </p>
              <p className="m-note" style={{ marginTop: "0.5rem" }}>
                The other way round is on the same shelf and just as true:{" "}
                <Link className="m-link" href="/agents/269706">Agripinaa&rsquo;s Ranger</Link> quotes a price we can now
                sign, but it took 0.05 USDT twice and answered with an error both times, so this site refuses to offer
                it until it delivers again, and prints its server&rsquo;s words as the reason.{" "}
                {rangerJob ? (
                  <>
                    Its escrowed job {rangerJob.jobId} ({rangerJob.budget} {rangerJob.token}) is {describeStatus(rangerJob)}.
                  </>
                ) : null}{" "}
                A grid job we negotiated with ChainHelix on the same rail did deliver, and its deliverable hash matches
                the chain: <Link className="m-link" href="/activity#strangers">see the tape</Link>.
              </p>
            </div>
          </li>
          <li>
            <span className="m-walkbig__n">4</span>
            <div>
              <h2 className="m-h3">Open Grid-1, ours, and read its window</h2>
              <p className="m-small">
                <Link className="m-link" href="/desk#grid-1">/desk#grid-1</Link>:{" "}
                {grid
                  ? grid.fills.length
                    ? `${grid.fills.length} real fills through SwapBound, ${grid.winRate === null ? "no round trip closed yet" : `${Math.round(grid.winRate * 100)}% of ${grid.roundTrips.length} round trips won`}, ${grid.pnlUsd >= 0 ? "+" : "-"}$${Math.abs(grid.pnlUsd).toFixed(4)} against doing nothing, worst drawdown $${grid.maxDrawdownUsd.toFixed(4)}.`
                    : "the window is open and no level has been crossed yet, so there is no fill to show. None is simulated."
                  : "the window could not be read this render."}{" "}
                {grid?.fills.length ? (
                  <a className="m-link m-mono" href={bscscanTx(grid.fills[grid.fills.length - 1].tx)} target="_blank" rel="noreferrer">
                    last fill {short(grid.fills[grid.fills.length - 1].tx)}
                  </a>
                ) : null}
              </p>
            </div>
          </li>
          <li>
            <span className="m-walkbig__n">5</span>
            <div>
              <h2 className="m-h3">Open the desk and compare it with the KeyStore</h2>
              <p className="m-small">
                <Link className="m-link" href="/desk">/desk</Link> lists {liveKeys.length} live key{liveKeys.length === 1 ? "" : "s"} on the demo
                account, what each may call, and the KeyStore&rsquo;s own answer beside it.{" "}
                {passkey
                  ? "A passkey wallet shows the whole lifecycle: grant, act, revoke, with the registry read before and after."
                  : "The passkey lifecycle is not recorded yet."}{" "}
                Revoking a live key takes the operator token, because it spends the account&rsquo;s gas.
              </p>
            </div>
          </li>
          <li>
            <span className="m-walkbig__n">6</span>
            <div>
              <h2 className="m-h3">The funnel, from the registry itself</h2>
              <p className="m-small">
                {registry ? (
                  <>
                    <strong>{registry.count.toLocaleString("en-GB")}</strong> agents registered at block{" "}
                    {registry.block.toLocaleString("en-GB")}, read from the registry&rsquo;s own counter, not an indexer&rsquo;s
                    estimate.{" "}
                  </>
                ) : (
                  "The registry counter did not answer this render. "
                )}
                {rungs.length
                  ? `Then: ${rungs
                      .slice(1)
                      .map((r) => `${r.population === null ? "unmeasured" : r.population.toLocaleString("en-GB")} ${r.name.toLowerCase()}`)
                      .join(" → ")}. `
                  : ""}
                <a className="m-link" href="/api/v1/registry/funnel">The funnel as JSON</a> ·{" "}
                <Link className="m-link" href="/verify">how each step is checked</Link>. Check the first number yourself:{" "}
                <span className="m-mono m-note">cast storage {short(IDENTITY_REGISTRY)} {short(COUNTER_SLOT)}</span>
              </p>
            </div>
          </li>
        </ol>

        <section className="m-section--tight" id="categories">
          <div className="m-head">
            <h2 className="m-h2">The four categories</h2>
            <p className="m-head__note">Same fields in every tile. No tile is ever empty.</p>
          </div>
          <div className="m-grid">
            {CATEGORIES.map((c) => {
              const ref = refs[c];
              const pick = pickByCat.get(c);
              return (
                <article className="m-card" key={c}>
                  <div className="m-card__top">
                    <div style={{ minWidth: 0 }}>
                      <span className="m-card__cat">{CATEGORY_LABEL[c]}</span>
                      <span className="m-card__name">
                        {ref.status === "live" ? "reference live" : ref.status === "paused" ? "reference paused" : ref.status === "idle" ? "reference idle" : "no reference yet"}
                        {" · "}
                        {pick ? "third party live" : "no third party answered"}
                      </span>
                    </div>
                    <CategoryMark category={c} size={40} />
                  </div>
                  <p className="m-small">
                    <strong>{ref.name}</strong>
                    {ref.tokenId ? (
                      <>
                        {" "}
                        (
                        <a className="m-link" href={`https://bscscan.com/token/${IDENTITY_REGISTRY}?a=${ref.tokenId}`} target="_blank" rel="noreferrer">
                          ERC-8004 #{ref.tokenId}
                        </a>
                        )
                      </>
                    ) : null}
                    : {ref.evidence}{" "}
                    {ref.tx ? (
                      <a className="m-link m-mono" href={bscscanTx(ref.tx)} target="_blank" rel="noreferrer">{short(ref.tx)}</a>
                    ) : null}
                  </p>
                  <p className="m-small" style={{ marginTop: "0.5rem" }}>
                    {pick ? (
                      <>
                        <strong>{pick.listing.name}</strong>, not ours: chosen because it is {pick.because}.
                      </>
                    ) : (
                      "No third-party agent in this category answered when we last called."
                    )}
                  </p>
                  <div className="m-card__foot">
                    <Link className="m-btn m-btn--sm" href={ref.href}>{ref.name}</Link>
                    {pick ? (
                      <Link className="m-btn m-btn--sm m-btn--primary" href={`/agents/${pick.listing.tokenId}`}>
                        {pick.listing.name}
                      </Link>
                    ) : (
                      <Link className="m-btn m-btn--sm" href={`/agents?category=${c}`}>All {CATEGORY_LABEL[c].toLowerCase()}</Link>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="m-section--tight">
          <p className="m-note">
            Everything above is read at render time and the page regenerates every two minutes. The{" "}
            <a className="m-link" href="https://youtu.be/7l_Ppu_V44o" target="_blank" rel="noreferrer">video</a> walks an earlier version of this path;
            where it and this page disagree, this page is the one that is true. Commit {commit}.
          </p>
        </section>
      </div>
    </AppShell>
  );
}

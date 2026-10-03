import Link from "next/link";
import type { Metadata } from "next";
import AppShell from "@/components/v2/shell/AppShell";
import CategoryMark from "@/components/v2/marks/CategoryMark";
import AgentTile from "@/components/x/AgentTile";
import { CATEGORY_LABEL } from "@/lib/config";
import { diagnose, population } from "@/lib/diagnose";
import { agentsFor } from "@/lib/diagnose/agents";
import { listings } from "@/lib/market/listing";
import { hireCounts } from "@/lib/market/hires";
import { live } from "@/lib/data/live";

export const metadata: Metadata = {
  title: "Check a position | Mandate",
  description:
    "Paste a wallet or a PancakeSwap V3 position and find out whether it is out of range or close to liquidation, then hire an agent that answered when we called it.",
};

export const dynamic = "force-dynamic";
// Room for the census slice that runs after the response (see lib/census/refresh).
export const maxDuration = 60;

/**
 * The shortest path from a problem to an agent.
 *
 * A plain GET form, server-rendered, so it works with no JavaScript and every
 * result is a URL somebody can paste to a friend. The alternative was a client
 * component posting to an API, which would have made the answer invisible to
 * anyone whose script had not loaded, and unshareable for everyone else.
 */
export default async function DiagnosePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await live();
  const sp = await searchParams;
  const q = ((Array.isArray(sp.q) ? sp.q[0] : sp.q) ?? "").trim().slice(0, 64);

  const counts = await hireCounts().catch(() => null);
  const hires = counts?.byTokenId;
  const result = q ? await diagnose(q, hires).catch(() => null) : null;
  const pop = population();
  const bad = result?.findings.filter((f) => f.severity !== "fine") ?? [];

  return (
    <AppShell>
      <section className="m-wrap m-section--tight" style={{ paddingTop: "clamp(2.5rem,6vw,4rem)" }}>
        <div style={{ maxWidth: "44ch" }}>
          <h1 className="m-h1">Is your position doing anything?</h1>
          <p className="m-lede m-lede--wide" style={{ marginTop: "1rem" }}>
            Paste a wallet or a PancakeSwap V3 position number. We read it from
            the chain and tell you whether it is earning, drifting, or close to
            being liquidated.
          </p>
        </div>

        <form className="m-diag" action="/diagnose" method="get">
          <input
            className="m-input"
            type="text"
            name="q"
            defaultValue={q}
            placeholder="0x… wallet address, or a position number like 1857423"
            aria-label="Wallet address or PancakeSwap V3 position id"
          />
          <button className="m-btn m-btn--primary m-btn--lg" type="submit">
            Check it
          </button>
        </form>

        {pop ? (
          <p className="m-note" style={{ marginTop: "0.9rem", maxWidth: "62ch" }}>
            For context: of {pop.live.toLocaleString("en-GB")} live V3 positions we
            read at block {pop.anchorBlock.toLocaleString("en-GB")},{" "}
            <strong>{pop.outOfRange.toLocaleString("en-GB")} were out of range</strong>{" "}
            and earning nothing. That is {pop.share.toFixed(1)}% of them, and it is
            the reason this page exists.{" "}
            <Link className="m-link" href="/evidence">
              How that was measured →
            </Link>
          </p>
        ) : null}

        {q && !result ? (
          <div className="m-absent" style={{ marginTop: "2rem" }}>
            <p className="m-absent__t">That is not a wallet address or a position number.</p>
            <p className="m-small">
              A wallet looks like <span className="m-mono">0x</span> followed by forty
              characters. A PancakeSwap V3 position is a plain number, printed on
              the position itself.
            </p>
          </div>
        ) : null}
      </section>

      {result ? (
        <div className="m-wrap m-section--tight">
          <div className="m-head">
            <h2 className="m-h2">
              {bad.length === 0
                ? "Nothing needs doing"
                : bad.length === 1
                  ? "One thing needs doing"
                  : `${bad.length} things need doing`}
            </h2>
            <p className="m-head__note">
              Read from BNB Smart Chain at block{" "}
              {Number(result.blockNumber).toLocaleString("en-GB")}.
            </p>
          </div>

          {result.findings.length === 0 ? (
            <div className="m-absent">
              <p className="m-absent__t">
                We found no PancakeSwap V3 positions and no Venus borrowing on{" "}
                {result.kind === "wallet" ? "that wallet" : "that position"}.
              </p>
              <p className="m-small">
                That is not a failure: most addresses hold neither. If you expected
                positions here, they may be staked in a farm, which this page does
                not yet read.
              </p>
            </div>
          ) : (
            <ol className="m-findings">
              {result.findings.map((f, i) => (
                <li className={`m-finding m-finding--${f.severity}`} key={`${f.kind}-${f.tokenId ?? i}`}>
                  <span className="m-finding__flag">
                    {f.severity === "act" ? "Act" : f.severity === "watch" ? "Watch" : "Fine"}
                  </span>
                  <div>
                    <h3 className="m-h3">{f.title}</h3>
                    <p className="m-small" style={{ marginTop: "0.35rem", maxWidth: "64ch" }}>
                      {f.detail}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}

          <p className="m-note" style={{ marginTop: "1rem", maxWidth: "64ch" }}>
            A range is half open: at the upper tick the position holds one side of
            the pair and earns no fees, so we count that as out. Positions whose
            pool would not answer are reported as unchecked rather than guessed at.
          </p>

          {/* ------------------------------------------------- who can fix it */}
          {result.needed.length ? (
            <section className="m-section--tight" aria-labelledby="h-for-wallet">
              <div className="m-head">
                <h2 id="h-for-wallet" className="m-h2">
                  Agents for this {result.kind === "wallet" ? "wallet" : "position"}
                </h2>
                <p className="m-head__note">Only agents a buyer can hire right now, by the same rules as everywhere on this site.</p>
              </div>
              {agentsFor(result.needed, listings(hires, counts?.settled, counts?.delivery)).map((g) => (
                <div className="x-diag-cat" key={g.category}>
                  <h3 className="m-h3 x-diag-cat__h">
                    <CategoryMark category={g.category} size={24} /> {CATEGORY_LABEL[g.category]}
                  </h3>
                  {g.hireable.length ? (
                    <div className="x-grid x-grid--3">
                      {g.hireable.map((l) => (
                        <AgentTile key={l.tokenId} l={l} forPosition={result.input} />
                      ))}
                    </div>
                  ) : (
                    <div className="m-absent">
                      <p className="m-absent__t">No {CATEGORY_LABEL[g.category].toLowerCase()} agent can be hired right now.</p>
                      <p className="m-small">
                        {g.answering
                          ? `${g.answering} answer in an agent protocol, but none has a price we can settle and a clean record. We will not recommend one we could not pay.`
                          : "None answered in an agent protocol when we last called."}{" "}
                        <Link className="m-link" href={`/agents?category=${g.category}`}>
                          See all of them anyway →
                        </Link>
                      </p>
                    </div>
                  )}
                  {g.total > g.hireable.length ? (
                    <p className="m-small x-diag-cat__more">
                      <Link className="m-link" href={`/agents?category=${g.category}&hireable=1`}>
                        All {g.total} hireable {CATEGORY_LABEL[g.category].toLowerCase()} agents →
                      </Link>
                    </p>
                  ) : null}
                </div>
              ))}
            </section>
          ) : null}

          {bad.length === 0 && result.findings.length > 0 ? (
            <p className="m-small" style={{ marginTop: "1.5rem" }}>
              Nothing here needs an agent right now.{" "}
              <Link className="m-link" href="/agents">
                Browse the marketplace anyway →
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}
    </AppShell>
  );
}

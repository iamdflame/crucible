import Link from "next/link";
import type { Metadata } from "next";
import AppShell from "@/components/v2/shell/AppShell";
import { CATEGORY_LABEL, type Category } from "@/lib/config";
import { live } from "@/lib/data/live";
import { findAgent } from "@/lib/data/agents";
import { latestConformance, type Latest } from "@/lib/conformance/run";
import { TOLERANCE } from "@/lib/conformance/checks";
import { DEMO_ADDRESS } from "@/lib/demo";
import { withTimeout } from "@/lib/cache";

export const metadata: Metadata = {
  title: "The MANDATE standard | MANDATE",
  description: "How every agent's answer is checked against our own reading of BNB Smart Chain, by code, and each agent's latest result.",
};

export const dynamic = "force-dynamic";

const pct = (n: number) => `${Math.round(n * 100)}%`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The rules, stated from the constants the checks enforce, so the page cannot say one thing while the code does another. */
const RULES: { job: Category; asked: string; checked: string[] }[] = [
  {
    job: "health-factor",
    asked: `The health factor of the Venus loan on ${short(DEMO_ADDRESS)}, the public test account.`,
    checked: [
      `Its health factor is within ${pct(TOLERANCE.healthFactor)} of the one we derive from Venus's Comptroller at the same time (${pct(TOLERANCE.healthFactorAged)} for an answer taken more than an hour earlier).`,
      "With no loan, it says there is none.",
    ],
  },
  {
    job: "rebalancing",
    asked: `Whether the PancakeSwap V3 positions of ${short(DEMO_ADDRESS)} are in range.`,
    checked: [
      "Whether a position is in range matches the pool's own tick, read now.",
      `The pool's current tick it states is within ${TOLERANCE.tick} ticks of ours (not held to this when the answer is more than an hour old).`,
      "An answer naming a position is compared with that position, read from the chain.",
    ],
  },
  {
    job: "yield-optimisation",
    asked: "Where 1,000 USDT earns most on BNB Smart Chain.",
    checked: [
      `A Venus USDT rate it states is within ${pct(TOLERANCE.rate)} of the rate we compute from Venus's rate per block and a block time we measure.`,
      "An answer only about venues we do not read ourselves is not comparable, never failed.",
    ],
  },
  {
    job: "grid-trading",
    asked: "A grid for WBNB/USDT between two prices 8% either side of the price now, with a stop and 1,000 USD of capital, over 10 levels.",
    checked: [
      `Every level lies inside the bounds asked for (within ${pct(TOLERANCE.gridBounds)}).`,
      "It has the number of levels asked for, give or take one, in price order.",
      "Its allocations add up to no more than the capital.",
    ],
  },
];

const WORD: Record<Latest["verdict"], string> = { pass: "Passed", fail: "Failed", "not-comparable": "Not comparable", unreadable: "Could not be checked", untested: "Not tested yet" };

export default async function StandardPage() {
  await live();
  const all = [...((await withTimeout(latestConformance().catch(() => new Map<string, Latest>()), 6_000)) ?? new Map<string, Latest>()).values()];
  const passed = all.filter((r) => r.verdict === "pass").length;
  return (
    <AppShell>
      <section className="x-wrap x-mkt-head">
        <div className="x-mkt-head__row">
          <h1 className="x-mkt-head__h">The MANDATE standard</h1>
          <p className="x-mkt-head__sub">Every agent in a job gets the same public question. Its answer is checked against our own reading of the chain, by code.</p>
        </div>
      </section>

      <div className="x-wrap x-section--tight x-helppage__body">
        <section>
          <h2>How an answer is checked</h2>
          <p>
            No language model grades anything here. For each job we ask one question about public, on-chain facts, read the same facts from BNB Smart
            Chain ourselves, and compare field by field. Our own agents are asked the same question and held to the same rules. Answers come from an
            agent&apos;s free call where it has one, and otherwise from our daily test purchase; an agent that only sells paid jobs is tested within a
            small daily budget.
          </p>
          {RULES.map((r) => (
            <div key={r.job}>
              <h3>{CATEGORY_LABEL[r.job]}</h3>
              <p>
                <strong>Asked:</strong> {r.asked}
              </p>
              <ul>
                {r.checked.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>

        <section>
          <h2>Latest results</h2>
          <p>
            {passed} of {all.length} agents checked passed on their latest answer. Each line links to the agent, where the field-by-field comparison is shown.
          </p>
          <div className="x-table-wrap">
            <table className="x-conf__table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Job</th>
                  <th>Result</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {all
                  .sort((a, b) => ["pass", "fail", "unreadable", "not-comparable", "untested"].indexOf(a.verdict) - ["pass", "fail", "unreadable", "not-comparable", "untested"].indexOf(b.verdict))
                  .map((r) => (
                    <tr key={r.tokenId}>
                      <td>
                        <Link className="x-link" href={`/agents/${r.tokenId}#checks`}>
                          {findAgent(r.tokenId)?.name ?? `Agent #${r.tokenId}`}
                        </Link>
                      </td>
                      <td>{CATEGORY_LABEL[r.category as Category] ?? r.category}</td>
                      <td>
                        <span className={`x-conf x-conf--${r.verdict}`}>{WORD[r.verdict]}</span>
                      </td>
                      <td>{r.checks.length ? r.checks.map((c) => `${c.field}: ${c.pass ? "matches" : `ours ${c.ours}, theirs ${c.theirs}`}`).join("; ") : r.note}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </AppShell>
  );
}

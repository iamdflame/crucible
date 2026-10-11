import Link from "next/link";
import type { Metadata } from "next";
import AppShell from "@/components/v2/shell/AppShell";
import CreateAgent from "@/components/x/CreateAgent";
import BuildPrompt from "@/components/x/BuildPrompt";
import NeedHelp from "@/components/x/NeedHelp";
import { LIST_RUNGS } from "@/lib/market/list-ladder";
import { QUALIFIES } from "@/lib/campaign/rules";

export const metadata: Metadata = {
  title: "Build an agent | MANDATE",
  description: "Build an agent for BNB Chain's Set and Earn: register it on ERC-8004 from your campaign wallet, list it on MANDATE in minutes, and see what it needs to qualify.",
};

const REPO = "https://github.com/iamdflame/mandate-bnb/tree/main/templates/agent-starter";
const DEPLOY =
  "https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fiamdflame%2Fmandate-bnb%2Ftree%2Fmain%2Ftemplates%2Fagent-starter&env=SELLER_KEY,AGENT_NAME,AGENT_DESCRIPTION,AGENT_CATEGORY&project-name=my-bnb-agent";

/**
 * The builder's path, start to listed: deploy something that answers and can
 * be paid, register it from your own wallet, and read where it stands. Each
 * step is one action, and the ladder says what the next one is worth.
 */
export default function BuildPage() {
  return (
    <AppShell>
      <section className="x-wrap x-mkt-head">
        <div className="x-mkt-head__row">
          <h1 className="x-mkt-head__h">Build an agent</h1>
          <p className="x-mkt-head__sub">Deploy it, register it from your wallet, and it is listed here within minutes.</p>
        </div>
      </section>

      <div className="x-wrap x-section--tight x-build">
        <section className="x-build__rules" aria-labelledby="qualifies">
          <h2 id="qualifies">What makes it count for Set and Earn</h2>
          <p>
            BNB Chain checks every agent after the campaign closes on 5 November, from onchain data and its public endpoints. Your repository must be public.
          </p>
          <ol className="x-build__checks">
            {QUALIFIES.map(([t, d]) => (
              <li key={t}>
                <strong>{t}.</strong> {d}
              </li>
            ))}
          </ol>
          <p className="x-build__note">
            Not counted: an agent that answers but never acts on chain, one listed before the Phase 2 announcement, the same agent under several ids, and copies of
            an existing agent with cosmetic changes. So make it yours: the starter below gets you registered, live and paid in minutes, and the onchain work is
            what you add. BNB Chain&apos;s own route is{" "}
            <a className="x-link" href="https://www.bnbchain.org/en/bnb-agent-studio" target="_blank" rel="noreferrer">
              BNB Agent Studio
            </a>
            , which agents built with it are hired here by too.
          </p>
          <p className="x-build__act">
            <Link className="x-btn x-btn--primary" href="/check">
              Check your agent now
            </Link>
          </p>
        </section>
        <BuildPrompt />
        <ol className="x-build__steps">
          <li className="x-build__step">
            <span className="x-home__n">1</span>
            <div>
              <h2>Deploy an agent that can be paid</h2>
              <p>
                The starter is one file that sells an answer over x402 in USD1: the buyer signs, your agent settles on chain and pays the gas, and nobody gets
                the answer before the money moves. Change what it answers and give it work to do on chain; keep the payment code.
              </p>
              <p className="x-build__act">
                <a className="x-btn" href={DEPLOY} target="_blank" rel="noreferrer">
                  Deploy the starter to Vercel
                </a>
                <a className="x-link" href={REPO} target="_blank" rel="noreferrer">
                  Read the code
                </a>
              </p>
              <p className="x-build__note">
                It needs a fresh wallet key (SELLER_KEY) holding about 0.001 BNB for gas. Already have an agent? Skip to step 2.
              </p>
              <p className="x-build__note">
                Selling jobs rather than calls? Serve BNB&apos;s standard hire: list an A2A endpoint whose card, at{" "}
                <span className="x-mono">/.well-known/agent-card.json</span> under it, offers <span className="x-mono">negotiate-erc8183-job</span> (the id in BNB&apos;s agent
                SDK; <span className="x-mono">negotiate</span> works too) and signs a price in $U on the ERC-8183 kernel. Buyers here open the job with your signed quote,
                fund the escrow, and you deliver on chain. Offer <span className="x-mono">notify_funded</span> and we tell you the job number as well.
              </p>
            </div>
          </li>

          <li className="x-build__step">
            <span className="x-home__n">2</span>
            <div>
              <h2>Register it on ERC-8004</h2>
              <p>One transaction from your wallet mints its identity on BNB Smart Chain. The card can be written on chain here, or point at the one your agent serves.</p>
              <CreateAgent />
            </div>
          </li>

          <li className="x-build__step">
            <span className="x-home__n">3</span>
            <div>
              <h2>Climb the ladder</h2>
              <p>
                Every registered agent is listed. How far it climbs decides where buyers see it, and each rung is checked by us, not claimed.{" "}
                <Link className="x-link" href="/list">
                  See where yours stands
                </Link>
                .
              </p>
              <ol className="x-build__ladder">
                {LIST_RUNGS.map((r) => (
                  <li key={r.n}>
                    <span className="x-mono">{r.n}</span>
                    <strong>{r.name}</strong>
                    <span>{r.test}</span>
                  </li>
                ))}
              </ol>
            </div>
          </li>
        </ol>
        <NeedHelp />
      </div>
    </AppShell>
  );
}

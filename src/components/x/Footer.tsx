import Link from "next/link";
import { MARKET_ADDRESS } from "@/lib/chain/market";
import { Mark } from "./Brand";
import { SUPPORT } from "@/lib/site";
import NetworkBadge from "./NetworkBadge";

/** Compact. Where things are, and the one address that lets anyone check us. */
export default function Footer() {
  return (
    <footer className="x-footer">
      <div className="x-wrap">
        <div className="x-footer__grid">
          <div>
            <Link href="/" className="x-brand" aria-label="MANDATE, home">
              <Mark size={26} />
              <span className="x-brand__word">Mandate</span>
            </Link>
            <p style={{ marginTop: "var(--s-3)", maxWidth: "34ch" }}>Hire an agent you can check, on BNB Smart Chain.</p>
            <p className="x-dim" style={{ marginTop: "var(--s-3)", maxWidth: "40ch", fontSize: "var(--ts-xs)" }}>
              Mandate never takes custody of your funds. Nothing here is investment advice.
            </p>
          </div>
          <div>
            <h4>Explore</h4>
            <ul>
              <li><Link href="/agents">Agents</Link></li>
              <li><Link href="/categories">Categories</Link></li>
              <li><Link href="/jobs">Jobs</Link></li>
              <li><Link href="/activity">Activity</Link></li>
              <li><Link href="/desk">My Desk</Link></li>
            </ul>
          </div>
          <div>
            <h4>For builders</h4>
            <ul>
              <li><Link href="/list">List your agent</Link></li>
              <li><Link href="/api">API and MCP</Link></li>
              <li><Link href="/brand">Brand kit</Link></li>
              <li><Link href="/status">Status</Link></li>
              <li><Link href="/judges">See it work</Link></li>
            </ul>
          </div>
          <div>
            <h4>Help</h4>
            <ul>
              <li><Link href="/help">How it works and FAQ</Link></li>
              <li><a href="/alerts">Liquidation alerts</a></li>
              <li><a href={SUPPORT.telegram} target="_blank" rel="noreferrer">Telegram</a></li>
              <li><a href={`mailto:${SUPPORT.email}`}>{SUPPORT.email}</a></li>
              <li><a href={SUPPORT.x} target="_blank" rel="noreferrer">X, @mandate_bnb</a></li>
            </ul>
          </div>
          <div>
            <h4>Trust</h4>
            <ul>
              <li><Link href="/trust">How verification works</Link></li>
              <li><Link href="/contracts">Contracts</Link></li>
              <li><Link href="/proof">Proof</Link></li>
              <li><Link href="/graveyard">Graveyard</Link></li>
              <li><Link href="/evidence">Evidence</Link></li>
              <li><Link href="/evidence/restatement">Where we were wrong</Link></li>
              <li>
                <a href={`https://bscscan.com/address/${MARKET_ADDRESS}`} target="_blank" rel="noreferrer">
                  Market contract
                </a>
              </li>
            </ul>
          </div>
        </div>
        <div className="x-footer__base">
          <NetworkBadge />
          <Link href="/contracts" className="x-mono">
            Contracts we read · market {MARKET_ADDRESS.slice(0, 10)}…{MARKET_ADDRESS.slice(-6)}
          </Link>
        </div>
      </div>
    </footer>
  );
}

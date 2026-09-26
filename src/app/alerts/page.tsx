import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import AppShell from "@/components/v2/shell/AppShell";
import AlertSignup from "@/components/x/AlertSignup";
import NeedHelp from "@/components/x/NeedHelp";

export const metadata: Metadata = {
  title: "Liquidation alerts | MANDATE",
  description: "A free Telegram message before your Venus loan on BNB Smart Chain can be liquidated. Nothing to sign; stop any time.",
};

/**
 * Free liquidation alerts. Anyone with a Venus loan can use them, hired or
 * not: a message before the loan can be liquidated, from the same reading of
 * the chain our agents act on. Guard-1, which can repay for them, is offered
 * underneath and nothing more.
 */
export default function AlertsPage() {
  return (
    <AppShell>
      <section className="x-wrap x-mkt-head">
        <div className="x-mkt-head__row">
          <h1 className="x-mkt-head__h">Liquidation alerts</h1>
          <p className="x-mkt-head__sub">A free Telegram message before your Venus loan can be liquidated.</p>
        </div>
      </section>

      <div className="x-wrap x-section--tight x-alerts">
        <AlertSignup />

        <aside className="x-alerts__side">
          <h2 className="x-alerts__h">How it works</h2>
          <ol className="x-alerts__how">
            <li>Every five minutes we read the wallet&apos;s Venus position from BNB Smart Chain.</li>
            <li>You get a message when its health factor drops below your level, a reminder if it stays there, and one line when it recovers.</li>
            <li>Nothing to sign and nothing to connect: we only read what the chain shows anyone, and cannot move a thing.</li>
          </ol>
          <p className="x-alerts__fine">
            We keep the wallet, your level and your Telegram chat, only to send these messages. Send <span className="x-mono">/stop</span> to the bot at any time to end them.
          </p>
          <div className="x-alerts__up">
            <p>
              <strong>Want it handled for you?</strong> Guard-1 can repay the loan itself, on a wallet you own, within a daily cap you set, until you revoke it.
            </p>
            <Link className="x-btn" href="/leash?agent=guard-1">
              Leash Guard-1 <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
        </aside>
      </div>
      <div className="x-wrap">
        <NeedHelp />
      </div>
    </AppShell>
  );
}

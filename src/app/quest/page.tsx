import type { Metadata } from "next";
import { formatUnits } from "viem";
import AppShell from "@/components/v2/shell/AppShell";
import QuestBoard, { type QuestCard } from "@/components/x/QuestBoard";
import { offerFor } from "@/components/x/offer";
import { CATEGORY_LABEL } from "@/lib/config";
import { live } from "@/lib/data/live";
import { isOurs } from "@/lib/market/judge";
import { questPicks } from "@/lib/market/quest-picks";
import { CAMPAIGN } from "@/lib/market/tracking";

const QUEST_TITLE = "Set and Earn, in one place";
const QUEST_BLURB = "BNB Chain's Set and Earn, 1 Oct to 5 Nov: hire three different agents across at least two shortlisted marketplaces, and build one of your own. Your progress here, checked on chain.";

export const metadata: Metadata = {
  title: "Set and Earn | MANDATE",
  description: QUEST_BLURB,
  openGraph: { title: QUEST_TITLE, description: QUEST_BLURB },
  twitter: { card: "summary_large_image", title: QUEST_TITLE, description: QUEST_BLURB },
};

export const dynamic = "force-dynamic";

const priceOf = (o: ReturnType<typeof offerFor>, label: string | null): string | null =>
  o.escrow ? `${formatUnits(BigInt(o.escrow.budget), 18)} $U a job` : label ? `${label} a call` : null;

/**
 * BNB's Set and Earn quest, done in one place.
 *
 * BNB Chain's rules (its campaign page, Tracks): register the wallet, hire
 * three different agents across at least two shortlisted marketplaces, and
 * build one agent of your own. This page puts the steps and the wallet's
 * progress first, then an agent for each job with the drawer that hires it,
 * read from the same tracking API BNB reads.
 */
export default async function QuestPage() {
  await live();
  const picks = await questPicks();
  const cards: QuestCard[] = picks.map((p) => {
    const offer = p.pick ? offerFor(p.pick) : null;
    return {
      category: p.category,
      label: CATEGORY_LABEL[p.category],
      others: p.others,
      // No free call here: a call MANDATE pays for is not the wallet's own hire, and would not count.
      offer: offer ? { ...offer, sponsored: null } : null,
      // The price of the hire the drawer leads with: an escrowed job where the agent takes one.
      price: offer ? priceOf(offer, p.pick!.priceLabel) : null,
      ours: p.pick ? isOurs(p.pick) : false,
    };
  });
  return (
    <AppShell>
      <section className="x-wrap x-mkt-head">
        <div className="x-mkt-head__row">
          <h1 className="x-mkt-head__h">Set and Earn</h1>
          <p className="x-mkt-head__sub">
            BNB Chain&apos;s campaign, 1 October to 5 November: hire three different agents across at least two shortlisted marketplaces, and build one of your
            own. The first 100 wallets to finish both get a limited merch drop.
          </p>
        </div>
      </section>
      <div className="x-wrap x-section--tight">
        <QuestBoard cards={cards} campaign={CAMPAIGN} />
      </div>
    </AppShell>
  );
}

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
import { countArrival } from "@/lib/ops/arrivals";
import { listings } from "@/lib/market/listing";
import { hirePath } from "@/lib/market/hire-law";
import { houseSlug } from "@/lib/market/performance";
import type { PackAgent } from "@/components/x/HirePack";
import type { TestnetPackAgent } from "@/components/x/TestnetPack";
import { testnetProviderFor } from "@/lib/escrow/testnet-jobs";
import { HOUSE_BUDGET } from "@/lib/escrow/contracts";
import { hirePauseForSlug } from "@/lib/market/paused";

/*
  The pack's two agents: ours, so a delivery within the escrow policy's
  thirty minutes is ours to keep, and about the buyer's own wallet. Health
  and yield first; they answer any wallet, with or without a position.
*/
const PACK_ORDER = ["guard-1", "yield-1", "range-1", "grid-1"];
const DOES: Record<string, string> = {
  "guard-1": "Reads your Venus loan's health factor, and how far prices would have to fall before it can be liquidated.",
  "yield-1": "Compares what your stablecoins would earn on Venus and Aave at the current block, and where it would place them.",
  "range-1": "Checks your PancakeSwap V3 positions for ranges that have drifted, with a plan to recenter them.",
  "grid-1": "Plans a bounded WBNB/USDT grid and states its fee drag.",
};

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
export default async function QuestPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await countArrival("/quest", await searchParams);
  await live();
  const picks = await questPicks();
  const pack: PackAgent[] = listings()
    .map((l) => ({ l, slug: houseSlug(l.tokenId) }))
    .filter(({ l, slug }) => slug && hirePath(l).ok)
    .map(({ l, slug }) => ({ slug: slug!, offer: offerFor(l) }))
    .filter(({ offer }) => offer.escrow && !offer.escrow.outside)
    .sort((a, b) => PACK_ORDER.indexOf(a.slug) - PACK_ORDER.indexOf(b.slug))
    .slice(0, 2)
    .map(({ slug, offer }) => ({ tokenId: offer.tokenId, name: offer.name, does: DOES[slug] ?? offer.task, provider: offer.escrow!.provider, budget: offer.escrow!.budget }));
  // The same two agents on testnet, where Set and Earn also counts hires and the buyer pays in test $U.
  const packSlugs = pack.map((a) => houseSlug(a.tokenId)).filter((s): s is NonNullable<typeof s> => s !== null) as string[];
  const testnetPack: TestnetPackAgent[] = (packSlugs.length >= 2 ? packSlugs : PACK_ORDER)
    .filter((slug) => !hirePauseForSlug(slug))
    .map((slug) => ({ slug, t: testnetProviderFor(slug) }))
    .filter((x): x is { slug: string; t: NonNullable<ReturnType<typeof testnetProviderFor>> } => Boolean(x.t?.mainnetTokenId))
    .slice(0, 2)
    .map(({ slug, t }) => ({
      slug,
      name: t.ref.name,
      does: DOES[slug] ?? t.ref.description,
      tokenId: t.tokenId,
      mainnetTokenId: t.mainnetTokenId!,
      provider: t.owner,
      budget: HOUSE_BUDGET.toString(),
    }));
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
            BNB Chain&apos;s campaign, to 5 November: hire three different agents on at least two marketplaces, and build one of your own. BNB Chain sends merch to
            the first 100 wallets that finish both.
          </p>
        </div>
      </section>
      <div className="x-wrap x-section--tight">
        <QuestBoard cards={cards} campaign={CAMPAIGN} pack={pack} testnetPack={testnetPack} />
      </div>
    </AppShell>
  );
}

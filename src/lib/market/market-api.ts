/**
 * The marketplace as data: what /agents shows, for a program to read.
 *
 *   GET /api/v1/market?q=…&job=…&view=ready|free|checked|all&limit=…
 *   GET /api/v1/market/{tokenId}
 *
 * The same listings, the same hire law and the same order as the page, so an
 * agent or an AI assistant asking here gets the answer a person would see:
 * whether an agent can be hired right now, how, at what price, and in words
 * why not when it cannot. The MCP server's tools read these routes, so the
 * hosted server and a local install answer alike.
 */

import { CATEGORIES, CATEGORY_LABEL, type Category } from "@/lib/config";
import { listings, type Listing } from "@/lib/market/listing";
import { hireCounts } from "@/lib/market/hires";
import { hireHref, hirePath, primaryRail, type HireVerdict, type Rail } from "@/lib/market/hire-law";
import { applyQuery, hirePriceUsd, parseQuery, tryFreeKind } from "@/lib/market/catalogue";
import { live } from "@/lib/data/live";
import { SITE } from "@/lib/site";

export interface MarketCard {
  tokenId: string;
  name: string;
  job: Category | null;
  jobLabel: string | null;
  /** Operated by MANDATE, and labelled so everywhere. */
  ours: boolean;
  hireable: boolean;
  /** The ways it can be hired here now: an escrowed job, a paid call (x402), or a job with capital. */
  how: ("escrow" | "x402" | "mandate")[];
  price: string | null;
  priceUsd: number | null;
  /** Why it cannot be hired, when it cannot: a few words, and the full sentence. */
  whyNot: { short: string | null; reason: string } | null;
  /** Whether its work can be seen free first, and how: one of ours, a call MANDATE pays for, or the seller's own free answer. */
  tryFree: "house" | "sponsored" | "sdk" | null;
  /** Its answer against MANDATE's own chain reading, when checked. */
  checked: string | null;
  hires: number;
  /** Median seconds from payment to delivery on chain, over how many jobs. */
  delivers: { seconds: number; jobs: number } | null;
  page: string;
  hire: string;
}

export interface MarketAgent extends MarketCard {
  what: string | null;
  owner: string | null;
  protocols: string[];
  /** Whether it answered when last called. */
  liveness: Listing["liveness"];
  answeredMinutesAgo: number | null;
  rails: Rail[];
  settled: number;
}

function card(l: Listing, v: HireVerdict): MarketCard {
  const delivers = l.deliveredIn ?? null;
  // The price Hire charges: the rail it leads with, as the tile shows it.
  const lead = primaryRail(v);
  return {
    tokenId: l.tokenId,
    name: l.name,
    job: l.category,
    jobLabel: l.category ? CATEGORY_LABEL[l.category] : null,
    ours: v.ours,
    hireable: v.ok,
    how: v.rails.map((r) => r.kind),
    price: lead && lead.kind !== "mandate" ? lead.price : l.priceLabel,
    priceUsd: hirePriceUsd(l, v),
    whyNot: v.ok ? null : { short: v.short, reason: v.reason ?? "It cannot be hired here right now." },
    tryFree: tryFreeKind(l, v),
    checked: l.checked?.verdict ?? null,
    hires: l.hires,
    delivers: delivers ? { seconds: delivers.seconds, jobs: delivers.jobs } : null,
    page: `${SITE}/agents/${l.tokenId}`,
    hire: `${SITE}${hireHref(l.tokenId, v) ?? `/agents/${l.tokenId}`}`,
  };
}

async function loaded(): Promise<Listing[]> {
  await live();
  const hc = await hireCounts();
  return listings(hc.byTokenId, hc.settled, hc.delivery);
}

export interface MarketSearch {
  /** Every agent listed under one of the four jobs, and how many of them can be hired now. */
  listed: number;
  ready: number;
  matched: number;
  agents: MarketCard[];
}

/** The page's own query: `view` ready by default (or all, for a search), the recommended order, at most 50. */
export async function searchMarket(params: { q?: string; job?: string; view?: string; limit?: number }): Promise<MarketSearch> {
  const all = await loaded();
  const job = params.job && (CATEGORIES as readonly string[]).includes(params.job) ? params.job : undefined;
  const q = parseQuery({ q: params.q ?? "", category: job, view: params.view });
  const { shown } = applyQuery(all, q);
  const limit = Math.min(50, Math.max(1, params.limit ?? 10));
  return {
    listed: all.length,
    ready: all.filter((l) => hirePath(l).ok).length,
    matched: shown.length,
    agents: shown.slice(0, limit).map((l) => card(l, hirePath(l))),
  };
}

/** One agent, as its page states it. Null when it is not listed under one of the four jobs. */
export async function marketAgent(tokenId: string): Promise<MarketAgent | null> {
  const l = (await loaded()).find((x) => x.tokenId === tokenId);
  if (!l) return null;
  const v = hirePath(l);
  return {
    ...card(l, v),
    what: l.what,
    owner: l.owner,
    protocols: l.protocols,
    liveness: l.liveness,
    answeredMinutesAgo: v.answeredMinutesAgo,
    rails: v.rails,
    settled: l.settled,
  };
}

/** The four jobs: how many agents can be hired for each now, and the lowest price among them. */
export async function marketJobs(): Promise<{ job: Category; label: string; ready: number; listed: number; from: string | null; browse: string }[]> {
  const all = await loaded();
  return CATEGORIES.map((c) => {
    const here = all.filter((l) => l.category === c);
    const ready = here.map((l) => ({ l, v: hirePath(l) })).filter((x) => x.v.ok);
    const cheapest = ready
      .map((x) => ({ usd: hirePriceUsd(x.l, x.v), label: card(x.l, x.v).price }))
      .filter((x) => x.usd !== null)
      .sort((a, b) => a.usd! - b.usd!)[0];
    return { job: c, label: CATEGORY_LABEL[c], ready: ready.length, listed: here.length, from: cheapest?.label ?? null, browse: `${SITE}/agents?category=${c}` };
  });
}

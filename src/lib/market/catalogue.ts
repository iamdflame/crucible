/**
 * The marketplace query: every filter and sort, defined once.
 *
 * The catalogue page, the home page shelves and the category pages all ask
 * the same questions of the same listings. They used to answer them in three
 * places, which is how a tile ends up advertising a count its own page cannot
 * reproduce. Here the filters live in the URL (so the list is server-rendered
 * and every view is a shareable link), and the counts come from the same
 * predicates the list uses.
 *
 * Nothing here scores an agent. "Recommended" is an order built from facts we
 * checked, and the rule is written out in RECOMMENDED_RULE so the page can say
 * it next to the sort control.
 */

import { CATEGORIES, type Category } from "@/lib/config";
import type { Listing } from "@/lib/market/listing";
import { hirePath, primaryRail, type HireVerdict } from "@/lib/market/hire-law";
import { isOurs } from "@/lib/market/judge";
import { assayFor } from "@/lib/market/assays";
import { intentOf, type Intent } from "@/lib/market/intent";
import { SPONSORED } from "@/lib/market/sponsored-targets";
import { houseSlug } from "@/lib/market/performance";

export type Sort = "recommended" | "recent" | "fastest" | "price" | "activity" | "evidence" | "newest";

/*
  Every sort says what it orders by, because "recommended" with no reason is
  a score in disguise. "Recently active" is the most recent answer to our own
  call; "most activity" is paid work delivered, then reviews, then mandates.
*/
export const SORTS: { id: Sort; label: string; how: string }[] = [
  { id: "recommended", label: "Recommended", how: "Hireable now first, then passed MANDATE checks, then reachable, priced on a rail we can pay, how clearly it matches the job, and past hires. Agents whose last paid work failed come last." },
  { id: "recent", label: "Recently active", how: "Answered our most recent check first." },
  { id: "fastest", label: "Fastest", how: "Quickest answer to our last call. Agents that did not answer come last." },
  { id: "price", label: "Lowest price", how: "Cheapest published price in dollar stablecoins. Unpriced agents come last." },
  { id: "activity", label: "Most activity", how: "Paid work delivered through this marketplace, then registry reviews, then mandates held." },
  { id: "evidence", label: "Most evidence", how: "Most checks proven against the chain, then settled work." },
  { id: "newest", label: "Newest", how: "Most recently registered on ERC-8004." },
];

export const RECOMMENDED_RULE =
  "Hireable now first, then passed MANDATE checks, then reachable, priced on a rail we can pay, how clearly it matches the job, and past hires. Agents whose last paid work failed come last. Our own agents never outrank an equal agent we do not run.";

/**
 * The marketplace's four doors. It opens on what can be hired, because a
 * shelf that leads with agents nobody can pay is a shop that looks closed:
 * on 3 October twelve of the first sixteen cards could not be hired. Every
 * agent is still one tab away under All.
 */
export type View = "ready" | "free" | "checked" | "all";
export const VIEWS: { id: View; label: string; short: string }[] = [
  { id: "ready", label: "Ready to hire", short: "Ready to hire" },
  { id: "free", label: "Try free", short: "Try free" },
  { id: "checked", label: "Passed MANDATE checks", short: "Checked" },
  { id: "all", label: "All agents", short: "All" },
];
/** A search looks everywhere (hireable first); a plain visit opens on what can be hired. */
export const defaultView = (q: Pick<Query, "q">): View => (q.q.trim() ? "all" : "ready");

export const PAGE = 24;

export interface Query {
  category: Category | null;
  q: string;
  sort: Sort;
  n: number;
  /** The tab. */
  view: View;
  // availability
  hireable: boolean;
  live: boolean;
  fresh: boolean;
  /** One registration per product: copies of the same card collapse onto the earliest. */
  unique: boolean;
  // trust
  /** Its answer matched our own chain reading in MANDATE's conformance checks. */
  checked: boolean;
  capable: boolean;
  assayed: boolean;
  reviewed: boolean;
  settled: boolean;
  // pricing
  priced: boolean;
  max: number | null;
  // protocol and execution
  proto: string | null;
  rail: "x402" | "job" | null;
}

export const EMPTY: Query = {
  category: null,
  q: "",
  sort: "recommended",
  n: PAGE,
  // Code that asks the catalogue a question sees everything; the page picks its own default.
  view: "all",
  hireable: false,
  live: false,
  fresh: false,
  unique: false,
  checked: false,
  capable: false,
  assayed: false,
  reviewed: false,
  settled: false,
  priced: false,
  max: null,
  proto: null,
  rail: null,
};

type Params = Record<string, string | string[] | undefined>;

export function parseQuery(sp: Params): Query {
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) as string | undefined;
  const flag = (k: string) => one(k) === "1";
  const cat = one("category");
  const sort = one("sort");
  const max = Number(one("max"));
  const rail = one("rail");
  const q = (one("q") ?? "").slice(0, 100);
  const view = one("view");
  return {
    category: CATEGORIES.includes(cat as Category) ? (cat as Category) : null,
    q,
    // "hireable=1" is the old name for the Ready tab, and every link that still says it lands there.
    view: VIEWS.some((v) => v.id === view) ? (view as View) : flag("hireable") ? "ready" : defaultView({ q }),
    // "checks" was the old default sort's name; it maps onto the same order.
    sort: SORTS.some((s) => s.id === sort) ? (sort as Sort) : "recommended",
    n: Math.min(400, Math.max(PAGE, Number(one("n")) || PAGE)),
    // Folded into the Ready tab; kept on the query for code that asks for it directly.
    hireable: false,
    live: flag("live"),
    fresh: flag("fresh"),
    unique: flag("unique"),
    checked: flag("checked"),
    capable: flag("capable"),
    assayed: flag("assayed"),
    reviewed: flag("reviewed"),
    settled: flag("settled"),
    priced: flag("priced"),
    max: max === 0.05 || max === 0.1 ? max : null,
    proto: one("proto")?.slice(0, 40) ?? null,
    rail: rail === "x402" || rail === "job" ? rail : null,
  };
}

/** A link to this view with some filters changed. Every control is one of these. */
export function hrefFor(q: Query, patch: Partial<Query>, base = "/agents"): string {
  const next = { ...q, ...patch };
  const p = new URLSearchParams();
  if (next.category) p.set("category", next.category);
  if (next.q) p.set("q", next.q);
  if (next.view !== defaultView(next)) p.set("view", next.view);
  for (const k of ["hireable", "live", "fresh", "unique", "checked", "capable", "assayed", "reviewed", "settled", "priced"] as const) if (next[k]) p.set(k, "1");
  if (next.max) p.set("max", String(next.max));
  if (next.proto) p.set("proto", next.proto);
  if (next.rail) p.set("rail", next.rail);
  if (next.sort !== "recommended") p.set("sort", next.sort);
  if (next.n !== PAGE) p.set("n", String(next.n));
  const s = p.toString();
  return s ? `${base}?${s}` : base;
}

const DAY = 24 * 3600 * 1000;

/** Each filter as a predicate, so counts and results can never disagree. */
export const PRED = {
  hireable: (l: Listing) => hirePath(l).ok,
  live: (l: Listing) => l.liveness === "live",
  fresh: (l: Listing) => Boolean(l.probe?.at && Date.now() - Date.parse(l.probe.at) < DAY),
  unique: (l: Listing) => l.firstOfProduct,
  checked: (l: Listing) => l.checked?.verdict === "pass",
  capable: (l: Listing) => assayFor(l.tokenId)?.results.find((r) => r.id === "capability")?.verdict === "pass",
  // Every indexed agent has been assayed, so "assayed" alone filters nothing.
  // This is the useful version: it passed at least half of the checks that
  // apply to it, the same bar the trust timeline uses for "Verified".
  assayed: (l: Listing) => {
    const r = assayFor(l.tokenId);
    if (!r) return false;
    const applicable = r.results.filter((x) => !x.notApplicable);
    return applicable.length > 0 && applicable.filter((x) => x.verdict === "pass").length >= Math.ceil(applicable.length / 2);
  },
  reviewed: (l: Listing) => l.reviews > 0,
  settled: (l: Listing) => l.settled > 0,
  // A price we can show, read from its own 402. Agents that only say they
  // charge are not "priced" here: a filter called Price published that
  // returns "price not read yet" would be the shop lying about its shelf.
  priced: (l: Listing) => Boolean(l.quote),
  x402: (l: Listing) => Boolean(l.quote) || l.declaresPayment,
  job: (l: Listing) => hirePath(l).rails.some((r) => r.kind === "mandate"),
  tryFree: (l: Listing) => tryFreeKind(l) !== null,
} as const;

/**
 * Whether a buyer can try it before paying, and how: we pay for a call to it
 * (sponsored), or it is an outside seller on BNB's SDK whose free answer our
 * last check could read. The drawer offers exactly these (components/x/offer).
 */
export function tryFreeKind(l: Listing, v: HireVerdict = hirePath(l)): "sponsored" | "sdk" | null {
  if (!v.ok) return null;
  if (SPONSORED[l.tokenId]) return "sponsored";
  const escrow = v.rails.some((r) => r.kind === "escrow");
  if (escrow && !houseSlug(l.tokenId) && l.escrowQuote?.kind === "sdk" && l.checked?.verdict !== "unreadable") return "sdk";
  return null;
}

/** What hiring it costs in dollars, on the rail Hire uses: an escrowed job's $U budget, else its per-call price. */
export function hirePriceUsd(l: Listing, v: HireVerdict = hirePath(l)): number | null {
  const r = primaryRail(v);
  if (r?.kind === "escrow") return Number(r.wei) / 1e18;
  return l.usdPrice;
}

/** Failures on record, which sink an agent below every other one we cannot hire. */
const FAILED = new Set(["Took payment, returned an error", "Refused a correct payment", "Missed an escrowed job"]);

export interface Result {
  shown: Listing[];
  /** Set when the text matched nothing literally but the words meant a job. */
  intent: Intent | null;
  /** Whether the intent widened the search beyond literal matches. */
  intentUsed: boolean;
}

export function applyQuery(all: Listing[], q: Query): Result {
  const needle = q.q.trim().toLowerCase();
  const intent = needle ? intentOf(needle) : null;

  // One hire verdict per agent per question: the sort compares thousands of pairs.
  const verdicts = new Map<Listing, HireVerdict>();
  const verdict = (l: Listing) => verdicts.get(l) ?? verdicts.set(l, hirePath(l)).get(l)!;
  const standing = (l: Listing) => (verdict(l).ok ? 2 : FAILED.has(verdict(l).short ?? "") ? 0 : 1);

  const base = all.filter((l) => {
    if (q.category && l.category !== q.category) return false;
    if (q.view === "ready" && !verdict(l).ok) return false;
    if (q.view === "free" && tryFreeKind(l, verdict(l)) === null) return false;
    if (q.view === "checked" && !PRED.checked(l)) return false;
    if (q.hireable && !verdict(l).ok) return false;
    if (q.live && !PRED.live(l)) return false;
    if (q.fresh && !PRED.fresh(l)) return false;
    if (q.unique && !PRED.unique(l)) return false;
    if (q.checked && !PRED.checked(l)) return false;
    if (q.capable && !PRED.capable(l)) return false;
    if (q.assayed && !PRED.assayed(l)) return false;
    if (q.reviewed && !PRED.reviewed(l)) return false;
    if (q.settled && !PRED.settled(l)) return false;
    if (q.priced && !PRED.priced(l)) return false;
    if (q.max !== null && !(l.usdPrice !== null && l.usdPrice <= q.max)) return false;
    if (q.proto && !l.protocols.some((p) => p.toLowerCase() === q.proto!.toLowerCase())) return false;
    if (q.rail === "x402" && !PRED.x402(l)) return false;
    if (q.rail === "job" && !PRED.job(l)) return false;
    return true;
  });

  const ours = (l: Listing) => Number(isOurs(l));
  const cmp: Record<Sort, (a: Listing, b: Listing) => number> = {
    recommended: (a, b) =>
      standing(b) - standing(a) ||
      Number(PRED.checked(b)) - Number(PRED.checked(a)) ||
      b.readiness - a.readiness ||
      ours(a) - ours(b) ||
      b.confidence - a.confidence,
    // Agents that answered come first in both of these; a silent one has no speed.
    fastest: (a, b) =>
      Number(!a.probe?.answered) - Number(!b.probe?.answered) ||
      (a.probe?.latencyMs ?? 9e9) - (b.probe?.latencyMs ?? 9e9),
    price: (a, b) => (a.usdPrice ?? 9e9) - (b.usdPrice ?? 9e9) || b.readiness - a.readiness,
    evidence: (a, b) => (b.checksPassed ?? -1) - (a.checksPassed ?? -1) || b.settled - a.settled || b.reviews - a.reviews,
    recent: (a, b) =>
      Number(!a.probe?.answered) - Number(!b.probe?.answered) || Date.parse(b.probe?.at ?? "0") - Date.parse(a.probe?.at ?? "0"),
    activity: (a, b) => b.settled - a.settled || b.reviews - a.reviews || b.hires - a.hires || b.readiness - a.readiness,
    newest: (a, b) => Date.parse(b.createdAt ?? "0") - Date.parse(a.createdAt ?? "0"),
  };
  if (!needle) return { shown: [...base].sort(cmp[q.sort]), intent: null, intentUsed: false };

  const hay = (l: Listing) => `${l.name} ${l.what ?? ""} ${l.tokenId} ${l.protocols.join(" ")}`.toLowerCase();
  const words = needle.split(/\s+/).filter((w) => w.length > 1);
  const literal = base.filter((l) => words.every((w) => hay(l).includes(w)));
  // Literal hits first, then, if the words named a job, the rest of that job.
  // Each group is sorted on its own so the literal matches stay on top.
  const byIntent = intent && !q.category ? base.filter((l) => l.category === intent.category && !literal.includes(l)) : [];
  return {
    shown: [...literal.sort(cmp[q.sort]), ...byIntent.sort(cmp[q.sort])],
    intent,
    intentUsed: byIntent.length > 0,
  };
}

/** The protocols agents declare, most common first, for the filter rail. */
export function topProtocols(all: Listing[], n = 8): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const l of all) for (const p of l.protocols) counts.set(p, (counts.get(p) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

export function isFiltered(q: Query): boolean {
  const { sort: _s, n: _n, view: _v, ...rest } = q;
  return JSON.stringify(rest) !== JSON.stringify((({ sort: _a, n: _b, view: _c, ...r }) => r)(EMPTY));
}

export interface CategoryStats {
  total: number;
  live: number;
  priced: number;
  hireable: number;
  /** Cheapest price among the agents you can hire in the category, on the rail Hire uses, or null when none is. */
  from: number | null;
}

/** The same counts the category tiles, the home page and /categories all show. */
export function categoryStats(all: Listing[]): Record<Category, CategoryStats> {
  return Object.fromEntries(
    CATEGORIES.map((c) => {
      const here = all.filter((l) => l.category === c);
      // "From" is what the cheapest agent you can hire costs on the rail Hire uses, so the tile never quotes a price nobody can pay.
      const prices = here
        .map((l) => ({ l, v: hirePath(l) }))
        .filter(({ v }) => v.ok)
        .map(({ l, v }) => hirePriceUsd(l, v))
        .filter((p): p is number => p !== null);
      return [
        c,
        {
          total: here.length,
          live: here.filter(PRED.live).length,
          priced: here.filter(PRED.priced).length,
          hireable: here.filter(PRED.hireable).length,
          from: prices.length ? Math.min(...prices) : null,
        },
      ];
    }),
  ) as Record<Category, CategoryStats>;
}

export const CATEGORY_PITCH: Record<Category, string> = {
  rebalancing: "Keep LP ranges working while markets move.",
  "grid-trading": "Automate entries and exits around a price range.",
  "yield-optimisation": "Route capital toward better yield.",
  "health-factor": "Protect lending positions before liquidation.",
};

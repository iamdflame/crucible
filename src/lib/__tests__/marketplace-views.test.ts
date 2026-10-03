/**
 * The marketplace opens on what can be hired, and its prices are the prices
 * of the rail Hire uses. On 3 October twelve of the first sixteen cards on
 * /agents could not be hired, a card led with an escrowed job while quoting
 * the per-call token, and a 1-wei job read "from $0.00" on the home page.
 */

import { describe, expect, it } from "vitest";
import type { Listing } from "@/lib/market/listing";
import { tokenAmount } from "@/lib/market/listing";
import { applyQuery, EMPTY, hrefFor, parseQuery, categoryStats } from "@/lib/market/catalogue";
import { priceParts, priceUsd } from "@/components/x/Price";

const now = () => new Date(Date.now() - 5 * 60_000).toISOString();

const listing = (over: Partial<Listing> = {}): Listing =>
  ({
    tokenId: "9001",
    name: "Test agent",
    what: null,
    category: "rebalancing",
    categoryLabel: "Rebalancing",
    confidence: 1,
    matched: [],
    owner: "0x00000000000000000000000000000000000000aa",
    protocols: [],
    probe: { answered: true, status: 402, latencyMs: 300, endpoint: "https://x.test", at: now() },
    liveness: "live",
    declaresPayment: true,
    quote: null,
    escrowQuote: null,
    priceLabel: null,
    registryVerified: false,
    reviews: 0,
    reviewQuality: null,
    checksPassed: null,
    custodySeparate: null,
    avgScore: null,
    registryScore: null,
    hires: 0,
    settled: 0,
    usdPrice: null,
    createdAt: null,
    signals: [],
    readiness: 0,
    copies: 1,
    firstOfProduct: true,
    ...over,
  }) as Listing;

// Hireable: it answered minutes ago and quoted a price we can pay.
const payable = (tokenId: string, over: Partial<Listing> = {}) =>
  listing({
    tokenId,
    quote: { payable: true, amount: "50000", decimals: 6, endpoint: "https://x.test/call", transferMethod: null } as never,
    priceLabel: "0.05 USDT",
    usdPrice: 0.05,
    ...over,
  });
// Not hireable: silent when we last called it.
const silent = (tokenId: string, over: Partial<Listing> = {}) => listing({ tokenId, liveness: "silent", probe: { answered: false, status: null, latencyMs: null, endpoint: "https://x.test", at: now() }, ...over });

describe("the marketplace's default order", () => {
  it("puts every agent you can hire above every one you cannot, whatever its readiness", () => {
    const shelf = [silent("1", { readiness: 95 }), payable("2", { readiness: 40 }), silent("3", { readiness: 80 }), payable("4", { readiness: 60 })];
    const ids = applyQuery(shelf, EMPTY).shown.map((l) => l.tokenId);
    expect(ids.slice(0, 2).sort()).toEqual(["2", "4"]);
    expect(ids).toEqual(["4", "2", "1", "3"]);
  });

  it("puts an agent that passed our checks first among the hireable", () => {
    const shelf = [payable("1", { readiness: 90 }), payable("2", { readiness: 50, checked: { verdict: "pass", at: now() } })];
    expect(applyQuery(shelf, EMPTY).shown.map((l) => l.tokenId)).toEqual(["2", "1"]);
  });
});

describe("the marketplace's tabs", () => {
  it("opens on Ready to hire, searches everything, and keeps old hireable links working", () => {
    expect(parseQuery({}).view).toBe("ready");
    expect(parseQuery({ q: "venus" }).view).toBe("all");
    expect(parseQuery({ hireable: "1" }).view).toBe("ready");
    expect(parseQuery({ view: "free" }).view).toBe("free");
    expect(parseQuery({ view: "nonsense" }).view).toBe("ready");
  });

  it("writes the tab into a link only when it is not the default", () => {
    expect(hrefFor(parseQuery({}), {})).toBe("/agents");
    expect(hrefFor(parseQuery({}), { view: "all" })).toBe("/agents?view=all");
    expect(hrefFor(parseQuery({ q: "venus" }), {})).toBe("/agents?q=venus");
    expect(hrefFor(parseQuery({ q: "venus" }), { view: "ready" })).toBe("/agents?q=venus&view=ready");
  });

  it("shows only hireable agents on Ready to hire, and everyone on All", () => {
    const shelf = [silent("1"), payable("2")];
    expect(applyQuery(shelf, { ...EMPTY, view: "ready" }).shown.map((l) => l.tokenId)).toEqual(["2"]);
    expect(applyQuery(shelf, { ...EMPTY, view: "all" }).shown).toHaveLength(2);
  });
});

describe("prices", () => {
  it("never reads $0.00", () => {
    expect(priceUsd(0)).toBe("Free");
    expect(priceUsd(1e-18)).toBe("<$0.0001");
    expect(priceUsd(0.05)).toBe("$0.05");
    expect(tokenAmount("1")).toBe("under 0.0001");
    expect(tokenAmount("50000000000000000")).toBe("0.05");
  });

  it("prices a card by the rail Hire uses: an escrowed job in $U, not the per-call token", () => {
    const parts = priceParts({ usdPrice: 0.05, priceLabel: "0.05 USD1", declaresPayment: true }, { kind: "escrow", price: "0.05 $U", wei: "50000000000000000", provider: "0x1" });
    expect(parts).toMatchObject({ value: "$0.05", unit: "/ job", exact: "0.05 $U" });
  });

  it("quotes a category from the cheapest agent you can actually hire", () => {
    const shelf = [silent("1", { usdPrice: 0.01, priceLabel: "0.01 USDT" }), payable("2")];
    expect(categoryStats(shelf).rebalancing.from).toBe(0.05);
  });
});

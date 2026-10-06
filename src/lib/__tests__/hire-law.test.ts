import { describe, expect, it } from "vitest";
import { hireHref, hirePath, primaryRail } from "../market/hire-law";
import type { Listing } from "../market/listing";
import type { Quote } from "../x402/quote";

const NOW = Date.parse("2026-09-11T18:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const quote = (payable: boolean, unpayable: string | null = null): Quote => ({
  endpoint: "https://example.test/x402",
  amount: "20000000000000000",
  decimals: 18,
  asset: "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d",
  assetName: "World Liberty Financial USD",
  network: "eip155:56",
  chainId: 56,
  payTo: "0xcd10D44703D6989290E0A8219f345fA0a5BF4c64",
  scheme: "eip3009",
  description: null,
  resource: null,
  x402Version: 2,
  header: "PAYMENT-SIGNATURE",
  transferMethod: "eip3009",
  payable,
  unpayable,
});

type L = Parameters<typeof hirePath>[0];
const stranger = (over: Partial<L> = {}): L => ({
  tokenId: "999999001",
  owner: "0x1111111111111111111111111111111111111111",
  probe: { answered: true, status: 402, latencyMs: 300, endpoint: "https://example.test/x402", at: minutesAgo(5) },
  liveness: "live" as Listing["liveness"],
  quote: quote(true),
  priceLabel: "0.02 USD1",
  ...over,
});

describe("the hire law", () => {
  it("never offers one of our operating wallets registered as an agent, however it answers", () => {
    // Keeper A, registered twice as an agent; it bids for us and is not for hire.
    const v = hirePath(stranger({ tokenId: "336599", owner: "0xd6d11aa5046dc5c7be8d63b9223b60d7ad94cbe9" }), { now: NOW, jobsOpen: true, bidders: new Set(["0xd6d11aa5046dc5c7be8d63b9223b60d7ad94cbe9"]) });
    expect(v.ok).toBe(false);
    expect(v.short).toBe("Our operating wallet, not for hire");
  });

  it("offers a stranger that answered recently and quoted a price we can pay, over x402", () => {
    const v = hirePath(stranger(), { now: NOW });
    expect(v.ok).toBe(true);
    expect(v.answeringNow).toBe(true);
    expect(primaryRail(v)).toMatchObject({ kind: "x402", price: "0.02 USD1" });
    expect(hireHref("999999001", v)).toBe("/agents/999999001#call");
  });

  it("never offers our market's job form for a stranger that does not bid in it", () => {
    const v = hirePath(stranger({ quote: null, priceLabel: null }), { now: NOW });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/does not bid on jobs in this market/);
    expect(hireHref("999999001", v)).toBeNull();
  });

  it("offers the job form for a stranger that has bid in this market, once jobs are open", () => {
    const v = hirePath(stranger({ quote: null, priceLabel: null }), {
      now: NOW,
      bidders: new Set(["0x1111111111111111111111111111111111111111"]),
      jobsOpen: true,
    });
    expect(v.ok).toBe(true);
    expect(primaryRail(v)).toEqual({ kind: "mandate" });
  });

  it("offers no job with capital while jobs are closed, however the agent bids", () => {
    const v = hirePath(stranger({ quote: null, priceLabel: null }), {
      now: NOW,
      bidders: new Set(["0x1111111111111111111111111111111111111111"]),
      jobsOpen: false,
    });
    expect(v.rails.some((r) => r.kind === "mandate")).toBe(false);
  });

  it("shows the seller's unpayable reason instead of a button", () => {
    const v = hirePath(stranger({ quote: quote(false, "it settles on eip155:8453, not BNB Smart Chain") }), { now: NOW });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("It quoted a price we cannot pay: it settles on eip155:8453, not BNB Smart Chain.");
  });

  it("refuses an answer older than a day, a silent agent, and one never called", () => {
    expect(hirePath(stranger({ probe: { answered: true, status: 402, latencyMs: 1, endpoint: "x", at: minutesAgo(26 * 60) } }), { now: NOW }).reason).toMatch(/last answered 26 h ago/);
    expect(hirePath(stranger({ probe: { answered: false, status: null, latencyMs: null, endpoint: "x", at: minutesAgo(3) }, liveness: "silent" }), { now: NOW }).ok).toBe(false);
    expect(hirePath(stranger({ probe: null, liveness: "untested" }), { now: NOW }).reason).toMatch(/not called it yet/);
    expect(hirePath(stranger({ liveness: "no-endpoint" }), { now: NOW }).reason).toMatch(/names nothing to call/);
  });

  it("refuses an agent that took our money and returned nothing, quoting what happened", () => {
    const seen = new Map([
      [
        "999999001",
        {
          tokenId: "999999001",
          delivered: 0,
          paidNotDelivered: 1,
          refused: 0,
          lastAt: new Date(NOW - 3 * 3600_000).toISOString(),
          lastWhy: "it answered 402 to the signed payment: settlement failed",
          lastTx: "0xabc",
          lastFailed: true,
        },
      ],
    ]);
    const v = hirePath(stranger(), { now: NOW, outcomes: seen });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/We paid it on .* and it answered with an error/);
    expect(v.reason).toMatch(/settlement failed/);
  });

  it("refuses an agent that turned down a correctly signed payment", () => {
    const seen = new Map([
      ["999999001", { tokenId: "999999001", delivered: 0, paidNotDelivered: 0, refused: 1, lastAt: new Date(NOW - 3600_000).toISOString(), lastWhy: "No x402 facilitator is configured", lastTx: null, lastFailed: true }],
    ]);
    expect(hirePath(stranger(), { now: NOW, outcomes: seen }).reason).toMatch(/refused it: No x402 facilitator/);
  });

  it("offers an agent again once it has delivered", () => {
    const seen = new Map([
      ["999999001", { tokenId: "999999001", delivered: 1, paidNotDelivered: 1, refused: 0, lastAt: new Date(NOW - 600_000).toISOString(), lastWhy: null, lastTx: "0xdef", lastFailed: false }],
    ]);
    expect(hirePath(stranger(), { now: NOW, outcomes: seen }).ok).toBe(true);
  });

  it("keeps a failure off the shelf past a week, until the next delivery", () => {
    const failed = { tokenId: "999999001", delivered: 0, paidNotDelivered: 1, refused: 0, lastAt: new Date(NOW - 30 * 86_400_000).toISOString(), lastWhy: "settlement failed", lastTx: "0xabc", lastFailed: true };
    expect(hirePath(stranger(), { now: NOW, outcomes: new Map([["999999001", failed]]) }).ok).toBe(false);
    // An agent that delivered before and failed most recently is off too: the latest call decides.
    const relapsed = { ...failed, delivered: 3, lastAt: new Date(NOW - 3600_000).toISOString() };
    expect(hirePath(stranger(), { now: NOW, outcomes: new Map([["999999001", relapsed]]) }).short).toBe("Took payment, returned an error");
  });

  it("gives every refusal a short form for a tile, and an offer none", () => {
    const refusals = [
      hirePath(stranger({ quote: null, priceLabel: null }), { now: NOW }),
      hirePath(stranger({ quote: quote(false, "it settles on eip155:8453, not BNB Smart Chain") }), { now: NOW }),
      hirePath(stranger({ probe: { answered: true, status: 402, latencyMs: 1, endpoint: "x", at: minutesAgo(26 * 60) } }), { now: NOW }),
      hirePath(stranger({ probe: null, liveness: "untested" }), { now: NOW }),
      hirePath(stranger({ liveness: "no-endpoint" }), { now: NOW }),
    ];
    for (const v of refusals) {
      expect(v.ok).toBe(false);
      expect(v.short).toBeTruthy();
      expect(v.short!.length).toBeLessThan(v.reason!.length);
    }
    expect(refusals.map((v) => v.short)).toEqual([
      "No price we can pay yet",
      "Its price is in a token we cannot pay",
      "Last answered 26 h ago",
      "Not checked yet",
      "Publishes nothing to call",
    ]);
    expect(hirePath(stranger(), { now: NOW }).short).toBeNull();
  });

  it("does not hire per call an endpoint that answers in no agent protocol", () => {
    const site = { answered: false, status: 200, latencyMs: 80, endpoint: "https://example.test", at: minutesAgo(5), protocol: "http" as const };
    const v = hirePath(stranger({ liveness: "not-agent", probe: site, quote: null, priceLabel: null }), { now: NOW });
    expect(v).toMatchObject({ ok: false, short: "No agent protocol" });
    // A bidder in this market is reached through the contract, so its plain answer is enough for a job.
    const bidding = hirePath(stranger({ liveness: "not-agent", probe: site, quote: null, priceLabel: null }), {
      now: NOW,
      bidders: new Set(["0x1111111111111111111111111111111111111111"]),
      jobsOpen: true,
    });
    expect(bidding.ok).toBe(true);
    expect(primaryRail(bidding)).toEqual({ kind: "mandate" });
  });

  it("says why it will not call an endpoint, rather than that there is none", () => {
    const v = hirePath(
      stranger({ liveness: "no-endpoint", probe: { answered: false, status: null, latencyMs: null, endpoint: "http://x.test", refused: true, error: "we only call https, and that is http" } }),
      { now: NOW },
    );
    expect(v).toMatchObject({ ok: false, short: "Endpoint we will not call" });
    expect(v.reason).toMatch(/we only call https/);
  });

  it("refuses an agent whose own server contradicts its card, naming what it offers", () => {
    const v = hirePath(
      { ...stranger({ probe: { answered: true, status: 200, latencyMs: 80, endpoint: "https://x.test/mcp", at: minutesAgo(5), protocol: "mcp", tools: [{ name: "getWeather" }] } }), category: "grid-trading" },
      { now: NOW },
    );
    expect(v).toMatchObject({ ok: false, short: "Tools do not fit its job" });
    expect(v.reason).toMatch(/offers getWeather/);
  });

  it("knows the answer is not 'now' after fifteen minutes, while still offering the hire", () => {
    const v = hirePath(stranger({ probe: { answered: true, status: 402, latencyMs: 1, endpoint: "x", at: minutesAgo(40) } }), { now: NOW });
    expect(v.ok).toBe(true);
    expect(v.answeringNow).toBe(false);
  });

  describe("an outside seller that sells escrowed jobs", () => {
    const escrowQuote = (unpayable: string | null = null) => ({
      a2a: "https://seller.test/a2a",
      provider: "0x73809F69916FcF7Ddc5BB1315fBdf96A569a5963" as const,
      price: "100000000000000000",
      service: "health_factor",
      serviceName: null,
      needs: null,
      etaSeconds: 120,
      at: minutesAgo(5),
      unpayable,
    });
    const seller = (unpayable: string | null = null) =>
      stranger({ quote: null, priceLabel: null, escrowQuote: escrowQuote(unpayable), probe: { answered: true, status: 200, latencyMs: 80, endpoint: "https://seller.test/a2a", at: minutesAgo(5), protocol: "a2a" } });

    it("is offered an escrowed job, and the job leads", () => {
      const v = hirePath(seller(), { now: NOW, escrowMissed: new Map() });
      expect(v.ok).toBe(true);
      expect(v.rails[0]).toMatchObject({ kind: "escrow", price: "0.1 $U" });
      expect(primaryRail(v)?.kind).toBe("escrow");
      expect(hireHref("999999001", v)).toBe("/agents/999999001#call");
    });

    it("is not offered one it prices in a token the escrow does not take", () => {
      const v = hirePath(seller("it wants USD1, and the escrow here pays in $U"), { now: NOW, escrowMissed: new Map() });
      expect(v).toMatchObject({ ok: false, short: "Its price is in a token we cannot pay" });
    });

    it("is taken off sale after a job passes its deadline undelivered", () => {
      const v = hirePath(seller(), { now: NOW, escrowMissed: new Map([["999999001", { jobId: "56900", at: minutesAgo(60) }]]) });
      expect(v).toMatchObject({ ok: false, short: "Missed an escrowed job" });
      expect(v.reason).toMatch(/#56900/);
    });
  });
});

describe("a failed paid call costs only what failed", () => {
  const failed = new Map([
    [
      "999999001",
      { tokenId: "999999001", delivered: 0, paidNotDelivered: 0, refused: 1, lastAt: new Date(NOW - 3 * 3600_000).toISOString(), lastWhy: "it answered 402 to the signed payment: {}", lastTx: null, lastFailed: true },
    ],
  ]);
  const escrowQuote = {
    a2a: "https://seller.test/a2a",
    provider: "0x73809F69916FcF7Ddc5BB1315fBdf96A569a5963" as const,
    price: "100000000000000000",
    service: null,
    serviceName: null,
    needs: null,
    etaSeconds: 120,
    at: minutesAgo(5),
    unpayable: null,
  };

  it("keeps an escrowed job on offer, where the buyer's money comes back if no work does", () => {
    const v = hirePath(stranger({ escrowQuote }), { now: NOW, outcomes: failed, escrowMissed: new Map() });
    expect(v.ok).toBe(true);
    expect(v.rails.map((r) => r.kind)).toEqual(["escrow"]);
  });

  it("withdraws the paid call, and says why when nothing else is left", () => {
    const v = hirePath(stranger(), { now: NOW, outcomes: failed });
    expect(v.ok).toBe(false);
    expect(v.short).toBe("Refused a correct payment");
  });
});

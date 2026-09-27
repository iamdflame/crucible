import { describe, expect, it } from "vitest";
import { fillNeeds } from "../conformance/hires";
import { DEMO_ADDRESS } from "../demo";
import { WBNB } from "../chain/prices";
import { errorOnly, gridToken, judge } from "../conformance/run";

describe("paid checks: what a plain seller is sent", () => {
  it("fills a seller's needs for the public test account, the WBNB/USDT pool and round sizes", () => {
    expect(fillNeeds({ address: "the account whose position to read (0x…)" }, null)).toEqual({ address: DEMO_ADDRESS });
    expect(fillNeeds({ token: "the token or pool to grid (0x…)", levels: "number of levels, optional", bandPct: "range as ± percent, optional", capitalUsd: "total capital, optional" }, null)).toEqual({
      token: WBNB,
      levels: "10",
      bandPct: "8",
      capitalUsd: "1000",
    });
    expect(fillNeeds({ token: "the token to compare (0x…)" }, null)).toEqual({ token: WBNB });
  });

  it("leaves out what is optional and unknown, and refuses what it would have to invent", () => {
    expect(fillNeeds({ from: "the Venus market held today, optional", amountUsd: "position size in USD, optional" }, null)).toEqual({ amountUsd: "1000" });
    expect(fillNeeds({ holdings: "array of { token: \"0x…\", usd: 1000 }" }, null)).toBeNull();
    expect(fillNeeds(null, null)).toEqual({});
  });
});

describe("paid checks: judged fairly", () => {
  it("reads an answer that says it failed as an error, not as a wrong answer", () => {
    expect(errorOnly({ category: "grid", ok: false, error: "price must be a finite number", hint: "expected params" })).toBe("price must be a finite number");
    expect(errorOnly({ error: "unknown skill" })).toBe("unknown skill");
    expect(errorOnly({ ok: true, healthFactor: 2 })).toBeNull();
  });

  it("does not fail a grid planned for another token: that answers another question", () => {
    const usdtPlan = { result: { plan: { token: { symbol: "USDT", address: "0x55d3" }, grid: { prices: [{ price: 0.92 }, { price: 1.08 }] } } } };
    expect(gridToken(usdtPlan)).toBe("USDT");
    const ref = { hf: null, positions: [], venusUsdtAprPct: null, grid: { lower: 713, upper: 837, levels: 10, capital: 1000 }, block: 1 };
    expect(judge("grid-trading", usdtPlan, ref).verdict).toBe("not-comparable");
    expect(gridToken({ levels: [{ price: 713 }] })).toBeNull();
  });
});

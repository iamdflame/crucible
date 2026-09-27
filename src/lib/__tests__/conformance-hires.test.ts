import { describe, expect, it } from "vitest";
import { fillNeeds } from "../conformance/hires";
import { DEMO_ADDRESS } from "../demo";
import { WBNB, WBNB_USDT_POOL } from "../chain/prices";

describe("paid checks: what a plain seller is sent", () => {
  it("fills a seller's needs for the public test account, the WBNB/USDT pool and round sizes", () => {
    expect(fillNeeds({ address: "the account whose position to read (0x…)" }, null)).toEqual({ address: DEMO_ADDRESS });
    expect(fillNeeds({ token: "the token or pool to grid (0x…)", levels: "number of levels, optional", bandPct: "range as ± percent, optional", capitalUsd: "total capital, optional" }, null)).toEqual({
      token: WBNB_USDT_POOL,
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

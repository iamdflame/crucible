import { describe, expect, it } from "vitest";
import { decide, describe as words, message, validThreshold, type Reading } from "../alerts/watch";

const H = 3_600_000;
const r = (over: Partial<Reading>): Reading => ({ state: "ok", hf: 1.8, collateralUsd: 1200, debtUsd: 500, shortfallUsd: 0, ...over });

describe("liquidation alerts", () => {
  it("speaks when a loan gets worse, not on every tick", () => {
    expect(decide("ok", "low", null)).toBe("worse");
    expect(decide("low", "danger", 0)).toBe("worse");
    expect(decide(null, "liquidatable", null)).toBe("worse");
    expect(decide("ok", "ok", null)).toBeNull();
    expect(decide("none", "none", null)).toBeNull();
  });

  it("repeats a low loan twice a day and a dangerous one every two hours", () => {
    const now = 100 * H;
    expect(decide("low", "low", now - 2 * H, now)).toBeNull();
    expect(decide("low", "low", now - 13 * H, now)).toBe("again");
    expect(decide("danger", "danger", now - 1 * H, now)).toBeNull();
    expect(decide("danger", "danger", now - 3 * H, now)).toBe("again");
  });

  it("says once when a loan recovers or is repaid, and nothing when it cannot be read", () => {
    expect(decide("low", "ok", 0)).toBe("recovered");
    expect(decide("danger", "none", 0)).toBe("repaid");
    expect(decide("low", "unread", 0)).toBeNull();
  });

  it("tells the watcher how far collateral can fall, and offers both ways out", () => {
    const m = message("worse", "0x003911a1DD39D21de18A4A54A8af8692cB62A301", 1.3, r({ state: "low", hf: 1.25 }));
    expect(m.text).toMatch(/Health factor 1\.25 on 0x0039…A301, below your 1\.30/);
    expect(m.text).toMatch(/lost about 20% of its value/);
    expect(m.buttons.map((b) => b.text)).toEqual(["Open Venus", "Let Guard-1 repay for me"]);
    expect(message("worse", "0x003911a1DD39D21de18A4A54A8af8692cB62A301", 1.3, r({ state: "liquidatable", hf: 0.97, shortfallUsd: 12.5 })).text).toMatch(/can be liquidated now, short by \$12\.50/);
    expect(words(r({ state: "none", hf: null }))).toBe("no Venus loan");
  });

  it("accepts only levels that leave time to act", () => {
    expect(validThreshold(1.3)).toBe(true);
    expect(validThreshold(1.0)).toBe(false);
    expect(validThreshold(5)).toBe(false);
    expect(validThreshold(Number.NaN)).toBe(false);
  });
});

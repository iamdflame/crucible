import { describe, expect, it } from "vitest";
import { asData, checkGrid, checkHealth, checkRange, checkYield } from "../conformance/checks";

// Answers as Marque's agents gave them on 27 Sep 2026, for the demo account.
const KEEL = '{"healthFactor":6.659,"primaryCollateralSymbol":"USDT","primaryCollateralFactor":0.8,"repayUsdToReachTarget":0}';
const BOUND = { currentTick: -66546, inRange: false, pctToNearestBound: 6.15, proposedTickLower: -66650, proposedTickUpper: -66450 };
const SLUICE = { recommend: true, venue: "venus", netAprPct: 3.1337, aprSources: [{ value: 3.136, source: "Venus vUSDT supplyRatePerBlock" }] };
const LATTICE = { spacingType: "geometric", levels: [714, 726.8, 739.9, 753.1, 766.7, 780.4, 794.4, 808.7, 823.2, 838].map((price) => ({ price, allocationUsd: 100 })) };

describe("MANDATE conformance checks", () => {
  it("reads an answer given as JSON text, JSON in prose, or data", () => {
    expect(asData(KEEL)).toMatchObject({ healthFactor: 6.659 });
    expect(asData('The result: {"healthFactor": 2}')).toMatchObject({ healthFactor: 2 });
    expect(asData("no data here")).toBeNull();
  });

  it("passes a health factor within 2% of the Comptroller's and fails one outside it", () => {
    expect(checkHealth(KEEL, { hf: 6.66 }).verdict).toBe("pass");
    expect(checkHealth(KEEL, { hf: 7.2 }).verdict).toBe("fail");
    expect(checkHealth('{"note":"no loan"}', { hf: null }).verdict).toBe("pass");
    expect(checkHealth('{"status":"ok"}', { hf: 3.1 }).checks[0]?.theirs).toBe("none given");
  });

  it("checks range status and the pool's tick, and says when there is nothing to compare", () => {
    expect(checkRange(BOUND, { positions: [{ tokenId: "1", inRange: false, tick: -66540 }] }).verdict).toBe("pass");
    expect(checkRange(BOUND, { positions: [{ tokenId: "1", inRange: true, tick: -66560 }] }).verdict).toBe("fail");
    expect(checkRange(BOUND, { positions: [] }).verdict).toBe("not-comparable");
  });

  it("compares a Venus USDT rate within 25%, and leaves other venues uncompared", () => {
    expect(checkYield(SLUICE, { venusUsdtAprPct: 3.2 }).verdict).toBe("pass");
    expect(checkYield(SLUICE, { venusUsdtAprPct: 21 }).verdict).toBe("fail");
    expect(checkYield({ vaults: [{ apr: "0.037" }] }, { venusUsdtAprPct: 3.2 }).verdict).toBe("not-comparable");
    expect(checkYield({ market: "venus", supply_apy_pct: 0.031 }, { venusUsdtAprPct: 3.2 }).checks[0]?.theirs).toBe("3.1%");
  });

  it("holds a grid to its bounds, level count, order and capital", () => {
    const ref = { lower: 714, upper: 838, levels: 10, capital: 1000 };
    expect(checkGrid(LATTICE, ref).verdict).toBe("pass");
    expect(checkGrid(LATTICE, { ...ref, upper: 800 }).checks.find((c) => c.field === "levels inside the bounds")?.pass).toBe(false);
    expect(checkGrid(LATTICE, { ...ref, capital: 500 }).verdict).toBe("fail");
    expect(checkGrid({ error: "no band" }, ref).verdict).toBe("fail");
  });
});

describe("an agent that answers with an error", () => {
  it("could not be checked, which is not the same as failing", async () => {
    const { errorOnly, judge } = await import("../conformance/run");
    const answer = '{"error":"unknown skill: undefined","skills":["negotiate","notify_funded"],"hint":"send a data part"}';
    expect(errorOnly(answer)).toBe("unknown skill: undefined");
    const ref = { hf: 6.66, positions: [], venusUsdtAprPct: 3.1, grid: { lower: 1, upper: 2, levels: 10, capital: 1000 }, block: 1 };
    expect(judge("health-factor", answer, ref).verdict).toBe("unreadable");
    expect(judge("grid-trading", '{"error":"no band","need":"a price band"}', ref).verdict).toBe("unreadable");
    expect(errorOnly('{"healthFactor": 2, "error": null}')).toBeNull();
  }, 60_000);
});

describe("an answer taken hours before our reading", () => {
  it("is held to what does not drift by the minute", () => {
    const answer = { currentTick: -66540, inRange: false };
    const ref = { positions: [{ tokenId: "1", inRange: false, tick: -66580 }] };
    expect(checkRange(answer, ref).verdict).toBe("fail");
    expect(checkRange(answer, ref, { aged: true }).verdict).toBe("pass");
    expect(checkHealth('{"healthFactor": 6.4}', { hf: 6.66 }).verdict).toBe("fail");
    expect(checkHealth('{"healthFactor": 6.4}', { hf: 6.66 }, { aged: true }).verdict).toBe("pass");
  });
});

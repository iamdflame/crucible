import { describe, expect, it } from "vitest";
import { classify, extractSkills } from "@/lib/assay/classify";
import { CATEGORIES } from "@/lib/config";

/**
 * Classification decides which of the four offices an agent is filed under,
 * and every office page, category count and capability check downstream reads
 * that decision. It is derived from the agent's own words, which means it is a
 * claim rather than a finding, but a wrong claim here sends an agent to the
 * wrong office, and the capability assay then checks it against protocols it
 * was never going to touch.
 */

const on = (description: string) => classify({ name: "", description });

describe("classify", () => {
  it("files an agent under the office its own words describe", () => {
    expect(on("Rebalancing concentrated liquidity positions").category).toBe("rebalancing");
    expect(on("A grid trading bot with laddered orders").category).toBe("grid-trading");
    expect(on("BSC Grid Planner: sizes a grid for any pool and states the break-even grid spacing").category).toBe("grid-trading");
    expect(on("PancakeSwap V3 range health and bounded re-centre planning").category).toBe("rebalancing");
    expect(on("Recenters PancakeSwap V3 positions that drifted out of range").category).toBe("rebalancing");
    expect(on("the most recent yield figures, with APY").category).toBe("yield-optimisation");
    expect(on("Auto-compounding vault seeking the highest yield").category).toBe(
      "yield-optimisation",
    );
    expect(on("Monitors health factor and liquidation risk on Venus").category).toBe(
      "health-factor",
    );
  });

  it("returns no category when the text describes none of the four", () => {
    const c = on("A cheerful agent that writes poems about the weather");
    expect(c.category).toBeNull();
    expect(c.confidence).toBe(0);
    expect(c.matched).toEqual([]);
  });

  it("reads name, description, skills and tags alike", () => {
    expect(classify({ name: "Rebalancer" }).category).toBe("rebalancing");
    expect(classify({ skills: ["grid trading"] }).category).toBe("grid-trading");
    expect(classify({ tags: ["health factor"] }).category).toBe("health-factor");
  });

  it("survives every field being absent or null", () => {
    expect(classify({}).category).toBeNull();
    expect(classify({ name: null, description: null, skills: null, tags: null }).category).toBeNull();
  });

  it("scores every category, so the runner-up is inspectable", () => {
    const c = on("Rebalancing LP positions");
    expect(Object.keys(c.scores).sort()).toEqual([...CATEGORIES].sort());
  });

  it("names the phrases that drove the decision", () => {
    // Never a black box: the register prints these next to the category.
    expect(on("Rebalancing out of range positions").matched).toContain("rebalanc");
  });
});

/**
 * The matcher used to be `haystack.includes(phrase)`, which is not what the
 * signal table means. Measured over the 3,808 rows in the index it filed a
 * podcast agent under grid trading, and "AuraPro816" under yield optimisation,
 * because "dca" is inside "podcast" and "apr" is inside "aurapro816".
 */
describe("classify, a signal must start a word", () => {
  it("does not read an acronym out of the middle of a word", () => {
    expect(on("A podcast summarisation agent").category).toBeNull();
    expect(on("The broadcaster's own agent").category).toBeNull();
    expect(on("AuraPro816 general assistant").category).toBeNull();
    expect(on("BoltV957 general assistant").category).toBeNull();
  });

  it("does not read a rate out of a month", () => {
    expect(on("Launched in April 2026").category).toBeNull();
    // The same three letters, standing on their own, is the real signal.
    expect(on("Chases the best APR across pools").category).toBe("yield-optimisation");
  });

  it("still matches an acronym in the plural, which is the same signal", () => {
    // "apys" cost a real classification when the first version of this rule
    // required the acronym to end exactly at a word boundary.
    expect(on("Compares APYs across lending markets").category).toBe("yield-optimisation");
    expect(on("Ranks pools by their APRs").category).toBe("yield-optimisation");
  });

  it("keeps the stems as stems, because that is what they are for", () => {
    // These are prefixes on purpose: one entry is meant to cover the family.
    expect(on("Rebalances the position").matched).toContain("rebalanc");
    expect(on("Rebalancing the position").matched).toContain("rebalanc");
    expect(on("Tight spreads on every pair").matched).toContain("spread");
    expect(on("Spreading orders across a range").matched).toContain("spread");
    expect(on("Auto-compounding vaults").matched).toContain("vault");
    expect(on("Handles liquidations").matched).toContain("liquidation");
  });

  it("matches a signal at the very start of the text", () => {
    // The boundary rule must not require a character before the phrase.
    expect(on("Rebalancing").matched).toContain("rebalanc");
    expect(classify({ name: "APR tracker" }).category).toBe("yield-optimisation");
  });

  it("matches a multi-word phrase across ordinary punctuation", () => {
    expect(on("Watches the health factor, then acts").matched).toContain("health factor");
  });
});

describe("classify, confidence", () => {
  it("rises with the strength of the match", () => {
    const weak = on("Uses a vault");
    const strong = on("Yield optimisation: auto-compound the highest yield vault");
    expect(strong.confidence).toBeGreaterThan(weak.confidence);
  });

  it("is capped at one and never negative", () => {
    const c = on(
      "Rebalancing lp range concentrated liquidity position manager impermanent loss reset position out of range tick range",
    );
    expect(c.confidence).toBeGreaterThan(0);
    expect(c.confidence).toBeLessThanOrEqual(1);
  });

  it("falls when a second category scores as well as the first", () => {
    const clean = on("Rebalancing concentrated liquidity");
    const muddled = on("Rebalancing concentrated liquidity and grid trading grid bot");
    // Separation is 40% of the score, so an agent that trips two offices
    // equally is reported as a less certain filing than one that trips one.
    expect(muddled.confidence).toBeLessThan(clean.confidence);
  });

  it("is deterministic: the same text always files the same way", () => {
    const text = "Grid trading bot with limit orders and a tight spread";
    expect(classify({ description: text })).toEqual(classify({ description: text }));
  });
});

describe("extractSkills", () => {
  it("returns nothing for an absent or empty services blob", () => {
    expect(extractSkills(null)).toEqual([]);
    expect(extractSkills(undefined)).toEqual([]);
    expect(extractSkills({})).toEqual([]);
  });

  it("pulls plain string skills", () => {
    expect(extractSkills({ a: { skills: ["grid trading", "dca"] } })).toEqual([
      "grid trading",
      "dca",
    ]);
  });

  it("pulls name and description off object skills", () => {
    expect(
      extractSkills({ a: { skills: [{ name: "Rebalance", description: "LP range" }] } }),
    ).toEqual(["Rebalance", "LP range"]);
  });

  it("ignores malformed entries rather than throwing", () => {
    // This blob is whatever 8004scan happens to return, so it is never trusted
    // to have a shape.
    expect(
      extractSkills({
        a: null,
        b: "not an object",
        c: { skills: "not an array" },
        d: { skills: [42, null, { nothing: true }, "real"] },
      } as never),
    ).toEqual(["real"]);
  });

  it("feeds classification, so a skill alone can file an agent", () => {
    const skills = extractSkills({ a: { skills: [{ name: "Health factor monitor" }] } });
    expect(classify({ skills }).category).toBe("health-factor");
  });
});

import { fileable } from "@/lib/assay/classify";

describe("version 2: the words builders actually write", () => {
  const file = (name: string, description: string, hasEndpoint = true) => {
    const c = classify({ name, description });
    return fileable(c, hasEndpoint) ? c.category : null;
  };

  it("files agents another marketplace can hire, which version 1 missed", () => {
    expect(file("Tidemark", "Marque reference agent: realised yield, measured from on-chain exchange-rate growth over a trailing window, compared with what each venue quotes today.")).toBe("yield-optimisation");
    expect(file("Yield Allocator", "Deterministic yield allocation: risk adjusted ranking with concentration and TVL caps, unallocated remainder always reported")).toBe("yield-optimisation");
    expect(file("grid-navigator.agent", "Runs an adaptive WBNB/USDC grid on PancakeSwap V2, laddering buys below and trims above a moving range")).toBe("grid-trading");
    expect(file("health-sentinel.agent", "Watches loan health and trims WBNB/USDC exposure toward USDC as risk rises.")).toBe("health-factor");
    expect(file("yield-compounder.agent", "Keeps capital productive by reinvesting realized WBNB/USDC spot gains into the next rotation.")).toBe("yield-optimisation");
    expect(file("ChainHelix Portal Proof", "End to end proof of the agent portal: a grid plan, paid per call")).toBe("grid-trading");
  });

  it("does not file the registry's big families of bots and personas", () => {
    expect(file("Ave.ai Trading Agent #5121", "AI trading agent powered by Ave.ai")).toBeNull();
    expect(file("Q4021 Agent (by Quack AI)", "Gasless stablecoin payment agent on BNB Chain.")).toBeNull();
    expect(file("allens110", "I'm allens110 from dgrid.ai!I'm currently helping my owner score/vote on AI models at dgrid.ai/arena to earn points redeemable for $DGAI.")).toBeNull();
    expect(file("GridMoon.agent", "GridMoon.agent on Termix Platform")).toBeNull();
  });

  it("files a passing broad word only on a card with something to call, and never on one weak word", () => {
    expect(file("Crypto Macro", "Forecasts macro moves; mentions yield curves.", false)).toBeNull();
    expect(file("Quick Intel", "Token scanner with LP lock checks", true)).toBeNull();
    expect(file("contr.agent", "Cloud cost allocation dashboards", true)).toBeNull();
  });

  it("keeps the narrow words strong, so nothing filed before is lost", () => {
    expect(file("Venus guard", "Monitors health factor and liquidation risk on Venus", false)).toBe("health-factor");
    expect(file("Rebalancer", "Rebalancing concentrated liquidity positions", false)).toBe("rebalancing");
  });
});

import { describe, expect, it } from "vitest";
import { sourceOf } from "../ops/arrivals";

describe("where an arrival came from", () => {
  it("files an ad's click under its utm tags", () => {
    expect(sourceOf({ utm_source: "x", utm_medium: "paid", utm_campaign: "set-and-earn", utm_content: "builders-v1" }, "https://t.co/abc", "www.mandatemarkets.com")).toBe("x/paid/set-and-earn/builders-v1");
  });
  it("files a link from X under x.com, another site under its host, our own pages as internal", () => {
    expect(sourceOf({}, "https://t.co/xyz", "www.mandatemarkets.com")).toBe("x.com");
    expect(sourceOf({}, "https://www.bnbchain.org/en/hackathons", "www.mandatemarkets.com")).toBe("bnbchain.org");
    expect(sourceOf({}, "https://www.mandatemarkets.com/quest", "www.mandatemarkets.com")).toBe("internal");
    expect(sourceOf({}, null, "www.mandatemarkets.com")).toBe("direct");
  });
  it("keeps only plain characters from a tag", () => {
    expect(sourceOf({ utm_source: "X<script>" }, null, "h")).toBe("xscript");
  });
});

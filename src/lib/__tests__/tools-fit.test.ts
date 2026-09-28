import { describe, expect, it } from "vitest";
import { toolsFit } from "../assay/tools";

describe("toolsFit: what an agent's software offers against the job its card claims", () => {
  it("does not hold BNB's SDK protocol skills against the job: they say how it is hired, not what it does", () => {
    const sdk = [{ name: "Negotiate an ERC-8183 job" }, { name: "Notify the seller a job is funded" }, { name: "ERC-8183 job status" }];
    expect(toolsFit("rebalancing", sdk as never).state).toBe("none");
    expect(toolsFit("grid-trading", [{ name: "negotiate" }, { name: "notify_funded" }] as never).state).toBe("none");
  });

  it("still names a real mismatch, and still sees a fitting tool beside the protocol ones", () => {
    expect(toolsFit("health-factor", [{ name: "generate_image" }, { name: "negotiate" }] as never).state).toBe("mismatch");
    expect(toolsFit("health-factor", [{ name: "get_health_factor" }, { name: "negotiate" }] as never).state).toBe("fits");
  });
});

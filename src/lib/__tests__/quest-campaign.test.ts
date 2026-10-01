import { describe, expect, it } from "vitest";
import { countedHires, type HireRow } from "../market/tracking";

const row = (agentId: string, o: Partial<HireRow> = {}): HireRow => ({
  kind: "paid-call",
  agentId,
  agentName: `Agent ${agentId}`,
  category: "health-factor",
  tx: `0x${agentId}`,
  block: 1,
  contract: null,
  jobId: null,
  amount: "1",
  asset: null,
  completed: true,
  onChain: true,
  at: "2026-10-01T10:00:00Z",
  sponsored: false,
  ...o,
});

describe("Set and Earn: the hires that count", () => {
  it("counts each different agent once, the earliest hire standing for it", () => {
    const c = countedHires([row("1", { at: "2026-10-02T00:00:00Z", tx: "0xlate" }), row("1", { at: "2026-10-01T00:00:00Z", tx: "0xearly" }), row("2")], []);
    expect(c.map((h) => h.agentId)).toEqual(["1", "2"]);
    expect(c[0]!.tx).toBe("0xearly");
  });

  it("leaves out hires not confirmed on chain, calls MANDATE paid for, and the wallet's own agents", () => {
    const c = countedHires([row("1", { onChain: false }), row("2", { sponsored: true }), row("3"), row("4")], ["3"]);
    expect(c.map((h) => h.agentId)).toEqual(["4"]);
  });
});

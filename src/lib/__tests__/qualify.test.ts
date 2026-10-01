import { describe, expect, it } from "vitest";
import { fitsJob, kindOf } from "../campaign/qualify";
import { PROTOCOLS } from "../config";
import { ESCROW } from "../escrow/contracts";

describe("Set and Earn: what an agent's transaction did", () => {
  it("reads lending, trades, positions and vault deposits from the contract or the function called", () => {
    expect(kindOf(PROTOCOLS.venusVUSDT, "0xa0712d68" + "0".repeat(64))).toBe("lending");
    expect(kindOf("0x0000000000000000000000000000000000000001", "0x0e752702" + "0".repeat(64))).toBe("lending");
    expect(kindOf(PROTOCOLS.pancakeV3Router, "0x04e45aaf")).toBe("trade");
    expect(kindOf(PROTOCOLS.pancakeV3PositionManager, "0x88316456")).toBe("position");
    expect(kindOf("0x0000000000000000000000000000000000000002", "0x6e553f65")).toBe("vault");
  });

  it("sets apart deliveries to a marketplace, approvals and plain transfers", () => {
    expect(kindOf(ESCROW.commerce, "0x12345678")).toBe("delivery");
    expect(kindOf("0x0000000000000000000000000000000000000003", "0x095ea7b3")).toBe("approval");
    expect(kindOf("0x0000000000000000000000000000000000000003", "0x")).toBe("transfer");
    expect(kindOf("0x0000000000000000000000000000000000000003", "0xdeadbeef")).toBe("other");
    expect(kindOf("0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", "0x8ea42286")).toBe("registry");
  });

  it("holds each job to the work BNB Chain names for it", () => {
    expect(fitsJob("yield-optimisation", "lending")).toBe(true);
    expect(fitsJob("yield-optimisation", "vault")).toBe(true);
    expect(fitsJob("health-factor", "lending")).toBe(true);
    expect(fitsJob("health-factor", "trade")).toBe(false);
    expect(fitsJob("grid-trading", "trade")).toBe(true);
    expect(fitsJob("rebalancing", "position")).toBe(true);
    expect(fitsJob("rebalancing", "delivery")).toBe(false);
    expect(fitsJob(null, "lending")).toBe(false);
  });
});

/**
 * When the trial pool pays a failed seller again: a refusal waits two days, a
 * seller that took the money and delivered nothing waits a week, and three of
 * those in a row stop the automatic retests.
 */

import { describe, expect, it, vi } from "vitest";
import type { PaidCallRecord } from "../market/paid-calls";

vi.mock("@/lib/db/client", () => ({ sql: null, db: null, hasDb: false }));

const { retestWait } = await import("../market/test-buys");

const DAY = 86_400_000;
const call = (at: string, o: Partial<PaidCallRecord>): PaidCallRecord => ({ id: `x:${at}`, tokenId: "1", at, paid: false, delivered: false, fault: "seller", ...o }) as PaidCallRecord;

describe("retestWait", () => {
  it("waits two days after a refusal", () => {
    expect(retestWait([call("2026-10-01", {})], "1")).toBe(2 * DAY);
  });

  it("waits a week once a seller took the money and delivered nothing", () => {
    expect(retestWait([call("2026-10-01", { paid: true })], "1")).toBe(7 * DAY);
  });

  it("stops paying on a timer after three such in a row", () => {
    const three = ["2026-09-25", "2026-10-08", "2026-10-10"].map((at) => call(at, { paid: true }));
    expect(retestWait(three, "1")).toBeNull();
  });

  it("counts from the last delivery, and leaves out failures we caused", () => {
    const calls = [
      call("2026-09-20", { paid: true }),
      call("2026-09-21", { paid: true }),
      call("2026-09-22", { paid: true, delivered: true, fault: null }),
      call("2026-10-06", { fault: "ours" }),
      call("2026-10-08", { paid: true }),
    ];
    expect(retestWait(calls, "1")).toBe(7 * DAY);
  });

  it("waits a week after three refusals in a row", () => {
    expect(retestWait(["2026-10-01", "2026-10-03", "2026-10-05"].map((at) => call(at, {})), "1")).toBe(7 * DAY);
  });
});

/**
 * One paid call a day to every outside seller a buyer could hire here.
 *
 * The hire law pulls a seller whose last paid call took the money and failed.
 * Waiting for a buyer to find that out costs the buyer. So once a day our
 * trial pool buys one call from each hireable seller we do not run, on the
 * same rail a buyer would use, and records it like any other paid call,
 * flagged as ours: it never counts as anybody's hire, and a failure is
 * attributed to the seller only when the seller is at fault.
 *
 * Capped per call and per day, and skipped with the reason when the pool
 * cannot pay in the seller's token.
 */

import type { Hex } from "viem";
import { payAndCall } from "@/lib/x402/pay-server";
import { recordPaidCall, toRecord, listPaidCalls, outcomes, type PaidCallRecord } from "@/lib/market/paid-calls";
import { confirmSettlement } from "@/lib/market/settlement";
import { listings } from "@/lib/market/listing";
import { hirePath } from "@/lib/market/hire-law";
import { isOurs } from "@/lib/market/judge";
import { hireCounts } from "@/lib/market/hires";
import { inputsFor, withInputs } from "@/lib/market/inputs";
import { previewFor } from "@/lib/market/quotes";
import { DEMO_ADDRESS } from "@/lib/demo";

/** The most one test call may cost, and all of them together in a day, in the token's own units (18 decimals). */
const PER_CALL = 100_000_000_000_000_000n; // 0.10
const PER_DAY = 1_000_000_000_000_000_000n; // 1.00
const EVERY_MS = 20 * 3_600_000;
/** A seller whose last paid call failed is paid again after this, so the hire law's "comes back once it delivers" can come true. */
const RETRY_AFTER_MS = 48 * 3_600_000;
/** After three failures in a row, once a week. */
const RETRY_SLOW_MS = 7 * 24 * 3_600_000;

/**
 * How long to wait before paying a seller pulled for a failed paid call
 * again, or null when it is not paid again on a timer at all. Pure, for tests.
 *
 * A seller that took the payment and delivered nothing is not paid on a
 * timer like one that refused: Agripinaa's six agents took 0.05 USDT ten
 * times between 8 and 10 Oct, each time failing to read their own receipt,
 * and emptied the trial pool's top-up. So any such failure waits a week, and
 * three in a row stop the automatic retests: a person retests by hand once
 * something about the seller changes. Failures we caused are left out.
 */
export function retestWait(calls: PaidCallRecord[], tokenId: string): number | null {
  let streak = 0;
  let tookAndFailed = 0;
  for (const c of calls.filter((x) => x.tokenId === tokenId && x.fault !== "ours").sort((a, b) => b.at.localeCompare(a.at))) {
    if (c.paid && c.delivered) break;
    streak += 1;
    if (c.paid) tookAndFailed += 1;
  }
  if (tookAndFailed >= 3) return null;
  return tookAndFailed > 0 || streak >= 3 ? RETRY_SLOW_MS : RETRY_AFTER_MS;
}

export async function testBuys(opts: { budgetMs: number }): Promise<string> {
  const raw = process.env.AGENT_A_KEY;
  if (!raw) return "no trial pool key on this deployment";
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  const started = Date.now();
  const calls = await listPaidCalls().catch(() => []);
  const since = Date.now() - 24 * 3_600_000;
  let spent = calls.filter((c) => c.note?.startsWith("Daily test purchase") && Date.parse(c.at) > since).reduce((s, c) => s + BigInt(c.amount ?? "0"), 0n);
  const counts = await hireCounts().catch(() => null);
  const past = outcomes(calls);
  const due = listings(counts?.byTokenId, counts?.settled).filter((l) => {
    if (isOurs(l) || !l.quote?.payable) return false;
    const last = calls.find((c) => c.tokenId === l.tokenId);
    const v = hirePath(l);
    if (v.ok && v.rails.some((r) => r.kind === "x402")) return !last || Date.now() - Date.parse(last.at) > EVERY_MS;
    /*
      Pulled for a failed paid call, and otherwise ready: answering now, with
      a price we can pay. It was never paid again, so it could never come
      back (16 sellers by 6 Oct). It is tried again after two days; after
      three failures in a row, or any that took the money, once a week (see
      retestWait). The wait runs from our last attempt of any kind: one that
      failed on our side, an input we could not supply, used to leave the
      clock where it was, and Brain on BNB's grid planner was asked twelve
      times in three days.
    */
    const o = past.get(l.tokenId);
    if (!o?.lastFailed || !last || l.liveness !== "live") return false;
    const wait = retestWait(calls, l.tokenId);
    return wait !== null && Date.now() - Date.parse(last.at) > wait;
  });
  const out: string[] = [];
  for (const l of due) {
    if (Date.now() - started > opts.budgetMs) break;
    const price = BigInt(l.quote!.amount);
    if (price > PER_CALL) {
      out.push(`#${l.tokenId}: priced over the test cap`);
      continue;
    }
    if (spent + price > PER_DAY) {
      out.push("daily cap reached");
      break;
    }
    // The agent's declared inputs, filled with the demo account where it asks for a wallet; anything else, skipped.
    const inputs = inputsFor(l.tokenId, previewFor(l.tokenId));
    if (inputs.some((i) => i.required && i.kind !== "wallet")) {
      out.push(`#${l.tokenId}: needs an input we cannot choose for it`);
      continue;
    }
    const url = withInputs(l.quote!.endpoint, Object.fromEntries(inputs.filter((i) => i.kind === "wallet").map((i) => [i.name, DEMO_ADDRESS])));
    try {
      const call = await payAndCall({ url, key, maxAmount: PER_CALL, settleWaitMs: 20_000 });
      if (call.payerShort) {
        // Nothing was offered, so nothing is recorded: the seller is tried again once the pool is topped up.
        out.push(`#${l.tokenId}: the trial pool holds less than its price`);
        continue;
      }
      const rec = {
        ...toRecord(call, { tokenId: l.tokenId, name: l.name, category: l.category ?? "unclassified", sponsored: true, subject: DEMO_ADDRESS, evidence: null }),
        note: "Daily test purchase from MANDATE's trial pool, to keep the hire law's record current.",
      };
      const read = await confirmSettlement(rec, { waitMs: 15_000 }).catch(() => rec);
      /*
        Held against the seller: taking the money and not delivering, or
        answering a correctly signed payment in its own requested format with
        another demand for payment, which no buyer could get past either. Any
        other refusal may be about our test input, and is ours.
      */
      const askedAgain = !read.paid && /answered 402 to the signed payment/.test(read.refused ?? "");
      const checked = { ...read, fault: read.paid ? (read.delivered ? null : ("seller" as const)) : askedAgain ? ("seller" as const) : ("ours" as const) };
      await recordPaidCall(checked);
      if (checked.paid) spent += price;
      out.push(`#${l.tokenId}: ${checked.delivered ? "delivered" : "did not deliver"}${checked.paid ? ", paid" : ""}`);
    } catch (e) {
      out.push(`#${l.tokenId}: ${(e as Error).message.split("\n")[0].slice(0, 100)}`);
    }
  }
  return out.join("; ") || "no seller due";
}

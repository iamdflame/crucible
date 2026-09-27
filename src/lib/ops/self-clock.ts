/**
 * The site's second clock.
 *
 * Scheduled work (liquidation alerts, the escrow sweep that pays our agents
 * and finds jobs funded to them, agents acting on leashed wallets, test buys)
 * runs when /api/cron/tick is called. An outside pinger calls it every five
 * minutes, and a pinger fails silently: when the site moved domains on 25 Sep
 * a redirect dropped its key, and nothing ran for 2.4 days. So a page served
 * also looks, at most once a minute per instance: if no job has run for seven
 * minutes, it calls the tick itself, once, under a lease every instance
 * shares. With the pinger healthy this never fires.
 */

import { after } from "next/server";
import { lastRuns } from "@/lib/ops/history";
import { withLease } from "@/lib/db/lease";
import { SITE } from "@/lib/site";

const STALE_MS = 7 * 60_000;
let lookedAt = 0;

export function keepClock(): void {
  const secret = process.env.CRON_SECRET;
  if (!secret || Date.now() - lookedAt < 60_000) return;
  lookedAt = Date.now();
  try {
    after(async () => {
      const newest = Math.max(0, ...[...(await lastRuns()).values()].map((r) => r.at?.getTime() ?? 0));
      if (Date.now() - newest < STALE_MS) return;
      // The tick is its own function with its own 60 seconds; this waits only long enough to have started it.
      await withLease("self-clock", 240, () =>
        fetch(`${SITE}/api/cron/tick`, { headers: { authorization: `Bearer ${secret}` }, cache: "no-store", signal: AbortSignal.timeout(25_000) }).then(
          () => undefined,
          () => undefined,
        ),
      );
    });
  } catch {
    // Outside a request (a script, a test): nothing to schedule.
  }
}

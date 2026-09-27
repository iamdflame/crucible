/**
 * The clock's tick, called from outside.
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://mandate-coral.vercel.app/api/cron/tick
 *
 * Point any external pinger at this every five minutes. It decides what is
 * due (see lib/ops/schedule) rather than trusting the caller's cadence, so a
 * pinger that fires late or twice cannot double-run a job or skip one.
 *
 * Authorised callers only: the jobs write to the database and one of them
 * spends a little gas, so an open endpoint would be somebody else's budget.
 */

import { NextResponse, after } from "next/server";
import { budgetOf, dueAfterJobs, scheduleState, tick } from "@/lib/ops/schedule";
import { withLease } from "@/lib/db/lease";
import { SITE } from "@/lib/site";
import { warm } from "@/lib/data/snapshots";
import { warmRegistry } from "@/lib/registry/tail";
import { warmOutcomes } from "@/lib/market/hire-law";
import { withTimeout } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const url = new URL(request.url);
  const authorised =
    Boolean(secret) &&
    (request.headers.get("authorization") === `Bearer ${secret}` || url.searchParams.get("key") === secret);

  if (!authorised) {
    return NextResponse.json(
      { ok: false, reason: "This endpoint runs the site's scheduled work and needs CRON_SECRET.", schedule: await scheduleState() },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  /*
    Every job runs in a fresh invocation: the newest census, registry and
    paid calls first. Without this each judged from the committed files, and
    the requirements job saw no agent hireable at all.
  */
  await withTimeout(Promise.all([warm().catch(() => undefined), warmRegistry().catch(() => undefined), warmOutcomes().catch(() => undefined)]), 9_000);

  const only = url.searchParams.getAll("job");
  // The pinger's own timeout, so a call is never cut off mid-job.
  const maxMs = Math.min(50_000, Math.max(5_000, Number(url.searchParams.get("maxMs")) || 22_000));
  const force = url.searchParams.get("force") === "1";
  // One named job runs in this invocation, under a lease, so a second tick arriving meanwhile does not run it twice.
  const ran =
    only.length === 1 && budgetOf(only[0]!) !== null
      ? ((await withLease(`tick:${only[0]}`, Math.ceil(budgetOf(only[0]!)! / 1000) + 15, () => tick({ only, force, maxMs }))) ?? [
          { job: only[0]!, ok: true, ms: 0, detail: null, skipped: "already running" },
        ])
      : await tick({ only: only.length ? only : undefined, force, maxMs });
  /*
    The after-response jobs, each in its own invocation with its own 60
    seconds, the ones a customer waits on first. A function goes on running
    when its caller stops waiting, so this only waits long enough to start them.
  */
  if (!only.length) {
    after(async () => {
      const due = await dueAfterJobs().catch(() => [] as string[]);
      await Promise.allSettled(
        due.map((name) =>
          fetch(`${SITE}/api/cron/tick?job=${encodeURIComponent(name)}`, { headers: { authorization: `Bearer ${secret}` }, cache: "no-store", signal: AbortSignal.timeout(4_000) }),
        ),
      );
    });
  }
  return NextResponse.json(
    { at: new Date().toISOString(), ran, schedule: await scheduleState() },
    { headers: { "cache-control": "no-store" } },
  );
}

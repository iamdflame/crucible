/**
 * What the Set and Earn promotion is producing, day by day: people reaching
 * /check and /quest (by ad and by source), agents checked, and hires on
 * MANDATE by wallets that are not ours. Read against the ad spend to decide
 * where the next dollar goes.
 *
 *   npx tsx --env-file=.env --env-file=.env.local src/scripts/promo-report.ts [--days 7]
 */

import { sql } from "@/lib/db/client";
import { ensureTables } from "@/lib/db/tables";
import { isTeam } from "@/lib/team";
import { DEFAULT_WARM, warm } from "@/lib/data/snapshots";
import { warmRegistry } from "@/lib/registry/tail";
import { hirePath, warmOutcomes } from "@/lib/market/hire-law";
import { listings } from "@/lib/market/listing";

const days = Number(process.argv[process.argv.indexOf("--days") + 1]) || 7;

async function main() {
  if (!sql) throw new Error("no DATABASE_URL");
  await ensureTables();
  const since = `${days} days`;

  const arrivals = (await sql`
    select day::text, path, source, n from arrivals where day > current_date - ${since}::interval order by day, path, n desc`) as { day: string; path: string; source: string; n: number }[];
  const checks = (await sql`
    select day::text, count(*)::int as agents from checks_daily where day > current_date - ${since}::interval group by day order by day`) as { day: string; agents: number }[];
  const jobs = (await sql`
    select created_at::date::text as day, client, status from escrow_jobs where created_at > now() - ${since}::interval`) as { day: string; client: string; status: string }[];
  const calls = (await sql`
    select at::date::text as day, coalesce(record->>'payer', '') as payer from paid_calls where at > now() - ${since}::interval and paid and not sponsored`.catch(() => [])) as { day: string; payer: string }[];

  const byDay = new Map<string, { check: number; quest: number; sources: Map<string, number>; agents: number; hires: number; wallets: Set<string>; open: number; tried: number; paid: number }>();
  const row = (d: string) =>
    byDay.get(d) ?? byDay.set(d, { check: 0, quest: 0, sources: new Map(), agents: 0, hires: 0, wallets: new Set(), open: 0, tried: 0, paid: 0 }).get(d)!;
  // Hire steps are filed as "hire:<step>:<agent id>" (lib/ops/arrivals countStep); pages by their path.
  const steps = new Map<string, number>();
  for (const a of arrivals) {
    const r = row(a.day);
    const step = a.path.match(/^hire:(open|try|funded|paid):(\d+)$/);
    if (step) {
      if (step[1] === "open") r.open += a.n;
      else if (step[1] === "try") r.tried += a.n;
      else r.paid += a.n;
      steps.set(`${step[1]} #${step[2]}`, (steps.get(`${step[1]} #${step[2]}`) ?? 0) + a.n);
      continue;
    }
    if (a.path === "/check") r.check += a.n;
    else if (a.path === "/quest") r.quest += a.n;
    r.sources.set(a.source, (r.sources.get(a.source) ?? 0) + a.n);
  }
  for (const c of checks) row(c.day).agents = c.agents;
  for (const j of jobs) if (!isTeam(j.client)) { const r = row(j.day); r.hires += 1; r.wallets.add(j.client.toLowerCase()); }
  for (const c of calls) if (c.payer && !isTeam(c.payer)) { const r = row(c.day); r.hires += 1; r.wallets.add(c.payer.toLowerCase()); }

  console.log(`day         /check  /quest  agents checked  opened  tried  paid  hires (wallets)  top sources`);
  for (const [d, r] of [...byDay.entries()].sort()) {
    const top = [...r.sources.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([s, n]) => `${s} ${n}`).join(", ");
    console.log(
      `${d}  ${String(r.check).padStart(6)}  ${String(r.quest).padStart(6)}  ${String(r.agents).padStart(14)}  ${String(r.open).padStart(6)}  ${String(r.tried).padStart(5)}  ${String(r.paid).padStart(4)}  ${String(r.hires).padStart(5)} (${r.wallets.size})${" ".repeat(Math.max(1, 8 - String(r.wallets.size).length))}${top}`,
    );
  }
  if (steps.size) {
    console.log(`\nhire steps by agent, last ${days} days:`);
    for (const [k, n] of [...steps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(n).padStart(6)}  ${k}`);
  }
  /*
    Why each agent we list can or cannot be hired today, so a fault of ours
    (a filing rule, a price request, a failure rule) shows up the day it starts
    rather than a week later (6 Oct: 19 of 359, four of them for our reasons).
  */
  await Promise.all([warm(DEFAULT_WARM), warmRegistry().catch(() => undefined), warmOutcomes()]);
  const reasons = new Map<string, number>();
  const all = listings();
  for (const l of all) {
    const v = hirePath(l);
    const k = v.ok ? "Hireable" : (v.short ?? "No reason given").replace(/\d+ (min|h|days) ago/, "N ago");
    reasons.set(k, (reasons.get(k) ?? 0) + 1);
  }
  console.log(`\nagents listed: ${all.length}; by whether they can be hired, and why not:`);
  for (const [k, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${k}`);

  const ads = new Map<string, number>();
  for (const a of arrivals) if (/\/paid\//.test(a.source)) ads.set(a.source, (ads.get(a.source) ?? 0) + a.n);
  if (ads.size) {
    console.log(`\npaid arrivals by ad, last ${days} days:`);
    for (const [s, n] of [...ads.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${s}`);
  }
}

main().then(() => process.exit(0), (e) => { console.error((e as Error).message); process.exit(1); });

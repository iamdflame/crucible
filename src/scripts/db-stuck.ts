/**
 * Database sessions stuck in a transaction, or waiting on a lock.
 *
 *   npx tsx --env-file=.env --env-file=.env.local src/scripts/db-stuck.ts
 *   npx tsx --env-file=.env --env-file=.env.local src/scripts/db-stuck.ts --kill
 *
 * On 1 Oct a deploy whose transactions could not reserve a connection left
 * pooled sessions "idle in transaction" holding an uncommitted CREATE TABLE,
 * and every later attempt to create that table waited on them. --kill ends
 * sessions idle in a transaction for over two minutes, which rolls back
 * whatever they left uncommitted, and queries waiting over five minutes on a
 * client that has gone (a serverless instance ended mid-read).
 */

import { sql } from "@/lib/db/client";

async function main() {
  if (!sql) throw new Error("no DATABASE_URL");
  const rows = (await sql`
    select pid, state, now() - xact_start as xact_age, now() - state_change as idle_for, wait_event_type, left(query, 120) as query
    from pg_stat_activity
    where datname = current_database() and pid <> pg_backend_pid()
      and (state like 'idle in transaction%' or wait_event_type = 'Lock' or now() - xact_start > interval '1 minute')
    order by xact_start nulls last`) as { pid: number; state: string; xact_age: unknown; idle_for: unknown; wait_event_type: string | null; query: string }[];
  for (const r of rows) console.log(r.pid, r.state, "| in transaction", String(r.xact_age).slice(0, 8), "| idle", String(r.idle_for).slice(0, 8), "| waiting on", r.wait_event_type ?? "-", "|", r.query.replace(/\s+/g, " "));
  console.log(`${rows.length} stuck or waiting`);
  if (process.argv.includes("--kill")) {
    const killed = (await sql`
      select pid, pg_terminate_backend(pid) as done from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid()
        and ((state like 'idle in transaction%' and now() - state_change > interval '2 minutes')
          or (state = 'active' and wait_event_type = 'Client' and now() - state_change > interval '5 minutes'))`) as { pid: number; done: boolean }[];
    console.log("terminated:", killed.map((k) => k.pid).join(", ") || "none");
  }
}

main().then(() => process.exit(0), (e) => { console.error((e as Error).message); process.exit(1); });

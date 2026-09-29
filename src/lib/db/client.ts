/**
 * Postgres connection.
 *
 * Optional by design. With DATABASE_URL set the app reads the materialised
 * index; without it, it falls back to the committed snapshot. That keeps the
 * site deployable and demoable before any infrastructure exists, and keeps it
 * up when 8004scan returns DATABASE_ERROR, which it does under load.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;

let sql: ReturnType<typeof postgres> | null = null;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

if (url) {
  sql = postgres(url, {
    /*
      Three per instance, let go after ten idle seconds. Supabase's pooler
      takes 200 clients in all and every instance holds its own pool: at five
      each, a crawler's burst of forty page loads on 29 Sep filled it.
    */
    max: process.env.NODE_ENV === "production" ? 3 : 1,
    idle_timeout: 10,
    /*
      One query in flight per connection, never pipelined. postgres.js sends a
      query without parameters straight behind the one before it; through
      Supabase's transaction pooler those stall once more than two queue on a
      connection (measured 29 Sep: 4 of 16 finished, the rest hung), which
      hung the build's prerender and could hang a busy instance.
    */
    // @ts-expect-error: postgres.js reads max_pipeline (src/index.js) but its types leave it out.
    max_pipeline: 0,
    connect_timeout: 15,
    prepare: false, // pooled connections (Neon/Supabase pgbouncer)
    // `create table if not exists` answers with a NOTICE on every cold start;
    // postgres.js prints notices by default, which buried script output.
    onnotice: () => undefined,
  });
  dbInstance = drizzle(sql, { schema });
}

export const db = dbInstance;
export const hasDb = Boolean(dbInstance);
export { schema, sql };

export async function closeDb() {
  await sql?.end({ timeout: 5 });
}

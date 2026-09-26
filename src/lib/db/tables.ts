/**
 * Every table this deployment needs, created once, in order.
 *
 * Each module used to create its own table on first use. That is tidy until
 * several of them run inside one render: `/status` reads sessions, snapshots,
 * schedules, samples and paid calls at the same time, so five `create table if
 * not exists` statements went out concurrently over a pool of five
 * connections, took catalog locks, and waited on each other. The page stopped
 * answering at all, which is a far worse failure than a missing table, and it
 * only happened in production because only production runs them together.
 *
 * So creation happens here: one promise, one statement at a time, shared by
 * every caller and paid once per instance. Readers that arrive while it is
 * running wait for it rather than issuing their own.
 */

import { sql as pg } from "@/lib/db/client";

const STATEMENTS: { name: string; run: () => Promise<unknown> }[] = [
  {
    name: "snapshots",
    run: () => pg!`create table if not exists snapshots (name text primary key, payload jsonb not null, captured_at timestamptz not null default now())`,
  },
  {
    name: "leases",
    run: () => pg!`create table if not exists leases (name text primary key, until timestamptz not null)`,
  },
  {
    name: "schedules",
    run: () => pg!`create table if not exists schedules (name text primary key, last_run_at timestamptz, last_ok boolean, last_detail jsonb)`,
  },
  {
    name: "status_samples",
    run: () => pg!`create table if not exists status_samples (at timestamptz primary key default now(), ok boolean not null, checks jsonb not null)`,
  },
  {
    name: "paid_calls",
    run: () => pg!`
      create table if not exists paid_calls (
        id text primary key,
        token_id text not null,
        category text not null,
        paid boolean not null,
        sponsored boolean not null default false,
        tx text,
        at timestamptz not null,
        record jsonb not null
      )
    `,
  },
  {
    name: "sponsored_calls",
    run: () => pg!`create table if not exists sponsored_calls (id bigserial primary key, caller text not null, token_id text not null, at timestamptz not null default now())`,
  },
  {
    name: "sessions",
    run: () => pg!`
      create table if not exists sessions (
        id text primary key,
        kind text not null,
        label text not null,
        market text,
        mandate_id integer,
        category text,
        wallet_address text not null,
        public_key text not null,
        key_id text not null,
        permissions jsonb,
        allowlist jsonb not null default '[]',
        withheld jsonb,
        cap_wei text not null default '0',
        expiry integer not null,
        registered boolean not null default false,
        registration_tx text,
        registration_block integer,
        admin_signer text not null default 'private-key',
        granted_at timestamptz not null default now(),
        grant_tx text,
        revoked_at timestamptz,
        revoke_tx text,
        revoked_because text,
        meta jsonb,
        secret text
      )
    `,
  },
  {
    // What each house agent decided every time it looked, including "nothing to do".
    name: "house_runs",
    run: async () => {
      await pg!`
        create table if not exists house_runs (
          id bigserial primary key,
          slug text not null,
          at timestamptz not null default now(),
          mode text not null,
          outcome text not null,
          reason text not null,
          readings jsonb not null default '{}',
          txs jsonb not null default '[]',
          state jsonb
        )
      `;
      await pg!`create index if not exists house_runs_slug_at on house_runs (slug, at desc)`;
    },
  },
  {
    // Every agent read straight from the ERC-8004 registry: its card, its owner, and the transaction that minted it.
    name: "registry_agents",
    run: async () => {
      await pg!`
        create table if not exists registry_agents (
          token_id text primary key,
          owner text,
          category text,
          record jsonb not null,
          block bigint,
          tx text,
          source text not null,
          indexed_at timestamptz not null default now()
        )
      `;
      await pg!`create index if not exists registry_agents_owner on registry_agents (owner)`;
      await pg!`create index if not exists registry_agents_indexed on registry_agents (indexed_at desc)`;
    },
  },
  {
    // Leashes users granted our agents on their own passkey wallets: the session's public half and its terms, never a private key.
    name: "user_leashes",
    run: async () => {
      await pg!`
        create table if not exists user_leashes (
          id text primary key,
          wallet text not null,
          slug text not null,
          owner text,
          key_id text not null,
          public_key text not null,
          daily_usdt text not null,
          expiry bigint not null,
          granted_at timestamptz not null default now(),
          revoked_at timestamptz,
          revoke_tx text,
          note text
        )
      `;
      await pg!`create index if not exists user_leashes_wallet on user_leashes (wallet)`;
      await pg!`create index if not exists user_leashes_owner on user_leashes (owner)`;
    },
  },
  {
    // Every turn an agent took on a user's leashed wallet, acted or not.
    name: "leash_runs",
    run: async () => {
      await pg!`
        create table if not exists leash_runs (
          id bigserial primary key,
          leash_id text not null,
          at timestamptz not null default now(),
          outcome text not null,
          reason text not null,
          readings jsonb not null default '{}',
          txs jsonb not null default '[]'
        )
      `;
      await pg!`create index if not exists leash_runs_leash_at on leash_runs (leash_id, at desc)`;
    },
  },
  {
    /*
      Free liquidation alerts: a wallet watched for a Telegram chat, the
      health factor that should wake them, and what we last read and said, so
      an alert fires on a change rather than on every tick. A row is a code
      until its chat presses Start in the bot.
    */
    name: "telegram_alerts",
    run: async () => {
      await pg!`
        create table if not exists telegram_alerts (
          id text primary key,
          wallet text not null,
          threshold double precision not null,
          chat_id text,
          created_at timestamptz not null default now(),
          linked_at timestamptz,
          stopped_at timestamptz,
          last_hf double precision,
          last_state text,
          last_alert_at timestamptz,
          last_checked_at timestamptz
        )
      `;
      await pg!`create index if not exists telegram_alerts_chat on telegram_alerts (chat_id)`;
      await pg!`create index if not exists telegram_alerts_due on telegram_alerts (last_checked_at) where chat_id is not null and stopped_at is null`;
    },
  },
  {
    // ERC-8183 jobs a buyer funded for one of our agents here, with what our agent delivered and each transaction.
    name: "escrow_jobs",
    run: async () => {
      await pg!`
        create table if not exists escrow_jobs (
          job_id text primary key,
          client text not null,
          provider text not null,
          slug text not null,
          token_id text not null,
          budget text not null,
          subject text,
          status text not null,
          funded_tx text,
          submit_tx text,
          settle_tx text,
          -- The exact bytes hashed on chain. Text, not jsonb: jsonb reorders keys and the hash would no longer match.
          deliverable text,
          deliverable_hash text,
          expired_at bigint,
          submitted_at bigint,
          note text,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `;
      await pg!`create index if not exists escrow_jobs_client on escrow_jobs (client)`;
      await pg!`create index if not exists escrow_jobs_status on escrow_jobs (status)`;
    },
  },
  {
    // Ratings buyers wrote from their own wallets on the ERC-8004 reputation registry, each verified on chain before it is kept.
    name: "ratings",
    run: async () => {
      await pg!`
        create table if not exists ratings (
          tx text primary key,
          wallet text not null,
          token_id text not null,
          score integer not null,
          tag1 text,
          tag2 text,
          block bigint,
          hire_tx text,
          at timestamptz not null default now()
        )
      `;
      await pg!`create index if not exists ratings_wallet on ratings (wallet)`;
    },
  },
];

let once: Promise<boolean> | null = null;

/*
  What the catalogue says about our tables, in one round trip.

  This used to run ALTER TABLE ... ENABLE ROW LEVEL SECURITY and REVOKE on all
  fourteen tables on every cold start of every instance. That cost about five
  seconds of sequential round trips, and worse, ALTER TABLE takes an access
  exclusive lock: while one instance's ALTER waits behind any open transaction,
  every ordinary SELECT on that table from every other instance queues behind
  the ALTER. A marketplace page that reads paid calls then waits for minutes,
  which is what a local run hit once the catalogue started reading them.

  So it asks first. A table that exists, has row-level security, and grants
  nothing to the public roles needs nothing, which after the first run is all
  of them, and a cold start costs one catalogue read.
*/
interface TableState {
  exists: boolean;
  rls: boolean;
  publicGrant: boolean;
}

async function catalogue(names: string[]): Promise<Map<string, TableState> | null> {
  try {
    const rows = (await pg!`
      select c.relname as name,
             c.relrowsecurity as rls,
             exists (
               select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
               join pg_roles r on r.oid = a.grantee
               where r.rolname in ('anon', 'authenticated')
             ) as public_grant
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname = any(${names})
    `) as { name: string; rls: boolean; public_grant: boolean }[];
    const out = new Map<string, TableState>(names.map((n) => [n, { exists: false, rls: false, publicGrant: false }]));
    for (const r of rows) out.set(r.name, { exists: true, rls: r.rls, publicGrant: r.public_grant });
    return out;
  } catch {
    return null;
  }
}

/*
  DDL that must never hold up readers. A lock it cannot get in a few seconds
  is abandoned and retried on the next cold start, rather than queueing and
  taking every reader of the table down with it.
*/
async function ddl(statement: string): Promise<void> {
  // The timeouts are transaction-local, so the statement has to run on the
  // same transaction, not on a fresh connection from the pool.
  await pg!.begin(async (tx) => {
    await tx`set local lock_timeout = '3s'`;
    await tx`set local statement_timeout = '10s'`;
    await tx.unsafe(statement);
  });
}

/** True when the tables exist (or there is no database and nothing to do). */
export function ensureTables(): Promise<boolean> {
  if (!pg) return Promise.resolve(false);
  once ??= (async () => {
    const state = await catalogue(STATEMENTS.map((s) => s.name));
    for (const s of STATEMENTS) {
      const st = state?.get(s.name) ?? { exists: false, rls: false, publicGrant: true };
      try {
        if (!st.exists) await s.run();
        /*
          Supabase serves every table in `public` over its REST API to anyone
          holding the project's anon key unless row-level security is on, and
          grants that role full rights by default. Nothing here should ever be
          reachable that way (the site connects directly as the owner, which
          bypasses RLS), so each table is locked the moment it exists, and only
          touched again if something has unlocked it.
        */
        if (!st.exists || !st.rls) {
          await ddl(`alter table public."${s.name}" enable row level security`);
        }
        if (!st.exists || st.publicGrant) {
          await ddl(`revoke all on table public."${s.name}" from anon, authenticated`).catch(() => undefined);
        }
      } catch {
        /* a table this deployment cannot create is reported by its reader */
      }
    }
    return true;
  })();
  return once;
}

/**
 * Snapshots: the committed JSON files, and their newer selves in Postgres.
 *
 * Every number on the site comes from a snapshot with a `capturedAt`: the
 * probe census, the assays, the registry index. Those used to be files in
 * `src/data/` and nothing else, which meant a deployed instance could only
 * ever show the reading from its last build. With GitHub Actions locked and
 * the Railway worker gone, nothing refreshed them at all.
 *
 * A snapshot now also lives in a `snapshots` table. Readers call `warm()`
 * once at the top of a render; it loads any row newer than what is in memory
 * (cheap: one `select` per snapshot per minute per instance). Writers call
 * `store()`. The committed file remains the floor: a database outage returns
 * the site to its build-time reading and says how old it is, rather than
 * blanking.
 *
 * Readers stay synchronous so the many call sites that already exist keep
 * their shape; `warm()` is the one async step and pages await it first.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql as pg } from "@/lib/db/client";
import { ensureTables } from "@/lib/db/tables";

export type SnapshotName = "probe" | "agents" | "assays" | "census" | "demo" | "grid-window" | "grid-state" | "funnel" | "definition" | "pool-gap" | "pool-gap-progress" | "registry-tail" | "requirements" | "conformance" | "escrow-watch" | "status-checks";

interface Loaded {
  payload: unknown;
  capturedAt: string;
  source: "file" | "db";
}

const memory = new Map<SnapshotName, Loaded>();
const lastWarm = new Map<SnapshotName, number>();
const WARM_TTL_MS = 60_000;

async function ensure(): Promise<boolean> {
  if (!pg) return false;
  await ensureTables();
  return true;
}

function fromFile(name: SnapshotName): Loaded | null {
  try {
    const raw = JSON.parse(readFileSync(join(process.cwd(), `src/data/${name}.json`), "utf8")) as {
      at?: string;
      capturedAt?: string;
      generatedAt?: string;
    };
    return { payload: raw, capturedAt: raw.at ?? raw.capturedAt ?? raw.generatedAt ?? new Date(0).toISOString(), source: "file" };
  } catch {
    return null;
  }
}

/** The best reading in memory right now: the DB row if warmed, else the file. */
export function snapshot<T = unknown>(name: SnapshotName): { payload: T; capturedAt: string; source: "file" | "db" } | null {
  const inMemory = memory.get(name);
  if (inMemory) return inMemory as { payload: T; capturedAt: string; source: "file" | "db" };
  const f = fromFile(name);
  if (f) memory.set(name, f);
  return (f as { payload: T; capturedAt: string; source: "file" | "db" } | null) ?? null;
}

/**
 * Loads newer readings from the database. Safe to call on every render:
 * it does nothing more than once a minute per snapshot per instance.
 */
export const DEFAULT_WARM: SnapshotName[] = ["probe", "assays", "census", "demo", "grid-window", "grid-state", "definition", "conformance"];

const warming = new Map<SnapshotName, Promise<void>>();

export async function warm(names: SnapshotName[] = DEFAULT_WARM): Promise<void> {
  if (!(await ensure())) return;
  // A name already being read is waited for, not skipped. It used to be marked
  // warm before its row arrived, so a second caller in the same moment went on
  // to read the committed file while the newer row was still on its way.
  const waiting = names.map((n) => warming.get(n)).filter((p): p is Promise<void> => Boolean(p));
  const due = names.filter((n) => !warming.has(n) && Date.now() - (lastWarm.get(n) ?? 0) > WARM_TTL_MS);
  if (due.length) {
    const read = (async () => {
      try {
        /*
          Two steps, so a reading that has not changed costs a few bytes: the
          timestamps first, then the payloads only for the names whose stored
          reading is newer than the one in memory. Every instance asked for
          every payload every minute before, and that added up.
        */
        const stamps = (await pg!`select name, captured_at from snapshots where name in ${pg!(due)}`) as { name: SnapshotName; captured_at: Date | string }[];
        const newer = stamps.filter((r) => {
          const current = snapshot(r.name);
          return !current || current.capturedAt < new Date(r.captured_at).toISOString();
        });
        if (newer.length) {
          const rows = (await pg!`select name, payload, captured_at from snapshots where name in ${pg!(newer.map((r) => r.name))}`) as {
            name: SnapshotName;
            payload: unknown;
            captured_at: Date | string;
          }[];
          for (const r of rows) {
            memory.set(r.name, { payload: r.payload, capturedAt: new Date(r.captured_at).toISOString(), source: "db" });
            onChange.get(r.name)?.forEach((fn) => fn());
          }
        }
      } catch {
        /* the file reading stands */
      } finally {
        for (const n of due) warming.delete(n);
      }
    })();
    for (const n of due) {
      lastWarm.set(n, Date.now());
      warming.set(n, read);
    }
    waiting.push(read);
  }
  await Promise.all(waiting);
}

/** Writes a new reading. `capturedAt` defaults to now. */
export async function store(name: SnapshotName, payload: unknown, capturedAt = new Date().toISOString()): Promise<void> {
  memory.set(name, { payload, capturedAt, source: "db" });
  onChange.get(name)?.forEach((fn) => fn());
  if (!(await ensure())) return;
  await pg!`
    insert into snapshots (name, payload, captured_at)
    values (${name}, ${JSON.stringify(payload)}::jsonb, ${capturedAt})
    on conflict (name) do update set payload = excluded.payload, captured_at = excluded.captured_at
  `;
}

/** When the reading behind a snapshot changes, derived caches must drop. */
const onChange = new Map<SnapshotName, Set<() => void>>();
export function onSnapshotChange(name: SnapshotName, fn: () => void): void {
  if (!onChange.has(name)) onChange.set(name, new Set());
  onChange.get(name)!.add(fn);
}

/** Age of a reading, for the "as of" line every count carries. */
export function ageOf(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "under a minute ago";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

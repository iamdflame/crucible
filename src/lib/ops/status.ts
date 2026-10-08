/**
 * The judge path, checked from the inside.
 *
 * Each of the six beats on /judges depends on a read: the demo address has
 * something to diagnose, every category has an agent that answered, Ranger
 * resolves, Grid-1 has fills, the desk can read the KeyStore, the funnel can
 * read the registry. This runs those reads and grades them, so /status (and
 * any uptime probe pointed at /api/status) sees a broken beat before a judge
 * does. It checks data, not HTML; the smoke script checks the HTML.
 */

import type { Address, Hex } from "viem";
import { marketClient } from "@/lib/chain/market";
import { providers } from "@/lib/escrow/jobs";
import { diagnose } from "@/lib/diagnose";
import { judgePicks } from "@/lib/market/judge";
import { listingFor } from "@/lib/market/listing";
import { readGridWindow, type GridWindow } from "@/lib/grid/window";
import { snapshot } from "@/lib/data/snapshots";
import { listSessions } from "@/lib/chain/session-store";
import { activeKeys, comparePolicy, readKey } from "@/lib/chain/keystore";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { registeredCount } from "@/lib/registry/count";
import { withTimeout } from "@/lib/cache";
import { DEMO_ADDRESS } from "@/lib/demo";
import { HOUSE_LEASHES, houseSessionId, supersededOf } from "@/lib/chain/house";
import { pauseForSlug } from "@/lib/market/paused";
import { listings } from "@/lib/market/listing";
import { hirePath } from "@/lib/market/hire-law";
import { hireCounts } from "@/lib/market/hires";
import { CATEGORIES, type Category } from "@/lib/config";

/** Fewer agents a buyer can hire in a job than this, and the job is thin: one failure from none. */
export const THIN_BELOW = 3;

/** Agents a buyer can hire right now, per job: the hire law's answer, as /agents and the API give it. */
export async function hireableByCategory(): Promise<Record<Category, string[]>> {
  const counts = await hireCounts().catch(() => null);
  const out = Object.fromEntries(CATEGORIES.map((c) => [c, [] as string[]])) as Record<Category, string[]>;
  for (const l of listings(counts?.byTokenId, counts?.settled)) {
    const c = l.category as Category | null;
    if (c && out[c] && hirePath(l).ok) out[c].push(l.name);
  }
  return out;
}

export interface Check {
  beat: number;
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

async function timed(beat: number, name: string, fn: () => Promise<{ ok: boolean; detail: string }>): Promise<Check> {
  const started = Date.now();
  const r = await withTimeout(fn().catch((e) => ({ ok: false, detail: `failed: ${(e as Error).message.slice(0, 160)}` })), 12_000);
  return { beat, name, ms: Date.now() - started, ...(r ?? { ok: false, detail: "no answer inside 12 seconds" }) };
}

export async function judgePathChecks(): Promise<Check[]> {
  return Promise.all([
    timed(1, "A wallet can be diagnosed from the chain", async () => {
      /*
        This used to require the demo address to have a position out of range.
        Range-1 recenters that account's positions on its own, so a working
        agent turned the check red. What must hold is that the diagnosis reads
        the positions and the Venus account at a block, whatever it finds.
      */
      const d = await diagnose(DEMO_ADDRESS);
      if (!d) return { ok: false, detail: "diagnose returned nothing" };
      const out = d.findings.filter((f) => f.kind === "out-of-range").length;
      const venus = d.findings.some((f) => f.kind === "thin-headroom" || f.kind === "liquidatable" || f.kind === "healthy");
      const idle = d.findings.some((f) => f.kind === "idle-cash");
      return { ok: venus && Boolean(d.blockNumber), detail: `${out} out of range, Venus ${venus ? "read" : "not read"}, idle cash ${idle ? "found" : "none"}, block ${d.blockNumber}` };
    }),
    timed(2, "Every category has an agent that answered", async () => {
      const picks = judgePicks();
      const cats = new Set(picks.map((p) => p.category));
      return { ok: cats.size === 4, detail: `${cats.size} of 4 categories have a live pick` };
    }),
    timed(3, "Ranger (269706) resolves with its checks", async () => {
      const l = listingFor("269706");
      return { ok: Boolean(l), detail: l ? `${l.name}: ${l.liveness}` : "not in the index" };
    }),
    timed(4, "Grid-1 has real fills on chain", async () => {
      // The read carries the stored window forward and stores each stretch as
      // it goes, so a slow provider can leave it short of the budget. The
      // stored reading is an earlier chain read of the same log: it stands,
      // with its block and its age, until it is more than a day old.
      let failed: string | null = null;
      const w = await withTimeout(
        readGridWindow().catch((e) => {
          failed = (e as Error).message.slice(0, 120);
          return null;
        }),
        9_000,
      );
      if (w) return { ok: w.fills.length > 0, detail: `${w.fills.length} fills, ${w.roundTrips.length} round trips, read to block ${w.toBlock}` };
      const why = failed ? `the chain read failed (${failed})` : "the chain read did not finish inside 9 seconds";
      const stored = snapshot<GridWindow>("grid-window")?.payload;
      if (!stored) return { ok: false, detail: `${why}, and there is no stored reading` };
      const hours = (Date.now() - Date.parse(stored.readAt)) / 3_600_000;
      const age = hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min` : `${hours.toFixed(1)} h`;
      return {
        ok: stored.fills.length > 0 && hours < 26,
        detail: `${stored.fills.length} fills, ${stored.roundTrips.length} round trips, stored reading to block ${stored.toBlock}, ${age} old; ${why}`,
      };
    }),
    timed(5, "The desk can read the KeyStore, and no house leash has lapsed", async () => {
      const all = await listSessions();
      const live = all.filter((s) => !s.revokedAt && s.registered && s.expiry * 1000 > Date.now());
      if (!live.length) return { ok: false, detail: "no live registered session to compare" };
      /*
        This beat used to take the first live session and stop there. Range-1's
        ran to October while Guard-1, Yield-1 and Grid-1 lapsed on 12 September,
        so it stayed green for the six days our other three agents could not
        act at all. A lapsed leash is an agent that is listed, holds a key, and
        is authority over nothing.
      */
      const paused = HOUSE_LEASHES.filter((l) => pauseForSlug(l.slug)).map((l) => l.slug);
      const lapsed = HOUSE_LEASHES.filter((l) => !pauseForSlug(l.slug))
        .map((l) => ({ slug: l.slug, rec: all.find((x) => x.id === houseSessionId(l.slug) && !x.revokedAt) }))
        .filter((h) => !h.rec || h.rec.expiry * 1000 <= Date.now())
        .map((h) => (h.rec ? `${h.slug} expired ${new Date(h.rec.expiry * 1000).toISOString().slice(0, 10)}` : `${h.slug} has no session`));
      const s = live[0];
      const m = await comparePolicy({ wallet: s.walletAddress as Hex, publicKey: s.publicKey as Hex, expiry: s.expiry, registered: s.registered, revoked: false });
      /*
        The other direction matters as much: a valid key on the account that no
        session on record explains is authority nobody here can account for.
        Three such keys sat on the demo account for a week before an audit
        found them. This counts them on every sample.
      */
      // A key a renewal replaced is ours until it expires: the record that replaced it carries it.
      const known = new Set([...all.map((x) => x.keyId.toLowerCase()), ...all.flatMap((x) => supersededOf(x).map((k) => k.keyId.toLowerCase()))]);
      const raw = process.env.PRIVATE_KEY;
      const adminKeyId = raw ? keccak256(privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex).publicKey).toLowerCase() : null;
      const keys = await activeKeys(DEMO_ADDRESS as Hex).catch(() => [] as Hex[]);
      let unaccounted = 0;
      for (const k of keys) {
        if (known.has(k.toLowerCase()) || k.toLowerCase() === adminKeyId) continue;
        const e = await readKey(DEMO_ADDRESS as Hex, k).catch(() => null);
        if (e?.valid) unaccounted += 1;
      }
      const tail = unaccounted ? `; ${unaccounted} valid key(s) on the account that no session accounts for` : `; every valid key on the account is accounted for`;
      const active = HOUSE_LEASHES.length - paused.length;
      const leashes =
        (lapsed.length ? `; ${lapsed.length} of ${active} house leashes lapsed (${lapsed.join(", ")})` : `; all ${active} active house leashes live`) +
        (paused.length ? `; ${paused.join(", ")} paused, left to expire` : "");
      return { ok: m.verdict === "matches" && unaccounted === 0 && lapsed.length === 0, detail: `${s.label}: ${m.verdict} at block ${m.block ?? "?"}${tail}${leashes}` };
    }),
    timed(6, "The funnel reads the registry", async () => {
      const c = await registeredCount();
      return { ok: c.count > 0, detail: `${c.count.toLocaleString("en-GB")} registered at block ${c.block.toLocaleString("en-GB")}` };
    }),
    timed(7, "Our agents can pay for the work they deliver", async () => {
      /*
        An escrowed job to one of our agents is delivered by a transaction from
        that agent's own wallet, and settled later by keeper A. A wallet out of
        BNB leaves a buyer's job undelivered until its deadline. Counted in
        deliveries at today's gas price, from the gas a submission used.
      */
      const price = await marketClient.getGasPrice();
      const per = DELIVERY_GAS * price;
      const raw = process.env.AGENT_A_KEY;
      const keeper = raw ? privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex).address : null;
      const wallets = [...[...providers().values()].map((p) => ({ name: p.ref.name, address: p.owner as Address })), ...(keeper ? [{ name: "keeper A", address: keeper }] : [])];
      const read = await Promise.all(wallets.map(async (w) => ({ ...w, left: Number((await marketClient.getBalance({ address: w.address })) / per) })));
      const low = read.filter((w) => w.left < MIN_DELIVERIES);
      return {
        ok: read.length > 0 && low.length === 0,
        detail: read.map((w) => `${w.name} ${w.left.toLocaleString("en-GB")}`).join(", ") + ` deliveries of gas left${low.length ? `; below ${MIN_DELIVERIES}: ${low.map((w) => w.name).join(", ")}` : ""}`,
      };
    }),
  ]);
}

/** Gas one escrow submission used on mainnet (job 56803), and the fewest deliveries a wallet should have in hand. */
const DELIVERY_GAS = 158_017n;
const MIN_DELIVERIES = 50;

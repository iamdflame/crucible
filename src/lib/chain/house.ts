/**
 * The four house leashes, in one table.
 *
 * Each reference agent acts on the demo account through a session, and a
 * session expires: that is the point of it. What was missing was anything
 * that noticed. Guard-1, Yield-1 and Grid-1 all lapsed on 12 September and
 * nobody saw it for six days, because a lapsed session does not fail loudly.
 * It just stops being authority, and the agent goes quiet.
 *
 * The leashes were written out longhand in three different scripts, so
 * renewing one meant finding the script that granted it and copying its
 * arguments. They live here now, so `renewHouseSessions` can renew any of
 * them without knowing which agent it is renewing, and the scheduler can run
 * that before expiry rather than after.
 */

import { parseUnits, type Address } from "viem";
import type { Category } from "@/lib/config";
import { GRID_CALLS, RANGE_CALLS, USDT, WBNB } from "@/lib/chain/leash";
import { grantScopedSession } from "@/lib/chain/session";
import { listSessions } from "@/lib/chain/session-store";
import { DEMO_ADDRESS } from "@/lib/demo";
import { pauseForSlug } from "@/lib/market/paused";

/** Venus vUSDT, the market Guard-1 repays into and Yield-1 supplies to. */
export const VUSDT: Address = "0xfD5840Cd36d94D7229439859C0112a4185BC0255";

export interface HouseLeash {
  slug: "range-1" | "grid-1" | "yield-1" | "guard-1";
  label: string;
  category: Category;
  calls: { to: Address; signature: string }[];
  /** Daily ERC-20 outflow the session may cause, per token. */
  tokenSpend: { token: Address; limit: bigint }[];
  /** Daily native allowance: value sent, plus the gas the account pays. */
  nativeSpendWei: bigint;
}

/**
 * Exactly what each house agent may do, and nothing else. These are the same
 * permissions the agents have held since they were first granted; renewing
 * reissues them rather than widening them.
 */
export const HOUSE_LEASHES: HouseLeash[] = [
  {
    slug: "range-1",
    label: "Range-1 on the demo address",
    category: "rebalancing",
    calls: RANGE_CALLS.map((c) => ({ to: c.to, signature: c.signature })),
    tokenSpend: [
      { token: USDT, limit: parseUnits("0.05", 18) },
      { token: WBNB, limit: parseUnits("0.05", 18) },
    ],
    nativeSpendWei: 2_000_000_000_000_000n,
  },
  {
    slug: "grid-1",
    label: "Grid-1 on the demo address",
    category: "grid-trading",
    calls: GRID_CALLS.map((c) => ({ to: c.to, signature: c.signature })),
    tokenSpend: [
      { token: USDT, limit: parseUnits("1", 18) },
      { token: WBNB, limit: parseUnits("0.003", 18) },
    ],
    nativeSpendWei: 2_000_000_000_000_000n,
  },
  {
    slug: "yield-1",
    label: "Yield-1 on the demo address",
    category: "yield-optimisation",
    calls: [
      { to: VUSDT, signature: "mint(uint256)" },
      { to: VUSDT, signature: "redeemUnderlying(uint256)" },
    ],
    tokenSpend: [{ token: USDT, limit: parseUnits("0.1", 18) }],
    nativeSpendWei: 1_000_000_000_000_000n,
  },
  {
    slug: "guard-1",
    label: "Guard-1 on the demo address",
    category: "health-factor",
    calls: [{ to: VUSDT, signature: "repayBorrow(uint256)" }],
    tokenSpend: [{ token: USDT, limit: parseUnits("0.05", 18) }],
    nativeSpendWei: 1_000_000_000_000_000n,
  },
];

export const houseSessionId = (slug: string, principal: Address = DEMO_ADDRESS as Address) => `house:${slug}:${principal.toLowerCase()}`;

export interface RenewalOutcome {
  slug: string;
  /** What the session was before: live and not yet due, due soon, or already lapsed. */
  was: "live" | "due" | "expired" | "missing";
  renewed: boolean;
  expiry: number | null;
  registrationTx?: string | null;
  error?: string;
  /** Left alone on purpose, and why. Not a failure. */
  skipped?: string;
}

/** Keys a house session's renewals replaced that may still be valid on chain, as its record carries them. */
export function supersededOf(rec: { meta?: Record<string, unknown> } | null | undefined): { keyId: string; expiry: number }[] {
  const list = rec?.meta?.superseded;
  return Array.isArray(list)
    ? list.filter((k): k is { keyId: string; expiry: number } => Boolean(k) && typeof (k as { keyId?: unknown }).keyId === "string" && typeof (k as { expiry?: unknown }).expiry === "number")
    : [];
}

/**
 * Renews the house sessions that are within `withinDays` of expiring, or have
 * already expired. A session with longer than that left is left alone: each
 * grant costs a registration transaction, so renewing early on every tick
 * would spend real BNB to change nothing.
 */
export async function renewHouseSessions(opts: { days?: number; withinDays?: number; only?: string[]; register?: boolean; max?: number } = {}): Promise<RenewalOutcome[]> {
  const days = Math.max(1, Math.min(60, opts.days ?? 21));
  const withinDays = opts.withinDays ?? 3;
  const principal = DEMO_ADDRESS as Address;
  const sessions = await listSessions().catch(() => []);
  const out: RenewalOutcome[] = [];
  // Each grant is a registration transaction and real gas. A bug that thought
  // every session was expired should cost a bounded amount, not the balance.
  let spent = 0;

  for (const leash of HOUSE_LEASHES) {
    if (opts.only?.length && !opts.only.includes(leash.slug)) continue;
    const id = houseSessionId(leash.slug, principal);
    const current = sessions.find((s) => s.id === id && !s.revokedAt) ?? null;
    const secondsLeft = current ? current.expiry - Math.floor(Date.now() / 1000) : -1;
    const was: RenewalOutcome["was"] = !current ? "missing" : secondsLeft <= 0 ? "expired" : secondsLeft < withinDays * 86_400 ? "due" : "live";
    // A paused agent's leash is left to run out: renewing it would spend a registration on authority nothing uses.
    if (pauseForSlug(leash.slug)) {
      out.push({ slug: leash.slug, was, renewed: false, expiry: current?.expiry ?? null, skipped: "paused" });
      continue;
    }
    if (was === "live") {
      out.push({ slug: leash.slug, was, renewed: false, expiry: current!.expiry });
      continue;
    }
    if (opts.max !== undefined && spent >= opts.max) {
      out.push({ slug: leash.slug, was, renewed: false, expiry: current?.expiry ?? null, error: `deferred: ${opts.max} renewals already done on this run` });
      continue;
    }
    /*
      A renewal writes the new key over this record, and the key it replaces
      stays valid on chain until its own expiry. Unrecorded, it reads to the
      audit as authority nobody accounts for (Range-1's and Yield-1's old keys,
      after the 6 Oct renewal). So the record carries the keys it superseded
      until each one expires.
    */
    const now = Math.floor(Date.now() / 1000);
    const carried = supersededOf(current).filter((k) => k.expiry > now);
    const superseded = current && current.expiry > now ? [...carried, { keyId: current.keyId, expiry: current.expiry }] : carried;
    try {
      spent += 1;
      const rec = await grantScopedSession({
        id,
        kind: "house",
        label: leash.label,
        category: leash.category,
        calls: leash.calls,
        tokenSpend: leash.tokenSpend,
        nativeSpendWei: leash.nativeSpendWei,
        capWei: 0n,
        ttlSeconds: days * 24 * 3600,
        register: opts.register ?? true,
        meta: { renewed: `granted for ${days} days; the previous session was ${was}`, superseded },
      });
      out.push({ slug: leash.slug, was, renewed: true, expiry: rec.expiry, registrationTx: rec.registrationTx ?? null });
    } catch (e) {
      out.push({ slug: leash.slug, was, renewed: false, expiry: current?.expiry ?? null, error: (e as Error).message.split("\n")[0].slice(0, 160) });
    }
  }
  return out;
}

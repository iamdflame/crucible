/**
 * An agent against BNB Chain's Set and Earn build checks, as far as the chain
 * and its public endpoints show them (the campaign page, Tracks):
 *
 *   owned          on the ERC-8004 registry, owned by the campaign wallet, listed here
 *   discoverable   a card that says what it does and which of the four jobs
 *   live           answers when called
 *   hired          three completed hires from three wallets that are not its own
 *   executes       five onchain actions of its own, on three different days
 *   fits           those actions fit its job
 *
 * BNB Chain makes the final determination after the campaign; this is the
 * same evidence read early, so a builder sees what is missing while there is
 * time to fix it. Each check says what it read and from where.
 *
 * The onchain part reads an archive node: the agent's wallets' nonces at each
 * day boundary give how many transactions they sent and on which days, and a
 * search within a day finds each recent transaction and the contract it called.
 */

import { createPublicClient, http, parseAbi, type Address, type Hash, type PublicClient } from "viem";
import { bsc } from "viem/chains";
import { sql as pg } from "@/lib/db/client";
import { ensureTables } from "@/lib/db/tables";
import { CATEGORY_LABEL, IDENTITY_REGISTRY, PROTOCOLS, type Category } from "@/lib/config";
import { findAgent } from "@/lib/data/agents";
import { listings } from "@/lib/market/listing";
import { listPaidCalls } from "@/lib/market/paid-calls";
import { readRegistryEntry } from "@/lib/sources/registry";
import { readJob } from "@/lib/escrow/jobs";
import { isTeam } from "@/lib/team";
import { withTimeout } from "@/lib/cache";
import { marketClient, MARKET_ADDRESS } from "@/lib/chain/market";
import { ESCROW } from "@/lib/escrow/contracts";

export type CheckState = "pass" | "pending" | "fail" | "unknown";
export type CheckId = "owned" | "discoverable" | "live" | "hired" | "executes" | "fits";

export interface Check {
  id: CheckId;
  label: string;
  state: CheckState;
  detail: string;
}

export interface Action {
  wallet: string;
  tx: Hash;
  to: string | null;
  kind: Kind;
  fits: boolean;
  at: string;
}

export interface Qualification {
  tokenId: string;
  name: string | null;
  category: Category | null;
  owner: string | null;
  wallets: string[];
  checks: Check[];
  actions: Action[];
  hirers: { wallet: string; via: string; team: boolean }[];
  at: string;
  /** Its onchain actions are still being read; the first four checks stand. */
  reading?: boolean;
}

const LABEL: Record<CheckId, string> = {
  owned: "Registered and owned",
  discoverable: "Discoverable",
  live: "Live",
  hired: "Hired by others",
  executes: "Actually executes",
  fits: "Does what it says",
};

const REGISTRY = parseAbi(["function getAgentWallet(uint256) view returns (address)"]);
const DAY = 86_400;
/** How far back the days are read: the campaign is five weeks. */
const MAX_DAYS = 45;
/** Recent transactions looked up one by one for what they called. */
const SAMPLE = 5;
const CACHE_MS = 30 * 60_000;

/* ------------------------------------------------------- what a call was */

export type Kind = "lending" | "trade" | "position" | "vault" | "delivery" | "registry" | "approval" | "transfer" | "other";

/** The ERC-8004 registries: an agent keeping its own registration current is housekeeping, not its job. */
const REGISTRIES = new Set([IDENTITY_REGISTRY.toLowerCase(), "0x8004baa17c55a88189ae136b182e5fda19de9b63"]);

/** Marketplace contracts an agent answers through: delivering a job is its work for a buyer, but not the protocol work its job names. */
const MARKETS = new Set([ESCROW.commerce.toLowerCase(), ESCROW.router.toLowerCase(), MARKET_ADDRESS.toLowerCase()]);

const LENDING = new Set(["0xa0712d68", "0xdb006a75", "0x852a12e3", "0xc5ebeaec", "0x0e752702", "0x2608f818", "0x1249c58b", "0x617ba037", "0x69328dec", "0x573ade81", "0xa415bcad", "0xc2998238", "0xede4edd0"]);
const TRADE = new Set(["0x04e45aaf", "0x414bf389", "0xb858183f", "0xc04b8d59", "0x38ed1739", "0x7ff36ab5", "0x18cbafe5", "0x8803dbee", "0xfb3bdb41", "0x5c11d795", "0xb6f9de95", "0x791ac947", "0x3593564c", "0x472b43f3"]);
const POSITION = new Set(["0x88316456", "0x219f5d17", "0x0c49ccbe", "0xfc6f7865", "0x42966c68"]);
const VAULT = new Set(["0x6e553f65", "0xb6b55f25", "0xba087652", "0xb460af94", "0x2e1a7d4d"]);

/** What a transaction did, from the contract it called and the function's selector. Pure, for tests. */
export function kindOf(to: string | null, input: string): Kind {
  const t = (to ?? "").toLowerCase();
  const sel = input.slice(0, 10).toLowerCase();
  if (t === PROTOCOLS.recipientBound || t === PROTOCOLS.pancakeV3PositionManager || t === PROTOCOLS.pancakeMasterChefV3 || POSITION.has(sel)) return "position";
  if (t === PROTOCOLS.swapBound || t === PROTOCOLS.pancakeV3Router || t === PROTOCOLS.pancakeV2Router || TRADE.has(sel)) return "trade";
  if (t === PROTOCOLS.venusComptroller || t === PROTOCOLS.venusVBNB || t === PROTOCOLS.venusVUSDT || t === PROTOCOLS.aaveV3Pool || LENDING.has(sel)) return "lending";
  if (VAULT.has(sel)) return "vault";
  if (MARKETS.has(t)) return "delivery";
  if (REGISTRIES.has(t)) return "registry";
  if (sel === "0x095ea7b3") return "approval";
  if (sel === "0xa9059cbb" || input === "0x") return "transfer";
  return "other";
}

/** Whether a kind of action is the work a job claims, as BNB Chain words it. Approvals and transfers are neither for nor against. */
export function fitsJob(category: Category | null, kind: Kind): boolean {
  if (!category) return false;
  if (category === "yield-optimisation") return kind === "lending" || kind === "vault";
  if (category === "health-factor") return kind === "lending";
  if (category === "grid-trading") return kind === "trade";
  return kind === "position" || kind === "trade";
}

/* -------------------------------------------------------- the archive */

/**
 * Historical state (a wallet's nonce at a past block) needs an archive node.
 * Of the public BSC endpoints, only thirdweb's serves it (measured 1 Oct:
 * blxrbdn, dataseed, defibit, publicnode and drpc refuse), so it is the
 * default; QUALIFY_RPC_URL names a better one. Blocks themselves are read from
 * our usual nodes, so the archive is asked only what only it can answer.
 */
function archive(): PublicClient | null {
  // With our thirdweb key, sent as thirdweb asks a server to send it; without one, its anonymous, rate-limited endpoint.
  const secret = process.env.THIRDWEB_SECRET_KEY || process.env.thirdweb_secret;
  const url = process.env.QUALIFY_RPC_URL || process.env.ARCHIVE_RPC_URL || "https://56.rpc.thirdweb.com";
  const headers = secret && url.includes("thirdweb.com") ? { "x-secret-key": secret.trim() } : undefined;
  return createPublicClient({ chain: bsc, transport: http(url, { retryCount: 2, timeout: 15_000, ...(headers ? { fetchOptions: { headers } } : {}) }) }) as PublicClient;
}

/*
  thirdweb's public endpoint, without a key, serves eight requests at once
  and refuses the rest (1 Oct: 16 at once, 8 answered); with our key, 32 at
  once all answered (2 Oct). Every archive read in an instance goes through
  one gate of six, and a refused read is asked again with backoff.
*/
let inFlight = 0;
const waiting: (() => void)[] = [];
async function gated<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= 6) await new Promise<void>((ok) => waiting.push(ok));
  inFlight++;
  try {
    // A refused read is asked again after half a second, one, then two: a burst limit passes, a real failure does not.
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (attempt >= 3) throw e;
        await new Promise((ok) => setTimeout(ok, 500 * 2 ** attempt));
      }
    }
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}
const nonceAt = (c: PublicClient, address: Address, blockNumber: bigint) => gated(() => c.getTransactionCount({ address, blockNumber }));

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/**
 * The block at each UTC midnight from `since` to now, interpolated between
 * the head and a block two million back. BSC's block time is steady, so the
 * estimate is minutes off at most, which only matters for a transaction sent
 * within minutes of midnight; reading every boundary block to correct it cost
 * a call a day and pushed a check past its time.
 */
async function dayBlocks(since: number): Promise<{ day: number; block: bigint }[]> {
  const c = marketClient;
  const head = await c.getBlock();
  const now = Number(head.timestamp);
  const startDay = Math.max(Math.floor(since / DAY) * DAY, Math.floor(now / DAY) * DAY - (MAX_DAYS - 1) * DAY);
  const back = 2_000_000n;
  const anchor = await c.getBlock({ blockNumber: head.number > back ? head.number - back : 1n });
  const rate = Number(head.number - anchor.number) / (now - Number(anchor.timestamp));
  const days: number[] = [];
  for (let d = startDay; d <= now; d += DAY) days.push(d);
  return days.map((d) => ({ day: d, block: head.number - BigInt(Math.max(0, Math.round((now - d) * rate))) }));
}

interface WalletActivity {
  wallet: string;
  sent: number;
  days: number[];
  windows: { from: bigint; to: bigint; nonceFrom: number; nonceTo: number; day: number }[];
}

/** How many transactions a wallet sent since `since`, and on which days, from its nonce at each day boundary. */
async function activity(c: PublicClient, wallet: Address, since: number): Promise<WalletActivity> {
  const marks = await dayBlocks(since);
  const head = await marketClient.getBlockNumber();
  const points = [...marks.map((m) => m.block), head];
  const nonces = await pool(points, 8, (b) => nonceAt(c, wallet, b));
  const windows: WalletActivity["windows"] = [];
  for (let i = 0; i < marks.length; i++) {
    if (nonces[i + 1]! > nonces[i]!) windows.push({ from: points[i]!, to: points[i + 1]!, nonceFrom: nonces[i]!, nonceTo: nonces[i + 1]!, day: marks[i]!.day });
  }
  return { wallet, sent: nonces[nonces.length - 1]! - nonces[0]!, days: windows.map((w) => w.day), windows };
}

/** The transaction a wallet sent with a given nonce, found by searching its day for the block where the nonce moved past it. */
async function findTx(c: PublicClient, wallet: Address, nonce: number, from: bigint, to: bigint): Promise<{ hash: Hash; to: string | null; input: string; at: number } | null> {
  // Three points a round, asked at once: a day of blocks narrows to one in about nine rounds, at about 27 reads, gentle on a public archive.
  let lo = from;
  let hi = to;
  while (hi - lo > 1n) {
    const step = (hi - lo) / 4n || 1n;
    const points = Array.from({ length: 3 }, (_, i) => lo + step * BigInt(i + 1)).filter((b) => b > lo && b < hi);
    if (!points.length) break;
    const counts = await Promise.all(points.map((b) => nonceAt(c, wallet, b)));
    const first = counts.findIndex((n) => n > nonce);
    if (first === -1) lo = points[points.length - 1]!;
    else {
      hi = points[first]!;
      if (first > 0) lo = points[first - 1]!;
    }
  }
  const block = await marketClient.getBlock({ blockNumber: hi, includeTransactions: true });
  const tx = block.transactions.find((t) => typeof t !== "string" && t.from.toLowerCase() === wallet.toLowerCase() && Number(t.nonce) === nonce);
  return tx && typeof tx !== "string" ? { hash: tx.hash, to: tx.to ?? null, input: tx.input, at: Number(block.timestamp) } : null;
}

/* --------------------------------------------------------- the checks */

async function hirersOf(tokenId: string, wallets: string[], owner: string | null): Promise<Qualification["hirers"]> {
  const mine = new Set([...wallets, owner ?? ""].map((w) => w.toLowerCase()));
  const found = new Map<string, string>();
  const add = (w: string | null | undefined, via: string) => {
    const k = (w ?? "").toLowerCase();
    if (k && !mine.has(k) && !found.has(k)) found.set(k, via);
  };
  for (const c of await listPaidCalls().catch(() => [])) if (c.tokenId === tokenId && c.paid && c.delivered) add(c.payer, "a paid call on MANDATE");
  if (pg) {
    await ensureTables();
    const here = (await pg`select client from escrow_jobs where token_id = ${tokenId} and status in ('SUBMITTED', 'COMPLETED')`.catch(() => [])) as { client: string }[];
    for (const r of here) add(r.client, "an escrowed job on MANDATE");
    // Jobs funded to its wallets on the shared ERC-8183 kernel, from any marketplace; completed is what the kernel says now.
    const kernel = (await pg`select job_id, client from kernel_jobs where provider in ${pg(wallets.map((w) => w.toLowerCase()))} order by block desc limit 40`.catch(() => [])) as { job_id: string; client: string }[];
    const states = await pool(kernel, 6, (k) => readJob(BigInt(k.job_id)).then((j) => j.status, () => null));
    kernel.forEach((k, i) => {
      if (states[i] === "SUBMITTED" || states[i] === "COMPLETED") add(k.client, `escrowed job #${k.job_id} on the ERC-8183 kernel`);
    });
  }
  return [...found.entries()].map(([wallet, via]) => ({ wallet, via, team: isTeam(wallet) }));
}

/** The kept result, when it is younger than half an hour. */
export async function cachedQualification(tokenId: string): Promise<Qualification | null> {
  if (!pg) return null;
  await ensureTables();
  const [row] = (await pg`select payload, at from qualifications where token_id = ${tokenId}`.catch(() => [])) as { payload: Qualification; at: Date }[];
  return row && Date.now() - new Date(row.at).getTime() < CACHE_MS ? row.payload : null;
}

/** The first four checks, which need no archive: seconds, for a page to show while the rest is read. */
export const quickQualification = (tokenId: string) => compute(tokenId, false);

export async function qualify(tokenId: string, opts: { fresh?: boolean } = {}): Promise<Qualification> {
  if (!opts.fresh) {
    const kept = await cachedQualification(tokenId);
    if (kept) return kept;
  }
  const out = await compute(tokenId, true);
  if (pg) await pg`insert into qualifications (token_id, payload, at) values (${tokenId}, ${JSON.stringify(out)}::jsonb, now()) on conflict (token_id) do update set payload = excluded.payload, at = now()`.catch(() => undefined);
  return out;
}

async function compute(tokenId: string, onchain: boolean): Promise<Qualification> {
  const checks: Check[] = [];
  const push = (id: CheckId, state: CheckState, detail: string) => checks.push({ id, label: LABEL[id], state, detail });
  const agent = findAgent(tokenId);
  const listing = listings().find((l) => l.tokenId === tokenId) ?? null;
  const entry = await withTimeout(readRegistryEntry(tokenId).catch(() => null), 12_000);
  const c = archive();
  const onChainWallet = c ? await marketClient.readContract({ address: IDENTITY_REGISTRY as Address, abi: REGISTRY, functionName: "getAgentWallet", args: [BigInt(tokenId)] }).catch(() => null) : null;
  const owner = entry?.owner ?? agent?.owner ?? null;
  const category = (agent?.category ?? listing?.category ?? null) as Category | null;
  const wallets = [...new Set([owner, onChainWallet, listing?.quote?.payTo].filter((w): w is string => Boolean(w && /^0x[0-9a-fA-F]{40}$/.test(w))).map((w) => w.toLowerCase()))];

  // 1. Registered and owned.
  const registeredAt = agent?.registeredBlock ? await marketClient.getBlock({ blockNumber: BigInt(agent.registeredBlock) }).then((b) => Number(b.timestamp), () => null) : null;
  if (!owner) push("owned", "unknown", "The registry could not be read just now.");
  else
    push(
      "owned",
      "pass",
      `#${tokenId} on the ERC-8004 identity registry, BNB Smart Chain, owned by ${owner}${registeredAt ? `, registered ${new Date(registeredAt * 1000).toUTCString().slice(5, 16)}` : ""}, and listed on MANDATE. It counts only if ${owner.slice(0, 8)}… is your registered campaign wallet, and only if it was listed after BNB Chain announced Phase 2.`,
    );

  // 2. Discoverable.
  if (!agent?.name && !entry) push("discoverable", "fail", "Its registration does not resolve to a card we can read.");
  else if (!category) push("discoverable", "fail", "Its card does not say which job it does in words we can file: say yield, grid trading, rebalancing or health factor.");
  else push("discoverable", "pass", `Its card resolves and files it under ${CATEGORY_LABEL[category]}.`);

  // 3. Live.
  const answered = listing?.probe?.answered && listing.probe.at ? Date.parse(listing.probe.at) : null;
  if (listing?.liveness === "live" && answered && Date.now() - answered < DAY * 1000) push("live", "pass", `It answered our last call, ${new Date(answered).toUTCString().slice(5, 22)} UTC.`);
  else if (!listing?.probe) push("live", "pending", "We have not called it yet; it is called within the hour once listed.");
  else push("live", "fail", answered ? `It last answered ${new Date(answered).toUTCString().slice(5, 22)} UTC, more than a day ago.` : "It did not answer our last call as an agent.");

  // 4. Hired by others.
  const hirers = wallets.length ? await withTimeout(hirersOf(tokenId, wallets, owner), 20_000) ?? [] : [];
  push(
    "hired",
    hirers.length >= 3 ? "pass" : "pending",
    `${hirers.length} different wallet${hirers.length === 1 ? "" : "s"} that ${hirers.length === 1 ? "is" : "are"} not its own ${hirers.length === 1 ? "has" : "have"} completed a hire (3 needed)${hirers.length ? `: ${hirers.map((h) => `${h.wallet.slice(0, 8)}… (${h.via}${h.team ? ", MANDATE's own wallet" : ""})`).join("; ")}` : ""}. Counted from hires through MANDATE and escrowed jobs on the shared kernel; per-call hires on other marketplaces are not seen here. BNB Chain also excludes wallets you fund.`,
  );

  // 5 and 6. Its own onchain actions, and whether they fit its job.
  const actions: Action[] = [];
  if (!onchain) {
    push("executes", "unknown", "Reading its wallets' transactions from the chain…");
    push("fits", "unknown", "Reading what its transactions called…");
  } else if (!c) {
    push("executes", "unknown", "No archive node on this deployment, so its transactions were not read.");
    push("fits", "unknown", "No archive node on this deployment.");
  } else {
    const since = registeredAt ?? Math.floor(Date.now() / 1000) - MAX_DAYS * DAY;
    const started = Date.now();
    const acts = await withTimeout(
      Promise.all(
        wallets.map((w) =>
          activity(c, w as Address, since).catch((e: Error) => {
            // Said in the logs, so an archive that refuses us is seen, not guessed at.
            console.warn(`qualify #${tokenId}: reading ${w} failed: ${e.message.split("\n")[0]!.slice(0, 160)}`);
            return null;
          }),
        ),
      ),
      30_000,
    );
    if (acts === null) console.warn(`qualify #${tokenId}: reading its wallets took over 30 s (${Date.now() - started} ms)`);
    const read = (acts ?? []).filter((a): a is WalletActivity => Boolean(a));
    if (!read.length) {
      push("executes", "unknown", "Its wallets' history could not be read just now: the archive node we read it from limits how often it answers. It is read again on the next check, within half an hour.");
      push("fits", "unknown", "Read with its transactions, on the next check.");
    } else {
      const sent = read.reduce((s, a) => s + a.sent, 0);
      const days = new Set(read.flatMap((a) => a.days));
      push(
        "executes",
        sent >= 5 && days.size >= 3 ? "pass" : "pending",
        `${sent} transaction${sent === 1 ? "" : "s"} sent by its wallets since it was registered, on ${days.size} different day${days.size === 1 ? "" : "s"} (5 on 3 needed). Read from ${read.map((a) => a.wallet.slice(0, 8) + "…").join(", ")}; actions taken through a session or smart account on another wallet are not seen here.`,
      );
      // The most recent transactions, newest first, each found and read for what it called.
      const wanted = read
        .flatMap((a) => a.windows.flatMap((w) => Array.from({ length: w.nonceTo - w.nonceFrom }, (_, i) => ({ wallet: a.wallet as Address, nonce: w.nonceFrom + i, w }))))
        .sort((x, y) => Number(y.w.to - x.w.to) || y.nonce - x.nonce)
        .slice(0, SAMPLE);
      const found = (await withTimeout(pool(wanted, 2, (x) => findTx(c, x.wallet, x.nonce, x.w.from, x.w.to).catch(() => null)), 18_000)) ?? [];
      found.forEach((t, i) => {
        if (!t) return;
        const kind = kindOf(t.to, t.input);
        actions.push({ wallet: wanted[i]!.wallet, tx: t.hash, to: t.to, kind, fits: fitsJob(category, kind), at: new Date(t.at * 1000).toISOString() });
      });
      // Work we can name (lending, trades, positions, vaults); housekeeping (approvals, transfers, deliveries, its registration) counts neither way.
      const counted = actions.filter((a) => a.kind === "lending" || a.kind === "trade" || a.kind === "position" || a.kind === "vault");
      const unknownTo = [...new Set(actions.filter((a) => a.kind === "other").map((a) => a.to ?? "contract creation"))];
      const deliveries = actions.filter((a) => a.kind === "delivery").length;
      const fitting = counted.filter((a) => a.fits).length;
      if (!actions.length) push("fits", sent ? "unknown" : "pending", sent ? "Its transactions could not be looked up just now." : "It has no transactions of its own yet.");
      else if (!category) push("fits", "fail", "Its job is not stated, so nothing can fit it.");
      else
        push(
          "fits",
          fitting > 0 && fitting * 2 >= counted.length ? "pass" : counted.length ? "fail" : unknownTo.length ? "unknown" : "pending",
          `Of its ${actions.length} most recent transactions, ${fitting} ${fitting === 1 ? "is" : "are"} ${CATEGORY_LABEL[category].toLowerCase()} work (${[...new Set(actions.map((a) => a.kind))].join(", ")}).${deliveries ? ` ${deliveries} ${deliveries === 1 ? "is a delivery" : "are deliveries"} of jobs to a marketplace contract: work for a buyer, but BNB Chain asks for actions of the job itself (${category === "grid-trading" ? "repeated trades" : category === "rebalancing" ? "adjusting positions" : "lending or vault calls"}).` : ""} ${unknownTo.length ? ` ${unknownTo.length === 1 ? "One calls a contract" : "Some call contracts"} we do not recognise (${unknownTo.map((a) => a.slice(0, 10) + "…").join(", ")}), so we cannot say; BNB Chain reviews those by hand.` : ""} Approvals, transfers and updates to its own registration count neither way.`,
        );
    }
  }

  return { tokenId, name: agent?.name ?? entry?.name ?? null, category, owner, wallets, checks, actions, hirers, at: new Date().toISOString(), ...(onchain ? {} : { reading: true }) };
}

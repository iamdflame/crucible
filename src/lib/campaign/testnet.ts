/**
 * Jobs funded on BNB Chain's testnet escrow, for Set and Earn progress.
 *
 * The campaign counts testnet hires as well as mainnet ones, and four of the
 * shortlisted marketplaces (Pokter, KATTEGAT, Agent Atlas and HelloFugu) hire
 * on testnet, where the buyer pays nothing real. A buyer doing the quest across
 * marketplaces hires on both networks, so their progress here reads both: the
 * mainnet kernel through `kernel_jobs`, this deployment through `testnet_jobs`.
 *
 * The kernel's address is read from BNB's own SDK, never typed. Public testnet
 * nodes cannot be trusted with log reads: on 8 Oct two of them could not find
 * HelloFugu's September transactions and the official one refused a read of a
 * single block. So logs come from thirdweb with our key, at most 1,000 blocks a
 * read (its limit), and a refused range is read again on the next pass rather
 * than taken as empty.
 */

import { createPublicClient, http, type Address, type Hash, type PublicClient } from "viem";
import { bscTestnet } from "viem/chains";
import { getAddress as deployment } from "@bnbagent/sdk/networks";
import { JOB_FUNDED } from "@/lib/escrow/contracts";
import { sql as pg } from "@/lib/db/client";
import { ensureTables } from "@/lib/db/tables";
import { snapshot, store, warm } from "@/lib/data/snapshots";

export const TESTNET_COMMERCE = deployment(97).commerceProxy as Address;
export const TESTNET_EXPLORER = "https://testnet.bscscan.com";

const SPAN = 1_000n;
const PARALLEL = 8;

/** thirdweb answers 429 when reads come fast; a single read waits and tries again, up to five times. */
async function patient<T>(read: () => Promise<T>): Promise<T> {
  let wait = 500;
  for (let i = 0; ; i++) {
    try {
      return await read();
    } catch (e) {
      if (i >= 4) throw e;
      await new Promise((r) => setTimeout(r, wait));
      wait *= 2;
    }
  }
}

function archiveKey(): string | null {
  return (process.env.THIRDWEB_SECRET_KEY || process.env.thirdweb_secret || "").trim() || null;
}

export function testnetClient(): PublicClient | null {
  const key = archiveKey();
  if (!key) return null;
  return createPublicClient({
    chain: bscTestnet,
    transport: http("https://97.rpc.thirdweb.com", { fetchOptions: { headers: { "x-secret-key": key } }, timeout: 20_000, retryCount: 1 }),
  }) as PublicClient;
}

type Funded = { args: { jobId?: bigint; client?: Address; provider?: Address; amount?: bigint }; blockNumber: bigint | null; transactionHash: Hash | null };

/** Stores funded jobs with their block's own time, so a backfilled row is dated when it happened, not when it was read. */
export async function indexTestnetJobs(c: PublicClient, logs: Funded[]): Promise<number> {
  if (!pg || !logs.length) return 0;
  await ensureTables();
  const blocks = [...new Set(logs.map((l) => l.blockNumber).filter((b): b is bigint => b !== null))];
  const times = new Map<bigint, string>();
  for (const b of blocks) {
    const block = await patient(() => c.getBlock({ blockNumber: b }));
    times.set(b, new Date(Number(block.timestamp) * 1000).toISOString());
  }
  const rows = logs
    .filter((l) => l.blockNumber !== null && l.transactionHash && l.args.jobId !== undefined && l.args.client && l.args.provider)
    .map((l) => ({
      job_id: l.args.jobId!.toString(),
      client: l.args.client!.toLowerCase(),
      provider: l.args.provider!.toLowerCase(),
      amount: (l.args.amount ?? 0n).toString(),
      block: Number(l.blockNumber),
      tx: l.transactionHash!.toLowerCase(),
      at: times.get(l.blockNumber!)!,
    }));
  if (!rows.length) return 0;
  await pg`insert into testnet_jobs ${pg(rows, "job_id", "client", "provider", "amount", "block", "tx", "at")} on conflict (job_id) do nothing`;
  return rows.length;
}

/**
 * Reads JobFunded from `from` to `to` in 1,000-block reads, eight at a time,
 * and stops at the first range the node refused. Returns the logs found and
 * the last block read without a gap, so the caller never skips a refused range.
 */
export async function readFunded(c: PublicClient, from: bigint, to: bigint, opts: { deadline: number }): Promise<{ logs: Funded[]; readTo: bigint; refused: boolean }> {
  const logs: Funded[] = [];
  let next = from;
  while (next <= to && Date.now() < opts.deadline) {
    const spans: [bigint, bigint][] = [];
    for (let f = next; f <= to && spans.length < PARALLEL; f += SPAN) spans.push([f, f + SPAN - 1n > to ? to : f + SPAN - 1n]);
    const got = await Promise.all(
      spans.map(([a, b]) => c.getLogs({ address: TESTNET_COMMERCE, event: JOB_FUNDED, fromBlock: a, toBlock: b }).then((l) => l as unknown as Funded[], () => null)),
    );
    for (let i = 0; i < got.length; i++) {
      const g = got[i];
      if (g === null) return { logs, readTo: next - 1n, refused: true };
      logs.push(...g);
      next = spans[i]![1] + 1n;
    }
  }
  return { logs, readTo: next - 1n, refused: false };
}

/** The scheduled pass: from the kept block to the head, inside the budget. */
export async function watchTestnet(opts: { budgetMs: number }): Promise<string> {
  if (!pg) return "no database";
  const c = testnetClient();
  if (!c) return "no archive key for testnet logs";
  await warm(["testnet-watch"]);
  const head = await patient(() => c.getBlockNumber());
  const kept = snapshot<{ block: number }>("testnet-watch")?.payload?.block;
  // With no cursor yet, start near the head; `npm run backfill-testnet-jobs` fills the campaign from its first day.
  const from = kept ? BigInt(kept) + 1n : head - 20_000n;
  if (from > head) return "up to date";
  const r = await readFunded(c, from, head, { deadline: Date.now() + opts.budgetMs - 5_000 });
  const n = await indexTestnetJobs(c, r.logs);
  if (r.readTo >= from) await store("testnet-watch", { block: Number(r.readTo) });
  return `${n} testnet job${n === 1 ? "" : "s"}; read to block ${r.readTo} of ${head}${r.refused ? ", a range was refused and is read again next pass" : ""}`;
}

/** The first testnet block at or after a time, by bisection on block timestamps. */
export async function blockAt(c: PublicClient, iso: string): Promise<bigint> {
  const target = BigInt(Math.floor(Date.parse(iso) / 1000));
  let lo = 0n;
  let hi = await patient(() => c.getBlockNumber());
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const t = (await patient(() => c.getBlock({ blockNumber: mid }))).timestamp;
    if (t < target) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

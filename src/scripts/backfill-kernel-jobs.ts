/**
 * Fills the kernel job index (every job funded on the ERC-8183 kernel, from
 * any marketplace) back to a date, for the Set and Earn checks. The escrow
 * watcher keeps it current from then on.
 *
 *   npx tsx --env-file=.env --env-file=.env.local src/scripts/backfill-kernel-jobs.ts --since 2026-09-25
 */

import type { Address, Hash, Log } from "viem";
import { marketClient } from "@/lib/chain/market";
import { scanLogs } from "@/lib/chain/logs";
import { ESCROW, JOB_FUNDED } from "@/lib/escrow/contracts";
import { indexKernelJobs } from "@/lib/escrow/jobs";

const since = process.argv.includes("--since") ? process.argv[process.argv.indexOf("--since") + 1]! : "2026-09-25";

async function main() {
  const head = await marketClient.getBlock();
  const target = Math.floor(Date.parse(`${since}T00:00:00Z`) / 1000);
  const anchor = await marketClient.getBlock({ blockNumber: head.number - 1_000_000n });
  const rate = Number(head.number - anchor.number) / Number(head.timestamp - anchor.timestamp);
  let from = head.number - BigInt(Math.round((Number(head.timestamp) - target) * rate));
  console.log(`scanning JobFunded from block ${from} (about ${since}) to ${head.number}`);
  let total = 0;
  const step = 100_000n;
  while (from <= head.number) {
    const to = from + step - 1n > head.number ? head.number : from + step - 1n;
    const scan = await scanLogs<Log & { args: { jobId: bigint; client: Address; provider: Address; amount: bigint }; transactionHash: Hash }>({ address: ESCROW.commerce, event: JOB_FUNDED, fromBlock: from, toBlock: to, span: 1_999n });
    if (!scan.complete) {
      console.log(`  ${from}-${to}: ${scan.refused} ranges refused, retrying`);
      continue;
    }
    total += await indexKernelJobs(scan.logs);
    console.log(`  ${from}-${to}: ${scan.logs.length} funded jobs`);
    from = to + 1n;
  }
  console.log(`indexed ${total} funded jobs`);
}

main().then(() => process.exit(0), (e) => { console.error((e as Error).message.split("\n")[0]); process.exit(1); });

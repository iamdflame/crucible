/**
 * Fills the testnet job index (every job funded on BNB's testnet ERC-8183
 * kernel) back to a date, then hands the cursor to the scheduled pass.
 *
 *   npx tsx --env-file=.env --env-file-if-exists=.env.local src/scripts/backfill-testnet-jobs.ts --since 2026-10-01T12:00:00Z
 *
 * A refused range is retried with a growing pause until it is read; the
 * cursor moves only past ranges that were.
 */

import { blockAt, indexTestnetJobs, readFunded, testnetClient, TESTNET_COMMERCE } from "@/lib/campaign/testnet";
import { store } from "@/lib/data/snapshots";
import { CAMPAIGN_STARTS } from "@/lib/campaign/rules";

async function main() {
  const c = testnetClient();
  if (!c) throw new Error("THIRDWEB_SECRET_KEY (or thirdweb_secret) is not set");
  const i = process.argv.indexOf("--since");
  const since = i > -1 ? process.argv[i + 1]! : CAMPAIGN_STARTS;
  const head = await c.getBlockNumber().catch(async () => { await new Promise((r) => setTimeout(r, 2_000)); return c.getBlockNumber(); });
  let from = await blockAt(c, since);
  console.log(`testnet kernel ${TESTNET_COMMERCE}: blocks ${from} to ${head} (${since} to now)`);
  let total = 0;
  let pause = 2_000;
  while (from <= head) {
    const r = await readFunded(c, from, head, { deadline: Date.now() + 60_000 });
    total += await indexTestnetJobs(c, r.logs);
    if (r.readTo >= from) {
      await store("testnet-watch", { block: Number(r.readTo) });
      from = r.readTo + 1n;
      pause = 2_000;
    }
    if (r.refused) {
      await new Promise((res) => setTimeout(res, pause));
      pause = Math.min(pause * 2, 30_000);
    }
    process.stdout.write(`\r  read to ${r.readTo} (${total} jobs)   `);
  }
  console.log(`\n${total} jobs indexed; the scheduled pass continues from block ${head}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

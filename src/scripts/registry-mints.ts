/**
 * The mint transaction of every agent the committed crawl filed under a job.
 *
 * The registry tail records the mint of every agent registered since the
 * crawl; the crawl's own agents were read before that and carried no
 * transaction. 8004scan says where each one was minted, and the chain decides:
 * a mint is kept only when that transaction's receipt shows the identity
 * registry minting that very token. Where the hint is missing or wrong, the
 * blocks around it are searched for the mint instead.
 *
 *   npm run registry-mints            every classified crawl agent without one
 *   npm run registry-mints -- --dry   say what would be stored, write nothing
 */

import { createPublicClient, http, type Hash } from "viem";
import { bsc } from "viem/chains";
import { IDENTITY_REGISTRY } from "@/lib/config";
import { fileIndex, getAgentIndex, type IndexedAgent } from "@/lib/data/agents";
import { getAgent } from "@/lib/sources/scan";
import { mintIn, storeCrawlMints, TRANSFER_TOPIC, warmRegistry } from "@/lib/registry/tail";

const dry = process.argv.includes("--dry");
// Receipts from March are gone from most free providers, which prune old blocks; BNB Chain's own seed keeps them.
const receipts = createPublicClient({ chain: bsc, transport: http("https://bsc-dataseed.bnbchain.org", { timeout: 20_000, retryCount: 2 }) });
const logs = createPublicClient({ chain: bsc, transport: http("https://bsc.rpc.blxrbdn.com", { timeout: 20_000, retryCount: 1 }) });
const ZERO = `0x${"0".repeat(64)}` as const;

async function fromHint(tokenId: string, tx: string): Promise<{ tx: string; block: number; owner: string } | null> {
  const receipt = await receipts.getTransactionReceipt({ hash: tx as Hash }).catch(() => null);
  if (!receipt || receipt.status !== "success") return null;
  const owner = mintIn(receipt.logs, tokenId);
  return owner ? { tx: receipt.transactionHash, block: Number(receipt.blockNumber), owner } : null;
}

async function around(tokenId: string, block: number): Promise<{ tx: string; block: number; owner: string } | null> {
  const topic = `0x${BigInt(tokenId).toString(16).padStart(64, "0")}` as const;
  for (const [from, to] of [[block - 2_500, block + 2_499], [block - 7_500, block - 2_501], [block + 2_500, block + 7_499]]) {
    const found = await logs
      .getLogs({ address: IDENTITY_REGISTRY, fromBlock: BigInt(Math.max(0, from!)), toBlock: BigInt(to!), topics: [TRANSFER_TOPIC, ZERO, null, topic] } as never)
      .catch(() => []);
    const hit = (found as { transactionHash: string; blockNumber: bigint; topics: string[] }[])[0];
    if (hit) return { tx: hit.transactionHash, block: Number(hit.blockNumber), owner: `0x${hit.topics[2]!.slice(26)}`.toLowerCase() };
  }
  return null;
}

async function main() {
  /*
    Crawl agents as the site reads them: the committed file with the registry
    overlay on top. A crawl agent filed under a job later (by the classifier's
    second version, through the overlay) has its job only there, and one whose
    mint was already stored has it only there too.
  */
  await warmRegistry();
  const crawl = new Set(fileIndex().agents.map((a) => a.tokenId));
  const targets = getAgentIndex().agents.filter((a) => crawl.has(a.tokenId) && a.category && !a.registeredTx);
  console.log(`${targets.length} classified crawl agents without a mint transaction${dry ? " (dry run)" : ""}`);
  const found: IndexedAgent[] = [];
  const missing: string[] = [];
  let n = 0;
  const queue = [...targets];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (;;) {
        const a = queue.shift();
        if (!a) return;
        const hint = await getAgent(56, a.tokenId).catch(() => null);
        let mint = hint?.created_tx_hash ? await fromHint(a.tokenId, hint.created_tx_hash) : null;
        if (!mint && hint?.created_block_number) mint = await around(a.tokenId, hint.created_block_number);
        if (mint) found.push({ ...a, registeredTx: mint.tx, registeredBlock: mint.block });
        else missing.push(a.tokenId);
        n += 1;
        if (n % 25 === 0) console.log(`  ${n} of ${targets.length}: ${found.length} confirmed on chain, ${missing.length} not found`);
      }
    }),
  );
  console.log(`${found.length} confirmed on chain; not found: ${missing.join(", ") || "none"}`);
  if (!dry) await storeCrawlMints(found);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error((e as Error).message);
    process.exit(1);
  },
);

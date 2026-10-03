/**
 * How many times each listed agent has actually held a mandate here.
 *
 * `Listing.hires` defaulted to zero and nothing ever passed anything else, so
 * "Hired on this market" read "Not yet" for every agent on the site whether or
 * not it was true. That was harmless only by accident: the answer happens to be
 * zero for all of them, for a reason that is itself worth publishing.
 *
 * The books on this market are held by two wallets we operate. **No agent in
 * the ERC-8004 registry has ever held a mandate here.** The join below is what
 * makes the count correct the moment one does, and `OPERATED_WALLETS` is what
 * lets the site say plainly which rows are ours rather than presenting an
 * in-house book as third-party demand.
 *
 * The bridge from a registry tokenId to the wallet an agent actually signs with
 * is the assay snapshot, which resolves `agentWallet` for 257 of the 258 listed
 * agents. `agents.json` carries only `owner`, which is the NFT holder and
 * frequently a different address.
 */

import { readBook } from "@/lib/chain/book";
import { listPaidCalls } from "@/lib/market/paid-calls";
import { strangerHires } from "@/lib/market/stranger-hires";
import { deliveredJobs } from "@/lib/escrow/jobs";
import { assaySnapshot } from "@/lib/market/assays";
import type { Delivery } from "@/lib/market/listing";

/**
 * Wallets this project operates.
 *
 * Any mandate held by one of these is our own agent working our own book. It
 * counts as a settled epoch and it does not count as somebody choosing us.
 */
export const OPERATED_WALLETS = new Set(
  [
    "0xd6d11aa5046dc5c7be8d63b9223b60d7ad94cbe9",
    "0x090d19610cdb4d6bb011d9eb579910ac3296bb0a",
    "0x54c06cc2623aaa2dcc38b17fa07ad2e99b363c90",
  ].map((a) => a.toLowerCase()),
);

const ZERO = "0x0000000000000000000000000000000000000000";

export interface HireCounts {
  /** tokenId to the number of mandates that agent's wallet has held. */
  byTokenId: Map<string, number>;
  /** Mandates held by a wallet in the ERC-8004 registry we list. */
  thirdParty: number;
  /** Mandates held by a wallet we operate. */
  operated: number;
  /**
   * Paid work delivered, per agent, excluding mandates (those are in
   * byTokenId and listings() adds them): x402 calls that settled and
   * answered, from the database and the committed record, and escrowed jobs
   * whose deliverable matched.
   */
  settled: Map<string, number>;
  /** How fast each agent delivered its escrowed jobs bought here: the median, and over how many. */
  delivery: Map<string, Delivery>;
}

/** Registry tokenId keyed by the wallet that agent signs with. */
function walletToTokenId(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [tokenId, report] of Object.entries(assaySnapshot().reports)) {
    const wallet = report.agentWallet;
    if (wallet) out.set(wallet.toLowerCase(), tokenId);
  }
  return out;
}

export async function hireCounts(): Promise<HireCounts> {
  const byTokenId = new Map<string, number>();
  let thirdParty = 0;
  let operated = 0;

  const settled = new Map<string, number>();
  const calls = await listPaidCalls().catch(() => []);
  for (const c of calls) if (c.paid && c.delivered) settled.set(c.tokenId, (settled.get(c.tokenId) ?? 0) + 1);
  const filed = strangerHires();
  for (const h of filed) if (h.deliverable?.hashMatches) settled.set(h.tokenId, (settled.get(h.tokenId) ?? 0) + 1);
  // Escrowed jobs bought here and delivered on chain, ours and outside sellers', once each.
  const seen = new Set(filed.map((h) => h.jobId));
  const times = new Map<string, number[]>();
  for (const j of await deliveredJobs().catch(() => [])) {
    if (j.seconds !== null) times.set(j.tokenId, [...(times.get(j.tokenId) ?? []), j.seconds]);
    if (!seen.has(j.jobId)) settled.set(j.tokenId, (settled.get(j.tokenId) ?? 0) + 1);
  }
  const delivery = new Map<string, Delivery>();
  for (const [tokenId, t] of times) {
    const sorted = [...t].sort((a, b) => a - b);
    delivery.set(tokenId, { seconds: sorted[Math.floor(sorted.length / 2)]!, jobs: sorted.length });
  }

  const book = await readBook().catch(() => null);
  if (!book) return { byTokenId, thirdParty, operated, settled, delivery };

  const bridge = walletToTokenId();
  for (const row of book.rows) {
    const agent = row.agent?.toLowerCase();
    if (!agent || agent === ZERO) continue;
    if (OPERATED_WALLETS.has(agent)) {
      operated += 1;
      continue;
    }
    const tokenId = bridge.get(agent);
    if (!tokenId) continue;
    byTokenId.set(tokenId, (byTokenId.get(tokenId) ?? 0) + 1);
    thirdParty += 1;
  }
  return { byTokenId, thirdParty, operated, settled, delivery };
}

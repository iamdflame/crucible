/**
 * Paid checks: an agent that answers only a paid job is hired for one, so its
 * answer can be checked against the chain like everybody else's.
 *
 * From our trial pool (keeper A, declared on /status as ours, never counted as
 * anybody's hire), through the same escrow a buyer uses, about the same public
 * test account the free checks ask about. Within $2 a day together with the
 * daily test purchases, each agent at most once in 44 hours, the cheapest
 * first, and never an agent whose work we cannot compare with our own reading:
 * paying for an answer we cannot check buys nothing.
 */

import { encodeFunctionData, getAddress, parseEventLogs, type Address, type Hex } from "viem";
import { sql as pg } from "@/lib/db/client";
import { ensureTables } from "@/lib/db/tables";
import { marketClient, walletFor } from "@/lib/chain/market";
import { WBNB, WBNB_USDT_POOL } from "@/lib/chain/prices";
import { DEMO_ADDRESS } from "@/lib/demo";
import { listings } from "@/lib/market/listing";
import { hirePath } from "@/lib/market/hire-law";
import { listPaidCalls } from "@/lib/market/paid-calls";
import { houseSlug } from "@/lib/market/performance";
import { readRegistryEntry } from "@/lib/sources/registry";
import { negotiateFull, type EscrowQuote } from "@/lib/escrow/a2a";
import { jobDescription } from "@/lib/escrow/sdk";
import { COMMERCE_ABI, DELIVERY_SECONDS, ESCROW, outsideDescription, POLICY_ABI, ROUTER_ABI, TOKEN_ABI } from "@/lib/escrow/contracts";
import { deliver, recordFunded } from "@/lib/escrow/jobs";
import { taskFor, gridTask } from "@/lib/escrow/task";
import { poolNow } from "@/lib/house/services";
import { errorOnly } from "@/lib/conformance/run";
import { warm } from "@/lib/data/snapshots";
import { warmRegistry } from "@/lib/registry/tail";
import { warmOutcomes } from "@/lib/market/hire-law";

const U = 1_000_000_000_000_000_000n;
/** $2 a day, the daily test purchases included. */
export const DAILY_CAP = 2n * U;
/** One check never costs more than a dollar. */
export const PER_HIRE = U;
const EVERY_MS = 44 * 3_600_000;
/** An agent whose last paid answer was only an error is not paid again for a week: the money bought nothing to check. */
const AFTER_ERROR_MS = 7 * 86_400_000;
/** Gas for the five steps with room to spare (job 56802 used 0.0000376 BNB at 0.05 gwei). */
const GAS = 100_000_000_000_000n;

/** A seller's service we can compare with our own reading, by the id it quotes; SDK sellers are asked the standard task. */
const COMPARABLE_SERVICES = new Set(["health_factor", "yield_plan", "grid_plan"]);

/** What a plain seller needs, filled for the test account, or null when it asks for something we would have to invent. */
export function fillNeeds(needs: Record<string, string> | null, grid: { lower: number; upper: number } | null): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [name, description] of Object.entries(needs ?? {})) {
    const optional = /optional|defaults? to/i.test(description);
    if (/address|wallet|account|owner/i.test(name)) out[name] = DEMO_ADDRESS;
    // WBNB itself, even where a pool would do: named the WBNB/USDT pool, a seller may plan for its USDT side instead.
    else if (/^token$/i.test(name)) out[name] = WBNB;
    else if (/pool/i.test(name)) out[name] = WBNB_USDT_POOL;
    else if (/levels?/i.test(name)) out[name] = "10";
    else if (/band/i.test(name)) out[name] = "8";
    else if (/capital|amount/i.test(name)) out[name] = "1000";
    else if (/lower/i.test(name) && grid) out[name] = String(grid.lower);
    else if (/upper/i.test(name) && grid) out[name] = String(grid.upper);
    else if (!optional) return null;
  }
  return out;
}

interface Candidate {
  tokenId: string;
  name: string;
  category: string;
  quote: EscrowQuote;
}

/** The agents a paid check is for: hireable by escrow, not ours, no free answer, and work we can compare. */
function candidates(): { due: Candidate[]; skipped: string[] } {
  const due: Candidate[] = [];
  const skipped: string[] = [];
  for (const l of listings()) {
    const q = l.escrowQuote;
    if (!l.category || !q || q.unpayable || houseSlug(l.tokenId)) continue;
    const v = hirePath(l);
    if (!v.ok || !v.rails.some((r) => r.kind === "escrow") || v.rails.some((r) => r.kind === "x402")) continue;
    // Checked free already: an SDK agent that answers its task without payment.
    if (q.kind === "sdk" && l.checked && l.checked.verdict !== "unreadable" && l.checked.verdict !== "untested") continue;
    if (q.kind !== "sdk" && q.service && !COMPARABLE_SERVICES.has(q.service)) {
      skipped.push(`#${l.tokenId}: its ${q.service} is not work we read from the chain`);
      continue;
    }
    if (BigInt(q.price) > PER_HIRE) {
      skipped.push(`#${l.tokenId}: ${Number(BigInt(q.price)) / 1e18} $U is over the per-check cap`);
      continue;
    }
    due.push({ tokenId: l.tokenId, name: l.name, category: l.category, quote: q });
  }
  due.sort((a, b) => (BigInt(a.quote.price) < BigInt(b.quote.price) ? -1 : 1));
  return { due, skipped };
}

export async function testHires(opts: { budgetMs: number; dry?: boolean }): Promise<string> {
  const raw = process.env.AGENT_A_KEY;
  if (!raw || !pg) return "no trial pool key or database on this deployment";
  await ensureTables();
  const started = Date.now();
  await Promise.all([warm().catch(() => undefined), warmRegistry().catch(() => undefined), warmOutcomes().catch(() => undefined)]);
  const wallet = walletFor((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
  const me = wallet.account.address;

  // Spent in the last day: our escrowed checks and the daily test purchases, together.
  const [row] = (await pg`select coalesce(sum(budget::numeric), 0)::text as spent from escrow_jobs where client = ${me.toLowerCase()} and created_at > now() - interval '24 hours'`) as { spent: string }[];
  const calls = await listPaidCalls().catch(() => []);
  const bought = calls.filter((c) => c.note?.startsWith("Daily test purchase") && Date.parse(c.at) > Date.now() - 86_400_000).reduce((s, c) => s + BigInt(c.amount ?? "0"), 0n);
  let spent = BigInt(row?.spent ?? "0") + bought;

  const lastRows = (await pg`
    select distinct on (token_id) token_id, created_at as at, seller_answer
    from escrow_jobs where client = ${me.toLowerCase()} order by token_id, created_at desc
  `) as { token_id: string; at: Date; seller_answer: string | null }[];
  const last = new Map(lastRows.map((r) => [r.token_id, new Date(r.at).getTime()]));
  const erred = new Set(lastRows.filter((r) => r.seller_answer && errorOnly(r.seller_answer)).map((r) => r.token_id));
  const { due, skipped } = candidates();
  const out = [...skipped];
  const pool = await poolNow().catch(() => null);
  const gridText = pool ? gridTask({}, pool.usdtPerBnb) : null;
  const m = gridText?.match(/between ([\d.]+) and ([\d.]+) USDT/);
  const grid = m ? { lower: Number(m[1]), upper: Number(m[2]) } : null;

  for (const c of due) {
    if (Date.now() - started > opts.budgetMs) break;
    const since = Date.now() - (last.get(c.tokenId) ?? 0);
    if (since < EVERY_MS) continue;
    if (erred.has(c.tokenId) && since < AFTER_ERROR_MS) {
      out.push(`#${c.tokenId}: its last paid answer was an error; tried again after a week`);
      continue;
    }
    const listed = BigInt(c.quote.price);
    if (spent + listed > DAILY_CAP) {
      out.push("daily cap reached");
      break;
    }
    const [u, bnb] = await Promise.all([
      marketClient.readContract({ address: ESCROW.paymentToken, abi: TOKEN_ABI, functionName: "balanceOf", args: [me] }) as Promise<bigint>,
      marketClient.getBalance({ address: me }),
    ]);
    if (u < listed || bnb < GAS) {
      out.push(`the trial pool holds ${Number(u) / 1e18} $U and ${Number(bnb) / 1e18} BNB, too little for #${c.tokenId}`);
      break;
    }

    // The task a buyer would send, about the test account; a plain seller gets its own needs filled.
    const sdkSeller = c.quote.kind === "sdk";
    const inputs = sdkSeller
      ? c.category === "grid-trading" && grid
        ? { lower: String(grid.lower), upper: String(grid.upper), capital: "1000" }
        : { wallet: DEMO_ADDRESS as string }
      : fillNeeds(c.quote.needs, grid);
    if (!inputs) {
      out.push(`#${c.tokenId}: it needs something we would have to invent`);
      continue;
    }
    const task = taskFor(c.category, c.name, inputs, { bnbUsd: pool?.usdtPerBnb ?? null });
    const entry = await readRegistryEntry(c.tokenId).catch(() => null);
    const signers = [entry?.owner, typeof entry?.card?.agentWallet === "string" ? entry.card.agentWallet : null].filter((w): w is string => Boolean(w));
    const live = await negotiateFull(c.quote.a2a, task, { signers, notify: c.quote.notify, skill: c.quote.skill }).catch((e: Error) => ({ error: e.message }));
    if ("error" in live) {
      out.push(`#${c.tokenId}: no quote just now (${live.error.slice(0, 60)})`);
      continue;
    }
    const q = live.quote;
    const price = BigInt(q.price);
    if (q.unpayable || price > PER_HIRE || spent + price > DAILY_CAP) {
      out.push(`#${c.tokenId}: ${q.unpayable ?? "its live price is over the cap"}`);
      continue;
    }
    const description = live.sdk ? jobDescription(live.sdk) : outsideDescription(q.serviceName ?? c.name, q.service, inputs);
    if (opts.dry) {
      spent += price;
      out.push(`#${c.tokenId} ${c.name}: would fund ${Number(price) / 1e18} $U (${live.sdk ? "signed" : "plain"} quote), inputs ${JSON.stringify(inputs)}`);
      continue;
    }

    const send = async (to: Address, data: Hex) => {
      const hash = await wallet.sendTransaction({ to, data } as never);
      const r = await marketClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
      if (r.status !== "success") throw new Error(`reverted ${hash}`);
      return r;
    };
    try {
      const window = BigInt(await marketClient.readContract({ address: ESCROW.policy, abi: POLICY_ABI, functionName: "disputeWindow" }));
      const expiredAt = BigInt(Math.floor(Date.now() / 1000)) + window + BigInt(DELIVERY_SECONDS);
      const created = await send(ESCROW.commerce, encodeFunctionData({ abi: COMMERCE_ABI, functionName: "createJob", args: [getAddress(q.provider), ESCROW.router, expiredAt, description, ESCROW.router] }));
      const jobId = parseEventLogs({ abi: COMMERCE_ABI, eventName: "JobCreated", logs: created.logs })[0]!.args.jobId;
      await send(ESCROW.router, encodeFunctionData({ abi: ROUTER_ABI, functionName: "registerJob", args: [jobId, ESCROW.policy] }));
      await send(ESCROW.commerce, encodeFunctionData({ abi: COMMERCE_ABI, functionName: "setBudget", args: [jobId, price, "0x"] }));
      const allowance = (await marketClient.readContract({ address: ESCROW.paymentToken, abi: TOKEN_ABI, functionName: "allowance", args: [me, ESCROW.commerce] })) as bigint;
      if (allowance < price) await send(ESCROW.paymentToken, encodeFunctionData({ abi: TOKEN_ABI, functionName: "approve", args: [ESCROW.commerce, price] }));
      const funded = await send(ESCROW.commerce, encodeFunctionData({ abi: COMMERCE_ABI, functionName: "fund", args: [jobId, price, "0x"] }));
      spent += price;
      const rec = await recordFunded(jobId, funded.transactionHash, DEMO_ADDRESS, { tokenId: c.tokenId, inputs });
      const told = "refused" in rec ? `record refused: ${rec.refused}` : await deliver(jobId.toString()).catch((e: Error) => `notify failed: ${e.message.slice(0, 60)}`);
      out.push(`#${c.tokenId}: job ${jobId} funded ${Number(price) / 1e18} $U; ${told.slice(0, 80)}`);
    } catch (e) {
      out.push(`#${c.tokenId}: ${(e as Error).message.split("\n")[0]!.slice(0, 100)}`);
      break;
    }
  }
  return `${out.join("; ") || "nothing due"} (spent ${Number(spent) / 1e18} of ${Number(DAILY_CAP) / 1e18} $U today)`;
}

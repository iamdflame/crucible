/**
 * BNB's standard hire, end to end on mainnet, from the test wallet.
 *
 *   npm run escrow-sdk-e2e -- --agent 341554 --task "WBNB/USDT, 1000 USD capital, 10 levels across 10%"
 *   npm run escrow-sdk-e2e -- --agent 269223 --pay-bnb   a seller that reads only its card's example
 *                                                       task, the wallet's shortfall bought with BNB
 *
 * The agent (one built on BNB's agent SDK) signs a quote over A2A; the quote
 * is checked against the wallets its ERC-8004 registration names; the job is
 * opened with the signed description, bound, budgeted, approved and funded
 * exactly as the drawer does; the site's record accepts it on the strength of
 * that signature; and once the agent submits, its DeliverableManifest is
 * fetched from the submission and must hash to what the kernel holds.
 */

import { parseEventLogs, type Hex } from "viem";
import { marketClient, walletFor } from "@/lib/chain/market";
import { COMMERCE_ABI, DELIVERY_SECONDS, ESCROW, POLICY_ABI, ROUTER_ABI, TOKEN_ABI } from "@/lib/escrow/contracts";
import { deliver, jobRow, readJob, recordFunded } from "@/lib/escrow/jobs";
import { escrowSeller, negotiateFull, notifyFunded } from "@/lib/escrow/a2a";
import { jobDescription } from "@/lib/escrow/sdk";
import { attributed, taskFor } from "@/lib/escrow/task";
import { planSwap } from "@/lib/escrow/pay-with-bnb";
import { readRegistryEntry } from "@/lib/sources/registry";
import { findAgent } from "@/lib/data/agents";
import { poolNow } from "@/lib/house/services";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1]! : null;
};

async function main() {
  const raw = process.env.TEST_WALLET_KEY;
  if (!raw) throw new Error("TEST_WALLET_KEY is not set");
  const tokenId = arg("agent") ?? "341554";
  const inputs: Record<string, string> = arg("task") ? { task: arg("task")! } : arg("wallet") ? { wallet: arg("wallet")! } : {};
  for (const k of ["lower", "upper", "capital"]) if (arg(k)) inputs[k] = arg(k)!;
  const wallet = walletFor((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
  const me = wallet.account.address;

  const entry = await readRegistryEntry(tokenId);
  if (!entry) throw new Error(`#${tokenId} could not be read from the registry`);
  const seller = await escrowSeller(entry.services);
  if (!seller) throw new Error(`#${tokenId} does not sell escrowed jobs over A2A`);
  const signers = [entry.owner, typeof entry.card?.agentWallet === "string" ? entry.card.agentWallet : null].filter((w): w is string => Boolean(w));
  const agent = findAgent(tokenId);
  const bnbUsd = agent?.category === "grid-trading" ? await poolNow().then((p) => p.usdtPerBnb, () => null) : null;
  // A seller whose card gives an example task reads only that form, as the drawer now sends it.
  const task = seller.examples[0] && !arg("task") ? attributed(seller.examples[0]) : taskFor(agent?.category ?? null, agent?.name ?? entry.name ?? tokenId, inputs, { bnbUsd });
  const { quote, sdk } = await negotiateFull(seller.url, task, { signers, notify: seller.notify, skill: seller.skill });
  if (!sdk) throw new Error("the agent answered with a plain quote, not BNB's signed form");
  if (quote.unpayable) throw new Error(`quote refused: ${quote.unpayable}`);
  const budget = BigInt(quote.price);
  console.log(`${entry.name}: signed quote ${Number(budget) / 1e18} $U from ${quote.provider} (owner ${entry.owner}); task "${task}"`);

  if (process.argv.includes("--pay-bnb")) {
    const held = await marketClient.readContract({ address: ESCROW.paymentToken, abi: TOKEN_ABI, functionName: "balanceOf", args: [me] });
    if (held < budget) {
      const plan = await planSwap(marketClient, me, budget - held);
      const hash = await wallet.sendTransaction({ to: plan.call.to, data: plan.call.data, value: plan.call.value } as never);
      const r = await marketClient.waitForTransactionReceipt({ hash });
      console.log(`  swap BNB for the ${Number(budget - held) / 1e18} $U short: ${r.status} https://bscscan.com/tx/${hash}`);
      if (r.status !== "success") throw new Error("the swap reverted");
    }
  }

  const send = async (label: string, request: Parameters<typeof wallet.writeContract>[0]) => {
    // A step that reverts in estimation on a node a block behind is tried again on the next blocks.
    let hash: `0x${string}` | null = null;
    for (let attempt = 0; hash === null; attempt++) {
      try {
        hash = await wallet.writeContract(request);
      } catch (e) {
        if (attempt >= 3 || !/revert/i.test((e as Error).message)) throw e;
        await new Promise((ok) => setTimeout(ok, 4_000));
      }
    }
    const r = await marketClient.waitForTransactionReceipt({ hash });
    console.log(`  ${label}: ${r.status} https://bscscan.com/tx/${hash}`);
    if (r.status !== "success") throw new Error(`${label} reverted`);
    return r;
  };
  const disputeWindow = await marketClient.readContract({ address: ESCROW.policy, abi: POLICY_ABI, functionName: "disputeWindow" });
  const expiredAt = BigInt(Math.floor(Date.now() / 1000)) + BigInt(disputeWindow) + BigInt(DELIVERY_SECONDS);
  const created = await send("open the job", { address: ESCROW.commerce, abi: COMMERCE_ABI, functionName: "createJob", args: [quote.provider, ESCROW.router, expiredAt, jobDescription(sdk), ESCROW.router] } as never);
  const jobId = parseEventLogs({ abi: COMMERCE_ABI, eventName: "JobCreated", logs: created.logs })[0]!.args.jobId;
  console.log(`  job #${jobId}`);
  await send("bind it to the policy", { address: ESCROW.router, abi: ROUTER_ABI, functionName: "registerJob", args: [jobId, ESCROW.policy] } as never);
  await send("set the budget", { address: ESCROW.commerce, abi: COMMERCE_ABI, functionName: "setBudget", args: [jobId, budget, "0x"] } as never);
  const allowance = await marketClient.readContract({ address: ESCROW.paymentToken, abi: TOKEN_ABI, functionName: "allowance", args: [me, ESCROW.commerce] });
  if (allowance < budget) await send("approve exactly the budget", { address: ESCROW.paymentToken, abi: TOKEN_ABI, functionName: "approve", args: [ESCROW.commerce, budget] } as never);
  const funded = await send("fund", { address: ESCROW.commerce, abi: COMMERCE_ABI, functionName: "fund", args: [jobId, budget, "0x"] } as never);

  const rec = await recordFunded(jobId, funded.transactionHash, null, { tokenId, inputs });
  if ("refused" in rec) throw new Error(`the site's record refused it: ${rec.refused}`);
  console.log(`  recorded: ${rec.job.status}, on the strength of the signed description`);
  if (seller.notify) console.log(`  told the seller: ${(await notifyFunded(seller.url, jobId.toString(), inputs).catch((e: Error) => ({ text: e.message }))).text.slice(0, 120)}`);

  for (let i = 0; i < 60; i++) {
    if ((await readJob(jobId)).status !== "FUNDED") break;
    await new Promise((ok) => setTimeout(ok, 10_000));
  }
  console.log(`  after waiting: ${await deliver(jobId.toString())}`);
  const row = await jobRow(jobId.toString());
  const job = await readJob(jobId);
  console.log(`  kernel says ${job.status}; deliverable ${job.deliverable}`);
  console.log(`  delivery ${row?.sellerVerified ? "verified against the on-chain hash" : "NOT verified"}; from ${row?.sellerUrl ?? "no URL found"}`);
  console.log(`  answer: ${(row?.sellerAnswer ?? "").slice(0, 300)}`);
  if (job.status !== "SUBMITTED" && job.status !== "COMPLETED") process.exit(1);
  if (!row?.sellerVerified) process.exit(1);
  console.log(`PASS: job #${jobId} hired ${entry.name} by BNB's standard, delivered and verified`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error((e as Error).message.split("\n")[0]);
    process.exit(1);
  },
);

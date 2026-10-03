/**
 * One escrowed job, end to end on mainnet, from the test wallet.
 *
 *   npm run escrow-e2e                    Range-1, about the test wallet itself
 *   npm run escrow-e2e -- --agent guard-1
 *   npm run escrow-e2e -- --api https://www.mandatemarkets.com
 *                                         record and deliver through the live site
 *   npm run escrow-e2e -- --pay-bnb       buy the budget's $U with BNB first, the
 *                                         way the drawer does for a buyer short of
 *                                         $U (lib/escrow/pay-with-bnb), and check
 *                                         exactly the budget arrived
 *
 * The buyer's five transactions exactly as the drawer sends them (open, bind
 * to the policy, budget, approve exactly the budget, fund), then the record
 * this site keeps, then our agent's delivery from its own wallet, then the
 * check that matters: the kernel's deliverable hash equals the keccak256 of
 * the bytes this site serves for it. Escrow opens to buyers only after this
 * passes.
 */

import { keccak256, parseEventLogs, stringToHex, type Hex } from "viem";
import { marketClient, walletFor } from "@/lib/chain/market";
import { COMMERCE_ABI, DELIVERY_SECONDS, ESCROW, HOUSE_BUDGET, POLICY_ABI, ROUTER_ABI, TOKEN_ABI, VIA } from "@/lib/escrow/contracts";
import { deliver, deliverableUrl, jobRow, providerFor, readJob, recordFunded } from "@/lib/escrow/jobs";
import { planSwap } from "@/lib/escrow/pay-with-bnb";
import { formatEther } from "viem";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1]! : fallback;
};

async function main() {
  const raw = process.env.TEST_WALLET_KEY;
  if (!raw) throw new Error("TEST_WALLET_KEY is not set");
  const wallet = walletFor((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
  const me = wallet.account.address;
  const p = providerFor(arg("agent", "range-1"));
  if (!p) throw new Error("no such agent of ours");
  const budget = HOUSE_BUDGET;

  const [u, bnb, disputeWindow] = await Promise.all([
    marketClient.readContract({ address: ESCROW.paymentToken, abi: TOKEN_ABI, functionName: "balanceOf", args: [me] }),
    marketClient.getBalance({ address: me }),
    marketClient.readContract({ address: ESCROW.policy, abi: POLICY_ABI, functionName: "disputeWindow" }),
  ]);
  console.log(`buyer ${me}: ${Number(u) / 1e18} $U, ${Number(bnb) / 1e18} BNB; provider ${p.ref.name} ${p.owner}`);
  // Carry on with a job already opened by an earlier run that stopped part way.
  const resume = arg("job", "");
  if (process.argv.includes("--pay-bnb") && !resume) {
    // The whole budget's worth, so the swap is exercised even when the wallet already holds some $U.
    const plan = await planSwap(marketClient, me, budget);
    console.log(`  swap: ${formatEther(plan.quote)} BNB at the pool's price, at most ${formatEther(plan.maxIn)}, for ${Number(budget) / 1e18} $U`);
    const hash = await wallet.sendTransaction({ to: plan.call.to, data: plan.call.data, value: plan.call.value } as never);
    const r = await marketClient.waitForTransactionReceipt({ hash });
    console.log(`  swap BNB for $U: ${r.status} https://bscscan.com/tx/${hash}`);
    if (r.status !== "success") throw new Error("the swap reverted");
    const [u2, bnb2] = await Promise.all([
      marketClient.readContract({ address: ESCROW.paymentToken, abi: TOKEN_ABI, functionName: "balanceOf", args: [me] }),
      marketClient.getBalance({ address: me }),
    ]);
    const spent = bnb - bnb2 - r.gasUsed * r.effectiveGasPrice;
    console.log(`  received ${formatEther(u2 - u)} $U (asked ${formatEther(budget)}) for ${formatEther(spent)} BNB, plus ${formatEther(r.gasUsed * r.effectiveGasPrice)} BNB gas`);
    if (u2 - u !== budget) throw new Error("the swap did not deliver exactly the budget");
    if (spent > plan.maxIn) throw new Error("the swap took more BNB than its cap");
  }
  const held = await marketClient.readContract({ address: ESCROW.paymentToken, abi: TOKEN_ABI, functionName: "balanceOf", args: [me] });
  if (held < budget) throw new Error("the test wallet needs at least 0.05 $U: run npm run fund-test-wallet first, or pass --pay-bnb");

  const send = async (label: string, request: Parameters<typeof wallet.writeContract>[0]) => {
    /*
      The node that estimates a step can be a block behind the one that mined
      the step before it, and then a good call reads as a revert (3 Oct: job
      56888's registerJob, which simulated fine a moment later). A step that
      reverts in estimation is tried again on the next block before it fails.
    */
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

  const expiredAt = BigInt(Math.floor(Date.now() / 1000)) + BigInt(disputeWindow) + BigInt(DELIVERY_SECONDS);
  const description = `${VIA}: ${p.ref.name} (ERC-8004 #${p.tokenId}) for ${me}`;
  const jobId = resume
    ? BigInt(resume)
    : parseEventLogs({
        abi: COMMERCE_ABI,
        eventName: "JobCreated",
        logs: (await send("open the job", { address: ESCROW.commerce, abi: COMMERCE_ABI, functionName: "createJob", args: [p.owner, ESCROW.router, expiredAt, description, ESCROW.router] } as never)).logs,
      })[0]!.args.jobId;
  console.log(`  job #${jobId}${resume ? " (resumed)" : ""}`);
  await send("bind it to the policy", { address: ESCROW.router, abi: ROUTER_ABI, functionName: "registerJob", args: [jobId, ESCROW.policy] } as never);
  await send("set the budget", { address: ESCROW.commerce, abi: COMMERCE_ABI, functionName: "setBudget", args: [jobId, budget, "0x"] } as never);
  const allowance = await marketClient.readContract({ address: ESCROW.paymentToken, abi: TOKEN_ABI, functionName: "allowance", args: [me, ESCROW.commerce] });
  if (allowance < budget) await send("approve exactly the budget", { address: ESCROW.paymentToken, abi: TOKEN_ABI, functionName: "approve", args: [ESCROW.commerce, budget] } as never);
  const funded = await send("fund", { address: ESCROW.commerce, abi: COMMERCE_ABI, functionName: "fund", args: [jobId, budget, "0x"] } as never);

  const api = arg("api", "");
  let text: string | null = null;
  if (api) {
    // The live site records it and its agent delivers it, exactly as for a buyer in the browser.
    const res = await fetch(`${api}/api/escrow/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId: jobId.toString(), tx: funded.transactionHash }) });
    console.log(`  recorded by ${api}: ${res.status}`);
    for (let i = 0; i < 36; i++) {
      if ((await readJob(jobId)).status !== "FUNDED") break;
      await new Promise((ok) => setTimeout(ok, 5_000));
    }
    const got = await fetch(`${api}/api/escrow/jobs/${jobId}/deliverable`);
    text = got.ok ? await got.text() : null;
    console.log(`  delivery served: ${got.status}`);
  } else {
    const rec = await recordFunded(jobId, funded.transactionHash, null);
    if ("refused" in rec) throw new Error(`recording refused: ${rec.refused}`);
    console.log(`  recorded: ${rec.job.status}`);
    console.log(`  delivery: ${await deliver(jobId.toString())}`);
    text = (await jobRow(jobId.toString()))?.deliverable ?? null;
  }

  const job = await readJob(jobId);
  const served = text ? keccak256(stringToHex(text)) : null;
  const matches = served !== null && served.toLowerCase() === job.deliverable.toLowerCase();
  console.log(`  kernel says ${job.status}; deliverable ${job.deliverable}`);
  console.log(`  served bytes hash to ${served} (${matches ? "match" : "MISMATCH"})`);
  console.log(`  read it: ${deliverableUrl(jobId.toString())}`);
  if (job.status !== "SUBMITTED" || !matches) process.exit(1);
  console.log(`PASS: job #${jobId} funded by the buyer and delivered by ${p.ref.name}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error((e as Error).message.split("\n")[0]);
    process.exit(1);
  },
);

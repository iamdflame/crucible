/**
 * One of our agents hired end to end on BNB Smart Chain testnet, from the test
 * wallet, the way MANDATE's free pack hires it: open, bind, budget, approve
 * and fund on the testnet kernel in test $U, then taken on and delivered, and
 * the delivered manifest's hash checked against the kernel's commitment.
 *
 *   npx tsx --env-file=.env --env-file-if-exists=.env.local src/scripts/escrow-testnet-e2e.ts [guard-1] [--sdk]
 *
 * With --sdk it hires the way a testnet marketplace on BNB's SDK does instead:
 * a quote from the live seller (/a2a/<slug>?chain=97) checked against the
 * agent's wallet, the job opened with that signed quote as its description,
 * and the seller told the job is funded over A2A. Then it waits for delivery.
 *
 * The test wallet's tBNB and test $U come from the principal's testnet
 * balance when it has too little. Testnet only.
 */

import { encodeFunctionData, formatUnits, parseEther, parseEventLogs, parseUnits, type Address, type Hex } from "viem";
import { testnetPublic, testnetWallet, TESTNET_TX } from "@/lib/chain/testnet";
import { COMMERCE_ABI, DELIVERY_SECONDS, ESCROW_TESTNET, HOUSE_BUDGET, POLICY_ABI, ROUTER_ABI, TOKEN_ABI, VIA } from "@/lib/escrow/contracts";
import { deliverTestnet, readTestnetJob, recordTestnetFound, testnetDeliverable, testnetProviderFor, commitmentOf } from "@/lib/escrow/testnet-jobs";
import { checkSdkQuote, jobDescription, type SdkQuote } from "@/lib/escrow/sdk";
import { SITE } from "@/lib/site";

const norm = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as Hex;

async function main() {
  const slug = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "guard-1";
  const sdk = process.argv.includes("--sdk");
  const p = testnetProviderFor(slug);
  if (!p) throw new Error(`${slug} has no testnet identity yet (run register-reference-testnet)`);
  const c = testnetPublic();
  const buyer = testnetWallet(norm(process.env.TEST_WALLET_KEY!));
  const principal = testnetWallet(norm(process.env.PRIVATE_KEY!));
  const me = buyer.account.address;

  // Gas and test $U for the buyer, from the principal's testnet balance.
  if ((await c.getBalance({ address: me })) < parseEther("0.005")) {
    const h = await principal.sendTransaction({ to: me, value: parseEther("0.02") });
    await c.waitForTransactionReceipt({ hash: h });
    console.log(`funded the test wallet 0.02 tBNB: ${TESTNET_TX(h)}`);
  }
  const held = (await c.readContract({ address: ESCROW_TESTNET.paymentToken, abi: TOKEN_ABI, functionName: "balanceOf", args: [me] })) as bigint;
  if (held < HOUSE_BUDGET) {
    const h = await principal.writeContract({ address: ESCROW_TESTNET.paymentToken, abi: [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }], functionName: "transfer", args: [me, parseUnits("0.2", 18)] });
    await c.waitForTransactionReceipt({ hash: h });
    console.log(`sent the test wallet 0.2 test $U: ${TESTNET_TX(h)}`);
  }

  const window = (await c.readContract({ address: ESCROW_TESTNET.policy, abi: POLICY_ABI, functionName: "disputeWindow" })) as bigint;
  const expiredAt = BigInt(Math.floor(Date.now() / 1000)) + window + BigInt(DELIVERY_SECONDS);
  const send = async (label: string, to: Address, data: Hex) => {
    const hash = await buyer.sendTransaction({ to, data });
    const r = await c.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${label} reverted: ${TESTNET_TX(hash)}`);
    console.log(`  ${label}: ${TESTNET_TX(hash)}`);
    return r;
  };
  console.log(`hiring ${p.ref.name} (testnet #${p.tokenId}, provider ${p.owner}) for ${formatUnits(HOUSE_BUDGET, 18)} test $U${sdk ? ", as an SDK buyer" : ""}`);
  let description = `${VIA}: ${p.ref.name} (ERC-8004 testnet #${p.tokenId}) for ${me}`;
  let price = HOUSE_BUDGET;
  const a2a = `${SITE}/a2a/${slug}?chain=97`;
  if (sdk) {
    // The quote, asked of the live seller exactly as an SDK buyer asks it.
    const res = await fetch(a2a, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { kind: "message", role: "user", messageId: crypto.randomUUID(), parts: [{ kind: "data", data: { skill: "negotiate-erc8183-job", task_description: `Health factor for ${me}`, terms: { deliverables: "health report", quality_standards: "read from chain" } } }] } } }),
    });
    const j = (await res.json()) as { result?: { parts?: { data?: SdkQuote & { provider_address?: string } }[] }; error?: { message: string } };
    const q = j.result?.parts?.[0]?.data;
    if (!q) throw new Error(`no quote: ${JSON.stringify(j.error ?? j).slice(0, 200)}`);
    const checked = await checkSdkQuote(q, { chainId: 97, commerce: ESCROW_TESTNET.commerce, token: ESCROW_TESTNET.paymentToken, signers: [p.owner], now: Math.floor(Date.now() / 1000) });
    if ("refused" in checked) throw new Error(`the quote fails an SDK buyer's check: ${checked.refused}`);
    description = jobDescription(q);
    price = checked.ok.price;
    console.log(`  quote: ${formatUnits(price, 18)} test $U, signed by ${p.owner}, checked as an SDK buyer checks it`);
  }
  const created = await send("createJob", ESCROW_TESTNET.commerce, encodeFunctionData({ abi: COMMERCE_ABI, functionName: "createJob", args: [p.owner, ESCROW_TESTNET.router, expiredAt, description, ESCROW_TESTNET.router] }));
  const jobId = parseEventLogs({ abi: COMMERCE_ABI, eventName: "JobCreated", logs: created.logs })[0]!.args.jobId;
  console.log(`  job ${jobId}`);
  await send("registerJob", ESCROW_TESTNET.router, encodeFunctionData({ abi: ROUTER_ABI, functionName: "registerJob", args: [jobId, ESCROW_TESTNET.policy] }));
  await send("setBudget", ESCROW_TESTNET.commerce, encodeFunctionData({ abi: COMMERCE_ABI, functionName: "setBudget", args: [jobId, price, "0x"] }));
  const allowance = (await c.readContract({ address: ESCROW_TESTNET.paymentToken, abi: TOKEN_ABI, functionName: "allowance", args: [me, ESCROW_TESTNET.commerce] })) as bigint;
  if (allowance < price) await send("approve", ESCROW_TESTNET.paymentToken, encodeFunctionData({ abi: TOKEN_ABI, functionName: "approve", args: [ESCROW_TESTNET.commerce, price] }));
  const funded = await send("fund", ESCROW_TESTNET.commerce, encodeFunctionData({ abi: COMMERCE_ABI, functionName: "fund", args: [jobId, price, "0x"] }));

  if (sdk) {
    // Told over A2A, as an SDK buyer tells it; the live seller takes it on and delivers. Then wait for the chain.
    const res = await fetch(a2a, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "message/send", params: { message: { kind: "message", role: "user", messageId: crypto.randomUUID(), parts: [{ kind: "data", data: { skill: "notify_funded", job_id: Number(jobId) } }] } } }) });
    console.log(`  notify_funded: ${res.status} ${(await res.text()).slice(0, 160)}`);
    for (let i = 0; i < 40; i++) {
      const j = await readTestnetJob(jobId);
      if (j.status !== "FUNDED") break;
      await new Promise((ok) => setTimeout(ok, 5_000));
    }
    const job = await readTestnetJob(jobId);
    const body = await fetch(`${SITE}/api/escrow/testnet/jobs/${jobId}/deliverable`).then((r) => (r.ok ? r.text() : null));
    const match = body ? commitmentOf(body).toLowerCase() === job.deliverable.toLowerCase() : false;
    console.log(`job ${jobId}: ${job.status}; deliverable served ${body ? `${body.length} bytes` : "missing"}; hash ${match ? "matches the chain" : "DOES NOT MATCH"}`);
    process.exit(match ? 0 : 1);
  }

  // Taken on and delivered, as the page's call does (retried: a node a block behind can read it as open).
  let r = "";
  for (let i = 0; i < 5; i++) {
    r = await recordTestnetFound(jobId, funded.transactionHash);
    if (r === "recorded" || r === "already recorded") break;
    await new Promise((ok) => setTimeout(ok, 3_000));
  }
  console.log(`record: ${r}`);
  console.log(`deliver: ${await deliverTestnet(jobId.toString())}`);
  const job = await readTestnetJob(jobId);
  const d = await testnetDeliverable(jobId.toString());
  const match = d ? commitmentOf(d.text).toLowerCase() === job.deliverable.toLowerCase() : false;
  console.log(`job ${jobId}: ${job.status}; deliverable ${d ? `${d.text.length} bytes` : "missing"}; hash ${match ? "matches the chain" : "DOES NOT MATCH"}`);
  if (!match) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});

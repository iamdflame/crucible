/**
 * One of our agents hired end to end on BNB Smart Chain testnet, from the test
 * wallet, the way MANDATE's free pack hires it: open, bind, budget, approve
 * and fund on the testnet kernel in test $U, then taken on and delivered, and
 * the delivered manifest's hash checked against the kernel's commitment.
 *
 *   npx tsx --env-file=.env --env-file-if-exists=.env.local src/scripts/escrow-testnet-e2e.ts [guard-1]
 *
 * The test wallet's tBNB and test $U come from the principal's testnet
 * balance when it has too little. Testnet only.
 */

import { encodeFunctionData, formatUnits, parseEther, parseEventLogs, parseUnits, type Address, type Hex } from "viem";
import { testnetPublic, testnetWallet, TESTNET_TX } from "@/lib/chain/testnet";
import { COMMERCE_ABI, DELIVERY_SECONDS, ESCROW_TESTNET, HOUSE_BUDGET, POLICY_ABI, ROUTER_ABI, TOKEN_ABI, VIA } from "@/lib/escrow/contracts";
import { deliverTestnet, readTestnetJob, recordTestnetFound, testnetDeliverable, testnetProviderFor, commitmentOf } from "@/lib/escrow/testnet-jobs";

const norm = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as Hex;

async function main() {
  const slug = process.argv[2] ?? "guard-1";
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
  console.log(`hiring ${p.ref.name} (testnet #${p.tokenId}, provider ${p.owner}) for ${formatUnits(HOUSE_BUDGET, 18)} test $U`);
  const created = await send("createJob", ESCROW_TESTNET.commerce, encodeFunctionData({ abi: COMMERCE_ABI, functionName: "createJob", args: [p.owner, ESCROW_TESTNET.router, expiredAt, `${VIA}: ${p.ref.name} (ERC-8004 testnet #${p.tokenId}) for ${me}`, ESCROW_TESTNET.router] }));
  const jobId = parseEventLogs({ abi: COMMERCE_ABI, eventName: "JobCreated", logs: created.logs })[0]!.args.jobId;
  console.log(`  job ${jobId}`);
  await send("registerJob", ESCROW_TESTNET.router, encodeFunctionData({ abi: ROUTER_ABI, functionName: "registerJob", args: [jobId, ESCROW_TESTNET.policy] }));
  await send("setBudget", ESCROW_TESTNET.commerce, encodeFunctionData({ abi: COMMERCE_ABI, functionName: "setBudget", args: [jobId, HOUSE_BUDGET, "0x"] }));
  const allowance = (await c.readContract({ address: ESCROW_TESTNET.paymentToken, abi: TOKEN_ABI, functionName: "allowance", args: [me, ESCROW_TESTNET.commerce] })) as bigint;
  if (allowance < HOUSE_BUDGET) await send("approve", ESCROW_TESTNET.paymentToken, encodeFunctionData({ abi: TOKEN_ABI, functionName: "approve", args: [ESCROW_TESTNET.commerce, HOUSE_BUDGET] }));
  const funded = await send("fund", ESCROW_TESTNET.commerce, encodeFunctionData({ abi: COMMERCE_ABI, functionName: "fund", args: [jobId, HOUSE_BUDGET, "0x"] }));

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

/**
 * One of our agents hired by BNB's standard, as a buyer on BNB's agent SDK
 * would hire it, end to end on mainnet from the test wallet.
 *
 *   npx tsx --env-file=.env --env-file=.env.local src/scripts/escrow-house-sdk-e2e.ts --agent guard-1
 *
 * Nothing here goes through the site: the agent is found from its ERC-8004
 * registration, its card read where the SDK reads it, a quote asked with the
 * SDK's skill id and checked against the agent's on-chain agentWallet, and the
 * job opened with the signed description, bound, budgeted, approved and
 * funded. The site is never told. The agent must find the job on the kernel
 * itself, as SDK agents do, and deliver a DeliverableManifest whose canonical
 * hash is what it committed, at the URL its submission names.
 *
 * With --wait-for-site the script only watches; otherwise, after three
 * minutes without a delivery, it runs the chain watcher itself (the same code
 * the site's escrow sweep runs).
 */

import { decodeFunctionData, getAddress, hexToString, parseAbi, parseEventLogs, type Hex } from "viem";
import { marketClient, walletFor } from "@/lib/chain/market";
import { IDENTITY_REGISTRY } from "@/lib/config";
import { COMMERCE_ABI, DELIVERY_SECONDS, ESCROW, POLICY_ABI, ROUTER_ABI, TOKEN_ABI } from "@/lib/escrow/contracts";
import { checkSdkQuote, isManifest, jobDescription, manifestHash, type SdkQuote } from "@/lib/escrow/sdk";
import { jobRow, readJob, submitTxOf, watchFunded } from "@/lib/escrow/jobs";
import { REFERENCE, referenceRegistrations } from "@/lib/house";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? (process.argv[i + 1] ?? "") : null;
};
const REGISTRY = parseAbi(["function tokenURI(uint256) view returns (string)", "function getAgentWallet(uint256) view returns (address)"]);

async function registration(uri: string): Promise<{ services: { name?: string; endpoint?: string }[] }> {
  if (uri.startsWith("data:application/json;base64,")) return JSON.parse(Buffer.from(uri.slice(29), "base64").toString("utf8"));
  return (await fetch(uri)).json();
}

async function main() {
  const raw = process.env.TEST_WALLET_KEY;
  if (!raw) throw new Error("TEST_WALLET_KEY is not set");
  const slug = arg("agent") ?? "guard-1";
  const ref = REFERENCE.find((r) => r.slug === slug);
  const reg = referenceRegistrations()[slug];
  if (!ref || !reg) throw new Error(`no agent ${slug}`);
  const tokenId = BigInt(reg.tokenId);
  const wallet = walletFor((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
  const me = wallet.account.address;

  // Discovery, as the SDK's buyer does it.
  const uri = await marketClient.readContract({ address: IDENTITY_REGISTRY as `0x${string}`, abi: REGISTRY, functionName: "tokenURI", args: [tokenId] });
  const agentWallet = await marketClient.readContract({ address: IDENTITY_REGISTRY as `0x${string}`, abi: REGISTRY, functionName: "getAgentWallet", args: [tokenId] });
  const base = (await registration(uri)).services.find((s) => s.name === "A2A")?.endpoint;
  if (!base) throw new Error("no A2A endpoint registered");
  const cardUrl = new URL(base);
  // The SDK's agentCardUrl: appended only when the endpoint is not the card already.
  const path = cardUrl.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/.well-known/agent-card.json")) cardUrl.pathname = `${path}/.well-known/agent-card.json`;
  const card = (await (await fetch(cardUrl)).json()) as { url: string; skills: { id: string }[] };
  console.log(`${ref.name} (#${tokenId}): card ${cardUrl} → ${card.url}; skills ${card.skills.map((s) => s.id).join(", ")}`);

  const task = `${arg("task") ?? `Venus health factor, liquidation distance and repayment advice for ${me}`}, via mandatemarkets.com`;
  const reply = (await (
    await fetch(card.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: { message: { kind: "message", role: "user", messageId: crypto.randomUUID(), parts: [{ kind: "data", data: { skill: "negotiate-erc8183-job", task_description: task, terms: { deliverables: "The report as JSON", quality_standards: "Read from BNB Smart Chain at delivery" } } }] } },
      }),
    })
  ).json()) as { result?: { parts: { data: SdkQuote & { provider_address: string } }[] }; error?: { message: string } };
  if (reply.error) throw new Error(`A2A error: ${reply.error.message}`);
  const quote = reply.result!.parts[0]!.data;
  if (getAddress(quote.provider_address) !== getAddress(agentWallet)) throw new Error("the quote's provider is not the agent's registered agentWallet");
  const checked = await checkSdkQuote(quote, { chainId: 56, commerce: ESCROW.commerce, token: ESCROW.paymentToken, signers: [agentWallet] });
  if ("refused" in checked) throw new Error(`quote refused: ${checked.refused}`);
  const budget = checked.ok.price;
  console.log(`  signed quote: ${Number(budget) / 1e18} $U, expires ${new Date(Number(checked.ok.expiresAt) * 1000).toISOString()}, signer ${checked.ok.provider}`);

  const send = async (label: string, request: Parameters<typeof wallet.writeContract>[0]) => {
    const hash = await wallet.writeContract(request);
    const r = await marketClient.waitForTransactionReceipt({ hash });
    console.log(`  ${label}: ${r.status} https://bscscan.com/tx/${hash}`);
    if (r.status !== "success") throw new Error(`${label} reverted`);
    return r;
  };
  const disputeWindow = await marketClient.readContract({ address: ESCROW.policy, abi: POLICY_ABI, functionName: "disputeWindow" });
  const expiredAt = BigInt(Math.floor(Date.now() / 1000)) + BigInt(disputeWindow) + BigInt(DELIVERY_SECONDS);
  const created = await send("open the job", { address: ESCROW.commerce, abi: COMMERCE_ABI, functionName: "createJob", args: [checked.ok.provider, ESCROW.router, expiredAt, jobDescription(quote), ESCROW.router] } as never);
  const jobId = parseEventLogs({ abi: COMMERCE_ABI, eventName: "JobCreated", logs: created.logs })[0]!.args.jobId;
  console.log(`  job #${jobId}`);
  await send("bind it to the policy", { address: ESCROW.router, abi: ROUTER_ABI, functionName: "registerJob", args: [jobId, ESCROW.policy] } as never);
  await send("set the budget", { address: ESCROW.commerce, abi: COMMERCE_ABI, functionName: "setBudget", args: [jobId, budget, "0x"] } as never);
  const allowance = await marketClient.readContract({ address: ESCROW.paymentToken, abi: TOKEN_ABI, functionName: "allowance", args: [me, ESCROW.commerce] });
  if (allowance < budget) await send("approve exactly the budget", { address: ESCROW.paymentToken, abi: TOKEN_ABI, functionName: "approve", args: [ESCROW.commerce, budget] } as never);
  await send("fund", { address: ESCROW.commerce, abi: COMMERCE_ABI, functionName: "fund", args: [jobId, budget, "0x"] } as never);
  console.log("  funded; the site has not been told. Waiting for the agent to find it on chain…");

  const onlyWatch = arg("wait-for-site") !== null;
  let ranWatcher = false;
  for (let i = 0; i < 90; i++) {
    const job = await readJob(jobId);
    if (job.status !== "FUNDED") break;
    if (!onlyWatch && !ranWatcher && i >= 18) {
      ranWatcher = true;
      console.log(`  no delivery after three minutes; running the chain watcher: ${await watchFunded({ budgetMs: 60_000 })}`);
    }
    await new Promise((ok) => setTimeout(ok, 10_000));
  }

  // Verification, as the SDK's buyer does it: the URL from the submission's optParams, the manifest's canonical hash against the kernel's.
  const job = await readJob(jobId);
  if (job.status !== "SUBMITTED" && job.status !== "COMPLETED") throw new Error(`the job is still ${job.status}`);
  const submitTx = await submitTxOf(jobId.toString(), job.submittedAt);
  if (!submitTx) throw new Error("the submission's transaction could not be found");
  const tx = await marketClient.getTransaction({ hash: submitTx as Hex });
  const call = decodeFunctionData({ abi: COMMERCE_ABI, data: tx.input });
  const opt = JSON.parse(hexToString((call.args as readonly unknown[])[2] as Hex)) as { deliverable_url?: string };
  if (!opt.deliverable_url) throw new Error("the submission carries no deliverable_url");
  const manifest = (await (await fetch(opt.deliverable_url)).json()) as unknown;
  if (!isManifest(manifest)) throw new Error("what the URL serves is not a DeliverableManifest v1");
  const matches = manifestHash(manifest).toLowerCase() === job.deliverable.toLowerCase();
  console.log(`  submitted https://bscscan.com/tx/${submitTx}; manifest at ${opt.deliverable_url}`);
  console.log(`  manifest job_id ${manifest.job_id}, chain ${manifest.chain_id}; canonical hash ${matches ? "MATCHES" : "DOES NOT MATCH"} the kernel's deliverable`);
  console.log(`  content: ${manifest.response.content.slice(0, 300)}`);
  console.log(`  site record: ${(await jobRow(jobId.toString()))?.status ?? "none"}${ranWatcher ? " (found by the watcher run here)" : " (found by the site on its own)"}`);
  if (!matches || manifest.job_id !== Number(jobId)) process.exit(1);
  console.log(`PASS: job #${jobId} hired ${ref.name} by BNB's standard, found on chain, delivered and verified`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error((e as Error).message.split("\n")[0]);
    process.exit(1);
  },
);

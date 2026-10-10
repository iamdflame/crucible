/**
 * Our agents' escrowed jobs on BNB Smart Chain testnet: found, checked,
 * delivered and settled, as lib/escrow/jobs does on mainnet, on the testnet
 * kernel and in test $U.
 *
 * Set and Earn counts testnet hires, and four shortlisted marketplaces hire
 * there for free. Our agents hold testnet identities (#2588 to #2591, from the
 * same wallets that own them on mainnet), so a buyer on any of those
 * marketplaces, or on MANDATE's own free pack, can hire them without real
 * money. The work is the same service a mainnet job runs, about the wallet the
 * job names; only where it is paid and committed differs.
 *
 * Kept apart from the mainnet module on purpose: job numbers on the two
 * kernels collide, the dispute windows differ (15 minutes here, seven days
 * there), and a mistake on testnet must never be able to touch a mainnet job.
 */

import { keccak256, stringToHex, toHex, type Address, type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sql as pg } from "@/lib/db/client";
import { ensureTables } from "@/lib/db/tables";
import { withLease } from "@/lib/db/lease";
import { REFERENCE, referenceRegistrations, referenceRegistrationsTestnet, type ReferenceAgent } from "@/lib/house";
import { HOUSE_SERVICES } from "@/lib/house/services";
import { SITE } from "@/lib/site";
import { testnetPublic, testnetWallet } from "@/lib/chain/testnet";
import { COMMERCE_ABI, ESCROW_TESTNET, HOUSE_BUDGET, JOB_STATUS, POLICY_ABI, ROUTER_ABI, VIA_HOST, type JobStatus } from "./contracts";
import { manifestFor, manifestHash, pyJson, readSignedDescription } from "./sdk";
import { subjectOfTask } from "./seller";

export interface TestnetJob {
  jobId: string;
  client: string;
  provider: string;
  slug: string;
  /** The agent's testnet ERC-8004 id. */
  tokenId: string;
  /** The same agent's mainnet id, where its page lives. */
  mainnetTokenId: string | null;
  budget: string;
  subject: string | null;
  /** Opened through MANDATE (its description names mandatemarkets.com), rather than on another marketplace. */
  here: boolean;
  status: JobStatus;
  fundedTx: string | null;
  submitTx: string | null;
  settleTx: string | null;
  deliverableHash: string | null;
  deliverable: string | null;
  note: string | null;
  createdAt: string;
}

export interface TestnetOnChainJob {
  client: Address;
  provider: Address;
  evaluator: Address;
  hook: Address;
  budget: bigint;
  expiredAt: bigint;
  status: JobStatus;
  submittedAt: bigint;
  deliverable: Hex;
  description: string;
}

export async function readTestnetJob(jobId: bigint): Promise<TestnetOnChainJob> {
  const j = await testnetPublic().readContract({ address: ESCROW_TESTNET.commerce, abi: COMMERCE_ABI, functionName: "getJob", args: [jobId] });
  return {
    client: j.client,
    provider: j.provider,
    evaluator: j.evaluator,
    hook: j.hook,
    budget: j.budget,
    expiredAt: j.expiredAt,
    status: JOB_STATUS[j.status] ?? "OPEN",
    submittedAt: j.submittedAt,
    deliverable: j.deliverable,
    description: j.description,
  };
}

/** Our agents with a testnet identity, by the wallet that owns it (the same wallet as on mainnet). */
export function testnetProviders(): Map<string, { ref: ReferenceAgent; tokenId: string; mainnetTokenId: string | null; owner: Address }> {
  const regs = referenceRegistrationsTestnet();
  const main = referenceRegistrations();
  const out = new Map<string, { ref: ReferenceAgent; tokenId: string; mainnetTokenId: string | null; owner: Address }>();
  for (const ref of REFERENCE) {
    const r = regs[ref.slug];
    if (r) out.set(r.owner.toLowerCase(), { ref, tokenId: r.tokenId, mainnetTokenId: main[ref.slug]?.tokenId ?? null, owner: r.owner });
  }
  return out;
}

export const testnetProviderFor = (slug: string) => [...testnetProviders().values()].find((p) => p.ref.slug === slug) ?? null;

function keyOf(ref: ReferenceAgent): Hex | null {
  const raw = process.env[ref.keyEnv];
  return raw ? ((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex) : null;
}

/** The agent's own key, to sign testnet quotes: the wallet that owns its testnet identity, which is also its agentWallet there. */
export function testnetSigner(slug: string): { address: Address; sign: (hash: Hex) => Promise<Hex> } | null {
  const p = testnetProviderFor(slug);
  const key = p ? keyOf(p.ref) : null;
  if (!p || !key) return null;
  const account = privateKeyToAccount(key);
  if (account.address.toLowerCase() !== p.owner.toLowerCase()) return null;
  return { address: account.address, sign: (hash) => account.signMessage({ message: hash }) };
}

type Row = {
  job_id: string;
  client: string;
  provider: string;
  slug: string;
  token_id: string;
  budget: string;
  subject: string | null;
  here: boolean;
  status: string;
  funded_tx: string | null;
  submit_tx: string | null;
  settle_tx: string | null;
  deliverable: string | null;
  deliverable_hash: string | null;
  note: string | null;
  created_at: Date | string;
};

function toJob(r: Row): TestnetJob {
  const p = testnetProviders().get(r.provider.toLowerCase());
  return {
    jobId: r.job_id,
    client: r.client,
    provider: r.provider,
    slug: r.slug,
    tokenId: r.token_id,
    mainnetTokenId: p?.mainnetTokenId ?? null,
    budget: r.budget,
    subject: r.subject,
    here: r.here,
    status: (JOB_STATUS as readonly string[]).includes(r.status) ? (r.status as JobStatus) : "FUNDED",
    fundedTx: r.funded_tx,
    submitTx: r.submit_tx,
    settleTx: r.settle_tx,
    deliverableHash: r.deliverable_hash,
    deliverable: r.deliverable,
    note: r.note,
    createdAt: typeof r.created_at === "string" ? r.created_at : r.created_at.toISOString(),
  };
}

export async function testnetJobRow(jobId: string): Promise<TestnetJob | null> {
  if (!pg) return null;
  await ensureTables();
  const [r] = (await pg`select * from testnet_escrow_jobs where job_id = ${jobId}`) as Row[];
  return r ? toJob(r) : null;
}

/** A wallet's testnet jobs with our agents, newest first: its hires here on testnet. */
export async function testnetJobsOfClient(client: string): Promise<TestnetJob[]> {
  if (!pg) return [];
  await ensureTables();
  const rows = (await pg`select * from testnet_escrow_jobs where client = ${client.toLowerCase()} order by created_at desc`) as Row[];
  return rows.map(toJob);
}

export const testnetDeliverableUrl = (jobId: string) => `${SITE}/api/escrow/testnet/jobs/${jobId}/deliverable`;

/**
 * Takes on a testnet job funded to one of our agents, with the checks the
 * mainnet watcher makes: ours, funded, bound to the testnet dispute policy,
 * and holding our price, or the price this agent signed, in test $U on chain
 * 97. A job whose description names mandatemarkets.com was opened here.
 */
export async function recordTestnetFound(jobId: bigint, fundTx: Hash | null): Promise<string> {
  if (!pg) return "no database";
  await ensureTables();
  if (await testnetJobRow(jobId.toString())) return "already recorded";
  const job = await readTestnetJob(jobId);
  const p = testnetProviders().get(job.provider.toLowerCase());
  if (!p) return "not one of ours";
  if (job.status !== "FUNDED" && job.status !== "SUBMITTED" && job.status !== "COMPLETED") return `it is ${job.status.toLowerCase()}`;
  if (job.evaluator.toLowerCase() !== ESCROW_TESTNET.router.toLowerCase() || job.hook.toLowerCase() !== ESCROW_TESTNET.router.toLowerCase()) {
    return "not bound to the testnet dispute policy, so it could not be settled";
  }
  const signed = await readSignedDescription(job.description);
  if (signed && "refused" in signed) return `its quote fails its own check: ${signed.refused}`;
  let task = job.description;
  if (signed) {
    if (signed.signer.toLowerCase() !== p.owner.toLowerCase()) return "its quote was not signed by this agent";
    const d = JSON.parse(job.description) as { chain_id?: number; currency?: string };
    if (d.chain_id !== undefined && Number(d.chain_id) !== 97) return `its quote is for chain ${d.chain_id}, not testnet`;
    if (d.currency && d.currency.toLowerCase() !== ESCROW_TESTNET.paymentToken.toLowerCase()) return "its quote is not in test $U";
    if (job.budget < signed.price) return "it holds less than the signed price";
    task = signed.task;
  } else if (job.budget < HOUSE_BUDGET) {
    return "it holds less than this agent's price";
  }
  const about = subjectOfTask(task, p.ref.slug) ?? job.client;
  const here = job.description.includes(VIA_HOST);
  // Told by the page before the index has read it: the funding transaction from the index when it has.
  if (!fundTx) {
    const [t] = (await pg`select tx from testnet_jobs where job_id = ${jobId.toString()}`.catch(() => [])) as { tx: string }[];
    fundTx = (t?.tx as Hash | undefined) ?? null;
  }
  await pg`
    insert into testnet_escrow_jobs (job_id, client, provider, slug, token_id, budget, subject, here, status, funded_tx, expired_at, submitted_at)
    values (${jobId.toString()}, ${job.client.toLowerCase()}, ${job.provider.toLowerCase()}, ${p.ref.slug}, ${p.tokenId}, ${job.budget.toString()},
            ${about}, ${here}, ${job.status}, ${fundTx?.toLowerCase() ?? null}, ${Number(job.expiredAt)}, ${Number(job.submittedAt) || null})
    on conflict (job_id) do nothing
  `;
  return "recorded";
}

/** The answer, as a DeliverableManifest for chain 97 whose canonical JSON hashes to what is committed on chain. */
async function answerFor(row: TestnetJob): Promise<{ text: string; hash: Hex }> {
  const service = HOUSE_SERVICES[row.slug];
  if (!service) throw new Error(`no service for ${row.slug}`);
  const subject = row.subject ?? row.client;
  const input: Record<string, string> = /^\d{1,10}$/.test(subject) ? { position: subject } : { wallet: subject };
  const answer = await service.run(input);
  const body = {
    job: { kernel: ESCROW_TESTNET.commerce, chainId: 97, id: row.jobId, client: row.client, budget: row.budget },
    agent: { name: service.name, erc8004: row.tokenId, network: "bsc-testnet", mainnetErc8004: row.mainnetTokenId, provider: row.provider },
    subject,
    answer,
    deliveredAt: new Date().toISOString(),
  };
  const m = manifestFor(BigInt(row.jobId), 97, { commerce: ESCROW_TESTNET.commerce, router: ESCROW_TESTNET.router, policy: ESCROW_TESTNET.policy }, JSON.stringify(body), "application/json", {
    agent: service.name,
    erc8004: Number(row.tokenId),
    site: SITE,
  });
  return { text: pyJson(m), hash: manifestHash(m) };
}

/** Our agent does the work and submits it on testnet. Idempotent, and leased so two passes never submit twice. */
export async function deliverTestnet(jobId: string): Promise<string> {
  const out = await withLease(`escrow97:${jobId}`, 90, async () => {
    const row = await testnetJobRow(jobId);
    if (!row) return "not recorded";
    const job = await readTestnetJob(BigInt(jobId));
    if (job.status !== "FUNDED") {
      await pg!`update testnet_escrow_jobs set status = ${job.status}, submitted_at = ${Number(job.submittedAt) || null}, updated_at = now() where job_id = ${jobId}`;
      return `already ${job.status.toLowerCase()}`;
    }
    if (BigInt(Math.floor(Date.now() / 1000)) >= job.expiredAt) {
      await pg!`update testnet_escrow_jobs set note = ${"Expired before delivery; the buyer can claim the refund."}, updated_at = now() where job_id = ${jobId}`;
      return "expired before delivery";
    }
    const p = testnetProviders().get(job.provider.toLowerCase());
    const key = p ? keyOf(p.ref) : null;
    if (!p || !key) return "no key for this provider on this deployment";
    // The answer is kept before it is committed to, so the hash on chain always has a body behind it.
    const a = row.deliverableHash && row.deliverable ? { text: row.deliverable, hash: row.deliverableHash as Hex } : await answerFor(row);
    if (!row.deliverableHash) await pg!`update testnet_escrow_jobs set deliverable = ${a.text}, deliverable_hash = ${a.hash}, updated_at = now() where job_id = ${jobId}`;
    const wallet = testnetWallet(key);
    const c = testnetPublic();
    const optParams = toHex(JSON.stringify({ deliverable_url: testnetDeliverableUrl(jobId) }));
    // A node a block behind can read a just-funded job as unfunded; the simulation is retried on the next blocks.
    let request: unknown = null;
    for (let attempt = 0; request === null; attempt++) {
      try {
        request = (await c.simulateContract({ account: wallet.account, address: ESCROW_TESTNET.commerce, abi: COMMERCE_ABI, functionName: "submit", args: [BigInt(jobId), a.hash, optParams] })).request;
      } catch (e) {
        if (attempt >= 3 || !/revert/i.test((e as Error).message)) throw e;
        await new Promise((ok) => setTimeout(ok, 3_000));
      }
    }
    const hash = await wallet.writeContract(request as never);
    const receipt = await c.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success") {
      await pg!`update testnet_escrow_jobs set note = ${`Submit reverted: ${hash}`}, updated_at = now() where job_id = ${jobId}`;
      return `submit reverted ${hash}`;
    }
    const after = await readTestnetJob(BigInt(jobId));
    await pg!`update testnet_escrow_jobs set status = ${after.status}, submit_tx = ${hash.toLowerCase()}, submitted_at = ${Number(after.submittedAt) || null}, note = null, updated_at = now() where job_id = ${jobId}`;
    return `submitted ${hash}`;
  });
  return out ?? "another pass is delivering it";
}

/** Settles a submitted testnet job once its dispute window (15 minutes) has passed, from the agent's own wallet. */
async function settleTestnet(jobId: string, windowSeconds: bigint): Promise<string> {
  const job = await readTestnetJob(BigInt(jobId));
  if (job.status !== "SUBMITTED") {
    await pg!`update testnet_escrow_jobs set status = ${job.status}, updated_at = now() where job_id = ${jobId}`;
    return `${jobId}: ${job.status.toLowerCase()}`;
  }
  if (BigInt(Math.floor(Date.now() / 1000)) < job.submittedAt + windowSeconds) return `${jobId}: in its dispute window`;
  const p = testnetProviders().get(job.provider.toLowerCase());
  const key = p ? keyOf(p.ref) : null;
  if (!key) return `${jobId}: no key to settle with`;
  const wallet = testnetWallet(key);
  const c = testnetPublic();
  const { request } = await c.simulateContract({ account: wallet.account, address: ESCROW_TESTNET.router, abi: ROUTER_ABI, functionName: "settle", args: [BigInt(jobId), "0x"] });
  const hash = await wallet.writeContract(request);
  const receipt = await c.waitForTransactionReceipt({ hash, timeout: 60_000 });
  const after = await readTestnetJob(BigInt(jobId));
  await pg!`update testnet_escrow_jobs set status = ${after.status}, settle_tx = ${receipt.status === "success" ? hash.toLowerCase() : null}, updated_at = now() where job_id = ${jobId}`;
  return `${jobId}: settle ${receipt.status}, now ${after.status.toLowerCase()}`;
}

/**
 * One pass: take on every indexed testnet job funded to our agents, deliver
 * every funded one, and settle every submitted one whose window has passed.
 * Deliveries first: a testnet job, like a mainnet one, has to be submitted
 * within 30 minutes of opening.
 */
export async function sweepTestnet(opts: { budgetMs: number }): Promise<string> {
  if (!pg) return "no database";
  await ensureTables();
  const started = Date.now();
  const left = () => opts.budgetMs - (Date.now() - started);
  const owners = [...testnetProviders().keys()];
  if (!owners.length) return "no testnet identities";
  const done: string[] = [];
  const found = (await pg`
    select t.job_id, t.tx from testnet_jobs t
    where t.provider in ${pg(owners)} and not exists (select 1 from testnet_escrow_jobs e where e.job_id = t.job_id)
    order by t.block desc limit 20
  `) as { job_id: string; tx: string }[];
  for (const f of found) {
    if (left() < 15_000) break;
    const r = await recordTestnetFound(BigInt(f.job_id), f.tx as Hash).catch((e: Error) => `failed: ${e.message.split("\n")[0]}`);
    done.push(`${f.job_id} ${r}`);
  }
  const funded = (await pg`select job_id from testnet_escrow_jobs where status = 'FUNDED' order by created_at desc limit 10`) as { job_id: string }[];
  for (const j of funded) {
    if (left() < 15_000) break;
    done.push(`${j.job_id} ${await deliverTestnet(j.job_id).catch((e: Error) => `deliver failed: ${e.message.split("\n")[0].slice(0, 120)}`)}`);
  }
  const submitted = (await pg`select job_id from testnet_escrow_jobs where status = 'SUBMITTED' order by created_at asc limit 10`) as { job_id: string }[];
  if (submitted.length && left() > 15_000) {
    const window = (await testnetPublic().readContract({ address: ESCROW_TESTNET.policy, abi: POLICY_ABI, functionName: "disputeWindow" }).catch(() => 900n)) as bigint;
    for (const j of submitted) {
      if (left() < 12_000) break;
      done.push(await settleTestnet(j.job_id, window).catch((e: Error) => `${j.job_id}: settle failed: ${e.message.split("\n")[0].slice(0, 120)}`));
    }
  }
  return done.join("; ") || "nothing to do";
}

/** The deliverable as committed: its text hashes to the job's on-chain commitment. */
export async function testnetDeliverable(jobId: string): Promise<{ text: string; hash: string } | null> {
  const row = await testnetJobRow(jobId);
  return row?.deliverable && row.deliverableHash ? { text: row.deliverable, hash: row.deliverableHash } : null;
}

/** keccak256 of the text, for a reader checking the commitment. */
export const commitmentOf = (text: string) => keccak256(stringToHex(text));

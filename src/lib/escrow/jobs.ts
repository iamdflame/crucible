/**
 * Escrowed jobs for our agents: recorded from the chain, delivered by the
 * agent's own wallet, settled on the clock.
 *
 * A buyer funds a job in their browser; this file never takes their word for
 * any of it. A job is recorded only when the kernel says it is FUNDED, names
 * one of our agents' wallets as provider, and was funded by the wallet it is
 * filed under. The agent then runs the same service its paid call sells,
 * about the subject the buyer named, keeps the answer, and submits its hash
 * from its own wallet with the answer's address in the policy's optParams, as
 * every ERC-8183 reader expects. After the policy's dispute window, anyone may
 * settle, and our keeper does, so the agent is paid without anyone watching.
 *
 * Outside sellers that price escrow over A2A are recorded the same way, from
 * the chain, against the quote the census holds for the agent the buyer
 * picked. We cannot deliver for them: we tell their seller the job is funded,
 * with what the buyer entered, keep the answer it gives back, and read its
 * submission from the kernel. One that lets a job pass its deadline
 * undelivered is taken off sale until it delivers again.
 */

import { keccak256, parseEventLogs, stringToHex, toHex, type Address, type Hash, type Hex, type Log } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { logClients, marketClient, walletFor } from "@/lib/chain/market";
import { sql as pg } from "@/lib/db/client";
import { ensureTables } from "@/lib/db/tables";
import { withLease } from "@/lib/db/lease";
import { REFERENCE, referenceRegistrations, type ReferenceAgent } from "@/lib/house";
import { HOUSE_SERVICES } from "@/lib/house/services";
import { SITE } from "@/lib/site";
import { getProbes } from "@/lib/data/probes";
import { snapshot, store, warm } from "@/lib/data/snapshots";
import { scanLogs } from "@/lib/chain/logs";
import { COMMERCE_ABI, ESCROW, HOUSE_BUDGET, JOB_FUNDED, JOB_STATUS, POLICY_ABI, ROUTER_ABI, VIA_HOST, type JobStatus } from "./contracts";
import { notifyFunded } from "./a2a";
import { isManifest, manifestFor, manifestHash, pyJson, readSignedDescription } from "./sdk";
import { subjectOfTask } from "./seller";
import { safeFetch } from "@/lib/net/safe-fetch";
import { readRegistryEntry } from "@/lib/sources/registry";

export interface EscrowJob {
  jobId: string;
  client: string;
  provider: string;
  slug: string;
  tokenId: string;
  budget: string;
  subject: string | null;
  status: JobStatus;
  fundedTx: string | null;
  submitTx: string | null;
  settleTx: string | null;
  deliverableHash: string | null;
  expiredAt: number | null;
  submittedAt: number | null;
  note: string | null;
  createdAt: string;
  /** Sold by an outside seller through its A2A quote, not delivered by one of ours. */
  outside: boolean;
  /** What the buyer entered for an outside seller, as it was sent. */
  inputs: Record<string, string> | null;
  /** Where the outside seller says its deliverable is. */
  sellerUrl: string | null;
}

export interface OnChainJob {
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

export async function readJob(jobId: bigint): Promise<OnChainJob> {
  const j = await marketClient.readContract({ address: ESCROW.commerce, abi: COMMERCE_ABI, functionName: "getJob", args: [jobId] });
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

/** Our agents that take escrowed jobs, by the wallet that owns each one's registration. */
export function providers(): Map<string, { ref: ReferenceAgent; tokenId: string; owner: Address }> {
  const regs = referenceRegistrations();
  const out = new Map<string, { ref: ReferenceAgent; tokenId: string; owner: Address }>();
  for (const ref of REFERENCE) {
    const r = regs[ref.slug];
    if (r) out.set(r.owner.toLowerCase(), { ref, tokenId: r.tokenId, owner: r.owner });
  }
  return out;
}

export const providerFor = (slug: string) => [...providers().values()].find((p) => p.ref.slug === slug) ?? null;

function providerKey(ref: ReferenceAgent): Hex | null {
  const raw = process.env[ref.keyEnv];
  return raw ? ((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex) : null;
}

/**
 * One of our agents' own wallet, to sign quotes in BNB's standard: the key
 * that owns its ERC-8004 registration, which is also its on-chain agentWallet,
 * the address an SDK buyer checks a quote against. Null where this deployment
 * holds no key for it.
 */
export function houseSigner(slug: string): { address: Address; sign: (hash: Hex) => Promise<Hex> } | null {
  const p = providerFor(slug);
  const key = p ? providerKey(p.ref) : null;
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
  status: string;
  funded_tx: string | null;
  submit_tx: string | null;
  settle_tx: string | null;
  deliverable_hash: string | null;
  expired_at: string | number | null;
  submitted_at: string | number | null;
  note: string | null;
  created_at: Date | string;
  inputs?: string | null;
  seller_url?: string | null;
};

const toJob = (r: Row): EscrowJob => ({
  jobId: r.job_id,
  client: r.client,
  provider: r.provider,
  slug: r.slug,
  tokenId: r.token_id,
  budget: r.budget,
  subject: r.subject,
  status: r.status as JobStatus,
  fundedTx: r.funded_tx,
  submitTx: r.submit_tx,
  settleTx: r.settle_tx,
  deliverableHash: r.deliverable_hash,
  expiredAt: r.expired_at === null ? null : Number(r.expired_at),
  submittedAt: r.submitted_at === null ? null : Number(r.submitted_at),
  note: r.note,
  createdAt: new Date(r.created_at).toISOString(),
  outside: r.slug === "",
  inputs: r.inputs ? (JSON.parse(r.inputs) as Record<string, string>) : null,
  sellerUrl: r.seller_url ?? null,
});

let columns: Promise<void> | null = null;
/** The columns outside sellers need, added once to a table created before them. Idempotent. */
function outsideColumns(): Promise<void> {
  /*
    Read first, alter only when a column is missing. ALTER TABLE takes an
    exclusive lock and every read of the table queues behind it while it
    waits, so running it on each new instance could stall every escrow read on
    the site behind one slow session. When it must run, it gives up after 3 s.
  */
  columns ??= (async () => {
    await ensureTables();
    const have = (await pg!`select column_name from information_schema.columns where table_name = 'escrow_jobs'`) as { column_name: string }[];
    const names = new Set(have.map((c) => c.column_name));
    if (["inputs", "seller_answer", "seller_url", "notified_at", "seller_verified"].every((c) => names.has(c))) return;
    // One multi-statement query, one implicit transaction, so the lock timeout holds (no sql.begin: see db/tables.ts ddl).
    await pg!.unsafe(
      `set local lock_timeout = '3s'; alter table escrow_jobs add column if not exists inputs text, add column if not exists seller_answer text, add column if not exists seller_url text, add column if not exists notified_at timestamptz, add column if not exists seller_verified boolean`,
    );
  })().catch((e) => {
    columns = null;
    throw e;
  });
  return columns;
}

/** A recorded job, with the exact text our agent delivered, when it has. */
export async function jobRow(jobId: string): Promise<(EscrowJob & { deliverable: string | null; sellerAnswer: string | null; sellerVerified: boolean | null }) | null> {
  if (!pg) return null;
  await outsideColumns();
  const [r] = (await pg`select * from escrow_jobs where job_id = ${jobId}`) as (Row & { deliverable: string | null; seller_answer?: string | null; seller_verified?: boolean | null })[];
  return r ? { ...toJob(r), deliverable: r.deliverable, sellerAnswer: r.seller_answer ?? null, sellerVerified: r.seller_verified ?? null } : null;
}

/** Every job funded here for one agent, newest first: its track record on this marketplace. */
export async function jobsOfAgent(tokenId: string): Promise<EscrowJob[]> {
  if (!pg) return [];
  await outsideColumns();
  const rows = (await pg`select * from escrow_jobs where token_id = ${tokenId} order by created_at desc limit 50`) as Row[];
  return rows.map(toJob);
}

/** Jobs funded here that the agent delivered on chain (submitted, or submitted and paid), one entry per job. */
/**
 * Jobs delivered on chain, with how long each took: from our record of the
 * funding, written moments after it, to the kernel's submission time. A job we
 * only learned of later reads as slow, so a negative or day-long gap is null.
 */
export async function deliveredJobs(): Promise<{ tokenId: string; jobId: string; seconds: number | null }[]> {
  if (!pg) return [];
  await outsideColumns();
  const rows = (await pg`select token_id, job_id, extract(epoch from created_at)::float8 as created, submitted_at from escrow_jobs where status in ('SUBMITTED', 'COMPLETED')`) as {
    token_id: string;
    job_id: string;
    created: number;
    submitted_at: string | number | null;
  }[];
  return rows.map((r) => {
    const took = r.submitted_at === null ? null : Number(r.submitted_at) - Number(r.created);
    return { tokenId: r.token_id, jobId: r.job_id, seconds: took !== null && took >= 0 && took < 86_400 ? Math.max(1, Math.round(took)) : null };
  });
}

export async function jobsOfClient(client: string): Promise<EscrowJob[]> {
  if (!pg) return [];
  await outsideColumns();
  const rows = (await pg`select * from escrow_jobs where client = ${client.toLowerCase()} order by created_at desc limit 200`) as Row[];
  return rows.map(toJob);
}

const addressLike = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);

/**
 * Records a job the buyer funded, from the chain alone. Returns why it was
 * refused, or the job. The subject is what the agent is asked about: the
 * buyer's own wallet unless they named a position.
 */
export async function recordFunded(
  jobId: bigint,
  fundTx: Hash,
  subject: string | null,
  outside: { tokenId: string; inputs: Record<string, string> } | null = null,
): Promise<{ job: EscrowJob } | { refused: string; status: number }> {
  if (!pg) return { refused: "This deployment keeps no database.", status: 503 };
  const [job, receipt] = await Promise.all([readJob(jobId), marketClient.getTransactionReceipt({ hash: fundTx }).catch(() => null)]);
  if (!receipt) return { refused: "That funding transaction is not on BNB Smart Chain yet.", status: 404 };
  if (receipt.status !== "success") return { refused: "That funding transaction reverted.", status: 400 };
  /*
    The kernel's own event is the proof, whatever sent the transaction. A
    wallet that batches the five steps into one confirmation sends it to the
    buyer's own account (EIP-7702) or through a bundler, never to the escrow
    directly, so the transaction's to and from prove nothing either way.
  */
  const funded = parseEventLogs({ abi: COMMERCE_ABI, eventName: "JobFunded", logs: receipt.logs.filter((l) => l.address.toLowerCase() === ESCROW.commerce.toLowerCase()) });
  if (!funded.some((l) => l.args.jobId === jobId)) return { refused: "That transaction did not fund this job on the ERC-8183 escrow.", status: 400 };
  if (!funded.some((l) => l.args.jobId === jobId && l.args.client.toLowerCase() === job.client.toLowerCase())) return { refused: "That job was funded by a different wallet from its client.", status: 400 };
  if (job.status !== "FUNDED" && job.status !== "SUBMITTED" && job.status !== "COMPLETED") return { refused: `That job is ${job.status.toLowerCase()}, not funded.`, status: 400 };
  const p = providers().get(job.provider.toLowerCase());
  if (!p && outside) return recordOutside(jobId, fundTx, job, outside);
  if (!p) return { refused: "That job's provider is not one of MANDATE's agents.", status: 400 };
  const about = subject && (addressLike(subject) || /^\d{1,10}$/.test(subject)) ? subject : job.client;

  await outsideColumns();
  await pg`
    insert into escrow_jobs (job_id, client, provider, slug, token_id, budget, subject, status, funded_tx, expired_at, submitted_at)
    values (${jobId.toString()}, ${job.client.toLowerCase()}, ${job.provider.toLowerCase()}, ${p.ref.slug}, ${p.tokenId}, ${job.budget.toString()},
            ${about}, ${job.status}, ${fundTx.toLowerCase()}, ${Number(job.expiredAt)}, ${Number(job.submittedAt) || null})
    on conflict (job_id) do update set status = excluded.status, funded_tx = coalesce(escrow_jobs.funded_tx, excluded.funded_tx), updated_at = now()
  `;
  const row = await jobRow(jobId.toString());
  return { job: row! };
}

/**
 * A job funded for an outside seller: kept only when it is the job the census
 * priced for that agent, bound to the optimistic policy (so the buyer can
 * dispute and reclaim), and opened here.
 */
async function recordOutside(jobId: bigint, fundTx: Hash, job: OnChainJob, o: { tokenId: string; inputs: Record<string, string> }): Promise<{ job: EscrowJob } | { refused: string; status: number }> {
  /*
    A job in BNB's standard form carries the agent's signed quote, and is
    checked on that alone: the signer must be a wallet the agent's
    registration names, the provider that signer, and the budget the signed
    price. Any other job is checked against the price the census holds.
  */
  const signed = await readSignedDescription(job.description);
  if (signed && "refused" in signed) return { refused: `That job's description fails its own check: ${signed.refused}.`, status: 400 };
  if (signed) {
    const entry = await readRegistryEntry(o.tokenId).catch(() => null);
    const names = [entry?.owner, typeof entry?.card?.agentWallet === "string" ? entry.card.agentWallet : null].filter(Boolean).map((w) => String(w).toLowerCase());
    if (!names.includes(signed.signer.toLowerCase())) return { refused: "That job's quote is signed by a wallet this agent's registration does not name.", status: 400 };
    if (signed.signer.toLowerCase() !== job.provider.toLowerCase()) return { refused: "That job names a different provider from the wallet that signed its quote.", status: 400 };
    if (job.budget < signed.price) return { refused: "That job holds less than the signed price.", status: 400 };
  } else {
    // The census this instance holds may predate the quote; read the newest.
    await warm(["probe"]);
    const q = getProbes().escrowQuotes?.[o.tokenId];
    if (!q || q.unpayable) return { refused: "That agent has no escrow price on record here.", status: 400 };
    if (q.provider.toLowerCase() !== job.provider.toLowerCase()) return { refused: "That job names a different provider from the one this agent's seller quoted.", status: 400 };
    if (job.budget < BigInt(q.price)) return { refused: "That job holds less than the seller's price.", status: 400 };
  }
  if (job.evaluator.toLowerCase() !== ESCROW.router.toLowerCase() || job.hook.toLowerCase() !== ESCROW.router.toLowerCase()) {
    return { refused: "That job is not bound to the escrow's dispute policy.", status: 400 };
  }
  if (!job.description.includes(VIA_HOST)) return { refused: "That job was not opened here.", status: 400 };
  const inputs = Object.fromEntries(Object.entries(o.inputs).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k) && typeof v === "string" && v.length <= 400));
  const about = Object.values(inputs).find((v) => addressLike(v) || /^\d{1,10}$/.test(v)) ?? null;
  await outsideColumns();
  await pg!`
    insert into escrow_jobs (job_id, client, provider, slug, token_id, budget, subject, status, funded_tx, expired_at, submitted_at, inputs)
    values (${jobId.toString()}, ${job.client.toLowerCase()}, ${job.provider.toLowerCase()}, ${""}, ${o.tokenId}, ${job.budget.toString()},
            ${about}, ${job.status}, ${fundTx.toLowerCase()}, ${Number(job.expiredAt)}, ${Number(job.submittedAt) || null}, ${JSON.stringify(inputs)})
    on conflict (job_id) do update set status = excluded.status, funded_tx = coalesce(escrow_jobs.funded_tx, excluded.funded_tx), updated_at = now()
  `;
  const row = await jobRow(jobId.toString());
  return { job: row! };
}

/**
 * The transaction that submitted a job, from the kernel's own event. The
 * kernel stamps when it was submitted, so the search is a narrow window of
 * blocks around that moment rather than a long scan most RPCs refuse.
 */
export async function submitTxOf(jobId: string, submittedAt: bigint): Promise<string | null> {
  if (!submittedAt) return null;
  const latest = await marketClient.getBlock().catch(() => null);
  if (!latest) return null;
  // BSC makes a block about every 0.45 s; the window allows for the estimate being off.
  const around = latest.number - BigInt(Math.ceil(Math.max(0, Number(latest.timestamp - submittedAt)) / 0.45));
  const logs = await marketClient
    .getContractEvents({
      address: ESCROW.commerce,
      abi: COMMERCE_ABI,
      eventName: "JobSubmitted",
      args: { jobId: BigInt(jobId) },
      fromBlock: around - 1_500n,
      toBlock: around + 1_500n > latest.number ? latest.number : around + 1_500n,
    })
    .catch(() => []);
  return logs[0]?.transactionHash?.toLowerCase() ?? null;
}

/**
 * What an outside agent delivered, read from its own submission: the URL in
 * the transaction's optParams, fetched, and checked against the hash the
 * kernel holds. A DeliverableManifest (BNB's standard form) is checked by its
 * canonical hash and shown by its content; anything else by its raw bytes.
 */
async function readDelivery(jobId: string, submittedAt: bigint, onChain: string): Promise<void> {
  if (!submittedAt || /^0x0{64}$/.test(onChain)) return;
  const txHash = await submitTxOf(jobId, submittedAt);
  if (!txHash) return;
  const tx = await marketClient.getTransaction({ hash: txHash as Hash }).catch(() => null);
  if (!tx) return;
  // The URL is plain UTF-8 inside the call data, whether the call went straight to the kernel or through a smart account.
  const url = Buffer.from(tx.input.slice(2), "hex").toString("latin1").match(/"deliverable_url"\s*:\s*"(https:\/\/[^"\s]{1,400})"/)?.[1];
  if (!url) return;
  const res = await safeFetch(url, { timeoutMs: 10_000, maxBytes: 512 * 1024, headers: { accept: "application/json" } }).catch(() => null);
  if (!res || res.status !== 200) {
    await pg!`update escrow_jobs set seller_url = coalesce(seller_url, ${url}), updated_at = now() where job_id = ${jobId}`;
    return;
  }
  let answer = res.text;
  let verified = keccak256(stringToHex(res.text)).toLowerCase() === onChain.toLowerCase();
  try {
    const parsed = JSON.parse(res.text) as unknown;
    if (isManifest(parsed)) {
      verified = manifestHash(parsed).toLowerCase() === onChain.toLowerCase();
      answer = parsed.response.content;
    } else if (!verified) {
      verified = manifestHash(parsed).toLowerCase() === onChain.toLowerCase();
    }
  } catch {
    /* not JSON: the raw bytes stand */
  }
  // A verified delivery replaces whatever the seller said when told; an unverified one only fills a gap.
  if (verified) {
    await pg!`update escrow_jobs set seller_answer = ${answer.slice(0, 200_000)}, seller_url = ${url}, seller_verified = true, updated_at = now() where job_id = ${jobId}`;
  } else {
    await pg!`update escrow_jobs set seller_answer = coalesce(seller_answer, ${answer.slice(0, 200_000)}), seller_url = coalesce(seller_url, ${url}), seller_verified = false, updated_at = now() where job_id = ${jobId}`;
  }
}

/**
 * Tells an outside seller its job is funded, at most every few minutes until
 * it submits, and brings our record up to what the kernel says. An agent on
 * BNB's SDK watches the chain for funded jobs, so it is not told; its delivery
 * is read from its submission once it lands.
 */
async function notifyOutside(row: EscrowJob & { sellerAnswer: string | null; sellerVerified: boolean | null }): Promise<string> {
  const job = await readJob(BigInt(row.jobId));
  if (job.status !== "FUNDED") {
    const submitTx = row.submitTx ?? (await submitTxOf(row.jobId, job.submittedAt));
    await pg!`update escrow_jobs set status = ${job.status}, submitted_at = ${Number(job.submittedAt) || null}, submit_tx = ${submitTx}, deliverable_hash = ${/^0x0{64}$/.test(job.deliverable) ? null : job.deliverable}, updated_at = now() where job_id = ${row.jobId}`;
    if (!row.sellerVerified) await readDelivery(row.jobId, job.submittedAt, job.deliverable).catch(() => undefined);
    return `seller ${job.status.toLowerCase()}`;
  }
  if (BigInt(Math.floor(Date.now() / 1000)) >= job.expiredAt) {
    await pg!`update escrow_jobs set note = ${"The seller did not deliver before the deadline; the buyer can claim the refund."}, updated_at = now() where job_id = ${row.jobId}`;
    return "expired undelivered";
  }
  const [r] = (await pg!`select notified_at from escrow_jobs where job_id = ${row.jobId}`) as { notified_at: Date | null }[];
  if (r?.notified_at && Date.now() - new Date(r.notified_at).getTime() < 3 * 60_000) return "seller told recently";
  await warm(["probe"]);
  const q = getProbes().escrowQuotes?.[row.tokenId];
  if (!q) return "no seller endpoint on record";
  if (q.notify === false) return "the seller watches the chain for funded jobs";
  await pg!`update escrow_jobs set notified_at = now() where job_id = ${row.jobId}`;
  const told = await notifyFunded(q.a2a, row.jobId, row.inputs ?? {}).catch((e: Error) => ({ text: null, url: null, error: e.message }));
  if ("error" in told) {
    await pg!`update escrow_jobs set note = ${`Telling the seller failed: ${told.error.slice(0, 160)}. Tried again in a few minutes.`}, updated_at = now() where job_id = ${row.jobId}`;
    return `seller not reached: ${told.error.slice(0, 80)}`;
  }
  // An SDK agent answers the notice with an acknowledgement; its work is read from its submission, not from this.
  if (q.kind === "sdk") await pg!`update escrow_jobs set note = null, updated_at = now() where job_id = ${row.jobId}`;
  else await pg!`update escrow_jobs set seller_answer = ${told.text!.slice(0, 200_000)}, seller_url = ${told.url}, note = null, updated_at = now() where job_id = ${row.jobId}`;
  // Some sellers submit before they answer; read the kernel once more.
  const after = await readJob(BigInt(row.jobId));
  if (after.status !== "FUNDED") {
    const submitTx = await submitTxOf(row.jobId, after.submittedAt);
    await pg!`update escrow_jobs set status = ${after.status}, submitted_at = ${Number(after.submittedAt) || null}, submit_tx = ${submitTx}, deliverable_hash = ${after.deliverable}, updated_at = now() where job_id = ${row.jobId}`;
    await readDelivery(row.jobId, after.submittedAt, after.deliverable).catch(() => undefined);
    return `seller told; ${after.status.toLowerCase()}`;
  }
  return "seller told";
}

/** Outside sellers whose most recent job here passed its deadline with nothing submitted, by token id. */
export async function missedEscrowJobs(): Promise<Map<string, { jobId: string; at: string }>> {
  if (!pg) return new Map();
  await outsideColumns();
  const rows = (await pg`
    select distinct on (token_id) token_id, job_id, status, submitted_at, expired_at
    from escrow_jobs where slug = '' order by token_id, created_at desc
  `) as { token_id: string; job_id: string; status: string; submitted_at: string | number | null; expired_at: string | number | null }[];
  const now = Math.floor(Date.now() / 1000);
  const out = new Map<string, { jobId: string; at: string }>();
  for (const r of rows) {
    if (r.submitted_at || r.expired_at === null || Number(r.expired_at) > now) continue;
    if (r.status !== "FUNDED" && r.status !== "EXPIRED") continue;
    out.set(r.token_id, { jobId: r.job_id, at: new Date(Number(r.expired_at) * 1000).toISOString() });
  }
  return out;
}

/** The answer our agent gives for a job: its service's own run, about the job's subject. Canonical JSON, so its hash can be re-derived. */
async function answerFor(row: EscrowJob, manifest = false): Promise<{ body: Record<string, unknown>; text: string; hash: Hex }> {
  const service = HOUSE_SERVICES[row.slug];
  if (!service) throw new Error(`no service for ${row.slug}`);
  const subject = row.subject ?? row.client;
  const input: Record<string, string> = /^\d{1,10}$/.test(subject) ? { position: subject } : { wallet: subject };
  const answer = await service.run(input);
  const body = {
    job: { kernel: ESCROW.commerce, id: row.jobId, client: row.client, budget: row.budget },
    agent: { name: service.name, erc8004: row.tokenId, provider: row.provider },
    subject,
    answer,
    deliveredAt: new Date().toISOString(),
  };
  /*
    A job in BNB's standard form is answered as its buyer's SDK reads it: a
    DeliverableManifest v1 whose canonical JSON hashes to what we commit on
    chain, served as that same text at the deliverable URL.
  */
  if (manifest) {
    const m = manifestFor(BigInt(row.jobId), 56, { commerce: ESCROW.commerce, router: ESCROW.router, policy: ESCROW.policy }, JSON.stringify(body), "application/json", { agent: service.name, erc8004: Number(row.tokenId), site: SITE });
    return { body, text: pyJson(m), hash: manifestHash(m) };
  }
  const text = JSON.stringify(body);
  return { body, text, hash: keccak256(stringToHex(text)) };
}

export const deliverableUrl = (jobId: string) => `${SITE}/api/escrow/jobs/${jobId}/deliverable`;

/**
 * Our agent does the work and submits it. Idempotent: a job already submitted
 * on chain is only brought up to date here, and a delivery in flight holds a
 * lease so two ticks never submit twice.
 */
export async function deliver(jobId: string): Promise<string> {
  const out = await withLease(`escrow:${jobId}`, 90, async () => {
    const row = await jobRow(jobId);
    if (!row) return "not recorded";
    if (row.outside) return notifyOutside(row);
    const job = await readJob(BigInt(jobId));
    if (job.status !== "FUNDED") {
      await pg!`update escrow_jobs set status = ${job.status}, submitted_at = ${Number(job.submittedAt) || null}, updated_at = now() where job_id = ${jobId}`;
      return `already ${job.status.toLowerCase()}`;
    }
    if (BigInt(Math.floor(Date.now() / 1000)) >= job.expiredAt) {
      await pg!`update escrow_jobs set note = ${"Expired before delivery; the buyer can claim the refund."}, updated_at = now() where job_id = ${jobId}`;
      return "expired before delivery";
    }
    const p = providers().get(job.provider.toLowerCase());
    const key = p ? providerKey(p.ref) : null;
    if (!p || !key) return "no key for this provider on this deployment";

    // The answer is kept before it is committed to, so the hash on chain always has a body behind it.
    const signed = await readSignedDescription(job.description);
    const a = row.deliverableHash && row.deliverable ? { text: row.deliverable, hash: row.deliverableHash as Hex } : await answerFor(row, Boolean(signed && "signer" in signed));
    if (!row.deliverableHash) {
      await pg!`update escrow_jobs set deliverable = ${a.text}, deliverable_hash = ${a.hash}, updated_at = now() where job_id = ${jobId}`;
    }
    const wallet = walletFor(key);
    const account = wallet.account;
    const optParams = toHex(JSON.stringify({ deliverable_url: deliverableUrl(jobId) }));
    /*
      Delivered the moment the buyer's record arrives, which is moments after
      their funding: the node that simulates can be a block behind and read
      the job as unfunded (3 Oct, job 56888 waited for the five-minute sweep).
      A submission that reverts in simulation is tried again on the next
      blocks before it is left to the sweep.
    */
    let request: unknown = null;
    for (let attempt = 0; request === null; attempt++) {
      try {
        request = (await marketClient.simulateContract({ account, address: ESCROW.commerce, abi: COMMERCE_ABI, functionName: "submit", args: [BigInt(jobId), a.hash, optParams] })).request;
      } catch (e) {
        if (attempt >= 3 || !/revert/i.test((e as Error).message)) throw e;
        await new Promise((ok) => setTimeout(ok, 3_000));
      }
    }
    const hash = await wallet.writeContract(request as never);
    const receipt = await marketClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success") {
      await pg!`update escrow_jobs set note = ${`Submit reverted: ${hash}`}, updated_at = now() where job_id = ${jobId}`;
      return `submit reverted ${hash}`;
    }
    const after = await readJob(BigInt(jobId));
    await pg!`update escrow_jobs set status = ${after.status}, submit_tx = ${hash.toLowerCase()}, submitted_at = ${Number(after.submittedAt) || null}, note = null, updated_at = now() where job_id = ${jobId}`;
    return `submitted ${hash}`;
  });
  return out ?? "another slice is delivering it";
}

/** Settles a submitted job once the dispute window has passed, from our keeper's wallet. */
async function settle(jobId: string, windowSeconds: bigint): Promise<string> {
  const job = await readJob(BigInt(jobId));
  if (job.status !== "SUBMITTED") {
    await pg!`update escrow_jobs set status = ${job.status}, updated_at = now() where job_id = ${jobId}`;
    return `${jobId}: ${job.status.toLowerCase()}`;
  }
  // An outside seller's submission is its own transaction; it is read from the kernel's event once, with its delivery.
  const [known] = (await pg!`select submit_tx, slug, seller_verified from escrow_jobs where job_id = ${jobId}`) as { submit_tx: string | null; slug: string; seller_verified: boolean | null }[];
  if (known && known.slug === "" && !known.seller_verified) await readDelivery(jobId, job.submittedAt, job.deliverable).catch(() => undefined);
  if (known && !known.submit_tx) {
    const found = await submitTxOf(jobId, job.submittedAt);
    if (found) await pg!`update escrow_jobs set submit_tx = ${found}, updated_at = now() where job_id = ${jobId}`;
  }
  if (BigInt(Math.floor(Date.now() / 1000)) < job.submittedAt + windowSeconds) return `${jobId}: in its dispute window`;
  const raw = process.env.AGENT_A_KEY;
  if (!raw) return `${jobId}: no keeper key`;
  const wallet = walletFor((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
  const account = wallet.account;
  const { request } = await marketClient.simulateContract({ account, address: ESCROW.router, abi: ROUTER_ABI, functionName: "settle", args: [BigInt(jobId), "0x"] });
  const hash = await wallet.writeContract(request);
  const receipt = await marketClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  const after = await readJob(BigInt(jobId));
  await pg!`update escrow_jobs set status = ${after.status}, settle_tx = ${receipt.status === "success" ? hash.toLowerCase() : null}, updated_at = now() where job_id = ${jobId}`;
  return `${jobId}: settle ${receipt.status}, now ${after.status.toLowerCase()}`;
}

/**
 * A job funded to one of our agents that nobody told us about. A buyer on
 * BNB's SDK opens and funds the job and then waits for the agent to notice,
 * as the standard has it; this is our agents noticing. The job is taken on
 * only when it is ours and will pay: bound to the dispute policy our keeper
 * settles through, holding at least our price, and, when it carries a signed
 * quote, one this agent signed and that had not lapsed when it was funded, the
 * checks the SDK's own agents make before they work.
 */
export async function recordFound(jobId: bigint, fundTx: Hash | null): Promise<string> {
  if (!pg) return "no database";
  await outsideColumns();
  if (await jobRow(jobId.toString())) return "already recorded";
  const job = await readJob(jobId);
  fundTx ??= await fundTxOf(jobId);
  const p = providers().get(job.provider.toLowerCase());
  if (!p) return "not one of ours";
  if (job.status !== "FUNDED" && job.status !== "SUBMITTED" && job.status !== "COMPLETED") return `it is ${job.status.toLowerCase()}`;
  if (job.evaluator.toLowerCase() !== ESCROW.router.toLowerCase() || job.hook.toLowerCase() !== ESCROW.router.toLowerCase()) return "not bound to the dispute policy, so it could not be settled";
  const signed = await readSignedDescription(job.description);
  if (signed && "refused" in signed) return `its quote fails its own check: ${signed.refused}`;
  let task = job.description;
  if (signed) {
    if (signed.signer.toLowerCase() !== p.owner.toLowerCase()) return "its quote was not signed by this agent";
    if (job.budget < signed.price) return "it holds less than the signed price";
    const expires = (JSON.parse(job.description) as { quote_expires_at?: number }).quote_expires_at;
    if (typeof expires === "number" && fundTx) {
      const receipt = await marketClient.getTransactionReceipt({ hash: fundTx }).catch(() => null);
      const block = receipt ? await marketClient.getBlock({ blockNumber: receipt.blockNumber }).catch(() => null) : null;
      if (block && BigInt(expires) <= block.timestamp) return "it was funded after its quote lapsed";
    }
    task = signed.task;
  } else if (job.budget < HOUSE_BUDGET) {
    return "it holds less than this agent's price";
  }
  const about = subjectOfTask(task, p.ref.slug) ?? job.client;
  await pg`
    insert into escrow_jobs (job_id, client, provider, slug, token_id, budget, subject, status, funded_tx, expired_at, submitted_at)
    values (${jobId.toString()}, ${job.client.toLowerCase()}, ${job.provider.toLowerCase()}, ${p.ref.slug}, ${p.tokenId}, ${job.budget.toString()},
            ${about}, ${job.status}, ${fundTx?.toLowerCase() ?? null}, ${Number(job.expiredAt)}, ${Number(job.submittedAt) || null})
    on conflict (job_id) do nothing
  `;
  return "recorded";
}

/** The transaction that funded a job, from the kernel's event: the job id is an indexed topic, so each range is a cheap query. */
async function fundTxOf(jobId: bigint): Promise<Hash | null> {
  const head = await marketClient.getBlockNumber();
  for (let to = head; to > head - 40_000n; to -= 2_000n) {
    for (const client of logClients) {
      const logs = await client.getLogs({ address: ESCROW.commerce, event: JOB_FUNDED, args: { jobId }, fromBlock: to - 1_999n, toBlock: to }).catch(() => null);
      if (logs === null) continue;
      if (logs[0]?.transactionHash) return logs[0].transactionHash;
      break;
    }
  }
  return null;
}

/**
 * Every funded job the watcher reads, whoever opened it and on whichever
 * marketplace: the kernel is shared, so this is who hired whom across all of
 * them, for an agent's Set and Earn checks.
 */
export async function indexKernelJobs(logs: { args: { jobId: bigint; client: Address; provider: Address; amount: bigint }; blockNumber: bigint | null; transactionHash: Hash | null }[]): Promise<number> {
  if (!pg || !logs.length) return 0;
  await ensureTables();
  const rows = logs
    .filter((l) => l.blockNumber !== null && l.transactionHash)
    .map((l) => ({ job_id: l.args.jobId.toString(), client: l.args.client.toLowerCase(), provider: l.args.provider.toLowerCase(), amount: l.args.amount.toString(), block: Number(l.blockNumber), tx: l.transactionHash!.toLowerCase() }));
  for (let i = 0; i < rows.length; i += 500) {
    await pg`insert into kernel_jobs ${pg(rows.slice(i, i + 500), "job_id", "client", "provider", "amount", "block", "tx")} on conflict (job_id) do nothing`;
  }
  return rows.length;
}

/**
 * Reads the kernel's JobFunded events since the last pass and takes on every
 * job funded to one of our agents. The block read up to is kept, and moved
 * only past ranges every node answered, so a refused range is read again
 * rather than taken as empty.
 */
export async function watchFunded(opts: { budgetMs: number }): Promise<string> {
  if (!pg) return "no database";
  const started = Date.now();
  await warm(["escrow-watch"]);
  const head = await marketClient.getBlockNumber();
  const kept = snapshot<{ block: number }>("escrow-watch")?.payload?.block;
  const from = kept ? BigInt(kept) + 1n : head - 2_000n;
  if (from > head) return "up to date";
  const to = head - from > 20_000n ? from + 20_000n : head;
  const scan = await scanLogs<Log & { args: { jobId: bigint; client: Address; provider: Address; amount: bigint } }>({ address: ESCROW.commerce, event: JOB_FUNDED, fromBlock: from, toBlock: to, span: 1_999n });
  if (!scan.complete) return `${scan.refused} of ${scan.ranges} ranges refused; read again next pass`;
  await indexKernelJobs(scan.logs).catch(() => undefined);
  const ours = scan.logs.filter((l) => providers().has(l.args.provider.toLowerCase()));
  const done: string[] = [];
  for (const l of ours) {
    if (Date.now() - started > opts.budgetMs) return `${done.join("; ")}; out of time before block ${to}`;
    const r = await recordFound(l.args.jobId, l.transactionHash ?? null).catch((e: Error) => `failed: ${e.message.split("\n")[0]}`);
    done.push(`${l.args.jobId} ${r}`);
    if (r === "recorded") done.push(`${l.args.jobId} ${await deliver(l.args.jobId.toString()).catch((e: Error) => `deliver failed: ${e.message.split("\n")[0]}`)}`);
  }
  await store("escrow-watch", { block: Number(to) });
  return `blocks ${from}-${to}: ${done.join("; ") || "no new jobs for our agents"}`;
}

/** The scheduled pass: deliver anything funded and undelivered, settle anything past its window. */
export async function sweepEscrow(opts: { budgetMs: number }): Promise<string> {
  if (!pg) return "no database";
  await outsideColumns();
  const started = Date.now();
  // Jobs funded to our agents on chain by buyers who never came through this site.
  const watched = await watchFunded({ budgetMs: Math.min(8_000, opts.budgetMs / 2) }).catch((e: Error) => `watch failed: ${e.message.split("\n")[0]}`);
  /*
    A funded job past its deadline is the buyer's to reclaim; it no longer takes a slot here.
    Deliveries go first: a buyer is waiting on a funded job, while a submitted
    one only waits out its seven-day window. Oldest first was starving them:
    on 3 Oct a job funded at 15:59 waited two ticks behind sixteen outside
    sellers' jobs (each told and read again, some timing out) and twenty
    settlements. Ours now go first, then outside sellers' newest first.
  */
  const funded = (await pg`
    select job_id, status from escrow_jobs
    where status = 'FUNDED' and (expired_at is null or expired_at > extract(epoch from now())::bigint)
    order by (slug <> '') desc, created_at desc limit 20
  `) as { job_id: string; status: string }[];
  const submitted = (await pg`select job_id, status from escrow_jobs where status = 'SUBMITTED' order by created_at asc limit 20`) as { job_id: string; status: string }[];
  // Our own deliveries, then outside sellers' newest first, then settlements.
  const open = [...funded, ...submitted];
  if (!open.length) return `watch: ${watched}; no open jobs`;
  const windowSeconds = await marketClient.readContract({ address: ESCROW.policy, abi: POLICY_ABI, functionName: "disputeWindow" });
  const done: string[] = [];
  for (const j of open) {
    if (Date.now() - started > opts.budgetMs) break;
    const r = j.status === "FUNDED" ? await deliver(j.job_id).catch((e) => `failed: ${(e as Error).message.split("\n")[0]}`) : await settle(j.job_id, windowSeconds).catch((e) => `failed: ${(e as Error).message.split("\n")[0]}`);
    done.push(`${j.job_id} ${r}`);
  }
  return `watch: ${watched}; ${done.join("; ")}`;
}

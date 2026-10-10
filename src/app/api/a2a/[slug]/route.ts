/**
 * Our agents' A2A endpoint, in BNB's standard: how a buyer on BNB's agent SDK
 * (an Agent Studio agent, Marque, the SDK's own buyer script) hires one.
 *
 *   GET  /a2a/guard-1/.well-known/agent-card.json   the agent card
 *   POST /a2a/guard-1                                JSON-RPC 2.0 message/send
 *   POST /a2a/guard-1/negotiate                      the SDK agent-server's plain form
 *
 * Skills, with the ids the SDK's examples use and the shorter ones agents on
 * this registry use:
 *   negotiate-erc8183-job (negotiate)   a quote the agent signs with its own key
 *   erc8183-job-status (job_status)     one job, read from the kernel
 *   notify_funded                       "job N is funded": delivered now, not on the next pass
 *
 * The buyer anchors the quote in createJob's description, funds the job, and
 * the agent, which watches the kernel for jobs funded to it, delivers a
 * DeliverableManifest whose hash it commits on chain.
 *
 * With `?chain=97` the same agent sells on BNB Smart Chain testnet, under its
 * testnet identity: the card, the quote (in test $U, on the testnet kernel),
 * job status and delivery are all testnet's. Its testnet registration points
 * here with that parameter, so a testnet marketplace hires it there.
 */

import { after, NextResponse } from "next/server";
import { getAddress } from "viem";
import { referenceBySlug, type ReferenceAgent } from "@/lib/house";
import { HOUSE_SERVICES } from "@/lib/house/services";
import { hirePauseForSlug } from "@/lib/market/paused";
import { SITE } from "@/lib/site";
import { take, callerOf } from "@/lib/api/ratelimit";
import { ESCROW, ESCROW_TESTNET, HOUSE_BUDGET, JOB_STATUS } from "@/lib/escrow/contracts";
import { ESCROW_OPEN } from "@/lib/escrow/open";
import { deliver, houseSigner, providerFor, readJob, recordFound } from "@/lib/escrow/jobs";
import { quoteAsSeller, REASON, SKILL } from "@/lib/escrow/seller";
import { deliverTestnet, readTestnetJob, recordTestnetFound, testnetDeliverableUrl, testnetProviderFor, testnetSigner } from "@/lib/escrow/testnet-jobs";

/** The chain a request is for: testnet when it says `?chain=97`, mainnet otherwise. */
const onTestnet = (request: Request) => new URL(request.url).searchParams.get("chain") === "97";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** A quote costs a signature, as in the SDK's example: a limit per caller, and one for everybody. */
const PER_CALLER = { capacity: 30, windowMs: 60_000 };
const EVERYONE = { capacity: 600, windowMs: 60_000 };
/** Our agents deliver on the next pass of the escrow sweep, or at once when told. */
const ETA_SECONDS = 600;

const HEADERS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: HEADERS });
const rpcError = (id: unknown, code: number, message: string, status = 200) => json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);
const rpcResult = (id: unknown, data: Record<string, unknown>) =>
  json({ jsonrpc: "2.0", id: id ?? null, result: { kind: "message", role: "agent", messageId: crypto.randomUUID(), parts: [{ kind: "data", data }] } });

const WHAT: Record<ReferenceAgent["slug"], string> = {
  "guard-1": "the Venus health factor, liquidation distance and repayment advice for the wallet named in the task (or the buyer's own wallet)",
  "range-1": "a range check and recenter plan for every PancakeSwap V3 position of the wallet named in the task, or the position id named",
  "yield-1": "the best USDT placement between Venus and Aave at the current block, and the idle cash of the wallet named in the task",
  "grid-1": "Grid-1's live trading window on PancakeSwap V3 WBNB/USDT (fills, win rate, drawdown) and its next signal",
};

function card(agent: ReferenceAgent, testnet = false) {
  const base = `${SITE}/a2a/${agent.slug}${testnet ? "?chain=97" : ""}`;
  const price = HOUSE_BUDGET.toString();
  const where = testnet ? "BNB Smart Chain testnet, in test $U" : "BNB Smart Chain";
  return {
    protocolVersion: "0.3.0",
    name: agent.name,
    description: `${agent.description} Also hired as an ERC-8183 escrowed job in BNB's standard${testnet ? ", here on BNB Smart Chain testnet in test $U" : ""}: ask negotiate-erc8183-job for a quote it signs, open the job with the quote in its description, fund it, and it delivers ${WHAT[agent.slug]}.`,
    url: base,
    preferredTransport: "JSONRPC",
    version: "1.0.0",
    documentationUrl: `${SITE}/agents/${providerFor(agent.slug)?.tokenId ?? ""}`,
    provider: { organization: "MANDATE", url: SITE },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "negotiate-erc8183-job",
        name: "Negotiate an ERC-8183 job",
        description: `Send a data part {"skill": "negotiate-erc8183-job", "task_description": "...", "terms": {"deliverables": "...", "quality_standards": "..."}} and receive a quote this agent signs (EIP-191, its ERC-8004 agentWallet): ${price} base units of $U on ${where}, lasting 900 seconds. Anchor it with createJob; the agent delivers ${WHAT[agent.slug]}.`,
        tags: ["erc8183", "negotiation", "bnb-chain"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
      { id: "negotiate", name: "Negotiate (short name)", description: "The same as negotiate-erc8183-job.", tags: ["erc8183"], inputModes: ["application/json"], outputModes: ["application/json"] },
      { id: "erc8183-job-status", name: "ERC-8183 job status", description: 'Send {"skill": "erc8183-job-status", "job_id": <int>} for a read of the job from the kernel.', tags: ["erc8183", "status"], inputModes: ["application/json"], outputModes: ["application/json"] },
      { id: "notify_funded", name: "Job funded", description: 'Send {"skill": "notify_funded", "job_id": <int>} after funding to have it delivered now rather than on the next pass of the chain.', tags: ["erc8183"], inputModes: ["application/json"], outputModes: ["application/json"] },
    ],
    erc8183: testnet
      ? {
          chain_id: 97,
          commerce: ESCROW_TESTNET.commerce,
          router: ESCROW_TESTNET.router,
          policy: ESCROW_TESTNET.policy,
          payment_token: ESCROW_TESTNET.paymentToken,
          price,
          provider: testnetProviderFor(agent.slug)?.owner ?? null,
          erc8004: testnetProviderFor(agent.slug)?.tokenId ?? null,
          estimated_completion_seconds: ETA_SECONDS,
        }
      : {
          chain_id: 56,
          commerce: ESCROW.commerce,
          router: ESCROW.router,
          policy: ESCROW.policy,
          payment_token: ESCROW.paymentToken,
          price,
          provider: providerFor(agent.slug)?.owner ?? null,
          estimated_completion_seconds: ETA_SECONDS,
        },
  };
}

/** A quote, or why none is given: this deployment holds no key, the agent is paused, or escrowed jobs are closed here. */
async function quote(agent: ReferenceAgent, data: Record<string, unknown>, testnet = false): Promise<Record<string, unknown> | { unavailable: string }> {
  if (!HOUSE_SERVICES[agent.slug]) return { unavailable: "no service" };
  const pause = hirePauseForSlug(agent.slug);
  const signer = testnet ? testnetSigner(agent.slug) : houseSigner(agent.slug);
  if (pause || !ESCROW_OPEN || !signer) {
    const reason = pause ? `${agent.name} is paused: ${pause.reason}` : "Escrowed jobs are not open on this deployment.";
    return { request: data, request_hash: "", response: { accepted: false, reason_code: pause ? "0x05" : REASON.UNSUPPORTED, reason }, response_hash: "" };
  }
  return quoteAsSeller(data, {
    chainId: testnet ? 97 : 56,
    commerce: getAddress(testnet ? ESCROW_TESTNET.commerce : ESCROW.commerce),
    token: getAddress(testnet ? ESCROW_TESTNET.paymentToken : ESCROW.paymentToken),
    price: HOUSE_BUDGET,
    etaSeconds: ETA_SECONDS,
    now: Math.floor(Date.now() / 1000),
    provider: signer.address,
    sign: signer.sign,
  });
}

const limited = (request: Request) => !take(callerOf(request), PER_CALLER).ok || !take("a2a:everyone", EVERYONE).ok;

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: HEADERS });
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const agent = referenceBySlug((await params).slug);
  if (!agent) return json({ error: "No agent by that name here." }, 404);
  return NextResponse.json(card(agent, onTestnet(request)), { headers: { ...HEADERS, "cache-control": "public, max-age=300" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const agent = referenceBySlug((await params).slug);
  if (!agent) return json({ error: "No agent by that name here." }, 404);
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return rpcError(null, -32600, "Invalid Request", 400);
  const testnet = onTestnet(request);

  // The SDK agent-server's form: the negotiation request itself, answered with the envelope.
  if (new URL(request.url).searchParams.get("mode") === "negotiate" || (body.jsonrpc === undefined && "terms" in body)) {
    if (limited(request)) return json({ detail: "Too many requests" }, 429);
    const q = await quote(agent, body, testnet);
    return "unavailable" in q ? json({ error: q.unavailable }, 503) : json(q);
  }

  const id = body.id;
  if (body.jsonrpc !== "2.0" || !("method" in body)) return rpcError(id, -32600, "Invalid Request", 400);
  if (body.method !== "message/send") return rpcError(id, -32601, `Method not found: ${String(body.method)}`);
  const message = ((body.params as Record<string, unknown> | undefined)?.message ?? {}) as { parts?: { kind?: string; data?: unknown }[] };
  const data = (message.parts ?? []).find((p) => p?.kind === "data" && p.data && typeof p.data === "object")?.data as Record<string, unknown> | undefined;
  if (!data) return rpcError(id, -32602, "message must carry a data part with a 'skill' field");
  const skill = String(data.skill ?? "");

  if ((SKILL.negotiate as readonly string[]).includes(skill)) {
    if (limited(request)) return rpcError(id, -32000, "Rate limited, retry later");
    if (typeof data.task_description !== "string" || !data.terms || typeof data.terms !== "object") {
      return rpcError(id, -32602, `${skill} requires 'task_description' (string) and 'terms' (object)`);
    }
    const q = await quote(agent, data, testnet);
    if ("unavailable" in q) return rpcError(id, -32603, String(q.unavailable));
    return rpcResult(id, q);
  }

  const jobId = typeof data.job_id === "number" || (typeof data.job_id === "string" && /^\d{1,12}$/.test(data.job_id)) ? BigInt(data.job_id) : null;
  if ((SKILL.status as readonly string[]).includes(skill)) {
    if (jobId === null) return rpcError(id, -32602, `${skill} requires an integer 'job_id'`);
    const job = await (testnet ? readTestnetJob(jobId) : readJob(jobId)).catch(() => null);
    if (!job) return rpcError(id, -32603, `Job ${jobId} lookup failed`);
    return rpcResult(id, {
      job_id: Number(jobId),
      client: job.client,
      provider: job.provider,
      status: job.status,
      budget: job.budget.toString(),
      expired_at: job.expiredAt.toString(),
      submitted_at: job.submittedAt.toString(),
      deliverable: job.deliverable,
    });
  }

  if ((SKILL.notify as readonly string[]).includes(skill)) {
    if (jobId === null) return rpcError(id, -32602, `${skill} requires an integer 'job_id'`);
    if (limited(request)) return rpcError(id, -32000, "Rate limited, retry later");
    const job = await (testnet ? readTestnetJob(jobId) : readJob(jobId)).catch(() => null);
    if (!job) return rpcError(id, -32603, `Job ${jobId} lookup failed`);
    const owner = (testnet ? testnetProviderFor(agent.slug)?.owner : providerFor(agent.slug)?.owner) ?? "";
    if (job.provider.toLowerCase() !== owner.toLowerCase()) return rpcError(id, -32602, `Job ${jobId} names a different provider`);
    if (!JOB_STATUS.includes(job.status) || job.status === "OPEN") return rpcError(id, -32602, `Job ${jobId} is not funded yet`);
    // Taken on and delivered after answering; the same checks as the chain watcher's.
    after(async () => {
      const r = await (testnet ? recordTestnetFound(jobId, null) : recordFound(jobId, null)).catch(() => "failed");
      if (r === "recorded" || r === "already recorded") await (testnet ? deliverTestnet(jobId.toString()) : deliver(jobId.toString())).catch(() => undefined);
    });
    const url = testnet ? testnetDeliverableUrl(jobId.toString()) : `${SITE}/api/escrow/jobs/${jobId}/deliverable`;
    return rpcResult(id, { received: true, job_id: Number(jobId), deliverable_url: url, estimated_completion_seconds: 60 });
  }

  return rpcError(id, -32602, `Unknown skill: ${JSON.stringify(skill)}`);
}

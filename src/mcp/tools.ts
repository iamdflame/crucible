/**
 * MANDATE, the BNB Chain agent marketplace, as tools an MCP client can call.
 *
 * A person reaches the marketplace through a browser; an AI assistant or
 * another agent cannot. This is the same marketplace over JSON-RPC, so Claude,
 * ChatGPT, Cursor or any MCP client can find an agent for a job, see whether it
 * can be hired right now and why not, try it free, get its live signed price,
 * check an agent against Set and Earn's six checks and read a wallet's quest
 * progress. The marketplace tools read the site's public API, so the hosted
 * server and a local install give the same answers.
 *
 * --- what this server can and cannot do ---------------------------------
 *
 * The reads need nothing: no key, no account, no signature.
 *
 * Paying is the buyer's. MANDATE never pays or signs on an assistant's behalf:
 * `hire_agent` returns the live price and the link where the buyer's own
 * wallet opens and funds the job, and nothing moves until they sign. Only the
 * local stdio server, run by a person with MCP_SIGNER_KEY in their own
 * environment, signs anything: `hire_over_x402` pays for one call,
 * `open_mandate` opens a mandate and `revoke_session` ends a key. Over the
 * hosted endpoint those return the exact transaction or terms and
 * `executed: false`. A tool that reported success for a transaction it never
 * sent would be the unverifiable claim this marketplace exists to strike out,
 * so every result says which of the two happened.
 */

import { assayAgent } from "@/lib/assay";
import { readAgentIndex } from "@/lib/data/agents";
import { collapse } from "@/lib/dedup";
import { CATEGORIES, CHAIN_ID, type Category } from "@/lib/config";
import { MARKET_ADDRESS, marketClient, readMandate, walletFor } from "@/lib/chain/market";
import { encodeFunctionData, formatUnits, parseEther, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MARKET_V2 } from "@/lib/chain/deployments";
import { MANDATE_MARKET_V2_ABI } from "@/lib/chain/abiV2";
import { openMandate as sendOpenMandate, openMandateArgs } from "@/lib/chain/marketV2";
import { readKey } from "@/lib/chain/keystore";
import { payAndCall } from "@/lib/x402/pay-server";
import { toJson } from "@/lib/chain/session-store";
import { SITE } from "@/lib/site";

const HOST = SITE;

/** A tool as the MCP `tools/list` response wants it. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
}

type Args = Record<string, unknown>;

/**
 * Who is calling, and whether this process may sign for them.
 *
 * The hosted endpoint passes nothing and gets `{ canSign: false }`: it runs on
 * a deployment whose PRIVATE_KEY belongs to the operator, never to a caller,
 * so no write tool there ever signs. The local stdio server passes
 * `{ canSign: true }` and signs with MCP_SIGNER_KEY, a key the person running
 * it put in their own environment. Nothing here reads PRIVATE_KEY.
 */
export interface ToolContext {
  canSign: boolean;
}
const HOSTED: ToolContext = { canSign: false };
type Handler = (args: Args, ctx: ToolContext) => Promise<unknown>;

function signerFor(ctx: ToolContext): { key: Hex; address: Address } | null {
  if (!ctx.canSign) return null;
  const raw = process.env.MCP_SIGNER_KEY;
  if (!raw) return null;
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  return { key, address: privateKeyToAccount(key).address };
}

/** Results cross a JSON boundary; bigints must not reach it raw. */
const plain = <T>(v: T): unknown => JSON.parse(toJson(v));

const str = (a: Args, k: string): string | undefined =>
  typeof a[k] === "string" ? (a[k] as string) : undefined;
const int = (a: Args, k: string): number | undefined => {
  const v = a[k];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
};

/* ------------------------------------------------------------- the market */

/** One call to MANDATE's public API, which states the marketplace exactly as its pages do. */
async function site<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  const r = await fetch(`${HOST}${path}`, {
    method: init.method ?? "GET",
    headers: { accept: "application/json", "user-agent": "mandate-mcp", ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(55_000),
  });
  const j = (await r.json().catch(() => null)) as { ok?: boolean; data?: T; error?: string } | null;
  if (!j?.ok) throw new Error(j?.error ?? `MANDATE answered ${r.status}.`);
  return j.data as T;
}

const VIEWS = ["ready", "free", "checked", "all"] as const;

function tokenIdOf(a: Args): string {
  const id = str(a, "tokenId") ?? (typeof a.tokenId === "number" ? String(a.tokenId) : "");
  if (!/^\d{1,12}$/.test(id)) throw new Error("tokenId must be the agent's ERC-8004 id, a decimal integer.");
  return id;
}

function jobOf(a: Args): Category | undefined {
  const job = str(a, "job");
  if (job === undefined) return undefined;
  if (!(CATEGORIES as readonly string[]).includes(job)) throw new Error(`job must be one of: ${CATEGORIES.join(", ")}`);
  return job as Category;
}

/** Inputs an agent asks for (a wallet, a position, a task), as plain strings. */
function inputsOf(a: Args): Record<string, string> {
  const raw = a.inputs && typeof a.inputs === "object" ? (a.inputs as Record<string, unknown>) : {};
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => /^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(e[0]) && typeof e[1] === "string"));
}

interface Card {
  tokenId: string;
  name: string;
  hireable: boolean;
  price: string | null;
  page: string;
  hire: string;
  whyNot: { short: string | null; reason: string } | null;
  rails: ({ kind: "x402"; price: string; endpoint: string } | { kind: "escrow"; price: string } | { kind: "mandate" })[];
}

const searchAgents: Handler = async (a) => {
  const sp = new URLSearchParams();
  const query = str(a, "query")?.trim();
  if (query) sp.set("q", query.slice(0, 100));
  const job = jobOf(a);
  if (job) sp.set("job", job);
  const view = str(a, "view");
  if (view !== undefined) {
    if (!(VIEWS as readonly string[]).includes(view)) throw new Error(`view must be one of: ${VIEWS.join(", ")}`);
    sp.set("view", view);
  }
  sp.set("limit", String(Math.min(50, Math.max(1, int(a, "limit") ?? 10))));
  return site(`/api/v1/market?${sp}`);
};

const getAgent: Handler = async (a) => {
  const agent = await site<Card>(`/api/v1/market/${tokenIdOf(a)}`);
  return {
    ...agent,
    next: agent.hireable
      ? `Use get_price for its live signed price, or open ${agent.hire}: the buyer's own wallet opens and funds the job, and nothing moves until they sign.`
      : (agent.whyNot?.reason ?? "It cannot be hired here right now."),
  };
};

const listJobs: Handler = async () => {
  const { jobs } = await site<{ jobs: unknown[] }>("/api/v1/market/jobs");
  return {
    chainId: CHAIN_ID,
    jobs,
    quest: `Set and Earn asks for three different agents across two marketplaces. ${HOST}/quest hires two of MANDATE's own agents in one confirmation.`,
  };
};

const tryAgent: Handler = async (a) =>
  site(`/api/try`, { method: "POST", body: { tokenId: tokenIdOf(a), inputs: inputsOf(a) } });

interface Quote {
  kind: string;
  provider: string;
  price: string;
  expiresAt: number | null;
  etaSeconds: number | null;
  task: string;
}

const getPrice: Handler = async (a) => {
  const tokenId = tokenIdOf(a);
  const q = await site<Quote>(`/api/escrow/quote`, { method: "POST", body: { tokenId, inputs: inputsOf(a) } });
  return {
    tokenId,
    price: `${formatUnits(BigInt(q.price), 18)} $U`,
    priceWei: q.price,
    provider: q.provider,
    signedByTheAgent: q.kind === "sdk",
    expiresAt: q.expiresAt ? new Date(q.expiresAt * 1000).toISOString() : null,
    etaSeconds: q.etaSeconds,
    task: q.task,
    escrow: "Paid into BNB Chain's ERC-8183 escrow, not to MANDATE. The agent is paid when it delivers; if it does not, the buyer reclaims it.",
    hire: `${HOST}/agents/${tokenId}#call`,
  };
};

const hireAgent: Handler = async (a) => {
  const tokenId = tokenIdOf(a);
  const agent = await site<Card>(`/api/v1/market/${tokenId}`);
  if (!agent.hireable) return { executed: false, tokenId, name: agent.name, reason: agent.whyNot?.reason ?? "It cannot be hired here right now.", page: agent.page };
  const price = agent.rails.some((r) => r.kind === "escrow") ? await getPrice(a, HOSTED).catch((e: Error) => ({ error: e.message })) : null;
  return {
    executed: false,
    tokenId,
    name: agent.name,
    reason: "MANDATE never pays or signs on an assistant's behalf. Open the link: the buyer's own wallet opens the job and pays exactly the price into escrow, in one confirmation where the wallet can batch.",
    hire: agent.hire,
    livePrice: price,
    ways: agent.rails.map((r) => r.kind),
  };
};

interface Qualification {
  tokenId: string;
  name: string | null;
  category: string | null;
  checks: { id: string; label: string; state: string; detail: string }[];
  reading?: boolean;
  at: string;
}

const checkAgent: Handler = async (a) => {
  const tokenId = tokenIdOf(a);
  const q = await site<Qualification>(`/api/v1/qualify/${tokenId}`);
  const passed = q.checks.filter((c) => c.state === "pass").length;
  return {
    tokenId,
    name: q.name,
    job: q.category,
    passed: `${passed} of ${q.checks.length}`,
    checks: q.checks.map((c) => ({ check: c.label, state: c.state, detail: c.detail })),
    note: q.reading
      ? "Its onchain actions are still being read; ask again in a minute for the last two checks."
      : "BNB Chain makes the final determination after the campaign closes, from onchain data and the agent's public endpoints.",
    at: q.at,
    page: `${HOST}/check?q=${tokenId}`,
  };
};

interface Quest {
  team: boolean;
  campaign: { hires: number; marketplaces: number; register: string; ends: string };
  agentsHired: { agentId: string; agentName: string | null; tx: string | null }[];
  elsewhere: { network: string; jobId: string; agentName: string | null; provider: string; explorer: string }[];
  across?: { agents: number; here: number; elsewhere: number; twoMarketplaces: boolean | null };
  agentsListed: number;
}

const questProgress: Handler = async (a) => {
  const wallet = str(a, "wallet") ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error("wallet must be a 0x address.");
  const q = await site<Quest>(`/api/v1/quest/${wallet}`);
  const across = q.across ?? { agents: q.agentsHired.length, here: q.agentsHired.length, elsewhere: 0, twoMarketplaces: null };
  const need = q.campaign.hires;
  return {
    wallet,
    team: q.team,
    hires: `${Math.min(across.agents, need)} of ${need} different agents`,
    here: q.agentsHired.map((h) => ({ agent: h.agentName ?? `#${h.agentId}`, tx: h.tx })),
    elsewhere: q.elsewhere.map((h) => ({ agent: h.agentName ?? `the agent at ${h.provider}`, network: h.network, job: h.jobId, explorer: h.explorer })),
    twoMarketplaces: across.twoMarketplaces,
    ownAgentListed: q.agentsListed > 0,
    next:
      across.agents < need
        ? `Hire ${need - across.agents} more different agent${need - across.agents === 1 ? "" : "s"}${across.twoMarketplaces ? "" : ", on at least two marketplaces"}: ${HOST}/quest`
        : q.agentsListed > 0
          ? "The hires are done as far as the chain shows. BNB Chain checks the agent you built after the campaign."
          : `Build and list one agent of your own: ${HOST}/build`,
    seen: "Hires on MANDATE, and jobs funded through BNB Chain's ERC-8183 escrow on any marketplace, mainnet or testnet. Hires paid per call or through another marketplace's own contract are counted by BNB Chain, not shown here.",
    register: q.campaign.register,
  };
};

/* ---------------------------------------------------------- trust reads */

const assay: Handler = async (a) => {
  const chainId = int(a, "chainId") ?? CHAIN_ID;
  const tokenId = str(a, "tokenId") ?? "";
  if (!/^\d{1,20}$/.test(tokenId)) {
    throw new Error("tokenId must be a decimal integer, as minted in the ERC-8004 registry.");
  }

  const r = await assayAgent(chainId, tokenId, undefined, { registryDeadlineMs: 12_000 });
  return {
    chainId: r.chainId,
    tokenId: r.tokenId,
    name: r.name,
    ownerAddress: r.ownerAddress,
    agentWallet: r.agentWallet,
    fineness: r.fineness,
    hallmark: r.hallmark,
    hallmarked: r.fineness >= 375,
    category: r.category,
    categoryConfidence: r.categoryConfidence,
    checks: r.results.map((c) => ({
      id: c.id,
      title: c.title,
      verdict: c.verdict,
      // The claim and the finding are separate fields on purpose: one is what
      // the registration asserts, the other is what the chain showed.
      claim: c.claim,
      finding: c.finding,
      weight: c.weight,
    })),
    // Every figure this office publishes names the line that re-derives it,
    // and a tool result is not exempt.
    verify: `curl ${HOST}/api/v1/assay/${chainId}/${tokenId}`,
    web: `${HOST}/agents/${tokenId}`,
  };
};

const checkDuplication: Handler = async (a) => {
  const top = Math.min(50, Math.max(1, int(a, "top") ?? 10));
  const index = await readAgentIndex();
  const d = collapse(index.agents);
  return {
    chainId: CHAIN_ID,
    rowsMeasured: d.counted,
    rowsSkippedWithoutNameOrDescription: d.unnamed,
    distinctProducts: d.distinct,
    duplicateRows: d.duplicateRows,
    duplicateShare: Number((d.duplicateShare * 100).toFixed(1)),
    collapseRatio: Number(d.collapse.toFixed(3)),
    method:
      "Collapsed on name and description, normalised for case and whitespace, and blind to the owner. One product minted once per user wallet has a different owner on every copy, so keying on the owner would report an almost clean register: 1.02x against 1.23x. Nothing is stemmed and no near-matches are clustered, so every figure here is a floor.",
    scope: `Measured over the ${d.counted.toLocaleString()} rows this office has read, not the ${index.registry.registered.toLocaleString()} registered. The ratio is not extrapolated, because a ratio measured on a crawl ordered by token id need not hold across the whole registry.`,
    mostRegistered: d.clusters.slice(0, top).map((c) => ({
      name: c.name,
      registrations: c.count,
      distinctOwners: c.owners,
      // One owner registering the same card repeatedly and one product minted
      // per user are different findings; the shape is here so they can be told
      // apart rather than added together.
      shape: c.owners === 1 ? "one owner, repeated registrations" : "minted per holder",
      tokenIds: c.tokenIds.slice(0, 12),
    })),
    verify: "npm run dedup",
  };
};

/* ----------------------------------------------------------------- writes */

/*
  These do not execute. Each returns what performing the action requires, and
  says so in the payload rather than only in the tool description, so a client
  that ignores descriptions still cannot mistake the result for a receipt.
*/

const DRY =
  "Nothing was sent. The hosted endpoint never signs; run the stdio server with MCP_SIGNER_KEY set in your own environment and this tool sends it from that key.";

const openMandate: Handler = async (a, ctx) => {
  const categoryArg = str(a, "category");
  if (!categoryArg || !(CATEGORIES as readonly string[]).includes(categoryArg)) {
    throw new Error(`category must be one of: ${CATEGORIES.join(", ")}`);
  }
  const category = categoryArg as Category;
  const capital = str(a, "capitalBnb") ?? "0.0002";
  if (!/^\d+(\.\d{1,18})?$/.test(capital)) throw new Error("capitalBnb must be a decimal amount of BNB.");
  const value = parseEther(capital);
  if (value < parseEther("0.0002")) throw new Error("capitalBnb must be at least 0.0002, the market's minimum.");

  const callArgs = openMandateArgs({
    category: CATEGORIES.indexOf(category) as 0 | 1 | 2 | 3,
    benchmark: 0,
    toleranceBps: 500,
    feeBps: 1000,
    slashBps: 2500,
    epochLength: 3600,
    epochsTotal: 24,
    strikes: 3,
    catastrophicBps: -1000,
    bondFloorBps: 2000,
  });
  const data = encodeFunctionData({ abi: MANDATE_MARKET_V2_ABI, functionName: "openMandate", args: callArgs } as never);
  const terms = {
    category,
    capitalBnb: capital,
    benchmark: "Hold, the only benchmark the settlement engine derives today",
    epoch: "3600 s, 24 epochs, 3 strikes, 25% slash, 10% fee on outperformance",
  };
  const s = signerFor(ctx);
  if (!s) {
    return {
      executed: false,
      reason: DRY,
      transaction: { chainId: CHAIN_ID, to: MARKET_V2, value: value.toString(), data },
      terms,
      web: `${HOST}/agents?category=${category}`,
    };
  }
  const hash = await sendOpenMandate(walletFor(s.key), callArgs, value);
  return {
    executed: true,
    from: s.address,
    transaction: hash,
    explorer: `https://bscscan.com/tx/${hash}`,
    terms,
    thenWhat: "Agents bid by posting a bond. Award one, and each epoch settles against a benchmark committed before the outcome.",
    web: `${HOST}/activity`,
  };
};

/** "0.05 USD1" to base units: every stable a BSC agent prices in here has 18 decimals. */
function priceWei(label: string): bigint | null {
  const m = /^(\d+(?:\.\d{1,18})?)\s/.exec(label.trim());
  return m ? parseUnits(m[1]!, 18) : null;
}

const hireOverX402: Handler = async (a, ctx) => {
  const tokenId = tokenIdOf(a);
  const query = str(a, "query");
  if (query && !/^[\w=&.:%-]{1,300}$/.test(query)) throw new Error("query must be a plain query string, like wallet=0x... or position=123.");
  const agent = await site<Card>(`/api/v1/market/${tokenId}`);
  const rail = agent.rails.find((r): r is { kind: "x402"; price: string; endpoint: string } => r.kind === "x402");
  if (!rail) {
    return { executed: false, tokenId, reason: agent.hireable ? "It is not sold per call. Use hire_agent for an escrowed job." : (agent.whyNot?.reason ?? "It cannot be hired here right now."), page: agent.page };
  }
  const url = query ? `${rail.endpoint}${rail.endpoint.includes("?") ? "&" : "?"}${query}` : rail.endpoint;
  const s = signerFor(ctx);
  if (!s) return { executed: false, reason: DRY, tokenId, price: rail.price, url, page: agent.page };
  const max = priceWei(rail.price);
  if (!max) return { executed: false, reason: `Its price "${rail.price}" could not be read, so nothing was signed.`, url };
  // Never more than the price the marketplace states; the payer's balance is checked before anything is signed.
  const call = await payAndCall({ url, key: s.key, maxAmount: max, settleWaitMs: 30_000 });
  return plain({
    executed: call.paid,
    paidBy: call.payer,
    price: rail.price,
    delivered: call.delivered,
    refused: call.refused,
    settlement: call.settlement?.tx ?? null,
    explorer: call.settlement?.tx ? `https://bscscan.com/tx/${call.settlement.tx}` : null,
    work: call.deliverable,
  });
};

const revokeSession: Handler = async (a, ctx) => {
  const keyId = str(a, "keyId");
  const mandateId = int(a, "mandateId");
  if (keyId === undefined && (mandateId === undefined || mandateId < 0)) {
    throw new Error("mandateId is required and must be a non-negative integer, or pass keyId, a KeyStore key id on your own account.");
  }
  const s = signerFor(ctx);
  if (!s || !keyId) {
    return {
      executed: false,
      reason: s ? "Pass keyId to revoke a key on your own account." : DRY,
      what: "Revocation ends a session key's authority on chain: the account refuses its next call, and the KeyStore reports it not valid.",
      httpAlternative: { method: "POST", url: `${HOST}/api/desk/revoke`, form: { id: "the session id shown on /desk", token: "the operator token" } },
      web: `${HOST}/desk`,
    };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(keyId)) throw new Error("keyId must be a 32-byte hex string.");
  const entry = await readKey(s.address, keyId as Hex);
  if (!entry.publicKey) throw new Error("The KeyStore has no key with that id on your account.");
  if (!entry.valid) return { executed: false, reason: "That key is already not valid.", keystore: plain(entry) };
  const { AltanaWalletProvider } = await import("@bnbagent/sdk/wallets");
  const r = await new AltanaWalletProvider({ privateKey: s.key }).revokeSession(entry.publicKey);
  const after = await readKey(s.address, keyId as Hex);
  return { executed: true, account: s.address, transaction: r.transactionHash ?? null, keystoreValidAfter: after.valid };
};

const readReceipt: Handler = async (a) => {
  const jobId = str(a, "jobId");
  const mandateId = int(a, "mandateId");
  const tx = str(a, "tx");
  if (jobId !== undefined) {
    if (!/^\d{1,20}$/.test(jobId)) throw new Error("jobId must be a decimal integer.");
    const sdk = (await import("@altananetwork/sdk")) as unknown as { BNB: unknown; getErc8183Job: (n: unknown, id: bigint) => Promise<unknown> };
    return plain({ kind: "erc8183-job", jobId, job: await sdk.getErc8183Job(sdk.BNB, BigInt(jobId)) });
  }
  if (mandateId !== undefined) {
    if (mandateId < 0) throw new Error("mandateId must be non-negative.");
    return plain({ kind: "mandate", market: MARKET_ADDRESS, mandate: await readMandate(mandateId), web: `${HOST}/receipts/${mandateId}` });
  }
  if (tx !== undefined) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) throw new Error("tx must be a 32-byte transaction hash.");
    const r = await marketClient.getTransactionReceipt({ hash: tx as Hex });
    return plain({ kind: "transaction", status: r.status, block: r.blockNumber, from: r.from, to: r.to, gasUsed: r.gasUsed, logs: r.logs.length, explorer: `https://bscscan.com/tx/${tx}` });
  }
  throw new Error("Give jobId, mandateId or tx.");
};

/* ------------------------------------------------------------------ table */

const TOKEN_ID = { type: "string", description: "The agent's ERC-8004 id on BNB Smart Chain, a decimal integer." };
const INPUTS = {
  type: "object",
  description: 'What the agent asks for, as strings: {"wallet": "0x…"}, {"position": "123"}, or {"task": "…"} for an agent that reads a task. Optional; the demo account is used when no wallet is named.',
  additionalProperties: { type: "string" },
};
const JOB = { type: "string", enum: [...CATEGORIES], description: "One of the four jobs." };

export const TOOLS: Array<ToolSpec & { handler: Handler }> = [
  {
    name: "search_agents",
    description:
      "Find agents on MANDATE, the BNB Chain agent marketplace, for one of four jobs: rebalancing, grid trading, yield optimisation or health factor (Venus loans). Returns the marketplace's own order with, for each agent, whether it can be hired right now, how, at what price, and in words why not when it cannot. By default only agents ready to hire; view 'all' includes the rest. No key needed.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free text, like 'venus liquidation' or an agent's name." },
        job: JOB,
        view: { type: "string", enum: [...VIEWS], description: "ready (default): can be hired now. free: can be tried free. checked: passed MANDATE's answer checks. all: every listed agent." },
        limit: { type: "number", description: "How many, 1-50. Default 10." },
      },
      additionalProperties: false,
    },
    handler: searchAgents,
  },
  {
    name: "get_agent",
    description:
      "One agent as the marketplace states it: what it does, whether it can be hired now and every way it can be, the price, how fast it delivers, whether its answers passed MANDATE's checks, and why not when it cannot be hired.",
    inputSchema: { type: "object", properties: { tokenId: TOKEN_ID }, required: ["tokenId"], additionalProperties: false },
    handler: getAgent,
  },
  {
    name: "list_jobs",
    description: "The four jobs agents do on BNB Chain, with how many agents can be hired for each right now and the lowest price.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: listJobs,
  },
  {
    name: "try_agent",
    description:
      "Try an agent free before paying, where it offers that: MANDATE's own agents, and agents built on BNB's agent SDK that answer a free message. Returns the agent's actual answer to the task a paid job would carry. Nothing is paid or signed, and it never counts as a hire.",
    inputSchema: { type: "object", properties: { tokenId: TOKEN_ID, inputs: INPUTS }, required: ["tokenId"], additionalProperties: false },
    handler: tryAgent,
  },
  {
    name: "get_price",
    description:
      "The live price for an escrowed job with an agent, signed by the agent itself where it is built on BNB's SDK and checked against the wallets its registration names. Paid into BNB Chain's ERC-8183 escrow, never to MANDATE; the agent is paid on delivery, or the buyer reclaims it. Nothing is signed.",
    inputSchema: { type: "object", properties: { tokenId: TOKEN_ID, inputs: INPUTS }, required: ["tokenId"], additionalProperties: false },
    handler: getPrice,
  },
  {
    name: "hire_agent",
    description:
      "Hire an agent: returns its live price and the link where the buyer's own wallet opens and funds the job, in one confirmation where the wallet can batch. MANDATE never pays or signs on an assistant's behalf, so this does NOT execute anything; nothing moves until the buyer signs.",
    inputSchema: { type: "object", properties: { tokenId: TOKEN_ID, inputs: INPUTS }, required: ["tokenId"], additionalProperties: false },
    handler: hireAgent,
  },
  {
    name: "check_agent",
    description:
      "Check an agent against BNB Chain's six Set and Earn checks (registered and owned, discoverable, live, hired by others, actually executes, does what it says), read from the chain and its endpoint. For builders asking whether their agent qualifies.",
    inputSchema: { type: "object", properties: { tokenId: TOKEN_ID }, required: ["tokenId"], additionalProperties: false },
    handler: checkAgent,
  },
  {
    name: "quest_progress",
    description:
      "A wallet's Set and Earn progress: different agents hired on MANDATE and on other marketplaces through BNB Chain's escrow (mainnet and testnet), whether they span two marketplaces, whether its own agent is listed, and the next step.",
    inputSchema: { type: "object", properties: { wallet: { type: "string", description: "The campaign wallet, a 0x address." } }, required: ["wallet"], additionalProperties: false },
    handler: questProgress,
  },
  {
    name: "assay_agent",
    description:
      "The full on-chain assay of any ERC-8004 agent on BNB Smart Chain: identity, custody, activity, capability, reputation and performance, each with the claim and what the chain showed. Works for any token id. No key.",
    inputSchema: {
      type: "object",
      properties: {
        tokenId: TOKEN_ID,
        chainId: { type: "number", description: `Chain id. Defaults to ${CHAIN_ID}.` },
      },
      required: ["tokenId"],
      additionalProperties: false,
    },
    handler: assay,
  },
  {
    name: "check_duplication",
    description:
      "How many registrations are the same product wearing different token ids. Collapses on name and description, blind to the owner, because a product minted once per user wallet has a different owner on every copy.",
    inputSchema: {
      type: "object",
      properties: {
        top: { type: "number", description: "How many clusters to return, 1-50. Default 10." },
      },
      additionalProperties: false,
    },
    handler: checkDuplication,
  },
  {
    name: "read_receipt",
    description:
      "Reads a receipt from the chain: an ERC-8183 job by jobId, a mandate by mandateId, or any transaction by hash. Read only, no key.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "An ERC-8183 job id." },
        mandateId: { type: "number", description: "A mandate id on the current market." },
        tx: { type: "string", description: "A transaction hash." },
      },
      additionalProperties: false,
    },
    handler: readReceipt,
  },
  {
    name: "hire_over_x402",
    description:
      "Buys one answer from an agent sold per call (x402), never above the price the marketplace states. Over the hosted endpoint it does NOT pay and returns the terms. Over the local stdio server with MCP_SIGNER_KEY set in your own environment, it pays from that key (checking the balance first) and returns the work and the settlement transaction.",
    inputSchema: {
      type: "object",
      properties: {
        tokenId: TOKEN_ID,
        query: { type: "string", description: "Inputs as a query string, like wallet=0x... or position=7408923." },
      },
      required: ["tokenId"],
      additionalProperties: false,
    },
    handler: hireOverX402,
  },
  {
    name: "open_mandate",
    description:
      "Opens a bonded mandate on MandateMarketV2. Over the hosted endpoint it PREPARES the exact transaction and does NOT send it. Over the local stdio server with MCP_SIGNER_KEY set, it sends it from that key and returns the hash. Escrows the signer's own capital.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", enum: [...CATEGORIES], description: "Which job." },
        capitalBnb: { type: "string", description: "Capital to escrow, in BNB. Default and minimum 0.0002." },
      },
      required: ["category"],
      additionalProperties: false,
    },
    handler: openMandate,
  },
  {
    name: "revoke_session",
    description:
      "Ends a session key's authority. Over the hosted endpoint it does NOT revoke and returns the authorised route. Over stdio with MCP_SIGNER_KEY set and a keyId, it revokes that key on the signer's own Altana account and returns the transaction and the KeyStore's answer afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        mandateId: { type: "number", description: "The mandate whose session to revoke (hosted: returns the route)." },
        keyId: { type: "string", description: "A KeyStore key id on the signer's own account (stdio only)." },
      },
      additionalProperties: false,
    },
    handler: revokeSession,
  },
];

export const TOOL_SPECS: ToolSpec[] = TOOLS.map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
}));

/**
 * Dispatch one call. Throws for an unknown tool or bad arguments.
 *
 * `ctx` defaults to the hosted context, which never signs. Only the stdio
 * server passes `{ canSign: true }`.
 */
export async function callTool(name: string, args: Args = {}, ctx: ToolContext = HOSTED): Promise<unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.handler(args ?? {}, ctx);
}

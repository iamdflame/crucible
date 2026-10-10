/**
 * ERC-8183 on BNB Smart Chain: the escrow a buyer funds and our agents deliver
 * against.
 *
 * AgenticCommerce holds the budget in $U. EvaluatorRouter is every job's
 * evaluator and hook, and OptimisticPolicy approves by silence: once the
 * provider submits, the budget is released after the dispute window unless
 * the buyer disputes. A job not submitted by its expiry refunds the buyer.
 *
 * The addresses are the Altana SDK's (ERC8183_ADDRESSES[56]); a test holds
 * these equal to it, so this file, which the browser also loads, does not
 * have to import the whole SDK.
 */

import { parseAbi, parseAbiItem, type Address } from "viem";

export const ESCROW = {
  commerce: "0xEa4DAa3100A767e86FDed867729ae7446476EBA6",
  router: "0x51895229E12F9876011789B04f8698af06cCD6DA",
  policy: "0x9C01845705b3078Aa2e8cfF7520a6376FD766dE5",
  paymentToken: "0xcE24439F2D9C6a2289F741120FE202248B666666",
} as const satisfies Record<string, Address>;

/**
 * The same kernel on BNB Smart Chain testnet (chain 97), where Set and Earn
 * also counts hires and four shortlisted marketplaces hire for free, paid in
 * test $U. Written from BNB's agent SDK (NETWORKS["bsc-testnet"] and
 * getAddress(97)); a test holds them equal to it.
 */
export const ESCROW_TESTNET = {
  commerce: "0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE",
  router: "0xD7d36D66d2F1B608A0F943f722D27e3744f66F25",
  policy: "0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA",
  paymentToken: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565",
  /** The ERC-8004 identity registry on testnet, where our agents hold their testnet identities. */
  identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
} as const satisfies Record<string, Address>;

/** The kernel's job states, in its own order. */
export const JOB_STATUS = ["OPEN", "FUNDED", "SUBMITTED", "COMPLETED", "REJECTED", "EXPIRED"] as const;
export type JobStatus = (typeof JOB_STATUS)[number];

export const COMMERCE_ABI = parseAbi([
  "struct Job { uint256 id; address client; address provider; address evaluator; string description; uint256 budget; uint256 expiredAt; uint8 status; address hook; uint256 submittedAt; bytes32 deliverable; }",
  "function createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook) returns (uint256)",
  "function setBudget(uint256 jobId, uint256 amount, bytes optParams)",
  "function fund(uint256 jobId, uint256 expectedBudget, bytes optParams)",
  "function submit(uint256 jobId, bytes32 deliverable, bytes optParams)",
  "function claimRefund(uint256 jobId)",
  "function getJob(uint256 jobId) view returns (Job)",
  "function jobCounter() view returns (uint256)",
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook)",
  "event JobFunded(uint256 indexed jobId, address indexed client, address indexed provider, uint256 amount)",
  "event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)",
]);

export const ROUTER_ABI = parseAbi(["function registerJob(uint256 jobId, address policy)", "function settle(uint256 jobId, bytes evidence)"]);

export const POLICY_ABI = parseAbi(["function disputeWindow() view returns (uint64)", "function dispute(uint256 jobId)"]);

export const TOKEN_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);

export const JOB_FUNDED = parseAbiItem("event JobFunded(uint256 indexed jobId, address indexed client, address indexed provider, uint256 amount)");

export const JOB_CREATED = parseAbiItem(
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook)",
);

/**
 * What a buyer pays for a job from one of our agents, in $U: one cent while
 * BNB Chain's Set and Earn runs (to 5 Nov 2026), set on 3 Oct when every
 * outside hire in the campaign was paying 0.03 $U or less. It was five cents,
 * the price of its paid call, which stays 0.05 USD1. The A2A seller's signed
 * quote, the hire law, the drawer and the recording check all read this one
 * figure, so they move together.
 */
export const HOUSE_BUDGET = 10_000_000_000_000_000n;

/** How long our agent has to deliver before the buyer can take the budget back. */
export const DELIVERY_SECONDS = 1_800;

/** The words every job opened here starts with, so any indexer can tell our jobs apart on chain. */
export const VIA = "via mandatemarkets.com";
/** The host every job opened here names, in the words above or in an outside seller's JSON description. */
export const VIA_HOST = "mandatemarkets.com";

/**
 * The on-chain description of a job for an outside seller: the JSON such
 * sellers read their task from, with our line in the task so any indexer can
 * still tell a job opened here.
 */
export function outsideDescription(name: string, service: string | null, inputs: Record<string, string>): string {
  return JSON.stringify({
    task: [name, ...Object.entries(inputs).map(([k, v]) => `${k} ${v}`), VIA].join(", "),
    ...(service ? { service } : {}),
    via: VIA_HOST,
  });
}

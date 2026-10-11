/**
 * A prompt a builder pastes into their AI assistant (Claude, ChatGPT, Cursor,
 * Claude Code) to build a Set and Earn agent with it, step by step.
 *
 * Most builders arriving for Set and Earn have an assistant and no idea where
 * BNB Chain's six checks bite. This hands the assistant everything it would
 * otherwise get wrong: the six checks in BNB Chain's words, BNB's own agent
 * SDK and the pieces of it that sell an escrowed job, the work on chain that
 * counts for the chosen job (as MANDATE's check judges it), the contracts for
 * the chosen network (read from this codebase's verified constants, never
 * typed), where test tokens come from, and the rules that disqualify an agent.
 * It also tells the assistant what it must never do: ask for the campaign
 * wallet's key, or arrange hires from wallets the builder controls. Pure, so
 * every promise in it is tested.
 */

import { CATEGORY_LABEL, IDENTITY_REGISTRY, PROTOCOLS, type Category } from "@/lib/config";
import { ESCROW, ESCROW_TESTNET } from "@/lib/escrow/contracts";
import { QUALIFIES, CAMPAIGN_ENDS } from "@/lib/campaign/rules";
import { SITE } from "@/lib/site";

export type BuildNetwork = "mainnet" | "testnet";

export interface PromptInput {
  job: Category;
  network: BuildNetwork;
  /** The builder's registered campaign wallet, when they give it. */
  wallet?: string | null;
  /** What they want it to do, in their words. */
  idea?: string | null;
}

/** What each job is, and the work on chain that counts for it: the same rule as MANDATE's check (lib/campaign/qualify fitsJob). */
const WORK: Record<Category, { is: string; acts: string; contracts: [string, string][] }> = {
  "health-factor": {
    is: "watches a leveraged Venus lending position and acts, or warns, before it reaches liquidation",
    acts: "lending calls on Venus from its own wallet: it supplies collateral or repays debt when the health factor of the position it manages falls toward its threshold. Give it a small position of its own so it has a loan to keep healthy.",
    contracts: [
      ["Venus Comptroller", PROTOCOLS.venusComptroller],
      ["Venus vUSDT", PROTOCOLS.venusVUSDT],
      ["Venus vBNB", PROTOCOLS.venusVBNB],
    ],
  },
  "yield-optimisation": {
    is: "finds the strongest available return and moves capital toward it",
    acts: "lending or vault calls from its own wallet: it supplies to and redeems from Venus or Aave (or deposits into and withdraws from a vault) as the best rate moves, with a small amount of its own capital.",
    contracts: [
      ["Venus Comptroller", PROTOCOLS.venusComptroller],
      ["Venus vUSDT", PROTOCOLS.venusVUSDT],
      ["Venus vBNB", PROTOCOLS.venusVBNB],
      ["Aave V3 Pool", PROTOCOLS.aaveV3Pool],
    ],
  },
  "grid-trading": {
    is: "places a ladder of buy and sell orders across a price range and works the range as the market moves",
    acts: "swaps on PancakeSwap from its own wallet, repeatedly: each time the price crosses one of its grid levels it buys or sells a small fixed amount.",
    contracts: [
      ["PancakeSwap V3 SmartRouter", PROTOCOLS.pancakeSmartRouter],
      ["PancakeSwap V2 Router", PROTOCOLS.pancakeV2Router],
    ],
  },
  rebalancing: {
    is: "keeps a portfolio or a liquidity position at its intended shape, trading it back into line when the market pulls it out",
    acts: "position calls on PancakeSwap V3 from its own wallet (decrease and increase liquidity, collect, or mint a new range when the price leaves the old one), or swaps that restore its target weights.",
    contracts: [
      ["PancakeSwap V3 NonfungiblePositionManager", PROTOCOLS.pancakeV3PositionManager],
      ["PancakeSwap MasterChef V3", PROTOCOLS.pancakeMasterChefV3],
      ["PancakeSwap V3 SmartRouter", PROTOCOLS.pancakeSmartRouter],
    ],
  },
};

const FAUCET_ASK = (who: string) => `I would like to get tBNB and U on BNB Smart Chain Testnet to my wallet ${who}`;

export function buildPrompt(input: PromptInput): string {
  const job = WORK[input.job];
  const label = CATEGORY_LABEL[input.job];
  const testnet = input.network === "testnet";
  const kernel = testnet ? ESCROW_TESTNET : ESCROW;
  const registry = testnet ? ESCROW_TESTNET.identity : IDENTITY_REGISTRY;
  const chain = testnet ? "BNB Smart Chain testnet (chain 97)" : "BNB Smart Chain mainnet (chain 56)";
  const wallet = input.wallet && /^0x[0-9a-fA-F]{40}$/.test(input.wallet) ? input.wallet : null;
  const owner = wallet ? `my campaign wallet, ${wallet}` : "my campaign wallet (ask me for its address)";
  const idea = input.idea?.trim().replace(/\s+/g, " ").slice(0, 400);
  const ends = new Date(CAMPAIGN_ENDS).toUTCString().slice(5, 16);

  const lines: string[] = [
    `I am building an AI agent for BNB Chain's Set and Earn campaign (Build the Era, Phase 2, until ${ends} 12:00 UTC), and I want you to build it with me in this repository, one step at a time. It only counts if it passes all six of BNB Chain's checks, listed below, so treat them as the specification.`,
    "",
    "## The agent",
    `- Job: ${label}. An agent that ${job.is}.`,
    idea ? `- What I want it to do: ${idea}` : `- What it does: propose something specific and useful within this job, and tell me before you build it.`,
    `- Network: ${chain}.`,
    `- Owner: ${owner}. It registers the agent, so it must own it. Never ask me for its private key: I sign that transaction myself.`,
    "- The agent gets its own fresh wallet for gas, for selling, and for its onchain work. Generate it, keep its key in an environment variable, never in the repository, and give me its address to fund.",
    "",
    "## BNB Chain's six checks (its words)",
    ...QUALIFIES.map(([t, d], i) => `${i + 1}. ${t}: ${d}`),
    "",
    "Not counted: an agent that answers but never acts on chain, one listed before the Phase 2 announcement, the same agent under several ids, and copies of an existing agent with cosmetic changes. Make it genuinely its own. The repository must be public.",
    "",
    "## How to build it",
    "1. Use BNB's agent SDK, `npm install @bnbagent/sdk` (Node 20 or later). Read https://github.com/bnb-chain/bnbagent-sdk (README and ARCHITECTURE.md) before writing code, and use its APIs rather than reimplementing them. Set `NETWORK=" + (testnet ? "bsc-testnet" : "bsc-mainnet") + "`.",
    "2. Selling (check 4, hired by others). Sell escrowed jobs in BNB's ERC-8183 standard, which every shortlisted marketplace on this chain can buy:",
    "   - Serve an A2A endpoint over HTTPS whose agent card is at `/.well-known/agent-card.json`. Offer the skill `negotiate-erc8183-job`: answer a buyer's request with a price quote signed by the agent's wallet, built with the SDK's `NegotiationHandler` (price in base units of the payment token; a quote lasts at most 900 seconds). Also offer `notify_funded`, so a marketplace can tell it a job number.",
    "   - Watch for jobs funded to the agent with the SDK's `fundedJobWatcher` and `ERC8183JobOps`, do the work, and submit with `submitResult` within 30 minutes of the job being opened: the dispute policy refuses later submissions, and the buyer's money then goes back to them.",
    `   - Contracts on ${chain}, as BNB's SDK names them: AgenticCommerce ${kernel.commerce}, EvaluatorRouter ${kernel.router}, OptimisticPolicy ${kernel.policy}, payment token ($U${testnet ? ", test" : ""}) ${kernel.paymentToken}. Confirm them against the SDK's \`BNB_CHAIN_ADDRESSES\`.`,
    "   - Keep the price small; most hires in Set and Earn are a few cents.",
    `3. Acting (checks 5 and 6). The agent's own wallet must make at least five onchain transactions of its job, on at least three different days. For ${label} that means ${job.acts} Run it on a schedule (a daily cron is enough) with small amounts. Approvals, plain transfers, registry updates and job deliveries do not count as its job.`,
    testnet
      ? "   - On testnet, first confirm the protocol it uses is deployed there and take its testnet addresses from that protocol's official documentation, never from memory. If it is not on testnet, tell me before choosing another."
      : `   - Contracts on mainnet: ${job.contracts.map(([n, a]) => `${n} ${a}`).join("; ")}. Verify each on BscScan before use.`,
    `4. Registering (checks 1 and 2), once it is live. Register it on the ERC-8004 Identity Registry ${registry} from ${owner}. Build the registration with the SDK's \`AgentURIGenerator\` and \`ERC8004Agent\` (a data: URI, the form the SDK reads): its name; a description that says in plain words that it does ${label.toLowerCase()} and what it does; a service pointing at its A2A agent card; and its registry entry. Alternatively I can register it at ${SITE}/build by pasting the endpoint and signing one transaction. Register exactly once.`,
    "5. Hosting (check 3). Deploy to a public HTTPS domain that stays up (Vercel, Railway, Fly or a server), and answer every call within a few seconds: BNB Chain probes at random times.",
    "6. Write a README that names the live URL and how to run it, and keep the repository public.",
    "",
    "## Funding",
    testnet
      ? `- Test BNB for gas and test $U to try buying from it: message BNB Chain's Telegram bot @bnbchain_official_bot (https://t.me/bnbchain_official_bot) with "${FAUCET_ASK(wallet ?? "<the wallet>")}". Or the web faucets: https://united-coin-u.github.io/u-faucet/ for test $U and https://www.bnbchain.org/en/testnet-faucet for tBNB.`
      : "- A little BNB for gas (each transaction costs a fraction of a cent at current prices) and a small amount of the tokens its job uses. Tell me exactly how much to send the agent's wallet before I send anything.",
    "",
    "## Checking as we go",
    testnet
      ? `- MANDATE lists every registered agent under its job. Its six-check page reads mainnet; on testnet, check each of the six yourself and show me the transactions on https://testnet.bscscan.com.`
      : `- MANDATE (${SITE}), a shortlisted marketplace, lists every registered agent whose card states its job, and checks it against the six from the chain: ${SITE}/check?q=<token id>, or as JSON at ${SITE}/api/v1/qualify/<token id>. Use it after each step.`,
    "- Hires must come from three different wallets that are not mine and were not funded by mine. Never hire it from wallets I control, and never pay or reward anyone to hire it: those hires are excluded, and the agent with them. Real buyers find it on the marketplaces once it is listed.",
    "",
    "## How to work with me",
    "- Explain each step before you do it, and ask me before any transaction from my campaign wallet.",
    "- Keep every secret in environment variables, with `.env` in `.gitignore`.",
    "- After each step, tell me what to check and how.",
    "- Start by proposing the agent's name, what one job of it delivers, and its price, and wait for my answer.",
  ];
  return lines.join("\n");
}

/** Where the same prompt is served as text, for an assistant to read at a link. */
export function promptUrl(input: PromptInput): string {
  const q = new URLSearchParams({ job: input.job, network: input.network });
  if (input.wallet && /^0x[0-9a-fA-F]{40}$/.test(input.wallet)) q.set("wallet", input.wallet);
  if (input.idea?.trim()) q.set("idea", input.idea.trim().slice(0, 400));
  return `${SITE}/api/build/prompt?${q}`;
}

/**
 * Links that open a chat with the prompt. The whole prompt is longer than a
 * chat link reliably carries, so the link asks the assistant to read it at
 * its URL; an assistant that cannot fetch pages is given the copied text.
 */
export function openIn(input: PromptInput): { claude: string; chatgpt: string; ask: string } {
  const ask = `Read the instructions at ${promptUrl(input)} and follow them: build my BNB Chain Set and Earn agent with me, step by step. If you cannot open the link, tell me and I will paste them.`;
  const q = encodeURIComponent(ask);
  return { claude: `https://claude.ai/new?q=${q}`, chatgpt: `https://chatgpt.com/?q=${q}`, ask };
}

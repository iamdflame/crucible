/**
 * What this server calls itself, in both transports.
 *
 * Kept in one place so the stdio install and the hosted endpoint cannot drift
 * into describing themselves differently: they are the same marketplace.
 */

export const SERVER_INFO = {
  name: "mandate",
  version: "2.0.0",
  title: "MANDATE, the BNB Chain agent marketplace",
} as const;

/** The MCP protocol revision this server speaks. */
export const PROTOCOL_VERSION = "2025-06-18";

export const INSTRUCTIONS =
  "MANDATE is the BNB Chain agent marketplace where every agent is checked on chain before you hire it. Agents here do one of four jobs on BNB Smart Chain: rebalancing, grid trading, yield optimisation and health factor (keeping a Venus loan from liquidation). To help someone hire: search_agents finds agents ready to hire for a job, get_agent says how and at what price (or why not), try_agent shows a free answer first where the agent offers one, get_price gets the agent's live signed price, and hire_agent gives the link where the buyer's own wallet pays into BNB Chain's escrow. MANDATE never pays or signs on anyone's behalf, so no hosted tool moves money. For BNB Chain's Set and Earn campaign: quest_progress reads a wallet's hires on MANDATE and on other marketplaces, and check_agent runs the six checks on an agent someone built. assay_agent, check_duplication and read_receipt read trust evidence from the chain. Run the stdio server with MCP_SIGNER_KEY set in your own environment and hire_over_x402, open_mandate and revoke_session act from that key.";

/**
 * Our agents' ERC-8004 registration in the form BNB's agent SDK writes and
 * reads: canonical JSON, base64 in a data: URI, held on chain.
 *
 * The SDK's buyer decodes a registration only from a data: URI
 * (AgentURIGenerator.decodeRegistrationFileFromBase64), so an https link, which
 * every other reader follows, left our agents invisible to it. The on-chain
 * copy carries what does not change: name, description, image, the services
 * and the registry entry. What does change (a pause, the price) is served live
 * by the A2A card and the https registration linked from it.
 */

import { IDENTITY_REGISTRY } from "@/lib/config";
import { ESCROW_TESTNET } from "@/lib/escrow/contracts";
import { SITE } from "@/lib/site";
import { pyJson } from "@/lib/escrow/sdk";
import type { ReferenceAgent } from "@/lib/house";

export function sdkRegistration(agent: ReferenceAgent, tokenId: string): Record<string, unknown> {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: agent.name,
    description: agent.description,
    image: `${SITE}/brand-kit/mandate-mark-512.png`,
    services: [
      // The card itself, as the SDK's own agents list it; the SDK and our reader both accept it.
      { name: "A2A", endpoint: `${SITE}/a2a/${agent.slug}/.well-known/agent-card.json`, version: "0.3.0" },
      { name: "x402", endpoint: `${SITE}/api/x402/house/${agent.slug}` },
      { name: "MCP", endpoint: `${SITE}/api/mcp` },
      { name: "web", endpoint: `${SITE}/agents/${tokenId}` },
      { name: "registration", endpoint: `${SITE}/house/${agent.slug}/registration.json` },
    ],
    x402Support: true,
    active: true,
    registrations: [{ agentId: Number(tokenId), agentRegistry: `eip155:56:${IDENTITY_REGISTRY}` }],
    supportedTrust: ["crypto-economic"],
  };
}

/**
 * The same agent's registration on BNB Smart Chain testnet. Its A2A card
 * carries `?chain=97`, so a buyer on a testnet marketplace (Pokter, KATTEGAT,
 * Agent Atlas, HelloFugu) is quoted in test $U on the testnet kernel, and the
 * agent delivers there. No x402 service: paid calls settle on mainnet only.
 * `tokenId` is null for the first write, before the registry has given one.
 */
export function sdkRegistrationTestnet(agent: ReferenceAgent, tokenId: string | null, mainnetTokenId: string): Record<string, unknown> {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: agent.name,
    description: `${agent.description} On BNB Smart Chain testnet, hired free in test $U.`,
    image: `${SITE}/brand-kit/mandate-mark-512.png`,
    services: [
      { name: "A2A", endpoint: `${SITE}/a2a/${agent.slug}/.well-known/agent-card.json?chain=97`, version: "0.3.0" },
      { name: "MCP", endpoint: `${SITE}/api/mcp` },
      { name: "web", endpoint: `${SITE}/agents/${mainnetTokenId}` },
    ],
    x402Support: false,
    active: true,
    registrations: tokenId ? [{ agentId: Number(tokenId), agentRegistry: `eip155:97:${ESCROW_TESTNET.identity}` }] : [],
    supportedTrust: ["crypto-economic"],
  };
}

export const DATA_URI_PREFIX = "data:application/json;base64,";

/** The registration as the SDK encodes it for tokenURI. */
export const dataUri = (registration: Record<string, unknown>) => `${DATA_URI_PREFIX}${Buffer.from(pyJson(registration), "utf8").toString("base64")}`;

/**
 * The build prompt a builder hands their AI assistant: it must carry BNB
 * Chain's six checks, the right contracts for the network it names and none
 * of the other's, the job's onchain work as MANDATE's check judges it, and the
 * two things an assistant must never do.
 */

import { describe, expect, it } from "vitest";
import { buildPrompt, openIn, promptUrl } from "../build/prompt";
import { CATEGORIES, IDENTITY_REGISTRY, PROTOCOLS } from "../config";
import { ESCROW, ESCROW_TESTNET } from "../escrow/contracts";
import { QUALIFIES } from "../campaign/rules";

const WALLET = "0x00000000000000000000000000000000000000b1";

describe("buildPrompt", () => {
  it("carries all six of BNB Chain's checks, for every job and network", () => {
    for (const job of CATEGORIES) {
      for (const network of ["mainnet", "testnet"] as const) {
        const p = buildPrompt({ job, network, wallet: WALLET });
        for (const [title] of QUALIFIES) expect(p, `${job} ${network}`).toContain(title);
        expect(p).not.toContain("—");
        expect(p).not.toMatch(/\bADDRESS\b/);
      }
    }
  });

  it("names mainnet's kernel, registry and the job's contracts on mainnet, and nothing of testnet's", () => {
    const p = buildPrompt({ job: "health-factor", network: "mainnet", wallet: WALLET });
    expect(p).toContain(ESCROW.commerce);
    expect(p).toContain(IDENTITY_REGISTRY);
    expect(p).toContain(PROTOCOLS.venusComptroller);
    expect(p).toContain("/check?q=");
    expect(p).not.toContain(ESCROW_TESTNET.commerce);
    expect(p).not.toContain("bnbchain_official_bot");
  });

  it("names testnet's kernel, registry and faucets on testnet, and sends the assistant to official docs for protocol addresses", () => {
    const p = buildPrompt({ job: "grid-trading", network: "testnet", wallet: WALLET });
    expect(p).toContain(ESCROW_TESTNET.commerce);
    expect(p).toContain(ESCROW_TESTNET.identity);
    expect(p).toContain(`I would like to get tBNB and U on BNB Smart Chain Testnet to my wallet ${WALLET}`);
    expect(p).toContain("u-faucet");
    expect(p).not.toContain(PROTOCOLS.pancakeSmartRouter);
    expect(p).toContain("official documentation");
  });

  it("describes each job's onchain work the way MANDATE's check judges it", () => {
    expect(buildPrompt({ job: "health-factor", network: "mainnet" })).toMatch(/lending calls on Venus/);
    expect(buildPrompt({ job: "yield-optimisation", network: "mainnet" })).toMatch(/lending or vault calls/);
    expect(buildPrompt({ job: "grid-trading", network: "mainnet" })).toMatch(/swaps on PancakeSwap/);
    expect(buildPrompt({ job: "rebalancing", network: "mainnet" })).toMatch(/position calls on PancakeSwap V3/);
  });

  it("never lets the assistant ask for the wallet's key, or arrange hires the rules exclude", () => {
    const p = buildPrompt({ job: "rebalancing", network: "mainnet", wallet: WALLET });
    expect(p).toContain("Never ask me for its private key");
    expect(p).toContain("never pay or reward anyone to hire it");
    expect(p).toContain(`my campaign wallet, ${WALLET}`);
  });

  it("asks for the wallet when none, or a malformed one, is given", () => {
    expect(buildPrompt({ job: "rebalancing", network: "mainnet", wallet: "0x12" })).toContain("ask me for its address");
    expect(buildPrompt({ job: "rebalancing", network: "mainnet" })).toContain("ask me for its address");
  });

  it("uses the builder's idea when given, and asks the assistant to propose one when not", () => {
    expect(buildPrompt({ job: "yield-optimisation", network: "mainnet", idea: "  move my USDT\nto the best Venus market " })).toContain("What I want it to do: move my USDT to the best Venus market");
    expect(buildPrompt({ job: "yield-optimisation", network: "mainnet" })).toContain("propose something specific");
  });
});

describe("the links that open it in a chat", () => {
  it("carry a short line pointing at the prompt's own URL", () => {
    const input = { job: "health-factor" as const, network: "testnet" as const, wallet: WALLET, idea: "watch my loan" };
    const url = promptUrl(input);
    expect(url).toContain("/api/build/prompt?job=health-factor&network=testnet");
    expect(url).toContain(`wallet=${WALLET}`);
    const links = openIn(input);
    expect(links.claude.length).toBeLessThan(2_000);
    expect(decodeURIComponent(links.claude)).toContain(url);
    expect(decodeURIComponent(links.chatgpt)).toContain(url);
  });
});

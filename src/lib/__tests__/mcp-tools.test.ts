/**
 * The MCP server: the marketplace tools come first, and no hosted tool moves
 * money. hire_agent returns a link; hire_over_x402 returns terms.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ sql: null, db: null, hasDb: false }));

const { TOOL_SPECS, callTool } = await import("../../mcp/tools");
const { SITE } = await import("../site");

const AGENT = {
  tokenId: "341556",
  name: "Keel",
  hireable: true,
  price: "0.05 $U",
  page: "https://www.mandatemarkets.com/agents/341556",
  hire: "https://www.mandatemarkets.com/agents/341556#call",
  whyNot: null,
  rails: [
    { kind: "escrow", price: "0.05 $U" },
    { kind: "x402", price: "0.05 USD1", endpoint: "https://seller.test/x402" },
  ],
};

function answer(path: string): unknown {
  if (path.includes("/api/v1/market/341556")) return AGENT;
  if (path.includes("/api/escrow/quote")) return { kind: "sdk", provider: "0x00000000000000000000000000000000000000aa", price: "50000000000000000", expiresAt: 1_800_000_000, etaSeconds: 30, task: "t" };
  throw new Error(`unexpected ${path}`);
}

afterEach(() => vi.unstubAllGlobals());

describe("the MCP tools", () => {
  it("lists the marketplace tools first, each name once", () => {
    const names = TOOL_SPECS.map((t) => t.name);
    expect(names.slice(0, 9)).toEqual(["search_agents", "get_agent", "list_jobs", "try_agent", "get_price", "hire_agent", "check_agent", "build_prompt", "quest_progress"]);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain("hire_erc8183");
  });

  it("hire_agent never executes: it returns the live price and the buyer's own link", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      fetched.push(url);
      return new Response(JSON.stringify({ ok: true, data: answer(url) }), { status: 200 });
    }));
    const r = (await callTool("hire_agent", { tokenId: "341556" })) as Record<string, any>;
    expect(r.executed).toBe(false);
    expect(r.hire).toBe(AGENT.hire);
    expect(r.livePrice.price).toBe("0.05 $U");
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every((u) => u.startsWith(`${SITE}/api/`))).toBe(true);
  });

  it("hire_over_x402 over the hosted endpoint returns terms and pays nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify({ ok: true, data: answer(url) }), { status: 200 })));
    const r = (await callTool("hire_over_x402", { tokenId: "341556" })) as Record<string, any>;
    expect(r.executed).toBe(false);
    expect(r.price).toBe("0.05 USD1");
  });

  it("an API refusal reaches the model as the API's own words", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "That agent is not listed under one of the four jobs here." }), { status: 404 })));
    await expect(callTool("get_agent", { tokenId: "1" })).rejects.toThrow("not listed under one of the four jobs");
  });

  it("refuses a malformed token id before calling anything", async () => {
    await expect(callTool("get_price", { tokenId: "0x12" })).rejects.toThrow("ERC-8004 id");
  });
});

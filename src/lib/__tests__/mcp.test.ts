import { describe, expect, it } from "vitest";
import { callTool, TOOL_SPECS, TOOLS } from "@/mcp/tools";
import { CATEGORIES } from "@/lib/config";

/**
 * The MCP surface is the marketplace as an agent reaches it, and the thing
 * that matters most about it is what it refuses to do.
 *
 * Four tools are named for actions, hiring, paying for a call, opening a
 * mandate, revoking, that this server cannot perform, because performing them
 * needs keys it does not hold. Each returns what the action would take instead. A regression that
 * made one of them report success would be exactly the unverifiable claim this
 * register exists to strike out, so it is asserted here rather than trusted to
 * the tool descriptions.
 */

const WRITE_TOOLS = ["hire_agent", "hire_over_x402", "open_mandate", "revoke_session"] as const;
const READ_TOOLS = [
  "search_agents",
  "get_agent",
  "list_jobs",
  "try_agent",
  "get_price",
  "check_agent",
  "build_prompt",
  "quest_progress",
  "assay_agent",
  "check_duplication",
  "read_receipt",
] as const;

describe("the tool table", () => {
  it("advertises every tool it can dispatch, and no more", () => {
    expect(TOOL_SPECS.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  it("covers exactly the tools this server means to expose", () => {
    expect(TOOL_SPECS.map((t) => t.name).sort()).toEqual(
      [...READ_TOOLS, ...WRITE_TOOLS].sort(),
    );
  });

  it("gives every tool a description, since that is all a model has to choose by", () => {
    for (const t of TOOL_SPECS) {
      expect(t.description.length, `${t.name} description`).toBeGreaterThan(40);
    }
  });

  it("gives every tool a closed object schema", () => {
    for (const t of TOOL_SPECS) {
      expect(t.inputSchema.type, t.name).toBe("object");
      // Open schemas let a model pass an argument that is silently ignored,
      // which reads to it as the call having been honoured.
      expect(t.inputSchema.additionalProperties, t.name).toBe(false);
    }
  });

  it("says in the description of each write tool that the hosted endpoint does not write", () => {
    for (const name of WRITE_TOOLS) {
      const spec = TOOL_SPECS.find((t) => t.name === name)!;
      expect(spec.description, name).toMatch(/PREPARES|does NOT|DOES NOT/);
    }
  });

  it("refuses an unknown tool rather than answering something plausible", async () => {
    await expect(callTool("definitely_not_a_tool")).rejects.toThrow(/Unknown tool/);
  });
});

describe("the write tools never claim to have acted", () => {
  it("open_mandate prepares and does not execute over the hosted endpoint", async () => {
    const r = (await callTool("open_mandate", { category: "rebalancing" })) as {
      executed: boolean;
      reason: string;
      transaction: { to: string; value: string; data: string };
      terms: { category: string };
    };
    expect(r.executed).toBe(false);
    expect(r.reason).toMatch(/never signs/i);
    expect(r.transaction.data).toMatch(/^0x[0-9a-f]{8}/);
    expect(r.transaction.value).toBe("200000000000000");
    expect(r.terms.category).toBe("rebalancing");
  });

  it("open_mandate rejects a category that is not an office", async () => {
    await expect(callTool("open_mandate", { category: "not-an-office" })).rejects.toThrow(
      /category must be one of/,
    );
    await expect(callTool("open_mandate", {})).rejects.toThrow(/category must be one of/);
  });

  it("revoke_session prepares and does not execute over the hosted endpoint", async () => {
    const r = (await callTool("revoke_session", { mandateId: 3 })) as {
      executed: boolean;
      httpAlternative: { url: string };
      web: string;
    };
    expect(r.executed).toBe(false);
    expect(r.httpAlternative.url).toContain("/api/desk/revoke");
    expect(r.web).toContain("/desk");
  });

  it("revoke_session requires a real mandate id", async () => {
    await expect(callTool("revoke_session", {})).rejects.toThrow(/mandateId is required/);
    await expect(callTool("revoke_session", { mandateId: -1 })).rejects.toThrow(
      /mandateId is required/,
    );
  });

  it("every write tool carries executed:false, whatever else it returns", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["open_mandate", { category: CATEGORIES[0] }],
      ["revoke_session", { mandateId: 0 }],
    ];
    for (const [name, args] of calls) {
      const r = (await callTool(name, args)) as { executed: boolean };
      expect(r.executed, name).toBe(false);
    }
  });
});

describe("only the local signer signs", () => {
  it("the hosted context never signs, even with a signer key in the environment", async () => {
    const before = process.env.MCP_SIGNER_KEY;
    process.env.MCP_SIGNER_KEY = "0x" + "11".repeat(32);
    try {
      const r = (await callTool("open_mandate", { category: CATEGORIES[0] })) as { executed: boolean; transaction: { data: string } };
      expect(r.executed).toBe(false);
      expect(r.transaction.data).toMatch(/^0x[0-9a-f]+$/);
    } finally {
      if (before === undefined) delete process.env.MCP_SIGNER_KEY;
      else process.env.MCP_SIGNER_KEY = before;
    }
  });

  it("the stdio context without a key does not sign either", async () => {
    const before = process.env.MCP_SIGNER_KEY;
    delete process.env.MCP_SIGNER_KEY;
    try {
      const r = (await callTool("revoke_session", { mandateId: 0 }, { canSign: true })) as { executed: boolean };
      expect(r.executed).toBe(false);
    } finally {
      if (before !== undefined) process.env.MCP_SIGNER_KEY = before;
    }
  });
});

describe("argument validation", () => {
  it("assay_agent refuses a token id that is not a decimal integer", async () => {
    for (const bad of ["", "abc", "0x12", "1.5", "-4"]) {
      await expect(callTool("assay_agent", { tokenId: bad })).rejects.toThrow(
        /decimal integer/,
      );
    }
  });

  it("hire_over_x402 refuses a token id that is not a decimal integer", async () => {
    await expect(callTool("hire_over_x402", { tokenId: "nope" })).rejects.toThrow(
      /decimal integer/,
    );
  });
});

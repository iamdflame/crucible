import { describe, expect, it } from "vitest";
import { readServices } from "@/lib/sources/registry";

describe("a card's services", () => {
  it("names a URL listed twice for the protocol it speaks", () => {
    const s = readServices({
      services: [
        { name: "web", endpoint: "https://assay.example/api/agents/range" },
        { name: "A2A", version: "1.0.0", endpoint: "https://assay.example/api/agents/range" },
      ],
    });
    expect(s).toEqual([{ name: "A2A", endpoint: "https://assay.example/api/agents/range" }]);
  });

  it("keeps distinct URLs, in order", () => {
    const s = readServices({ services: [{ name: "web", endpoint: "https://a.example" }, { name: "MCP", endpoint: "https://b.example/mcp" }] });
    expect(s.map((x) => x.name)).toEqual(["web", "MCP"]);
  });
});

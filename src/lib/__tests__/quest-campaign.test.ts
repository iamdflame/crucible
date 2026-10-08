import { describe, expect, it } from "vitest";
import { acrossMarketplaces, countedHires, type ElsewhereJob, type HireRow } from "../market/tracking";

const row = (agentId: string, o: Partial<HireRow> = {}): HireRow => ({
  kind: "paid-call",
  agentId,
  agentName: `Agent ${agentId}`,
  category: "health-factor",
  tx: `0x${agentId}`,
  block: 1,
  contract: null,
  jobId: null,
  amount: "1",
  asset: null,
  completed: true,
  onChain: true,
  at: "2026-10-01T10:00:00Z",
  sponsored: false,
  ...o,
});

describe("Set and Earn: the hires that count", () => {
  it("counts each different agent once, the earliest hire standing for it", () => {
    const c = countedHires([row("1", { at: "2026-10-02T00:00:00Z", tx: "0xlate" }), row("1", { at: "2026-10-01T00:00:00Z", tx: "0xearly" }), row("2")], []);
    expect(c.map((h) => h.agentId)).toEqual(["1", "2"]);
    expect(c[0]!.tx).toBe("0xearly");
  });

  it("leaves out hires not confirmed on chain, calls MANDATE paid for, and the wallet's own agents", () => {
    const c = countedHires([row("1", { onChain: false }), row("2", { sponsored: true }), row("3"), row("4")], ["3"]);
    expect(c.map((h) => h.agentId)).toEqual(["4"]);
  });
});

describe("Set and Earn: hires on other marketplaces, from the shared escrow", () => {
  const WALLET = "0x00000000000000000000000000000000000000b1";
  const job = (jobId: string, provider: string, o: Partial<ElsewhereJob> = {}): ElsewhereJob => ({
    network: "mainnet",
    jobId,
    provider,
    tx: `0x${jobId}`,
    at: `2026-10-0${jobId.slice(-1)}T00:00:00Z`,
    ...o,
  });
  const directory: Record<string, { tokenId: string; name: string | null }[]> = {
    "0xaaa": [{ tokenId: "10", name: "Lattice" }],
    "0x73809f690000000000000000000000000000beef": [{ tokenId: "20", name: "One" }, { tokenId: "21", name: "Two" }],
    "0xccc": [{ tokenId: "3", name: "Agent 3" }],
    "0xddd": [{ tokenId: "99", name: "Mine" }],
  };
  const opts = { wallet: WALLET, owned: ["99"], agentsOfProvider: (p: string) => directory[p] ?? [] };
  const here = countedHires([row("1"), row("2")], []);

  it("adds each agent hired elsewhere once, by name when its wallet runs exactly one", () => {
    const r = acrossMarketplaces(here, [job("1", "0xaaa"), job("2", "0xaaa")], opts);
    expect(r.elsewhere.map((h) => h.agentName)).toEqual(["Lattice"]);
    expect(r.agents).toBe(3);
    expect(r.twoMarketplaces).toBe(true);
  });

  it("counts a wallet that runs several agents once, and says so", () => {
    const BRAIN = "0x73809f690000000000000000000000000000beef";
    const r = acrossMarketplaces([], [job("1", BRAIN), job("2", BRAIN)], opts);
    expect(r.agents).toBe(1);
    expect(r.elsewhere[0]!.agentName).toBe("one of 2 agents run by 0x7380…beef");
  });

  it("does not count an agent twice when it was also hired here", () => {
    const r = acrossMarketplaces(countedHires([row("3")], []), [job("1", "0xccc")], opts);
    expect(r.agents).toBe(1);
    expect(r.elsewhere).toHaveLength(0);
  });

  it("leaves out the wallet's own agents and jobs paid to itself", () => {
    const r = acrossMarketplaces([], [job("1", "0xddd"), job("2", WALLET)], opts);
    expect(r.agents).toBe(0);
  });

  it("keeps testnet hires apart, with testnet's explorer, since a testnet agent has its own identity", () => {
    const r = acrossMarketplaces([], [job("1", "0xaaa"), job("2", "0xaaa", { network: "testnet" })], opts);
    expect(r.agents).toBe(2);
    expect(r.elsewhere[1]!.explorer).toBe("https://testnet.bscscan.com/tx/0x2");
  });

  it("cannot say whether hires all made elsewhere span two marketplaces", () => {
    expect(acrossMarketplaces([], [job("1", "0xaaa"), job("2", "0xccc")], opts).twoMarketplaces).toBeNull();
    expect(acrossMarketplaces([], [job("1", "0xaaa")], opts).twoMarketplaces).toBe(false);
    expect(acrossMarketplaces(here, [], opts).twoMarketplaces).toBe(false);
  });
});

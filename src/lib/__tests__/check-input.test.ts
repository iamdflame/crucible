import { describe, expect, it } from "vitest";
import { readCheckInput } from "@/lib/campaign/check-input";

const W = "0x1111111111111111111111111111111111111111";

describe("readCheckInput", () => {
  it("reads an id, with or without a hash", () => {
    expect(readCheckInput(" 341554 ")).toEqual({ kind: "id", id: "341554" });
    expect(readCheckInput("#341554")).toEqual({ kind: "id", id: "341554" });
  });
  it("reads a wallet", () => {
    expect(readCheckInput(W)).toEqual({ kind: "wallet", wallet: W });
  });
  it("takes the id from a link to the agent's page", () => {
    expect(readCheckInput("https://www.mandatemarkets.com/agents/344119")).toEqual({ kind: "id", id: "344119" });
    expect(readCheckInput("mandatemarkets.com/agents/344119?about=x")).toEqual({ kind: "id", id: "344119" });
    expect(readCheckInput("https://www.8004scan.io/agents/56/341554")).toEqual({ kind: "id", id: "341554" });
    expect(readCheckInput(`https://bscscan.com/nft/${W}/341554`)).toEqual({ kind: "id", id: "341554" });
    expect(readCheckInput(`https://bscscan.com/token/${W}?a=341554`)).toEqual({ kind: "id", id: "341554" });
  });
  it("takes the wallet from a link to a wallet's page", () => {
    expect(readCheckInput(`https://bscscan.com/address/${W}`)).toEqual({ kind: "wallet", wallet: W });
  });
  it("treats words as a name", () => {
    expect(readCheckInput("Mandate Range-1")).toEqual({ kind: "name", text: "Mandate Range-1" });
  });
  it("refuses what it cannot read", () => {
    expect(readCheckInput("")).toEqual({ kind: "empty" });
    expect(readCheckInput("0x123")).toEqual({ kind: "bad" });
    expect(readCheckInput("https://example.com/about")).toEqual({ kind: "bad" });
    expect(readCheckInput("1".repeat(13))).toEqual({ kind: "bad" });
  });
});

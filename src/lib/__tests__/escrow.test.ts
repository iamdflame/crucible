/**
 * Escrowed jobs: the addresses the browser loads are the SDK's, a job is
 * counted from what the kernel says, and a delivery hashes to what was kept.
 */

import { describe, expect, it, vi } from "vitest";
import { keccak256, stringToHex } from "viem";
import { ERC8183_ADDRESSES } from "@altananetwork/sdk";
import { ESCROW, ESCROW_TESTNET, JOB_STATUS } from "../escrow/contracts";

vi.mock("@/lib/db/client", () => ({ sql: null, db: null, hasDb: false }));

describe("escrow contracts", () => {
  it("are the Altana SDK's own ERC-8183 addresses on BNB Smart Chain", () => {
    const sdk = ERC8183_ADDRESSES[56]!;
    expect(ESCROW.commerce).toBe(sdk.commerce);
    expect(ESCROW.router).toBe(sdk.router);
    expect(ESCROW.policy).toBe(sdk.policy);
    expect(ESCROW.paymentToken).toBe(sdk.paymentToken);
  });

  it("on testnet are BNB's agent SDK's own addresses for chain 97", async () => {
    const { NETWORKS } = await import("@bnbagent/sdk");
    const { getAddress: deployment } = await import("@bnbagent/sdk/networks");
    const { getAddress } = await import("viem");
    const n = NETWORKS["bsc-testnet"]!;
    expect(ESCROW_TESTNET.commerce).toBe(getAddress(n.commerceContract));
    expect(ESCROW_TESTNET.router).toBe(getAddress(n.routerContract));
    expect(ESCROW_TESTNET.policy).toBe(getAddress(n.policyContract));
    expect(ESCROW_TESTNET.identity).toBe(getAddress(n.registryContract));
    expect(ESCROW_TESTNET.paymentToken).toBe(getAddress(deployment(97).paymentToken));
  });

  it("names the kernel's states in its own order", async () => {
    const { JOB_STATUS: sdkStatus } = await import("@altananetwork/sdk");
    expect([...JOB_STATUS]).toEqual([...sdkStatus]);
  });
});

describe("escrow hires in the tracking API", () => {
  it("count a job as completed once our agent has submitted it, with the funding transaction as proof", async () => {
    const { escrowHires } = await import("../market/tracking");
    const base = {
      jobId: "56801",
      client: "0xabc",
      provider: "0x004c7ae8077560c75fe5687da39e7be0697ddbfd",
      slug: "range-1",
      tokenId: "344119",
      budget: "50000000000000000",
      subject: null,
      fundedTx: "0xfund",
      submitTx: null,
      settleTx: null,
      deliverableHash: null,
      expiredAt: null,
      submittedAt: null,
      note: null,
      createdAt: "2026-09-25T00:00:00Z",
      outside: false,
      inputs: null,
      sellerUrl: null,
    };
    const [funded, submitted] = escrowHires([
      { ...base, status: "FUNDED" },
      { ...base, jobId: "56802", status: "SUBMITTED" },
    ]);
    expect(funded).toMatchObject({ kind: "escrow-job", agentId: "344119", tx: "0xfund", jobId: "56801", completed: false, onChain: true, contract: ESCROW.commerce });
    expect(submitted!.completed).toBe(true);
    // The tracking module loads the whole catalogue on first import.
  }, 60_000);
});

describe("a deliverable", () => {
  it("is kept as text, so the bytes served hash to what was submitted", () => {
    // jsonb would have reordered these keys; text keeps them as hashed.
    const text = JSON.stringify({ job: { id: "1" }, answer: { b: 1, a: 2 } });
    expect(keccak256(stringToHex(text))).toBe(keccak256(stringToHex(JSON.stringify(JSON.parse(text)))));
    expect(text.indexOf('"b"')).toBeLessThan(text.indexOf('"a"'));
  });
});

describe("an outside seller's escrow quote", () => {
  const A2A = "https://seller.example/a2a";
  it("is read straight from a result or from a task's artifacts", async () => {
    const { quoteFrom } = await import("../escrow/a2a");
    const flat = quoteFrom(
      { accepted: true, provider: "0x73809F69916FcF7Ddc5BB1315fBdf96A569a5963", price: "100000000000000000", currency: "U", service: "health_factor", needs: { address: "the account (0x…)" }, verifying_contract: ESCROW.commerce, payment_token: ESCROW.paymentToken, chain_id: 56 },
      A2A,
    );
    expect(flat).toMatchObject({ price: "100000000000000000", service: "health_factor", needs: { address: "the account (0x…)" }, unpayable: null });
    const task = quoteFrom(
      { kind: "task", artifacts: [{ parts: [{ kind: "data", data: { skill: "negotiate", provider: "0xa09991fc5D8637bb4245737C3ebF26E24D653962", price: "5000000000000000000", currency: "U", service: "Venus liquidation-risk report" } }] }] },
      A2A,
    );
    expect(task).toMatchObject({ price: "5000000000000000000", service: null, serviceName: "Venus liquidation-risk report", unpayable: null });
  });
  it("cannot be funded here in another token, on another kernel, or on another chain", async () => {
    const { quoteFrom } = await import("../escrow/a2a");
    const base = { provider: "0x73809F69916FcF7Ddc5BB1315fBdf96A569a5963", price: "100000000000000000" };
    expect(quoteFrom({ ...base, currency: "USD1" }, A2A).unpayable).toMatch(/USD1/);
    expect(quoteFrom({ ...base, payment_token: "0x55d398326f99059fF775485246999027B3197955" }, A2A).unpayable).toMatch(/token other than \$U/);
    expect(quoteFrom({ ...base, verifying_contract: "0x0000000000000000000000000000000000000001" }, A2A).unpayable).toMatch(/different contract/);
    expect(quoteFrom({ ...base, chain_id: 8453 }, A2A).unpayable).toMatch(/8453/);
  });
});

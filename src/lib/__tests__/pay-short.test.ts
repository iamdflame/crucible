/**
 * A payer that cannot cover the price signs nothing, and the failure is ours.
 *
 * The trial pool paid Agripinaa Ranger 0.05 USDT on 6 Oct and kept 0.0135.
 * The next five Agripinaa payments were signed anyway, failed at the transfer
 * (TRANSFER_FROM_FAILED), and were held against the sellers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { domainSeparator, type Address } from "viem";

const VAULT = vi.hoisted(() => ({
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      network: "eip155:56",
      amount: "10000000000000000",
      asset: "0xcE24439F2D9C6a2289F741120FE202248B666666",
      payTo: "0xA06Db692d7e28356f80199Ff77E22a0Ef02A3518",
      maxTimeoutSeconds: 600,
      extra: { assetTransferMethod: "eip3009", decimals: 18, name: "United Stables", symbol: "U", version: "1" },
    },
  ],
}));
const sent = vi.hoisted(() => [] as { method?: string; body?: string; headers?: Record<string, string> }[]);
const sells = vi.hoisted(() => ({ tools: false }));
const held = vi.hoisted(() => ({ amount: 0n }));
const chain = vi.hoisted(() => ({ readContract: vi.fn(), getBlockNumber: vi.fn(async () => 1n), getLogs: vi.fn(async () => []) }));

vi.mock("@/lib/chain/market", () => ({ marketClient: chain, logClients: [], walletFor: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ sql: null, db: null, hasDb: false }));
vi.mock("@/lib/net/safe-fetch", () => ({
  safeFetch: vi.fn(async (url: string, opts: { method?: string; body?: string; headers?: Record<string, string> }) => {
    sent.push({ method: opts.method, body: opts.body, headers: opts.headers });
    const paidFor = Object.keys(opts.headers ?? {}).some((k) => /^x-payment$/i.test(k));
    return {
      status: paidFor ? 200 : 402,
      headers: new Headers(),
      text: paidFor ? '{"ok":true}' : JSON.stringify(sells.tools ? { ...VAULT, tools: [{ tool: "list_vaults", amount: "10000000000000000" }] } : VAULT),
      truncated: false,
      bytes: 0,
      finalUrl: url,
      redirects: 0,
    };
  }),
}));

const { payAndCall } = await import("../x402/pay-server");
const { toRecord } = await import("../market/paid-calls");

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const U = VAULT.accepts[0]!.asset as Address;

beforeEach(() => {
  sent.length = 0;
  sells.tools = false;
  chain.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === "balanceOf") return held.amount;
    if (functionName === "DOMAIN_SEPARATOR") return domainSeparator({ domain: { name: "United Stables", version: "1", chainId: 56, verifyingContract: U } });
    throw new Error(`unexpected read ${functionName}`);
  });
});

describe("a payer short of the price", () => {
  it("signs nothing, and the record says the failure is ours", async () => {
    held.amount = 5_000_000_000_000_000n; // 0.005 $U against a price of 0.01
    const call = await payAndCall({ url: "https://seller.test/x402", key: KEY, maxAmount: 10n ** 17n, settleWaitMs: 0 });
    expect(call.payerShort).toBe(true);
    expect(call.paid).toBe(false);
    expect(sent).toHaveLength(1); // the 402 only: no payment was offered
    const rec = toRecord(call, { tokenId: "338253", name: "Vault", category: "yield-optimisation", sponsored: true, subject: null, evidence: null });
    expect(rec.fault).toBe("ours");
  });

  it("still pays when it holds enough", async () => {
    held.amount = 10n ** 18n;
    const call = await payAndCall({ url: "https://seller.test/x402", key: KEY, maxAmount: 10n ** 17n, settleWaitMs: 0 });
    expect(call.payerShort).toBeUndefined();
    expect(sent).toHaveLength(2);
    expect(toRecord(call, { tokenId: "338253", name: "Vault", category: "yield-optimisation", sponsored: true, subject: null, evidence: null }).fault).toBeUndefined();
  });
});

describe("a seller of MCP tools over x402", () => {
  it("is paid on a tools/call for the tool its 402 names, not on a repeat of the GET", async () => {
    held.amount = 10n ** 18n;
    sells.tools = true;
    const call = await payAndCall({ url: "https://seller.test/x402", key: KEY, maxAmount: 10n ** 17n, settleWaitMs: 0 });
    expect(call.delivered).toBe(true);
    expect(sent[0]!.method).toBe("GET");
    expect(sent[1]!.method).toBe("POST");
    expect(JSON.parse(sent[1]!.body!)).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_vaults", arguments: {} } });
  });

  it("keeps a plain GET for a seller that names no tools", async () => {
    held.amount = 10n ** 18n;
    await payAndCall({ url: "https://seller.test/x402", key: KEY, maxAmount: 10n ** 17n, settleWaitMs: 0 });
    expect(sent[1]!.method).toBe("GET");
    expect(sent[1]!.body).toBeUndefined();
  });
});

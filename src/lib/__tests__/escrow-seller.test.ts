import { describe, expect, it } from "vitest";
import { keccak256, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import reference from "./fixtures/sdk-negotiate-reference.json";
import { checkSdkQuote, isManifest, jobDescription, manifestFor, manifestHash, pyJson, readSignedDescription, type SdkQuote } from "../escrow/sdk";
import { quoteAsSeller, subjectOfTask, MAX_QUOTE_TTL, REASON } from "../escrow/seller";

/**
 * Our agents sell in BNB's standard, so a buyer on BNB's agent SDK must get
 * from us exactly what the SDK's own NegotiationHandler would give it. The
 * fixture is the SDK's output (bnbagent-sdk 7a7a431) for a throwaway key and a
 * fixed clock; ECDSA signatures are deterministic, so the signature matches too.
 */

const account = privateKeyToAccount(keccak256(stringToHex("mandate seller fixture")));
const COMMERCE = "0xEa4DAa3100A767e86FDed867729ae7446476EBA6" as const;
const TOKEN = "0xcE24439F2D9C6a2289F741120FE202248B666666" as const;
const terms = (now = reference.now) => ({
  chainId: 56,
  commerce: COMMERCE,
  token: TOKEN,
  price: 50_000_000_000_000_000n,
  etaSeconds: 600,
  now,
  provider: account.address,
  sign: (h: Hex) => account.signMessage({ message: h }),
});

describe("our agents as sellers in BNB's standard hire", () => {
  it("answers a negotiation exactly as the SDK's own handler does, signature included", async () => {
    expect(account.address).toBe(reference.provider);
    const ours = await quoteAsSeller(reference.request, terms());
    const { provider_address, ...rest } = ours;
    expect(provider_address).toBe(account.address);
    expect(rest).toEqual(reference.envelope);
  });

  it("gives a quote our own buyer accepts, signed by the provider, lasting the SDK's 900 seconds", async () => {
    const q = (await quoteAsSeller(reference.request, terms())) as unknown as SdkQuote;
    const r = await checkSdkQuote(q, { chainId: 56, commerce: COMMERCE, token: TOKEN, signers: [account.address], now: reference.now + 10 });
    expect("ok" in r && r.ok.provider).toBe(account.address);
    expect("ok" in r && r.ok.price).toBe(50_000_000_000_000_000n);
    expect("ok" in r && r.ok.expiresAt).toBe(reference.now + MAX_QUOTE_TTL);
    const read = await readSignedDescription(jobDescription(q));
    expect(read && "signer" in read && read.signer).toBe(account.address);
  });

  it("never lets a quote outlive 900 seconds, whatever it is asked", async () => {
    const q = (await quoteAsSeller(reference.request, { ...terms(), ttlSeconds: 86_400 })) as { response: { quote_expires_at: number } };
    expect(q.response.quote_expires_at).toBe(reference.now + MAX_QUOTE_TTL);
  });

  it("declines, with the SDK's reason codes, what it cannot quote", async () => {
    const reason = async (data: Record<string, unknown>) => ((await quoteAsSeller(data, terms())).response as { accepted: boolean; reason_code: string }).reason_code;
    expect(await reason({ terms: { deliverables: "a", quality_standards: "b" } })).toBe(REASON.AMBIGUOUS_TERMS);
    expect(await reason({ task_description: "t", terms: { deliverables: "a", quality_standards: "" } })).toBe(REASON.AMBIGUOUS_TERMS);
    expect(await reason({ task_description: "t", terms: { deliverables: "a", quality_standards: "b", price: "1.5" } })).toBe(REASON.AMBIGUOUS_TERMS);
    expect(await reason({ task_description: "t", terms: { deliverables: "a", quality_standards: "b", currency: "0x55d398326f99059fF775485246999027B3197955" } })).toBe(REASON.UNSUPPORTED);
    expect(await reason({ task_description: "t".repeat(5000), terms: { deliverables: "a", quality_standards: "b" } })).toBe(REASON.TASK_TOO_LONG);
  });

  it("signs nothing it declines", async () => {
    const q = await quoteAsSeller({ task_description: "t", terms: { deliverables: "a", quality_standards: "" } }, terms());
    expect(q.provider_sig).toBeUndefined();
    expect(q.negotiation_hash).toBeUndefined();
  });

  it("reads whom a job is about from its task, or leaves it to the buyer's own wallet", () => {
    expect(subjectOfTask("Health factor for 0x003911a1DD39D21de18A4A54A8af8692cB62A301 please", "guard-1")).toBe("0x003911a1DD39D21de18A4A54A8af8692cB62A301");
    expect(subjectOfTask("Check position #7546488 for drift", "range-1")).toBe("7546488");
    expect(subjectOfTask("Check position #7546488 for drift", "guard-1")).toBeNull();
    expect(subjectOfTask("Best yield for 1000 USDT", "yield-1")).toBeNull();
  });

  it("serves a manifest that hashes, as a buyer re-reads it, to exactly what it commits on chain", () => {
    const body = { answer: { healthFactor: 1.83, note: "café, ≥ 1.5 is safe" }, subject: "0x003911a1DD39D21de18A4A54A8af8692cB62A301" };
    const m = manifestFor(56999n, 56, { commerce: COMMERCE, router: "0x51895229E12F9876011789B04f8698af06cCD6DA", policy: "0x9C01845705b3078Aa2e8cfF7520a6376FD766dE5" }, JSON.stringify(body), "application/json", { agent: "Guard-1", erc8004: 344123 });
    const served = pyJson(m);
    const committed = manifestHash(m);
    expect(committed).toBe(keccak256(stringToHex(served)));
    const reread = JSON.parse(served) as unknown;
    expect(isManifest(reread)).toBe(true);
    expect(manifestHash(reread)).toBe(committed);
    expect(JSON.parse((reread as { response: { content: string } }).response.content)).toEqual(body);
    expect(/[^\x00-\x7f]/.test(served)).toBe(false);
  });
});

describe("our agents as sellers on BNB Smart Chain testnet", () => {
  it("quote in test $U on the testnet kernel, and an SDK buyer checking for chain 97 accepts it", async () => {
    const { ESCROW_TESTNET } = await import("../escrow/contracts");
    const t = { ...terms(), chainId: 97, commerce: ESCROW_TESTNET.commerce, token: ESCROW_TESTNET.paymentToken };
    const q = (await quoteAsSeller(reference.request, t)) as unknown as SdkQuote & { verifying_contract: string; chain_id: number };
    expect(q.chain_id).toBe(97);
    expect(q.verifying_contract).toBe(ESCROW_TESTNET.commerce);
    const r = await checkSdkQuote(q, { chainId: 97, commerce: ESCROW_TESTNET.commerce, token: ESCROW_TESTNET.paymentToken, signers: [account.address], now: reference.now + 10 });
    expect("refused" in r ? r.refused : null).toBeNull();
    // A mainnet buyer would refuse it: a testnet quote cannot be spent on mainnet.
    const main = await checkSdkQuote(q, { chainId: 56, commerce: COMMERCE, token: TOKEN, signers: [account.address], now: reference.now + 10 });
    expect("refused" in main).toBe(true);
    // And the job description built from it recovers to the agent, as our testnet watcher reads it.
    const read = await readSignedDescription(jobDescription(q));
    expect(read && "signer" in read ? read.signer : null).toBe(account.address);
  });
});

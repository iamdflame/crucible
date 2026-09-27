import { describe, expect, it } from "vitest";
import { keccak256, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import reference from "./fixtures/sdk-negotiate-reference.json";
import { checkSdkQuote, jobDescription, readSignedDescription, type SdkQuote } from "../escrow/sdk";
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
});

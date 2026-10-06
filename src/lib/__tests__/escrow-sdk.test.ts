import { describe, expect, it } from "vitest";
import { keccak256, stringToHex } from "viem";
import quote from "./fixtures/sdk-quote-lattice.json";
import { checkSdkQuote, isSdkQuote, jobDescription, manifestFor, manifestHash, negotiationHash, pyJson, sanitize, type SdkQuote } from "../escrow/sdk";

const q = quote as unknown as SdkQuote;
const LATTICE_OWNER = "0x5aAF7b5B2170986C59279682Bd714c475ae8C718";
const WANT = {
  chainId: 56,
  commerce: "0xEa4DAa3100A767e86FDed867729ae7446476EBA6" as const,
  token: "0xcE24439F2D9C6a2289F741120FE202248B666666" as const,
  signers: [LATTICE_OWNER],
  now: (q.response.negotiated_at ?? q.negotiated_at ?? 0) + 5,
};

describe("BNB's standard hire (bnbagent-sdk)", () => {
  it("serialises JSON exactly as Python's json.dumps(sort_keys, compact, ensure_ascii)", () => {
    expect(pyJson({ b: 1, a: { d: "x", c: [true, null] } })).toBe('{"a":{"c":[true,null],"d":"x"},"b":1}');
    expect(pyJson("café — ok")).toBe('"caf\\u00e9 \\u2014 ok"');
    expect(sanitize("a [b]\u0001c\td")).toBe("a (b)c\td");
  });

  it("recomputes a live agent's quote hash and recovers its registered owner", async () => {
    expect(isSdkQuote(q)).toBe(true);
    expect(negotiationHash(q)).toBe(q.negotiation_hash);
    const r = await checkSdkQuote(q, WANT);
    expect("ok" in r && r.ok.provider).toBe(LATTICE_OWNER);
    expect("ok" in r && r.ok.price).toBe(100000000000000000n);
    expect("ok" in r && r.ok.task).toMatch(/via mandatemarkets\.com/);
  });

  it("writes the description the agent will accept: the signed content, its hash and its signature", () => {
    const d = JSON.parse(jobDescription(q));
    expect(d.negotiation_hash).toBe(q.negotiation_hash);
    expect(d.provider_sig).toBe(q.provider_sig);
    const { negotiation_hash: _h, provider_sig: _s, ...signed } = d;
    expect(keccak256(stringToHex(pyJson(signed)))).toBe(q.negotiation_hash);
  });

  it("refuses a quote that was edited, expired, signed by a stranger, or priced for another kernel or token", async () => {
    const edited = { ...q, response: { ...q.response, terms: { ...q.response.terms, price: "1" } } };
    expect(await checkSdkQuote(edited, WANT)).toEqual({ refused: "its quote's hash does not match its terms" });
    expect(await checkSdkQuote(q, { ...WANT, now: (q.response.quote_expires_at ?? 0) + 1 })).toEqual({ refused: "its quote has expired" });
    expect(await checkSdkQuote(q, { ...WANT, signers: ["0x0000000000000000000000000000000000000001"] })).toEqual({ refused: "its quote is signed by a wallet this agent's registration does not name" });
    expect(await checkSdkQuote(q, { ...WANT, commerce: "0x0000000000000000000000000000000000000002" })).toEqual({ refused: "its escrow is a different contract from the ERC-8183 kernel we use" });
    expect(await checkSdkQuote(q, { ...WANT, token: "0x55d398326f99059fF775485246999027B3197955" })).toEqual({ refused: "it wants a token other than $U" });
  });

  it("hashes a deliverable manifest the way verifiers re-derive it", () => {
    const m = manifestFor(56802n, 56, { commerce: "0xc", router: "0xr", policy: "0xp" }, '{"answer":1}');
    expect(manifestHash(m)).toBe(keccak256(stringToHex('{"chain_id":56,"contracts":{"commerce":"0xc","policy":"0xp","router":"0xr"},"job_id":56802,"metadata":{},"response":{"content":"{\\"answer\\":1}","content_type":"application/json"},"version":1}')));
  });
});

describe("the task an outside agent is asked", () => {
  it("states a grid with both bounds, a stop and the capital, around the price now when left blank", async () => {
    const { gridTask, taskFor } = await import("../escrow/task");
    // The token's address rides with its name: one grid seller plans nothing without it (6 Oct).
    expect(gridTask({}, 776)).toBe("Grid plan for WBNB/USDT (token 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c) between 714 and 838 USDT, stop 678, capital 1000 USD, 10 levels");
    expect(gridTask({ lower: "700", upper: "800", capital: "500" }, 776)).toBe("Grid plan for WBNB/USDT (token 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c) between 700 and 800 USDT, stop 665, capital 500 USD, 10 levels");
    expect(taskFor("health-factor", "Keel", { wallet: "0xabc" })).toMatch(/for 0xabc, via mandatemarkets\.com$/);
    expect(taskFor("grid-trading", "Lattice", {}, { bnbUsd: 776 })).toMatch(/^Grid plan .* via mandatemarkets\.com$/);
  });
});

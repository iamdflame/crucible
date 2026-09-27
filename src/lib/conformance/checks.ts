/**
 * MANDATE's conformance checks: an agent's actual answer, field by field,
 * against our own reading of the chain.
 *
 * Every agent under a job is asked the same public question (the demo
 * account's Venus loan, its PancakeSwap V3 positions, the Venus USDT rate, a
 * grid inside stated bounds), and its answer is compared with what we read
 * from BNB Smart Chain ourselves, by code, never by a language model. An
 * answer about something we cannot read ourselves is "not comparable", never
 * a fail. Pure, so every rule is tested.
 */

export type Verdict = "pass" | "fail" | "not-comparable" | "unreadable";

/** The tolerances, published on /standard from these same constants so the page cannot drift from the code. */
export const TOLERANCE = {
  healthFactor: 0.02,
  healthFactorAged: 0.05,
  tick: 30,
  rate: 0.25,
  gridBounds: 0.01,
  agedAfterMs: 3_600_000,
} as const;

export interface Check {
  field: string;
  ours: string;
  theirs: string;
  pass: boolean;
}

export interface Result {
  verdict: Verdict;
  checks: Check[];
  /** Why, when the verdict is not a plain pass or fail. */
  note: string | null;
}

/** Every value in a JSON answer whose key matches, depth first. */
function values(v: unknown, key: RegExp, depth = 0, out: unknown[] = []): unknown[] {
  if (!v || typeof v !== "object" || depth > 8) return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (key.test(k)) out.push(x);
    if (x && typeof x === "object") values(x, key, depth + 1, out);
  }
  return out;
}

const firstNumber = (v: unknown, key: RegExp): number | null => {
  for (const x of values(v, key)) {
    const n = typeof x === "number" ? x : typeof x === "string" && /^-?\d+(\.\d+)?$/.test(x.trim()) ? Number(x) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
};
const firstBool = (v: unknown, key: RegExp): boolean | null => {
  for (const x of values(v, key)) if (typeof x === "boolean") return x;
  return null;
};

/** An answer as data: JSON as given, JSON inside a string, or nothing we can read. */
export function asData(answer: unknown): unknown {
  if (typeof answer !== "string") return answer;
  try {
    return JSON.parse(answer);
  } catch {
    const m = answer.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

const fmt = (n: number | null, dp = 3) => (n === null ? "none" : Number(n.toFixed(dp)).toString());
const within = (a: number, b: number, rel: number) => Math.abs(a - b) <= Math.abs(b) * rel;

/** Health factor: within 2% of the Comptroller-derived figure, or both saying there is no loan. */
export function checkHealth(answer: unknown, ref: { hf: number | null }, opts: { aged?: boolean } = {}): Result {
  const data = asData(answer);
  if (data === null || typeof data !== "object") return { verdict: "unreadable", checks: [], note: "the answer is not data we can read" };
  const theirs = firstNumber(data, /health.?factor|^hf$/i);
  if (ref.hf === null) {
    const pass = theirs === null || theirs > 1e6;
    return { verdict: pass ? "pass" : "fail", checks: [{ field: "health factor", ours: "no loan", theirs: fmt(theirs), pass }], note: null };
  }
  if (theirs === null) return { verdict: "fail", checks: [{ field: "health factor", ours: fmt(ref.hf), theirs: "none given", pass: false }], note: null };
  // An answer taken hours before our reading is held to 5%: prices move a loan's health factor.
  const pass = within(theirs, ref.hf, opts.aged ? TOLERANCE.healthFactorAged : TOLERANCE.healthFactor);
  return { verdict: pass ? "pass" : "fail", checks: [{ field: "health factor", ours: fmt(ref.hf), theirs: fmt(theirs), pass }], note: opts.aged ? "compared within 5%: the answer was taken more than an hour before our reading" : null };
}

/** Range: in or out of range as the pool's own tick says, and the tick itself within 30 of ours (answers are minutes apart). */
export function checkRange(answer: unknown, ref: { positions: { tokenId: string; inRange: boolean | null; tick: number | null }[] }, opts: { aged?: boolean } = {}): Result {
  const data = asData(answer);
  if (data === null || typeof data !== "object") return { verdict: "unreadable", checks: [], note: "the answer is not data we can read" };
  const live = ref.positions.filter((p) => p.inRange !== null);
  if (!live.length) return { verdict: "not-comparable", checks: [], note: "the test account holds no open position to compare" };
  const inRange = firstBool(data, /in.?range/i);
  const tick = firstNumber(data, /current.?tick|^tick$/i);
  const p = live[0]!;
  const checks: Check[] = [];
  if (inRange !== null) checks.push({ field: "in range", ours: String(p.inRange), theirs: String(inRange), pass: inRange === p.inRange });
  // A pool's tick moves by the minute; an answer taken hours ago is held to whether the range was right, not to the tick.
  if (tick !== null && p.tick !== null && !opts.aged) checks.push({ field: "current tick", ours: String(p.tick), theirs: String(tick), pass: Math.abs(tick - p.tick) <= TOLERANCE.tick });
  if (!checks.length) return { verdict: "not-comparable", checks, note: "the answer states neither whether the position is in range nor the pool's tick" };
  return { verdict: checks.every((c) => c.pass) ? "pass" : "fail", checks, note: null };
}

/**
 * Yield: a Venus USDT rate it states, within 25% of ours (rates move, and
 * published figures differ in how they count blocks). An answer about other
 * venues only is not comparable.
 */
export function checkYield(answer: unknown, ref: { venusUsdtAprPct: number | null }): Result {
  const data = asData(answer);
  if (data === null || typeof data !== "object") return { verdict: "unreadable", checks: [], note: "the answer is not data we can read" };
  if (ref.venusUsdtAprPct === null) return { verdict: "not-comparable", checks: [], note: "Venus's rate could not be read on this pass" };
  const text = JSON.stringify(data).toLowerCase();
  if (!text.includes("venus")) return { verdict: "not-comparable", checks: [], note: "the answer is about venues other than Venus, which we do not read ourselves" };
  let theirs = firstNumber(data, /(net.?)?ap[ry](.?pct|.?percent)?$|supply.?ap[ry]/i);
  if (theirs === null) return { verdict: "fail", checks: [{ field: "Venus USDT rate", ours: `${fmt(ref.venusUsdtAprPct, 2)}%`, theirs: "none given", pass: false }], note: null };
  if (theirs > 0 && theirs < 0.5) theirs *= 100; // a fraction, not a percentage
  const pass = within(theirs, ref.venusUsdtAprPct, TOLERANCE.rate);
  return { verdict: pass ? "pass" : "fail", checks: [{ field: "Venus USDT rate", ours: `${fmt(ref.venusUsdtAprPct, 2)}%`, theirs: `${fmt(theirs, 2)}%`, pass }], note: null };
}

/** Grid: every level inside the bounds asked for, in order, as many as asked for, and allocations within the capital. */
export function checkGrid(answer: unknown, ref: { lower: number; upper: number; levels: number; capital: number }): Result {
  const data = asData(answer);
  if (data === null || typeof data !== "object") return { verdict: "unreadable", checks: [], note: "the answer is not data we can read" };
  const arr = values(data, /^(levels|grid|prices|grid_levels)$/i).find((x) => Array.isArray(x)) as unknown[] | undefined;
  if (!arr?.length) return { verdict: "fail", checks: [{ field: "levels", ours: `${ref.levels} inside ${ref.lower} to ${ref.upper}`, theirs: "none given", pass: false }], note: null };
  const prices = arr.map((x) => (typeof x === "number" ? x : firstNumber(x, /^price$/i))).filter((n): n is number => n !== null);
  const alloc = arr.map((x) => (typeof x === "object" ? firstNumber(x, /alloc|usd|capital|size/i) : null)).filter((n): n is number => n !== null);
  const inside = prices.every((p) => p >= ref.lower * (1 - TOLERANCE.gridBounds) && p <= ref.upper * (1 + TOLERANCE.gridBounds));
  const ordered = prices.every((p, i) => i === 0 || p >= prices[i - 1]!) || prices.every((p, i) => i === 0 || p <= prices[i - 1]!);
  const checks: Check[] = [
    { field: "levels inside the bounds", ours: `${ref.lower} to ${ref.upper}`, theirs: prices.length ? `${fmt(Math.min(...prices), 2)} to ${fmt(Math.max(...prices), 2)}` : "no prices", pass: prices.length > 0 && inside },
    { field: "level count", ours: String(ref.levels), theirs: String(prices.length), pass: Math.abs(prices.length - ref.levels) <= 1 },
    { field: "levels in order", ours: "ascending or descending", theirs: ordered ? "in order" : "out of order", pass: ordered },
  ];
  if (alloc.length) {
    const sum = alloc.reduce((a, b) => a + b, 0);
    checks.push({ field: "allocation within capital", ours: `at most ${ref.capital}`, theirs: fmt(sum, 2), pass: sum <= ref.capital * 1.01 });
  }
  return { verdict: checks.every((c) => c.pass) ? "pass" : "fail", checks, note: null };
}

/**
 * The hire law: no honourable path, no button.
 *
 * Every card and profile used to end in a Hire button, whatever stood behind
 * it. For an agent we do not operate, that button opened a job in our own
 * market which only our keeper ever bid on, so "Hire Ranger" hired us. For an
 * agent that had not answered in days, it offered a hire nobody would pick up.
 * A rival could screenshot either and be right.
 *
 * This is the one place that decides, for every surface, whether a hire can
 * be honoured and by which rail:
 *
 *   x402      the agent quoted a price in its own 402 that this marketplace can
 *             pay (BNB Smart Chain, a token we pay in, a transfer method we sign)
 *   mandate   the agent bids in this market, so opening a job here reaches it:
 *             our reference agents, labelled as ours, and any agent that has bid
 *   escrow    the agent's seller priced an ERC-8183 job over A2A, in $U, on the
 *             kernel we use: the buyer funds the escrow, the seller delivers on
 *             chain, and the money comes back if it does not
 *
 * and it requires a recent answer. When no rail exists the verdict carries the
 * reason, in a sentence a person can act on, and the surface shows that
 * instead of a button. Surfaces do not decide this themselves.
 */

import type { Listing } from "@/lib/market/listing";
import { isOurs } from "@/lib/market/judge";
import { listPaidCalls, outcomes, paidCallsFromFile, type Outcome } from "@/lib/market/paid-calls";
import { pauseFor } from "@/lib/market/paused";
import { isTeam } from "@/lib/team";
import { referenceRegistrations } from "@/lib/house";

let refTokens: { at: number; ids: Set<string> } | null = null;
/** Our four reference agents' token ids, read from their registrations at most once a minute. */
function referenceTokenIds(): Set<string> {
  if (!refTokens || Date.now() - refTokens.at > 60_000) refTokens = { at: Date.now(), ids: new Set(Object.values(referenceRegistrations()).map((r) => r.tokenId)) };
  return refTokens.ids;
}
import { JOBS_OPEN } from "@/lib/market/jobs-open";
import { escrowPriceLabel } from "@/lib/market/listing";
import { missedEscrowJobs, providerFor } from "@/lib/escrow/jobs";
import { HOUSE_BUDGET } from "@/lib/escrow/contracts";
import { ESCROW_OPEN } from "@/lib/escrow/open";
import { houseSlug } from "@/lib/market/performance";
import { humanAmount } from "@/lib/x402/quote";

/** The wallet one of our reference agents takes escrowed jobs from, when it takes them. */
function houseProvider(tokenId: string): string | null {
  const slug = houseSlug(tokenId);
  return slug ? (providerFor(slug)?.owner ?? null) : null;
}
import { nameSome, toolsFit } from "@/lib/assay/tools";

/** A hire is only offered on an answer from the last day. */
export const FRESH_HOURS = 24;
/** "Answering now" means an answer inside this window. */
export const LIVE_MINUTES = 15;
let cached: { at: number; map: Map<string, Outcome> } | null = null;
let fromDb: { at: number; map: Map<string, Outcome> } | null = null;
/** Outside escrow sellers whose latest job passed its deadline undelivered, by token id: the job and when it expired. */
let escrowMissed: Map<string, { jobId: string; at: string }> = new Map();

/**
 * Loads every recorded call, the database's and the committed file's, so the
 * law remembers a failure a visitor's own payment met, not only ours.
 */
export async function warmOutcomes(): Promise<void> {
  const [calls, missed] = await Promise.all([listPaidCalls().catch(() => null), missedEscrowJobs().catch(() => null)]);
  if (calls) fromDb = { at: Date.now(), map: outcomes(calls) };
  if (missed) escrowMissed = missed;
}

/** What happened when we last paid each agent: the database's record when warm, the committed file otherwise. */
function history(): Map<string, Outcome> {
  if (fromDb && Date.now() - fromDb.at < 5 * 60_000) return fromDb.map;
  if (!cached || Date.now() - cached.at > 60_000) {
    cached = { at: Date.now(), map: outcomes(paidCallsFromFile()) };
  }
  return cached.map;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}`;
}

export type Rail =
  | {
      kind: "x402";
      /** The price as a person reads it, e.g. "0.02 USD1". */
      price: string;
      method: "eip3009" | "permit2" | null;
      endpoint: string;
    }
  | { kind: "mandate" }
  | {
      kind: "escrow";
      /** The budget as a person reads it, e.g. "0.10 $U". */
      price: string;
      /** The same budget in $U base units (18 decimals), for figures. */
      wei: string;
      /** The wallet the job names as provider. */
      provider: string;
    };

export interface HireVerdict {
  /** A hire this site can honour exists for this agent right now. */
  ok: boolean;
  rails: Rail[];
  /** Why not, when not. */
  reason: string | null;
  /** The same reason in a few words, for a tile. The full sentence is on the agent page. */
  short: string | null;
  /** Minutes since we last saw it answer, or null when it never has. */
  answeredMinutesAgo: number | null;
  answeringNow: boolean;
  /** Operated by Mandate, and labelled so everywhere. */
  ours: boolean;
}

function ago(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min ago`;
  const h = minutes / 60;
  return h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`;
}

export function hirePath(
  l: Pick<Listing, "tokenId" | "owner" | "probe" | "liveness" | "quote" | "priceLabel"> & { category?: Listing["category"]; escrowQuote?: Listing["escrowQuote"] },
  opts: { now?: number; bidders?: ReadonlySet<string>; outcomes?: Map<string, Outcome>; jobsOpen?: boolean; escrowMissed?: Map<string, { jobId: string; at: string }> } = {},
): HireVerdict {
  const now = opts.now ?? Date.now();
  const ours = isOurs(l);
  const bidder = ours || Boolean(l.owner && opts.bidders?.has(l.owner.toLowerCase()));
  /*
    An endpoint that answers, but in no agent protocol, cannot be paid per
    call. It can still take a job in this market, which reaches it through the
    contract rather than its endpoint, so for a bidder that answer counts.
  */
  const responded = Boolean(l.probe?.answered) || (l.liveness === "not-agent" && bidder);
  const at = l.probe?.at ? Date.parse(l.probe.at) : NaN;
  const minutes = responded && Number.isFinite(at) ? Math.max(0, (now - at) / 60_000) : null;
  const base = { answeredMinutesAgo: minutes, answeringNow: minutes !== null && minutes <= LIVE_MINUTES, ours };
  const refuse = (reason: string, short: string): HireVerdict => ({ ok: false, rails: [], reason, short, ...base });

  // A decision we took about our own agent outranks anything it answers.
  const pause = pauseFor(l.tokenId);
  if (pause && pause.scope === "all") return refuse(pause.reason, pause.short);

  /*
    Our own operating wallets registered as agents, a keeper that bids for us
    or our marketplace's own identity, are not agents for hire. Offered, they
    padded a job's count with us twice over. Only our four reference agents
    are offered, on the same terms as anyone's.
  */
  if (isTeam(l.owner) && !referenceTokenIds().has(l.tokenId)) {
    return refuse("One of MANDATE's own operating wallets, registered as an agent so its work is on record. It bids and settles for us; it is not for hire.", "Our operating wallet, not for hire");
  }

  if (l.liveness === "no-endpoint") {
    return l.probe?.refused
      ? refuse(`Its registration names an endpoint we will not call: ${l.probe.error ?? "plain http, or an address on a private network"}.`, "Endpoint we will not call")
      : refuse("Its registry card names nothing to call, so there is nothing to hire.", "Publishes nothing to call");
  }
  if (l.liveness === "untested" || !l.probe) return refuse("We have not called it yet, so we cannot say it will pick up.", "Not checked yet");
  if (l.liveness === "not-agent" && !bidder) {
    return refuse("It answers, but not in MCP, A2A or x402, so there is nothing here we know how to hire.", "No agent protocol");
  }
  if (!responded) return refuse("It did not answer when we last called it.", "Did not answer our last call");
  if (minutes === null) return refuse("We have no time for its last answer, so we cannot say it is still there.", "No recent answer on record");
  if (minutes > FRESH_HOURS * 60) {
    return refuse(`It last answered ${ago(minutes)}. A hire is only offered on an answer from the last day.`, `Last answered ${ago(minutes)}`);
  }

  // The software behind the card offers something else: a claim its own server contradicts.
  const fit = toolsFit(l.category ?? null, l.probe.tools);
  if (fit.state === "mismatch") {
    return refuse(`The software behind it offers ${nameSome(fit.listed)}, and none of it fits the job its card claims.`, "Tools do not fit its job");
  }

  /*
    What happened the last time it was paid outranks what it says it charges.
    An agent whose most recent paid call took the money and answered with an
    error, or refused a correct payment, is not offered to anyone until it
    delivers a paid call again. It used to come back after seven days on its
    own, which would have put real users' money in front of a seller that had
    not fixed anything.
  */
  const seen = (opts.outcomes ?? history()).get(l.tokenId);
  if (seen?.lastFailed && seen.lastAt) {
    const took = seen.paidNotDelivered > 0 && seen.lastTx;
    const what = took
      ? `We paid it on ${shortDate(seen.lastAt)} and it answered with an error instead of the work`
      : `It was offered a correctly signed payment on ${shortDate(seen.lastAt)} and refused it`;
    return refuse(`${what}: ${(seen.lastWhy ?? "no reason given").slice(0, 220)}. It comes back once it delivers a paid call.`, took ? "Took payment, returned an error" : "Refused a correct payment");
  }

  const rails: Rail[] = [];
  if (l.quote?.payable) {
    rails.push({ kind: "x402", price: l.priceLabel ?? l.quote.amount, method: l.quote.transferMethod ?? null, endpoint: l.quote.endpoint });
  }
  /*
    An escrowed job: our own agents deliver one from their own wallets, and an
    outside seller at the price it quoted, unless its last job passed the
    deadline undelivered. It leads the rails: the chain records it against the
    agent, and the buyer's money comes back if the work does not arrive.
  */
  const missed = (opts.escrowMissed ?? escrowMissed).get(l.tokenId);
  const eq = l.escrowQuote;
  const house = ours && ESCROW_OPEN ? houseProvider(l.tokenId) : null;
  if (house) {
    rails.unshift({ kind: "escrow", price: `${humanAmount(HOUSE_BUDGET.toString(), 18)} $U`, wei: HOUSE_BUDGET.toString(), provider: house });
  } else if (eq && !eq.unpayable && !ours && !missed) {
    rails.unshift({ kind: "escrow", price: escrowPriceLabel(eq) ?? `${eq.price} $U`, wei: eq.price, provider: eq.provider });
  }
  // A job hands it capital to act with, which a trading pause forbids; its paid answer does not.
  // Jobs are offered only while the market settles them on its own (lib/market/jobs-open).
  if (bidder && !pause && (opts.jobsOpen ?? JOBS_OPEN)) rails.push({ kind: "mandate" });

  if (!rails.length) {
    if (missed) {
      return refuse(
        `Escrowed job #${missed.jobId} reached its deadline on ${shortDate(missed.at)} with nothing delivered, so its buyer can take the budget back. It comes back once it delivers a job again.`,
        "Missed an escrowed job",
      );
    }
    if (eq?.unpayable) return refuse(`It prices escrowed jobs, but ${eq.unpayable}.`, "Its price is in a token we cannot pay");
    return refuse(
      l.quote
        ? `It quoted a price we cannot pay: ${l.quote.unpayable}.`
        : "It has not quoted a price, and it does not bid on jobs in this market, so a hire here would not reach it.",
      l.quote ? "Its price is in a token we cannot pay" : "No price we can pay yet",
    );
  }
  return { ok: true, rails, reason: null, short: null, ...base };
}

/** The first rail a surface should lead with: an escrowed job, then a paid call, then a job it must bid on. */
export function primaryRail(v: HireVerdict): Rail | null {
  return v.rails.find((r) => r.kind === "escrow") ?? v.rails.find((r) => r.kind === "x402") ?? v.rails[0] ?? null;
}

/** Where the primary action goes, for a card or a profile. */
export function hireHref(tokenId: string, v: HireVerdict, about?: string): string | null {
  const r = primaryRail(v);
  if (!r) return null;
  if (r.kind === "x402" || r.kind === "escrow") return `/agents/${tokenId}#call`;
  return about ? `/hire/${tokenId}?about=${encodeURIComponent(about)}` : `/hire/${tokenId}`;
}

/**
 * The clock this deployment does not have.
 *
 * Vercel's hobby plan runs one cron a day, GitHub Actions is billing-locked,
 * and the probe has to be at most fifteen minutes old for anything on the site
 * to claim liveness. So the schedule lives here instead of in a platform: one
 * authorised endpoint (`/api/cron/tick`) is called every few minutes from
 * outside, and this decides which jobs are actually due.
 *
 * Every job records when it last ran and what it said, so `/status` can show
 * the clock rather than assert it, and a job that starts failing is visible as
 * a widening gap rather than as silence.
 */

import { lastRuns, note, recordStatus } from "@/lib/ops/history";
import { testHires } from "@/lib/conformance/hires";
import { refreshIfStale } from "@/lib/census/refresh";
import { readGridWindow } from "@/lib/grid/window";
import { judgePathChecks } from "@/lib/ops/status";
import { definitionOfDone, score } from "@/lib/ops/definition-of-done";
import { store } from "@/lib/data/snapshots";
import { beat } from "@/lib/heartbeat";
import { sweepOurJobs, sweeperOn } from "@/lib/market/sweeper";
import { renewHouseSessions } from "@/lib/chain/house";
import { runHouse, HOUSE_CADENCE_MIN } from "@/lib/house/run";
import { continuePoolGap } from "@/lib/pancake/pool-gap";
import { tailRegistry, warmRegistry } from "@/lib/registry/tail";
import { confirmPending } from "@/lib/market/confirm";
import { sweepEscrow } from "@/lib/escrow/jobs";
import { runLeashes } from "@/lib/leash/run";
import { advanceEpochs } from "@/lib/market/epochs";
import { testBuys } from "@/lib/market/test-buys";
import { checkAlerts } from "@/lib/alerts/watch";
import { requirements } from "@/lib/ops/requirements";
import { runConformance } from "@/lib/conformance/run";
import { warmOutcomes } from "@/lib/market/hire-law";
import { refreshEscrowQuotes } from "@/lib/census/quotes";
import { watchTestnet } from "@/lib/campaign/testnet";
import { sweepTestnet } from "@/lib/escrow/testnet-jobs";

export interface Job {
  name: string;
  everyMinutes: number;
  budgetMs: number;
  /** After-response jobs are told how much of the shared window is theirs. */
  run: (budgetMs?: number) => Promise<unknown>;
  /**
   * Runs after the tick has answered, on its own budget. For long reads that
   * would otherwise eat the pinger's thirty seconds and starve every job
   * behind them: the function lives on for its full duration after the reply.
   */
  afterResponse?: boolean;
}

/*
  Order is priority. A pinger gives one call a fixed number of seconds, so the
  tick runs what fits and leaves the rest for the next call rather than being
  cut off mid-job: the cheap sample that keeps the history dense goes first,
  the long reads after it.
*/
export const JOBS: Job[] = [
  /*
    The house agents come first. A turn that finds nothing to do costs a few
    reads; one that acts is the reason the clock exists, and must not be the
    job deferred for lack of time. Range-1 starts no transaction more than
    eight seconds into its turn and resumes on the next one.
  */
  { name: "guard-1", everyMinutes: HOUSE_CADENCE_MIN["guard-1"], budgetMs: 15_000, run: () => runHouse("guard-1") },
  { name: "range-1", everyMinutes: HOUSE_CADENCE_MIN["range-1"], budgetMs: 20_000, run: () => runHouse("range-1") },
  {
    // Six beats and one row in the history. Cheap, so it runs on every tick.
    name: "status",
    everyMinutes: 5,
    budgetMs: 14_000,
    run: async () => {
      const checks = await judgePathChecks();
      const samples = await recordStatus(checks);
      // Kept whole for /status, which reads it rather than spending five seconds per visit asking again.
      await store("status-checks", checks);
      return { ok: checks.every((c) => c.ok), beats: checks.length, samples };
    },
  },
  {
    // The answering set, so no page ever claims a liveness older than this.
    name: "probe",
    everyMinutes: 10,
    budgetMs: 16_000,
    run: () => refreshIfStale({ limit: 40, budgetMs: 14_000, force: true }),
  },
  {
    name: "grid-window",
    everyMinutes: 30,
    budgetMs: 10_000,
    run: async () => {
      const w = await readGridWindow({ fresh: true });
      return { fills: w.fills.length, toBlock: w.toBlock };
    },
  },
  {
    // Paid checks: an agent that answers only a paid job is hired for one from the trial pool, within $2 a day, so its answer can be checked too.
    name: "test-hires",
    everyMinutes: 60,
    budgetMs: 55_000,
    afterResponse: true,
    run: (budgetMs = 50_000) => testHires({ budgetMs }),
  },
  {
    // MANDATE's conformance checks: each hireable agent's answer against our own chain reading, oldest first.
    name: "conformance",
    everyMinutes: 60,
    budgetMs: 25_000,
    afterResponse: true,
    run: (budgetMs = 23_000) => runConformance({ budgetMs }),
  },
  {
    // BNB's Phase 2 requirements, each worked out from what the site can read, for /status and /api/requirements.
    name: "requirements",
    everyMinutes: 15,
    budgetMs: 25_000,
    afterResponse: true,
    run: async () => {
      await warmRegistry().catch(() => undefined);
      await warmOutcomes().catch(() => undefined);
      const boxes = await requirements();
      if (boxes.length) await store("requirements", boxes);
      return score(boxes);
    },
  },
  {
    /*
      The definition asks the ladder, the chain and the database, so it is its
      own job rather than a tail on the status sample: it took thirteen seconds
      and pushed a whole tick past the pinger's thirty-second limit.
    */
    name: "definition",
    everyMinutes: 15,
    budgetMs: 22_000,
    run: async () => {
      const boxes = await definitionOfDone();
      if (boxes.length) await store("definition", boxes);
      return score(boxes);
    },
  },
  {
    /*
      Escrowed jobs mature on their own day: a provider that delivered is paid
      only when somebody settles after the dispute window, and one that never
      delivered holds the escrow until the refund is claimed. Neither should
      wait for an operator to be awake.
    */
    name: "sweeper",
    everyMinutes: 30,
    budgetMs: 20_000,
    run: async () => {
      const dry = !sweeperOn();
      const r = await sweepOurJobs({ max: 2, dry });
      return { dry, checked: r.checked, actions: r.actions };
    },
  },
  { name: "yield-1", everyMinutes: HOUSE_CADENCE_MIN["yield-1"], budgetMs: 15_000, run: () => runHouse("yield-1") },
  {
    /*
      A session expires, and nothing used to notice. Guard-1, Yield-1 and
      Grid-1 all lapsed on 12 September; they were still listed, still had
      their keys, and could not act on anything for six days. This renews a
      leash while it still has three days left, so the agents never go quiet
      waiting for an operator to remember. Nothing is due on most runs, and a
      run that is due costs one registration each.
    */
    name: "leases",
    everyMinutes: 6 * 60,
    budgetMs: 20_000,
    run: async () => {
      /*
        Off unless switched on. A renewal is a registration transaction paid
        for out of the operator's own balance, and a job that spends money on
        a clock should be something the operator turned on deliberately, not
        something that starts the moment it is deployed. With it off this
        reports what is lapsing so `/status` can still say so.
      */
      if (process.env.LEASE_RENEWAL !== "on") {
        const due = await renewHouseSessions({ withinDays: 3, max: 0 });
        return {
          off: "LEASE_RENEWAL is not on, so nothing was granted",
          lapsing: due.filter((x) => x.was !== "live" && !x.skipped).map((x) => `${x.slug} ${x.was}`),
          paused: due.filter((x) => x.skipped === "paused").map((x) => x.slug),
        };
      }
      const r = await renewHouseSessions({ days: 21, withinDays: 3, max: 2 });
      const did = r.filter((x) => x.renewed);
      return {
        renewed: did.map((x) => x.slug),
        failed: r.filter((x) => x.error).map((x) => `${x.slug}: ${x.error}`),
        live: r.filter((x) => x.was === "live" && !x.skipped).length,
        paused: r.filter((x) => x.skipped === "paused").map((x) => x.slug),
      };
    },
  },
  {
    name: "heartbeat",
    everyMinutes: 15,
    budgetMs: 5_000,
    run: async () => {
      await beat("cron", 1, { by: "tick" });
      return { wrote: "cron" };
    },
  },
  /*
    PancakeSwap's pool gaps. A new window starts every twelve hours; reading
    one takes many slices, since a thousand blocks of V3 swaps is 24 MB, so the
    job looks in on every tick, reads what fits, and publishes when done.
  */
  {
    name: "pool-gap",
    everyMinutes: 5,
    // The tick takes at most 22 of the function's 60 seconds; the jobs after it share at most 36 of the rest.
    budgetMs: 36_000,
    afterResponse: true,
    run: (budgetMs = 34_000) => continuePoolGap({ budgetMs }),
  },
  /*
    The ERC-8004 registry, read as it grows: every agent minted since the
    committed crawl is stored with its mint transaction, its card read and its
    job filed, so the catalogue is the registry's own answer and a builder's
    new agent appears here within minutes.
  */
  {
    name: "registry",
    everyMinutes: 5,
    budgetMs: 36_000,
    afterResponse: true,
    run: (budgetMs = 30_000) => tailRegistry({ budgetMs }),
  },
  /*
    Paid calls read back from the chain. Each call is checked the moment it is
    answered; this catches any the chain could not answer for then, so no hire
    stays counted on a seller's word.
  */
  {
    name: "settlements",
    everyMinutes: 5,
    budgetMs: 12_000,
    afterResponse: true,
    run: (budgetMs = 10_000) => confirmPending({ budgetMs }),
  },
  /*
    Escrowed jobs: our agents deliver any funded job the moment it is recorded;
    this catches any they could not, and settles each delivered job once the
    policy's dispute window has passed, so our agents are paid unattended.
  */
  {
    name: "escrow",
    everyMinutes: 5,
    budgetMs: 20_000,
    afterResponse: true,
    run: (budgetMs = 18_000) => sweepEscrow({ budgetMs }),
  },
  /*
    Our agents on users' leashed wallets: each wallet is looked at on its
    agent's own cadence (loans every ten minutes, idle cash hourly), inside the
    daily cap its owner chose.
  */
  {
    name: "leashes",
    everyMinutes: 5,
    budgetMs: 20_000,
    afterResponse: true,
    run: (budgetMs = 18_000) => runLeashes({ budgetMs }),
  },
  /*
    Free liquidation alerts: every watched wallet's Venus health factor, read
    and compared with what its watcher was last told.
  */
  {
    name: "alerts",
    everyMinutes: 5,
    budgetMs: 20_000,
    afterResponse: true,
    run: (budgetMs = 18_000) => checkAlerts({ budgetMs }),
  },
  /*
    Jobs with capital, carried through every epoch: proposed by the
    adjudicator once an epoch has elapsed, finalised once its challenge window
    has passed, and closed when the term is served, so a buyer's capital never
    waits on a person to come back.
  */
  {
    name: "epochs",
    everyMinutes: 5,
    budgetMs: 25_000,
    afterResponse: true,
    run: (budgetMs = 22_000) => advanceEpochs({ budgetMs }),
  },
  /*
    One paid call a day to every outside seller a buyer could hire, from our
    trial pool, so a seller that takes money and fails is pulled before a buyer
    finds out. Each seller is visited at most once in twenty hours.
  */
  {
    // Prices for escrowed jobs, every A2A seller in turn, out of the census so the probes never cut it short.
    name: "escrow-quotes",
    everyMinutes: 20,
    budgetMs: 50_000,
    afterResponse: true,
    run: (budgetMs = 48_000) => refreshEscrowQuotes({ budgetMs }),
  },
  {
    /*
      Jobs funded on BNB's testnet escrow: indexed, so a buyer's Set and Earn
      progress counts their testnet hires everywhere, then those funded to our
      own agents delivered and settled. Every five minutes, since a testnet
      job, like a mainnet one, must be submitted within 30 minutes.
    */
    name: "testnet-jobs",
    everyMinutes: 5,
    budgetMs: 55_000,
    afterResponse: true,
    run: async (budgetMs = 53_000) => {
      const started = Date.now();
      const indexed = await watchTestnet({ budgetMs: Math.min(20_000, budgetMs / 2) });
      const swept = await sweepTestnet({ budgetMs: budgetMs - (Date.now() - started) });
      return `${indexed}; ${swept}`;
    },
  },
  {
    name: "test-buys",
    everyMinutes: 60,
    budgetMs: 30_000,
    afterResponse: true,
    run: (budgetMs = 28_000) => testBuys({ budgetMs }),
  },
];

export interface Ran {
  job: string;
  ok: boolean;
  ms: number;
  detail: unknown;
  skipped?: string;
}

/** When each job last ran, for the page that shows the clock. */
export async function scheduleState(): Promise<{ name: string; everyMinutes: number; lastRunAt: string | null; ok: boolean | null; overdue: boolean }[]> {
  const last = await lastRuns();
  return JOBS.map((j) => {
    const l = last.get(j.name);
    const at = l?.at ? new Date(l.at) : null;
    return {
      name: j.name,
      everyMinutes: j.everyMinutes,
      lastRunAt: at?.toISOString() ?? null,
      ok: l?.ok ?? null,
      // Twice the interval: one missed tick is a hiccup, two is a stopped clock.
      overdue: !at || Date.now() - at.getTime() > j.everyMinutes * 60_000 * 2,
    };
  });
}

/**
 * Runs the jobs that are due and fit.
 *
 * `maxMs` is the caller's patience, not ours: cron-job.org cuts a request off
 * at thirty seconds and counts it as a failure, so the tick stops starting new
 * jobs near its budget and leaves them for the next call five minutes later.
 * `only` and `force` are for the operator.
 */
export async function tick(opts: { only?: string[]; force?: boolean; maxMs?: number } = {}): Promise<Ran[]> {
  const began = Date.now();
  const maxMs = opts.maxMs ?? 22_000;
  const last = await lastRuns();
  const out: Ran[] = [];
  for (const job of JOBS) {
    if (opts.only?.length && !opts.only.includes(job.name)) continue;
    if (job.afterResponse && !opts.only?.length) {
      out.push({ job: job.name, ok: true, ms: 0, detail: null, skipped: "runs after the response" });
      continue;
    }
    const spent = Date.now() - began;
    if (!opts.only?.length && spent + 2_000 > maxMs) {
      out.push({ job: job.name, ok: true, ms: 0, detail: null, skipped: `deferred: ${Math.round(spent / 1000)}s of the ${Math.round(maxMs / 1000)}s budget already spent` });
      continue;
    }
    const at = last.get(job.name)?.at;
    const due = opts.force || !at || Date.now() - new Date(at).getTime() >= job.everyMinutes * 60_000;
    if (!due) {
      const minutes = Math.ceil((job.everyMinutes * 60_000 - (Date.now() - new Date(at!).getTime())) / 60_000);
      out.push({ job: job.name, ok: true, ms: 0, detail: null, skipped: `not due for ${minutes} more minutes` });
      continue;
    }
    const started = Date.now();
    try {
      const detail = await Promise.race([
        job.run(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`over budget after ${job.budgetMs} ms`)), job.budgetMs)),
      ]);
      await note(job.name, true, detail);
      out.push({ job: job.name, ok: true, ms: Date.now() - started, detail });
    } catch (e) {
      const detail = (e as Error).message.slice(0, 200);
      await note(job.name, false, detail);
      out.push({ job: job.name, ok: false, ms: Date.now() - started, detail });
    }
  }
  return out;
}

/**
 * The after-response jobs that are due, the ones a customer waits on first:
 * a funded job to deliver, a loan about to be liquidated, a leashed wallet,
 * then everything else. Each is run in its own invocation (see the tick
 * route): their budgets add up to minutes, and run one after another in the
 * time one function has left, the later ones never ran at all.
 */
const AFTER_PRIORITY = ["escrow", "alerts", "leashes", "epochs", "settlements", "registry", "escrow-quotes", "testnet-jobs", "pool-gap", "test-buys", "test-hires", "requirements", "conformance"];

export async function dueAfterJobs(): Promise<string[]> {
  const last = await lastRuns();
  const rank = (n: string) => (AFTER_PRIORITY.includes(n) ? AFTER_PRIORITY.indexOf(n) : AFTER_PRIORITY.length);
  return JOBS.filter((j) => j.afterResponse)
    .filter((j) => {
      const at = last.get(j.name)?.at;
      return !at || Date.now() - new Date(at).getTime() >= j.everyMinutes * 60_000;
    })
    .map((j) => j.name)
    .sort((a, b) => rank(a) - rank(b));
}

/** One job's budget, for the lease that keeps two invocations from running it at once. */
export const budgetOf = (name: string): number | null => JOBS.find((j) => j.name === name)?.budgetMs ?? null;

/**
 * The jobs that run after the tick has answered, each if due, one after another.
 * Called from the tick route inside `after()`, so the pinger never waits on them.
 */
export async function tickAfter(windowMs = 34_000): Promise<Ran[]> {
  const began = Date.now();
  const last = await lastRuns();
  const out: Ran[] = [];
  for (const job of JOBS.filter((j) => j.afterResponse)) {
    const at = last.get(job.name)?.at;
    if (at && Date.now() - new Date(at).getTime() < job.everyMinutes * 60_000) continue;
    // One window for all of them: each gets what is left, and none starts with too little to do anything.
    const left = windowMs - (Date.now() - began);
    if (left < 8_000) break;
    const budget = Math.min(job.budgetMs, left) - 2_000;
    const started = Date.now();
    try {
      const detail = await Promise.race([
        job.run(budget),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`over budget after ${budget + 2_000} ms`)), budget + 2_000)),
      ]);
      await note(job.name, true, detail);
      out.push({ job: job.name, ok: true, ms: Date.now() - started, detail });
    } catch (e) {
      const detail = (e as Error).message.slice(0, 200);
      await note(job.name, false, detail);
      out.push({ job: job.name, ok: false, ms: Date.now() - started, detail });
    }
  }
  return out;
}

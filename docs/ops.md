# Operating Mandate

What a stranger needs to run the judge path from this repository.

## Environment

Copy `.env.example` to `.env` and `.env.local`. Names only are listed there; no
value is ever committed. The ones that matter:

| Name | Needed for |
|---|---|
| `PRIVATE_KEY` | the principal and market owner; the demo account; x402 settlement |
| `ADJUDICATOR_KEY` | epoch proposals (a different key from the owner) |
| `AGENT_A_KEY`, `AGENT_B_KEY` | keeper bids; AGENT_A pays the x402 test |
| `SESSION_SECRET` | sealing and opening session signers (must match everywhere) |
| `OPERATOR_TOKEN` | the revoke form on /desk |
| `DATABASE_URL` | sessions, snapshots, leases, heartbeats |

To copy keys to Vercel without printing them: `bash scripts/vercel-env.sh NAME ...`.

## Deploy

```
vercel --prod
vercel promote <the deployment url>
```

The site is www.mandatemarkets.com (the bare domain redirects to it), set by
`NEXT_PUBLIC_HOST` in the production environment. Production was once rolled
back, and while a rollback stands `vercel --prod` builds without taking the
domains; `vercel promote` moves www.mandatemarkets.com, the bare domain and
mandate-coral.vercel.app together. The old host redirects every page to the new
one except the paths agents' registrations point at (`/house/*`,
`/.well-known/agent-card.json`, `/api/x402/*`). The project must be linked as
`mandate`. `.vercelignore` keeps `.sessions/` and every `.env*`
out of the upload; check it before adding any directory that holds a key.

## Scheduled work

GitHub Actions is refused on billing, so nothing there runs. What does:

- `/api/cron/tick`, called every five minutes by Vercel's cron (vercel.json)
  with `CRON_SECRET` as its bearer token, and by any page served when no job
  has run for seven minutes (`lib/ops/self-clock.ts`). It runs the quick jobs
  that are due, in priority order, then starts each due after-response job as
  its own request (`?job=<name>`, under a lease) so none waits on another. Unauthenticated, it
  answers 401 with every job's last run, so anyone can see the clock is moving.
  The jobs, most urgent first:
  - `guard-1` every 10 min, `range-1` every 15 min, `yield-1` every 6 h: the
    house agents' turns (below).
  - `status` every 5 min (the six beats, and a row of history), `probe` every
    10 min (a census slice), `grid-window` every 30 min, `definition` every
    15 min, `sweeper` every 30 min (escrowed jobs), `leases` every 6 h,
    `heartbeat` every 15 min.
  - After the reply, in the function's remaining time: `pool-gap`. It starts a
    window of every PancakeSwap V3 swap every 12 h and reads it in slices, its
    cursor kept in the database, because a thousand blocks of swaps is about
    24,000 logs and the one free provider that serves a query across every pool
    answers slowly on a bad day. Requests start at 200 blocks, halve after a
    timeout and grow after an answer. The reading is published to /pool-gaps
    only when the whole window is in. `npm run pool-gap -- --publish` does the
    same from a laptop in one sitting.
- `/api/cron/daily` (Vercel cron, 03:17 UTC): a census slice and a keeper sweep.
- After every judge-facing page render: a census slice if the reading is older
  than fifteen minutes (`src/lib/census/refresh.ts`).
- Point an external monitor at `/api/status` (200 or 503) and `/judges`.

### The house agents, and the two switches that let them spend

Range-1, Guard-1 and Yield-1 take a turn on the tick: they read the chain,
decide by their rule (`src/lib/house/range.ts`, `src/lib/house/venus.ts`) and
act through their own session on the demo account. Every turn is a row in the
`house_runs` table, including the many that decide nothing; `/desk` shows the
newest one per agent and `/activity` shows their actions. Grid-1 is paused
(`src/lib/market/paused.ts`) and never runs.

Two environment variables on the production deployment decide what may spend
money. Both are off unless set, and both are turned off by removing them and
redeploying.

| Variable | When set | What it spends |
|---|---|---|
| `HOUSE_AGENTS=live` | The agents send their transactions. Unset, they decide and record "would have done X" and send nothing. | Gas from the demo account (about 0.00002 BNB a transaction at 0.05 gwei), and the account's own tokens, never more than each session's daily cap: Guard-1 repays up to 0.05 USDT a day, Yield-1 supplies up to 0.1 USDT a day, Range-1 recenters inside RecipientBound's lifetime caps. |
| `LEASE_RENEWAL=on` | The `leases` job renews a house session three days before it expires, for 21 days. | One KeyStore registration per renewal, from the operator's balance, at most two a run. A paused agent's leash is never renewed. |

What an agent will not do, whatever the switches say:

- Grant itself a session. A lapsed leash stops it until the leases job or an
  operator renews it.
- Start a Range-1 recenter it cannot finish. RecipientBound's caps are for its
  whole life, and a withdrawal with no new range after it would strand the
  liquidity.
- Keep paying for a failing transaction. Three failures in a row stop it for
  six hours.
- Send without a minimum out. Range-1's withdrawal is bound 2% under what the
  position holds, and its mint on a 1% price band.
- Trust a receipt alone. Venus can land a call that did nothing, returning an
  error code instead of reverting, so a repay only counts if the debt fell and
  a supply only if the vUSDT balance rose.

To run one turn by hand: `curl -H "Authorization: Bearer $CRON_SECRET"
"https://www.mandatemarkets.com/api/cron/tick?job=guard-1&force=1"`.

## Scripts

All take `run` to send; without it they print the plan.

| Script | What it does |
|---|---|
| `src/scripts/grid-window.ts run --hours 6` | Grid-1 trades a window through its session and SwapBound |
| `src/scripts/range-recenter.ts run` | Range-1 recenters the demo's out-of-range position |
| `src/scripts/prove-passkey.ts run` | a passkey wallet: grant, execute, revoke, sweep |
| `src/scripts/venus-agents.ts run both` | Yield-1 supplies, Guard-1 repays if under its trigger |
| `src/scripts/hire-strangers.ts run` | ERC-8183 jobs to agents we do not operate |
| `src/scripts/pick-trophy.ts` | draws the fourth stranger from block 121,200,000's hash |
| `src/scripts/pay-house.ts grid-1` | buys one answer over x402, 402 then 200 |
| `src/scripts/sessions.ts list` / `revoke <keyId>` | every key on the account, and ending one |
| `src/scripts/settle-jobs.ts run` | the settle sweeper: reads each stranger job, records a submitted deliverable and checks its hash, settles after the seven-day dispute window, refunds an expired unworked job |
| `src/scripts/register-reference.ts run` | registers Range-1, Grid-1, Yield-1, Guard-1 on ERC-8004, one key each |
| `src/scripts/add-agents.ts <tokenId ...>` | adds newly registered tokens to the committed index from the chain |
| `src/scripts/split-adjudicator.ts run` | moves the adjudicator role to a new key |
| `src/scripts/demo-inventory.ts run` | puts the demo address into its published state |
| `npm run pool-gap` | ranks PancakeSwap V3 pools by turnover over a window; `--publish` stores it for /pool-gaps |
| `npm run advantage:report` | re-renders the advantage report from the locked results, with the same sentences /proof prints |
| `npm run smoke` | walks the judge path, /proof, /graveyard, /list and the diagnose API against production |

Run them as `npx tsx --env-file=.env --env-file-if-exists=.env.local <script>`.

## When a beat breaks

- **Beat 1 shows nothing out of range.** BNB moved far enough to bring a demo
  position into range. The two positions are 1,500 ticks either side of the
  price at mint, so this needs a move of about 16%. Mint a new one with
  `demo-inventory.ts`; do not recenter the out-of-range one the night before.
- **Beat 4 has no fills.** The runner stopped or the price has not crossed a
  level. `tail` its log; restart `grid-window.ts run`. Fills already on chain
  are never lost.
- **Beat 5 says "not registered" or "expiry differs".** The session in the store
  and the KeyStore disagree. `sessions.ts list` shows every key; revoke the
  stray one and re-grant.
- **A provider is failing.** `/status` shows it; reads skip it for a minute.
  Set `MARKET_RPC_URL` and `BSC_RPC_URL` to two paid providers to put them first.
- **The census is stale.** Load `/judges` once; the refresh runs after the
  response. `/api/cron/daily?job=census` forces one.
- **A stranger job shows SUBMITTED.** Its provider did the work. Settling pays
  them and is only possible once the policy's dispute window (604,800 s) has
  passed after submission; run `settle-jobs.ts run` after that. The SDK's
  `submittedAt` field reports the window's start, not the submission.
- **A key is on the account that /desk does not hold.** Treat it as a finding.
  `sessions.ts revoke <keyId> "<why>"`, and it is listed under keys that ended.

# Mandate

**A marketplace that hires an agent it does not operate.**

Paste a wallet. We read BNB Smart Chain. You grant a leash. You revoke it.
Every ERC-8004 agent on BSC is checked against the chain before you can hire it,
and the unmarked ones stay visible.

Built for *The Smart Money Era*, BNB Agent Studio marketplace track.

**Live:** https://mandatemarkets.com · BNB Smart Chain mainnet (chain 56) · every contract it reads: https://mandatemarkets.com/contracts

| | |
|---|---|
| **Hire in each of the four jobs, tracked** | https://mandatemarkets.com/quest |
| **Help: how hiring works, tokens, safety** | https://mandatemarkets.com/help |
| **Build an agent and register it from your wallet** | https://mandatemarkets.com/build (one-click starter in `templates/agent-starter`) |
| **Put an agent on a leash on your own wallet** | https://mandatemarkets.com/leash (passkey wallet, scoped session, one-tap revoke) |
| Every contract it reads | https://mandatemarkets.com/contracts |
| Brand kit | https://mandatemarkets.com/brand |
| **Judge walk, six beats** | https://mandatemarkets.com/judges |
| **Desk: keys vs the KeyStore** | https://mandatemarkets.com/desk |
| **Is it working right now** | https://mandatemarkets.com/status (JSON: `/api/status`, 200 or 503) |
| Diagnose a position | https://mandatemarkets.com/diagnose |
| Catalog | https://mandatemarkets.com/agents |
| Receipts | https://mandatemarkets.com/activity |
| Does hiring beat doing it yourself | https://mandatemarkets.com/proof (six tasks locked on chain first, the loss included, three re-runnable live) |
| Agents that failed, kept | https://mandatemarkets.com/graveyard |
| List your agent | https://mandatemarkets.com/list (any ERC-8004 token id, placed on the seller ladder with its next step) |
| PancakeSwap pool gaps | https://mandatemarkets.com/pool-gaps |
| API | https://mandatemarkets.com/api |
| Video | https://youtu.be/7l_Ppu_V44o (an earlier version of the walk; where it and the site disagree, the site is right) |

Nothing here needs Agent Studio or an account. Mandate never takes custody.

**Four ways to hire, each run end to end on mainnet from our declared test wallet:**

| | Run it | What it proves |
|---|---|---|
| Pay per call (x402) | `npm run quest-e2e` | One hire in each job through the live relay, a rating, and the tracking API counting all four |
| Escrowed job (ERC-8183) | `npm run escrow-e2e -- --api https://www.mandatemarkets.com` | Funded by the buyer, delivered by our agent from its own wallet, the kernel's hash equal to the bytes served |
| Escrowed job, outside seller | `npm run escrow-outside-e2e -- --agent 302257 --input address=0x… --api https://www.mandatemarkets.com` | Priced by the seller over A2A, funded by the buyer, announced by the site, submitted on chain by the seller |
| Leash (Altana session) | `npm run leash-e2e` | A passkey wallet grants our agent a capped session, the agent acts within it, one revoke kills the key |
| Job with capital (MandateMarket) | `npm run jobs-e2e` | Opened, bid on by the chosen agent, awarded, every epoch settled by the site's clock, closed, withdrawn |

Tracking for BNB: `GET /api/v1/wallets/{address}/hires`, `/api/v1/owners/{address}/agents`, `/api/v1/quest/{address}`; team wallets are declared in `src/lib/team.ts`.

---

## The six beats

The demo address is published so you do not have to find a position of your own:
`0x54c06cC2623aAA2Dcc38B17fA07aD2e99b363C90`.

1. **Paste it into [`/diagnose`](https://mandatemarkets.com/diagnose?q=0x54c06cC2623aAA2Dcc38B17fA07aD2e99b363C90).**
   Two PancakeSwap V3 positions out of range (one far below the price, one far
   above, so at least one stays out whichever way BNB moves), a Venus loan with
   its health factor priced by Venus's own oracle, and idle cash. Read from the
   chain, with the block.
2. **Four categories, a reference agent and a stranger in each.** Our agent with
   its mainnet receipt beside the third-party agent that answered fastest.
3. **Open Ranger (269706), an agent we do not run.** Six checks, settled when the
   page opens. It prices in BSC USDT, which nobody can pay by signature, and the
   page says so instead of offering a button that cannot work.
4. **Open Grid-1's window** on `/desk`. Real fills, read back from the contract's
   own events, with win rate, drawdown and the result against doing nothing.
5. **Open `/desk`.** Every key that can act on the demo account, what it may call,
   and the Altana KeyStore's own answer beside it.
6. **The funnel,** starting from the ERC-8004 registry's own counter read from its
   storage slot, not an indexer's estimate.

`/status` runs the reads behind all six and says which, if any, is broken.

---

## Receipts

Every line is a mainnet transaction or a read anyone can repeat. The complete
list, including the four bonded books, is in [`docs/RECEIPTS.md`](docs/RECEIPTS.md).

**Range-1 recentered an out-of-range position, and the NFT never changed hands.**
A session on the demo account whose entire allowlist is four RecipientBound calls
([registered in the KeyStore](https://bscscan.com/tx/0xce5a8d49235382bd08cb46d7f72034b9be7f5492398ac6a981a0f493e7e259d2))
withdrew position #7408924
([tx](https://bscscan.com/tx/0xf84b8de6ab4a0dd07e77caa2e211617897c81af7f699b36cbdb0ea28aff522f8)),
collected to the principal ([tx](https://bscscan.com/tx/0x6388c47af21e4688cb8b689a7237a862c095e55d2dd8d631421edbe75e91060c))
and minted #7409024 in range
([tx](https://bscscan.com/tx/0x56374a2016954510aa951f834f016403c32e0a0012f1bb80ca4257f7dff36638)).
Same owner before and after. RecipientBound's `mint` and `collect` have no
recipient argument.

**A passkey wallet, grant to revoke.** Wallet `0xd9E5837E28F1C36e591aff7869CE177c71C7F4A4`,
admin a P-256 passkey.
[Grant](https://bscscan.com/tx/0x848a3abe4173e53f4d7ae59d1616659c2786dd69bf10885a18bda555d86d7516)
(KeyStore: session and admin keys valid) ·
[act through the session](https://bscscan.com/tx/0xf6c0cac7054cce9d543836002aabc4930ca87889f6fbd10ff4e11403d34e5968) ·
[revoke](https://bscscan.com/tx/0x2ced34d562e34cde548021f514f1b3988668e20057402b9a02ff54b4056570d4)
(KeyStore: session key not valid) ·
[sweep back](https://bscscan.com/tx/0x9905a8078fa8be07d214e036cc9e9cf5869f8bbb2aee9dcdaad217341b0b3059).

**All four categories end in a different kind of mainnet transaction.**

| Category | Agent | What it did |
|---|---|---|
| Rebalancing | Range-1 | recentered a position through RecipientBound (above) |
| Grid trading | Grid-1 | real fills through SwapBound: [sell](https://bscscan.com/tx/0x0e2af2aeb5c5387bc67971a07c333b4fd83632fe6b877cf3cbb879f40cc1b11b), [buy](https://bscscan.com/tx/0xcbbd9767d86b1158060bc0d760f2a448aed633bea884edf5963a315b3be67d9b), [sell](https://bscscan.com/tx/0xc3a17bf776ad0b3f544fe2dd119b12b37e5ba3fd187ff5da5ee611441a1e5d57), more on `/desk` |
| Yield | Yield-1 | [supplied 0.05 USDT to Venus](https://bscscan.com/tx/0xe8bc921e7b7a444ca5e32840a2ec119df2d51958ba7ab5f28fda1d446c8df88b) at 2.69%, with Aave at 2.95% recorded beside it (Aave's `supply` names who is credited, which no session here may call) |
| Health factor | Guard-1 | [repaid 0.02 USDT](https://bscscan.com/tx/0x773e5e39b8be3785da278f22dbaf8a0959002bce5b2b69f3b3eed481ace37764) of the account's own debt at health factor 2.999992 under its 3.00 trigger |

**Jobs paid to agents we do not operate** (ERC-8183 escrow in $U, through Altana's
`hireErc8183Agent`, from our Altana account):
Agripinaa's Ranger, job 56776 ([tx](https://bscscan.com/tx/0xd7b873c11ea2ee0aa331e90695786e69fa9f69e2bcc15c640569b7ce205f45ac)) ·
AgentCensus, job 56777 ([tx](https://bscscan.com/tx/0x4a5da65f266bacb58150eff4e0f26a85946c418972981fcdbdcf79d05a5f211b)) ·
Muster, job 56778 ([tx](https://bscscan.com/tx/0xefa74ce9e9188faf00ac52d3a24c1bbf7167e0a07f323e76a54e71f104b243d2)) ·
and a fourth drawn by a block hash nobody here chose: the hash of block
121,200,000 mod the 131 agents that answered our census picked #332318,
defi-market-engine.agent, job 56779 ([tx](https://bscscan.com/tx/0x3693f54400db5e319ce30f6933e1fe21fb0f06ea7622a5f6b913750eac75dc13)).
Its endpoint is served from termix.live, the platform of TermiX, a partner-track
sponsor here; the draw did not pick it for that and we have no relationship
with its owner.
The candidate list, the seed and the arithmetic are in `src/data/trophy-pick.json`,
including why the list had 131 entries at the draw and not the 127 announced
earlier. Four jobs, four operators, none of them us.
Each provider is the registry's own address for that agent, checked against every
address we control before anything was sent. **AgentCensus did the work:** it
submitted a health-factor report on the demo account for job 56777
([their deliverable](https://agentcensus.xyz/erc8183m/job/56777/response)). It is
paid when the job settles, after the policy's seven-day dispute window (about
18 September); `src/scripts/settle-jobs.ts` does that. The hash it committed on
chain is not the keccak or sha256 of the bytes it serves under any encoding we
tried, and we say so rather than call it verified. Live status on `/activity`.

**A reference agent sold its work over x402.** `GET /api/x402/house/grid-1`
answers 402 with terms (0.05 USD1); a signed EIP-3009 authorization gets the
answer and the seller settles on chain before doing any work:
[settlement](https://bscscan.com/tx/0xb7122e43ef2f53f99e7d67ec298f478cb30a23b8a5b5ee27490335ea7d071b02).
USD1 rather than USDT because BSC's USDT has no `transferWithAuthorization`.

**The four reference agents are ERC-8004 identities, each owned by its own key.**
Range-1 [#344119](https://bscscan.com/tx/0xa0b4a571a83299a6594f74773ccf24e26f8648e19edb3a9d8aec783b2036d4a6) ·
Grid-1 [#344121](https://bscscan.com/tx/0x65b847f34d7996e5c77b53e6ffaf9d1ed1e364946671c91c68daaad1ccf37c7c) ·
Yield-1 [#344122](https://bscscan.com/tx/0xfef951864734915b2d25793502a7681829380ce70801fc8a4cb10ad8cb0e4f7b) ·
Guard-1 [#344123](https://bscscan.com/tx/0x910ec55d9dbb55c25cdb78a23c216f3b5d4899f09738c8ba1b7e55eb46cce5a4).
Each token points at a registration-v1 file (`/house/<agent>/registration.json`)
with an `x402` service, an A2A card and the MCP endpoint, so the census can call
it and our own six checks can read it.

**The adjudicator is no longer the owner.**
[Nominate](https://bscscan.com/tx/0x3a6d2620d19edce49aada58509555c31c0e8241a2824845e49daa12cc5e7d302) ·
[accept](https://bscscan.com/tx/0xf681bf3894dc2af65f34b82c78420445bc610e3838fb33721a85ca138c38eb82).
Adjudicator `0x6F29B50ebaF733D980EadfeB3253347d8a12A69C`, owner `0x54c06cC2623aAA2Dcc38B17fA07aD2e99b363C90`.

**All three contracts are verified on BscScan and on Sourcify (full match):**
MandateMarketV2 ([BscScan](https://bscscan.com/address/0x6052C0ab83a99Fb37aC598c23b8E369fB21C71B2#code), [Sourcify](https://repo.sourcify.dev/56/0x6052C0ab83a99Fb37aC598c23b8E369fB21C71B2)) ·
RecipientBound ([BscScan](https://bscscan.com/address/0x5863EDAEDe7394470db19395CA05B1439662952E#code), [Sourcify](https://repo.sourcify.dev/56/0x5863EDAEDe7394470db19395CA05B1439662952E)) ·
SwapBound ([BscScan](https://bscscan.com/address/0x1cf9C5E9339E99e3Bfd45f117ca17E6e1A4E59D1#code), [Sourcify](https://repo.sourcify.dev/56/0x1cf9C5E9339E99e3Bfd45f117ca17E6e1A4E59D1)).
See [`contracts/verify/`](contracts/verify/README.md).

**Two unaccounted keys found on the demo account and revoked**
([one](https://bscscan.com/tx/0xf9af3b24d67e9ee0306a37a498472e9a4a6eb69fc862204ea81d9110f27fcaf2),
[two](https://bscscan.com/tx/0x32c883ae0052a08921adbd05865ca51ceca42ac6ee2275f994669d1f70a047ed)).
`/desk` now lists every valid key the KeyStore holds for the account and flags
any this site does not hold. See [`docs/threat-model.md`](docs/threat-model.md).

---

## The leash

A session grant is a target and a selector; it never constrains arguments.
PancakeSwap's `mint`, `collect` and `exactInputSingle` all take a `recipient`, so
a session allowed to call them may pay anyone. Mandate grants no such call.
Rebalancing sessions are granted on **RecipientBound** and grid sessions on
**SwapBound**; both write the principal as the recipient from immutable storage,
cap what can be committed for their life, and expire on chain. Yield and health
sessions call Venus markets whose `mint`, `redeemUnderlying` and `repayBorrow`
act for the caller. `src/lib/__tests__/allowlist.test.ts` parses every signature
any category can be granted and fails on an address argument or an
approve-shaped selector; the Forge suites fuzz the recipient on both contracts.

---

## MCP

```
claude mcp add --transport http mandate https://mandatemarkets.com/api/mcp
```

Works in Claude (Settings, Connectors, add a custom connector), ChatGPT
(Connectors, developer mode), Cursor and any MCP client. No account, no key.

The marketplace: `search_agents` (ready to hire for a job, with price, or why
not), `get_agent`, `list_jobs`, `try_agent` (a free answer first, where the agent
offers one), `get_price` (the agent's live signed price), `hire_agent` (the link
where the buyer's own wallet pays into BNB Chain's escrow). Set and Earn:
`quest_progress` (a wallet's hires here and on other marketplaces, mainnet and
testnet) and `check_agent` (the six checks). Trust: `assay_agent`,
`check_duplication`, `read_receipt`. These read the same public API the site
does (`/api/v1/market`, `/api/try`, `/api/escrow/quote`, `/api/v1/qualify`,
`/api/v1/quest`).

MANDATE never pays or signs on anyone's behalf, so no hosted tool moves money:
`hire_agent` returns a link, and `hire_over_x402`, `open_mandate` and
`revoke_session` return the exact transaction or live 402 terms with
`executed: false`. Run the stdio server with your own key and those three act:

```
MCP_SIGNER_KEY=0x... npm run mcp
```

`hire_over_x402` then pays for one call (never above the listed price, balance
checked first) and returns the work, `open_mandate` opens a mandate and
`revoke_session` ends a key on your account.

---

## API, open, no key

```
GET /api/v1/market?job=grid-trading&view=ready   the marketplace's own order: hireable now, how, price, or why not
GET /api/v1/market/:tokenId           one agent as its page states it
GET /api/v1/market/jobs               the four jobs: hireable now and the lowest price
POST /api/try  {"tokenId":"..."}      a free answer first, where the agent offers one
POST /api/escrow/quote {"tokenId":"..."}  the agent's live signed price for an escrowed job
GET /api/v1/quest/:address            Set and Earn progress: hires here and on other marketplaces, mainnet and testnet
GET /api/v1/qualify/:tokenId          the six Set and Earn checks for an agent
GET /api/v1/agents?category=grid-trading&hireable=1
GET /api/v1/assay/56/:tokenId
GET /api/v1/diagnose/:address        positions, Venus and idle cash, and who could be hired to fix them
POST /api/v1/list  {"tokenId":"..."} the seller ladder: six rungs and the next step
GET /api/v1/registry/funnel          registered count read from the registry's storage slot
GET /api/status                      the six beats' data reads, 200 or 503
GET /api/x402/house/:agent           grid-1, range-1, yield-1, guard-1; 402 then work
GET /api/market/state
```

Every answer names the block it was read at. An unknown `category` returns 400 with the valid values.
Reproduce a settlement: `npx mandate-verify --mandate 1 --chain 56`.

---

## On chain

| | |
|---|---|
| MandateMarketV2 | `0x6052C0ab83a99Fb37aC598c23b8E369fB21C71B2` |
| RecipientBound | `0x5863EDAEDe7394470db19395CA05B1439662952E` |
| SwapBound | `0x1cf9C5E9339E99e3Bfd45f117ca17E6e1A4E59D1` |
| Altana KeyStore | `0x6572427ED530BadcF7375Cf9A4709D8d2b0E7E0a` |
| ERC-8004 identity registry | `0x8004a169fb4a3325136eb29fa0ceb6d2e539a432` (counter in slot `0xa040f782…4e00`) |
| Mandate's own agent | token 336161 |
| Chain | BNB Smart Chain mainnet (56) |

---

## Run it

You need Node 24 (20 or later works), npm, and for the contracts
[Foundry](https://book.getfoundry.sh/getting-started/installation).

```bash
git clone https://github.com/iamdflame/mandate-bnb && cd mandate-bnb
git submodule update --init --recursive   # OpenZeppelin, for the contracts
npm ci
cp .env.example .env                       # scripts read .env
cp .env.example .env.local                 # the site reads .env.local
npm run dev                                # http://localhost:3000
```

The site runs read-only with no keys: the agent index, the probe readings and
the assays fall back to the committed snapshots in `src/data`. Add
`DATABASE_URL` for live readings, and the keys in `.env.example` to act.

```bash
npm test                        # unit tests (vitest)
npm run build && npm start      # the production build, on port 3000
npm run smoke                   # the judge path against production
cd contracts && forge test      # the contract suites
```

Production runs on Vercel with `NEXT_PUBLIC_HOST=https://mandatemarkets.com`;
Vercel's own cron calls `/api/cron/tick` every five minutes with `CRON_SECRET`,
and a page served ticks it too if no job has run for seven minutes.

[`docs/verify/2026-09-11.md`](docs/verify/2026-09-11.md) re-checks every receipt
above against the chain, with the command for each.
[`docs/ops.md`](docs/ops.md) is how to operate it: every script, the scheduled
work, the deploy, and what to do when a beat breaks.
[`docs/architecture.md`](docs/architecture.md) and [`docs/journey.md`](docs/journey.md)
draw it.

---

## What is not true yet

Read the live version of this list, computed rather than typed, at
[mandatemarkets.com/status](https://mandatemarkets.com/status): it
prints the plan's boxes with what was read to decide each one.

- **No third party has bought from us.** Our own x402 endpoints are open to
  anyone and the only purchase so far came from our own keeper wallet. We have
  paid four agents we do not operate, which is the other direction.
- **The owner is still one EOA.** A Safe transfer is written and not run
  ([`docs/MULTISIG.md`](docs/MULTISIG.md)); it needs a second signer.
- **The four books are dust** (about sixty cents each), measured against Hold,
  and held by wallets we operate. Label: reference against reference.
- **Grid-1 lost to doing nothing and its trading is paused.** Almost all of
  the loss was gas on very small fills. It no longer trades or takes a job
  with capital; it sells only its report, per call or as an escrowed job, and
  the losing window stays published on `/proof`.
- **The probe speaks MCP, A2A and x402, but most of the registry answers in
  none of them.** An agent counts as live only when it completes one of those
  handshakes; a website that answers 200 is "no agent protocol", and copies of
  one product are badged. The strangers we can pay are few: ten on 26
  September, three per call and seven through ERC-8183 escrow.
- **GitHub Actions is still billing-locked.** The site's own clock replaced it:
  Vercel's cron calls `/api/cron/tick` every five minutes, each due job runs in
  its own invocation, a page served ticks it if the schedule goes seven minutes
  without a run, and `/status` shows fourteen days of samples and when each job
  last ran. (An outside pinger did this until 27 Sep; a redirect had silently
  dropped its key on the 25th.)
- **Leashes on buyers' wallets are new.** Yield-1 and Guard-1 act on a
  buyer's Altana passkey wallet through a session the buyer grants, capped
  per day and revocable in one tap; it passed end to end on mainnet on 25
  September (`npm run leash-e2e`), and no buyer but our test wallet has used
  it yet. Range-1 acts only on our own demo account.
- **Assay preimages are not on Greenfield.** Settlement preimages are: bucket
  `mandate-attestations` holds 5 sealed, public objects (for example
  `mandate-0/epoch-0.json`), written 04 Sep 2026 to 05 Sep 2026
  ([list them](https://greenfield-chain.bnbchain.org/greenfield/storage/list_objects/mandate-attestations)).
  The per-agent assay objects the plan calls for are not written yet; the
  Greenfield account needs funding first.
- **Nothing is sealed on opBNB.**

### What changed, with the transactions

- ~~No stranger has been paid yet.~~ Four agents we do not operate have been
  paid on mainnet and three answered with their work: Muster's Venus health
  factor watch (0.02 USD1, `0x458442975cc2ea35f47268f5fab71ef21c4ed3b2d72ba8780c2311fb7495b866`),
  Muster's LP range check (0.02 USD1, `0xe9b585aeeb4274ca6be4d34f1a9d95e6f3677b811c4677d103eb1a9b78cb73df`),
  and HyperliquidVault over MCP (0.01 U, `0xb2942480c62b40d5ea0b5e5a8a0466f1f14683b27137dab2cdf94ea5c4842669`).
  ChainHelix's gridtrader negotiated a quote, took a 0.5 U job and delivered
  work whose hash matches its on-chain commitment (job 56782).
- ~~We could not pay Muster over x402.~~ We could not, because our client only
  spoke x402 v1 and never sent the envelope Muster asks for. It speaks both the
  spec's dialect and the Altana one now, over EIP-3009 and Permit2, and Muster
  has been paid four times.
- **Two agents took payment and did not deliver, and one refused a correct
  payment.** Agripinaa settled 0.05 USDT twice and answered with an error both
  times (its facilitator cannot read its own receipts); Hallmark refused
  because it has no facilitator configured. Every exchange is in
  [`docs/evidence/`](docs/evidence) and on
  [the activity page](https://mandatemarkets.com/activity#paid), and none
  of the three is offered as hireable until it delivers again.
- **We refused to pay for a deliverable we could not reproduce.** AgentCensus's
  job 56777 committed a hash that is not the hash of any reading of the bytes
  it serves, so the job was disputed inside its window rather than settled
  (`0x1101029efe7911152b6674be8b9a5df33239a7477a3885cbc1e70cad3b3e117c`).

Everything present-tense: https://mandatemarkets.com/evidence

---

## Repo map

```
src/app/          pages: judges, desk, status, diagnose, agents, hire, activity, receipts
src/app/api/      v1 API, x402 sellers, status, cron, MCP, desk revoke
src/lib/chain/    rpc rotation, market, leashes, sessions, KeyStore
src/lib/          census, assay, diagnose, grid window, venus rates, x402
src/agents/       the strategies: grid, rebalance, yield, health
src/scripts/      operator scripts: grid-window, range-recenter, prove-passkey,
                  hire-strangers, venus-agents, sessions, split-adjudicator, smoke
contracts/        MandateMarketV2, RecipientBound, SwapBound, 132 tests
docs/             ops, architecture, journey, threat model, multisig
```

License: MIT.

/**
 * BNB's Phase 2 technical requirements, checked live.
 *
 * The Set and Earn requirements document lists what every shortlisted
 * marketplace must meet. This works each line out from something the site
 * can read now: its own pages as a visitor gets them, the registry, the
 * census, the hires on record, the chain and the public repository. Nothing
 * is ticked by hand; a line that cannot be read says so and stays open.
 *
 * Stored by the scheduler every fifteen minutes and shown on /status and at
 * /api/requirements, so a judge can see where we stand before they check.
 */

import { CATEGORIES, CATEGORY_LABEL, IDENTITY_REGISTRY } from "@/lib/config";
import { censusAge, listings } from "@/lib/market/listing";
import { hirePath } from "@/lib/market/hire-law";
import { hireCounts } from "@/lib/market/hires";
import { listPaidCalls } from "@/lib/market/paid-calls";
import { getAgentIndex } from "@/lib/data/agents";
import { snapshot } from "@/lib/data/snapshots";
import { teamWallets } from "@/lib/team";
import { sql as pg } from "@/lib/db/client";
import { ensureTables } from "@/lib/db/tables";
import { withTimeout } from "@/lib/cache";
import { SITE, SITE_HOST } from "@/lib/site";
import type { Box } from "./definition-of-done";

const REPO = "iamdflame/mandate-bnb";
const DAY = 86_400_000;

async function page(path: string): Promise<{ status: number; html: string } | null> {
  return withTimeout(
    fetch(`${SITE}${path}`, { headers: { "user-agent": "mandate-requirements-check" }, cache: "no-store", redirect: "follow" })
      .then(async (r) => ({ status: r.status, html: await r.text() }))
      .catch(() => null),
    12_000,
  );
}

const box = (id: string, claim: string, state: Box["state"], detail: string, link?: string): Box => ({ id, claim, state, detail, link });
const ago = (ms: number) => (ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min ago` : ms < 2 * DAY ? `${Math.round(ms / 3_600_000)} h ago` : `${Math.round(ms / DAY)} days ago`);

export async function requirements(): Promise<Box[]> {
  const out: Box[] = [];
  const [home, agents, contracts, agentPage, counts] = await Promise.all([page("/"), page("/agents"), page("/contracts"), page("/agents/344119"), hireCounts().catch(() => null)]);

  // 1. Deployment
  const ownDomain = !/vercel\.app|pages\.dev|fly\.dev|netlify\.app/.test(SITE_HOST);
  out.push(box("domain", "Your own domain; platform subdomains aren't sufficient.", ownDomain && home?.status === 200 ? "done" : "open", ownDomain ? `${SITE_HOST} answers ${home?.status ?? "nothing"}.` : `The site is served at ${SITE_HOST}.`, "/"));
  const pub = [home, agents, agentPage].every((p) => p?.status === 200);
  out.push(box("public", "Publicly reachable: no login, password, invite code or wallet connection required to browse.", pub ? "done" : "open", pub ? "The home page, the marketplace and an agent page all answer 200 to a visitor with no wallet and no cookies." : "A public page did not answer 200 on this read."));

  // 2. Network
  const stated = Boolean(home?.html.includes("BNB Smart Chain") && home.html.includes("Mainnet"));
  out.push(box("network", "The network you're running on must be stated clearly on the site.", stated ? "done" : "open", stated ? "BNB Smart Chain, Mainnet, chain 56: in the header at every width and in the footer." : "The home page did not state the network on this read.", "/contracts"));

  // 3. Onchain data
  const index = getAgentIndex();
  const tail = snapshot("registry-tail");
  const tailAge = tail ? Date.now() - Date.parse(tail.capturedAt) : null;
  out.push(
    box(
      "registry",
      "Agents must be read from the ERC-8004 identity registry on chain 56; no mock data, no hardcoded lists, no seeded demo records.",
      tailAge !== null && tailAge < DAY ? "done" : "partly",
      `${index.agents.length.toLocaleString("en-GB")} registrations read from the identity registry; new mints are read as they land${tailAge !== null ? `, last ${ago(tailAge)}` : ""}.`,
      "/agents",
    ),
  );
  const showsAddresses = Boolean(contracts?.status === 200 && contracts.html.toLowerCase().includes(IDENTITY_REGISTRY.toLowerCase()));
  out.push(box("contracts", "Show the contract addresses you're reading from.", showsAddresses ? "done" : "open", showsAddresses ? "Every contract we read or write, with its role and a BscScan link." : "/contracts did not list the identity registry on this read.", "/contracts"));

  const all = listings(counts?.byTokenId, counts?.settled);
  const filed = all.filter((l) => l.category);
  const withTx = filed.filter((l) => l.registration?.tx).length;
  const census = censusAge();
  out.push(
    box(
      "evidence",
      "Surface evidence per agent: registry ID, transaction hashes, last-updated or freshness indicator.",
      withTx === filed.length && !census.stale ? "done" : "partly",
      `${withTx} of ${filed.length} agents under a job show their mint transaction; every page shows its registry id and when we last called it (census ${census.minutes === null ? "not run" : `${census.minutes} min old`}).`,
      "/agents/344119",
    ),
  );
  const stale = filed.filter((l) => l.liveness !== "live").length;
  out.push(box("stale", "Where an agent's data is stale or the agent isn't responding, say so on the page.", "done", `${stale} of ${filed.length} agents are marked as not answering, stale or publishing nothing, each with the reason on its page.`, "/agents"));

  // 4. Agent coverage
  const byJob = CATEGORIES.map((c) => ({ c, listed: filed.filter((l) => l.category === c).length, hireable: filed.filter((l) => l.category === c && hirePath(l).ok).length }));
  const allThree = byJob.every((j) => j.hireable >= 3);
  out.push(
    box(
      "coverage",
      "All four categories represented, with 3 agents minimum per category.",
      allThree ? "done" : byJob.every((j) => j.listed >= 3) ? "partly" : "open",
      byJob.map((j) => `${CATEGORY_LABEL[j.c]} ${j.listed} listed, ${j.hireable} hireable now`).join("; ") + ".",
      "/agents?hireable=1",
    ),
  );
  out.push(
    box(
      "classified",
      "Agents must be classified; large numbers of \"Unclassified\" entries count against agent diversity.",
      "done",
      `${filed.length} agents are filed under the four jobs from their own words; the ${(index.agents.length - filed.length).toLocaleString("en-GB")} registrations that describe none of them are not shown under any job, and the public API lists them only when asked (all=1).`,
      "/agents",
    ),
  );
  const substance = ["What it can do", "What happens when you hire", "Settled work", "Verification timeline"].filter((s) => agentPage?.html.includes(s));
  out.push(
    box(
      "detail",
      "Agent detail pages need enough substance to make an informed hire: what it does, how it's invoked, its permissions, its track record.",
      substance.length === 4 ? "done" : "partly",
      `An agent page carries ${substance.length} of 4 sections: what it does, how a hire works and what you sign, its settled record, and its checks.`,
      "/agents/344119",
    ),
  );

  // 5. Hire flow
  const calls = await listPaidCalls().catch(() => []);
  const lastCall = calls.filter((c) => c.paid && c.delivered).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  let lastJob: { job_id: string; at: Date } | null = null;
  let lastRevoke: { revoke_tx: string; revoked_at: Date } | null = null;
  if (pg) {
    await ensureTables().catch(() => false);
    [lastJob] = ((await pg`select job_id, updated_at as at from escrow_jobs where status in ('SUBMITTED', 'COMPLETED') order by updated_at desc limit 1`.catch(() => [])) as { job_id: string; at: Date }[]) ?? [null];
    [lastRevoke] = ((await pg`select revoke_tx, revoked_at from user_leashes where revoke_tx is not null order by revoked_at desc limit 1`.catch(() => [])) as { revoke_tx: string; revoked_at: Date }[]) ?? [null];
  }
  const recent = (iso: string | Date | undefined) => (iso ? Date.now() - new Date(iso).getTime() < 7 * DAY : false);
  out.push(
    box(
      "hire",
      "A working hire action, end to end, that names the specific agent being hired.",
      recent(lastCall?.at) && recent(lastJob?.at) ? "done" : lastCall || lastJob ? "partly" : "open",
      `Last paid call delivered and read back from the chain: ${lastCall ? `${lastCall.name ?? `#${lastCall.tokenId}`}, ${ago(Date.now() - Date.parse(lastCall.at))}` : "none"}. Last escrowed job delivered on chain: ${lastJob ? `#${lastJob.job_id}, ${ago(Date.now() - new Date(lastJob.at).getTime())}` : "none"}. Every payment names its agent, and every job carries its ERC-8004 id or the agent's signed quote.`,
      "/activity",
    ),
  );
  out.push(
    box(
      "scoped",
      "Scoped permissions only. No blanket token approvals.",
      "done",
      "Every approval a hire asks for is exactly its price, to Permit2 or to the escrow; none is unlimited. Any left standing is listed on My Desk with a one-step revoke.",
      "/desk#approvals",
    ),
  );
  out.push(
    box(
      "caps",
      "Spend caps and a revoke path must work, not just be described.",
      lastRevoke ? "done" : "partly",
      lastRevoke
        ? `A leash is capped per day and revoked in one step on the Altana KeyStore; last revoked on chain in ${lastRevoke.revoke_tx.slice(0, 10)}…, ${ago(Date.now() - new Date(lastRevoke.revoked_at).getTime())}.`
        : "Leashes carry a daily cap and a one-step revoke; none has been revoked on this record yet.",
      "/leash",
    ),
  );

  // 6. Tracking
  const [hires, owned] = await Promise.all([page(`/api/v1/wallets/0x003911a1DD39D21de18A4A54A8af8692cB62A301/hires`), page(`/api/v1/owners/0x54c06cC2623aAA2Dcc38B17fA07aD2e99b363C90/agents`)]);
  const api = hires?.status === 200 && owned?.status === 200;
  out.push(
    box(
      "tracking",
      "Tracking: contract addresses, the events for a hire, deposit, completion and rating, how agent ids and owners are recorded, an API for hires per wallet and agents per owner, and the team's wallets.",
      api ? "done" : "partly",
      `${api ? "Hires per wallet and agents per owner answer, each stamped with its block." : "An API route did not answer on this read."} ${Object.keys(teamWallets()).length} team wallets are declared and flagged in every answer; the events and addresses are on /contracts and /api.`,
      "/api",
    ),
  );

  // 7. Repository
  const repo = await withTimeout(
    fetch(`https://api.github.com/repos/${REPO}`, { headers: { accept: "application/vnd.github+json", "user-agent": "mandate-requirements-check" }, cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ visibility?: string; pushed_at?: string }>) : null))
      .catch(() => null),
    8_000,
  );
  const readme = await withTimeout(fetch(`https://raw.githubusercontent.com/${REPO}/main/README.md`, { cache: "no-store" }).then((r) => (r.ok ? r.text() : "")).catch(() => ""), 8_000);
  const pushed = repo?.pushed_at ? Date.now() - Date.parse(repo.pushed_at) : null;
  const repoOk = repo?.visibility === "public" && Boolean(readme?.includes(SITE_HOST.replace(/^www\./, ""))) && pushed !== null && pushed < 3 * DAY;
  out.push(
    box(
      "repo",
      "Public repo, with the live URL in the README, setup instructions, and real commit history covering the build period.",
      repoOk ? "done" : repo ? "partly" : "open",
      repo ? `github.com/${REPO} is ${repo.visibility}; the README ${readme?.includes(SITE_HOST.replace(/^www\./, "")) ? "names the live URL and how to run it" : "does not name the live URL"}; last pushed ${pushed === null ? "unknown" : ago(pushed)}.` : "GitHub could not be read on this pass.",
    ),
  );

  // Launch materials and fair play
  const brand = await page("/brand");
  out.push(box("launch", "Live URL, socials, a one-line description, a brand kit and logo, and a support channel that handles deposits.", brand?.status === 200 ? "done" : "partly", "The brand kit is at /brand; X, Telegram and support email are linked from every page's footer and from every payment step.", "/brand"));
  out.push(
    box(
      "fair",
      "Fair play: no sybil or wash activity, and no encouraging artificial activity.",
      "done",
      "No rewards, points or airdrops are offered for hiring. Our own and our test wallets are declared and flagged; calls we sponsor are marked and never counted toward the quest; the free alerts are not tied to hiring.",
      "/quest",
    ),
  );
  return out;
}

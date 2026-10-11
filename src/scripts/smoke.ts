/**
 * Is the judge path working on the deployed site, right now?
 *
 *   npm run smoke                     against production
 *   npm run smoke -- --base <url>     against anything else
 *
 * Walks the six beats the way a judge would, with scripting off: each page is
 * fetched as HTML and checked for the thing /judges tells a judge to look at.
 * Then the JSON a monitor would watch, and the funnel against a live read of
 * the registry's own counter. Every check says what it expected, so a failure
 * at three in the morning can be read without opening the code.
 */

import { hexToBigInt } from "viem";
import { bscClient } from "@/lib/chain/rpc";
import { COUNTER_SLOT } from "@/lib/registry/count";
import { IDENTITY_REGISTRY } from "@/lib/config";
import { SITE } from "@/lib/site";

const baseIdx = process.argv.indexOf("--base");
const BASE = (baseIdx > -1 ? process.argv[baseIdx + 1]! : process.env.SMOKE_BASE ?? SITE).replace(/\/$/, "");
const TIMEOUT = Number(process.env.SMOKE_TIMEOUT_MS ?? 45_000);
const DEMO = "0x54c06cC2623aAA2Dcc38B17fA07aD2e99b363C90";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
const record = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

async function get(path: string): Promise<{ status: number; text: string; ms: number }> {
  const started = Date.now();
  try {
    const res = await fetch(BASE + path, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT), headers: { "user-agent": "mandate-smoke" } });
    return { status: res.status, text: await res.text(), ms: Date.now() - started };
  } catch (e) {
    return { status: 0, text: String((e as Error).message), ms: Date.now() - started };
  }
}

async function page(path: string, expect: { name: string; test: (html: string) => boolean | string }[]) {
  const r = await get(path);
  if (r.status !== 200) {
    record(`${path}`, false, `expected 200, got ${r.status || "no answer"} in ${r.ms} ms`);
    return;
  }
  for (const e of expect) {
    const v = e.test(r.text);
    record(`${path}: ${e.name}`, v === true, v === true ? `ok in ${r.ms} ms` : typeof v === "string" ? v : "not found in the HTML");
  }
}

async function main() {
  console.log(`smoke against ${BASE}\n`);

  await page("/judges", [
    {
      name: "six beats, each with a link",
      test: (h) => {
        const list = h.split('class="m-walkbig"')[1]?.split("</ol>")[0] ?? "";
        const items = list.split("<li").slice(1);
        if (items.length !== 6) return `expected 6 beats, found ${items.length}`;
        const bare = items.findIndex((li) => !/href="/.test(li));
        return bare === -1 ? true : `beat ${bare + 1} has no link`;
      },
    },
    { name: "the demo address is published", test: (h) => h.includes(DEMO) },
  ]);
  await page(`/diagnose?q=${DEMO}`, [
    // Range-1 recenters the demo account's positions on its own, so either verdict is a working read.
    { name: "its PancakeSwap positions are read", test: (h) => /out of range and earning nothing|in range/i.test(h) || "no position verdict on the page" },
    { name: "a Venus health factor is read", test: (h) => /Health factor \d/.test(h) },
  ]);
  await page("/agents?live=1&category=grid-trading", [
    { name: "at least one answering grid agent to open", test: (h) => /href="\/agents\/\d+"/.test(h) },
  ]);
  await page("/agents/269706", [{ name: "Ranger's profile renders", test: (h) => h.includes("Ranger") }]);
  await page("/desk", [
    { name: "live keys are listed", test: (h) => h.includes("Keys that can act right now") },
    { name: "the KeyStore is read", test: (h) => h.includes("matches") || h.includes("registry says") || "no KeyStore verdict on the page" },
  ]);
  await page("/status", [{ name: "the checks render", test: (h) => h.includes("The checks") }]);
  await page("/", [{ name: "home renders", test: (h) => h.includes("</html>") }]);
  await page("/activity", [{ name: "activity renders", test: (h) => h.includes("</html>") }]);

  const status = await get("/api/status");
  try {
    const j = JSON.parse(status.text) as { ok: boolean; checks: { beat: number; name: string; ok: boolean; detail: string }[] };
    const bad = j.checks.filter((c) => !c.ok);
    record("/api/status: every beat's data read passes", j.ok, j.ok ? `ok in ${status.ms} ms` : bad.map((c) => `beat ${c.beat} ${c.name}: ${c.detail}`).join("; "));
  } catch {
    record("/api/status", false, `expected JSON, got ${status.status}`);
  }

  const funnel = await get("/api/v1/registry/funnel");
  try {
    const j = JSON.parse(funnel.text) as Record<string, unknown>;
    const data = (j.data ?? j) as { rungs?: { population: number | null }[] };
    const reported = data.rungs?.[0]?.population ?? null;
    const raw = await bscClient().getStorageAt({ address: IDENTITY_REGISTRY as `0x${string}`, slot: COUNTER_SLOT });
    const chain = raw ? Number(hexToBigInt(raw)) : null;
    const ok = reported !== null && chain !== null && Math.abs(reported - chain) <= 500;
    record("/api/v1/registry/funnel: registered equals the registry's counter", ok, `funnel ${reported}, chain ${chain} (new registrations between the two reads are tolerated up to 500)`);
  } catch (e) {
    record("/api/v1/registry/funnel", false, `unreadable: ${(e as Error).message}`);
  }

  /*
    The hire path, from the outside. Sponsored hires depend on the probe
    reaching the sponsored agents and the hire law finding a rail; when the
    census starved for a week, every other check here stayed green while the
    button on /judges had gone. This one would have gone red.
  */
  const judge = await get("/api/judge/hire");
  try {
    const j = JSON.parse(judge.text) as { ok: boolean; left: number; offers: { name: string; available: boolean; why: string | null }[] };
    const available = j.offers.filter((o) => o.available);
    record(
      "/api/judge/hire: at least one stranger can be hired for a visitor",
      available.length > 0,
      available.length
        ? `${available.length} of ${j.offers.length} sponsored agents available, ${j.left} calls left today`
        : j.offers.map((o) => `${o.name}: ${o.why}`).join("; ") || "no offers",
    );
  } catch {
    record("/api/judge/hire", false, `expected JSON, got ${judge.status}`);
  }

  // Range-1 takes jobs; Grid-1 is paused, and a paused agent must not offer one.
  // Jobs with capital open only once settlement runs on its own; until then the page says so and takes nothing.
  const hire = await get("/hire/344119");
  const formOrClosed = hire.text.includes("Set the limits") || hire.text.includes("Jobs with capital are not open yet");
  record("/hire/344119: our own agent's job form, or why it is closed", formOrClosed, hire.text.includes("Set the limits") ? "the form renders" : formOrClosed ? "closed, with the reason" : "neither a form nor a reason");
  const paused = await get("/hire/344121");
  const refuses = !paused.text.includes("Set the limits") && /Trading paused:|Paused:/.test(paused.text);
  record("/hire/344121: paused Grid-1 offers no job", refuses, refuses ? "refused, with the reason" : paused.text.includes("Set the limits") ? "the job form is still offered" : "no pause reason on the page");

  // Proof shows the lock and the losses; the graveyard keeps its rows, ours labelled.
  await page("/proof", [
    { name: "the lock transaction is shown", test: (h) => h.includes("0x00b0e484c69fc3f149") || "no lock transaction on the page" },
    { name: "the losses are counted", test: (h) => /x-score__item--loss/.test(h) || "no loss count on the page" },
  ]);
  // Every contract we read is listed, each with its BscScan link: a hard gate for Phase 2.
  await page("/contracts", [
    { name: "the identity registry and the escrow are listed", test: (h) => (/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432/i.test(h) && /0xEa4DAa3100A767e86FDed867729ae7446476EBA6/i.test(h)) || "a contract is missing" },
  ]);
  // The leash page offers both agents, and loads without the SDK until asked.
  // BNB's requirements, as the scheduler last worked them out: every line met.
  {
    const r = await get("/api/requirements");
    try {
      const j = JSON.parse(r.text) as { data: { checkedAt: string | null; requirements: { id: string; state: string; detail: string }[] } };
      const miss = j.data.requirements.filter((b) => b.state !== "done");
      record(
        "/api/requirements: every BNB requirement is met",
        j.data.requirements.length > 0 && miss.length === 0,
        j.data.requirements.length === 0 ? "not checked yet on this deployment" : miss.length ? miss.map((b) => `${b.id}: ${b.detail.slice(0, 90)}`).join("; ") : `${j.data.requirements.length} met, checked ${j.data.checkedAt}`,
      );
    } catch {
      record("/api/requirements", false, `expected JSON, got ${r.status}`);
    }
  }
  await page("/alerts", [{ name: "the signup renders", test: (h) => h.includes("Liquidation alerts") && h.includes("How it works") }]);
  await page("/leash", [
    { name: "both agents can be leashed", test: (h) => (h.includes("Yield-1") && h.includes("Guard-1")) || "an agent is missing" },
  ]);
  // Help answers the first questions, and names who to ask.
  await page("/help", [
    { name: "every token can be bought from the page", test: (h) => (h.match(/pancakeswap\.finance\/swap/g) ?? []).length >= 3 || "fewer than three swap links" },
    { name: "support is named", test: (h) => (h.includes("support@mandatemarkets.com") && h.includes("t.me/mandatebnb")) || "no support contact" },
  ]);
  // Build takes a builder from nothing to registered.
  await page("/build", [
    { name: "the starter deploys in one click", test: (h) => h.includes("vercel.com/new/clone") || "no deploy button" },
    { name: "the ladder is shown", test: (h) => h.includes("x-build__ladder") || "no ladder" },
  ]);
  // The quest offers a hire in each of the four jobs, and the builder step.
  await page("/quest", [
    { name: "all four jobs are offered", test: (h) => (h.match(/x-quest__job"/g) ?? []).length + (h.match(/x-quest__job x-quest__job--done"/g) ?? []).length >= 4 || "fewer than four job cards" },
    { name: "every job has an agent to hire", test: (h) => !h.includes("Nobody can be hired for this job right now") || "a job with nobody to hire" },
    { name: "BNB's rules and its registration are stated", test: (h) => (h.includes("forms.gle/jzTajVNZEgukeoYT9") && h.includes("different agents")) || "no campaign rules or registration link" },
    // Most people arrive here to hire: two of the three, in one confirmation, before the rules.
    { name: "the two-hire pack comes first", test: (h) => (h.includes('class="x-pack"') && h.indexOf('class="x-pack"') < h.indexOf("x-quest__steps")) || "no pack ahead of the steps" },
    { name: "the same two hires are offered free on testnet", test: (h) => h.includes("free on testnet") || "no testnet pack" },
  ]);
  // A builder learns whether people can hire their agent here.
  await page("/check?q=344119", [{ name: "says whether people can hire it here", test: (h) => h.includes("Can people hire it on MANDATE?") || "no hire box" }]);
  // The Set and Earn check our posts link to: it renders the checks for an agent, and a wallet's agents.
  await page("/check?q=344123", [
    { name: "the six checks render for an agent", test: (h) => (h.includes("x-qualify") && h.includes("Set and Earn checks")) || "no check panel" },
  ]);
  // Builders rarely know their id: a name, or a link to the agent's page, finds it too.
  await page(`/check?q=${encodeURIComponent("Mandate Guard-1")}`, [
    { name: "an agent's name finds its check", test: (h) => h.includes("x-qualify") || h.includes("x-check__agent") || "the name found nothing" },
  ]);
  // The shop opens on what can be hired: every card on the first screen has a Hire button.
  await page("/agents", [
    {
      name: "opens on Ready to hire, every card hireable",
      test: (h) => {
        if (!/x-tab x-tab--on"[^>]*><span class="x-tab__long">Ready to hire/.test(h)) return "not on the Ready to hire tab";
        // A card's body can stream in after its frame, so each card's Hire link is looked for anywhere in the page.
        const ids = [...h.matchAll(/class="x-agent[^"]*" data-agent="(\d+)"/g)].slice(0, 12).map((m) => m[1]!);
        const dead = ids.filter((id) => !h.includes(`href="/agents/${id}#call"`) && !h.includes(`href="/hire/${id}"`));
        return (ids.length > 0 && dead.length === 0) || `${dead.length} of ${ids.length} cards cannot be hired (${dead.join(", ")})`;
      },
    },
    {
      // 19 on 6 Oct before the hireability pass, 28 after it: a slide back below 25 means something on our side broke again.
      name: "at least 25 agents are ready to hire",
      test: (h) => {
        const n = Number(/x-tab x-tab--on"[^>]*>.*?<span class="x-tab__n">(\d+)</.exec(h)?.[1] ?? NaN);
        return n >= 25 || `the Ready to hire tab counts ${Number.isNaN(n) ? "nothing" : n}`;
      },
    },
  ]);
  await page("/graveyard", [
    { name: "failures are listed", test: (h) => h.includes("x-grave__who") || "no rows" },
    { name: "our own mistake is labelled", test: (h) => h.includes("Our mistake, not theirs") || "no row labelled as ours" },
  ]);

  // The re-run is the page's live claim, so it is checked live: three reads of the head block.
  const rerun = await get("/api/proof/rerun");
  try {
    const j = JSON.parse(rerun.text) as { block: number | null; checks: { id: string; verdict: string; finding: string }[] };
    // A failed check is a finding, and the leash one failing would be the worst news on the site, so it fails here too.
    const bad = j.checks.filter((c) => c.verdict !== "pass");
    record(
      "/api/proof/rerun: the live checks pass at the head block",
      Boolean(j.block) && j.checks.length > 0 && !bad.length,
      bad.length ? bad.map((c) => `${c.id} ${c.verdict}: ${c.finding}`).join("; ") : `${j.checks.length} checks at block ${j.block} in ${rerun.ms} ms`,
    );
  } catch {
    record("/api/proof/rerun", false, `expected JSON, got ${rerun.status}`);
  }

  // The seller's door: a real token placed on the ladder, with the next step named.
  await page("/list?id=342379", [
    { name: "a token is placed on the ladder", test: (h) => /Rung \d of 5/.test(h) || "no rung on the page" },
    { name: "the next step or the top is named", test: (h) => h.includes("x-listing__next") || "no next step" },
  ]);

  // The buyer's door as data: the diagnosis names the block it read.
  const diag = await get(`/api/v1/diagnose/${DEMO}`);
  try {
    const j = JSON.parse(diag.text) as { ok: boolean; observed: { blockNumber: string | null }; data?: { needed: string[]; agents: unknown[] } };
    const good = j.ok && Boolean(j.observed.blockNumber) && Array.isArray(j.data?.agents);
    record("/api/v1/diagnose: the demo wallet is read at a block", good, good ? `block ${j.observed.blockNumber}, needs ${j.data!.needed.join(", ") || "nothing"}` : diag.text.slice(0, 160));
  } catch {
    record("/api/v1/diagnose", false, `expected JSON, got ${diag.status}`);
  }

  // The marketplace as data, which the MCP tools read: as many ready to hire as the page counts.
  const market = await get(`/api/v1/market?view=ready&limit=3`);
  try {
    const j = JSON.parse(market.text) as { ok: boolean; data?: { ready: number; agents: { hireable: boolean; hire: string }[] } };
    const good = j.ok && (j.data?.ready ?? 0) >= 25 && (j.data?.agents ?? []).every((a) => a.hireable && a.hire.includes("/agents/"));
    record("/api/v1/market: at least 25 ready, each with a hire link", good, good ? `${j.data!.ready} ready` : market.text.slice(0, 160));
  } catch {
    record("/api/v1/market", false, `expected JSON, got ${market.status}`);
  }

  // Our agents sell on testnet too: the card a testnet marketplace reads names chain 97 and test $U.
  const card97 = await get(`/a2a/guard-1/.well-known/agent-card.json?chain=97`);
  try {
    const j = JSON.parse(card97.text) as { url?: string; erc8183?: { chain_id?: number; erc8004?: string | null } };
    const good = j.erc8183?.chain_id === 97 && Boolean(j.erc8183.erc8004) && Boolean(j.url?.includes("chain=97"));
    record("/a2a/guard-1?chain=97: the testnet card names chain 97 and its testnet identity", good, good ? `testnet #${j.erc8183!.erc8004}` : card97.text.slice(0, 160));
  } catch {
    record("/a2a/guard-1?chain=97", false, `expected JSON, got ${card97.status}`);
  }

  // The build prompt an assistant reads at its link carries BNB Chain's six checks.
  const prompt = await get(`/api/build/prompt?job=health-factor&network=mainnet`);
  {
    const good = prompt.status === 200 && ["Registered and owned", "Discoverable", "Live", "Hired by others", "Actually executes", "Does what it says"].every((t) => prompt.text.includes(t));
    record("/api/build/prompt: the build prompt carries the six checks", good, good ? `${prompt.text.length} chars` : `${prompt.status} ${prompt.text.slice(0, 120)}`);
  }

  // An AI assistant connecting over MCP gets the marketplace tools first.
  try {
    const res = await fetch(`${BASE}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "mandate-smoke" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const names = (((await res.json()) as { result?: { tools?: { name: string }[] } }).result?.tools ?? []).map((t) => t.name);
    const good = names[0] === "search_agents" && names.includes("hire_agent") && names.includes("quest_progress");
    record("/api/mcp: the marketplace tools come first", good, good ? `${names.length} tools` : names.join(", ").slice(0, 160));
  } catch (e) {
    record("/api/mcp", false, (e as Error).message.slice(0, 120));
  }

  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(width)}  ${c.detail}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed} of ${checks.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});

/**
 * Files again, under the current classifier, every agent that has no job,
 * and puts the cards that never loaded back in the queue to be read.
 *
 * Only agents with no job are touched: one already listed under a job is
 * never moved by a rule change. Dry by default, because DATABASE_URL is
 * usually production:
 *
 *   npx tsx --env-file=.env --env-file=.env.local src/scripts/refile-registry.ts          report
 *   npx tsx --env-file=.env --env-file=.env.local src/scripts/refile-registry.ts --apply  write
 */

import { sql } from "@/lib/db/client";
import { classify, CLASSIFIER_VERSION, fileable } from "@/lib/assay/classify";
import { refileOld } from "@/lib/registry/tail";
import { fileIndex } from "@/lib/data/agents";

const APPLY = process.argv.includes("--apply");

async function main() {
  if (!sql) throw new Error("no DATABASE_URL");

  // 1. Cards the tail stored as read although they never loaded: no name, no job.
  const [unread] = (await sql`
    select count(*)::int as n from registry_agents
    where source = 'tail' and coalesce((record->>'resolved')::boolean, false) and record->>'name' is null`) as { n: number }[];
  console.log(`cards that never loaded, to read again: ${unread?.n ?? 0}`);
  if (APPLY && unread?.n) {
    await sql`
      update registry_agents set record = record || jsonb_build_object('resolved', false, 'attempts', 0), indexed_at = now()
      where source = 'tail' and coalesce((record->>'resolved')::boolean, false) and record->>'name' is null`;
  }

  // 2. The tail's rows with no job, under the current classifier.
  if (APPLY) {
    let total = { looked: 0, filed: 0 };
    for (;;) {
      const r = await refileOld(3_000);
      total = { looked: total.looked + r.looked, filed: total.filed + r.filed };
      if (r.looked < 3_000) break;
    }
    console.log(`tail rows filed again: ${total.looked} looked at, ${total.filed} now under a job`);
  } else {
    const rows = (await sql`
      select token_id, record from registry_agents where category is null and record->>'name' is not null
        and coalesce((record->>'classifierVersion')::int, 1) < ${CLASSIFIER_VERSION}`) as { token_id: string; record: { name?: string; description?: string; protocols?: string[]; x402?: boolean } }[];
    const hits = rows.filter((r) => {
      const c = classify({ name: r.record.name, description: r.record.description });
      return fileable(c, Boolean(r.record.x402) || (r.record.protocols ?? []).some((p) => /^(a2a|mcp|x402)$/i.test(p)));
    });
    console.log(`tail rows that would be filed: ${hits.length} of ${rows.length}`);
    for (const r of hits.slice(0, 40)) console.log(`  #${r.token_id} ${r.record.name} -> ${classify({ name: r.record.name, description: r.record.description }).category}`);
  }

  /*
    3. The September crawl's agents with no job. The crawl is a committed file,
    so they are written into registry_agents, which the site lays over the
    file (registryExtras): filed ones show at once, and the rest are there for
    the next classifier version to look at again.
  */
  const crawl = fileIndex().agents.filter((a) => !a.category && a.name);
  const rows = crawl.map((a) => {
    const c = classify({ name: a.name, description: a.description });
    const callable = a.x402 || a.protocols.some((p) => /^(a2a|mcp|x402)$/i.test(p));
    const filed = fileable(c, callable);
    return {
      token_id: a.tokenId,
      owner: a.owner,
      category: filed ? c.category : null,
      record: { ...a, category: filed ? c.category : null, confidence: filed ? c.confidence : 0, matched: filed ? c.matched : [], classifierVersion: CLASSIFIER_VERSION, resolved: true, source: "crawl" },
    };
  });
  const filed = rows.filter((r) => r.category);
  console.log(`crawl agents with no job: ${crawl.length}; ${APPLY ? "filed" : "would be filed"}: ${filed.length}`);
  for (const r of filed.slice(0, 40)) console.log(`  #${r.token_id} ${r.record.name} -> ${r.category} [${r.record.matched.join(", ")}]`);
  if (APPLY && rows.length) {
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      await sql`
        insert into registry_agents (token_id, owner, category, record, source, indexed_at)
        select x.token_id, x.owner, x.category, x.record, 'crawl', now()
        from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) as x(token_id text, owner text, category text, record jsonb)
        on conflict (token_id) do update set
          category = coalesce(registry_agents.category, excluded.category),
          record = case when registry_agents.category is null then registry_agents.record || excluded.record else registry_agents.record end,
          indexed_at = case when registry_agents.category is null and excluded.category is not null then now() else registry_agents.indexed_at end`;
    }
  }
}

main().then(() => process.exit(0), (e) => { console.error((e as Error).message); process.exit(1); });

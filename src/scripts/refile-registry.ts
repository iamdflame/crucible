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

  // 3. The September crawl's rows with no job.
  const crawl = (await sql`
    select token_id, name, description, a2a_endpoint, mcp_server, x402_supported from agents where category is null and name is not null`) as {
    token_id: string;
    name: string;
    description: string | null;
    a2a_endpoint: string | null;
    mcp_server: string | null;
    x402_supported: boolean | null;
  }[];
  const moved = crawl
    .map((r) => ({ r, c: classify({ name: r.name, description: r.description }) }))
    .filter(({ r, c }) => fileable(c, Boolean(r.a2a_endpoint || r.mcp_server || r.x402_supported)));
  console.log(`crawl rows that ${APPLY ? "are" : "would be"} filed: ${moved.length} of ${crawl.length}`);
  for (const { r, c } of moved.slice(0, 40)) console.log(`  #${r.token_id} ${r.name} -> ${c.category} [${c.matched.join(", ")}]`);
  if (APPLY && moved.length) {
    const rows = moved.map(({ r, c }) => ({ token_id: r.token_id, category: c.category, confidence: c.confidence }));
    await sql`
      update agents a set category = u.category, category_confidence = u.confidence, updated_at = now()
      from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as u(token_id text, category text, confidence real)
      where a.token_id::text = u.token_id and a.category is null`;
  }
}

main().then(() => process.exit(0), (e) => { console.error((e as Error).message); process.exit(1); });

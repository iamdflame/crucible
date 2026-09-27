import { refreshIfStale } from "@/lib/census/refresh";
import { getProbes } from "@/lib/data/probes";
import { getAgentIndex } from "@/lib/data/agents";
const owner = process.argv[2]?.toLowerCase();
const ids = owner?.startsWith("0x") ? getAgentIndex().agents.filter((a) => a.owner?.toLowerCase() === owner).map((a) => a.tokenId) : process.argv.slice(2);
console.log("agents:", ids.join(","), "|", getAgentIndex().agents.filter((a) => ids.includes(a.tokenId)).map((a) => `${a.tokenId} ${a.name} ${a.category}`).join("; "));
for (let i = 0; i < 4; i++) {
  const r = await refreshIfStale({ force: true, only: ids, limit: ids.length, budgetMs: 150_000 });
  console.log(r.ran, r.why, r.refreshed);
  if (r.ran) break;
  await new Promise((ok) => setTimeout(ok, 30_000));
}
const q = getProbes().escrowQuotes ?? {};
for (const id of ids) console.log(id, q[id] ? `${q[id].kind} ${q[id].provider} ${Number(q[id].price) / 1e18} $U notify=${q[id].notify} unpayable=${q[id].unpayable}` : "no escrow quote");
process.exit(0);

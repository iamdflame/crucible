import { warm } from "@/lib/data/snapshots";
import { requirements } from "@/lib/ops/requirements";
import { warmOutcomes } from "@/lib/market/hire-law";
await warm(["probe", "registry-tail", "definition"]);
await warmOutcomes();
for (const b of await requirements()) console.log(b.state.padEnd(6), b.id.padEnd(10), "|", b.detail.slice(0, 230));
process.exit(0);

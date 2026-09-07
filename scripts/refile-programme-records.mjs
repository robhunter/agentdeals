import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const indexPath = join(process.cwd(), "data", "index.json");
const data = JSON.parse(readFileSync(indexPath, "utf8"));

const PROGRAMME_TIERS = new Set(["Startup Program", "Portfolio"]);
const PROGRAMME_CATEGORY = "Startup Perks";
const MERGED_AWAY = "Startup Programs";

const moved = [];
for (const offer of data.offers) {
  if (offer.category === MERGED_AWAY) {
    moved.push({ vendor: offer.vendor, from: offer.category, tier: offer.tier, why: "merged" });
    offer.category = PROGRAMME_CATEGORY;
    continue;
  }
  if (PROGRAMME_TIERS.has(offer.tier) && offer.category !== PROGRAMME_CATEGORY) {
    moved.push({ vendor: offer.vendor, from: offer.category, tier: offer.tier, why: "tier" });
    offer.category = PROGRAMME_CATEGORY;
  }
}

writeFileSync(indexPath, JSON.stringify(data, null, 2) + "\n");

for (const m of moved) console.log(`${m.why}\t${m.from}\t${m.vendor}\t${m.tier}`);
console.log(`moved ${moved.length} of ${data.offers.length} in ${indexPath}`);

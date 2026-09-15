import { getDealChanges, loadDealChanges, DEFAULT_CHANGE_WINDOW_DAYS } from "../dist/data.js";
import { recordsWeStandBehind } from "../dist/change-resolution.js";

const all = loadDealChanges();
const standing = recordsWeStandBehind(all);

const unfiltered = getDealChanges();
const allTime = getDealChanges("2020-01-01");

console.log("DEFAULT_CHANGE_WINDOW_DAYS =", DEFAULT_CHANGE_WINDOW_DAYS);
console.log("window start today          =", new Date(Date.now() - DEFAULT_CHANGE_WINDOW_DAYS * 864e5).toISOString().slice(0, 10));
console.log("raw records in log          =", all.length, "| we stand behind:", standing.length);
console.log("default window   total      =", unfiltered.total, "| distinct vendors:", new Set(unfiltered.changes.map((c) => c.vendor)).size);
console.log("since=2020-01-01 total      =", allTime.total, "| distinct vendors:", new Set(allTime.changes.map((c) => c.vendor)).size);
console.log("in-window date range        =", unfiltered.changes.map((c) => c.date).sort()[0], "→", unfiltered.changes.map((c) => c.date).sort().at(-1));

const vendorsAllTime = [...new Set(allTime.changes.map((c) => c.vendor))].sort();
const blind = [];
for (const v of vendorsAllTime) {
  const filtered = getDealChanges(undefined, undefined, v);
  if (filtered.total === 0) blind.push(v);
}
console.log("\nvendors holding a live record that answer 0 to a vendor-filtered call with no since:");
console.log("  ", blind.length, "of", vendorsAllTime.length, `(${((blind.length / vendorsAllTime.length) * 100).toFixed(0)}%)`);

const removedBlind = blind.filter((v) =>
  allTime.changes.some((c) => c.vendor === v && c.change_type === "free_tier_removed"),
);
console.log("   of which carry a free_tier_removed record we still publish:", removedBlind.length);

console.log("\nissue's four controls (no since passed):");
for (const v of ["Hetzner", "Amazon SES", "Brave Search API", "CodeRabbit"]) {
  const now = getDealChanges(undefined, undefined, v);
  const ever = getDealChanges("2020-01-01", undefined, v);
  console.log(`   ${v.padEnd(18)} default=${String(now.total).padStart(2)}  all-time=${String(ever.total).padStart(2)}  ` +
    ever.changes.map((c) => `${c.date}/${c.change_type}`).join(" "));
}

const catsAllTime = [...new Set(allTime.changes.map((c) => c.category).filter(Boolean))].sort();
const blindCats = catsAllTime.filter((c) => getDealChanges(undefined, undefined, undefined, undefined, c).total === 0);
console.log("\ncategories holding a live record that answer 0 to a category-filtered call:", blindCats.length, "of", catsAllTime.length);
if (blindCats.length) console.log("  ", blindCats.join(", "));

const typesAllTime = [...new Set(allTime.changes.map((c) => c.change_type))].sort();
const blindTypes = typesAllTime.filter((t) => getDealChanges(undefined, t).total === 0);
console.log("change types holding a live record that answer 0 to a type-filtered call:", blindTypes.length, "of", typesAllTime.length);
if (blindTypes.length) console.log("  ", blindTypes.join(", "));

console.log("\nbogus-parameter control: an unrecognised query key is ignored, so /api/changes?bogusparam=zzz returns", unfiltered.total);

import { loadOffers } from "../dist/data.js";
import { partitionAlternatives, partitionRoleCandidates, MEMBERSHIP_GATE_RULES } from "../dist/product-role.js";

const HELP = `membership-impact.js — report what the #1032 membership gates remove.

Usage:
  node scripts/membership-impact.js [--json]

Prints, for every catalogue record classified with a product_role, which
alternatives lists it is removed from, how many lists shrink, and every
category whose alternatives list falls below three entries once the gates
are applied. Reads data/index.json through the built dist/ modules; makes no
network calls and writes nothing.

  --json   emit the same report as JSON instead of text
  --help   show this message`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

const asJson = process.argv.includes("--json");
const offers = loadOffers();

const classified = offers.filter((o) => o.product_role);
const gated = classified.filter((o) => o.product_role.deployment_model === "local_dev_only" || o.product_role.is_addon);

const removalsByOffer = new Map();
const listsAffected = new Map();
const categoryShrink = [];

const categories = [...new Set(offers.map((o) => o.category))].sort();

for (const category of categories) {
  const inCategory = offers.filter((o) => o.category === category);
  let shrunk = 0;
  let minKept = Infinity;
  let minSubject = null;
  for (const subject of inCategory) {
    const candidates = inCategory.filter((o) => o.vendor !== subject.vendor);
    const { kept, removed } = partitionAlternatives(candidates, subject);
    if (removed.length > 0) {
      shrunk += 1;
      const key = `${category}`;
      listsAffected.set(key, (listsAffected.get(key) ?? 0) + 1);
      for (const r of removed) {
        const k = `${r.offer.vendor} (${r.offer.category})`;
        const entry = removalsByOffer.get(k) ?? { gate: r.gate, lists: 0 };
        entry.lists += 1;
        removalsByOffer.set(k, entry);
      }
    }
    if (kept.length < minKept) {
      minKept = kept.length;
      minSubject = subject.vendor;
    }
  }
  if (shrunk > 0 && minKept < 3) {
    categoryShrink.push({ category, min_alternatives: minKept, on_page: minSubject, total_in_category: inCategory.length });
  }
}

const roleCategories = [...new Set(categories)];
const roleImpact = [];
for (const category of roleCategories) {
  const { removed } = partitionRoleCandidates(offers.filter((o) => o.category === category));
  if (removed.length > 0) {
    roleImpact.push({ category, removed: removed.map((r) => `${r.offer.vendor} (${MEMBERSHIP_GATE_RULES[r.gate].label.toLowerCase()})`) });
  }
}

const report = {
  catalogue_size: offers.length,
  classified: classified.length,
  gated: gated.length,
  gated_records: gated.map((o) => ({
    vendor: o.vendor,
    category: o.category,
    deployment_model: o.product_role.deployment_model,
    is_addon: o.product_role.is_addon,
    source_url: o.product_role.source_url,
  })),
  alternatives_lists_shrunk: [...listsAffected.entries()].map(([category, lists]) => ({ category, lists })),
  removals: [...removalsByOffer.entries()].map(([offer, v]) => ({ offer, gate: v.gate, lists: v.lists })),
  categories_below_three: categoryShrink,
  role_recommendation_impact: roleImpact,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`catalogue ${report.catalogue_size} records, ${report.classified} classified, ${report.gated} carrying a gate\n`);
  console.log("gated records:");
  for (const g of report.gated_records) {
    console.log(`  ${g.vendor} (${g.category}) — ${g.deployment_model}${g.is_addon ? ", add-on" : ""}`);
  }
  console.log("\nremoved from alternatives lists:");
  for (const r of report.removals) {
    console.log(`  ${r.offer} — ${r.gate} — removed from ${r.lists} lists`);
  }
  console.log("\nalternatives lists that shrink, by category:");
  for (const a of report.alternatives_lists_shrunk) {
    console.log(`  ${a.category}: ${a.lists} lists`);
  }
  console.log("\ncategories where an alternatives list falls below 3:");
  if (report.categories_below_three.length === 0) console.log("  none");
  for (const c of report.categories_below_three) {
    console.log(`  ${c.category}: ${c.min_alternatives} on /vendor/${c.on_page} (${c.total_in_category} in category)`);
  }
  console.log("\nrole recommendations (/api/stack, plan_stack):");
  if (report.role_recommendation_impact.length === 0) console.log("  none");
  for (const r of report.role_recommendation_impact) {
    console.log(`  ${r.category}: ${r.removed.join(", ")}`);
  }
}

#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexPath = resolve(__dirname, "../data/index.json");
const mappingPath = resolve(__dirname, "../data/category-mapping.json");

// Keyword-based categorization rules for Developer Tools entries
// that aren't in the explicit mapping. Applied in order — first match wins.
const keywordRules: Array<{ category: string; test: (v: string, d: string, tags: string[]) => boolean }> = [
  { category: "Startup Perks", test: (_v, d) => d.includes("Access via:") },
  { category: "Startup Perks", test: (v) => /startup|accelerat/i.test(v) },
];

interface Offer {
  vendor: string;
  category: string;
  description: string;
  tags?: string[];
  [key: string]: unknown;
}

interface IndexData {
  offers: Offer[];
  [key: string]: unknown;
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const data: IndexData = JSON.parse(readFileSync(indexPath, "utf8"));
  const mapping: Record<string, string> = JSON.parse(readFileSync(mappingPath, "utf8"));

  const devTools = data.offers.filter(o => o.category === "Developer Tools");
  console.log(`Developer Tools entries: ${devTools.length}`);
  console.log(`Mapping entries: ${Object.keys(mapping).length}`);

  let moved = 0;
  let unmapped = 0;
  const unmappedVendors: string[] = [];

  for (const offer of data.offers) {
    if (offer.category !== "Developer Tools") continue;

    // Check explicit mapping first
    if (mapping[offer.vendor]) {
      offer.category = mapping[offer.vendor];
      moved++;
      continue;
    }

    // Fall back to keyword rules
    let matched = false;
    for (const rule of keywordRules) {
      if (rule.test(offer.vendor, offer.description || "", offer.tags || [])) {
        offer.category = rule.category;
        moved++;
        matched = true;
        break;
      }
    }

    if (!matched) {
      unmapped++;
      unmappedVendors.push(offer.vendor);
    }
  }

  // Count categories after recategorization
  const cats: Record<string, number> = {};
  for (const offer of data.offers) {
    cats[offer.category] = (cats[offer.category] || 0) + 1;
  }

  console.log(`\nMoved: ${moved}`);
  console.log(`Remaining in Developer Tools: ${unmapped}`);
  if (unmappedVendors.length > 0) {
    console.log(`Unmapped vendors: ${unmappedVendors.join(", ")}`);
  }

  console.log(`\nCategory distribution after recategorization:`);
  Object.entries(cats)
    .sort((a, b) => b[1] - a[1])
    .forEach(([cat, count]) => {
      console.log(`  ${count.toString().padStart(4)} ${cat}`);
    });

  // Verify acceptance criteria
  const maxCategory = Object.entries(cats).reduce((a, b) => a[1] > b[1] ? a : b);
  const devToolsRemaining = cats["Developer Tools"] || 0;
  const startupPerks = cats["Startup Perks"] || 0;

  console.log(`\n--- Acceptance Criteria ---`);
  console.log(`Max category: ${maxCategory[0]} (${maxCategory[1]}) — ${maxCategory[1] <= 120 ? "PASS" : "FAIL"} (limit: 120)`);
  console.log(`Developer Tools: ${devToolsRemaining} — ${devToolsRemaining < 30 ? "PASS" : "FAIL"} (limit: <30)`);
  console.log(`Startup Perks: ${startupPerks}`);
  console.log(`Total offers: ${data.offers.length}`);

  if (!dryRun) {
    writeFileSync(indexPath, JSON.stringify(data, null, 2) + "\n");
    console.log(`\nWrote updated index to ${indexPath}`);
  } else {
    console.log(`\n[DRY RUN] No changes written.`);
  }
}

main();

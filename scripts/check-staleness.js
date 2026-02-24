#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_THRESHOLD_DAYS = 30;

export function findStaleEntries(offers, thresholdDays, now = new Date()) {
  const stale = [];
  for (const offer of offers) {
    if (!offer.verifiedDate) {
      stale.push({ vendor: offer.vendor, category: offer.category, daysSince: Infinity });
      continue;
    }
    const verified = new Date(offer.verifiedDate);
    const diffMs = now.getTime() - verified.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays > thresholdDays) {
      stale.push({ vendor: offer.vendor, category: offer.category, daysSince: diffDays });
    }
  }
  return stale.sort((a, b) => b.daysSince - a.daysSince);
}

function main() {
  const thresholdArg = process.argv[2];
  const thresholdDays = thresholdArg ? parseInt(thresholdArg, 10) : DEFAULT_THRESHOLD_DAYS;

  if (isNaN(thresholdDays) || thresholdDays < 0) {
    console.error(`Invalid threshold: ${thresholdArg}. Must be a non-negative integer.`);
    process.exit(2);
  }

  const indexPath = resolve(__dirname, "..", "data", "index.json");
  let data;
  try {
    data = JSON.parse(readFileSync(indexPath, "utf-8"));
  } catch (err) {
    console.error(`Failed to read index: ${err.message}`);
    process.exit(2);
  }

  const offers = data.offers || [];
  const stale = findStaleEntries(offers, thresholdDays);

  if (stale.length === 0) {
    console.log(`All ${offers.length} entries verified within ${thresholdDays} days.`);
    process.exit(0);
  }

  console.log(`Found ${stale.length} stale entries (threshold: ${thresholdDays} days):\n`);
  for (const entry of stale) {
    const days = entry.daysSince === Infinity ? "never verified" : `${entry.daysSince} days ago`;
    console.log(`  ${entry.vendor} (${entry.category}) — ${days}`);
  }

  process.exit(1);
}

// Only run main when executed directly (not imported)
const isMainModule = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main();
}

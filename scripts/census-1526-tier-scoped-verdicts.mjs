#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { supersedingChange } from "../dist/superseded-description.js";
import { namesADifferentTier, readingGradesTheHostedEdition } from "../dist/change-tier.js";
import { publishedRisk } from "../dist/data.js";
import { changesByVendor } from "../dist/superseded-census.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");

const AS_OF = "2026-09-10";
const AS_OF_MS = Date.parse(`${AS_OF}T12:00:00Z`);

const offers = JSON.parse(readFileSync(resolve(REPO, "data", "index.json"), "utf-8")).offers;
const changes = JSON.parse(readFileSync(resolve(REPO, "data", "deal_changes.json"), "utf-8")).changes;
const byVendor = changesByVendor(changes);

const changeKey = (change) =>
  change ? [change.vendor, change.change_type, change.date, change.source_url].join("|") : null;

const offerKey = (offer) => [offer.vendor, offer.tier, offer.url].join("|");

const rows = offers.map((offer) => {
  const vendorChanges = byVendor.get(offer.vendor.toLowerCase()) ?? [];
  const risk = publishedRisk(offer, vendorChanges, AS_OF, AS_OF_MS);
  return {
    offer: offerKey(offer),
    withholding: changeKey(supersedingChange(offer, vendorChanges)),
    named_tier: supersedingChange(offer, vendorChanges)?.tier ?? null,
    risk_level: risk.risk_level,
    risk_cause: changeKey(risk.cause),
  };
});

if (process.argv.includes("--json")) {
  process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
} else {
  const withholding = rows.filter((row) => row.withholding !== null);
  const byType = {};
  for (const row of withholding) {
    const type = row.withholding.split("|")[1];
    byType[type] = (byType[type] ?? 0) + 1;
  }
  const named = withholding.filter((row) => row.named_tier !== null).length;
  console.log(`offers ${rows.length}, change records ${changes.length}, as of ${AS_OF}`);
  console.log(`withholding their stored terms: ${withholding.length}`);
  console.log(`  the record names a tier: ${named}`);
  console.log(`  the record names none:    ${withholding.length - named}`);
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }
  const demoted = rows.filter((row) => row.risk_level && row.risk_level !== "stable");
  console.log(`rated caution or risky: ${demoted.length}`);

  let pairs = 0;
  let refusedForNamingAnotherTier = 0;
  const refusedForReadingTheHostedEdition = [];
  for (const offer of offers) {
    for (const change of byVendor.get(offer.vendor.toLowerCase()) ?? []) {
      pairs++;
      if (namesADifferentTier(change, offer.tier)) refusedForNamingAnotherTier++;
      if (readingGradesTheHostedEdition(change, offer)) {
        refusedForReadingTheHostedEdition.push(`${offer.vendor} (${offer.tier}) <- ${changeKey(change)}`);
      }
    }
  }
  console.log(`offer/record pairs: ${pairs}`);
  console.log(`  the record names another tier: ${refusedForNamingAnotherTier}`);
  console.log(`  the reading grades the hosted edition: ${refusedForReadingTheHostedEdition.length}`);
  for (const pair of refusedForReadingTheHostedEdition) console.log(`    ${pair}`);
}

#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CHANGE_DIRECTION, narrowsTheStoredTerms } from "../dist/change-direction.js";
import { isNoLongerInForce } from "../dist/change-resolution.js";
import { changeRatesTheListedTier } from "../dist/change-tier.js";
import {
  quotesTheStoredTermsAsPrevious,
  readingPricesNothingButATrial,
  supersedesTheStoredTerms,
  supersedingChange,
} from "../dist/superseded-description.js";
import { supersededCensus, changesByVendor } from "../dist/superseded-census.js";
import { loadDealChanges } from "../dist/data.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");

const offers = JSON.parse(readFileSync(resolve(REPO, "data", "index.json"), "utf-8")).offers;
const changes = JSON.parse(readFileSync(resolve(REPO, "data", "deal_changes.json"), "utf-8")).changes;
const today = new Date().toISOString().slice(0, 10);

const byVendor = changesByVendor(changes);
const changesFor = (offer) => byVendor.get(offer.vendor.toLowerCase()) ?? [];

function supersedingUnderADirectionGate(offer) {
  let newest = null;
  for (const change of changesFor(offer)) {
    if (!narrowsTheStoredTerms(change.change_type)) continue;
    if (!supersedesTheStoredTerms(change, offer)) continue;
    if (readingPricesNothingButATrial(change, offer)) continue;
    if (!newest || change.date > newest.date) newest = change;
  }
  return newest;
}

const rows = [];
for (const offer of offers) {
  for (const change of changesFor(offer)) {
    if (!quotesTheStoredTermsAsPrevious(change, offer.description ?? "")) continue;
    if (isNoLongerInForce(change)) continue;
    if (!changeRatesTheListedTier(change, offer)) continue;
    rows.push({
      vendor: offer.vendor,
      tier: offer.tier,
      direction: CHANGE_DIRECTION[change.change_type] ?? "unclassified",
      change_type: change.change_type,
      impact: change.impact,
      date: change.date,
      detected_by: change.detected_by ?? "a person",
      summary: change.summary ?? "",
      pricesNothingButATrial: readingPricesNothingButATrial(change, offer),
    });
  }
}

const directions = ["negative", "positive", "neutral", "unclassified"];

console.log(`── Records whose stored terms one of our own records names as the previous ones, ${today} ──`);
console.log(`Every row below passes every test but direction: the record is in force, it rates the tier we`);
console.log(`list, and its previous_state is our stored description word for word.\n`);

console.log("direction    records   withheld by the direction gate");
for (const direction of directions) {
  const inDirection = rows.filter((r) => r.direction === direction);
  if (inDirection.length === 0) continue;
  const withheld = direction === "negative" ? 0 : inDirection.length;
  console.log(`${direction.padEnd(12)} ${String(inDirection.length).padStart(7)}   ${withheld}`);
}
console.log(`${"all".padEnd(12)} ${String(rows.length).padStart(7)}   ${rows.filter((r) => r.direction !== "negative").length}`);

const before = offers.filter((o) => supersedingUnderADirectionGate(o) !== null).length;
const after = offers.filter((o) => supersedingChange(o, changesFor(o)) !== null).length;
console.log(`\n── Records that publish a disclosure rather than our stored figure ──`);
console.log(`under a direction gate: ${before}`);
console.log(`whatever the direction:  ${after}`);
console.log(
  `\nThe two counts are smaller than the ${rows.length} above because a record whose reading prices nothing but a\n` +
  `trial keeps publishing our stored terms: ${rows.filter((r) => r.pricesNothingButATrial).length} of these rows, ` +
  `${rows.filter((r) => r.pricesNothingButATrial && r.direction !== "negative").length} of them outside the negative column.`,
);

const held = rows.filter((r) => r.direction !== "negative");
console.log(`\n── The ${held.length} a direction gate used to withhold ──`);
const counted = (key) => {
  const seen = new Map();
  for (const row of held) seen.set(row[key], (seen.get(row[key]) ?? 0) + 1);
  return [...seen].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ");
};
console.log(`by type: ${counted("change_type")}`);
console.log(`by impact: ${counted("impact")}`);
console.log(`found by: ${counted("detected_by")}\n`);
for (const row of [...held].sort((a, b) => a.vendor.localeCompare(b.vendor))) {
  console.log(`${row.vendor} — ${row.tier} — ${row.change_type} — ${row.impact} — ${row.date}`);
  console.log(`    ${row.summary}`);
}

console.log(`\n── What the quality budgets measure, against what the site serves ──`);
console.log(`the budgets read data/deal_changes.json as it is stored:`);
console.log(JSON.stringify(supersededCensus(offers, changes, today), null, 2));
console.log(`\nthe site reads it with data/change_directions.json applied, which withdraws a verdict`);
console.log(`wherever a reviewed reading refutes the record's own type:`);
console.log(JSON.stringify(supersededCensus(offers, loadDealChanges(), today), null, 2));

#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { supersedingChange } from "../dist/superseded-description.js";
import { applyReviewedDirections, loadDirectionReview } from "../dist/change-direction-review.js";
import { publishedRisk } from "../dist/data.js";
import { changesByVendor } from "../dist/superseded-census.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");

const AS_OF = "2026-09-11";
const AS_OF_MS = Date.parse(`${AS_OF}T12:00:00Z`);

const DISCOVERED_LIMIT_VENDORS = [
  "addy.io", "Aionda Mail", "AppFit", "BugBug", "CatchJS.com", "dnspod.com", "Expo",
  "forwardemail.net", "FreeIPAPI", "GitBook", "Harness CI", "Icon Horse", "mockaroo",
  "Mocklets", "Nango", "packagecloud.io", "Permit.io", "Pinata IPFS", "ploi.io", "Postman",
  "Pullflow", "RightFeature", "transfernow", "Vaadin", "webhookrelay.com", "Whitespace", "Zenable",
];

const offers = JSON.parse(readFileSync(resolve(REPO, "data", "index.json"), "utf-8")).offers;
const stored = JSON.parse(readFileSync(resolve(REPO, "data", "deal_changes.json"), "utf-8")).changes;
const review = loadDirectionReview();

const changeKey = (change) =>
  change ? [change.vendor, change.change_type, change.date, change.source_url].join("|") : null;

function rowsFor(changes) {
  const byVendor = changesByVendor(changes);
  const rows = new Map();
  for (const offer of offers) {
    const vendorChanges = byVendor.get(offer.vendor.toLowerCase()) ?? [];
    const risk = publishedRisk(offer, vendorChanges, AS_OF, AS_OF_MS);
    rows.set([offer.vendor, offer.tier, offer.url].join("|"), {
      vendor: offer.vendor,
      withholding: changeKey(supersedingChange(offer, vendorChanges)),
      risk_level: risk.risk_level,
      risk_cause: changeKey(risk.cause),
    });
  }
  return rows;
}

const before = rowsFor(stored);
const after = rowsFor(applyReviewedDirections(stored, review.directions));

const moved = [];
for (const [key, was] of before) {
  const now = after.get(key);
  const fields = ["withholding", "risk_level", "risk_cause"].filter((f) => was[f] !== now[f]);
  if (fields.length > 0) moved.push({ vendor: was.vendor, fields, was, now });
}

const countWithholding = (rows) => [...rows.values()].filter((r) => r.withholding !== null).length;
const countRated = (rows) => [...rows.values()].filter((r) => r.risk_level && r.risk_level !== "stable").length;

console.log(`offers ${offers.length}, change records ${stored.length}, as of ${AS_OF}`);
console.log(`reviewed records: ${review.directions.length} (reviewed ${review.reviewed})`);
console.log(`  widened:   ${review.directions.filter((d) => d.tier_direction === "widened").length}`);
console.log(`  unchanged: ${review.directions.filter((d) => d.tier_direction === "unchanged").length}`);
console.log(`  narrowed:  ${review.directions.filter((d) => d.tier_direction === "narrowed").length}`);
console.log("");
console.log(`withholding their stored terms: ${countWithholding(before)} -> ${countWithholding(after)}`);
console.log(`rated caution or risky:         ${countRated(before)} -> ${countRated(after)}`);
console.log(`offers whose published row moves: ${moved.length}`);
console.log("");
for (const row of moved.sort((a, b) => a.vendor.localeCompare(b.vendor))) {
  const parts = row.fields.map((f) => {
    if (f === "risk_level") return `risk ${row.was.risk_level ?? "none"} -> ${row.now.risk_level ?? "none"}`;
    if (f === "withholding") return `terms ${row.was.withholding ? "withheld" : "published"} -> ${row.now.withholding ? "withheld" : "published"}`;
    return `cause ${row.was.risk_cause ? "set" : "none"} -> ${row.now.risk_cause ? "set" : "none"}`;
  });
  console.log(`  ${row.vendor}: ${parts.join(", ")}`);
}

console.log("");
console.log("The 27 records that discover a limit, measured before and after:");
let discoveredMoved = 0;
for (const vendor of DISCOVERED_LIMIT_VENDORS) {
  const key = [...before.keys()].find((k) => k.toLowerCase().startsWith(`${vendor.toLowerCase()}|`));
  if (!key) {
    console.log(`  ${vendor}: not in the catalogue under that name`);
    continue;
  }
  const was = before.get(key);
  const now = after.get(key);
  const same =
    was.withholding === now.withholding &&
    was.risk_level === now.risk_level &&
    was.risk_cause === now.risk_cause;
  if (!same) discoveredMoved++;
  if (!same) console.log(`  ${vendor}: MOVED`);
}
console.log(`  moved: ${discoveredMoved} of ${DISCOVERED_LIMIT_VENDORS.length}`);

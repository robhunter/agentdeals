#!/usr/bin/env node

import { isNoLongerInForce } from "../dist/change-resolution.js";
import { changeGradesTheListedTier } from "../dist/change-tier.js";
import { readingDescribesNoNarrowing } from "../dist/change-direction.js";
import {
  quotesTheStoredTermsAsPrevious,
  readingBehindTheChange,
  readingPricesNothingButATrial,
  supersedingChange,
} from "../dist/superseded-description.js";
import { changesByVendor, supersededCensus, primaryOfferFor } from "../dist/superseded-census.js";
import { loadDealChanges, loadOffers } from "../dist/data.js";
import { vendorSlugMap } from "../dist/vendor-slug.js";
import { gateFor } from "../dist/ranking.js";

const offers = loadOffers();
const changes = loadDealChanges();
const today = new Date().toISOString().slice(0, 10);

const byVendor = changesByVendor(changes);
const changesFor = (offer) => byVendor.get(offer.vendor.toLowerCase()) ?? [];

const quoting = [];
for (const offer of offers) {
  for (const change of changesFor(offer)) {
    if (isNoLongerInForce(change)) continue;
    if (!quotesTheStoredTermsAsPrevious(change, offer.description)) continue;
    quoting.push({ offer, change });
  }
}

const byOffer = new Map();
for (const { offer, change } of quoting) {
  const held = byOffer.get(offer);
  if (!held || change.date > held.date) byOffer.set(offer, change);
}

console.log(`in-force records quoting a stored description verbatim: ${quoting.length}`);
console.log(`offers whose stored description one of them quotes:     ${byOffer.size}`);

const gateOf = (offer) => {
  const quotingOnes = changesFor(offer).filter(
    (c) => !isNoLongerInForce(c) && quotesTheStoredTermsAsPrevious(c, offer.description),
  );
  if (supersedingChange(offer, changesFor(offer))) return "withheld";
  if (quotingOnes.every((c) => readingDescribesNoNarrowing(c))) return "readingDescribesNoNarrowing";
  if (quotingOnes.every((c) => !changeGradesTheListedTier(c, offer))) return "changeGradesTheListedTier";
  return "readingPricesNothingButATrial";
};

const buckets = new Map();
for (const offer of byOffer.keys()) {
  const key = gateOf(offer);
  const held = buckets.get(key) ?? [];
  held.push(offer);
  buckets.set(key, held);
}
console.log("\nby outcome:");
for (const [key, list] of [...buckets].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${key}: ${list.length}`);
}

const slugOf = new Map();
for (const [slug, vendor] of vendorSlugMap.entries()) {
  if (!slugOf.has(vendor)) slugOf.set(vendor, slug);
}
const isPrimary = (offer) => primaryOfferFor(offers, offer.vendor) === offer;

for (const [key, list] of buckets) {
  if (key === "withheld") continue;
  const pages = list.filter((o) => isPrimary(o) && slugOf.has(o.vendor));
  console.log(
    `\n${key}: ${pages.length} of them are the offer a /vendor page publishes; ${pages.filter((o) => !gateFor(o, today)).length} carry no ranking gate`,
  );
  for (const offer of pages.slice(0, 10)) {
    const change = byOffer.get(offer);
    console.log(
      `   /vendor/${slugOf.get(offer.vendor)}  tier=${JSON.stringify(offer.tier)} record=${change.date} ${change.change_type} direction=${JSON.stringify(change.tier_direction)}`,
    );
  }
}

console.log(`\ncensus module: ${JSON.stringify(supersededCensus(offers, changes, today))}`);

const withheld = [...byOffer.keys()].filter((o) => gateOf(o) === "withheld");
const ages = [];
for (const offer of withheld) {
  const reading = readingBehindTheChange(supersedingChange(offer, changesFor(offer)));
  if (!reading) continue;
  ages.push(Math.round((Date.parse(today) - Date.parse(reading.date)) / 86400000));
}
ages.sort((a, b) => a - b);
console.log(`\nwithholding offers whose record carries a sourced dated reading: ${ages.length} of ${withheld.length}`);
console.log(`age of that reading, days: min ${ages[0]} p50 ${ages[Math.floor(ages.length / 2)]} max ${ages[ages.length - 1]}`);
console.log(`readings older than 19 days: ${ages.filter((d) => d > 19).length}`);

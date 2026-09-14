#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH =
  process.env.AGENTDEALS_INDEX_PATH || resolve(__dirname, "..", "data", "index.json");
const CHANGES_PATH =
  process.env.AGENTDEALS_CHANGES_PATH || resolve(__dirname, "..", "data", "deal_changes.json");

const BROAD = new RegExp(
  [
    "open[- ]?source",
    "\\boss\\b",
    "a?gpl(?:v[23])?",
    "lgpl",
    "\\bmpl\\b",
    "mit licen[cs]e",
    "apache[- ]?2",
    "\\bbsd\\b",
    "\\bbsl\\b",
    "elastic licen[cs]e",
    "\\bsspl\\b",
    "community edition",
    "self[- ]?host(?:ed|ing|able)?",
    "licen[cs]e",
  ].join("|"),
  "i"
);

const LICENCE_TIER = new RegExp(
  [
    "\\boss\\b",
    "open[- ]?source",
    "\\bcommunity\\b",
    "self[- ]?host(?:ed|ing|able)?",
    "a?gpl",
    "\\bmpl\\b",
    "apache",
    "\\bbsd\\b",
  ].join("|"),
  "i"
);

const NAMED_LICENCE = new RegExp(
  [
    "a?gplv?[23]?(?:[.-]\\d)?",
    "lgpl",
    "\\bmpl[- ]?2(?:\\.0)?",
    "mit licen[cs]e",
    "apache[- ]?2(?:\\.0)?",
    "bsd[- ]?[23]?[- ]?clause",
    "\\bbsl\\b",
    "elastic licen[cs]e",
    "\\bsspl\\b",
    "cc[- ]?by",
  ].join("|"),
  "i"
);

const SELF_HOST_IS_FREE = [
  /self[- ]?host(?:ed|able|ing)?[^.;]{0,60}\b(?:free|no limits|unlimited)\b/i,
  /\b(?:free|unlimited|no limits)\b[^.;]{0,60}self[- ]?host(?:ed|able|ing)?/i,
  /\bself[- ]?host(?:able)?\s+open[- ]?source\s+version\b/i,
  /\bopen[- ]?source\s+version\b[^.;]{0,40}\b(?:free|available)\b/i,
];

const FREE_FOR_OSS_USERS = [
  /\bfree\b[^.;]{0,40}\bfor\s+(?:public\s+repos|open[- ]?source|foss|oss)\b/i,
  /\bfor\s+open[- ]?source\s+(?:projects|maintainers|repos)\b/i,
  /\bopen[- ]?source\s+(?:plan|program|sponsorship)\b/i,
];

const OSS_AS_OBJECT = [
  /\bopen[- ]?source\s+(?:sca|scans?|tests?|dependenc\w+|packages?|librar\w+|vulnerabilit\w+)\b/i,
  /\bgpt[- ]?oss\b/i,
  /\b(?:support|remote support|concurrent|user|seat|device)\s+licen[cs]es?\b/i,
  /\blicen[cs]es?\s+(?:available|included)\b/i,
  /\bopen[- ]?source\s+\w+\s+alternative\b/i,
];

const matchesAny = (patterns, text) => patterns.some((pattern) => pattern.test(text ?? ""));

export function broadSignals(offer) {
  const tags = (offer?.tags ?? []).join(" ");
  return {
    tier: BROAD.test(offer?.tier ?? ""),
    description: BROAD.test(offer?.description ?? ""),
    tags: BROAD.test(tags),
  };
}

export function matchesBroadClassifier(offer) {
  return Object.values(broadSignals(offer)).some(Boolean);
}

export function licenceEvidence(offer) {
  const tier = offer?.tier ?? "";
  const description = offer?.description ?? "";
  return {
    tier_names_a_licence_ground: LICENCE_TIER.test(tier),
    description_names_a_licence: NAMED_LICENCE.test(description),
    description_says_self_hosting_is_free: matchesAny(SELF_HOST_IS_FREE, description),
  };
}

export function incidentalEvidence(offer) {
  const description = offer?.description ?? "";
  return {
    free_for_open_source_users: matchesAny(FREE_FOR_OSS_USERS, description),
    open_source_is_the_object_not_the_grant: matchesAny(OSS_AS_OBJECT, description),
  };
}

export function freeByLicence(offer) {
  return Object.values(licenceEvidence(offer)).some(Boolean);
}

export function incidentalOnly(offer) {
  return (
    matchesBroadClassifier(offer) &&
    !freeByLicence(offer) &&
    Object.values(incidentalEvidence(offer)).some(Boolean)
  );
}

const NARROWING_TYPES = new Set([
  "free_tier_removed",
  "limits_reduced",
  "restriction",
  "open_source_killed",
  "pricing_restructured",
  "pricing_model_change",
]);

const isLive = (change) => !change?.resolution;

export function census(offers, changes) {
  const broad = offers.filter(matchesBroadClassifier);
  const precise = offers.filter(freeByLicence);
  const incidental = offers.filter(incidentalOnly);
  const vendorsBroad = new Set(broad.map((o) => o.vendor));
  const vendorsPrecise = new Set(precise.map((o) => o.vendor));

  const live = changes.filter(isLive);
  const narrowing = live.filter((c) => NARROWING_TYPES.has(c.change_type) && c.date >= "2026-01-01");
  const removals = live.filter((c) => c.change_type === "free_tier_removed");

  const inPopulation = (set) => (c) => set.has(c.vendor);
  const byRead = (c) => c.date_source === "discovered";

  return {
    offers: offers.length,
    broad: broad.length,
    precise: precise.length,
    incidental_only: incidental.length,
    tier_only: offers.filter((o) => licenceEvidence(o).tier_names_a_licence_ground).length,
    narrowing_2026: {
      broad: narrowing.filter(inPopulation(vendorsBroad)).length,
      precise: narrowing.filter(inPopulation(vendorsPrecise)).length,
    },
    removals_live: {
      all: removals.length,
      broad: removals.filter(inPopulation(vendorsBroad)).length,
      precise: removals.filter(inPopulation(vendorsPrecise)).length,
      precise_from_a_page_read: removals.filter(inPopulation(vendorsPrecise)).filter(byRead).length,
    },
    removal_records: removals
      .filter(inPopulation(vendorsBroad))
      .map((c) => ({
        vendor: c.vendor,
        date: c.date,
        date_source: c.date_source,
        detected_by: c.detected_by ?? null,
        source_url: c.source_url,
        free_by_licence: vendorsPrecise.has(c.vendor),
        offer_tier: offers.find((o) => o.vendor === c.vendor)?.tier ?? null,
      }))
      .sort((a, b) => a.vendor.localeCompare(b.vendor)),
    incidental_examples: incidental.slice(0, 12).map((o) => ({
      vendor: o.vendor,
      tier: o.tier,
      why: Object.entries(incidentalEvidence(o))
        .filter(([, hit]) => hit)
        .map(([name]) => name),
    })),
  };
}

function main() {
  const offers = JSON.parse(readFileSync(INDEX_PATH, "utf8")).offers;
  const changes = JSON.parse(readFileSync(CHANGES_PATH, "utf8")).changes;
  const report = census(offers, changes);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

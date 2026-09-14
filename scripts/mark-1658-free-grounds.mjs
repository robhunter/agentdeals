#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FREE_GROUND_LICENCE, FREE_GROUND_PLAN } from "./change-gate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH =
  process.env.AGENTDEALS_INDEX_PATH || resolve(__dirname, "..", "data", "index.json");

const TIER_NAMES_A_LICENCE_GROUND =
  /\boss\b|open[- ]?source|\bcommunity\b|self[- ]?host(?:ed|ing|able)?|a?gpl|\bmpl\b|apache|\bbsd\b/i;

export const TIER_SAYS_OSS_BUT_THE_FREE_THING_IS_NOT_THE_LICENCE = new Set([
  "1Password",
  "BrowserStack",
  "Clarifai",
  "Highlight.io",
  "JetBrains",
  "Sauce Labs",
  "Semaphore CI",
  "Sentry",
  "VirusTotal",
]);

export const LICENCE_FREE_BEYOND_THE_TIER_STRING = new Set([
  "Circum Icons",
  "Logto",
  "Penpot",
  "Rybbit",
  "SuperTokens",
  "Xata",
  "openobserve.ai",
]);

const A_FREE_HOSTED_PLAN = [
  /\bcloud(?:-hosted)?:?\s*(?:permanent\s+)?free\b/i,
  /\bcloud\s+free\s+(?:tier|plan)\b/i,
  /\b(?:free|permanent free)\s+(?:cloud\s+)?tier\s+(?:with|includes?|has)\b/i,
  /\bfree\s+hosted\b/i,
  /\bfree\s+plans?\s+has\b/i,
  /\bhosted\s+free\s+tier\b/i,
  /\b\d[\d,.]*\s*[kmb]?\s*maus?\s+free\b/i,
  /\bfree\s*\(cloud\)/i,
];

export function tierNamesALicenceGround(offer) {
  return TIER_NAMES_A_LICENCE_GROUND.test(offer?.tier ?? "");
}

export function isLicenceFree(offer) {
  if (TIER_SAYS_OSS_BUT_THE_FREE_THING_IS_NOT_THE_LICENCE.has(offer?.vendor)) return false;
  return tierNamesALicenceGround(offer) || LICENCE_FREE_BEYOND_THE_TIER_STRING.has(offer?.vendor);
}

export function alsoHasAFreeHostedPlan(offer) {
  const description = offer?.description ?? "";
  return A_FREE_HOSTED_PLAN.some((pattern) => pattern.test(description));
}

export function groundsFor(offer) {
  if (!isLicenceFree(offer)) return null;
  const grounds = [FREE_GROUND_LICENCE];
  if (alsoHasAFreeHostedPlan(offer)) grounds.push(FREE_GROUND_PLAN);
  return grounds;
}

export function markOffers(offers) {
  const marked = [];
  for (const offer of offers) {
    const grounds = groundsFor(offer);
    if (!grounds) continue;
    offer.free_grounds = grounds;
    marked.push({ vendor: offer.vendor, tier: offer.tier, free_grounds: grounds });
  }
  return marked;
}

function main() {
  const apply = process.argv.includes("--apply");
  const index = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
  const marked = markOffers(index.offers);
  const withPlan = marked.filter((m) => m.free_grounds.includes(FREE_GROUND_PLAN));
  process.stdout.write(
    `${JSON.stringify(
      {
        offers: index.offers.length,
        marked: marked.length,
        licence_only: marked.length - withPlan.length,
        licence_and_plan: withPlan.length,
        excluded_by_hand: [...TIER_SAYS_OSS_BUT_THE_FREE_THING_IS_NOT_THE_LICENCE].sort(),
        added_by_hand: [...LICENCE_FREE_BEYOND_THE_TIER_STRING].sort(),
        records: marked.sort((a, b) => a.vendor.localeCompare(b.vendor)),
      },
      null,
      2
    )}\n`
  );
  if (apply) {
    writeFileSync(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`);
    process.stdout.write(`wrote ${INDEX_PATH}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

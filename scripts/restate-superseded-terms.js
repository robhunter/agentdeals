#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isoDay } from "./change-log.js";
import { offerKey } from "./change-refusals.js";
import { loadDealChanges } from "../dist/data.js";
import { changesByVendor } from "../dist/superseded-census.js";
import { RESTATEMENT_REFUSALS, restatementRulings, withheldTermsMeasure } from "../dist/restatement.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function indexPath() {
  return process.env.AGENTDEALS_INDEX_PATH || resolve(__dirname, "..", "data", "index.json");
}

export function restatementsPath() {
  return process.env.AGENTDEALS_RESTATED_PATH || resolve(__dirname, "..", "data", "restated_terms.json");
}

export function readRestatements(path = restatementsPath()) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(parsed?.restatements) ? parsed.restatements : [];
  } catch {
    return [];
  }
}

export function writeRestatements(entries, options = {}) {
  const path = options.path ?? restatementsPath();
  if (options.dryRun) return { path, entries };
  writeFileSync(path, JSON.stringify({ restatements: entries }, null, 2) + "\n");
  return { path, entries };
}

export function restatementEntry(ruling, today) {
  const { offer, change, reading, restatement } = ruling;
  return {
    vendor: offer.vendor,
    url: offer.url,
    restated_on: restatement?.restated_on ?? today,
    previous_description: offer.description,
    description: reading.terms,
    reading_date: reading.date,
    source_url: reading.url,
    record_date: change.date,
    change_type: change.change_type,
    summary: change.summary ?? null,
  };
}

export function rulingsOver(offers, today) {
  const byVendor = changesByVendor(loadDealChanges());
  return restatementRulings(offers, (offer) => byVendor.get(offer.vendor.toLowerCase()) ?? [], today);
}

export function applyRestatements(data, rulings, today, limit = Infinity) {
  const written = [];
  const byKey = new Map(
    (data.offers ?? []).map((offer, index) => [offerKey(offer.vendor, offer.url), index]),
  );
  for (const ruling of rulings) {
    if (written.length >= limit) break;
    if (ruling.refusal) continue;
    const index = byKey.get(offerKey(ruling.offer.vendor, ruling.offer.url));
    if (index === undefined) continue;
    written.push(restatementEntry(ruling, today));
    data.offers[index].description = ruling.reading.terms;
    data.offers[index].restated_from = ruling.restatement;
  }
  return written;
}

export function newestRestatementFor(entries, vendor) {
  const named = entries.filter((entry) => entry.vendor.toLowerCase() === vendor.toLowerCase());
  return named.sort((a, b) => a.restated_on.localeCompare(b.restated_on)).pop() ?? null;
}

export function revertRestatement(data, entries, vendor) {
  const entry = newestRestatementFor(entries, vendor);
  if (!entry) return { entry: null, reverted: false };
  const offer = (data.offers ?? []).find(
    (candidate) => offerKey(candidate.vendor, candidate.url) === offerKey(entry.vendor, entry.url),
  );
  if (!offer) return { entry, reverted: false };
  offer.description = entry.previous_description;
  delete offer.restated_from;
  return { entry, reverted: true, left: entries.filter((held) => held !== entry) };
}

export function refusalLines(measure) {
  const lines = [];
  for (const reason of RESTATEMENT_REFUSALS) {
    lines.push(`  refused, ${reason}: ${measure.offers_we_refuse_to_restate[reason] ?? 0}`);
  }
  return lines;
}

export function summaryLines(measure, written, path) {
  return [
    "",
    "── Summary ──",
    `Offers withholding their stored terms behind a sourced reading: ` +
      `${measure.offers_we_may_restate_from_their_reading + Object.values(measure.offers_we_refuse_to_restate).reduce((a, b) => a + b, 0)}`,
    `We may restate from that reading: ${measure.offers_we_may_restate_from_their_reading}`,
    ...refusalLines(measure),
    `Re-read since the record and still withheld: ${measure.offers_re_read_since_the_record_and_still_withheld}`,
    `Restated this run: ${written.length}`,
    `Restatements recorded in ${path}`,
  ];
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;
  if (limitIdx !== -1 && (isNaN(limit) || limit < 1)) {
    console.error(`Invalid limit: ${args[limitIdx + 1]}. Must be a positive integer.`);
    process.exit(2);
  }
  const revertIdx = args.indexOf("--revert");
  const revert = revertIdx !== -1 ? args[revertIdx + 1] : null;

  const path = indexPath();
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    console.error(`Failed to read index: ${err.message}`);
    process.exit(2);
  }

  const today = isoDay(new Date());
  const held = readRestatements();

  if (revert) {
    const { entry, reverted, left } = revertRestatement(data, held, revert);
    if (!entry) {
      console.error(`No restatement recorded for ${revert}.`);
      process.exit(2);
    }
    if (!reverted) {
      console.error(`${revert} was restated on ${entry.restated_on} but is no longer in the index.`);
      process.exit(2);
    }
    if (!dryRun) {
      writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
      writeRestatements(left);
    }
    console.log(`Reverted ${entry.vendor} to the terms we stored before ${entry.restated_on}.`);
    console.log(`  restored: ${entry.previous_description}`);
    process.exit(0);
  }

  const rulings = rulingsOver(data.offers ?? [], today);
  const measure = withheldTermsMeasure(rulings);
  const written = applyRestatements(data, rulings, today, limit);

  for (const entry of written) {
    console.log(`  ✎ ${entry.vendor} restated from ${entry.source_url} as read on ${entry.reading_date}`);
    console.log(`      was: ${entry.previous_description}`);
    console.log(`      now: ${entry.description}`);
  }

  const store = writeRestatements([...held, ...written], { dryRun });
  if (!dryRun && written.length > 0) {
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  }
  for (const line of summaryLines(measure, written, store.path)) console.log(line);
  process.exit(0);
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main().catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}

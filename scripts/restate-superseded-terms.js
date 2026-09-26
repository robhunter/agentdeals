#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isoDay } from "./change-log.js";
import { offerKey } from "./change-refusals.js";
import {
  corroborationPath,
  readHeldReadings,
  releaseReadingsWhoseBaselineMoved,
  writeHeldReadings,
} from "./change-corroboration.js";
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
    description: ruling.description,
    reading_date: reading.date,
    reading_terms: reading.terms,
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
    data.offers[index].description = ruling.description;
    data.offers[index].restated_from = ruling.restatement;
  }
  return written;
}

export function termsTheWriteWouldPublish(rulings) {
  return new Map(
    rulings
      .filter((ruling) => !ruling.refusal)
      .map((ruling) => [offerKey(ruling.offer.vendor, ruling.offer.url), ruling.description]),
  );
}

export function termsTheWriteDidPublish(written) {
  return new Map(written.map((entry) => [offerKey(entry.vendor, entry.url), entry.description]));
}

export function releaseHeldReadingsBehind(storedTerms, options = {}) {
  const path = options.path ?? corroborationPath();
  const store = readHeldReadings(path);
  const { stillHeld, resolutions } = releaseReadingsWhoseBaselineMoved(store.held, storedTerms, {
    now: options.now ?? new Date(),
  });
  if (resolutions.length === 0) return { resolutions, path, written: false };
  const outcome = writeHeldReadings(stillHeld, [...store.resolved, ...resolutions], {
    dryRun: options.dryRun,
    now: options.now ?? new Date(),
    path,
  });
  return { resolutions, path, written: outcome.written };
}

export function releaseLines(resolutions) {
  if (resolutions.length === 0) return ["No reading was being held against terms this run replaces."];
  return [
    `Readings released because this run replaced the terms they were read against: ${resolutions.length}`,
    ...resolutions.map(({ vendor, change_type }) => `  ⇥ ${vendor} (${change_type}) released as baseline_moved`),
  ];
}

export function standingRestatements(entries) {
  return entries.filter((entry) => !entry.reverted_on);
}

export function newestStandingRestatements(entries) {
  const newest = new Map();
  for (const entry of standingRestatements(entries)) {
    const key = offerKey(entry.vendor, entry.url);
    const held = newest.get(key);
    if (!held || entry.restated_on > held.restated_on) newest.set(key, entry);
  }
  return newest;
}

export function theIndexPublishes(offer, entry) {
  return offer?.restated_from?.restated_on === entry.restated_on && offer?.description === entry.description;
}

export function restatementsTheIndexNeverTook(entries, offers) {
  const published = new Map((offers ?? []).map((offer) => [offerKey(offer.vendor, offer.url), offer]));
  return [...newestStandingRestatements(entries)]
    .filter(([key, entry]) => published.has(key) && !theIndexPublishes(published.get(key), entry))
    .map(([, entry]) => entry);
}

export function restatementsWrittenAgain(entries) {
  const first = new Set();
  const again = [];
  for (const entry of standingRestatements(entries)) {
    const reading = `${offerKey(entry.vendor, entry.url)}|${entry.reading_date}|${entry.description}`;
    if (first.has(reading)) again.push(entry);
    else first.add(reading);
  }
  return again;
}

export function newestRestatementFor(entries, vendor) {
  const named = standingRestatements(entries).filter(
    (entry) => entry.vendor.toLowerCase() === vendor.toLowerCase(),
  );
  return named.sort((a, b) => a.restated_on.localeCompare(b.restated_on)).pop() ?? null;
}

export function restatementStandingBefore(entries, entry) {
  return (
    standingRestatements(entries)
      .filter(
        (held) =>
          held !== entry &&
          offerKey(held.vendor, held.url) === offerKey(entry.vendor, entry.url) &&
          held.restated_on < entry.restated_on,
      )
      .sort((a, b) => a.restated_on.localeCompare(b.restated_on))
      .pop() ?? null
  );
}

export function restatedFromPointer(entry) {
  return {
    reading_date: entry.reading_date,
    source_url: entry.source_url,
    record_date: entry.record_date,
    change_type: entry.change_type,
    restated_on: entry.restated_on,
  };
}

export function putTheStoredTermsBack(data, entry, today, entries = []) {
  const offer = (data.offers ?? []).find(
    (candidate) => offerKey(candidate.vendor, candidate.url) === offerKey(entry.vendor, entry.url),
  );
  if (!offer) return null;
  offer.description = entry.previous_description;
  const stillStanding = restatementStandingBefore(entries, entry);
  if (stillStanding) offer.restated_from = restatedFromPointer(stillStanding);
  else delete offer.restated_from;
  offer.restatement_reverted = { record_date: entry.record_date, reverted_on: today };
  return { ...entry, reverted_on: today };
}

export function withTheRevertRecorded(entries, entry, recorded) {
  return entries.map((held) => (held === entry ? recorded : held));
}

export function revertRestatement(data, entries, vendor, today) {
  const entry = newestRestatementFor(entries, vendor);
  if (!entry) return { entry: null, reverted: false };
  const recorded = putTheStoredTermsBack(data, entry, today ?? entry.restated_on, entries);
  if (!recorded) return { entry, reverted: false };
  return { entry, reverted: true, left: withTheRevertRecorded(entries, entry, recorded) };
}

export function restatementsFrom(entries, day) {
  return standingRestatements(entries).filter((entry) => entry.restated_on === day);
}

export function aLaterRunRestatedThisAgain(entries, entry) {
  return standingRestatements(entries).some(
    (held) =>
      held !== entry &&
      offerKey(held.vendor, held.url) === offerKey(entry.vendor, entry.url) &&
      held.restated_on > entry.restated_on,
  );
}

export function revertRun(data, entries, day, today) {
  const written = restatementsFrom(entries, day);
  const reverted = [];
  const supersededBefore = [];
  const gone = [];
  let left = entries;
  for (const entry of written) {
    if (aLaterRunRestatedThisAgain(entries, entry)) {
      supersededBefore.push(entry);
      continue;
    }
    const recorded = putTheStoredTermsBack(data, entry, today ?? day, entries);
    if (!recorded) {
      gone.push(entry);
      continue;
    }
    left = withTheRevertRecorded(left, entry, recorded);
    reverted.push(entry);
  }
  return { written, reverted, supersededBefore, gone, left };
}

export function revertRunLines(day, outcome) {
  const lines = [`Reverted ${outcome.reverted.length} of the ${outcome.written.length} entries restated on ${day}.`];
  for (const entry of outcome.reverted) {
    lines.push(`  ⇤ ${entry.vendor} restored to the terms we stored before ${day}`);
  }
  for (const entry of outcome.supersededBefore) {
    lines.push(
      `  ⇥ ${entry.vendor} left alone — a later run restated it again, so revert that run first`,
    );
  }
  for (const entry of outcome.gone) {
    lines.push(`  ⇥ ${entry.vendor} left alone — it is no longer in the index`);
  }
  return lines;
}

export function refusalLines(measure) {
  const lines = [];
  for (const reason of RESTATEMENT_REFUSALS) {
    lines.push(`  refused, ${reason}: ${measure.offers_we_refuse_to_restate[reason] ?? 0}`);
  }
  return lines;
}

export function openingLine(measure) {
  const keeping = measure.restatements_keeping_the_stored_sentence_saying_what_the_product_is ?? 0;
  return (
    `  keeping the stored sentence saying what the product is: ${keeping}` +
    ` of ${measure.offers_we_may_restate_from_their_reading}`
  );
}

export function summaryLines(measure, written, path) {
  return [
    "",
    "── Summary ──",
    `Offers withholding their stored terms behind a sourced reading: ` +
      `${measure.offers_we_may_restate_from_their_reading + Object.values(measure.offers_we_refuse_to_restate).reduce((a, b) => a + b, 0)}`,
    `We may restate from that reading: ${measure.offers_we_may_restate_from_their_reading}`,
    openingLine(measure),
    ...refusalLines(measure),
    `Re-read since the record and still withheld: ${measure.offers_re_read_since_the_record_and_still_withheld}`,
    `Restated this run: ${written.length}`,
    `Restatements recorded in ${path}`,
  ];
}

export function reportOnlyLines(measure) {
  return [
    "",
    "── Summary ──",
    `We may restate from that reading: ${measure.offers_we_may_restate_from_their_reading}`,
    openingLine(measure),
    ...refusalLines(measure),
    `Re-read since the record and still withheld: ${measure.offers_re_read_since_the_record_and_still_withheld}`,
    "Restated this run: 0",
    "Run again with --write to store those readings as our terms.",
  ];
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes("--write");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;
  if (limitIdx !== -1 && (isNaN(limit) || limit < 1)) {
    console.error(`Invalid limit: ${args[limitIdx + 1]}. Must be a positive integer.`);
    process.exit(2);
  }
  const revertIdx = args.indexOf("--revert");
  const revert = revertIdx !== -1 ? args[revertIdx + 1] : null;
  const revertRunIdx = args.indexOf("--revert-run");
  const revertDay = revertRunIdx !== -1 ? args[revertRunIdx + 1] : null;
  if (revertRunIdx !== -1 && !/^\d{4}-\d{2}-\d{2}$/.test(revertDay ?? "")) {
    console.error(`Invalid day: ${revertDay}. --revert-run takes the YYYY-MM-DD a run recorded.`);
    process.exit(2);
  }

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

  if (revertDay) {
    const outcome = revertRun(data, held, revertDay, today);
    if (outcome.written.length === 0) {
      console.error(`No restatement was recorded on ${revertDay}.`);
      process.exit(2);
    }
    if (outcome.reverted.length > 0) {
      writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
      writeRestatements(outcome.left);
    }
    for (const line of revertRunLines(revertDay, outcome)) console.log(line);
    process.exit(outcome.reverted.length === outcome.written.length ? 0 : 1);
  }

  if (revert) {
    const { entry, reverted, left } = revertRestatement(data, held, revert, today);
    if (!entry) {
      console.error(`No restatement recorded for ${revert}.`);
      process.exit(2);
    }
    if (!reverted) {
      console.error(`${revert} was restated on ${entry.restated_on} but is no longer in the index.`);
      process.exit(2);
    }
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
    writeRestatements(left);
    console.log(`Reverted ${entry.vendor} to the terms we stored before ${entry.restated_on}.`);
    console.log(`  restored: ${entry.previous_description}`);
    process.exit(0);
  }

  const rulings = rulingsOver(data.offers ?? [], today);
  const measure = withheldTermsMeasure(rulings);

  if (dryRun) {
    const wouldRelease = releaseHeldReadingsBehind(termsTheWriteWouldPublish(rulings), { dryRun: true });
    for (const line of reportOnlyLines(measure)) console.log(line);
    for (const line of releaseLines(wouldRelease.resolutions)) console.log(line);
    process.exit(0);
  }

  const written = applyRestatements(data, rulings, today, limit);

  for (const entry of written) {
    console.log(`  ✎ ${entry.vendor} restated from ${entry.source_url} as read on ${entry.reading_date}`);
    console.log(`      was: ${entry.previous_description}`);
    console.log(`      now: ${entry.description}`);
  }

  const released = releaseHeldReadingsBehind(termsTheWriteDidPublish(written));
  const store = writeRestatements([...held, ...written]);
  if (written.length > 0) writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  for (const line of summaryLines(measure, written, store.path)) console.log(line);
  for (const line of releaseLines(released.resolutions)) console.log(line);
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

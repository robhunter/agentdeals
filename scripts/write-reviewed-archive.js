import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { bracketStatesRecord } from "./archive-captures.js";
import { reviewKey } from "../dist/change-direction-review.js";
import { CHANGES_PATH, readChangeLog } from "./change-log.js";
import { correctionUsesListingPage, needsArchiveCheck, recordKey } from "./settle-discovered-records.js";
import { writeSettledRecords } from "./write-settled-records.js";

export function reviewedRecordKey(record) {
  return JSON.stringify([record.vendor, record.date, record.change_type]);
}

function reviewedDisposition(record, result, today, key) {
  if (!isDeepStrictEqual(record, result.expected_record)) throw new Error(`reviewed disposition record changed: ${key}`);
  if (record.archive_check?.outcome !== "vendor_changed") throw new Error(`reviewed disposition requires a published vendor change: ${key}`);
  if (result.outcome === "no_usable_capture") {
    if (result.brackets !== undefined) throw new Error(`an unsettled disposition cannot retain brackets: ${key}`);
    return { ...record, archive_check: { checked: today, outcome: result.outcome } };
  }
  if (result.outcome !== "vendor_changed") throw new Error(`a reviewed disposition may only drop brackets or unsettle a record: ${key}`);
  const existing = record.archive_check.brackets;
  const retained = result.brackets;
  if (!Array.isArray(existing) || !Array.isArray(retained) || retained.length === 0 || retained.length >= existing.length) throw new Error(`a bracket disposition must retain a proper nonempty subset: ${key}`);
  const indices = retained.map((bracket) => existing.findIndex((held) => isDeepStrictEqual(held, bracket)));
  if (indices.some((at, index) => at < 0 || (index > 0 && at <= indices[index - 1]))) throw new Error(`a bracket disposition must preserve the retained brackets exactly and in order: ${key}`);
  return { ...record, archive_check: { ...record.archive_check, checked: today, brackets: retained } };
}

export function writeReviewedArchive(changes, report, offers) {
  if (![1, 2, 3, 4].includes(report.version) || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:pull|issues)\/\d+#issuecomment-\d+$/.test(report.review_url ?? "")) throw new Error("a reviewed report must identify its approval");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(report.today ?? "")) throw new Error("a reviewed report must give its reading day");
  if (!Array.isArray(report.results) || report.results.length === 0) throw new Error("a reviewed report must name its approved records");
  const seen = new Set();
  const results = report.results.map((result) => {
    const key = reviewedRecordKey(result);
    if (seen.has(key)) throw new Error(`duplicate reviewed key: ${key}`);
    seen.add(key);
    const matches = changes.filter((record) => reviewedRecordKey(record) === key);
    if (matches.length !== 1) throw new Error(`expected one current record for reviewed key ${key}, found ${matches.length}`);
    const [record] = matches;
    if (record.resolution) throw new Error(`reviewed record is already settled or no longer in force: ${key}`);
    if (report.version === 4) {
      const { operation, ...approved } = result;
      const version = operation === "vendor_change" ? 2 : operation === "disposition" ? 3 : null;
      if (!version) throw new Error(`a mixed report requires an explicit vendor_change or disposition operation: ${key}`);
      const written = writeReviewedArchive(changes, { ...report, version, results: [approved] }, offers);
      const index = changes.indexOf(record);
      return { index, record: written.changes[index], written: written.written[0] };
    }
    if (report.version === 3) return reviewedDisposition(record, result, report.today, key);
    if (!needsArchiveCheck(record)) throw new Error(`reviewed record is already settled or no longer in force: ${key}`);
    if (report.version === 2) {
      if (result.outcome !== "vendor_changed") throw new Error(`only reviewed vendor changes may be written: ${key}`);
      if (!isDeepStrictEqual(record, result.expected_record)) throw new Error(`reviewed vendor record changed: ${key}`);
      if (!Array.isArray(result.brackets) || result.brackets.length === 0 || result.brackets.some((bracket) => !bracketStatesRecord(bracket))) throw new Error(`reviewed vendor change lacks both endpoint claims: ${key}`);
      for (const bracket of result.brackets) {
        const { older, newer } = bracket.claim_proof;
        const oldEndpointMatches = /^\d{4}-\d{2}-\d{2}$/.test(bracket.last_old) && older.day === bracket.last_old && older.url === bracket.last_old_capture && older.url;
        const newEndpointMatches = newer.day === (bracket.first_new ?? report.today) && newer.url === bracket.first_new_capture && newer.day > older.day;
        const newCaptureMatches = bracket.first_new === null ? bracket.first_new_capture === null : /^\d{4}-\d{2}-\d{2}$/.test(bracket.first_new) && newer.url;
        if (!oldEndpointMatches || !newEndpointMatches || !newCaptureMatches) throw new Error(`reviewed endpoint identity differs from its bracket: ${key}`);
      }
      const dated = result.brackets.map((bracket) => bracket.first_new ?? report.today).sort()[0];
      if (result.date_from_captures !== dated) throw new Error(`reviewed date differs from its brackets: ${key}`);
      if (record.source_url !== result.source_url) throw new Error(`reviewed source differs from the approved record: ${key}`);
      return { ...result, record_key: recordKey(record) };
    }
    if (result.outcome !== "ours") throw new Error(`only reviewed corrections may be written: ${key}`);
    if (!correctionUsesListingPage(record, offers) || record.source_url !== result.source_url) throw new Error(`reviewed source is not the current listing page: ${key}`);
    if (!result.capture?.url || !result.capture?.day || !result.stated_then?.length || !result.readings?.length || !result.historical_proof?.readings?.some((reading) => reading.verdict?.status === "stated" && reading.verdict.stated_then?.length)) throw new Error(`reviewed correction lacks saved readings: ${key}`);
    return { ...result, record_key: recordKey(record) };
  });
  if (report.version === 4) {
    const replacements = new Map(results.map(({ index, record }) => [index, record]));
    return {
      changes: changes.map((record, index) => replacements.get(index) ?? record),
      written: results.map(({ written }) => written),
      not_written: [],
      review: [],
    };
  }
  if (report.version === 3) {
    const replacements = new Map(results.map((record) => [reviewedRecordKey(record), record]));
    return {
      changes: changes.map((record) => replacements.get(reviewedRecordKey(record)) ?? record),
      written: results.map(({ vendor, date, change_type, archive_check }) => ({ vendor, date, change_type, outcome: archive_check.outcome })),
      not_written: [],
      review: [],
    };
  }
  const written = writeSettledRecords(changes, [{ ...report, results }], { holdVendorChanges: report.version !== 2 });
  if (written.written.length !== results.length || written.not_written.length) throw new Error("the reviewed report was not written in full");
  return written;
}

export function directionReviewsAfterWrite(review, before, after) {
  if (!Array.isArray(review?.directions)) throw new Error("the direction review must contain a directions array");
  const held = new Set(before.map(reviewKey));
  const remaining = new Set(after.map(reviewKey));
  return { ...review, directions: review.directions.filter((entry) => !held.has(reviewKey(entry)) || remaining.has(reviewKey(entry))) };
}

function main() {
  const [file, ...extra] = process.argv.slice(2);
  if (!file || extra.length) throw new Error("give one committed reviewed report: node scripts/write-reviewed-archive.js <report.json>");
  const committed = execFileSync("git", ["show", `HEAD:${file}`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (readFileSync(resolve(file), "utf8") !== committed) throw new Error("the reviewed report differs from its committed bytes");
  const report = JSON.parse(committed);
  const log = readChangeLog(CHANGES_PATH);
  const offers = JSON.parse(readFileSync("data/index.json", "utf8")).offers;
  const written = writeReviewedArchive(log.changes, report, offers);
  const directionsPath = process.env.AGENTDEALS_CHANGE_DIRECTIONS_PATH || resolve("data/change_directions.json");
  const hasDirections = existsSync(directionsPath);
  const review = hasDirections ? JSON.parse(readFileSync(directionsPath, "utf8")) : null;
  const directions = hasDirections ? directionReviewsAfterWrite(review, log.changes, written.changes) : null;
  writeFileSync(CHANGES_PATH, JSON.stringify({ ...log, changes: written.changes }, null, 2) + "\n");
  if (directions && directions.directions.length !== review.directions.length) {
    writeFileSync(directionsPath, JSON.stringify(directions, null, 2) + "\n");
    console.log(`Retired ${review.directions.length - directions.directions.length} direction reviews of replaced records`);
  }
  console.log(`Wrote exactly ${written.written.length} reviewed ${report.version === 4 ? "operations" : report.version === 3 ? "dispositions" : report.version === 2 ? "vendor changes" : "corrections"} from ${file}`);
  for (const record of written.written) console.log(`${record.vendor} ${record.date} ${record.change_type}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (error) { console.error(error?.message ?? error); process.exitCode = 1; }
}

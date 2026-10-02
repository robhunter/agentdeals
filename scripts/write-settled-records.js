import { readFileSync, writeFileSync } from "node:fs";
import { CHANGES_PATH, CORRECTION_TO_OUR_OWN_RECORD, readChangeLog } from "./change-log.js";
import { recordKey, reviewList, worthAskingAgain } from "./settle-discovered-records.js";
import { differenceInOurTextSummary, OURS_ARCHIVE_OUTCOME } from "../dist/change-confirmation.js";

export const STATED_THEN_SEPARATOR = " · ";

export const NOT_WRITTEN = {
  askedAgain: "the reader failed or the Archive did not answer: the next run asks again",
  noRecordKey: "the result names no record key",
  noSuchRecord: "no record of this vendor has this key",
  severalRecords: "more than one record of this vendor has this key",
  alreadyChecked: "the record already carries an archive check",
  noLongerInForce: "the record is retracted or reversed",
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function storedBracket({ last_old, first_new, last_old_capture = null, first_new_capture = null }) {
  return { last_old, first_new, last_old_capture, first_new_capture };
}

function theCopyFromOurTextDay(result) {
  return {
    capture_day: result.capture.day,
    capture: result.capture.url,
    stated_then: result.stated_then.map((line) => line.old).join(STATED_THEN_SEPARATOR),
  };
}

export function archiveCheckFor(record, result, checked) {
  const check = { checked, outcome: result.outcome };
  if (result.outcome === "vendor_changed") return { ...check, brackets: result.brackets.map(storedBracket) };
  if (result.outcome === OURS_ARCHIVE_OUTCOME) {
    const { capture_day, capture, stated_then } = theCopyFromOurTextDay(result);
    return { ...check, capture_day, recorded_as: record.change_type, capture, stated_then };
  }
  if (result.outcome === "removal_stated_before") return { ...check, ...theCopyFromOurTextDay(result) };
  return check;
}

export function dayTheCapturesDateItTo(record, result) {
  const day = result.outcome === "vendor_changed" ? result.date_from_captures : null;
  return day && day < record.date ? day : null;
}

export function settledRecord(record, result, checked) {
  const archive_check = archiveCheckFor(record, result, checked);
  if (result.outcome === OURS_ARCHIVE_OUTCOME) {
    return {
      ...record,
      change_type: CORRECTION_TO_OUR_OWN_RECORD,
      summary: differenceInOurTextSummary({
        vendor: record.vendor,
        capture_day: result.capture.day,
        text_day: result.text_day,
        record_date: record.recorded_date ?? record.date,
      }),
      archive_check,
    };
  }
  const datedTo = dayTheCapturesDateItTo(record, result);
  return { ...record, ...(datedTo ? { date: datedTo } : {}), archive_check };
}

function vendorAndKey(vendor, key) {
  return JSON.stringify([vendor, key]);
}

function recordsByVendorAndKey(changes) {
  const found = new Map();
  for (const [at, change] of changes.entries()) {
    const key = vendorAndKey(change.vendor, recordKey(change));
    found.set(key, [...(found.get(key) ?? []), at]);
  }
  return found;
}

function whyNotWritten(result, matches, changes) {
  if (worthAskingAgain(result)) return NOT_WRITTEN.askedAgain;
  if (!result.record_key) return NOT_WRITTEN.noRecordKey;
  if (matches.length === 0) return NOT_WRITTEN.noSuchRecord;
  if (matches.length > 1) return NOT_WRITTEN.severalRecords;
  if (changes[matches[0]].archive_check) return NOT_WRITTEN.alreadyChecked;
  if (changes[matches[0]].resolution) return NOT_WRITTEN.noLongerInForce;
  return null;
}

export function writeSettledRecords(changes, reports) {
  const matching = recordsByVendorAndKey(changes);
  const settled = [...changes];
  const written = [];
  const writtenResults = [];
  const notWritten = [];
  for (const report of reports) {
    if (!ISO_DAY.test(String(report.today))) throw new Error(`a settle report must give the day it ran as today; got ${report.today}`);
    for (const result of report.results) {
      const subject = { vendor: result.vendor, date: result.date, change_type: result.change_type, outcome: result.outcome };
      const matches = matching.get(vendorAndKey(result.vendor, result.record_key)) ?? [];
      const why = whyNotWritten(result, matches, settled);
      if (why) {
        notWritten.push({ ...subject, why });
        continue;
      }
      const [at] = matches;
      settled[at] = settledRecord(settled[at], result, report.today);
      written.push({
        ...subject,
        ...(settled[at].date !== result.date ? { dated: settled[at].date } : {}),
        ...(settled[at].change_type !== result.change_type ? { retyped: settled[at].change_type } : {}),
      });
      writtenResults.push(result);
    }
  }
  return { changes: settled, written, not_written: notWritten, review: reviewList(writtenResults) };
}

export function countsByOutcome(entries) {
  const counts = new Map();
  for (const { outcome } of entries) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function main() {
  const reportFiles = process.argv.slice(2);
  if (reportFiles.length === 0) throw new Error("give one or more settle reports: node scripts/write-settled-records.js settled-first-readings.json");
  const log = readChangeLog(CHANGES_PATH);
  const reports = reportFiles.map((file) => JSON.parse(readFileSync(file, "utf-8")));
  const { changes, written, not_written, review } = writeSettledRecords(log.changes, reports);
  writeFileSync(CHANGES_PATH, `${JSON.stringify({ ...log, changes }, null, 2)}\n`);
  console.log(`Wrote an archive check on ${written.length} records to ${CHANGES_PATH}`);
  for (const [outcome, count] of countsByOutcome(written)) console.log(`  ${outcome}: ${count}`);
  console.log(`  dated by the first copy showing the new terms: ${written.filter((entry) => entry.dated).length}`);
  console.log(`  re-typed as our correction: ${written.filter((entry) => entry.retyped).length}`);
  console.log(`Not written: ${not_written.length}`);
  for (const entry of not_written) console.log(`  ${entry.vendor} ${entry.date} ${entry.change_type} (${entry.outcome}): ${entry.why}`);
  console.log(`For review: ${review.length}`);
  for (const entry of review) console.log(`  ${entry.vendor} ${entry.date} ${entry.change_type}, badge ${entry.badge ?? "none"}: ${entry.why ?? "no reason given"}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}

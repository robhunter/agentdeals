#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readChangeLog, changeLogFreshness, CHANGES_PATH } from "./change-log.js";

export const DEFAULT_THRESHOLD_DAYS = 14;

export function report(freshness, thresholdDays) {
  const lines = [];
  lines.push("── Change-log freshness ──");
  lines.push(`Total changes recorded: ${freshness.total}`);
  lines.push(`Last change recorded: ${freshness.last_recorded_date ?? "never"}`);
  lines.push(`Days since last change recorded: ${freshness.days_since_last_recorded ?? "n/a"}`);
  lines.push(`Recorded in the last 30 days: ${freshness.recorded_last_30_days}`);
  lines.push(
    `Machine-detected entries: ${freshness.machine_detected_total}` +
      (freshness.last_detected_date
        ? ` (last ${freshness.last_detected_date}, ${freshness.days_since_last_detected} days ago)`
        : " (none — no detector has ever written to this log)")
  );
  lines.push(`Threshold: ${thresholdDays} days`);

  const days = freshness.days_since_last_recorded;
  const stale = days === null || days > thresholdDays;
  if (stale) {
    lines.push("");
    lines.push(
      days === null
        ? "STALE: no entry carries a recorded_date, so the age of this log cannot be measured."
        : `STALE: ${days} days since anything was added to the change log, past the ${thresholdDays}-day threshold.`
    );
    lines.push(
      "The daily job runs URL mode, which cannot detect a change. Nothing else writes to this log."
    );
  }
  return { stale, text: lines.join("\n") };
}

function main() {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--threshold");
  const thresholdDays = idx !== -1 ? parseInt(args[idx + 1], 10) : DEFAULT_THRESHOLD_DAYS;
  if (isNaN(thresholdDays) || thresholdDays < 1) {
    console.error(`Invalid threshold: ${args[idx + 1]}. Must be a positive integer.`);
    process.exit(2);
  }

  let data;
  try {
    data = readChangeLog(CHANGES_PATH);
  } catch (err) {
    console.error(`Failed to read change log: ${err.message}`);
    process.exit(2);
  }

  const { stale, text } = report(changeLogFreshness(data.changes), thresholdDays);
  console.log(text);
  process.exit(stale ? 1 : 0);
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) main();

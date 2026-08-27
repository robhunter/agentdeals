#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readChangeLog, changeLogFreshness, CHANGES_PATH } from "./change-log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_THRESHOLD_DAYS = 14;

export const WORKFLOW_PATH =
  process.env.AGENTDEALS_REVERIFY_WORKFLOW_PATH ||
  resolve(__dirname, "..", ".github", "workflows", "reverify.yml");

const INVOCATION = /node\s+scripts\/reverify-rolling\.js[^\n]*/g;

export function detectorSchedule(workflowYaml) {
  const invocations = workflowYaml.match(INVOCATION) ?? [];
  if (invocations.length === 0) {
    return { known: false, scheduled: false, reason: "no reverify-rolling.js invocation found" };
  }
  const withAi = invocations.filter((line) => /(^|\s)--ai(\s|$)/.test(line));
  if (withAi.length > 0 && withAi.length < invocations.length) {
    return {
      known: false,
      scheduled: false,
      reason: `${withAi.length} of ${invocations.length} invocations pass --ai`,
    };
  }
  return { known: true, scheduled: withAi.length > 0, reason: null };
}

export function report(freshness, thresholdDays, schedule) {
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
  lines.push(`Entries whose effective date is the day we looked: ${freshness.discovered_date_total}`);
  lines.push("");

  if (!schedule.known) {
    lines.push(
      `CANNOT TELL whether the detector is scheduled: ${schedule.reason}. Refusing to guess which alarm applies.`
    );
    return { failJob: false, openAbsenceIssue: false, undecidable: true, text: lines.join("\n") };
  }

  if (!schedule.scheduled) {
    lines.push(
      "The daily workflow does not pass --ai, so nothing is scheduled to detect a change."
    );
    lines.push(
      "Elapsed time cannot measure a detector that is switched off, so this step does not fail the run."
    );
    lines.push("Signalling the absence as a single open issue instead.");
    return { failJob: false, openAbsenceIssue: true, undecidable: false, text: lines.join("\n") };
  }

  const days = freshness.days_since_last_detected;
  lines.push(`Detector is scheduled (--ai). Threshold: ${thresholdDays} days since last detection.`);
  const stale = days === null || days > thresholdDays;
  if (stale) {
    lines.push("");
    lines.push(
      days === null
        ? "STALE: the detector is scheduled but has never written an entry to this log. This fires from its first scheduled run, because a detector that runs and records nothing is indistinguishable here from one that never ran — only its first detection clears it."
        : `STALE: ${days} days since the detector last recorded a change, past the ${thresholdDays}-day threshold.`
    );
    lines.push(
      "A hand-written entry does not clear this: the gate reads days_since_last_detected, not days_since_last_recorded."
    );
  }
  return { failJob: stale, openAbsenceIssue: false, undecidable: false, text: lines.join("\n") };
}

function emitOutputs(result, schedule) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(
    outputPath,
    [
      `detector_scheduled=${schedule.known && schedule.scheduled}`,
      `open_absence_issue=${result.openAbsenceIssue}`,
      "",
    ].join("\n")
  );
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

  let workflowYaml;
  try {
    workflowYaml = readFileSync(WORKFLOW_PATH, "utf-8");
  } catch (err) {
    console.error(`Failed to read ${WORKFLOW_PATH}: ${err.message}`);
    process.exit(2);
  }

  const schedule = detectorSchedule(workflowYaml);
  const result = report(changeLogFreshness(data.changes), thresholdDays, schedule);
  console.log(result.text);
  emitOutputs(result, schedule);
  if (result.undecidable) process.exit(2);
  process.exit(result.failJob ? 1 : 0);
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) main();

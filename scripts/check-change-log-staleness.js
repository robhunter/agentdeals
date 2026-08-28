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

const INVOCATION = /node\s+scripts\/reverify-rolling\.js([^\n]*)/g;

const COMMAND_SEPARATORS = new Set(["|", ";", "&", ">", "<"]);

export const AI_FLAG = "--ai";

export const DETECTOR_CLI_OPTIONS = {
  takesValue: ["--limit"],
  boolean: ["--ai", "--dry-run", "--seed-state"],
};

export function tokenizeArgs(argText) {
  const tokens = [];
  let current = null;
  const flush = () => {
    if (current) tokens.push(current);
    current = null;
  };
  const add = (text, { expands = false, splittable = false, word = text } = {}) => {
    if (!current) current = { text: "", word: "", expands: false, splittable: false };
    current.text += text;
    current.word += word;
    if (expands) current.expands = true;
    if (splittable) current.splittable = true;
  };

  let i = 0;
  while (i < argText.length) {
    const ch = argText[i];
    if (/\s/.test(ch)) {
      flush();
      i += 1;
    } else if (COMMAND_SEPARATORS.has(ch)) {
      flush();
      return tokens;
    } else if (argText.startsWith("${{", i)) {
      const end = argText.indexOf("}}", i + 3);
      const raw = end === -1 ? argText.slice(i) : argText.slice(i, end + 2);
      add(raw, { expands: true, splittable: true });
      i += raw.length;
    } else if (ch === "'") {
      const end = argText.indexOf("'", i + 1);
      const raw = end === -1 ? argText.slice(i) : argText.slice(i, end + 1);
      add(raw, { word: raw.slice(1, end === -1 ? undefined : -1) });
      i += raw.length;
    } else if (ch === '"') {
      let j = i + 1;
      let inner = "";
      let expands = false;
      while (j < argText.length && argText[j] !== '"') {
        if (argText[j] === "$") expands = true;
        inner += argText[j];
        j += 1;
      }
      const closed = j < argText.length;
      add(closed ? `"${inner}"` : `"${inner}`, { expands, word: inner });
      i = j + 1;
    } else if (ch === "$") {
      add(ch, { expands: true, splittable: true });
      i += 1;
    } else {
      add(ch);
      i += 1;
    }
  }
  flush();
  return tokens;
}

export function flagTokens(argText) {
  const flags = [];
  let consumingValue = false;
  for (const token of tokenizeArgs(argText)) {
    if (consumingValue) {
      consumingValue = false;
      if (token.expands && !token.splittable) continue;
    }
    if (DETECTOR_CLI_OPTIONS.takesValue.includes(token.word)) consumingValue = true;
    flags.push(token);
  }
  return flags;
}

export function detectorSchedule(workflowYaml) {
  const invocations = [...workflowYaml.matchAll(INVOCATION)].map((m) => flagTokens(m[1]));
  if (invocations.length === 0) {
    return { known: false, scheduled: false, reason: "no reverify-rolling.js invocation found" };
  }
  const unresolved = invocations.flat().filter((token) => token.expands);
  if (unresolved.length > 0) {
    return {
      known: false,
      scheduled: false,
      reason: `an argument that could be the ${AI_FLAG} flag is not a literal: ${unresolved
        .map((token) => token.text)
        .join(", ")}`,
    };
  }
  const withAi = invocations.filter((tokens) =>
    tokens.some((token) => !token.expands && token.word === AI_FLAG)
  );
  if (withAi.length > 0 && withAi.length < invocations.length) {
    return {
      known: false,
      scheduled: false,
      reason: `${withAi.length} of ${invocations.length} invocations pass ${AI_FLAG}`,
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

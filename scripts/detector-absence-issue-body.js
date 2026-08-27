#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function absenceIssueBody(marker) {
  return [
    "The daily re-verification workflow does not pass `--ai`, so the only mode that can detect a",
    "pricing change never runs. URL mode reports a hardcoded zero. Nothing is scheduled to write",
    "to `data/deal_changes.json`.",
    "",
    "This is one durable signal for a condition elapsed time cannot measure. The change log ages",
    "whether or not anything out there has changed, so a day-counting alarm on it would be red",
    "every day, and an alarm that is red every day is one nobody reads.",
    "",
    "The staleness gate reads `days_since_last_detected` and starts failing the daily run at the",
    "same commit that adds `--ai` to the workflow. There is no flag to flip separately.",
    "",
    "Opened by `.github/workflows/reverify.yml`, which will not open a second one while this is",
    `open. Marker: ${marker}`,
    "",
  ].join("\n");
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  const marker = process.argv[2];
  if (!marker) {
    console.error("Usage: detector-absence-issue-body.js <marker>");
    process.exit(2);
  }
  process.stdout.write(absenceIssueBody(marker));
}

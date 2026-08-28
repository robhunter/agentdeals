#!/usr/bin/env node

/**
 * Report what the change gate would do to records already in the log.
 *
 * Usage:
 *   node scripts/gate-report.js                        # every machine-detected record, first layer only
 *   node scripts/gate-report.js --on 2026-08-28        # only records recorded that day
 *   node scripts/gate-report.js --confirm              # also ask the second-opinion pass
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readChangeLog, CHANGES_PATH, DETECTED_BY_AI } from "./change-log.js";
import { gateCandidates, confirmDescribesChange } from "./change-gate.js";
import { createVerifierClient, VERIFIER_MODEL } from "./verify-freshness.js";

export function machineDetected(changes, onDate) {
  return changes.filter(
    (c) => c.detected_by === DETECTED_BY_AI && (!onDate || c.recorded_date === onDate)
  );
}

export function reportLines({ candidates, accepted, rejected, unchecked }) {
  const verdictFor = new Map();
  for (const c of accepted) verdictFor.set(c, { mark: "keep", note: "" });
  for (const { candidate, error } of unchecked) {
    verdictFor.set(candidate, { mark: "keep", note: `no second opinion: ${error}` });
  }
  for (const { candidate, reason, detail } of rejected) {
    verdictFor.set(candidate, { mark: "DROP", note: `${reason} — ${detail}` });
  }
  const lines = [];
  for (const candidate of candidates) {
    const verdict = verdictFor.get(candidate) ?? { mark: "keep", note: "" };
    lines.push(
      `${verdict.mark}  ${candidate.vendor} (${candidate.change_type})${verdict.note ? ` — ${verdict.note}` : ""}`
    );
  }
  lines.push("");
  lines.push(
    `Kept: ${candidates.length - rejected.length} | Dropped: ${rejected.length} | Recorded without a second opinion: ${unchecked.length} | Considered: ${candidates.length}`
  );
  return lines;
}

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes("--confirm");
  const onIdx = args.indexOf("--on");
  const onDate = onIdx !== -1 ? args[onIdx + 1] : null;

  const data = readChangeLog(process.env.AGENTDEALS_CHANGES_PATH || CHANGES_PATH);
  const candidates = machineDetected(data.changes, onDate);

  console.log(
    `Change gate report — ${candidates.length} machine-detected records` +
      (onDate ? ` recorded on ${onDate}` : "") +
      (confirm ? ` (second opinion: ${VERIFIER_MODEL})` : " (first layer only)")
  );
  console.log("");

  if (candidates.length === 0) {
    console.log("Nothing to report.");
    process.exit(0);
  }

  let confirmFn = null;
  if (confirm) {
    const client = createVerifierClient();
    confirmFn = (entry) => confirmDescribesChange(client, entry);
  }

  const result = await gateCandidates(candidates, { confirmFn });
  for (const line of reportLines({ candidates, ...result })) console.log(line);

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

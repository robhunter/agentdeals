#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditRecord,
  applyAudit,
  redirectedOffDomain,
  FREE_TIER_REMOVED,
  OUTCOME_REFUSED,
  OUTCOME_REWRITTEN,
} from "./change-gate.js";
import { fetchPageText } from "./verify-freshness.js";
import { recordRefusals, withdrawRefusals } from "./change-refusals.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CHANGES_PATH = resolve(__dirname, "..", "data", "deal_changes.json");

const identity = (record) =>
  [record?.vendor, record?.change_type, record?.date, record?.source_url].join("|");

export function asFirstWritten(records, snapshot) {
  const queued = new Map();
  for (const record of snapshot) {
    const key = identity(record);
    if (!queued.has(key)) queued.set(key, []);
    queued.get(key).push(record);
  }
  const candidates = records.map((record) => {
    const waiting = queued.get(identity(record));
    const original = waiting?.shift();
    return original ? { ...record, summary: original.summary } : record;
  });
  const readmitted = [...queued.values()].flat();
  return { candidates: [...candidates, ...readmitted], readmitted };
}

export function sweepRecords(records, options = {}) {
  const finalUrlFor = options.finalUrlFor ?? (() => undefined);
  const kept = [];
  const admitted = [];
  const refused = [];
  const rewritten = [];
  for (const record of records) {
    const verdict = auditRecord(record, { finalUrl: finalUrlFor(record) });
    if (verdict.outcome === OUTCOME_REFUSED) {
      refused.push({ candidate: record, reason: verdict.reason, detail: verdict.detail });
      continue;
    }
    const next = applyAudit(record, verdict);
    if (verdict.outcome === OUTCOME_REWRITTEN) {
      rewritten.push({ vendor: record.vendor, was: record.summary, now: verdict.summary });
    }
    kept.push(next);
    admitted.push(record);
  }
  return { kept, admitted, refused, rewritten };
}

export function countsByReason(refused) {
  const counts = new Map();
  for (const { reason } of refused) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return counts;
}

export async function redirectsFor(records) {
  const found = new Map();
  for (const record of records) {
    if (record.change_type !== FREE_TIER_REMOVED) continue;
    if (!record.source_url) continue;
    const page = await fetchPageText(record.source_url);
    if (!page.ok || !page.finalUrl) continue;
    if (!redirectedOffDomain(record.source_url, page.finalUrl)) continue;
    found.set(record, page.finalUrl);
    console.log(`  → ${record.vendor}: ${record.source_url} now redirects to ${page.finalUrl}`);
  }
  return found;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const checkRedirects = process.argv.includes("--check-redirects");
  const changesPath = process.env.AGENTDEALS_CHANGES_PATH || DEFAULT_CHANGES_PATH;
  const data = JSON.parse(readFileSync(changesPath, "utf-8"));

  const restoreAt = process.argv.indexOf("--restore-from");
  let candidates = data.changes;
  if (restoreAt !== -1) {
    const snapshotPath = process.argv[restoreAt + 1];
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8")).changes;
    const restored = asFirstWritten(data.changes, snapshot);
    candidates = restored.candidates;
    console.log(`Reading summaries as first written from ${snapshotPath}`);
    console.log(`  ${snapshot.length} snapshot record(s), ${restored.readmitted.length} not in the log\n`);
  }

  let redirects = new Map();
  if (checkRedirects) {
    const wouldRefuse = sweepRecords(candidates).refused.map(({ candidate }) => candidate);
    console.log(`Checking ${wouldRefuse.length} refused record(s) for a redirect off the vendor's domain`);
    redirects = await redirectsFor(wouldRefuse);
    console.log(`  ${redirects.size} record(s) re-sourced from a redirect\n`);
  }

  const { kept, admitted, refused, rewritten } = sweepRecords(candidates, {
    finalUrlFor: (record) => redirects.get(record),
  });

  console.log(`Read ${candidates.length} recorded change(s) from ${changesPath}`);
  console.log(`  kept:      ${kept.length}`);
  console.log(`  rewritten: ${rewritten.length}`);
  console.log(`  refused:   ${refused.length}`);
  for (const [reason, count] of [...countsByReason(refused)].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${reason.padEnd(26)} ${count}`);
  }
  for (const { candidate, reason } of refused) {
    console.log(`  ✗ ${candidate.vendor} (${candidate.change_type}) [${reason}]`);
  }
  for (const { vendor, was, now } of rewritten) {
    console.log(`  ✎ ${vendor}\n      was: ${was}\n      now: ${now}`);
  }

  if (dryRun) {
    console.log("\nDry run — nothing written.");
    return;
  }
  data.changes = kept;
  writeFileSync(changesPath, JSON.stringify(data, null, 2) + "\n");
  const withdrawn = withdrawRefusals(admitted);
  const written = recordRefusals(refused);
  console.log(`\nWrote ${kept.length} change(s) to ${changesPath}`);
  console.log(`Wrote ${written.written.length} refusal(s) to ${written.path}`);
  console.log(`Withdrew ${withdrawn.withdrawn} refusal(s) the gate now admits`);
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main().catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}

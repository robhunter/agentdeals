#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readChangeLog } from "./change-log.js";
import { auditRecord } from "./change-gate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = { kind: null, type: null, vendor: null, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--kind") options.kind = argv[++i];
    else if (argv[i] === "--type") options.type = argv[++i];
    else if (argv[i] === "--vendor") options.vendor = argv[++i];
    else if (argv[i] === "--verbose") options.verbose = true;
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const path = resolve(__dirname, "..", "data", "deal_changes.json");
  const records = readChangeLog(path).changes;
  const audited = records.map((record) => ({ record, verdict: auditRecord(record) }));

  const selected = audited.filter(({ record, verdict }) => {
    if (options.type && record.change_type !== options.type) return false;
    if (options.vendor && record.vendor.toLowerCase() !== options.vendor.toLowerCase()) return false;
    if (options.kind && verdict.outcome !== options.kind) return false;
    return true;
  });

  const byOutcome = new Map();
  for (const { verdict } of selected) {
    byOutcome.set(verdict.outcome, (byOutcome.get(verdict.outcome) ?? 0) + 1);
  }

  console.log(`${selected.length} of ${records.length} record(s) selected\n`);
  for (const [outcome, count] of [...byOutcome.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${outcome.padEnd(24)} ${count}`);
  }

  const survivors = selected.filter(({ verdict }) => verdict.outcome !== "refused");
  const rewritten = survivors.filter(({ verdict }) => verdict.summary !== null);
  console.log(`\n  kept: ${survivors.length}, of which rewritten: ${rewritten.length}`);

  const byType = new Map();
  for (const { record, verdict } of selected) {
    const bucket = byType.get(record.change_type) ?? { kept: 0, refused: 0 };
    if (verdict.outcome === "refused") bucket.refused++;
    else bucket.kept++;
    byType.set(record.change_type, bucket);
  }
  console.log("\n  by change type (kept / refused):");
  for (const [type, bucket] of [...byType.entries()].sort((a, b) => b[1].refused - a[1].refused)) {
    console.log(`    ${type.padEnd(26)} ${String(bucket.kept).padStart(4)} / ${bucket.refused}`);
  }

  if (!options.kind && !options.vendor && !options.verbose) return;
  console.log("");
  for (const { record, verdict } of selected) {
    console.log(`=== ${record.vendor} | ${record.change_type} | ${record.impact} | ${record.source_url}`);
    console.log(`  outcome: ${verdict.outcome}${verdict.reason ? ` (${verdict.reason})` : ""}`);
    console.log(`  was: ${record.summary}`);
    if (verdict.summary !== null) console.log(`  now: ${verdict.summary}`);
    for (const { clause, kind } of verdict.dropped) console.log(`  – [${kind}] ${clause}`);
    console.log("");
  }
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) main();

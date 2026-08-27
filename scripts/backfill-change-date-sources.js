#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DATE_SOURCE_HAND_WRITTEN, DATE_SOURCES } from "./change-log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANGES_PATH = resolve(__dirname, "..", "data", "deal_changes.json");

export function planBackfill(changes) {
  const machineWritten = changes.filter((c) => c.detected_by);
  const alreadyLabelled = changes.filter((c) => DATE_SOURCES.includes(c.date_source));
  const toLabel = changes.filter(
    (c) => !c.detected_by && !DATE_SOURCES.includes(c.date_source)
  );
  return { machineWritten, alreadyLabelled, toLabel };
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const data = JSON.parse(readFileSync(CHANGES_PATH, "utf-8"));
  const { machineWritten, alreadyLabelled, toLabel } = planBackfill(data.changes);

  console.log(`Entries: ${data.changes.length}`);
  console.log(`Already carrying a date_source: ${alreadyLabelled.length}`);
  console.log(`Machine-written (detected_by set): ${machineWritten.length}`);
  console.log(`To label ${DATE_SOURCE_HAND_WRITTEN}: ${toLabel.length}`);

  const unlabelledMachine = machineWritten.filter(
    (c) => !DATE_SOURCES.includes(c.date_source)
  );
  if (unlabelledMachine.length > 0) {
    console.error("");
    console.error(
      `Refusing to run: ${unlabelledMachine.length} machine-written entries carry no date_source.`
    );
    console.error(
      "Only the writer knows whether their date came from the vendor's page, so this script cannot label them."
    );
    for (const c of unlabelledMachine.slice(0, 5)) {
      console.error(`  ${c.vendor} | ${c.change_type} | ${c.date}`);
    }
    process.exit(2);
  }

  for (const change of toLabel) change.date_source = DATE_SOURCE_HAND_WRITTEN;

  if (dryRun) {
    console.log("");
    console.log("Dry run — nothing written.");
    return;
  }

  writeFileSync(CHANGES_PATH, JSON.stringify(data, null, 2) + "\n");
  console.log("");
  console.log(`Wrote ${CHANGES_PATH}`);
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) main();

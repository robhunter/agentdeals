import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { restrictionEvidence, RESTRICTION } from "./change-gate.js";
import { buildRefusalEntry, mergeRefusals, readRefusals, refusalsPath } from "./change-refusals.js";
import { fetchPageText } from "./verify-freshness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANGES_PATH = resolve(__dirname, "..", "data", "deal_changes.json");

const apply = process.argv.includes("--apply");
const offline = process.argv.includes("--offline");

const index = JSON.parse(readFileSync(CHANGES_PATH, "utf-8"));
const restrictions = index.changes.filter((c) => c.change_type === RESTRICTION);

const pages = new Map();
if (!offline) {
  for (const record of restrictions) {
    if (pages.has(record.source_url)) continue;
    const read = await fetchPageText(record.source_url);
    pages.set(record.source_url, read.ok ? read.text : null);
    console.log(`  read ${record.source_url} → ${read.ok ? `${read.text.length} chars` : read.error}`);
  }
}

const reclassified = [];
const refused = [];
for (const record of restrictions) {
  const verdict = restrictionEvidence(record, { pageText: pages.get(record.source_url) ?? undefined });
  if (verdict.reclassifyAs) reclassified.push({ record, to: verdict.reclassifyAs, detail: verdict.detail });
  else if (!verdict.ok) refused.push({ record, reason: verdict.reason, detail: verdict.detail });
}

console.log(`\n${restrictions.length} restriction records`);
console.log(`  ${reclassified.length} reclassified, ${refused.length} refused, ${restrictions.length - reclassified.length - refused.length} kept\n`);
for (const { record, to, detail } of reclassified) console.log(`  ${record.vendor} ${record.date} → ${to}\n      ${detail}`);
for (const { record, reason, detail } of refused) console.log(`  ${record.vendor} ${record.date} → refused (${reason})\n      ${detail}`);

if (!apply) {
  console.log("\nnothing written — pass --apply");
  process.exit(0);
}

const refusedKeys = new Set(refused.map(({ record }) => `${record.vendor}|${record.date}`));
const reclassifyTo = new Map(reclassified.map(({ record, to }) => [`${record.vendor}|${record.date}`, to]));

index.changes = index.changes
  .filter((c) => !refusedKeys.has(`${c.vendor}|${c.date}`) || c.change_type !== RESTRICTION)
  .map((c) => {
    const to = c.change_type === RESTRICTION ? reclassifyTo.get(`${c.vendor}|${c.date}`) : undefined;
    return to ? { ...c, change_type: to } : c;
  });
writeFileSync(CHANGES_PATH, `${JSON.stringify(index, null, 2)}\n`);

const entries = refused.map(({ record, reason, detail }) =>
  buildRefusalEntry({ candidate: record, reason, detail }, { now: new Date(`${record.recorded_date ?? record.date}T00:00:00Z`) })
);
const path = refusalsPath();
writeFileSync(path, `${JSON.stringify({ refusals: mergeRefusals(readRefusals(path), entries) }, null, 2)}\n`);

console.log(`\nwrote ${CHANGES_PATH} and ${path}`);

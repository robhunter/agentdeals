#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { statesABaseline, quantities, FREE_TIER_REMOVED } from "./change-gate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_NOW = resolve(__dirname, "..", "data", "deal_changes.json");

const DIRECTIONAL = ["limits_reduced", "limits_increased", FREE_TIER_REMOVED];

const identity = (record) =>
  [record?.vendor, record?.change_type, record?.date, record?.source_url].join("|");

export function byIdentity(records) {
  const index = new Map();
  for (const record of records) {
    const key = identity(record);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(record);
  }
  return index;
}

export function directionalRecordsAlteredBy(before, after) {
  const rewrites = byIdentity(after);
  const taken = new Map();
  const population = [];
  for (const record of before) {
    if (!DIRECTIONAL.includes(record.change_type)) continue;
    const key = identity(record);
    const at = taken.get(key) ?? 0;
    const rewritten = rewrites.get(key)?.[at] ?? null;
    taken.set(key, at + 1);
    if (rewritten && rewritten.summary === record.summary) continue;
    population.push({ key, first: record, rewritten });
  }
  return population;
}

export function reportBaselines(before, after, now) {
  const published = byIdentity(now);
  const taken = new Map();
  const rows = [];
  for (const { key, first, rewritten } of directionalRecordsAlteredBy(before, after)) {
    const at = taken.get(key) ?? 0;
    const current = published.get(key)?.[at];
    taken.set(key, at + 1);
    const wrote = quantities(first.summary);
    const carries = current ? quantities(current.summary) : [];
    rows.push({
      vendor: first.vendor,
      change_type: first.change_type,
      refusedByTheFirstRewrite: rewritten === null,
      published: Boolean(current),
      hadABaseline: statesABaseline(first.summary),
      hasABaseline: Boolean(current) && statesABaseline(current.summary),
      lost: wrote.filter((figure) => !carries.includes(figure)),
      gained: carries.filter((figure) => !wrote.includes(figure)),
      summary: current?.summary ?? null,
    });
  }
  return rows;
}

function main() {
  const [firstPath, rewrittenPath, nowPath = DEFAULT_NOW] = process.argv.slice(2);
  if (!firstPath || !rewrittenPath) {
    console.error("usage: baseline-report.js <as-first-written.json> <after-rewrite.json> [now.json]");
    process.exit(2);
  }
  const load = (path) => JSON.parse(readFileSync(path, "utf-8")).changes;
  const rows = reportBaselines(load(firstPath), load(rewrittenPath), load(nowPath));

  const rewrittenThen = rows.filter((row) => !row.refusedByTheFirstRewrite);
  const refusedThen = rows.filter((row) => row.refusedByTheFirstRewrite);
  const published = rewrittenThen.filter((row) => row.published);
  const withABaseline = published.filter((row) => row.hasABaseline);
  const bare = published.filter((row) => !row.hasABaseline);
  const gone = rewrittenThen.filter((row) => !row.published);
  const lostAFigure = published.filter((row) => row.lost.length > 0);

  console.log(`directional records the first rewrite altered: ${rows.length}`);
  console.log(`  it rewrote: ${rewrittenThen.length}`);
  console.log(`  it refused: ${refusedThen.length} (${refusedThen.filter((row) => row.published).length} back in the log now)`);
  console.log(`\nof the ${rewrittenThen.length} it rewrote:`);
  console.log(`  still published:        ${published.length}`);
  console.log(`  no longer in the log:   ${gone.length}`);
  console.log(`  stating a baseline now: ${withABaseline.length}`);
  console.log(`  stating none:           ${bare.length}`);
  console.log(`  short a figure they were first written with: ${lostAFigure.length}`);

  console.log(`\nshort a figure they were first written with (${lostAFigure.length}):`);
  for (const row of lostAFigure) {
    console.log(`  ${row.vendor} (${row.change_type}) short ${row.lost.join(", ")}`);
    console.log(`      ${row.summary}`);
  }

  console.log(`\nstating no baseline (${bare.length}):`);
  for (const row of bare) {
    console.log(`  ${row.vendor} (${row.change_type})${row.hadABaseline ? " — stated one when first written" : ""}`);
    console.log(`      ${row.summary}`);
  }

  console.log(`\nno longer in the log (${gone.length}):`);
  for (const row of gone) console.log(`  ${row.vendor} (${row.change_type})`);
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) main();

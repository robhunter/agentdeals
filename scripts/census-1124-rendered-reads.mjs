#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPageText, PAGE_TOO_SHORT_ERROR } from "./verify-freshness.js";
import { findRenderer, READ_BY_RENDERING } from "./rendered-page.js";
import { priceSignals } from "./change-gate.js";
import { sourceCheckRecord, SOURCE_CHECK_UNREADABLE } from "./vendor-naming.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH =
  process.env.AGENTDEALS_INDEX_PATH || resolve(__dirname, "..", "data", "index.json");
const CONCURRENCY = 4;

function arg(name, fallback = null) {
  const at = process.argv.indexOf(name);
  return at !== -1 ? process.argv[at + 1] : fallback;
}

export function shortPageCohort(offers) {
  return offers.filter(
    (offer) =>
      offer.url &&
      offer.source_check?.outcome === SOURCE_CHECK_UNREADABLE &&
      String(offer.source_check.detail ?? "").startsWith(PAGE_TOO_SHORT_ERROR)
  );
}

async function mapWithConcurrency(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const out = arg("--out", "/tmp/census-1124.json");
  const write = process.argv.includes("--write");
  const checked = arg("--checked", new Date().toISOString().slice(0, 10));
  const limit = Number(arg("--limit", "0"));
  const only = arg("--url", null);

  const renderer = findRenderer();
  console.error(`rendering client: ${renderer ?? "none found — nothing will escalate"}`);
  if (!renderer) process.exitCode = 2;

  const data = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
  const offers = data.offers || [];
  let cohort = shortPageCohort(offers);
  if (only) cohort = cohort.filter((offer) => offer.url === only);
  if (limit > 0) cohort = cohort.slice(0, limit);

  const indexOf = new Map(offers.map((offer, at) => [offer, at]));
  console.error(`${cohort.length} records cite a page our fetcher read as too short`);

  const started = Date.now();
  const rows = [];
  let done = 0;
  await mapWithConcurrency(cohort, CONCURRENCY, async (offer) => {
    const at = Date.now();
    const page = await fetchPageText(offer.url);
    const signals = page.ok ? priceSignals(page.text) : [];
    const check = sourceCheckRecord(offer, page, signals, checked);
    rows.push({
      vendor: offer.vendor,
      slug: offer.slug ?? null,
      url: offer.url,
      chars_before: page.chars_before_rendering ?? page.chars ?? null,
      chars_after: page.ok ? page.text.length : (page.chars ?? null),
      rendered: page.read === READ_BY_RENDERING,
      outcome: check.outcome,
      detail: check.detail,
      seconds: Math.round((Date.now() - at) / 100) / 10,
    });
    if (write) offers[indexOf.get(offer)].source_check = check;
    done++;
    console.error(
      `  ${String(done).padStart(3)}/${cohort.length} ${check.outcome.padEnd(22)} ${offer.vendor} — ${offer.url}`
    );
  });

  rows.sort((a, b) => a.vendor.localeCompare(b.vendor));
  writeFileSync(out, JSON.stringify(rows, null, 1) + "\n");
  if (write) writeFileSync(INDEX_PATH, JSON.stringify(data, null, 2) + "\n");

  const recovered = rows.filter((r) => r.outcome !== SOURCE_CHECK_UNREADABLE);
  const byOutcome = new Map();
  for (const r of rows) byOutcome.set(r.outcome, (byOutcome.get(r.outcome) ?? 0) + 1);

  console.error("");
  console.error(`cohort                       ${rows.length}`);
  console.error(`no longer unreadable         ${recovered.length}`);
  console.error(`still unreadable             ${rows.length - recovered.length}`);
  for (const [outcome, count] of [...byOutcome].sort((a, b) => b[1] - a[1])) {
    console.error(`  ${outcome.padEnd(24)} ${count}`);
  }
  const wall = Math.round((Date.now() - started) / 1000);
  console.error("");
  console.error(`renders attempted            ${rows.filter((r) => r.rendered).length}`);
  console.error(`wall clock                   ${wall}s`);
  console.error(`per record                   ${Math.round((wall / rows.length) * 10) / 10}s`);
  console.error(`wrote ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

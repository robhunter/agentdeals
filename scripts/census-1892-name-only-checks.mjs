#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPageText } from "./verify-freshness.js";
import { figuresWeAlsoPublish, priceSignals } from "./change-gate.js";
import {
  checkKeptOnlyTheName,
  sourceCheckRecord,
  statesAnAmount,
  statesAnAmountOfZero,
  WE_MATCHED_NO_AMOUNT_TO_OUR_TERMS,
  READ_FROM_MARKUP,
  SOURCE_CHECK_OK,
} from "./vendor-naming.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH =
  process.env.AGENTDEALS_INDEX_PATH || resolve(__dirname, "..", "data", "index.json");
const CONCURRENCY = 10;
const MOST_AMOUNTS_NAMED = 6;

export const GAINS_A_FIGURE_WE_PUBLISH = "gains_a_figure_we_publish";
export const GAINS_ONLY_A_STATED_ZERO = "gains_only_a_stated_zero";
export const GAINS_THE_CLAUSE = "gains_the_clause";
export const READ_FROM_THE_MARKUP = "read_from_the_markup";
export const NOT_READ = "not_read";

function arg(name, fallback = null) {
  const at = process.argv.indexOf(name);
  return at !== -1 ? process.argv[at + 1] : fallback;
}

export function whatTheRereadWrites(offer, page, signals, check) {
  if (!page?.ok) return NOT_READ;
  if (check.outcome !== SOURCE_CHECK_OK) return check.outcome;
  if (check.read === READ_FROM_MARKUP) return READ_FROM_THE_MARKUP;
  if (check.detail.endsWith(WE_MATCHED_NO_AMOUNT_TO_OUR_TERMS)) return GAINS_THE_CLAUSE;
  const ours = figuresWeAlsoPublish(signals, offer.description);
  return ours.length > 0 ? GAINS_A_FIGURE_WE_PUBLISH : GAINS_ONLY_A_STATED_ZERO;
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

export async function rereadNameOnlyChecks(offers, options = {}) {
  const fetchFn = options.fetchFn ?? fetchPageText;
  const checked = options.checked ?? new Date().toISOString().slice(0, 10);
  const population = offers.filter(checkKeptOnlyTheName);
  const urls = [...new Set(population.map((offer) => offer.url))];
  const pages = new Map();
  await mapWithConcurrency(urls, options.concurrency ?? CONCURRENCY, async (url) => {
    pages.set(url, await fetchFn(url));
  });
  return population.map((offer) => {
    const page = pages.get(offer.url) ?? { ok: false, error: "not fetched" };
    const signals = page.ok ? priceSignals(page.text) : [];
    const check = sourceCheckRecord(offer, page, signals, checked);
    return {
      vendor: offer.vendor,
      url: offer.url,
      stored: offer.source_check,
      writes: whatTheRereadWrites(offer, page, signals, check),
      check,
      error: page.ok ? null : page.error,
      rendered: Boolean(check.rendered),
      figures_we_also_publish: figuresWeAlsoPublish(signals, offer.description),
      states_an_amount_of_zero: signals.some(statesAnAmountOfZero),
      amounts_the_page_states: signals.filter(statesAnAmount).slice(0, MOST_AMOUNTS_NAMED),
    };
  });
}

export function tally(rows) {
  const counts = {};
  for (const row of rows) counts[row.writes] = (counts[row.writes] ?? 0) + 1;
  return counts;
}

async function main() {
  const data = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
  const rows = await rereadNameOnlyChecks(data.offers, { checked: arg("--checked") ?? undefined });
  const report = { population: rows.length, counts: tally(rows), rows };
  const out = arg("--out");
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Records whose check kept only the name: ${rows.length}`);
  for (const [writes, count] of Object.entries(report.counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${writes}: ${count}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

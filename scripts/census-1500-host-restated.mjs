#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPageText } from "./verify-freshness.js";
import { priceSignals } from "./change-gate.js";
import {
  hostRestatement,
  productHalf,
  sourceCheckRecord,
  pageNamesVendor,
  pageNamesOnlyTheHost,
  SOURCE_CHECK_OUTCOMES,
  SOURCE_CHECK_NOT_THE_PRODUCT,
} from "./vendor-naming.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH =
  process.env.AGENTDEALS_INDEX_PATH || resolve(__dirname, "..", "data", "index.json");
const CONCURRENCY = 12;

const WITHHOLDING = new Set(["does_not_name_vendor", SOURCE_CHECK_NOT_THE_PRODUCT, "states_no_terms", "unreadable"]);

function arg(name, fallback = null) {
  const at = process.argv.indexOf(name);
  return at !== -1 ? process.argv[at + 1] : fallback;
}

export function restatedRecords(offers) {
  return offers
    .map((offer, index) => ({ offer, index, restated: hostRestatement(offer.vendor, offer.url) }))
    .filter(({ restated }) => restated.tokens.length > 0);
}

export function outcomeCounts(offers) {
  const counts = Object.fromEntries(SOURCE_CHECK_OUTCOMES.map((outcome) => [outcome, 0]));
  counts.none = 0;
  for (const offer of offers) {
    const outcome = offer.source_check?.outcome ?? "none";
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return counts;
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

async function main() {
  const write = process.argv.includes("--write");
  const out = arg("--out", "/tmp/census-1500.json");
  const checked = arg("--checked", new Date().toISOString().slice(0, 10));
  const cacheDir = arg("--cache");
  const limit = arg("--limit") ? parseInt(arg("--limit"), 10) : null;

  const data = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
  const offers = data.offers ?? [];
  const before = outcomeCounts(offers);

  let population = restatedRecords(offers);
  if (limit) population = population.slice(0, limit);
  const urls = [...new Set(population.map(({ offer }) => offer.url).filter(Boolean))];
  console.error(`${population.length} of ${offers.length} records name a token their cited host restates`);
  console.error(`${urls.length} distinct URLs to read`);

  if (cacheDir && !existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const cachePath = (url) => join(cacheDir, `${createHash("sha1").update(url).digest("hex")}.json`);

  let done = 0;
  const pages = new Map();
  await mapWithConcurrency(urls, CONCURRENCY, async (url) => {
    let page;
    if (cacheDir && existsSync(cachePath(url))) {
      page = JSON.parse(readFileSync(cachePath(url), "utf-8"));
    } else {
      const fetched = await fetchPageText(url);
      page = fetched.ok
        ? { ok: true, text: fetched.text, structured: fetched.structured ?? null }
        : { ok: false, error: fetched.error };
      if (cacheDir) writeFileSync(cachePath(url), JSON.stringify(page));
    }
    done++;
    if (done % 50 === 0) console.error(`  ${done}/${urls.length}`);
    pages.set(url, page);
  });

  const rows = [];
  for (const { offer, index, restated } of population) {
    const page = pages.get(offer.url) ?? { ok: false, error: "not fetched" };
    const signals = page.ok ? priceSignals(page.text) : [];
    const check = sourceCheckRecord(offer, page, signals, checked);
    const was = offer.source_check?.outcome ?? "none";
    const namedNow = page.ok ? pageNamesVendor(page.text, offer.vendor, { url: offer.url }).named : null;
    const row = {
      vendor: offer.vendor,
      url: offer.url,
      restates: restated.tokens,
      product: productHalf(offer.vendor, restated),
      was,
      now: check.outcome,
      detail: check.detail,
      page_ok: page.ok,
      named_now: namedNow,
      names_only_the_host: page.ok ? pageNamesOnlyTheHost(page.text, offer.vendor, offer.url) : null,
    };
    rows.push(row);
    if (write && check.outcome !== was && WITHHOLDING.has(check.outcome)) {
      data.offers[index].source_check = check;
      row.written = true;
    }
  }

  const after = outcomeCounts(data.offers);
  const moved = rows.filter((row) => row.was !== row.now);
  const intoProduct = rows.filter((row) => row.now === SOURCE_CHECK_NOT_THE_PRODUCT);
  const leftWithholding = rows.filter((row) => WITHHOLDING.has(row.was) && !WITHHOLDING.has(row.now));

  const report = {
    checked,
    population: population.length,
    catalogue: offers.length,
    before,
    after,
    reread_outcomes: rows.reduce((a, row) => ({ ...a, [row.now]: (a[row.now] ?? 0) + 1 }), {}),
    moved: moved.length,
    into_does_not_name_product: intoProduct.length,
    left_withholding_on_reread: leftWithholding.map((row) => `${row.vendor} — ${row.was} → ${row.now}`),
    rows,
  };
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  console.error(JSON.stringify({ ...report, rows: undefined, left_withholding_on_reread: report.left_withholding_on_reread.length }, null, 2));
  console.error(`wrote ${out}`);

  if (write) {
    writeFileSync(INDEX_PATH, JSON.stringify(data, null, 2) + "\n");
    console.error(`stamped ${rows.filter((row) => row.written).length} records in ${INDEX_PATH}`);
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}

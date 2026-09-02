#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPageText } from "./verify-freshness.js";
import { priceSignals, numericPriceSignals, quantities, MAGNITUDE_UNITS } from "./change-gate.js";
import { classifySource, sourceCheckRecord } from "./vendor-naming.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH =
  process.env.AGENTDEALS_INDEX_PATH || resolve(__dirname, "..", "data", "index.json");
const CONCURRENCY = 12;

function arg(name, fallback = null) {
  const at = process.argv.indexOf(name);
  return at !== -1 ? process.argv[at + 1] : fallback;
}

async function mapWithConcurrency(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

const MAGNITUDE_AFTER_NUMBER = /(\d[\d,]*(?:\.\d+)?)\s?([kmb])\b/gi;

function numbersOn(text) {
  const found = new Set(quantities(text));
  for (const match of text.matchAll(MAGNITUDE_AFTER_NUMBER)) {
    const base = Number(match[1].replace(/,/g, ""));
    const scale = MAGNITUDE_UNITS.get(match[2].toLowerCase());
    if (Number.isFinite(base) && scale) found.add(base * scale);
  }
  return found;
}

async function main() {
  const out = arg("--out", "/tmp/price-evidence-census.json");
  const cacheDir = arg("--cache", null);
  const write = process.argv.includes("--write");
  const checked = arg("--checked", new Date().toISOString().slice(0, 10));

  const data = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
  const all = (data.offers || []).filter((o) => o.url);
  const offers = all.filter((o) => o.source_check?.outcome === "ok");
  const urls = [...new Set(offers.map((o) => o.url))];

  console.error(`${offers.length} ok records, ${urls.length} distinct URLs`);

  if (cacheDir && !existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const cachePath = (url) =>
    join(cacheDir ?? "", `${createHash("sha1").update(url).digest("hex")}.json`);

  let done = 0;
  const pages = new Map();
  const fetchInto = async (url) => {
    if (cacheDir && existsSync(cachePath(url))) {
      pages.set(url, JSON.parse(readFileSync(cachePath(url), "utf-8")));
      return;
    }
    const page = await fetchPageText(url);
    if (cacheDir && page.ok) writeFileSync(cachePath(url), JSON.stringify(page));
    pages.set(url, page);
  };

  await mapWithConcurrency(urls, CONCURRENCY, async (url) => {
    await fetchInto(url);
    done++;
    if (done % 100 === 0) console.error(`  ${done}/${urls.length}`);
  });

  const retry = urls.filter((u) => !pages.get(u)?.ok);
  console.error(`retrying ${retry.length} failed fetches`);
  await mapWithConcurrency(retry, CONCURRENCY, fetchInto);

  let restamped = 0;
  const rows = offers.map((offer) => {
    const page = pages.get(offer.url) ?? { ok: false, error: "not fetched" };
    const signals = page.ok ? priceSignals(page.text) : [];
    const numeric = page.ok ? numericPriceSignals(page.text) : [];
    const onPage = page.ok ? numbersOn(page.text) : new Set();
    const published = [...new Set(quantities(offer.description ?? ""))];
    const absent = published.filter((n) => !onPage.has(n));
    const row = {
      vendor: offer.vendor,
      slug: offer.slug ?? null,
      url: offer.url,
      description: offer.description ?? null,
      stored_detail: offer.source_check?.detail ?? null,
      fetch_ok: Boolean(page.ok),
      error: page.ok ? null : page.error,
      chars: page.ok ? page.text.length : null,
      signals: signals.length,
      numeric_signals: numeric.length,
      phrase_evidence: [...new Set(signals)].slice(0, 6),
      published_numbers: published,
      numbers_absent_from_page: absent,
      outcome_today: classifySource(offer, page, signals).outcome,
    };
    if (write && page.ok && row.outcome_today !== offer.source_check?.outcome) {
      offer.source_check = sourceCheckRecord(offer, page, signals, checked);
      restamped++;
    }
    return row;
  });

  writeFileSync(out, JSON.stringify(rows, null, 1) + "\n");
  if (write) writeFileSync(INDEX_PATH, JSON.stringify(data, null, 2) + "\n");

  const read = rows.filter((r) => r.fetch_ok);
  const phraseOnly = read.filter((r) => r.numeric_signals === 0 && r.signals > 0);
  const noSignal = read.filter((r) => r.signals === 0);
  const withQuantity = phraseOnly.filter((r) => r.published_numbers.length > 0);
  const withAbsent = withQuantity.filter((r) => r.numbers_absent_from_page.length > 0);
  const numericRecords = read.filter((r) => r.numeric_signals > 0);

  console.error("");
  console.error(`ok records                       ${rows.length}`);
  console.error(`  read                           ${read.length}`);
  console.error(`  fetch failed                   ${rows.length - read.length}`);
  console.error(`  page carries a numeric signal  ${numericRecords.length}`);
  console.error(`  phrase-only evidence           ${phraseOnly.length}`);
  console.error(`    publishing a quantity        ${withQuantity.length}`);
  console.error(`      quantity absent from page  ${withAbsent.length}`);
  console.error(`  no price signal at all         ${noSignal.length}`);
  if (write) console.error(`  re-stamped                     ${restamped}`);

  console.error("");
  console.error("no price signal at all:");
  for (const r of noSignal) console.error(`  ${r.vendor.padEnd(28)} ${r.url}`);

  console.error("");
  console.error(`wrote ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

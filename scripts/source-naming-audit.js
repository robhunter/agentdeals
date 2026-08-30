#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPageText } from "./verify-freshness.js";
import { priceSignals } from "./change-gate.js";
import { pageNamesVendor, sourceCheckRecord } from "./vendor-naming.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH =
  process.env.AGENTDEALS_INDEX_PATH || resolve(__dirname, "..", "data", "index.json");
const CONCURRENCY = 12;

function arg(name, fallback = null) {
  const at = process.argv.indexOf(name);
  return at !== -1 ? process.argv[at + 1] : fallback;
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  const out = arg("--out", "/tmp/source-naming.json");
  const limit = arg("--limit") ? parseInt(arg("--limit"), 10) : null;
  const urlFilter = arg("--urls") ? new Set(arg("--urls").split(",")) : null;

  const data = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
  let offers = data.offers || [];
  if (urlFilter) offers = offers.filter((o) => urlFilter.has(o.url));
  if (limit) offers = offers.slice(0, limit);

  const urls = [...new Set(offers.map((o) => o.url).filter(Boolean))];
  console.error(`${offers.length} offers, ${urls.length} distinct URLs`);

  const cacheDir = arg("--cache");
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
      page = fetched.ok ? { ok: true, text: fetched.text } : { ok: false, error: fetched.error };
      if (cacheDir) writeFileSync(cachePath(url), JSON.stringify(page));
    }
    done++;
    if (done % 100 === 0) console.error(`  ${done}/${urls.length}`);
    pages.set(url, page);
  });

  const writeIndex = process.argv.includes("--write");
  const checked = arg("--checked", new Date().toISOString().slice(0, 10));

  const rows = offers.map((offer) => {
    const page = pages.get(offer.url) ?? { ok: false, error: "not fetched" };
    const signals = page.ok ? priceSignals(page.text).length : 0;
    if (writeIndex) offer.source_check = sourceCheckRecord(offer, page, signals, checked);
    if (!page.ok) {
      return { vendor: offer.vendor, category: offer.category, url: offer.url, fetch_ok: false, error: page.error };
    }
    const naming = pageNamesVendor(page.text, offer.vendor, { url: offer.url });
    return {
      vendor: offer.vendor,
      category: offer.category,
      tier: offer.tier ?? null,
      description: offer.description,
      verifiedDate: offer.verifiedDate ?? null,
      url: offer.url,
      fetch_ok: true,
      chars: page.text.length,
      signals: priceSignals(page.text).length,
      named: naming.named,
      named_via: naming.via,
      named_form: naming.form,
    };
  });

  const summary = {
    offers: rows.length,
    urls: urls.length,
    fetch_failed: rows.filter((r) => !r.fetch_ok).length,
    named_in_text: rows.filter((r) => r.named_via === "text").length,
    named_in_url: rows.filter((r) => r.named_via === "url").length,
    named_by_host: rows.filter((r) => r.named_via === "host").length,
    not_named: rows.filter((r) => r.fetch_ok && !r.named).length,
    no_signals: rows.filter((r) => r.fetch_ok && r.signals === 0).length,
    named_and_signals: rows.filter((r) => r.fetch_ok && r.named && r.signals > 0).length,
  };
  console.error(JSON.stringify(summary, null, 2));
  writeFileSync(out, JSON.stringify({ summary, rows }, null, 2) + "\n");
  if (writeIndex) {
    writeFileSync(INDEX_PATH, JSON.stringify(data, null, 2) + "\n");
    console.error(`stamped source_check on ${offers.length} offers in ${INDEX_PATH}`);
  }
  console.error(`wrote ${out}`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});

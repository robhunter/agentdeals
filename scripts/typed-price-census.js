#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readBodyWithin, withMinimumLength } from "./verify-freshness.js";
import { readStructuredPrices, unrenderedPrices, isZero } from "./structured-prices.js";
import { priceSignals } from "./change-gate.js";
import { classifySource, sourceCheckRecord } from "./vendor-naming.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH =
  process.env.AGENTDEALS_INDEX_PATH || resolve(__dirname, "..", "data", "index.json");
const CONCURRENCY = 12;
const FETCH_TIMEOUT_MS = 20_000;
const HARD_CEILING = 64_000_000;

function arg(name, fallback = null) {
  const at = process.argv.indexOf(name);
  return at !== -1 ? process.argv[at + 1] : fallback;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchMeasured(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; AgentDeals-Verify/1.0; +https://github.com/robhunter/agentdeals)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await readBodyWithin(res, HARD_CEILING);
    if (body.tooLarge) return { ok: false, error: `page too large: ${body.bytes} bytes` };
    return withMinimumLength({
      ok: true,
      text: stripHtml(body.html),
      structured: readStructuredPrices(body.html),
    });
  } catch (err) {
    return { ok: false, error: err.name === "AbortError" ? "timeout" : err.message };
  } finally {
    clearTimeout(timeout);
  }
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

const REGRADED_FROM = new Set(["states_no_terms", "states_no_amount"]);

async function main() {
  const out = arg("--out", "/tmp/typed-price-census.json");
  const cacheDir = arg("--cache", "/tmp/typed-price-cache");

  const data = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
  const offers = (data.offers || []).filter((o) => o.url);
  const urls = [...new Set(offers.map((o) => o.url))];
  console.error(`${offers.length} offers, ${urls.length} distinct URLs`);

  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const cachePath = (url) => join(cacheDir, `${createHash("sha1").update(url).digest("hex")}.json`);

  let done = 0;
  const pages = new Map();
  await mapWithConcurrency(urls, CONCURRENCY, async (url) => {
    let page;
    if (existsSync(cachePath(url))) {
      page = JSON.parse(readFileSync(cachePath(url), "utf-8"));
    } else {
      page = await fetchMeasured(url);
      writeFileSync(cachePath(url), JSON.stringify(page));
    }
    done++;
    if (done % 100 === 0) console.error(`  ${done}/${urls.length}`);
    pages.set(url, page);
  });

  const write = process.argv.includes("--write");
  const checked = arg("--checked", new Date().toISOString().slice(0, 10));
  let restampedRegrade = 0;
  let restampedFlag = 0;

  const rows = offers.map((offer) => {
    const page = pages.get(offer.url) ?? { ok: false, error: "not fetched" };
    const signals = page.ok ? priceSignals(page.text) : [];
    const structured = page.structured ?? { blocks: 0, parsed: 0, prices: [] };
    const withMarkup = classifySource(offer, page, signals);
    const withoutMarkup = classifySource(offer, page.ok ? { ...page, structured: null } : page, signals);
    const unrendered = page.ok ? unrenderedPrices(page.structured, page.text) : [];
    const stored = offer.source_check?.outcome ?? null;
    const regraded =
      page.ok && REGRADED_FROM.has(withoutMarkup.outcome) && !REGRADED_FROM.has(withMarkup.outcome);
    const flagOnly = page.ok && !regraded && stored === withMarkup.outcome && unrendered.length > 0;
    if (write && (regraded || flagOnly)) {
      offer.source_check = sourceCheckRecord(offer, page, signals, checked);
      if (regraded) restampedRegrade++;
      else restampedFlag++;
    }
    return {
      vendor: offer.vendor,
      url: offer.url,
      stored,
      fetch_ok: page.ok,
      error: page.ok ? null : page.error,
      chars: page.ok ? page.text.length : null,
      blocks: structured.blocks,
      parsed: structured.parsed,
      typed_prices: structured.prices.length,
      typed_nonzero: structured.prices.filter((p) => !isZero(p)).length,
      signals: signals.length,
      outcome_today: withoutMarkup.outcome,
      outcome_with_markup: withMarkup.outcome,
      read: withMarkup.read ?? null,
      unrendered: unrendered.length,
      unrendered_sample: unrendered.slice(0, 3).map((p) => `${p.name ?? "—"} ${p.currency ?? ""} ${p.price}`.trim()),
    };
  });

  writeFileSync(out, JSON.stringify(rows, null, 1) + "\n");
  if (write) writeFileSync(INDEX_PATH, JSON.stringify(data, null, 2) + "\n");

  const fetched = rows.filter((r) => r.fetch_ok);
  const urlRows = new Map();
  for (const r of rows) if (!urlRows.has(r.url)) urlRows.set(r.url, r);
  const urlList = [...urlRows.values()];
  const urlsFetched = urlList.filter((r) => r.fetch_ok);
  const urlsTyped = urlsFetched.filter((r) => r.typed_prices > 0);
  const urlsTypedOnly = urlsTyped.filter((r) => r.signals === 0 || !r.signals);
  const regraded = fetched.filter(
    (r) => REGRADED_FROM.has(r.outcome_today) && !REGRADED_FROM.has(r.outcome_with_markup)
  );
  const ladders = regraded.filter((r) => r.typed_prices >= 3);
  const singles = regraded.filter((r) => r.typed_prices === 1);
  const zeroOnly = regraded.filter((r) => r.typed_nonzero === 0);
  const storedRegraded = fetched.filter(
    (r) => REGRADED_FROM.has(r.stored) && !REGRADED_FROM.has(r.outcome_with_markup) && r.typed_prices > 0
  );
  const unrenderedRows = fetched.filter((r) => r.unrendered > 0);
  const unreadableTyped = rows.filter((r) => !r.fetch_ok && r.typed_prices > 0);

  const say = (label, value) => console.error(`${label.padEnd(42)}${value}`);
  console.error("");
  say("distinct URLs", urlList.length);
  say("  fetched", urlsFetched.length);
  say("  carrying a typed price", urlsTyped.length);
  say("  typed price and no rendered signal", urlsTypedOnly.length);
  console.error("");
  say("records", rows.length);
  say("  on a page carrying a typed price", fetched.filter((r) => r.typed_prices > 0).length);
  say("  re-graded by reading the markup", regraded.length);
  say("    on a ladder of 3 or more prices", ladders.length);
  say("    on a single typed price", singles.length);
  say("    on zero-priced nodes only", zeroOnly.length);
  say("  stored as states_no_* and re-graded", storedRegraded.length);
  console.error("");
  say("records with unrendered typed prices", unrenderedRows.length);
  say("  typed prices the page never renders", unrenderedRows.reduce((a, r) => a + r.unrendered, 0));
  say("unreadable pages carrying typed prices", unreadableTyped.length);
  if (write) {
    console.error("");
    say("re-stamped after a re-grade", restampedRegrade);
    say("re-stamped to record unrendered prices", restampedFlag);
  }
  console.error("");
  console.error(`wrote ${out}`);
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main().catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}

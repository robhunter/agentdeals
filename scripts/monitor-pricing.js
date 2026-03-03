#!/usr/bin/env node

/**
 * Automated pricing page monitor for high-churn vendors.
 *
 * Reads data/watchlist.json, fetches pricing pages in parallel,
 * compares content hashes against stored baselines, and logs
 * detected changes to data/pricing-changes.jsonl.
 *
 * Usage:
 *   npm run monitor:pricing              # check all vendors due today
 *   npm run monitor:pricing -- --init    # create baseline (first run)
 *   npm run monitor:pricing -- --all     # check all vendors regardless of interval
 *   npm run monitor:pricing -- --vendor "Vercel"  # check a specific vendor
 *
 * Add new vendors by editing data/watchlist.json.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WATCHLIST_PATH = resolve(__dirname, "..", "data", "watchlist.json");
const HASHES_PATH = resolve(__dirname, "..", "data", "pricing-hashes.json");
const CHANGES_PATH = resolve(__dirname, "..", "data", "pricing-changes.jsonl");
const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 15000;

export function extractTextContent(html) {
  let cleaned = html;
  cleaned = cleaned.replace(/<head[\s\S]*?<\/head>/gi, "");
  cleaned = cleaned.replace(/<script[\s\S]*?<\/script>/gi, "");
  cleaned = cleaned.replace(/<style[\s\S]*?<\/style>/gi, "");
  cleaned = cleaned.replace(/<svg[\s\S]*?<\/svg>/gi, "");
  cleaned = cleaned.replace(/<[^>]+>/g, " ");
  cleaned = cleaned.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  cleaned = cleaned.replace(/&#?\w+;/g, " ");
  cleaned = cleaned.replace(/\b[0-9a-f]{8,}\b/gi, "");
  cleaned = cleaned.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "");
  cleaned = cleaned.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}[^\s]*/g, "");
  cleaned = cleaned.replace(/\b\d{10,13}\b/g, "");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned;
}

function hashContent(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "AgentDeals-PricingMonitor/1.0",
        Accept: "text/html",
      },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

export function isDueForCheck(entry, lastCheck, now = new Date()) {
  if (!lastCheck) return true;
  const lastDate = new Date(lastCheck);
  const diffMs = now.getTime() - lastDate.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);
  return entry.interval === "daily" ? diffHours >= 24 : diffHours >= 168;
}

async function checkBatch(entries, hashes, isInit) {
  const results = { changed: [], unchanged: [], errors: [] };

  await Promise.all(entries.map(async (entry) => {
    try {
      const html = await fetchPage(entry.url);
      const text = extractTextContent(html);
      const hash = hashContent(text);
      const now = new Date().toISOString();
      const prev = hashes[entry.vendor];

      if (!isInit && prev && prev.hash && prev.hash !== hash) {
        results.changed.push({ vendor: entry.vendor, url: entry.url, oldHash: prev.hash, newHash: hash });
      } else {
        results.unchanged.push(entry.vendor);
      }

      hashes[entry.vendor] = { url: entry.url, hash, checkedAt: now };
    } catch (err) {
      const reason = err.name === "AbortError" ? "timeout" : err.message;
      results.errors.push({ vendor: entry.vendor, url: entry.url, error: reason });
    }
  }));

  return results;
}

function logChange(change) {
  const entry = {
    ts: new Date().toISOString(),
    vendor: change.vendor,
    url: change.url,
    type: "pricing_page_changed",
    oldHash: change.oldHash,
    newHash: change.newHash,
  };
  appendFileSync(CHANGES_PATH, JSON.stringify(entry) + "\n");
}

async function main() {
  const args = process.argv.slice(2);
  const isInit = args.includes("--init");
  const checkAll = args.includes("--all");
  const vendorIdx = args.indexOf("--vendor");
  const specificVendor = vendorIdx !== -1 ? args[vendorIdx + 1] : null;

  let watchlist;
  try {
    watchlist = JSON.parse(readFileSync(WATCHLIST_PATH, "utf-8"));
  } catch (err) {
    console.error(`Failed to read watchlist: ${err.message}`);
    process.exit(2);
  }

  let hashes = {};
  if (!isInit && existsSync(HASHES_PATH)) {
    try {
      hashes = JSON.parse(readFileSync(HASHES_PATH, "utf-8"));
    } catch {
      console.error("Warning: Could not parse hashes file, treating as init run.");
    }
  }

  let vendors = watchlist.vendors;
  if (specificVendor) {
    vendors = vendors.filter((v) => v.vendor === specificVendor);
    if (vendors.length === 0) {
      console.error(`Vendor "${specificVendor}" not found in watchlist.`);
      process.exit(2);
    }
  } else if (!checkAll && !isInit) {
    const now = new Date();
    vendors = vendors.filter((v) => isDueForCheck(v, hashes[v.vendor]?.checkedAt, now));
  }

  if (vendors.length === 0) {
    console.log("No vendors due for check. Use --all to force check all vendors.");
    process.exit(0);
  }

  console.log(`${isInit ? "Initializing baseline for" : "Checking"} ${vendors.length} vendor pricing pages...\n`);

  const allChanged = [];
  const allErrors = [];
  let unchangedCount = 0;

  // Process in batches for concurrency control
  for (let i = 0; i < vendors.length; i += CONCURRENCY) {
    const batch = vendors.slice(i, i + CONCURRENCY);
    const results = await checkBatch(batch, hashes, isInit);
    allChanged.push(...results.changed);
    allErrors.push(...results.errors);
    unchangedCount += results.unchanged.length;

    // Log each change immediately
    for (const c of results.changed) {
      logChange(c);
    }
  }

  // Save updated hashes
  writeFileSync(HASHES_PATH, JSON.stringify(hashes, null, 2) + "\n");

  // Summary
  if (isInit) {
    console.log(`Baseline created: ${Object.keys(hashes).length} vendors hashed.`);
  } else if (allChanged.length === 0) {
    console.log(`No pricing page changes detected (${unchangedCount} checked).`);
  } else {
    console.log(`${allChanged.length} pricing page(s) changed:\n`);
    for (const c of allChanged) {
      console.log(`  ${c.vendor} — ${c.url}`);
    }
    console.log(`\nChanges logged to ${CHANGES_PATH}`);
  }

  if (allErrors.length > 0) {
    console.log(`\n${allErrors.length} error(s):\n`);
    for (const e of allErrors) {
      console.log(`  ${e.vendor} — ${e.error} (${e.url})`);
    }
  }

  process.exit(allChanged.length > 0 ? 1 : 0);
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main();
}

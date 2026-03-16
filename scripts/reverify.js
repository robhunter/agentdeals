#!/usr/bin/env node

/**
 * Automated data re-verification pipeline.
 *
 * Finds stale entries (verifiedDate older than threshold), checks URL
 * reachability, and bumps verifiedDate for reachable vendors.
 *
 * Usage:
 *   npm run reverify                        # re-verify entries older than 25 days
 *   npm run reverify -- --threshold 14      # custom threshold
 *   npm run reverify -- --dry-run           # report only, don't modify data
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(__dirname, "..", "data", "index.json");
const DEFAULT_THRESHOLD_DAYS = 25;
const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 15000;

export function findStaleOffers(offers, thresholdDays, now = new Date()) {
  const stale = [];
  const fresh = [];
  for (let i = 0; i < offers.length; i++) {
    const offer = offers[i];
    if (!offer.verifiedDate) {
      stale.push({ index: i, offer });
      continue;
    }
    const verified = new Date(offer.verifiedDate);
    const diffMs = now.getTime() - verified.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays >= thresholdDays) {
      stale.push({ index: i, offer });
    } else {
      fresh.push({ index: i, offer });
    }
  }
  return { stale, freshCount: fresh.length };
}

async function checkUrl(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Try HEAD first (lighter)
    let res = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      headers: {
        "User-Agent": "AgentDeals-Reverify/1.0",
        Accept: "text/html",
      },
      redirect: "follow",
    });
    // Some servers reject HEAD — fall back to GET
    if (res.status === 405 || res.status === 403) {
      clearTimeout(timeout);
      const controller2 = new AbortController();
      const timeout2 = setTimeout(() => controller2.abort(), FETCH_TIMEOUT_MS);
      try {
        res = await fetch(url, {
          method: "GET",
          signal: controller2.signal,
          headers: {
            "User-Agent": "AgentDeals-Reverify/1.0",
            Accept: "text/html",
          },
          redirect: "follow",
        });
      } finally {
        clearTimeout(timeout2);
      }
    }
    if (!res.ok) {
      return { reachable: false, error: `HTTP ${res.status}` };
    }
    return { reachable: true };
  } catch (err) {
    const reason = err.name === "AbortError" ? "timeout" : err.message;
    return { reachable: false, error: reason };
  } finally {
    clearTimeout(timeout);
  }
}

export async function reverifyBatch(entries, today) {
  const results = { verified: [], flagged: [] };

  await Promise.all(entries.map(async (entry) => {
    const result = await checkUrl(entry.offer.url);
    if (result.reachable) {
      results.verified.push({ index: entry.index, vendor: entry.offer.vendor, category: entry.offer.category });
    } else {
      results.flagged.push({
        index: entry.index,
        vendor: entry.offer.vendor,
        url: entry.offer.url,
        error: result.error,
      });
    }
  }));

  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  const thresholdIdx = args.indexOf("--threshold");
  const thresholdDays = thresholdIdx !== -1
    ? parseInt(args[thresholdIdx + 1], 10)
    : DEFAULT_THRESHOLD_DAYS;

  if (isNaN(thresholdDays) || thresholdDays < 0) {
    console.error(`Invalid threshold: ${args[thresholdIdx + 1]}. Must be a non-negative integer.`);
    process.exit(2);
  }

  let data;
  try {
    data = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
  } catch (err) {
    console.error(`Failed to read index: ${err.message}`);
    process.exit(2);
  }

  const offers = data.offers || [];
  const { stale, freshCount } = findStaleOffers(offers, thresholdDays);

  if (stale.length === 0) {
    console.log(`All ${offers.length} entries verified within ${thresholdDays} days.`);
    console.log(`Re-verified: 0 | Flagged: 0 | Already fresh: ${freshCount} | Total: ${offers.length}`);
    process.exit(0);
  }

  console.log(`Found ${stale.length} stale entries (threshold: ${thresholdDays} days).`);
  if (dryRun) console.log("(dry-run mode — no changes will be written)\n");
  else console.log("");

  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  let totalVerified = 0;
  let totalFlagged = 0;

  // Process in batches for concurrency control
  for (let i = 0; i < stale.length; i += CONCURRENCY) {
    const batch = stale.slice(i, i + CONCURRENCY);
    const results = await reverifyBatch(batch, today);

    // Update verifiedDate for reachable entries
    if (!dryRun) {
      for (const v of results.verified) {
        data.offers[v.index].verifiedDate = today;
      }
    }

    // Log flagged entries
    for (const f of results.flagged) {
      console.log(`  ⚠ ${f.vendor} — ${f.error} (${f.url})`);
    }

    totalVerified += results.verified.length;
    totalFlagged += results.flagged.length;
  }

  // Write updated index
  if (!dryRun && totalVerified > 0) {
    writeFileSync(INDEX_PATH, JSON.stringify(data, null, 2) + "\n");
  }

  console.log(`\nRe-verified: ${totalVerified} | Flagged: ${totalFlagged} | Already fresh: ${freshCount} | Total: ${offers.length}`);

  process.exit(0);
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main();
}

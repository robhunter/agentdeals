#!/usr/bin/env node

/**
 * Rolling data re-verification.
 *
 * Picks the N oldest-verified entries (regardless of staleness threshold),
 * checks them, and stamps verifiedDate across a 3-day window so future
 * re-verifications stay smoothly distributed instead of cliffing on a
 * single date.
 *
 * Usage:
 *   npm run reverify:rolling                    # 100 oldest, URL-only
 *   npm run reverify:rolling -- --limit 50      # 50 oldest
 *   npm run reverify:rolling -- --ai            # Haiku-based verification
 *   npm run reverify:rolling -- --dry-run       # report only
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reverifyBatch } from "./reverify.js";
import { fetchPageText, verifyWithHaiku } from "./verify-freshness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(__dirname, "..", "data", "index.json");
const DEFAULT_LIMIT = 100;
const URL_CONCURRENCY = 10;
const AI_RATE_LIMIT_MS = 500;
const STAGGER_WINDOW_DAYS = 3;

export function pickOldestEntries(offers, limit, now = new Date()) {
  const entries = offers.map((offer, index) => {
    const ts = offer.verifiedDate
      ? new Date(offer.verifiedDate).getTime()
      : 0; // missing date sorts oldest
    return { index, offer, ts };
  });
  entries.sort((a, b) => a.ts - b.ts);
  const picked = entries.slice(0, limit).map(({ index, offer }) => ({ index, offer }));
  const remaining = entries.slice(limit);
  const oldestRemaining = remaining.length > 0
    ? (remaining[0].offer.verifiedDate || null)
    : null;
  return { picked, oldestRemaining };
}

export function staggeredDate(now, rand = Math.random) {
  const offsetDays = Math.floor(rand() * STAGGER_WINDOW_DAYS);
  const d = new Date(now.getTime() - offsetDays * 24 * 60 * 60 * 1000);
  return d.toISOString().split("T")[0];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runUrlMode(picked, data, dryRun, now) {
  let verified = 0;
  let flagged = 0;
  for (let i = 0; i < picked.length; i += URL_CONCURRENCY) {
    const batch = picked.slice(i, i + URL_CONCURRENCY);
    const results = await reverifyBatch(batch);
    for (const v of results.verified) {
      if (!dryRun) {
        data.offers[v.index].verifiedDate = staggeredDate(now);
      }
      verified++;
    }
    for (const f of results.flagged) {
      console.log(`  ⚠ ${f.vendor} — ${f.error} (${f.url})`);
      flagged++;
    }
  }
  return { verified, flagged, changed: 0, changes: [] };
}

async function runAiMode(picked, data, dryRun, now) {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY required for --ai mode");
  }
  const client = new Anthropic();

  let verified = 0;
  let flagged = 0;
  let changed = 0;
  const changes = [];

  for (const entry of picked) {
    const { offer, index } = entry;
    const page = await fetchPageText(offer.url);
    if (!page.ok) {
      console.log(`  ⚠ ${offer.vendor} — ${page.error} (${offer.url})`);
      flagged++;
      await sleep(AI_RATE_LIMIT_MS);
      continue;
    }
    let result;
    try {
      result = await verifyWithHaiku(client, offer, page.text);
    } catch (err) {
      console.log(`  ⚠ ${offer.vendor} — AI error: ${err.message}`);
      flagged++;
      await sleep(AI_RATE_LIMIT_MS);
      continue;
    }
    if (result.status === "confirmed") {
      if (!dryRun) {
        data.offers[index].verifiedDate = staggeredDate(now);
      }
      verified++;
    } else if (result.status === "changed") {
      changed++;
      changes.push({
        vendor: offer.vendor,
        category: offer.category,
        tier: offer.tier,
        summary: result.summary,
      });
      console.log(`  ⚠ ${offer.vendor} (${offer.category}, ${offer.tier}): ${result.summary}`);
    } else {
      flagged++;
      console.log(`  ⚠ ${offer.vendor} — unclear: ${result.summary || "no detail"}`);
    }
    await sleep(AI_RATE_LIMIT_MS);
  }
  return { verified, flagged, changed, changes };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const useAi = args.includes("--ai");

  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1
    ? parseInt(args[limitIdx + 1], 10)
    : DEFAULT_LIMIT;

  if (isNaN(limit) || limit < 1) {
    console.error(`Invalid limit: ${args[limitIdx + 1]}. Must be a positive integer.`);
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
  const now = new Date();
  const { picked, oldestRemaining } = pickOldestEntries(offers, limit, now);

  console.log(
    `Rolling re-verification — ${picked.length} oldest entries` +
      (useAi ? " (Haiku)" : " (URL-only)") +
      (dryRun ? " (dry-run)" : "")
  );
  console.log("");

  if (picked.length === 0) {
    console.log("No entries to process.");
    process.exit(0);
  }

  const result = useAi
    ? await runAiMode(picked, data, dryRun, now)
    : await runUrlMode(picked, data, dryRun, now);

  if (!dryRun && result.verified > 0) {
    writeFileSync(INDEX_PATH, JSON.stringify(data, null, 2) + "\n");
  }

  console.log("");
  console.log("── Summary ──");
  console.log(`Checked: ${picked.length}`);
  console.log(`Verified (date bumped): ${result.verified}`);
  if (useAi) console.log(`Changed (PM review needed): ${result.changed}`);
  console.log(`Flagged (URL/AI failure): ${result.flagged}`);
  console.log(`Oldest remaining verifiedDate: ${oldestRemaining ?? "n/a"}`);
  console.log(`Total entries: ${offers.length}`);

  process.exit(0);
}

const isMainModule =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main().catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}

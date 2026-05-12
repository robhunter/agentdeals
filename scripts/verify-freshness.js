#!/usr/bin/env node

/**
 * AI-powered data freshness verification.
 *
 * Finds stale entries, fetches vendor pricing pages, and uses Claude Haiku
 * to verify whether stored deal information is still accurate. Updates
 * verifiedDate for confirmed entries; flags discrepancies for PM review.
 *
 * Usage:
 *   npm run verify-freshness                       # verify entries older than 25 days
 *   npm run verify-freshness -- --threshold 14     # custom threshold
 *   npm run verify-freshness -- --dry-run          # report only, don't modify data
 *   npm run verify-freshness -- --limit 50         # verify at most 50 entries
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(__dirname, "..", "data", "index.json");
const DEFAULT_THRESHOLD_DAYS = 25;
const FETCH_TIMEOUT_MS = 15_000;
const RATE_LIMIT_MS = 500; // 2 requests per second
const MAX_PAGE_TEXT_LENGTH = 12_000; // chars sent to Haiku
const HAIKU_MODEL = "claude-haiku-4-5-20251001";

// ── Helpers ──────────────────────────────────────────────────────────────────

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
    const diffDays = Math.floor(
      (now.getTime() - verified.getTime()) / (1000 * 60 * 60 * 24)
    );
    if (diffDays >= thresholdDays) {
      stale.push({ index: i, offer, daysSince: diffDays });
    } else {
      fresh.push({ index: i, offer });
    }
  }
  // Sort by staleness descending — verify the oldest first
  stale.sort((a, b) => (b.daysSince ?? Infinity) - (a.daysSince ?? Infinity));
  return { stale, freshCount: fresh.length };
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

export async function fetchPageText(url) {
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
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const html = await res.text();
    const text = stripHtml(html);
    if (text.length < 50) {
      return { ok: false, error: "page content too short (likely JS-rendered SPA)" };
    }
    const truncated = text.slice(0, MAX_PAGE_TEXT_LENGTH);
    return { ok: true, text: truncated };
  } catch (err) {
    const reason = err.name === "AbortError" ? "timeout" : err.message;
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyWithHaiku(client, offer, pageText) {
  const prompt = `You are verifying whether a vendor's deal/free-tier information is still accurate.

STORED DEAL INFO:
- Vendor: ${offer.vendor}
- Category: ${offer.category}
- Tier: ${offer.tier}
- Description: ${offer.description}

CURRENT PRICING PAGE TEXT (truncated):
${pageText}

Compare the stored deal info against the pricing page text. Focus on:
1. Does the tier/plan still exist?
2. Are the key limits/features still the same?
3. Has pricing changed (free → paid, limits reduced, etc.)?

Respond with EXACTLY one of these JSON objects (no other text):
- If the deal info is still accurate: {"status":"confirmed"}
- If you found a discrepancy: {"status":"changed","summary":"<brief description of what changed>"}
- If the page doesn't contain enough info to verify: {"status":"unclear","summary":"<reason>"}`;

  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 200,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0]?.text?.trim();
  try {
    const parsed = JSON.parse(text);
    if (["confirmed", "changed", "unclear"].includes(parsed.status)) {
      return parsed;
    }
  } catch {
    // Try to extract JSON from response
    const match = text?.match(/\{[^}]+\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (["confirmed", "changed", "unclear"].includes(parsed.status)) {
          return parsed;
        }
      } catch { /* fall through */ }
    }
  }
  return { status: "unclear", summary: "Could not parse AI response" };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function verifyFreshness({ thresholdDays, dryRun, limit, indexPath, now = new Date() }) {
  const data = JSON.parse(readFileSync(indexPath || INDEX_PATH, "utf-8"));
  const offers = data.offers || [];
  const { stale, freshCount } = findStaleOffers(offers, thresholdDays, now);

  if (stale.length === 0) {
    return {
      total: offers.length,
      alreadyFresh: freshCount,
      verified: 0,
      changed: 0,
      failed: 0,
      skipped: 0,
      changes: [],
      failures: [],
    };
  }

  const toVerify = limit ? stale.slice(0, limit) : stale;
  const skipped = stale.length - toVerify.length;

  let client;
  function getClient() {
    if (!client) {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error("ANTHROPIC_API_KEY environment variable is required");
      }
      client = new Anthropic();
    }
    return client;
  }
  const today = now.toISOString().split("T")[0];

  let verified = 0;
  let changed = 0;
  let failed = 0;
  const changes = [];
  const failures = [];

  for (const entry of toVerify) {
    const { offer, index } = entry;

    // Fetch pricing page
    const page = await fetchPageText(offer.url);
    if (!page.ok) {
      failed++;
      failures.push({ vendor: offer.vendor, category: offer.category, url: offer.url, error: page.error });
      await sleep(RATE_LIMIT_MS);
      continue;
    }

    // Verify with Haiku
    let result;
    try {
      result = await verifyWithHaiku(getClient(), offer, page.text);
    } catch (err) {
      failed++;
      failures.push({ vendor: offer.vendor, category: offer.category, url: offer.url, error: `AI error: ${err.message}` });
      await sleep(RATE_LIMIT_MS);
      continue;
    }

    if (result.status === "confirmed") {
      verified++;
      if (!dryRun) {
        data.offers[index].verifiedDate = today;
      }
    } else if (result.status === "changed") {
      changed++;
      changes.push({ vendor: offer.vendor, category: offer.category, tier: offer.tier, summary: result.summary });
    } else {
      // unclear — count as failed
      failed++;
      failures.push({ vendor: offer.vendor, category: offer.category, url: offer.url, error: result.summary || "unclear" });
    }

    await sleep(RATE_LIMIT_MS);
  }

  // Write updated index
  if (!dryRun && verified > 0) {
    writeFileSync(indexPath || INDEX_PATH, JSON.stringify(data, null, 2) + "\n");
  }

  return {
    total: offers.length,
    alreadyFresh: freshCount,
    staleFound: stale.length,
    verified,
    changed,
    failed,
    skipped,
    changes,
    failures,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  const thresholdIdx = args.indexOf("--threshold");
  const thresholdDays =
    thresholdIdx !== -1
      ? parseInt(args[thresholdIdx + 1], 10)
      : DEFAULT_THRESHOLD_DAYS;

  const limitIdx = args.indexOf("--limit");
  const limit =
    limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : undefined;

  if (isNaN(thresholdDays) || thresholdDays < 0) {
    console.error(
      `Invalid threshold: ${args[thresholdIdx + 1]}. Must be a non-negative integer.`
    );
    process.exit(2);
  }
  if (limit !== undefined && (isNaN(limit) || limit < 1)) {
    console.error(
      `Invalid limit: ${args[limitIdx + 1]}. Must be a positive integer.`
    );
    process.exit(2);
  }

  console.log(
    `Freshness verification — threshold: ${thresholdDays} days` +
      (limit ? `, limit: ${limit}` : "") +
      (dryRun ? " (dry-run)" : "")
  );
  console.log("");

  const result = await verifyFreshness({ thresholdDays, dryRun, limit });

  if (result.staleFound === undefined || result.staleFound === 0) {
    console.log(
      `All ${result.total} entries verified within ${thresholdDays} days.`
    );
    process.exit(0);
  }

  console.log(`Stale entries found: ${result.staleFound}`);
  if (result.skipped > 0) {
    console.log(`Skipped (over limit): ${result.skipped}`);
  }
  console.log("");

  // Report changes
  if (result.changes.length > 0) {
    console.log("⚠ DISCREPANCIES DETECTED (requires PM review):");
    for (const c of result.changes) {
      console.log(`  ${c.vendor} (${c.category}, ${c.tier}): ${c.summary}`);
    }
    console.log("");
  }

  // Report failures
  if (result.failures.length > 0) {
    console.log("✗ FAILED TO VERIFY:");
    for (const f of result.failures) {
      console.log(`  ${f.vendor} (${f.category}): ${f.error}`);
    }
    console.log("");
  }

  console.log("── Summary ──");
  console.log(
    `Verified: ${result.verified} | Changed: ${result.changed} | Failed: ${result.failed} | Skipped: ${result.skipped} | Already fresh: ${result.alreadyFresh} | Total: ${result.total}`
  );

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

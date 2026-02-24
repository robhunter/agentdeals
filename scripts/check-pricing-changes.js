#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HASHES_PATH = resolve(__dirname, "..", "data", "pricing-hashes.json");
const INDEX_PATH = resolve(__dirname, "..", "data", "index.json");
const FETCH_TIMEOUT_MS = 15000;

function extractTextContent(html) {
  // Extract visible text content only — far more stable than hashing full HTML.
  // Dynamic elements (nonces, hydration data, build hashes, session tokens)
  // live in tags/attributes, not visible text.
  let cleaned = html;
  // Remove entire head section (meta tags, scripts, styles, link tags)
  cleaned = cleaned.replace(/<head[\s\S]*?<\/head>/gi, "");
  // Remove script and style tags
  cleaned = cleaned.replace(/<script[\s\S]*?<\/script>/gi, "");
  cleaned = cleaned.replace(/<style[\s\S]*?<\/style>/gi, "");
  // Remove SVG content (icon hashes change)
  cleaned = cleaned.replace(/<svg[\s\S]*?<\/svg>/gi, "");
  // Remove all HTML tags, keeping text content
  cleaned = cleaned.replace(/<[^>]+>/g, " ");
  // Decode common HTML entities
  cleaned = cleaned.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  // Remove remaining HTML entities
  cleaned = cleaned.replace(/&#?\w+;/g, " ");
  // Remove hex strings (build hashes, trace IDs) — 8+ hex chars
  cleaned = cleaned.replace(/\b[0-9a-f]{8,}\b/gi, "");
  // Remove UUIDs
  cleaned = cleaned.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "");
  // Remove ISO timestamps and date-time strings
  cleaned = cleaned.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}[^\s]*/g, "");
  // Remove Unix timestamps (10-13 digits)
  cleaned = cleaned.replace(/\b\d{10,13}\b/g, "");
  // Normalize whitespace
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
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  let data;
  try {
    data = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
  } catch (err) {
    console.error(`Failed to read index: ${err.message}`);
    process.exit(2);
  }

  const offers = data.offers || [];
  const missingUrl = offers.filter((o) => !o.url);
  if (missingUrl.length > 0) {
    console.error(`Warning: ${missingUrl.length} entries missing url field:`);
    for (const o of missingUrl) {
      console.error(`  - ${o.vendor}`);
    }
  }

  // Load existing hashes
  let previousHashes = {};
  const isBaseline = !existsSync(HASHES_PATH);
  if (!isBaseline) {
    try {
      previousHashes = JSON.parse(readFileSync(HASHES_PATH, "utf-8"));
    } catch {
      console.error("Warning: Could not parse existing hashes file, treating as baseline run.");
    }
  }

  const currentHashes = {};
  const changed = [];
  const errors = [];

  console.log(`Checking ${offers.length} vendor pricing pages...\n`);

  for (const offer of offers) {
    if (!offer.url) continue;

    process.stdout.write(`  ${offer.vendor}... `);
    try {
      const html = await fetchPage(offer.url);
      const cleaned = extractTextContent(html);
      const hash = hashContent(cleaned);
      currentHashes[offer.vendor] = { url: offer.url, hash, checkedAt: new Date().toISOString() };

      if (!isBaseline && previousHashes[offer.vendor] && previousHashes[offer.vendor].hash !== hash) {
        changed.push({ vendor: offer.vendor, url: offer.url });
        console.log("CHANGED");
      } else {
        console.log("ok");
      }
    } catch (err) {
      const reason = err.name === "AbortError" ? "timeout" : err.message;
      errors.push({ vendor: offer.vendor, url: offer.url, error: reason });
      currentHashes[offer.vendor] = previousHashes[offer.vendor] || { url: offer.url, hash: null, error: reason };
      console.log(`ERROR (${reason})`);
    }
  }

  // Write updated hashes
  writeFileSync(HASHES_PATH, JSON.stringify(currentHashes, null, 2) + "\n");

  console.log("");
  if (isBaseline) {
    console.log(`Baseline created: ${Object.keys(currentHashes).length} vendors hashed.`);
    console.log(`Hashes saved to ${HASHES_PATH}`);
  } else if (changed.length === 0) {
    console.log("No pricing page changes detected.");
  } else {
    console.log(`${changed.length} pricing page(s) changed:\n`);
    for (const c of changed) {
      console.log(`  ${c.vendor} — ${c.url}`);
    }
  }

  if (errors.length > 0) {
    console.log(`\n${errors.length} error(s):\n`);
    for (const e of errors) {
      console.log(`  ${e.vendor} — ${e.error} (${e.url})`);
    }
  }

  process.exit(changed.length > 0 ? 1 : 0);
}

main();

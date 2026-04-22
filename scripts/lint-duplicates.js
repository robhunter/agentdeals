#!/usr/bin/env node

// Detection-only lint for same-product-multi-category duplicates in data/index.json.
// Advisory output — does not modify data, exits 0. Each flagged candidate requires
// a human category-judgment call (see PR #983 rationale).
//
// Heuristic: same vendor name (exact match, case-insensitive), appearing in ≥2
// distinct categories, whose tier strings share at least one meaningful token
// after normalization. Catches e.g. Figma "Starter" vs "Free (Starter)"
// (shared: "starter") and Proton Pass "Free" vs "Free" (shared: "free"),
// while leaving Sentry "Developer" vs "OSS Sponsored" (no shared token) alone.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TIER_STOPWORDS = new Set([
  "plan",
  "tier",
  "account",
  "the",
  "a",
  "an",
  "of",
  "and",
  "or",
  "for",
]);

// Vendor name pairs to always exclude even if heuristic would match.
// Empty by default — the current known-legitimate multi-entry cases all use
// distinct vendor names (e.g. "Amazon Kiro" vs "Amazon Kiro (AWS Startups)")
// and are therefore naturally excluded by exact-name matching.
const ALLOWLIST = new Set([]);

export function tierTokens(tier) {
  if (!tier) return new Set();
  const normalized = String(tier)
    .toLowerCase()
    .replace(/[()[\]{}/,:;.!?]/g, " ");
  const tokens = normalized
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !TIER_STOPWORDS.has(t));
  return new Set(tokens);
}

export function sharedTierTokens(a, b) {
  const ta = tierTokens(a);
  const tb = tierTokens(b);
  const shared = [];
  for (const t of ta) if (tb.has(t)) shared.push(t);
  return shared;
}

export function findDuplicateCandidates(offers) {
  const byVendor = new Map();
  for (const o of offers) {
    if (!o.vendor) continue;
    const key = o.vendor.toLowerCase().trim();
    if (!byVendor.has(key)) byVendor.set(key, []);
    byVendor.get(key).push(o);
  }

  const candidates = [];
  for (const [, entries] of byVendor) {
    if (entries.length < 2) continue;
    if (ALLOWLIST.has(entries[0].vendor)) continue;

    // For each pair of entries with the same vendor name, check if they
    // (a) live in different categories and (b) share a tier token.
    const categories = new Set(entries.map((e) => e.category));
    if (categories.size < 2) continue;

    // Compute shared tier tokens across all entries — if ANY pair shares a
    // token and lives in different categories, flag the vendor.
    let flagged = false;
    let sharedTokensUnion = new Set();
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        if (entries[i].category === entries[j].category) continue;
        const shared = sharedTierTokens(entries[i].tier, entries[j].tier);
        if (shared.length > 0) {
          flagged = true;
          for (const t of shared) sharedTokensUnion.add(t);
        }
      }
    }
    if (!flagged) continue;

    candidates.push({
      vendor: entries[0].vendor,
      entries: entries.map((e) => ({ category: e.category, tier: e.tier })),
      sharedTierTokens: [...sharedTokensUnion].sort(),
    });
  }

  return candidates.sort((a, b) => a.vendor.localeCompare(b.vendor));
}

export function formatMarkdown(candidates) {
  if (candidates.length === 0) {
    return "## Duplicate candidates\n\nNo same-vendor-same-tier multi-category duplicates detected.\n";
  }
  const lines = [];
  lines.push("## Duplicate candidates");
  lines.push("");
  lines.push(
    `**${candidates.length} candidate${candidates.length === 1 ? "" : "s"}** — same vendor, shared tier token, ≥2 categories. Each requires a human category-judgment call (see PR #983).`,
  );
  lines.push("");
  for (const c of candidates) {
    lines.push(`### ${c.vendor}`);
    lines.push(`_Shared tier token(s): ${c.sharedTierTokens.join(", ")}_`);
    for (const e of c.entries) {
      lines.push(`- ${e.category} — ${e.tier}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function main() {
  const indexPath = resolve(__dirname, "..", "data", "index.json");
  let data;
  try {
    data = JSON.parse(readFileSync(indexPath, "utf-8"));
  } catch (err) {
    console.error(`Failed to read data/index.json: ${err.message}`);
    process.exit(2);
  }

  const offers = data.offers || [];
  const candidates = findDuplicateCandidates(offers);

  console.log(formatMarkdown(candidates));

  // Advisory only — always exit 0 so CI does not block merges.
  process.exit(0);
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main();
}

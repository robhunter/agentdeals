#!/usr/bin/env node

// Detection-only lint for same-product-multi-category duplicates in data/index.json.
// Advisory output — does not modify data, exits 0. Each flagged candidate requires
// a human category-judgment call (see PR #983 rationale).
//
// Heuristic: same vendor name (normalized — case-insensitive, TLD-suffix-stripped,
// corp-suffix-stripped), appearing in ≥2 distinct categories, whose tier strings
// share at least one meaningful token after normalization. Catches e.g. Figma
// "Starter" vs "Free (Starter)" (shared: "starter"), Proton Pass "Free" vs
// "Free" (shared: "free"), and Photopea "photopea.com" vs "Photopea" (TLD-suffix
// variant, same product), while leaving Sentry "Developer" vs "OSS Sponsored"
// (no shared token) alone and Amazon Kiro "Amazon Kiro" vs "Amazon Kiro (AWS
// Startups)" (parenthetical suffix preserved, different keys) alone.

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
// whose parenthetical suffixes are preserved by normalizeVendor, so they
// are naturally excluded by the (normalized) key-mismatch.
const ALLOWLIST = new Set([]);

// Normalize a vendor name for grouping: lowercase, strip common TLD suffixes,
// strip Inc./LLC/Ltd corporate suffixes, trim. Keeps parenthetical disambiguators
// intact (e.g. "Amazon Kiro (AWS Startups)" stays distinct from "Amazon Kiro").
// See op-learning #58: exact matching is sometimes a feature — normalization
// widens the equivalence class only where the variants are empirically the same
// product (e.g. "photopea.com" vs "Photopea").
const TLD_SUFFIX_RE = /\.(com|io|net|org|dev|app|co|ai)$/;
const CORP_SUFFIX_RE = /\s+(inc\.?|llc|ltd\.?)$/;

export function normalizeVendor(name) {
  return String(name || "")
    .toLowerCase()
    .trim()
    .replace(TLD_SUFFIX_RE, "")
    .replace(CORP_SUFFIX_RE, "")
    .trim();
}

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
    const key = normalizeVendor(o.vendor);
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

    const rawNames = [...new Set(entries.map((e) => e.vendor))].sort();
    const candidate = {
      vendor: entries[0].vendor,
      entries: entries.map((e) => ({
        vendor: e.vendor,
        category: e.category,
        tier: e.tier,
      })),
      sharedTierTokens: [...sharedTokensUnion].sort(),
    };
    if (rawNames.length > 1) candidate.vendorNameVariants = rawNames;
    candidates.push(candidate);
  }

  return candidates.sort((a, b) =>
    normalizeVendor(a.vendor).localeCompare(normalizeVendor(b.vendor)),
  );
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
    if (c.vendorNameVariants) {
      const variants = c.vendorNameVariants.map((v) => `"${v}"`).join(", ");
      lines.push(`_Vendor name variants: ${variants}_`);
    }
    for (const e of c.entries) {
      const label = c.vendorNameVariants ? `${e.vendor} — ${e.category}` : e.category;
      lines.push(`- ${label} — ${e.tier}`);
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

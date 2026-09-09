#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const AGGREGATOR_OUTCOME = "does_not_name_vendor";

export function normalizePricingUrl(url) {
  return String(url || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("#")[0]
    .split("?")[0]
    .replace(/\/+$/, "");
}

export function loadMergeRegistry(path) {
  const registryPath = path || resolve(__dirname, "..", "data", "vendor_merges.json");
  const raw = JSON.parse(readFileSync(registryPath, "utf-8"));
  return {
    merges: raw.merges || [],
    sharedPricingPages: raw.shared_pricing_pages || [],
  };
}

function vendorKey(name) {
  return String(name || "").trim().toLowerCase();
}

function sameVendorSet(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export function sharedPageGroups(offers, options = {}) {
  const { withinCategory = false, retired = [], allowlist = [] } = options;
  const retiredKeys = new Set(retired.map(vendorKey));
  const allowSets = allowlist.map((entry) => new Set((entry.vendors || entry).map(vendorKey)));

  const buckets = new Map();
  for (const offer of offers) {
    const url = normalizePricingUrl(offer.url);
    if (!url) continue;
    const key = withinCategory ? `${url} ${offer.category}` : url;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(offer);
  }

  const groups = [];
  for (const [, members] of buckets) {
    if (members.length < 2) continue;
    if (members.some((o) => o.source_check?.outcome === AGGREGATOR_OUTCOME)) continue;

    const live = members.filter((o) => !retiredKeys.has(vendorKey(o.vendor)));
    if (live.length < 2) continue;

    const vendors = new Set(live.map((o) => vendorKey(o.vendor)));
    if (vendors.size < 2) continue;
    if (allowSets.some((allowed) => sameVendorSet(vendors, allowed))) continue;

    groups.push({
      url: normalizePricingUrl(live[0].url),
      category: withinCategory ? live[0].category : null,
      vendors: live.map((o) => o.vendor).sort(),
      entries: live
        .map((o) => ({ vendor: o.vendor, category: o.category, tier: o.tier }))
        .sort((a, b) => a.vendor.localeCompare(b.vendor)),
    });
  }

  return groups.sort((a, b) => a.url.localeCompare(b.url) || a.vendors[0].localeCompare(b.vendors[0]));
}

export function blockingGroups(offers, registry = loadMergeRegistry()) {
  return sharedPageGroups(offers, {
    withinCategory: true,
    retired: registry.merges.map((m) => m.retired),
    allowlist: registry.sharedPricingPages,
  });
}

export function advisoryGroups(offers, registry = loadMergeRegistry()) {
  return sharedPageGroups(offers, {
    withinCategory: false,
    retired: registry.merges.map((m) => m.retired),
    allowlist: registry.sharedPricingPages,
  });
}

export function formatMarkdown(groups) {
  if (groups.length === 0) {
    return "## Shared pricing pages\n\nNo unreviewed group of records shares a pricing page.\n";
  }

  const lines = [
    "## Shared pricing pages",
    "",
    `${groups.length} group${groups.length === 1 ? "" : "s"} of records cite one pricing page. Each needs a judgement: one product indexed twice, or products that share a page.`,
    "",
  ];
  for (const group of groups) {
    lines.push(`### ${group.url}`);
    lines.push("");
    for (const entry of group.entries) {
      lines.push(`- ${entry.vendor} — ${entry.category} — ${entry.tier}`);
    }
    lines.push("");
    lines.push(
      "Merge it in `data/vendor_merges.json`, or record it there as a shared page if the products are distinct.",
    );
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

  console.log(formatMarkdown(advisoryGroups(data.offers || [])));
  process.exit(0);
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main();
}

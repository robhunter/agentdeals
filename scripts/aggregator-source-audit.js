#!/usr/bin/env node

/**
 * Report, per offer, whether anything readable states the terms we publish for
 * it — for records whose cited page does not name them (#1109 AC-3, AC-4).
 *
 * For each offer it tries, in order:
 *   1. a deep link on the aggregator it is already sourced from
 *   2. the vendor's own site, guessed from the vendor name
 * and reports what each answered. It repoints nothing.
 *
 * Usage:
 *   node scripts/aggregator-source-audit.js --out /tmp/aggregator.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPageText } from "./verify-freshness.js";
import { priceSignals } from "./change-gate.js";
import { pageNamesVendor } from "./vendor-naming.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH =
  process.env.AGENTDEALS_INDEX_PATH || resolve(__dirname, "..", "data", "index.json");
const CONCURRENCY = 8;

function arg(name, fallback = null) {
  const at = process.argv.indexOf(name);
  return at !== -1 ? process.argv[at + 1] : fallback;
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function candidateUrls(offer) {
  const host = new URL(offer.url).hostname.replace(/^www\./, "");
  const s = slug(offer.vendor);
  const out = [];
  if (host === "joinsecret.com") out.push({ kind: "deep_link", url: `https://www.joinsecret.com/${s}` });
  if (host === "brex.com") out.push({ kind: "deep_link", url: `https://www.brex.com/rewards/partner-perks` });
  const bare = s.replace(/-/g, "");
  out.push({ kind: "vendor_site", url: `https://${bare}.com/pricing` });
  out.push({ kind: "vendor_site", url: `https://${bare}.com/` });
  return out;
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

async function main() {
  const out = arg("--out", "/tmp/aggregator-source-audit.json");
  const data = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
  const offers = (data.offers || []).filter(
    (o) => o.source_check?.outcome === "does_not_name_vendor"
  );
  console.error(`${offers.length} offers whose cited page does not name them`);

  let done = 0;
  const rows = await mapWithConcurrency(offers, CONCURRENCY, async (offer) => {
    const attempts = [];
    for (const candidate of candidateUrls(offer)) {
      const page = await fetchPageText(candidate.url);
      if (!page.ok) {
        attempts.push({ ...candidate, ok: false, error: page.error });
        continue;
      }
      const naming = pageNamesVendor(page.text, offer.vendor, { url: candidate.url });
      attempts.push({
        ...candidate,
        ok: true,
        chars: page.text.length,
        signals: priceSignals(page.text).length,
        names: naming.named,
        via: naming.via,
      });
      if (naming.named && naming.via === "text") break;
    }
    done++;
    if (done % 10 === 0) console.error(`  ${done}/${offers.length}`);
    const usable = attempts.find((a) => a.ok && a.names && a.via === "text" && a.signals > 0);
    const namesOnly = attempts.find((a) => a.ok && a.names && a.via === "text");
    return {
      vendor: offer.vendor,
      category: offer.category,
      tier: offer.tier ?? null,
      description: offer.description,
      cited: offer.url,
      verdict: usable ? `readable_${usable.kind}` : namesOnly ? `names_but_no_terms_${namesOnly.kind}` : "nothing_readable",
      best: usable ?? namesOnly ?? null,
      attempts,
    };
  });

  const verdicts = {};
  for (const r of rows) verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
  console.error(JSON.stringify(verdicts, null, 2));
  writeFileSync(out, JSON.stringify({ verdicts, rows }, null, 2) + "\n");
  console.error(`wrote ${out}`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});

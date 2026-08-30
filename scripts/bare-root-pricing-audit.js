#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPageText } from "./verify-freshness.js";
import { priceSignals, MIN_PRICE_SIGNALS } from "./change-gate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH =
  process.env.AGENTDEALS_INDEX_PATH || resolve(__dirname, "..", "data", "index.json");
const CANDIDATE_PATHS = ["/pricing", "/plans", "/pricing.html"];
const CONCURRENCY = 12;

export function isBareRoot(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/" && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

export function candidateUrls(url) {
  const parsed = new URL(url);
  return CANDIDATE_PATHS.map((path) => `${parsed.origin}${path}`);
}

export async function readsPricing(url, fetchFn = fetchPageText) {
  const page = await fetchFn(url);
  if (!page.ok) return { url, ok: false, error: page.error, signals: 0 };
  const signals = priceSignals(page.text);
  return { url, ok: true, signals: signals.length, sample: signals.slice(0, 4) };
}

export async function auditOffer(offer, fetchFn = fetchPageText) {
  const root = await readsPricing(offer.url, fetchFn);
  const candidates = [];
  for (const url of candidateUrls(offer.url)) {
    candidates.push(await readsPricing(url, fetchFn));
  }
  const priced = [root, ...candidates].filter((r) => r.ok && r.signals >= MIN_PRICE_SIGNALS);
  return {
    vendor: offer.vendor,
    url: offer.url,
    root,
    candidates,
    best: priced.sort((a, b) => b.signals - a.signals)[0] ?? null,
  };
}

async function pool(items, worker, size) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

export function summarise(audits) {
  const total = audits.length;
  const rootPriced = audits.filter((a) => a.root.ok && a.root.signals >= MIN_PRICE_SIGNALS);
  const candidatePriced = audits.filter((a) =>
    a.candidates.some((c) => c.ok && c.signals >= MIN_PRICE_SIGNALS)
  );
  const anyPriced = audits.filter((a) => a.best);
  const candidate200 = audits.filter((a) => a.candidates.some((c) => c.ok));
  return {
    total,
    rootPriced: rootPriced.length,
    candidatePriced: candidatePriced.length,
    anyPriced: anyPriced.length,
    candidateReadable: candidate200.length,
    candidateReadableNoPricing: candidate200.length - candidatePriced.length,
    neither: total - anyPriced.length,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;
  const outIdx = args.indexOf("--out");
  const out = outIdx !== -1 ? args[outIdx + 1] : null;
  const outcomeIdx = args.indexOf("--outcome");
  const outcome = outcomeIdx !== -1 ? args[outcomeIdx + 1] : null;

  const data = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
  const all = data.offers || [];
  const offers = outcome
    ? all.filter((o) => o.source_check?.outcome === outcome)
    : all.filter((o) => isBareRoot(o.url));
  const subject = offers.slice(0, limit);

  console.log(
    `${outcome ? `Offers whose cited page came back ${outcome}` : "Bare-root offers"}: ${offers.length} of ${all.length}`
  );
  console.log(`Reading ${subject.length} of them, ${1 + CANDIDATE_PATHS.length} URLs each`);
  console.log("");

  let done = 0;
  const audits = await pool(
    subject,
    async (offer) => {
      const audit = await auditOffer(offer);
      done++;
      if (done % 50 === 0) console.log(`  … ${done}/${subject.length}`);
      return audit;
    },
    CONCURRENCY
  );

  const stats = summarise(audits);
  console.log("");
  console.log("── Summary ──");
  console.log(`Offers read: ${stats.total}`);
  console.log(`Stored root itself carries price text: ${stats.rootPriced}`);
  console.log(`A candidate pricing page carries price text: ${stats.candidatePriced}`);
  console.log(`A candidate pricing page is readable but carries none: ${stats.candidateReadableNoPricing}`);
  console.log(`Either the root or a candidate carries price text: ${stats.anyPriced}`);
  console.log(`Nothing we can read states any terms: ${stats.neither}`);

  if (out) {
    writeFileSync(out, JSON.stringify({ stats, audits }, null, 2) + "\n");
    console.log(`\nPer-offer detail written to ${out}`);
  }
  process.exit(0);
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main().catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}

#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPageText } from "./verify-freshness.js";
import { priceSignals } from "./change-gate.js";
import {
  classifySource,
  sourceCheckRecord,
  SOURCE_CHECK_OK,
  SOURCE_CHECK_NO_TERMS,
} from "./vendor-naming.js";
import { isBareRoot } from "./bare-root-pricing-audit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH =
  process.env.AGENTDEALS_INDEX_PATH || resolve(__dirname, "..", "data", "index.json");
const CONCURRENCY = 12;

export const ONE_HOP_PATHS = ["/pricing", "/pricing/", "/plans", "/pricing.html"];

export function oneHopUrls(url) {
  const { origin } = new URL(url);
  return ONE_HOP_PATHS.map((path) => `${origin}${path}`);
}

function withoutTrailingSlash(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

export function samePage(one, other) {
  return withoutTrailingSlash(one) === withoutTrailingSlash(other);
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export async function readPageFor(offer, url, fetchFn = fetchPageText, checked = today()) {
  const page = await fetchFn(url);
  if (!page.ok) return { url, ok: false, error: page.error };
  const signals = priceSignals(page.text);
  const { outcome, detail } = classifySource({ ...offer, url }, page, signals);
  return {
    url,
    ok: true,
    final_url: page.finalUrl ?? url,
    chars: page.text.length,
    signals: signals.length,
    outcome,
    detail,
    check: sourceCheckRecord({ ...offer, url }, page, signals, checked),
  };
}

export function answersForTheOffer(reading, rootUrl) {
  if (!reading || !reading.ok) return false;
  if (samePage(reading.final_url, rootUrl)) return false;
  return reading.outcome === SOURCE_CHECK_OK;
}

export function redirectsToTheRoot(reading, rootUrl) {
  return Boolean(reading?.ok) && samePage(reading.final_url, rootUrl);
}

export async function probeOffer(offer, fetchFn = fetchPageText, checked = today()) {
  const root = await readPageFor(offer, offer.url, fetchFn, checked);
  const hops = [];
  for (const url of oneHopUrls(offer.url)) {
    hops.push(await readPageFor(offer, url, fetchFn, checked));
  }
  const answering = hops
    .filter((hop) => answersForTheOffer(hop, offer.url))
    .sort((one, other) => other.signals - one.signals);
  const [winner, ...lost] = answering;
  return {
    vendor: offer.vendor,
    url: offer.url,
    stored_outcome: offer.source_check?.outcome ?? null,
    stored_checked: offer.source_check?.checked ?? null,
    verified_date: offer.verifiedDate ?? null,
    root,
    hops,
    repoint_to: winner?.url ?? null,
    winner_signals: winner?.signals ?? 0,
    winner_detail: winner?.detail ?? null,
    winner_check: winner?.check ?? null,
    lost_to_the_winner: lost.map((hop) => hop.url),
  };
}

export function repointsTheReportEarned(probes) {
  return probes.filter(
    (probe) =>
      probe.repoint_to &&
      probe.winner_check &&
      !(probe.root.ok && probe.root.outcome === SOURCE_CHECK_OK)
  );
}

export function applyRepoints(offers, probes) {
  const applied = [];
  const movedSinceTheProbe = [];
  for (const probe of repointsTheReportEarned(probes)) {
    const offer = offers.find((one) => one.vendor === probe.vendor && one.url === probe.url);
    if (!offer) {
      movedSinceTheProbe.push(probe.vendor);
      continue;
    }
    offer.url = probe.repoint_to;
    offer.source_check = probe.winner_check;
    applied.push({ vendor: probe.vendor, from: probe.url, to: probe.repoint_to });
  }
  return { applied, movedSinceTheProbe };
}

export function summarise(probes) {
  const rootAnswers = probes.filter((p) => p.root.ok && p.root.outcome === SOURCE_CHECK_OK);
  const rootUnreadable = probes.filter((p) => !p.root.ok);
  const rootStatesNoTerms = probes.filter((p) => p.root.ok && p.root.outcome === SOURCE_CHECK_NO_TERMS);
  const repointable = repointsTheReportEarned(probes);
  const redirectsHome = probes.filter((p) => p.hops.some((hop) => redirectsToTheRoot(hop, p.url)));
  const hopNamesNoVendor = probes.filter((p) =>
    p.hops.some((hop) => hop.ok && hop.outcome === "does_not_name_vendor")
  );
  const hopReadableNoTerms = probes.filter((p) =>
    p.hops.some((hop) => hop.ok && hop.outcome === SOURCE_CHECK_NO_TERMS)
  );
  return {
    population: probes.length,
    root_answers_today: rootAnswers.length,
    root_states_no_terms: rootStatesNoTerms.length,
    root_unreadable: rootUnreadable.length,
    root_other: probes.length - rootAnswers.length - rootStatesNoTerms.length - rootUnreadable.length,
    one_hop_answers: repointable.length,
    one_hop_redirects_to_the_root: redirectsHome.length,
    one_hop_readable_states_no_terms: hopReadableNoTerms.length,
    one_hop_does_not_name_vendor: hopNamesNoVendor.length,
    nothing_we_read_answers:
      probes.length - rootAnswers.length - repointable.length,
    winners_by_path: ONE_HOP_PATHS.reduce((tally, path) => {
      tally[path] = repointable.filter((p) => new URL(p.repoint_to).pathname === path).length;
      return tally;
    }, {}),
  };
}

function arg(name, fallback = null) {
  const at = process.argv.indexOf(name);
  return at !== -1 ? process.argv[at + 1] : fallback;
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function cachedFetcher(cacheDir) {
  if (!cacheDir) return fetchPageText;
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const pathFor = (url) => join(cacheDir, `${createHash("sha1").update(url).digest("hex")}.json`);
  return async (url) => {
    const at = pathFor(url);
    if (existsSync(at)) return JSON.parse(readFileSync(at, "utf-8"));
    const fetched = await fetchPageText(url);
    const page = fetched.ok
      ? {
          ok: true,
          text: fetched.text,
          structured: fetched.structured ?? null,
          finalUrl: fetched.finalUrl ?? url,
        }
      : { ok: false, error: fetched.error };
    writeFileSync(at, JSON.stringify(page));
    return page;
  };
}

function applyFromReport(reportPath) {
  const data = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
  const { probes } = JSON.parse(readFileSync(reportPath, "utf-8"));
  const datesBefore = new Map((data.offers ?? []).map((offer) => [offer.vendor, offer.verifiedDate]));
  const { applied, movedSinceTheProbe } = applyRepoints(data.offers ?? [], probes);
  const advanced = (data.offers ?? []).filter(
    (offer) => datesBefore.get(offer.vendor) !== offer.verifiedDate
  );
  if (advanced.length > 0) {
    console.error(`refusing to write: ${advanced.length} verified dates moved`);
    process.exit(2);
  }
  writeFileSync(INDEX_PATH, JSON.stringify(data, null, 2) + "\n");
  console.error(`repointed ${applied.length} offers in ${INDEX_PATH}, 0 verified dates moved`);
  if (movedSinceTheProbe.length > 0) {
    console.error(`left alone, moved since the probe: ${movedSinceTheProbe.join(", ")}`);
  }
}

async function main() {
  const report = arg("--apply");
  if (report) return applyFromReport(report);

  const out = arg("--out", "/tmp/bare-root-one-hop.json");
  const outcome = arg("--outcome", SOURCE_CHECK_NO_TERMS);
  const limit = arg("--limit") ? parseInt(arg("--limit"), 10) : null;
  const fetchFn = cachedFetcher(arg("--cache"));

  const data = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
  const all = data.offers ?? [];
  let population = all.filter(
    (offer) => isBareRoot(offer.url) && offer.source_check?.outcome === outcome
  );
  if (limit) population = population.slice(0, limit);

  console.error(
    `${population.length} offers cite a bare root and last came back ${outcome}, of ${all.length}`
  );
  console.error(`reading ${1 + ONE_HOP_PATHS.length} URLs each, ${CONCURRENCY} offers at a time`);

  let done = 0;
  const probes = await mapWithConcurrency(population, CONCURRENCY, async (offer) => {
    const probe = await probeOffer(offer, fetchFn);
    done++;
    if (done % 25 === 0) console.error(`  ${done}/${population.length}`);
    return probe;
  });

  const summary = summarise(probes);
  console.error(JSON.stringify(summary, null, 2));
  writeFileSync(out, JSON.stringify({ summary, probes }, null, 2) + "\n");
  console.error(`wrote ${out}`);
}

const runningAsScript =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (runningAsScript) {
  main().catch((err) => {
    console.error(`fatal: ${err.message}`);
    process.exit(1);
  });
}

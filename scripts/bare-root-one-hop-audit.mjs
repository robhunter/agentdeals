#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPageText } from "./verify-freshness.js";
import { priceSignals, figuresWeAlsoPublish, quantifiedAttributes } from "./change-gate.js";
import {
  classifySource,
  sourceCheckRecord,
  statesAnAmount,
  statesAnAmountOfZero,
  SOURCE_CHECK_OK,
  SOURCE_CHECK_FREE_PRICE,
  SOURCE_CHECK_NO_AMOUNT,
  SOURCE_CHECK_NO_TERMS,
} from "./vendor-naming.js";
import { reportedFigures } from "./withdraw-figures-we-do-not-publish.js";
import { FREE_PLAN_EXCERPT } from "./free-plan-excerpt.js";
import { isBareRoot } from "./bare-root-pricing-audit.js";
import { offerRetired } from "../dist/retirement.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH =
  process.env.AGENTDEALS_INDEX_PATH || resolve(__dirname, "..", "data", "index.json");
const CONCURRENCY = 12;

export const ONE_HOP_PATHS = ["/pricing", "/pricing/", "/plans", "/pricing.html"];

export const MOST_AMOUNTS_NAMED = 6;

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
    figures_we_also_publish: figuresWeAlsoPublish(signals, offer.description),
    amounts_the_page_states: signals.filter(statesAnAmount).slice(0, MOST_AMOUNTS_NAMED),
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
  const repository = REPOSITORIES_OF_OPEN_SOURCE_EDITIONS.has(offer.vendor)
    ? await readPageFor(offer, REPOSITORIES_OF_OPEN_SOURCE_EDITIONS.get(offer.vendor), fetchFn, checked)
    : null;
  return {
    vendor: offer.vendor,
    url: offer.url,
    tier: offer.tier ?? null,
    terms_we_hold: offer.description ?? null,
    stored_outcome: offer.source_check?.outcome ?? null,
    stored_checked: offer.source_check?.checked ?? null,
    verified_date: offer.verifiedDate ?? null,
    root,
    hops,
    repoint_to: winner?.url ?? null,
    winner_signals: winner?.signals ?? 0,
    winner_detail: winner?.detail ?? null,
    winner_check: winner?.check ?? null,
    winner_figures_we_also_publish: winner?.figures_we_also_publish ?? [],
    winner_amounts_the_page_states: winner?.amounts_the_page_states ?? [],
    lost_to_the_winner: lost.map((hop) => hop.url),
    repository,
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

export function quotesAFigureWeAlsoPublish(probe) {
  return (probe.winner_figures_we_also_publish ?? []).length > 0;
}

export function reportsOnlyAStatedZero(probe) {
  const figures = reportedFigures(probe.winner_check?.detail)?.figures ?? [];
  return figures.length > 0 && figures.every(statesAnAmountOfZero);
}

export function statesAZeroAndNoFigureOfOurs(probe) {
  return !quotesAFigureWeAlsoPublish(probe) && reportsOnlyAStatedZero(probe);
}

export function theRulingCovers(probe) {
  return quotesAFigureWeAlsoPublish(probe) || reportsOnlyAStatedZero(probe);
}

export const HELD_LISTINGS = new Map([
  ["Zulip", "its pricing page states storage per user, and the terms we hold state a total"],
]);

export const AN_ENDED_LISTING =
  "the listing has ended, and a pricing page still standing does not state what it offers";

export const AN_OPEN_SOURCE_TIER = /\bOSS\b|open[- ]?source|self[- ]?host/i;

export function anOpenSourceEdition(listing) {
  return AN_OPEN_SOURCE_TIER.test(listing.tier ?? "");
}

export const AN_OPEN_SOURCE_EDITION =
  "the listing is an open-source edition, which cites its repository or self-hosting docs, never the hosted product's pricing page";

export const REPOSITORIES_OF_OPEN_SOURCE_EDITIONS = new Map([
  ["Umami", "https://github.com/umami-software/umami"],
]);

const OUTCOMES_THAT_NAME_THE_LISTING = new Set([
  SOURCE_CHECK_OK,
  SOURCE_CHECK_FREE_PRICE,
  SOURCE_CHECK_NO_AMOUNT,
  SOURCE_CHECK_NO_TERMS,
]);

export function theRepositoryNamesTheListing(reading) {
  return Boolean(reading?.ok) && OUTCOMES_THAT_NAME_THE_LISTING.has(reading.outcome);
}

export function reasonToHold(listing) {
  if (HELD_LISTINGS.has(listing.vendor)) return HELD_LISTINGS.get(listing.vendor);
  if (offerRetired(listing)) return AN_ENDED_LISTING;
  if (anOpenSourceEdition(listing)) return AN_OPEN_SOURCE_EDITION;
  return null;
}

export function repointsTheRulingTakes(probes) {
  return repointsTheReportEarned(probes).filter(
    (probe) => theRulingCovers(probe) && reasonToHold(probe) === null
  );
}

export function repointsToTheirRepository(probes) {
  return repointsTheReportEarned(probes).filter(
    (probe) =>
      theRulingCovers(probe) &&
      reasonToHold(probe) === AN_OPEN_SOURCE_EDITION &&
      theRepositoryNamesTheListing(probe.repository)
  );
}

export function heldBeforeRepointing(probes) {
  const citingTheirRepository = new Set(repointsToTheirRepository(probes));
  return repointsTheReportEarned(probes)
    .filter(
      (probe) =>
        theRulingCovers(probe) && reasonToHold(probe) !== null && !citingTheirRepository.has(probe)
    )
    .map((probe) => ({
      vendor: probe.vendor,
      url: probe.url,
      the_page_we_are_not_citing: probe.repoint_to,
      reason: reasonToHold(probe),
    }));
}

export function heldForStatingOnlyAmountsNotOurs(probes) {
  return repointsTheReportEarned(probes).filter((probe) => !theRulingCovers(probe));
}

export function heldPopulation(probes) {
  return heldForStatingOnlyAmountsNotOurs(probes).map((probe) => ({
    vendor: probe.vendor,
    url: probe.url,
    the_page_we_are_not_citing: probe.repoint_to,
    amounts_the_page_states: probe.winner_amounts_the_page_states,
    terms_we_hold: probe.terms_we_hold,
  }));
}

export function termsStateAQuantity(probe) {
  return quantifiedAttributes(probe.terms_we_hold ?? "").length > 0;
}

export function repointsStatingAZero(probes) {
  const taken = repointsTheRulingTakes(probes).filter(statesAZeroAndNoFigureOfOurs);
  const named = (probe) => ({
    vendor: probe.vendor,
    repointed_to: probe.repoint_to,
    terms_we_hold: probe.terms_we_hold,
  });
  return {
    terms_state_a_quantity_the_page_did_not_match: taken.filter(termsStateAQuantity).map(named),
    terms_state_no_quantity_we_can_read: taken
      .filter((probe) => !termsStateAQuantity(probe))
      .map(named),
  };
}

export function verifiedDatesThatMoved(before, offers) {
  return offers
    .map((offer, at) => ({ vendor: offer.vendor, from: before[at], to: offer.verifiedDate }))
    .filter((seen) => seen.from !== seen.to);
}

export function offersTheProbeMatches(offers, probe) {
  return offers.filter((one) => one.vendor === probe.vendor && one.url === probe.url);
}

function repointsToApply(probes) {
  return [
    ...repointsTheRulingTakes(probes).map((probe) => ({
      probe,
      to: probe.repoint_to,
      check: probe.winner_check,
      holdItLifts: null,
    })),
    ...repointsToTheirRepository(probes).map((probe) => ({
      probe,
      to: probe.repository.url,
      check: probe.repository.check,
      holdItLifts: AN_OPEN_SOURCE_EDITION,
    })),
  ];
}

export function applyRepoints(offers, probes) {
  const applied = [];
  const movedSinceTheProbe = [];
  const sharedByTwoOffers = [];
  const heldOnApplying = [];
  const excerptsLeftOnTheRoot = [];
  for (const { probe, to, check, holdItLifts } of repointsToApply(probes)) {
    const matched = offersTheProbeMatches(offers, probe);
    if (matched.length === 0) {
      movedSinceTheProbe.push(probe.vendor);
      continue;
    }
    if (matched.length > 1) {
      sharedByTwoOffers.push({ vendor: probe.vendor, url: probe.url, offers: matched.length });
      continue;
    }
    const [offer] = matched;
    const reason = reasonToHold(offer);
    if (reason !== null && reason !== holdItLifts) {
      heldOnApplying.push({ vendor: probe.vendor, reason });
      continue;
    }
    offer.url = to;
    offer.source_check = check;
    if (offer[FREE_PLAN_EXCERPT] && offer[FREE_PLAN_EXCERPT].url !== offer.url) {
      delete offer[FREE_PLAN_EXCERPT];
      excerptsLeftOnTheRoot.push(probe.vendor);
    }
    applied.push({ vendor: probe.vendor, from: probe.url, to });
  }
  return { applied, movedSinceTheProbe, sharedByTwoOffers, heldOnApplying, excerptsLeftOnTheRoot };
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
    one_hop_answers_quoting_a_figure_we_publish: repointable.filter(quotesAFigureWeAlsoPublish).length,
    one_hop_answers_stating_a_zero_and_no_figure_of_ours: repointable.filter(statesAZeroAndNoFigureOfOurs).length,
    one_hop_answers_stating_only_amounts_not_ours: heldForStatingOnlyAmountsNotOurs(probes).length,
    held_before_repointing: heldBeforeRepointing(probes).length,
    repoints_taken: repointsTheRulingTakes(probes).length,
    repointed_to_their_repository: repointsToTheirRepository(probes).length,
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
  const datesBefore = (data.offers ?? []).map((offer) => offer.verifiedDate);
  const { applied, movedSinceTheProbe, sharedByTwoOffers, heldOnApplying, excerptsLeftOnTheRoot } = applyRepoints(
    data.offers ?? [],
    probes
  );
  const advanced = verifiedDatesThatMoved(datesBefore, data.offers ?? []);
  if (advanced.length > 0) {
    console.error(`refusing to write: ${advanced.length} verified dates moved`);
    process.exit(2);
  }
  writeFileSync(INDEX_PATH, JSON.stringify(data, null, 2) + "\n");
  console.error(`repointed ${applied.length} offers in ${INDEX_PATH}, 0 verified dates moved`);
  const stating = repointsStatingAZero(probes);
  console.error(
    `of those, stating a zero and no figure of ours: ${stating.terms_state_a_quantity_the_page_did_not_match.length} whose terms state a quantity the page did not match, ${stating.terms_state_no_quantity_we_can_read.length} whose terms state no quantity we can read`
  );
  console.error(
    `held, page states amounts and none matched the terms we hold: ${heldForStatingOnlyAmountsNotOurs(probes).length}`
  );
  for (const probe of repointsToTheirRepository(probes)) {
    console.error(`${probe.vendor} cites its repository ${probe.repository.url}, not ${probe.repoint_to}`);
  }
  for (const held of [...heldBeforeRepointing(probes), ...heldOnApplying]) {
    console.error(`held, ${held.vendor}: ${held.reason}`);
  }
  if (excerptsLeftOnTheRoot.length > 0) {
    console.error(`removed the excerpt read from the root they no longer cite: ${excerptsLeftOnTheRoot.join(", ")}`);
  }
  if (movedSinceTheProbe.length > 0) {
    console.error(`left alone, moved since the probe: ${movedSinceTheProbe.join(", ")}`);
  }
  for (const pair of sharedByTwoOffers) {
    console.error(`left alone, ${pair.offers} offers share ${pair.vendor} at ${pair.url}`);
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
  const held = heldPopulation(probes);
  console.error(JSON.stringify(summary, null, 2));
  writeFileSync(
    out,
    JSON.stringify(
      {
        summary,
        held,
        held_before_repointing: heldBeforeRepointing(probes),
        to_their_repository: repointsToTheirRepository(probes).map((probe) => ({
          vendor: probe.vendor,
          url: probe.url,
          repointed_to: probe.repository.url,
          the_page_we_are_not_citing: probe.repoint_to,
        })),
        stating_a_zero: repointsStatingAZero(probes),
        probes,
      },
      null,
      2
    ) + "\n"
  );
  console.error(`wrote ${out}, naming ${held.length} held offers with the amounts their page states`);
}

const runningAsScript =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (runningAsScript) {
  main().catch((err) => {
    console.error(`fatal: ${err.message}`);
    process.exit(1);
  });
}

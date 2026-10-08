import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITES = ["test/bare-root-one-hop.test.ts"];
const AUDIT = "scripts/bare-root-one-hop-audit.mjs";

const MUTANTS = [
  ["a-hop-that-resolves-back-to-the-root-still-answers", AUDIT,
    `  if (samePage(reading.final_url, rootUrl)) return false;\n  return reading.outcome === SOURCE_CHECK_OK;`,
    `  return reading.outcome === SOURCE_CHECK_OK;`],

  ["any-page-that-resolves-answers", AUDIT,
    `  return reading.outcome === SOURCE_CHECK_OK;\n}`,
    `  return true;\n}`],

  ["a-hop-that-states-no-terms-answers", AUDIT,
    `  return reading.outcome === SOURCE_CHECK_OK;\n}`,
    `  return reading.outcome === SOURCE_CHECK_OK || reading.outcome === SOURCE_CHECK_NO_TERMS;\n}`],

  ["the-trailing-slash-makes-it-a-different-page", AUDIT,
    `    return \`\${parsed.origin}\${parsed.pathname.replace(/\\/+$/, "")}\`;`,
    `    return \`\${parsed.origin}\${parsed.pathname}\`;`],

  ["we-never-ask-for-the-pricing-path-with-a-trailing-slash", AUDIT,
    `export const ONE_HOP_PATHS = ["/pricing", "/pricing/", "/plans", "/pricing.html"];`,
    `export const ONE_HOP_PATHS = ["/pricing", "/plans", "/pricing.html"];`],

  ["the-paths-that-also-answered-go-unreported", AUDIT,
    `    lost_to_the_winner: lost.map((hop) => hop.url),`,
    `    lost_to_the_winner: [],`],

  ["a-root-that-answers-today-is-counted-as-repointable", AUDIT,
    `  return probes.filter(\n    (probe) =>\n      probe.repoint_to &&\n      probe.winner_check &&\n      !(probe.root.ok && probe.root.outcome === SOURCE_CHECK_OK)\n  );`,
    `  return probes.filter((probe) => probe.repoint_to);`],

  ["the-repoint-restamps-the-verified-date", AUDIT,
    `    offer.url = to;\n    offer.source_check = check;`,
    `    offer.url = to;\n    offer.source_check = check;\n    offer.verifiedDate = check.checked;`],

  ["the-repoint-keeps-the-check-taken-on-the-root", AUDIT,
    `    offer.source_check = check;`,
    `    offer.source_check = probe.root.check;`],

  ["an-offer-whose-url-moved-since-the-probe-is-repointed-anyway", AUDIT,
    `  return offers.filter((one) => one.vendor === probe.vendor && one.url === probe.url);`,
    `  return offers.filter((one) => one.vendor === probe.vendor);`],

  ["a-root-we-could-not-fetch-is-counted-as-read", AUDIT,
    `  const rootUnreadable = probes.filter((p) => !p.root.ok);`,
    `  const rootUnreadable = probes.filter((p) => p.root.ok === false && p.root.error === "");`],

  ["the-ruling-takes-every-repoint-the-probe-earned", AUDIT,
    `    (probe) => theRulingCovers(probe) && reasonToHold(probe) === null`,
    `    (probe) => reasonToHold(probe) === null`],

  ["a-page-matching-none-of-our-figures-counts-as-quoting-one", AUDIT,
    `  return (probe.winner_figures_we_also_publish ?? []).length > 0;`,
    `  return true;`],

  ["a-stated-amount-counts-as-a-figure-we-publish", AUDIT,
    `    winner_figures_we_also_publish: winner?.figures_we_also_publish ?? [],`,
    `    winner_figures_we_also_publish: winner?.amounts_the_page_states ?? [],`],

  ["a-vendor-and-url-carrying-two-offers-repoints-the-first", AUDIT,
    `    if (matched.length > 1) {\n      sharedByTwoOffers.push({ vendor: probe.vendor, url: probe.url, offers: matched.length });\n      continue;\n    }\n    const [offer] = matched;`,
    `    const [offer] = matched;`],

  ["the-held-population-is-the-repoints-we-took", AUDIT,
    `  return repointsTheReportEarned(probes).filter((probe) => !theRulingCovers(probe));`,
    `  return repointsTheReportEarned(probes).filter((probe) => theRulingCovers(probe));`],

  ["a-held-offer-is-named-without-the-amounts-its-page-states", AUDIT,
    `    amounts_the_page_states: probe.winner_amounts_the_page_states,`,
    `    amounts_the_page_states: [],`],

  ["a-held-offer-is-named-without-the-terms-we-hold", AUDIT,
    `    terms_we_hold: probe.terms_we_hold,\n  }));`,
    `    terms_we_hold: null,\n  }));`],

  ["the-summary-counts-no-repoint-as-held", AUDIT,
    `    one_hop_answers_stating_only_amounts_not_ours: heldForStatingOnlyAmountsNotOurs(probes).length,`,
    `    one_hop_answers_stating_only_amounts_not_ours: 0,`],

  ["a-page-stating-a-zero-and-none-of-our-figures-is-held", AUDIT,
    `  return quotesAFigureWeAlsoPublish(probe) || reportsOnlyAStatedZero(probe);`,
    `  return quotesAFigureWeAlsoPublish(probe);`],

  ["a-check-reporting-a-zero-beside-another-amount-counts-as-the-zero", AUDIT,
    `  return figures.length > 0 && figures.every(statesAnAmountOfZero);`,
    `  return figures.some(statesAnAmountOfZero);`],

  ["a-check-reporting-no-figure-counts-as-a-zero", AUDIT,
    `  return figures.length > 0 && figures.every(statesAnAmountOfZero);`,
    `  return figures.every(statesAnAmountOfZero);`],

  ["a-zero-beside-a-figure-we-publish-counts-as-the-zero", AUDIT,
    `  return !quotesAFigureWeAlsoPublish(probe) && reportsOnlyAStatedZero(probe);`,
    `  return reportsOnlyAStatedZero(probe) || quotesAFigureWeAlsoPublish(probe);`],

  ["zulip-is-not-held", AUDIT,
    `  if (HELD_LISTINGS.has(listing.vendor)) return HELD_LISTINGS.get(listing.vendor);\n`,
    ``],

  ["an-ended-listing-is-not-held", AUDIT,
    `  if (offerRetired(listing)) return AN_ENDED_LISTING;\n`,
    ``],

  ["the-repoint-does-not-ask-the-listing-it-writes-whether-it-is-held", AUDIT,
    `    const reason = reasonToHold(offer);`,
    `    const reason = null;`],

  ["a-held-listing-is-named-without-its-reason", AUDIT,
    `      reason: reasonToHold(probe),\n    }));`,
    `      reason: null,\n    }));`],

  ["the-held-list-names-the-repoints-taken", AUDIT,
    `        theRulingCovers(probe) && reasonToHold(probe) !== null && !citingTheirRepository.has(probe)`,
    `        theRulingCovers(probe)`],

  ["every-zero-repoint-is-filed-as-stating-a-quantity", AUDIT,
    `  return quantifiedAttributes(probe.terms_we_hold ?? "").length > 0;`,
    `  return true;`],

  ["the-zero-lists-take-repoints-that-quote-our-figures", AUDIT,
    `  const taken = repointsTheRulingTakes(probes).filter(statesAZeroAndNoFigureOfOurs);`,
    `  const taken = repointsTheRulingTakes(probes);`],

  ["the-summary-counts-every-repoint-as-quoting-a-figure", AUDIT,
    `    one_hop_answers_quoting_a_figure_we_publish: repointable.filter(quotesAFigureWeAlsoPublish).length,`,
    `    one_hop_answers_quoting_a_figure_we_publish: repointsTheRulingTakes(probes).length,`],

  ["the-summary-counts-no-zero-repoint", AUDIT,
    `    one_hop_answers_stating_a_zero_and_no_figure_of_ours: repointable.filter(statesAZeroAndNoFigureOfOurs).length,`,
    `    one_hop_answers_stating_a_zero_and_no_figure_of_ours: 0,`],

  ["the-summary-counts-no-held-listing", AUDIT,
    `    held_before_repointing: heldBeforeRepointing(probes).length,`,
    `    held_before_repointing: 0,`],

  ["the-summary-counts-every-answer-as-taken", AUDIT,
    `    repoints_taken: repointsTheRulingTakes(probes).length,`,
    `    repoints_taken: repointable.length,`],

  ["the-repoint-keeps-an-excerpt-read-from-the-root", AUDIT,
    `      delete offer[FREE_PLAN_EXCERPT];\n`,
    ``],

  ["the-repoint-removes-every-excerpt", AUDIT,
    `    if (offer[FREE_PLAN_EXCERPT] && offer[FREE_PLAN_EXCERPT].url !== offer.url) {`,
    `    if (offer[FREE_PLAN_EXCERPT]) {`],

  ["the-probe-forgets-the-tier", AUDIT,
    `    tier: offer.tier ?? null,`,
    `    tier: null,`],

  ["an-open-source-edition-takes-the-hosted-pricing-page", AUDIT,
    `  if (anOpenSourceEdition(listing)) return AN_OPEN_SOURCE_EDITION;\n`,
    ``],

  ["only-a-tier-saying-oss-is-an-open-source-edition", AUDIT,
    `export const AN_OPEN_SOURCE_TIER = /\\bOSS\\b|open[- ]?source|self[- ]?host/i;`,
    `export const AN_OPEN_SOURCE_TIER = /\\bOSS\\b/i;`],

  ["a-tier-naming-a-self-hosted-edition-is-not-read", AUDIT,
    `export const AN_OPEN_SOURCE_TIER = /\\bOSS\\b|open[- ]?source|self[- ]?host/i;`,
    `export const AN_OPEN_SOURCE_TIER = /\\bOSS\\b|open[- ]?source/i;`],

  ["the-tier-is-read-case-sensitively", AUDIT,
    `export const AN_OPEN_SOURCE_TIER = /\\bOSS\\b|open[- ]?source|self[- ]?host/i;`,
    `export const AN_OPEN_SOURCE_TIER = /\\bOSS\\b|open[- ]?source|self[- ]?host/;`],

  ["any-tier-is-an-open-source-edition", AUDIT,
    `  return AN_OPEN_SOURCE_TIER.test(listing.tier ?? "");`,
    `  return true;`],

  ["the-probe-never-reads-the-repository", AUDIT,
    `    ? await readPageFor(offer, REPOSITORIES_OF_OPEN_SOURCE_EDITIONS.get(offer.vendor), fetchFn, checked)\n    : null;`,
    `    ? null\n    : null;`],

  ["the-repository-repoint-cites-the-hosted-page", AUDIT,
    `      to: probe.repository.url,`,
    `      to: probe.repoint_to,`],

  ["the-repository-repoint-stores-the-hosted-page-check", AUDIT,
    `      check: probe.repository.check,`,
    `      check: probe.winner_check,`],

  ["a-repository-we-could-not-read-is-cited", AUDIT,
    `  return Boolean(reading?.ok) && OUTCOMES_THAT_NAME_THE_LISTING.has(reading.outcome);`,
    `  return Boolean(reading);`],

  ["a-repository-that-never-names-the-listing-is-cited", AUDIT,
    `  return Boolean(reading?.ok) && OUTCOMES_THAT_NAME_THE_LISTING.has(reading.outcome);`,
    `  return Boolean(reading?.ok);`],

  ["an-ended-open-source-edition-is-repointed-to-its-repository", AUDIT,
    `      reasonToHold(probe) === AN_OPEN_SOURCE_EDITION &&`,
    `      anOpenSourceEdition(probe) &&`],

  ["the-repository-repoint-takes-listings-the-ruling-does-not-cover", AUDIT,
    `      theRulingCovers(probe) &&\n      reasonToHold(probe) === AN_OPEN_SOURCE_EDITION &&`,
    `      reasonToHold(probe) === AN_OPEN_SOURCE_EDITION &&`],

  ["applying-a-repository-repoint-lifts-every-hold", AUDIT,
    `    if (reason !== null && reason !== holdItLifts) {`,
    `    if (reason !== null && holdItLifts === null) {`],

  ["a-hop-lifts-the-open-source-hold-on-applying", AUDIT,
    `      check: probe.winner_check,\n      holdItLifts: null,`,
    `      check: probe.winner_check,\n      holdItLifts: AN_OPEN_SOURCE_EDITION,`],

  ["the-summary-counts-no-repository-repoint", AUDIT,
    `    repointed_to_their_repository: repointsToTheirRepository(probes).length,`,
    `    repointed_to_their_repository: 0,`],

  ["the-held-list-names-the-repository-repoint", AUDIT,
    `        theRulingCovers(probe) && reasonToHold(probe) !== null && !citingTheirRepository.has(probe)`,
    `        theRulingCovers(probe) && reasonToHold(probe) !== null`],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

function suitesPass() {
  for (const file of SUITES) {
    if (!run("node", ["--test", "--test-concurrency", "1", file])) return false;
  }
  return true;
}

function occurrences(haystack, needle) {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

if (!suitesPass()) {
  console.error("the scoped suite is red before any mutant was applied — every mutant would score a false kill");
  process.exit(2);
}

const survivors = [];
const notApplied = [];
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  const found = occurrences(original, from);
  if (found !== 1) {
    console.log(`NOT APPLIED  ${name} — its target appears ${found} times in ${file}, not once`);
    notApplied.push(name);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const green = suitesPass();
  writeFileSync(file, original);
  console.log(`${green ? "SURVIVED" : "killed  "}  ${name}`);
  if (green) survivors.push(name);
}

const scored = MUTANTS.length - notApplied.length;
console.log(`\n${scored - survivors.length}/${scored} killed, of ${MUTANTS.length} written`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (notApplied.length > 0) console.log("not applied:", notApplied.join(", "));

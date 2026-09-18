import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITES = [
  ["test/criteria-gate-census.test.ts", []],
  ["test/ranking.test.ts", []],
];

const THE_RULE = "`We have not been able to confirm the offer for more than ${VERIFICATION_LAPSED_DAYS} days. This is a floor, not a filter.`";
const THE_CENSUS = `census: (offers, date) => gateCensusSentence("verification_lapsed", offers.map(offer => gateFor(offer, date)), date),`;
const THE_ROW = "escHtmlServer(gateTableRowText(g, offers, date))";
const THE_COUNT = `  const tripping = gates.filter((g): g is Gate => g !== null && g.code === code).map((g) => g.code);`;

const MUTANTS = [
  ["the-floor-clause-goes-back-to-a-literal", "src/ranking.ts",
    `${THE_RULE},\n    ${THE_CENSUS}`,
    "`We have not been able to confirm the offer for more than ${VERIFICATION_LAPSED_DAYS} days. This is a floor, not a filter: no offer currently trips it.`,"],

  ["the-criteria-page-prints-the-rule-and-drops-the-census", "src/serve.ts",
    THE_ROW,
    "escHtmlServer(g.rule)"],

  ["the-census-counts-every-gated-offer-instead-of-this-one-gate", "src/gate-disclosure.ts",
    THE_COUNT,
    `  const tripping = gates.filter((g): g is Gate => g !== null).map(() => code);`],

  ["the-census-counts-the-catalogue-instead-of-the-offers-that-trip-it", "src/gate-disclosure.ts",
    THE_COUNT,
    `  const tripping = gates.map(() => code);`],

  ["the-census-re-derives-the-rule-instead-of-reading-the-gate-we-publish", "src/ranking.ts",
    THE_CENSUS,
    `census: (offers, date) => gateCensusSentence("verification_lapsed", offers.map(offer => offer.verifiedDate && daysBetween(offer.verifiedDate, date) > VERIFICATION_LAPSED_DAYS ? { code: "verification_lapsed" as GateCode, reason: "" } : null), date),`],

  ["the-census-is-taken-on-a-day-the-page-is-not-served-on", "src/ranking.ts",
    THE_CENSUS,
    `census: (offers) => gateCensusSentence("verification_lapsed", offers.map(offer => gateFor(offer, "2026-09-18")), "2026-09-18"),`],

  ["the-census-names-no-day-it-was-taken-on", "src/gate-disclosure.ts",
    "  const scope = `On ${date}, across the ${gates.length.toLocaleString(\"en-US\")} offers we hold`;",
    "  const scope = `Across the ${gates.length.toLocaleString(\"en-US\")} offers we hold`;"],

  ["the-clause-stops-agreeing-in-number-with-its-own-count", "src/gate-disclosure.ts",
    "    clauses.push(n === 1 ? clause.one : clause.many(n));",
    "    clauses.push(clause.many(n));"],

  ["the-floor-stops-saying-how-long-a-confirmation-may-go-unrenewed", "src/ranking.ts",
    THE_RULE,
    "`We have not been able to confirm the offer recently enough. This is a floor, not a filter.`"],

  ["a-published-rule-asserts-the-catalogue-again-on-a-different-row", "src/ranking.ts",
    "trigger: `The offer's own stated expiry date falls within ${EXPIRING_SOON_DAYS} days.`,",
    "trigger: `The offer's own stated expiry date falls within ${EXPIRING_SOON_DAYS} days. No offer currently trips it.`,"],

  ["the-census-words-the-same-offers-differently-from-a-category-page", "src/gate-disclosure.ts",
    "  return `${scope}, ${gateClauseList(tripping)}.`;",
    "  return `${scope}, ${tripping.length} are stale.`;"],
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
  for (const [file, extra] of SUITES) {
    if (!run("node", ["--test", "--test-concurrency", "1", ...extra, file])) return false;
  }
  return true;
}

if (!run("npm", ["run", "build"])) {
  console.error("the tree does not build before any mutant was applied — fix that first");
  process.exit(2);
}
if (!suitesPass()) {
  console.error("the scoped suites are red before any mutant was applied — every mutant would score a false kill");
  process.exit(2);
}

const survivors = [];
const uncompiled = [];
const skipped = [];
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  if (!original.includes(from)) {
    console.log(`SKIP  ${name} — the line it mutates is not in ${file}`);
    skipped.push(name);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const built = run("npm", ["run", "build"]);
  const green = built && suitesPass();
  writeFileSync(file, original);
  if (!built) uncompiled.push(name);
  console.log(`${green ? "SURVIVED" : built ? "killed  " : "DID NOT COMPILE"}  ${name}`);
  if (green) survivors.push(name);
}
run("npm", ["run", "build"]);
const killed = MUTANTS.length - survivors.length - uncompiled.length - skipped.length;
console.log(`\n${killed}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (uncompiled.length > 0) console.log("did not compile:", uncompiled.join(", "));
if (skipped.length > 0) console.log("skipped — target string moved, so these scored nothing:", skipped.join(", "));

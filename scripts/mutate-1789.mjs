import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITES = [
  ["test/a-withheld-rating-does-not-lapse.test.ts", []],
  ["test/uncited-change-records.test.ts", []],
];

const THE_WITHHOLDING = "    const withheld = demotionWithheldForNoSource(c);";
const THE_COUNT = "        records: vendorChanges.filter(c => demotionWithheldForNoSource(c) !== null).length,";
const THE_LAPSE_DATE = "  const lapses = Date.parse(`${date}T00:00:00Z`) + (VERDICT_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000;";
const THE_SENTENCE = "    ? `${A_VERDICT_LAPSES_RULE} This one rests on a record ${changeEntryDateLabel(cause)}, so it lapses on ${demotionLapsesOn(cause.date)} unless we record something new first.`";
const THE_SHARED_NOTICE = "export const A_VERDICT_ROLLS_NOTICE = `${A_VERDICT_LAPSES_RULE} ${A_BADGE_STATES_THE_RECORD_IT_RESTS_ON}`;";
const THE_DEMOTION_CLOCK = "  return verdictHasLapsed(change, nowMs) ? null : demotionForChange(change);";
const THE_PREDICATE = "  const stated = input.gate || word === null ? input.historyLevel : word;\n  return stated !== \"stable\" && input.cause ? input.cause : null;";
const THE_LAPSE_LINE = "${riskCauseLine}${verdictLapseLine}${ratingWithheldLine}";
const THE_WITHHELD_LINE = "listed below, marked. ${escHtmlServer(A_WITHHELD_RATING_DOES_NOT_LAPSE)} <a href=\"#changes\"";

const MUTANTS = [
  ["the-withholding-goes-back-to-expiring-on-the-verdict-clock", "src/data.ts",
    THE_WITHHOLDING,
    "    const withheld = verdictHasLapsed(c, nowMs) ? null : demotionWithheldForNoSource(c);"],

  ["the-count-of-withheld-records-goes-back-to-the-verdict-clock", "src/data.ts",
    THE_COUNT,
    "        records: vendorChanges.filter(c => !verdictHasLapsed(c, nowMs) && demotionWithheldForNoSource(c) !== null).length,"],

  ["the-withholding-expires-on-a-clock-of-its-own", "src/data.ts",
    THE_WITHHOLDING,
    "    const withheld = c.date < new Date(nowMs - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) ? null : demotionWithheldForNoSource(c);"],

  ["the-stated-lapse-day-is-a-day-early", "src/data.ts",
    THE_LAPSE_DATE,
    "  const lapses = Date.parse(`${date}T00:00:00Z`) + VERDICT_WINDOW_DAYS * 24 * 60 * 60 * 1000;"],

  ["the-stated-lapse-day-is-a-day-late", "src/data.ts",
    THE_LAPSE_DATE,
    "  const lapses = Date.parse(`${date}T00:00:00Z`) + (VERDICT_WINDOW_DAYS + 2) * 24 * 60 * 60 * 1000;"],

  ["the-page-states-the-rule-and-names-no-day", "src/data.ts",
    THE_SENTENCE,
    "    ? A_VERDICT_LAPSES_RULE"],

  ["the-page-dates-the-record-without-saying-which-end-the-date-came-from", "src/data.ts",
    THE_SENTENCE,
    "    ? `${A_VERDICT_LAPSES_RULE} This one rests on a record dated ${cause.date}, so it lapses on ${demotionLapsesOn(cause.date)} unless we record something new first.`"],

  ["the-page-writes-the-rule-again-instead-of-reading-the-published-one", "src/data.ts",
    THE_SENTENCE,
    "    ? `A demotion here lapses once its record is old enough. This one rests on a record ${changeEntryDateLabel(cause)}, so it lapses on ${demotionLapsesOn(cause.date)} unless we record something new first.`"],

  ["the-comparison-pages-get-their-own-copy-of-the-rule", "src/data.ts",
    THE_SHARED_NOTICE,
    "export const A_VERDICT_ROLLS_NOTICE = `A verdict here is not a fixed property of the vendor. A demotion lapses on its own once its record is old enough. ${A_BADGE_STATES_THE_RECORD_IT_RESTS_ON}`;"],

  ["a-cited-demotion-stops-lapsing-too", "src/data.ts",
    THE_DEMOTION_CLOCK,
    "  return demotionForChange(change);"],

  ["no-vendor-page-names-the-demotion-it-publishes", "src/vendor-verdict.ts",
    THE_PREDICATE,
    "  return null;"],

  ["every-vendor-page-dates-a-demotion-whether-it-publishes-one-or-not", "src/vendor-verdict.ts",
    THE_PREDICATE,
    "  return input.cause;"],

  ["the-vendor-page-drops-the-line-that-dates-the-demotion", "src/serve.ts",
    THE_LAPSE_LINE,
    "${riskCauseLine}${ratingWithheldLine}"],

  ["the-vendor-page-withholds-a-rating-without-saying-it-does-not-expire", "src/serve.ts",
    THE_WITHHELD_LINE,
    "listed below, marked. <a href=\"#changes\""],
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

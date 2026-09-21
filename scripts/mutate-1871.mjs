import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITES = [
  "test/check-figure-bears-on-the-offer.test.ts",
  "test/product-named-on-its-page.test.ts",
];

const MUTANTS = [
  ["any-quantity-of-any-size-counts-as-ours", "scripts/change-gate.js",
    "  if (value === null || value !== measuredValue(published)) return false;",
    "  if (value === null) return false;"],

  ["any-quantity-of-the-same-size-counts-as-ours", "scripts/change-gate.js",
    `  const measures = new Set((published?.words ?? []).filter(isAMeasureWord));
  return (stated?.words ?? []).some((word) => isAMeasureWord(word) && measures.has(word));`,
    "  return true;"],

  ["a-byte-allowance-stops-matching-the-same-byte-allowance", "scripts/change-gate.js",
    "  if (stated?.unit && stated.unit === published?.unit) return true;\n",
    ""],

  ["the-same-figure-is-reported-once-per-time-the-page-states-it", "scripts/change-gate.js",
    '    if (key === "" || seen.has(key)) continue;',
    '    if (key === "") continue;'],

  ["a-stated-price-of-zero-stops-being-reported", "scripts/vendor-naming.js",
    `  const free = (signals ?? []).find(statesAnAmountOfZero);
  return free ? [String(free).trim()] : [];`,
    "  return [];"],

  ["a-stated-price-of-zero-displaces-the-allowance-we-publish", "scripts/vendor-naming.js",
    "  const ours = figuresWeAlsoPublish(signals, terms);\n  if (ours.length > 0) return ours.slice(0, MOST_FIGURES_REPORTED);",
    `  const ours = figuresWeAlsoPublish(signals, terms);
  const zero = (signals ?? []).find(statesAnAmountOfZero);
  if (zero) return [String(zero).trim()];
  if (ours.length > 0) return ours.slice(0, MOST_FIGURES_REPORTED);`],

  ["the-sentence-grows-to-every-figure-that-matched", "scripts/vendor-naming.js",
    "  if (ours.length > 0) return ours.slice(0, MOST_FIGURES_REPORTED);",
    "  if (ours.length > 0) return ours;"],

  ["the-page-that-stated-nothing-of-ours-says-something-else", "scripts/vendor-naming.js",
    "  if (figures.length === 0) return STATES_NO_FIGURE_WE_PUBLISH;",
    '  if (figures.length === 0) return "states no amount we can read";',],

  ["the-reported-figures-run-together-in-a-list", "scripts/vendor-naming.js",
    '.join(" and ")',
    '.join(", ")'],

  ["only-the-first-figure-that-bears-is-reported", "scripts/vendor-naming.js",
    '  return `states ${figures.map((figure) => `"${figure}"`).join(" and ")}`;',
    '  return `states "${figures[0]}"`;'],

  ["the-check-goes-back-to-the-first-signal-on-the-page", "scripts/vendor-naming.js",
    "  const reported = figuresWorthReporting(found, offer.description);",
    "  const reported = found.slice(0, 1);"],

  ["every-currency-amount-reads-as-a-price-of-zero", "scripts/vendor-naming.js",
    "const AN_AMOUNT_OF_ZERO = /^(?:[$€£¥₹]\\s?0(?:[.,]0+)?|0(?:\\.0+)?\\s?(?:USD|EUR|GBP))$/i;",
    "const AN_AMOUNT_OF_ZERO = /^[$€£¥₹]\\s?\\d/;"],

  ["a-figure-we-do-not-publish-is-never-withdrawn", "scripts/withdraw-figures-we-do-not-publish.js",
    '  if (keep.length === 0) return reported.named.replace(/,$/, "");',
    "  if (keep.length === 0) return detail;"],

  ["the-withdrawal-leaves-the-clause-ending-in-a-comma", "scripts/withdraw-figures-we-do-not-publish.js",
    'reported.named.replace(/,$/, "")',
    "reported.named"],

  ["only-the-first-stored-figure-is-read-back", "scripts/withdraw-figures-we-do-not-publish.js",
    '/^(?<named>.*?) and states (?<figures>"[^"]*"(?: and "[^"]*")*)$/',
    '/^(?<named>.*?) and states (?<figures>"[^"]*")/'],
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
  const built = run("npm", ["run", "build"]);
  const green = built && suitesPass();
  writeFileSync(file, original);
  if (!built) uncompiled.push(name);
  console.log(`${green ? "SURVIVED" : built ? "killed  " : "NOT APPLIED — did not compile"}  ${name}`);
  if (green) survivors.push(name);
}
run("npm", ["run", "build"]);
const scored = MUTANTS.length - notApplied.length - uncompiled.length;
console.log(`\n${scored - survivors.length}/${scored} killed, of ${MUTANTS.length} written`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (uncompiled.length > 0) console.log("did not compile:", uncompiled.join(", "));
if (notApplied.length > 0) console.log("not applied:", notApplied.join(", "));

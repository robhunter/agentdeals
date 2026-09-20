import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITES = [
  "test/figure-read-reference-date.test.ts",
  "test/stale-page-facts.test.ts",
];

const MUTANTS = [
  ["a-figure-read-dates-the-verdict-too", "src/page-reviews.ts",
    `  if (figure.surface !== "table") return clock;\n`,
    ""],

  ["a-figure-read-dates-every-cell-on-its-page", "src/page-reviews.ts",
    "    .filter(read => read.vendors.includes(figure.slug))\n",
    ""],

  ["a-read-older-than-the-page-clock-dates-the-cell", "src/page-reviews.ts",
    "    .filter(readOn => readOn > page.clock_starts)\n",
    ""],

  ["the-oldest-covering-read-dates-the-cell", "src/page-reviews.ts",
    "  const newest = covering[covering.length - 1];",
    "  const newest = covering[0];"],

  ["a-declared-read-reaches-every-page", "src/page-reviews.ts",
    "  return reads.filter(read => read.path === pagePath);",
    "  return reads.slice();"],

  ["the-flag-is-decided-by-the-page-clock-again", "src/page-reviews.ts",
    "    if (changed > against.date) {",
    "    if (changed > status.clock_starts) {"],

  ["every-flag-reports-the-page-clock-as-its-source", "src/page-reviews.ts",
    "compared_against: against.date, compared_against_source: against.source",
    `compared_against: against.date, compared_against_source: "page_clock"`],

  ["the-flag-names-a-date-it-was-not-measured-against", "src/page-reviews.ts",
    "compared_against: against.date, compared_against_source: against.source",
    "compared_against: status.clock_starts, compared_against_source: against.source"],

  ["the-plan-table-read-leaves-the-registry", "src/page-reviews.ts",
    `  {
    path: "/hetzner-pricing-2026",
    read_on: HETZNER_PLAN_TABLE_READ_ON,
    vendors: ["hetzner"],
    cited_from: "hetzner.com",
    covers: "the plan table in section 1",
  },
`,
    ""],

  ["the-read-that-clears-nothing-leaves-the-registry", "src/page-reviews.ts",
    `  {
    path: "/storage-comparison-2026",
    read_on: STORAGE_RATE_CARD_READ_ON,
    vendors: ["cloudflare-r2", "aws", "backblaze-b2", "google-cloud-storage"],
    cited_from: "each provider's own pricing page",
    covers: "the pay-as-you-go rate card",
  },
`,
    ""],

  ["the-plan-table-read-is-dated-from-the-page-instead", "src/page-reviews.ts",
    `export const HETZNER_PLAN_TABLE_READ_ON = "2026-09-04";`,
    `export const HETZNER_PLAN_TABLE_READ_ON = "2026-03-25";`],

  ["the-source-check-shape-stops-being-classified", "src/page-reviews.ts",
    `    rendered_by: "readClauseHtml, in a span classed cited-source-read",`,
    `    rendered_by: "readClauseHtml",`],

  ["one-disclosure-leaves-the-list", "src/page-reviews.ts",
    `  {
    name: "row_level_provenance",
    signature: "a cell stating where its own figure came from",
    states: "This row states its own provenance in the table rather than in the byline.",
  },
`,
    ""],
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

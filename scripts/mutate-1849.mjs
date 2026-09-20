import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITES = [
  "test/a-withheld-rating-does-not-lapse.test.ts",
  "test/compiled-comparison-figures.test.ts",
  "test/uncited-change-records.test.ts",
];

const NARROWING = `export function withholdingThatDoesNotLapse(input: VendorVerdictInput): RatingWithheld | null {
  if (input.offerEnded || input.gate) return null;
  return input.ratingWithheld ?? null;
}`;

const MUTANTS = [
  ["the-line-is-deleted-from-the-page", "src/serve.ts",
    "${riskCauseLine}${verdictLapseLine}${ratingWithheldLine}",
    "${riskCauseLine}${verdictLapseLine}"],

  ["the-line-stops-saying-the-withholding-does-not-lapse", "src/serve.ts",
    "${escHtmlServer(A_WITHHELD_RATING_DOES_NOT_LAPSE)} ",
    ""],

  ["the-narrowing-suppresses-every-page", "src/vendor-verdict.ts",
    NARROWING,
    `export function withholdingThatDoesNotLapse(input: VendorVerdictInput): RatingWithheld | null {
  if (input.offerEnded || input.gate) return null;
  return null;
}`],

  ["the-narrowing-stops-excluding-an-ended-offer", "src/vendor-verdict.ts",
    "  if (input.offerEnded || input.gate) return null;",
    "  if (input.gate) return null;"],

  ["the-narrowing-stops-excluding-a-gated-offer", "src/vendor-verdict.ts",
    "  if (input.offerEnded || input.gate) return null;",
    "  if (input.offerEnded) return null;"],

  ["a-withheld-rating-draws-a-rating-badge", "src/vendor-verdict.ts",
    "  if (withheld) return { kind: \"none\", because: withheld };",
    "  if (withheld) return { kind: \"rating\", word: \"stable\" };"],

  ["the-svg-badge-stops-saying-unrated", "src/serve.ts",
    "    return { status: \"withheld\", label: withheldBadgeLabel(claim.because), verifiedDate: null };",
    "    return { status: \"active\", label: \"active\", verifiedDate: null };"],

  ["a-figure-stops-naming-a-vendor-the-catalogue-has-no-page-for", "src/compiled-figures.ts",
    `  const named = changeLogVendorNamed(subject.label);
  return named ? { slug: null, vendor: named } : null;`,
    "  return null;"],

  ["the-change-log-names-nobody", "src/vendor-slug.ts",
    `    map.set(slug, change.vendor);
  }
  return map;`,
    `    map.set(slug, change.vendor);
  }
  return new Map();`],
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

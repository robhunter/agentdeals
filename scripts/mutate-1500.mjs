import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/product-named-on-its-page.test.ts",
  "test/vendor-naming.test.ts",
  "test/source-check.test.ts",
  "test/price-evidence-grade.test.ts",
];

const NAMING = "scripts/vendor-naming.js";
const CHECK = "src/source-check.ts";

const MUTANTS = [
  ["no-name-ever-restates-its-host", NAMING,
    `  const words = nameWords(vendor);
  if (words.length < 2) return NOTHING_RESTATED;`,
    `  const words = nameWords(vendor);
  if (words.length >= 0) return NOTHING_RESTATED;`],
  ["a-label-of-any-length-restates-a-token", NAMING,
    `  if (label.length < MIN_FORM_LENGTH) return false;
  if (label === token) return true;`,
    `  if (label === token) return true;`],
  ["a-remainder-of-qualifiers-is-still-a-product", NAMING,
    `  if (!remainder.some(distinguishesTheProduct)) return NOTHING_RESTATED;`,
    `  if (remainder.length === 0) return NOTHING_RESTATED;`],
  ["the-tld-is-never-the-brand-in-the-host", NAMING,
    `  for (const label of hostLabels(url)) {`,
    `  for (const label of hostLabels(url).slice(0, -1)) {`],
  ["a-restated-token-is-evidence-again", NAMING,
    `  const forms = vendorNameForms(vendor, [...aliases, productHalf(vendor, restated)])
    .filter((form) => !restating.has(form));`,
    `  const forms = vendorNameForms(vendor, [...aliases, productHalf(vendor, restated)]);`],
  ["the-host-fallback-forgets-which-labels-the-name-restates", NAMING,
    `    if (restated.labels.includes(label)) continue;`,
    `    if (restated.labels.includes(label) && false) continue;`],
  ["the-product-half-is-never-a-form-of-its-own", NAMING,
    `  const forms = vendorNameForms(vendor, [...aliases, productHalf(vendor, restated)])`,
    `  const forms = vendorNameForms(vendor, [...aliases])`],
  ["the-product-half-is-the-whole-name", NAMING,
    `  const kept = nameWords(vendor).filter((word) => !nameTokens(word).some((token) => restating.has(token)));`,
    `  const kept = nameWords(vendor);`],
  ["a-parenthetical-aside-is-part-of-the-name", NAMING,
    `    .replace(/\\([^)]*\\)/g, " ")`,
    `    .replace(/\\([^)]*\\)/g, "$&")`],
  ["an-unnamed-product-reads-as-an-unnamed-vendor", NAMING,
    `    if (pageNamesOnlyTheHost(page.text, offer.vendor, offer.url)) {`,
    `    if (false && pageNamesOnlyTheHost(page.text, offer.vendor, offer.url)) {`],
  ["every-unnamed-page-reads-as-an-unnamed-product", NAMING,
    `    if (pageNamesOnlyTheHost(page.text, offer.vendor, offer.url)) {`,
    `    if (true) {`],
  ["the-platform-test-answers-for-every-record", NAMING,
    `  if (restated.tokens.length === 0) return false;`,
    `  if (restated.tokens.length === 0) return true;`],
  ["the-new-outcome-leaves-the-shared-vocabulary", NAMING,
    `  SOURCE_CHECK_NOT_THE_PRODUCT,
  SOURCE_CHECK_NO_TERMS,
  SOURCE_CHECK_UNREADABLE,
];`,
    `  SOURCE_CHECK_NO_TERMS,
  SOURCE_CHECK_UNREADABLE,
];`],
  ["an-unnamed-product-stops-holding-the-verified-date", NAMING,
    `const OUTCOMES_THAT_HOLD_THE_VERIFIED_DATE = new Set([
  SOURCE_CHECK_NOT_NAMED,
  SOURCE_CHECK_NOT_THE_PRODUCT,`,
    `const OUTCOMES_THAT_HOLD_THE_VERIFIED_DATE = new Set([
  SOURCE_CHECK_NOT_NAMED,`],
  ["an-unnamed-product-keeps-its-rating", CHECK,
    `export const LEVEL_WITHHOLDING_OUTCOMES: SourceCheckOutcome[] = [
  "does_not_name_vendor",
  "does_not_name_product",`,
    `export const LEVEL_WITHHOLDING_OUTCOMES: SourceCheckOutcome[] = [
  "does_not_name_vendor",`],
  ["the-reader-is-told-the-page-named-nobody", CHECK,
    `  does_not_name_product: (subject) => \`The page we cite for \${subject} names the platform it runs on and not \${subject} itself.\`,`,
    `  does_not_name_product: (subject) => \`The page we cite for \${subject} does not name it.\`,`],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

const survivors = [];
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  if (!original.includes(from)) {
    console.log(`SKIP  ${name} — the line it mutates is not in ${file}`);
    survivors.push(`${name} (not applied)`);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const built = run("npm", ["run", "build"]);
  const green = built && run("node", ["--test", "--test-concurrency", "1", ...SUITE]);
  writeFileSync(file, original);
  console.log(`${green ? "SURVIVED" : built ? "killed  " : "killed (did not compile)"}  ${name}`);
  if (green) survivors.push(name);
}
run("npm", ["run", "build"]);
console.log(`\n${MUTANTS.length - survivors.length}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/superseded-terms.test.ts",
  "test/vendor-verdict.test.ts",
  "test/change-direction-review.test.ts",
  "test/llm-api-readme.test.ts",
];

const OLD_DIRECTION_GATE =
  `  if (["limits_increased", "new_free_tier", "new_tier", "startup_program_expanded", ` +
  `"pricing_postponed", "rebranded", "record_corrected"].includes(change.change_type)) return false;\n`;

const MUTANTS = [
  ["the-direction-gates-the-disclosure-again", "src/superseded-description.ts",
    "  if (isNoLongerInForce(change)) return false;\n  if (!changeRatesTheListedTier(change, offer)) return false;",
    `  if (isNoLongerInForce(change)) return false;\n${OLD_DIRECTION_GATE}  if (!changeRatesTheListedTier(change, offer)) return false;`],

  ["a-record-we-have-resolved-still-withholds-the-terms", "src/superseded-description.ts",
    "  if (isNoLongerInForce(change)) return false;\n  if (!changeRatesTheListedTier(change, offer)) return false;",
    "  if (!changeRatesTheListedTier(change, offer)) return false;"],

  ["a-record-about-another-tier-withholds-the-one-we-list", "src/superseded-description.ts",
    "  if (isNoLongerInForce(change)) return false;\n  if (!changeRatesTheListedTier(change, offer)) return false;",
    "  if (isNoLongerInForce(change)) return false;"],

  ["any-record-of-the-vendor-withholds-the-terms", "src/superseded-description.ts",
    "  return quotesTheStoredTermsAsPrevious(change, offer.description);\n}",
    "  return true;\n}"],

  ["the-oldest-quoting-record-decides-what-the-page-quotes", "src/superseded-description.ts",
    "    if (!newest || change.date > newest.date) newest = change;",
    "    if (!newest || change.date < newest.date) newest = change;"],

  ["the-verdict-stops-reading-the-supersession", "src/vendor-verdict.ts",
    "    if (termsSuperseded) return supersededTermsHoldTheDirection(total);\n",
    ""],

  ["the-supersession-silences-a-recorded-narrowing", "src/vendor-verdict.ts",
    "  const narrowing = narrowingChanges(byTheVendor, offer);\n  if (narrowing.length === 0) {\n    if (termsSuperseded) return supersededTermsHoldTheDirection(total);",
    "  const narrowing = narrowingChanges(byTheVendor, offer);\n  if (termsSuperseded) return supersededTermsHoldTheDirection(total);\n  if (narrowing.length === 0) {",
  ],

  ["the-sentence-loses-the-form-it-uses-for-one-record", "src/vendor-verdict.ts",
    "  return recorded === 1\n    ? `The one change we have recorded ${STORED_TERMS_NAMED_AS_PREVIOUS}.`",
    "  return recorded === 0\n    ? `The one change we have recorded ${STORED_TERMS_NAMED_AS_PREVIOUS}.`"],

  ["the-vendor-page-is-built-as-if-nothing-were-superseded", "src/vendor-verdict-input.ts",
    "      termsSuperseded: storedTermsAreSuperseded(primary, vendorChanges),",
    "      termsSuperseded: false,"],

  ["the-published-index-is-built-as-if-nothing-were-superseded", "src/llm-api-readme.ts",
    "    termsSuperseded: superseding !== null,",
    "    termsSuperseded: false,"],

  ["the-criteria-page-states-no-rule-for-the-notice", "src/serve.ts",
    `  <p><strong style="color:var(--text)">\${escHtmlServer(SUPERSEDED_TERMS_RULE)}</strong>`,
    `  <p><strong style="color:var(--text)">\${escHtmlServer("")}</strong>`],

  ["the-api-answers-nothing-where-the-page-withholds-the-terms", "src/serve.ts",
    "  return superseded ? { terms_superseded: supersededTermsRecord(offer.vendor, superseded) } : {};",
    "  return {};"],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

const only = process.argv[2] ?? "";
const survivors = [];
const uncompiled = [];
const skipped = [];
for (const [name, file, from, to] of MUTANTS) {
  if (only && !name.includes(only)) continue;
  const original = readFileSync(file, "utf-8");
  if (!original.includes(from)) {
    console.log(`SKIP  ${name} — the line it mutates is not in ${file}`);
    skipped.push(name);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const built = run("npm", ["run", "build"]);
  const green = built && run("node", ["--test", "--test-concurrency", "1", ...SUITE]);
  writeFileSync(file, original);
  if (!built) uncompiled.push(name);
  console.log(`${green ? "SURVIVED" : built ? "killed  " : "DID NOT COMPILE"}  ${name}`);
  if (green) survivors.push(name);
}
run("npm", ["run", "build"]);
const ran = MUTANTS.filter(([name]) => !only || name.includes(only)).length;
const killed = ran - survivors.length - uncompiled.length - skipped.length;
console.log(`\n${killed}/${ran} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (uncompiled.length > 0) console.log("did not compile:", uncompiled.join(", "));
if (skipped.length > 0) console.log("skipped — target string moved, so these scored nothing:", skipped.join(", "));

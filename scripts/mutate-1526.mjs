import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const TIER = "src/change-tier.ts";
const READING = "src/superseding-reading.ts";
const RECORD = "src/free-tier-record.ts";
const SUPERSEDED = "src/superseded-description.ts";
const DATA = "src/data.ts";
const VERDICT = "src/vendor-verdict.ts";
const LOG = "scripts/change-log.js";

const SUITE = [
  "test/tier-scoped-verdicts.test.ts",
  "test/change-log-writer.test.ts",
  "test/superseded-terms.test.ts",
  "test/vendor-verdict.test.ts",
  "test/risk-badge.test.ts",
];

const MUTANTS = [
  ["a-record-naming-another-tier-still-grades-this-one", TIER,
    `  const named = comparableTerms(change.tier);\n  return named !== "" && named !== comparableTerms(tier);`,
    `  return false;`],

  ["a-record-naming-no-tier-grades-nothing", TIER,
    `  const named = comparableTerms(change.tier);\n  return named !== "" && named !== comparableTerms(tier);`,
    `  return comparableTerms(change.tier) !== comparableTerms(tier);`],

  ["the-named-tier-is-read-through-neither-case-nor-whitespace", TIER,
    `export function comparableTerms(text: string | null | undefined): string {\n  return (text ?? "").replace(/\\s+/g, " ").trim().toLowerCase();\n}`,
    `export function comparableTerms(text: string | null | undefined): string {\n  return text ?? "";\n}`],

  ["a-reading-of-the-hosted-product-grades-the-self-hosted-edition", TIER,
    `  return namesTheVendorsHostedEdition(change.current_state ?? "", offer.vendor);`,
    `  return false;`],

  ["every-tier-reads-as-a-self-hosted-edition", TIER,
    `  if (!tierRecordsASelfHostedEdition(offer.tier ?? "")) return false;`,
    ``],

  ["a-verdict-on-the-edition-itself-stops-grading-it", TIER,
    `  if (VERDICTS_ABOUT_THE_EDITION_ITSELF.includes(change.change_type)) return false;`,
    ``],

  ["the-hosted-product-is-read-off-the-summary-rather-than-the-reading", TIER,
    `  return namesTheVendorsHostedEdition(change.current_state ?? "", offer.vendor);`,
    `  return namesTheVendorsHostedEdition(offer.tier ?? "", offer.vendor);`],

  ["a-bare-mention-of-the-vendor-reads-as-its-hosted-product", READING,
    "\\\\s+${A_HOSTED_EDITION}(?:[^A-Za-z0-9]|$)",
    "(?:[^A-Za-z0-9]|$)"],

  ["a-vendor-name-is-read-as-a-pattern-rather-than-a-name", READING,
    "${escapeRegExp(name)}",
    "${name}"],

  ["a-community-tier-reads-as-a-self-hosted-edition", RECORD,
    `export const A_SELF_HOSTED_EDITION = /\\boss\\b|\\bopen[\\s-]?source\\b|\\bself[\\s-]?hosted\\b/i;`,
    `export const A_SELF_HOSTED_EDITION = /\\boss\\b|\\bopen[\\s-]?source\\b|\\bself[\\s-]?hosted\\b|\\bcommunity\\b/i;`],

  ["the-withholding-stops-asking-which-tier-the-record-graded", SUPERSEDED,
    `  if (!changeGradesTheListedTier(change, offer)) return false;`,
    ``],

  ["the-rating-stops-asking-which-tier-the-record-graded", DATA,
    `  return vendorChanges.filter((change) => changeGradesTheListedTier(change, offer));`,
    `  return vendorChanges;`],

  ["the-history-sentence-keeps-counting-a-record-that-graded-another-tier", VERDICT,
    `    .filter(c => offer === null || changeGradesTheListedTier(c, offer))\n`,
    ``],

  ["the-writer-drops-the-tier-the-reading-named", LOG,
    `      ...(tierRead ? { tier: tierRead } : {}),`,
    ``],

  ["the-writer-stores-a-tier-the-reading-never-named", LOG,
    `  const tierRead = typeof result.tier === "string" ? result.tier.trim() : "";`,
    `  const tierRead = typeof result.tier === "string" ? result.tier.trim() : String(result.tier ?? "");`],
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
  const compiled = file.startsWith("src/") ? run("npm", ["run", "build"]) : true;
  const green = compiled && run("node", ["--test", "--test-concurrency", "1", ...SUITE]);
  writeFileSync(file, original);
  if (file.startsWith("src/")) run("npm", ["run", "build"]);
  console.log(`${green ? "SURVIVED" : "killed  "}  ${name}${compiled ? "" : " (by tsc)"}`);
  if (green) survivors.push(name);
}
console.log(`\n${MUTANTS.length - survivors.length}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));

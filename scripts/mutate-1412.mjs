import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/meta-description-withholding.test.ts",
];

const MUTANTS = [
  ["meta-never-reads-the-source-check", "src/serve.ts",
    `  const metaVerifiedSentence = termsUnconfirmed && !discontinuedOn
    ? \` \${unconfirmedTermsMetaSentence(termsUnconfirmed)}\`
    : verifiedSentence;`,
    `  const metaVerifiedSentence = verifiedSentence;`],
  ["meta-withholds-on-every-vendor", "src/serve.ts",
    `  const metaVerifiedSentence = termsUnconfirmed && !discontinuedOn
    ? \` \${unconfirmedTermsMetaSentence(termsUnconfirmed)}\`
    : verifiedSentence;`,
    `  const metaVerifiedSentence = \` \${unconfirmedTermsMetaSentence(termsUnconfirmed ?? "unreadable")}\`;`],
  ["meta-states-nothing-about-verification", "src/serve.ts",
    `  const metaVerifiedSentence = termsUnconfirmed && !discontinuedOn
    ? \` \${unconfirmedTermsMetaSentence(termsUnconfirmed)}\`
    : verifiedSentence;`,
    `  const metaVerifiedSentence = "";`],
  ["discontinuation-loses-its-place-to-the-withholding", "src/serve.ts",
    `  const metaVerifiedSentence = termsUnconfirmed && !discontinuedOn`,
    `  const metaVerifiedSentence = termsUnconfirmed`],
  ["the-source-check-never-reaches-the-verdict-input", "src/serve.ts",
    `      sourceCheck: primary.source_check?.outcome ?? null,`,
    `      sourceCheck: null,`],
  ["the-body-stops-sharing-the-predicate", "src/serve.ts",
    `  const amountUnstatedLine = !levelWithheld && termsUnconfirmed === "states_no_amount"`,
    `  const amountUnstatedLine = !levelWithheld && termsUnconfirmed === "unreadable"`],
  ["predicate-passes-every-outcome", "src/source-check.ts",
    `  return outcome && outcome !== "ok" ? outcome : null;`,
    `  return null;`],
  ["predicate-fails-every-outcome", "src/source-check.ts",
    `  return outcome && outcome !== "ok" ? outcome : null;`,
    `  return outcome ? (outcome as TermsUnconfirmedReason) : null;`],
  ["predicate-forgets-that-a-plan-without-an-amount-is-unconfirmed", "src/source-check.ts",
    `  return outcome && outcome !== "ok" ? outcome : null;`,
    `  return outcome && outcome !== "ok" && outcome !== "states_no_amount" ? outcome : null;`],
  ["predicate-forgets-the-unreadable-page", "src/source-check.ts",
    `  return outcome && outcome !== "ok" ? outcome : null;`,
    `  return outcome && outcome !== "ok" && outcome !== "unreadable" ? outcome : null;`],
  ["meta-clause-stops-quoting-the-body", "src/source-check.ts",
    `  does_not_name_vendor: WITHHELD_LEVEL_CLAUSES.does_not_name_vendor(""),
  states_no_terms: WITHHELD_LEVEL_CLAUSES.states_no_terms(""),
  unreadable: WITHHELD_LEVEL_CLAUSES.unreadable(""),`,
    `  does_not_name_vendor: "we cannot confirm this",
  states_no_terms: "we cannot confirm this",
  unreadable: "we cannot confirm this",`],
  ["every-outcome-reads-the-same-to-a-reader", "src/source-check.ts",
    `export function unconfirmedTermsClause(reason: TermsUnconfirmedReason): string {
  return UNCONFIRMED_TERMS_CLAUSES[reason];
}`,
    `export function unconfirmedTermsClause(reason: TermsUnconfirmedReason): string {
  return UNCONFIRMED_TERMS_CLAUSES[reason] && UNCONFIRMED_TERMS_CLAUSES.unreadable;
}`],
  ["a-plan-without-an-amount-reads-as-an-unreadable-page", "src/source-check.ts",
    `  states_no_amount: \`the page we cite for this offer names a plan but states no amount\`,`,
    `  states_no_amount: WITHHELD_LEVEL_CLAUSES.unreadable(""),`],
  ["the-withholding-sentence-says-nothing", "src/vendor-verdict.ts",
    `  return \`Not verified — \${unconfirmedTermsClause(reason)}.\`;`,
    `  return "";`],
  ["the-withholding-sentence-keeps-the-verification-word", "src/vendor-verdict.ts",
    `  return \`Not verified — \${unconfirmedTermsClause(reason)}.\`;`,
    `  return \`Verified August 2026 — \${unconfirmedTermsClause(reason)}.\`;`],
  ["the-withholding-sentence-drops-its-cause", "src/vendor-verdict.ts",
    `  return \`Not verified — \${unconfirmedTermsClause(reason)}.\`;`,
    `  return "Not verified.";`],
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

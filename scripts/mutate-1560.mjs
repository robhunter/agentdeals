import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/withholding-covers-every-assertive-surface.test.ts",
  "test/meta-description-withholding.test.ts",
  "test/gated-vendor-answers.test.ts",
  "test/growth-limits.test.ts",
];

const MUTANTS = [
  ["the-refused-read-withholds-the-rating-and-not-the-terms", "src/vendor-verdict.ts",
    "  read_not_reconciled: \"the_terms\",\n  change_measured_no_difference: \"the_terms\",",
    "  read_not_reconciled: \"the_rating\",\n  change_measured_no_difference: \"the_rating\","],

  ["only-the-unreconciled-family-withholds-the-terms", "src/vendor-verdict.ts",
    "  change_measured_no_difference: \"the_terms\",",
    "  change_measured_no_difference: \"the_rating\","],

  ["an-uncited-change-record-withholds-the-terms-as-well-as-the-rating", "src/vendor-verdict.ts",
    "  no_source: \"the_rating\",",
    "  no_source: \"the_terms\","],

  ["a-gated-offer-withholds-the-terms-as-well-as-the-listing", "src/vendor-verdict.ts",
    "  not_a_free_offer: \"the_rating\",",
    "  not_a_free_offer: \"the_terms\","],

  ["every-withholding-leaves-the-terms-unread", "src/vendor-verdict.ts",
    "  return WITHHOLDING_SCOPE[withholdingTag(because)] === \"the_terms\";",
    "  return true;"],

  ["no-withholding-leaves-the-terms-unread", "src/vendor-verdict.ts",
    "  return WITHHOLDING_SCOPE[withholdingTag(because)] === \"the_terms\";",
    "  return false;"],

  ["the-reason-a-page-withholds-ignores-the-refusal", "src/vendor-verdict.ts",
    "  if (input.levelWithheld) return { reason: input.levelWithheld };\n  const refused = refusalWithholdsStability(input);\n  return refused ? refusedReadWithholding(refused) : null;",
    "  if (input.levelWithheld) return { reason: input.levelWithheld };\n  return null;"],

  ["the-meta-description-states-the-terms-as-verified-over-a-refusal", "src/vendor-verdict.ts",
    "  if (withheldForARefusedRead(because)) return NOT_VERIFIED(refusedReadWithholdingMetaClause(because));",
    "  if (withheldForARefusedRead(because)) return null;"],

  ["the-meta-description-drops-the-words-that-withdraw-the-claim", "src/vendor-verdict.ts",
    "export const NOT_VERIFIED = (clause: string): string => `Not verified — ${clause}.`;",
    "export const NOT_VERIFIED = (clause: string): string => `${clause}.`;"],

  ["the-meta-description-reads-the-refusal-before-the-source-check", "src/vendor-verdict.ts",
    "  const bySource = termsUnconfirmedBySource(input);\n  if (bySource) return NOT_VERIFIED(unconfirmedTermsClause(bySource));\n  const unconfirmed = whyWeCannotConfirmTheseTerms(input);",
    "  const unconfirmed = whyWeCannotConfirmTheseTerms(input);\n  const bySource = unconfirmed ? null : termsUnconfirmedBySource(input);\n  if (bySource) return NOT_VERIFIED(unconfirmedTermsClause(bySource));"],

  ["both-refusal-families-publish-the-same-meta-sentence", "src/vendor-verdict.ts",
    "    ? measuredNoDifferenceMetaClause(because.refusedOn)\n    : unreconciledReadMetaClause(because.refusedOn);",
    "    ? measuredNoDifferenceMetaClause(because.refusedOn)\n    : measuredNoDifferenceMetaClause(because.refusedOn);"],

  ["the-caveat-names-the-other-family-of-refusal", "src/vendor-verdict.ts",
    "    ? measuredNoDifferenceSentence(subject, because.refusedOn)\n    : unreconciledReadSentence(subject, because.refusedOn);",
    "    ? unreconciledReadSentence(subject, because.refusedOn)\n    : measuredNoDifferenceSentence(subject, because.refusedOn);"],

  ["the-answer-caveats-without-naming-the-day-or-the-vendor", "src/serve.ts",
    "    ? `We cannot confirm that today. ${termsWeCannotConfirm.sentence} `",
    "    ? `We cannot confirm that today. `"],

  ["the-free-tier-answer-reads-the-source-check-and-not-the-refusal", "src/serve.ts",
    "    : termsWeCannotConfirm\n    ? `${eligibilityGateSentence}${unconfirmedTermsPreamble}Our stored record says",
    "    : levelWithheld\n    ? `${eligibilityGateSentence}${unconfirmedTermsPreamble}Our stored record says"],

  ["the-tier-answer-reads-the-source-check-and-not-the-refusal", "src/serve.ts",
    "    : eligibilityGateSentence + (termsWeCannotConfirm\n    ? `${unconfirmedTermsPreamble}Our stored record calls",
    "    : eligibilityGateSentence + (levelWithheld\n    ? `${unconfirmedTermsPreamble}Our stored record calls"],

  ["the-recommendation-line-reads-the-source-check-and-not-the-refusal", "src/serve.ts",
    "    : alternatives.length > 0 && !termsWeCannotConfirm && !primaryGate",
    "    : alternatives.length > 0 && !levelWithheld && !primaryGate"],

  ["the-meta-description-ignores-the-withholding-entirely", "src/serve.ts",
    "  const termsNotVerified = termsNotVerifiedMetaSentence(verdictInput);",
    "  const termsNotVerified: string | null = null;"],

  ["the-page-is-built-from-a-record-holding-no-refusals", "src/vendor-verdict-input.ts",
    "      termsConfirmedOn: primary.verifiedDate,\n      refusedReads,",
    "      termsConfirmedOn: primary.verifiedDate,\n      refusedReads: [],"],

  ["the-badge-names-a-gate-by-the-word-gated-rather-than-its-code", "src/vendor-verdict.ts",
    "  return because.reason === \"gated\" ? because.gate : because.reason;",
    "  return because.reason as WithholdingTag;"],

  ["the-refusal-is-exempted-from-the-scope-at-runtime", "src/vendor-verdict.ts",
    "  return WITHHOLDING_SCOPE[withholdingTag(because)] === \"the_terms\";\n}",
    "  return WITHHOLDING_SCOPE[withholdingTag(because)] === \"the_terms\" && !withheldForARefusedRead(because);\n}"],

  ["the-empty-history-caveat-reads-the-refusal-as-a-reading-failure", "src/vendor-verdict.ts",
    "  read_not_reconciled: \"so we cannot tell you that nothing changed\",\n  change_measured_no_difference: \"so we cannot tell you that nothing changed\",",
    "  read_not_reconciled: \"so nothing we have read describes these terms\",\n  change_measured_no_difference: \"so nothing we have read describes these terms\","],
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

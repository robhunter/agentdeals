import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/vendor-page-states-the-reason-once.test.ts",
  "test/node-states-what-the-page-states.test.ts",
  "test/check-finding-not-a-quotation.test.ts",
  "test/comparison-source-citation.test.ts",
  "test/growth-limits.test.ts",
  "test/vendor-verdict.test.ts",
];

const MUTANTS = [
  ["the-verdict-says-only-that-we-are-not-rating-the-offer", "src/vendor-verdict.ts",
    "  return `${capitalise(refusedReadWithholdingClause(because))},`\n    + ` ${CANNOT_CONFIRM_THESE_TERMS} and are not rating this offer today.`;",
    "  return `${capitalise(refusedReadWithholdingClause(because))}, so we are not rating this offer today.`;"],

  ["the-verdict-says-only-that-we-cannot-confirm-the-terms", "src/vendor-verdict.ts",
    "  return `${capitalise(refusedReadWithholdingClause(because))},`\n    + ` ${CANNOT_CONFIRM_THESE_TERMS} and are not rating this offer today.`;",
    "  return `${capitalise(refusedReadWithholdingClause(because))}, ${CANNOT_CONFIRM_THESE_TERMS} today.`;"],

  ["the-verdict-drops-the-reason-and-keeps-the-consequence", "src/vendor-verdict.ts",
    "  return `${capitalise(refusedReadWithholdingClause(because))},`\n    + ` ${CANNOT_CONFIRM_THESE_TERMS} and are not rating this offer today.`;",
    "  return `We ${CANNOT_CONFIRM_THESE_TERMS.replace(\"so we \", \"\")} and are not rating this offer today.`;"],

  ["a-rated-vendor-withholding-its-terms-says-so-in-its-own-words", "src/vendor-verdict.ts",
    "      ? ` ${capitalise(withheldLevelClause(input.levelWithheld, input.unconfirmableSince))}, ${CANNOT_CONFIRM_THESE_TERMS} today.`",
    "      ? ` ${capitalise(withheldLevelClause(input.levelWithheld, input.unconfirmableSince))}, so we cannot confirm the terms above.`"],

  ["the-refused-read-never-reaches-the-verdict", "src/vendor-verdict.ts",
    "  const refused = refusalWithholdsStability(input);\n  if (refused) {\n    return refusedReadVerdictSentence(refusedReadWithholding(refused));\n  }",
    "  const refused = null;\n  if (refused) {\n    return refusedReadVerdictSentence(refusedReadWithholding(refused));\n  }"],

  ["a-citation-stands-whatever-the-page-says-about-the-terms", "src/source-citation.ts",
    "  if (!source.cited || !termsWeCannotConfirm) return source;\n  return { cited: false, kind: \"unconfirmed\", clause: termsWeCannotConfirm.clause };",
    "  return source;"],

  ["no-page-cites-the-read-behind-the-terms-it-displays", "src/source-citation.ts",
    "  if (!source.cited || !termsWeCannotConfirm) return source;\n  return { cited: false, kind: \"unconfirmed\", clause: termsWeCannotConfirm.clause };",
    "  if (!source.cited) return source;\n  return { cited: false, kind: \"unconfirmed\", clause: \"\" };"],

  ["the-vendor-page-cites-its-read-without-asking-about-the-terms", "src/serve.ts",
    "    const source = freeTierSourceWeMayCite(primary, reasonWeCannotConfirmFor(primary));",
    "    const source = freeTierSourceWeMayCite(primary, null);"],

  ["a-tier-that-merely-names-an-ending-withholds-the-reason", "src/vendor-verdict-input.ts",
    "  return offerEnded(offer) ? null : unconfirmed;",
    "  return /\\b(retired|deprecated|discontinued|sunset|withdrawn)\\b/i.test(offer.tier) ? null : unconfirmed;"],

  ["every-record-states-the-reason-including-the-ended-ones", "src/vendor-verdict-input.ts",
    "  return offerEnded(offer) ? null : unconfirmed;",
    "  return unconfirmed;"],

  ["no-record-states-a-reason-we-cannot-confirm-its-terms", "src/vendor-verdict-input.ts",
    "  return offerEnded(offer) ? null : unconfirmed;",
    "  return null;"],

  ["a-recorded-ending-answers-without-the-reason-beside-it", "src/serve.ts",
    "    reasonARecordedEndingDoesNotAnswer\n      ? withUnconfirmedTerms(terms, reasonARecordedEndingDoesNotAnswer)\n      : terms;",
    "    terms;"],

  ["the-published-phrase-loses-the-words-that-withdraw-the-claim", "src/vendor-verdict.ts",
    "export const CANNOT_CONFIRM_THESE_TERMS = \"so we cannot confirm these terms\";",
    "export const CANNOT_CONFIRM_THESE_TERMS = \"so we publish these terms\";"],

  ["the-caveat-sentence-loses-its-clause", "src/vendor-verdict.ts",
    "    : `${capitalise(unconfirmed.clause)}, ${CANNOT_CONFIRM_THESE_TERMS} today.`;",
    "    : `${CANNOT_CONFIRM_THESE_TERMS} today.`;"],
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

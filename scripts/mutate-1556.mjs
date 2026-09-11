import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/refused-change-not-stable.test.ts",
  "test/vendor-verdict.test.ts",
  "test/badge-withholding.test.ts",
];

const MUTANTS = [
  ["a-refusal-never-clears-again", "src/change-refusal.ts",
    "  return refusal.refused_date < termsConfirmedOn;",
    "  return false;"],

  ["a-confirmation-on-the-day-of-the-refusal-clears-it", "src/change-refusal.ts",
    "  return refusal.refused_date < termsConfirmedOn;",
    "  return refusal.refused_date <= termsConfirmedOn;"],

  ["the-withholding-set-ignores-the-confirmation", "src/change-refusal.ts",
    "      r => !refusalConfirmsTheStoredTerms(r) && !refusalPredatesConfirmation(r, termsConfirmedOn),\n    ),\n  );\n}\n\nexport interface StabilityEvidence",
    "      r => !refusalConfirmsTheStoredTerms(r),\n    ),\n  );\n}\n\nexport interface StabilityEvidence"],

  ["a-confirming-refusal-withholds-the-rating", "src/change-refusal.ts",
    "      r => !refusalConfirmsTheStoredTerms(r) && !refusalPredatesConfirmation(r, termsConfirmedOn),\n    ),\n  );\n}\n\nexport interface StabilityEvidence",
    "      r => !refusalPredatesConfirmation(r, termsConfirmedOn),\n    ),\n  );\n}\n\nexport interface StabilityEvidence"],

  ["two-refusals-on-one-day-publish-the-equality-one", "src/change-refusal.ts",
    "    if (\n      refusal.refused_date === held.refused_date\n      && refusalMeasuredNoDifference(held)\n      && !refusalMeasuredNoDifference(refusal)\n    ) {\n      held = refusal;\n    }",
    "    if (false) {\n      held = refusal;\n    }"],

  ["the-oldest-live-refusal-is-the-one-we-publish", "src/change-refusal.ts",
    "    if (held === null || refusal.refused_date > held.refused_date) {\n      held = refusal;\n      continue;\n    }",
    "    if (held === null || refusal.refused_date < held.refused_date) {\n      held = refusal;\n      continue;\n    }"],

  ["a-superseded-refusal-is-read-as-a-live-one", "src/change-refusal.ts",
    "      r => !refusalConfirmsTheStoredTerms(r) && refusalPredatesConfirmation(r, termsConfirmedOn),",
    "      r => !refusalConfirmsTheStoredTerms(r) && !refusalPredatesConfirmation(r, termsConfirmedOn),"],

  ["the-record-is-read-as-never-confirmed", "src/data.ts",
    "    termsConfirmedOn: offer.verifiedDate,\n    refusals: refusalsForVendor(offer.vendor),",
    "    termsConfirmedOn: \"\",\n    refusals: refusalsForVendor(offer.vendor),"],

  ["the-vendor-page-is-read-as-never-confirmed", "src/serve.ts",
    "      termsConfirmedOn: primary.verifiedDate,\n      refusedReads: refusalsFor(vendorName),",
    "      termsConfirmedOn: \"\",\n      refusedReads: refusalsFor(vendorName),"],

  ["the-cleared-verdict-counts-the-refusal-as-nothing", "src/vendor-verdict.ts",
    "    const superseded = refusedReadOurConfirmationSupersedes(input);\n    if (superseded) {",
    "    const superseded = null as RefusedRead | null;\n    if (superseded) {"],

  ["the-cleared-verdict-dates-itself-to-the-refusal", "src/vendor-verdict.ts",
    "      return `It's stable — ${supersededRefusalClause(superseded.refused_date, input.termsConfirmedOn)}.`;",
    "      return `It's stable — ${supersededRefusalClause(input.termsConfirmedOn, superseded.refused_date)}.`;"],

  ["the-cleared-faq-answer-counts-the-refusal-as-nothing", "src/serve.ts",
    "    : supersededRefusal\n    ? supersededRefusalSentence(vendorName, supersededRefusal.refused_date, primary.verifiedDate)\n    : confirmedByRefusal",
    "    : confirmedByRefusal"],

  ["the-cleared-risk-summary-counts-the-refusal-as-nothing", "src/data.ts",
    "  } else if (supersededRefusal && vendorChanges.length === 0) {",
    "  } else if (supersededRefusal && vendorChanges.length < 0) {"],

  ["the-guard-on-the-confirmation-date-is-dropped", "src/change-refusal.ts",
    "  return refusal.refused_date < termsConfirmedOn;",
    "  return refusal.refused_date > termsConfirmedOn;"],
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
  const green = built && run("node", ["--test", "--test-concurrency", "1", ...SUITE]);
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

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/hardcoded-row-agrees-with-the-record.test.ts",
  "test/ended-terms.test.ts",
  "test/compiled-comparison-figures.test.ts",
  "test/stack-template-free-tiers.test.ts",
];

const MUTANTS = [
  [
    "src/serve.ts",
    's|free: "No free tier", starter: 39|free: "5 GB storage, 1B reads", starter: 39|',
    "the estimator row offers the allowance the Hobby plan used to carry",
  ],
  [
    "src/serve.ts",
    "s|freeCell: statesNoFreeTier\\(vendor.free\\)\\n        \\?|freeCell: false\\n        ?|",
    "the estimator prices every row at nothing at zero users",
  ],
  [
    "src/serve.ts",
    's|<span class="removed-badge">FREE REMOVED</span></td>\n      <td>MySQL|<span class="removed-badge">REMOVED</span></td>\n      <td>MySQL|',
    "a compiled figure badges a removal in a label of its own",
  ],
  [
    "src/serve.ts",
    "s|and the story of PlanetScale&rsquo;s free tier removal|and the PlanetScale cautionary tale|",
    "a guide names a vendor beside a free tier and does not say the tier ended",
  ],
  [
    "src/serve.ts",
    "s|PlanetScale's free tier, removed in April 2024, was widely|PlanetScale's free tier was widely|",
    "a sentence states a free tier a later sentence says was removed",
  ],
  [
    "src/retired-terms.ts",
    "s|\\|killed\\|kills\\|killing\\|eliminated\\|eliminates\\)|)|",
    "killing a free tier is not an ending",
  ],
  [
    "src/retired-terms.ts",
    "s|return OPENS_BY_DENYING_A_FREE_TIER.test\\(text\\);|return false;|",
    "no row is read as denying a free tier",
  ],
  [
    "test/hardcoded-vendor-rows.ts",
    's|removed\\|removal\\|retired|removed\\|retired|',
    "a removal is not an ending",
  ],
  [
    "test/hardcoded-vendor-rows.ts",
    's|\\|killed\\|shut down\\|shut off";|";|',
    "shutting a free tier down is not an ending",
  ],
  [
    "test/hardcoded-vendor-rows.ts",
    "s|return ASKS_RATHER_THAN_STATES.test\\(claim.trim\\(\\)\\);|return false;|",
    "a question is read as a claim",
  ],
  [
    "test/hardcoded-vendor-rows.ts",
    "s|return ASKS_RATHER_THAN_STATES.test\\(claim.trim\\(\\)\\);|return true;|",
    "every claim is read as a question",
  ],
  [
    "test/hardcoded-row-agrees-with-the-record.test.ts",
    "s|NAMES_A_SUBJECT_RATHER_THAN_CLAIMING.find\\(|NAMES_A_SUBJECT_RATHER_THAN_CLAIMING.slice(0, 1).find(() => true \\|\\| false \\|\\| (|",
    "the exemption list suppresses every claim it is asked about",
  ],
];

function run() {
  try {
    execFileSync("node", ["--test", "--test-concurrency", "1", ...SUITE], { encoding: "utf8", stdio: "pipe" });
    return "SURVIVED";
  } catch {
    return "killed";
  }
}

function build() {
  try {
    execFileSync("npx", ["tsc"], { encoding: "utf8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

let killed = 0;
for (const [file, expression, description] of MUTANTS) {
  const original = readFileSync(file, "utf8");
  execFileSync("perl", ["-0pi", "-e", expression, file]);
  if (readFileSync(file, "utf8") === original) {
    console.log(`  NOT APPLIED  ${description} (${file})`);
    continue;
  }
  const compiled = file.startsWith("src/") ? build() : true;
  const verdict = compiled ? run() : "killed by the compiler";
  if (verdict !== "SURVIVED") killed++;
  console.log(`  ${verdict.padEnd(22)} ${description}`);
  writeFileSync(file, original);
  if (file.startsWith("src/")) build();
}

console.log(`\n${killed} of ${MUTANTS.length} killed`);

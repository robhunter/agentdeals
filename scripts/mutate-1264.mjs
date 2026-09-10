import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/withheld-reason-names-what-we-looked-for.test.ts",
  "test/meta-description-withholding.test.ts",
  "test/badge-withholding.test.ts",
  "test/vendor-verdict.test.ts",
  "test/comparison-verdict.test.ts",
];

const CHECK = "src/source-check.ts";
const SERVE = "src/serve.ts";

const MUTANTS = [
  ["the-old-claim-comes-back", CHECK,
    `export const NO_PRICE_SIGNAL_PHRASE = "states no amount, tier or rate we can read";`,
    `export const NO_PRICE_SIGNAL_PHRASE = "states no terms we can read";`],
  ["the-hedge-is-dropped", CHECK,
    `export const NO_PRICE_SIGNAL_PHRASE = "states no amount, tier or rate we can read";`,
    `export const NO_PRICE_SIGNAL_PHRASE = "states no amount, tier or rate";`],
  ["the-sentence-stops-following-the-clause", CHECK,
    `  states_no_terms: (subject) => \`The page we cite for \${subject} \${NO_PRICE_SIGNAL_PHRASE}.\`,`,
    `  states_no_terms: (subject) => \`The page we cite for \${subject} states no terms we can read.\`,`],
  ["an-agent-is-told-something-else", CHECK,
    `  states_no_terms: WITHHELD_LEVEL_CLAUSES.states_no_terms(""),`,
    `  states_no_terms: \`the page we cite for this offer states no terms we can read\`,`],
  ["another-withheld-reason-drifts", CHECK,
    `  unreadable: (subject) => \`We could not read the page we cite for \${subject}.\`,`,
    `  unreadable: (subject) => \`The page we cite for \${subject} states no terms we can read.\`,`],
  ["a-surface-keeps-its-own-copy", SERVE,
    `    source_unusable: "the page we cite is not about this offer",`,
    `    source_unusable: "the page we cite states no terms",`],
  ["the-badge-keeps-the-old-label", SERVE,
    `  states_no_terms: "unrated \\u2014 page states no price",`,
    `  states_no_terms: "unrated \\u2014 page states no terms",`],
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
  const built = run("npx", ["tsc"]);
  const green = built && run("node", ["--test", "--test-concurrency", "1", ...SUITE]);
  writeFileSync(file, original);
  console.log(`${green ? "SURVIVED" : "killed  "}  ${name}${built ? "" : " (build)"}`);
  if (green) survivors.push(name);
}
run("npx", ["tsc"]);
console.log(`\n${MUTANTS.length - survivors.length}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));

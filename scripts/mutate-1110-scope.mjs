import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITES = ["test/a-figure-keeps-its-per-unit-scope.test.ts", "test/check-figure-bears-on-the-offer.test.ts"];
const GATE = "scripts/change-gate.js";

const MUTANTS = [
  ["no-figure-carries-a-scope", GATE,
    `    const scope = scopeOf(beside, rate);`,
    `    const scope = null;`],

  ["a-rate-forgets-the-unit-beside-its-period", GATE,
    `  if (rate?.period?.scope) return singular(rate.period.scope.toLowerCase());\n`,
    ``],

  ["a-slash-names-no-scope", GATE,
    `const A_NAMED_SCOPE = /(?:\\s+per\\s+|\\s*\\/\\s*)([a-z][a-z-]+)/i;`,
    `const A_NAMED_SCOPE = /(?:\\s+per\\s+)([a-z][a-z-]+)/i;`],

  ["a-period-reads-as-a-scope", GATE,
    `  if (ATTRIBUTE_STOPWORDS.has(word) || readPeriod(\`/\${word}\`)) return null;`,
    `  if (ATTRIBUTE_STOPWORDS.has(word)) return null;`],

  ["a-per-that-names-no-unit-reads-as-a-scope", GATE,
    `  if (ATTRIBUTE_STOPWORDS.has(word) || readPeriod(\`/\${word}\`)) return null;`,
    `  if (readPeriod(\`/\${word}\`)) return null;`],

  ["the-scope-is-read-past-the-end-of-the-clause", GATE,
    `  const stops = [beside.search(A_FIGURE), beside.search(CLAUSE_ENDS)].filter((at) => at !== -1);`,
    `  const stops = [beside.search(A_FIGURE)].filter((at) => at !== -1);`],

  ["the-scope-is-read-past-the-next-figure", GATE,
    `  const stops = [beside.search(A_FIGURE), beside.search(CLAUSE_ENDS)].filter((at) => at !== -1);`,
    `  const stops = [beside.search(CLAUSE_ENDS)].filter((at) => at !== -1);`],

  ["the-matcher-ignores-the-scope", GATE,
    `  if (stated?.scope && stated.scope !== published?.scope) return false;\n`,
    ``],

  ["the-matcher-asks-for-the-same-scope-both-ways", GATE,
    `  if (stated?.scope && stated.scope !== published?.scope) return false;`,
    `  if ((stated?.scope ?? null) !== (published?.scope ?? null)) return false;`],

  ["a-token-is-ours-if-any-figure-in-it-is", GATE,
    `    if (stated.some((quantity) => carriesAScopeOursDoNot(quantity, published))) continue;\n`,
    ``],

  ["any-scope-is-one-ours-carry", GATE,
    `  return Boolean(quantity?.scope) && !published.some((ours) => ours.scope === quantity.scope);`,
    `  return false;`],

  ["every-figure-carries-a-scope-ours-do-not", GATE,
    `  return Boolean(quantity?.scope) && !published.some((ours) => ours.scope === quantity.scope);`,
    `  return !published.some((ours) => ours.scope === quantity.scope);`],
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

if (!suitesPass()) {
  console.error("the scoped suite is red before any mutant was applied — every mutant would score a false kill");
  process.exit(2);
}

const survivors = [];
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
  const green = suitesPass();
  writeFileSync(file, original);
  console.log(`${green ? "SURVIVED" : "killed  "}  ${name}`);
  if (green) survivors.push(name);
}

const scored = MUTANTS.length - notApplied.length;
console.log(`\n${scored - survivors.length}/${scored} killed, of ${MUTANTS.length} written`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (notApplied.length > 0) console.log("not applied:", notApplied.join(", "));

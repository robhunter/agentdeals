import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITES = [
  "test/homepage-ranking-window-sentence.test.ts",
  "test/guide-ranking-key-cap.test.ts",
];

const MUTANTS = [
  ["the-window-is-always-counted-in-days", "src/homepage-routing.ts",
    "  return window.days === 1",
    "  return false"],

  ["the-single-day-loses-its-date", "src/homepage-routing.ts",
    "    ? `on ${window.to}, the one day on which every guide we publish had its own count`",
    "    ? `on the one day on which every guide we publish had its own count`"],

  ["the-window-claims-every-request-was-attributed", "src/homepage-routing.ts",
    "days on which every guide we publish had its own count, ${window.from} to ${window.to}`",
    "days we can attribute in full, ${window.from} to ${window.to}`"],

  ["the-shared-bucket-share-is-always-plural", "src/homepage-routing.ts",
    `    const span = rankedWindow.days === 1 ? "that day" : "in those days";`,
    `    const span = "in those days";`],

  ["a-guide-below-the-cut-counts-as-tied", "src/homepage-routing.ts",
    "  return ranked.slice(0, count).filter((guide) => guide.agentOpens === first.agentOpens).length;",
    "  return ranked.slice(0, count).filter((guide) => guide.agentOpens >= first.agentOpens).length;"],

  ["the-tie-is-read-against-the-last-guide-named", "src/homepage-routing.ts",
    "  const first = ranked[count];",
    "  const first = ranked[count - 1];"],

  ["nothing-ever-ties-at-the-cut", "src/homepage-routing.ts",
    "  const first = ranked[count];\n  if (!first) return 0;",
    "  const first = ranked[count];\n  if (first) return 0;"],

  ["the-completeness-claim-survives-a-tie", "src/homepage-routing.ts",
    "  if (selection.tiedAtCut > 0) {",
    "  if (false) {"],

  ["the-page-reports-no-tie-however-many-there-are", "src/serve.ts",
    "    tiedAtCut: guidesTiedAtCut(order, HOMEPAGE_GUIDE_COUNT),",
    "    tiedAtCut: 0,"],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe" });
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

if (!run("npm", ["run", "build"])) {
  console.error("the tree does not build before any mutant was applied — fix that first");
  process.exit(2);
}
if (!suitesPass()) {
  console.error("the scoped suites are red before any mutant was applied — every mutant would score a false kill");
  process.exit(2);
}

const survivors = [];
const uncompiled = [];
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
  const built = run("npm", ["run", "build"]);
  const green = built && suitesPass();
  writeFileSync(file, original);
  if (!built) uncompiled.push(name);
  console.log(`${green ? "SURVIVED" : built ? "killed  " : "NOT APPLIED — did not compile"}  ${name}`);
  if (green) survivors.push(name);
}
run("npm", ["run", "build"]);
const scored = MUTANTS.length - notApplied.length - uncompiled.length;
console.log(`\n${scored - survivors.length}/${scored} killed, of ${MUTANTS.length} written`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (uncompiled.length > 0) console.log("did not compile:", uncompiled.join(", "));
if (notApplied.length > 0) console.log("not applied:", notApplied.join(", "));

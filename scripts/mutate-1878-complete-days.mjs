import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITES = [
  "test/homepage-ranking-window-sentence.test.ts",
  "test/guide-ranking-key-cap.test.ts",
  "test/homepage-one-copy-one-hop.test.ts",
];

const MUTANTS = [
  ["an-unfinished-day-is-ranked", "src/homepage-routing.ts",
    "  return mostRecentDays(rollups, days).filter((day) => day.complete === true);",
    "  return mostRecentDays(rollups, days);"],

  ["a-rollup-that-states-nothing-reads-as-complete", "src/homepage-routing.ts",
    "(day) => day.complete === true",
    "(day) => day.complete !== false"],

  ["the-ranking-windows-every-day-held", "src/homepage-routing.ts",
    "  return completeDaysInWindow(rollups, days).filter((day) => {",
    "  return mostRecentDays(rollups, days).filter((day) => {"],

  ["the-held-count-includes-the-unfinished-day", "src/serve.ts",
    "  const held = completeDaysInWindow(durableRollups, AGENT_OPENS_WINDOW_DAYS);",
    "  const held = [...durableRollups].sort((a, b) => a.date.localeCompare(b.date)).slice(-AGENT_OPENS_WINDOW_DAYS);"],

  ["the-window-stops-saying-its-days-were-complete", "src/homepage-routing.ts",
    "    : `across the ${window.days} complete days on which",
    "    : `across the ${window.days} days on which"],

  ["the-one-day-stops-saying-it-was-complete", "src/homepage-routing.ts",
    "    ? `on ${window.to}, the one complete day on which",
    "    ? `on ${window.to}, the one day on which"],

  ["one-held-day-is-counted-as-days", "src/homepage-routing.ts",
    `  return days === 1 ? "1 complete day" : \`\${days} complete days\`;`,
    `  return \`\${days} complete days\`;`],

  ["the-fallback-counts-days-without-saying-complete", "src/homepage-routing.ts",
    "      + `We hold ${completeDaysCount(heldDays)} of traffic",
    "      + `We hold ${heldDays} days of traffic"],
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

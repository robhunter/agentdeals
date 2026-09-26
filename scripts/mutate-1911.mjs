import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = "test/catalogue-wide-route-citation.test.ts";

const RUN_DATE = "verifiedDate: new Date().toISOString().slice(0, 10)";
const daysBeforeTheRun = (days) => `verifiedDate: new Date(Date.now() - ${days} * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)`;

const MUTANTS = [
  ["the-fixture-was-verified-31-days-before-the-run", SUITE, RUN_DATE, daysBeforeTheRun(31), [
    "/api/new answers with no record, so this probe proves nothing",
    "/api/newest answers with no record, so this probe proves nothing",
  ]],

  ["the-fixture-falls-one-day-outside-the-window-api-new-is-asked-for", SUITE, RUN_DATE, daysBeforeTheRun(2), [
    "/api/new answers with no record, so this probe proves nothing",
  ]],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8" });
    return { ok: true, output: "" };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

const suite = () => run("node", ["--test", "--test-concurrency", "1", SUITE]);

function occurrences(haystack, needle) {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

if (!run("npm", ["run", "build"]).ok) {
  console.error("the tree does not build before any mutant was applied — fix that first");
  process.exit(2);
}
if (!suite().ok) {
  console.error("the suite is red before any mutant was applied — every mutant would score a false kill");
  process.exit(2);
}

const survivors = [];
const killedForAnotherReason = [];
const notApplied = [];
for (const [name, file, from, to, messages] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  const found = occurrences(original, from);
  if (found !== 1) {
    console.log(`NOT APPLIED  ${name} — its target appears ${found} times in ${file}, not once`);
    notApplied.push(name);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const result = suite();
  writeFileSync(file, original);
  const missing = messages.filter((message) => !result.output.includes(message));
  if (result.ok) {
    console.log(`SURVIVED  ${name}`);
    survivors.push(name);
  } else if (missing.length > 0) {
    console.log(`KILLED FOR ANOTHER REASON  ${name} — the failure never said: ${missing.join(" | ")}`);
    killedForAnotherReason.push(name);
  } else {
    console.log(`killed    ${name} — ${messages.join(" | ")}`);
  }
}
const scored = MUTANTS.length - notApplied.length;
const killed = scored - survivors.length - killedForAnotherReason.length;
console.log(`\n${killed}/${scored} killed with the failure they were written to cause, of ${MUTANTS.length} written`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (killedForAnotherReason.length > 0) console.log("killed for another reason:", killedForAnotherReason.join(", "));
if (notApplied.length > 0) console.log("not applied:", notApplied.join(", "));
if (survivors.length + killedForAnotherReason.length + notApplied.length > 0) process.exit(1);

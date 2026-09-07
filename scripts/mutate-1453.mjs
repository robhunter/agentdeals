import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = ["test/removal-durability.test.ts"];

const MUTANTS = [
  ["the-executive-summary-calls-every-removal-permanent-again", "src/serve.ts",
    "${escHtmlServer(lastingExamples.map(e => e.vendor).join(\", \"))}, and more. ${escHtmlServer(removalReturnRateSentence(durability))}",
    "Heroku, PlanetScale, SendGrid, Brave Search API, X API, and more. Once removed, none have returned."],
  ["the-key-pattern-callout-calls-every-removal-permanent-again", "src/serve.ts",
    "<strong>Key pattern:</strong> ${escHtmlServer(removalDurabilityPattern(durability, lastingExamples))} Plan your architecture",
    "<strong>Key pattern:</strong> Once a free tier is removed, it never comes back. Heroku (2022), PlanetScale (2024), SendGrid (2025), Brave Search (2026), X API (2026) &mdash; all permanent. Plan your architecture"],
  ["the-named-examples-are-written-out-rather-than-read-off-the-log", "src/serve.ts",
    "  const lastingExamples = lastingRemovalExamplesFor(\"/state-of-free-tiers\", dealChanges);",
    "  const lastingExamples = [\"Heroku\", \"PlanetScale\", \"SendGrid\", \"Brave Search API\", \"X API (Twitter)\"].map(vendor => ({ vendor, date: \"2022-11-28\", year: \"2022\" }));"],
  ["the-key-pattern-names-no-example-at-all", "src/serve.ts",
    "${escHtmlServer(removalDurabilityPattern(durability, lastingExamples))}",
    "${escHtmlServer(removalDurabilityPattern(durability, []))}"],
  ["a-reversal-recorded-in-the-resolution-field-is-not-a-return", "src/removal-durability.ts",
    "  if (removal.resolution?.state === \"reversed\") {",
    "  if (removal.resolution?.state === \"retracted\") {"],
  ["a-return-only-our-own-later-record-shows-is-missed", "src/removal-durability.ts",
    "      .filter(\n        (c) =>\n          c.vendor === removal.vendor &&",
    "      .filter(\n        (c) =>\n          false &&\n          c.vendor === removal.vendor &&"],
  ["a-retracted-record-is-counted-as-a-removal-that-came-back", "src/removal-durability.ts",
    "  if (theEventNeverHappened(removal)) return null;\n  if (removal.resolution?.state === \"reversed\") {",
    "  if (theEventNeverHappened(removal)) {\n    return { basis: \"resolution\", date: removal.resolution!.date, detail: null };\n  }\n  if (removal.resolution?.state === \"reversed\") {"],
  ["a-record-we-retracted-still-counts-as-a-removal-we-stand-behind", "src/removal-durability.ts",
    "  const weStandBehind = recorded.filter((r) => !theEventNeverHappened(r));",
    "  const weStandBehind = recorded;"],
  ["an-expansion-dated-before-the-removal-reads-as-a-return", "src/removal-durability.ts",
    "          c.date > removal.date &&",
    "          c.date !== removal.date &&"],
  ["another-vendor-expanding-reads-as-this-vendor-returning", "src/removal-durability.ts",
    "          c.vendor === removal.vendor &&\n          c.date > removal.date &&",
    "          c.date > removal.date &&"],
  ["a-later-cut-reads-as-a-return", "src/removal-durability.ts",
    "          CHANGE_DIRECTION[c.change_type as DealChange[\"change_type\"]] === \"positive\",",
    "          CHANGE_DIRECTION[c.change_type as DealChange[\"change_type\"]] !== \"neutral\","],
  ["the-return-rate-is-published-without-naming-anyone", "src/removal-durability.ts",
    "  return `${durability.cameBack.length} of the ${standBehind} removals we stand behind have since come back: ${vendorsThatCameBack(durability)}.${retractionClause(durability)}`;",
    "  return `${durability.cameBack.length} of the ${standBehind} removals we stand behind have since come back.${retractionClause(durability)}`;"],
  ["a-vendor-that-came-back-may-still-be-named-as-lasting", "src/removal-durability.ts",
    "    (removal) => !theEventNeverHappened(removal) && !theFreeTierCameBackAfter(removal, log),",
    "    (removal) => !theEventNeverHappened(removal),"],
  ["only-a-vendors-first-removal-is-checked-before-naming-it", "src/removal-durability.ts",
    "  const everyOneHeld = removals.every(",
    "  const everyOneHeld = removals.slice(0, 1).every("],
  ["the-scan-for-permanence-claims-sees-nothing", "src/removal-durability.ts",
    "  return REMOVAL_PERMANENCE_ASSERTIONS.some((pattern) => pattern.test(text));",
    "  return false;"],
  ["the-scan-fires-on-any-use-of-the-word-permanent", "src/removal-durability.ts",
    "const REMOVAL_PERMANENCE_ASSERTIONS = [",
    "const REMOVAL_PERMANENCE_ASSERTIONS = [\n  /\\bpermanent\\b/i,"],
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

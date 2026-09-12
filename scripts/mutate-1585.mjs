import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const TIER = "src/change-tier.ts";
const REVIEW = "src/change-direction-review.ts";
const LOG = "scripts/change-log.js";

const LISTINGS = "test/superseded-terms-listings.test.ts";

const SUITE = [
  "test/tier-scoped-verdicts.test.ts",
  "test/change-direction-review.test.ts",
  LISTINGS,
];

const MUTANTS = [
  ["a reading that says our tier narrowed is held off it again", TIER,
    "  if (readingSaysTheListedTierNarrowed(change)) return false;\n",
    ""],

  ["the vendor's own name for our free plan is a different plan again", TIER,
    "  return !readingNamesTheFreePlanWeList(change, tier);",
    "  return true;"],

  ["an edition's name stops carrying its own identity", TIER,
    "  if (tierRecordsASelfHostedEdition(listed)) return false;\n",
    ""],

  ["any listed tier counts as a free plan, so a paid plan's reading grades it", TIER,
    "  if (!tierRecordsAFreeTier(listed)) return false;\n",
    ""],

  ["the reading no longer has to describe a free plan at all", TIER,
    '  return A_FREE_PLAN.test(`${change.summary ?? ""} ${change.current_state ?? ""}`);',
    "  return true;"],

  ["the reading is read for a free plan in its terms but not in its summary", TIER,
    '  return A_FREE_PLAN.test(`${change.summary ?? ""} ${change.current_state ?? ""}`);',
    '  return A_FREE_PLAN.test(`${change.current_state ?? ""}`);'],

  ["the overlay writes over a direction the record was written with", REVIEW,
    "    if (isTierDirection(change.tier_direction)) return change;\n",
    ""],

  ["the overlay reaches a record its review does not name", REVIEW,
    "    const reviewed = byRecord.get(reviewKey(change));",
    "    const reviewed = byRecord.get(reviewKey(change)) ?? [...byRecord.values()][0];"],

  ["the detector stops storing the direction the reader gave", LOG,
    "      ...(directionRead ? { tier_direction: directionRead } : {}),\n",
    ""],

  ["a record is identified by an opening another record shares", LISTINGS,
    "    length < stored.length &&",
    "    false &&"],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8", env: { ...process.env, TZ: "UTC" } });
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
  const green = built && run("npx", ["tsx", "--test", "--test-concurrency", "1", ...SUITE]);
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

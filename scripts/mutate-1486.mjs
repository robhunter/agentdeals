import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = ["test/stacks.test.ts"];

const MUTANTS = [
  ["a-withheld-level-is-published-anyway", "src/stacks.ts",
    "    risk_level: assessment.rating_withheld ? null : assessment.level,",
    "    risk_level: assessment.level,"],

  ["the-candidate-carries-no-reason-for-a-withheld-level", "src/stacks.ts",
    "    rating_withheld: assessment.rating_withheld,",
    "    rating_withheld: null,"],

  ["the-candidate-carries-no-reason-for-a-withheld-stability", "src/stacks.ts",
    "    stability_withheld: uncitedNarrowings.length > 0 ? { reason: \"no_source\", records: uncitedNarrowings.length } : null,",
    "    stability_withheld: null,"],

  ["the-stability-reason-counts-every-record-rather-than-the-uncited-ones", "src/stacks.ts",
    "  const uncitedNarrowings = standingNarrowingsCitingNoSource(vendorChanges);",
    "  const uncitedNarrowings = vendorChanges;"],

  ["the-candidate-carries-no-link-health", "src/stacks.ts",
    "    link_unreachable: linkUnreachable,",
    "    link_unreachable: null,"],

  ["stability-is-classified-without-the-records-that-withhold-it", "src/stacks.ts",
    "    stability: withheldStability(linkUnreachable, classifyStability(vendorChanges), vendorChanges),",
    "    stability: withheldStability(null, classifyStability(vendorChanges), []),"],

  ["the-uncited-record-rule-reaches-only-the-level", "src/stacks.ts",
    "  const linkUnreachable = unreachableNoticeForUrl(offer.url);",
    "  const linkUnreachable = null;"],
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

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/stability-filter-respects-withholding.test.ts",
  "test/stability.test.ts",
  "test/stacks.test.ts",
  "test/link-unreachable-demerit.test.ts",
];

const MUTANTS = [
  ["the-source-check-stops-withholding-the-class", "src/data.ts",
    "  const sourceCheck = levelWithheldReason({ source_check: withholding.source_check ?? undefined }, null);\n  if (sourceCheck) return sourceCheck;",
    "  const sourceCheck = levelWithheldReason({ source_check: withholding.source_check ?? undefined }, null);\n  if (false) return sourceCheck;"],

  ["the-gate-stops-withholding-the-class", "src/data.ts",
    "  if (withholding.gate) return withholding.gate.code;",
    "  if (false) return withholding.gate?.code ?? \"gate\";"],

  ["a-refused-read-stops-withholding-the-class", "src/data.ts",
    "  if (withholding.refused_read) return \"refused_read\";",
    "  if (false) return \"refused_read\";"],

  ["an-unreachable-page-stops-withholding-the-class", "src/data.ts",
    "  if (withholding.link_unreachable) return \"link_unreachable\";",
    "  if (false) return \"link_unreachable\";"],

  ["a-narrowing-citing-no-source-stops-withholding-the-class", "src/data.ts",
    "  if (standingNarrowingsCitingNoSource(vendorChanges).length > 0) return \"no_source\";",
    "  if (standingNarrowingsCitingNoSource(vendorChanges).length < 0) return \"no_source\";"],

  ["a-withholding-takes-the-adverse-class-down-with-it", "src/data.ts",
    "  return FAVOURABLE_STABILITY_CLASSES.has(stability) ? null : stability;",
    "  return null;"],

  ["a-withholding-leaves-the-favourable-class-standing", "src/data.ts",
    "  return FAVOURABLE_STABILITY_CLASSES.has(stability) ? null : stability;",
    "  return stability;"],

  ["the-filter-goes-back-to-the-unwithheld-classification", "src/data.ts",
    "      (o) => publishedRisk(o, vendorChanges.get(o.vendor.toLowerCase()) ?? []).stability === stability,",
    "      (o) => classifyStability(vendorChanges.get(o.vendor.toLowerCase()) ?? []) === stability,"],

  ["the-filter-defaults-a-withheld-record-to-stable", "src/data.ts",
    "      (o) => publishedRisk(o, vendorChanges.get(o.vendor.toLowerCase()) ?? []).stability === stability,",
    "      (o) => (publishedRisk(o, vendorChanges.get(o.vendor.toLowerCase()) ?? []).stability ?? \"stable\") === stability,"],

  ["the-row-publishes-the-unwithheld-classification", "src/data.ts",
    "  const stability = withheldStability(withholding, classified, grading);",
    "  const stability: StabilityClass | null = classified;"],

  ["the-row-says-nothing-about-why-the-class-is-withheld", "src/data.ts",
    "    stability_withheld_because: stability === null ? stabilityWithholdingReason(withholding, grading) : null,",
    "    stability_withheld_because: null,"],

  ["the-index-answers-a-name-it-does-not-hold-with-stable", "src/data.ts",
    "    of: (vendorOrSlug: string) => byKey.get(vendorOrSlug.toLowerCase()) ?? UNRATED_STABILITY,",
    "    of: (vendorOrSlug: string) => byKey.get(vendorOrSlug.toLowerCase()) ?? \"stable\","],

  ["the-index-answers-by-vendor-name-only", "src/data.ts",
    "    for (const key of [vendor.toLowerCase(), toSlug(vendor)]) {",
    "    for (const key of [vendor.toLowerCase()]) {"],

  ["the-disclosure-counts-nothing-held-back", "src/data.ts",
    "  const withheld = candidates.filter(\n    (o) => publishedRisk(o, vendorChanges.get(o.vendor.toLowerCase()) ?? []).stability === null,\n  ).length;",
    "  const withheld = 0;"],

  ["the-disclosure-counts-every-candidate-as-held-back", "src/data.ts",
    "  const withheld = candidates.filter(\n    (o) => publishedRisk(o, vendorChanges.get(o.vendor.toLowerCase()) ?? []).stability === null,\n  ).length;",
    "  const withheld = candidates.length;"],

  ["a-candidate-publishes-the-unwithheld-class", "src/stacks.ts",
    "    stability: published.stability,",
    "    stability: published.stability ?? classifyStability(vendorChanges),"],
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

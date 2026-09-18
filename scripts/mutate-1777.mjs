import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITES = [
  ["test/openapi-covers-what-we-serve.test.ts", []],
];

const PAYLOAD = "{ offer: offerWithCode, relatedVendors, ...(includeAlternatives ? { alternatives } : {}), tie_break, ...(resolvedFrom ? { resolved_from: resolvedFrom } : {}) }";

const MUTANTS = [
  ["the-alternatives-array-ships-inside-offer-as-well", "src/serve.ts",
    "    const { relatedVendors, alternatives, tie_break, ...offerRecord } = detailResult.offer;",
    "    const { relatedVendors, tie_break, ...offerRecord } = detailResult.offer;\n    const alternatives = detailResult.offer.alternatives;"],

  ["tie_break-is-reachable-only-inside-offer", "src/serve.ts",
    PAYLOAD,
    "{ offer: { ...offerWithCode, tie_break }, relatedVendors, ...(includeAlternatives ? { alternatives } : {}), ...(resolvedFrom ? { resolved_from: resolvedFrom } : {}) }"],

  ["relatedVendors-is-reachable-only-inside-offer", "src/serve.ts",
    PAYLOAD,
    "{ offer: { ...offerWithCode, relatedVendors }, ...(includeAlternatives ? { alternatives } : {}), tie_break, ...(resolvedFrom ? { resolved_from: resolvedFrom } : {}) }"],

  ["the-alternatives-array-is-served-without-the-flag", "src/serve.ts",
    PAYLOAD,
    "{ offer: offerWithCode, relatedVendors, alternatives: alternatives ?? [], tie_break, ...(resolvedFrom ? { resolved_from: resolvedFrom } : {}) }"],

  ["a-disambiguation-answer-cites-nothing", "src/serve.ts",
    "res.end(JSON.stringify(citedAcrossTheWholeIndex({ disambiguation, resolved_from: vendorParam })));",
    "res.end(JSON.stringify({ disambiguation, resolved_from: vendorParam }));"],

  ["the-schema-stops-declaring-relatedVendors", "src/openapi.ts",
    "                      relatedVendors: { type: \"array\", items: { type: \"string\" }, description: \"Every alternative we hold in this vendor's category, named, in the order tie_break describes. Not a selection of them (#1774). Returned whether or not alternatives=true.\" },\n",
    ""],

  ["the-schema-stops-declaring-the-block-it-serves", "src/openapi.ts",
    ",\n                      _agent: { $ref: \"#/components/schemas/AgentBlock\" }",
    ""],

  ["the-two-arrays-name-the-same-set-in-a-different-order", "src/data.ts",
    "      result.alternatives = enrichOffers(sameCategoryOffers).map(o => stripReferrerValue(o));",
    "      result.alternatives = enrichOffers(sameCategoryOffers).map(o => stripReferrerValue(o)).reverse();"],

  ["the-details-door-caps-at-five-again", "src/data.ts",
    "    const sameCategoryOffers = relatedRanking.entries.map((e) => e.offer);",
    "    const sameCategoryOffers = relatedRanking.entries.slice(0, 5).map((e) => e.offer);"],
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
  for (const [file, extra] of SUITES) {
    if (!run("node", ["--test", "--test-concurrency", "1", ...extra, file])) return false;
  }
  return true;
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
  const green = built && suitesPass();
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

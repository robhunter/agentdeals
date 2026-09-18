import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const NEW_BLOCK = "every door that names alternatives names the whole ranked order";

const SUITES = [
  ["test/named-subsets.test.ts", ["--test-name-pattern", NEW_BLOCK]],
  ["test/ranked-surfaces.test.ts", []],
];

const MUTANTS = [
  ["the-details-door-caps-at-five-again", "src/data.ts",
    "    const sameCategoryOffers = relatedRanking.entries.map((e) => e.offer);",
    "    const sameCategoryOffers = relatedRanking.entries.slice(0, 5).map((e) => e.offer);"],

  ["the-vendor-risk-door-caps-at-three-again", "src/data.ts",
    "  const alternatives = alternativesRanking.entries.map((e) => ({\n    vendor: e.offer.vendor,",
    "  const alternatives = alternativesRanking.entries.slice(0, 3).map((e) => ({\n    vendor: e.offer.vendor,"],

  ["related-vendors-is-capped-while-alternatives-is-whole", "src/data.ts",
    "    const relatedVendors = sameCategoryOffers.map((o) => o.vendor);",
    "    const relatedVendors = sameCategoryOffers.slice(0, 5).map((o) => o.vendor);"],

  ["the-published-total-is-lowered-to-match-a-cap", "src/ranking.ts",
    "    tie_break: { ...result.tie_break, ranked_total: entries.length },",
    "    tie_break: { ...result.tie_break, ranked_total: Math.min(entries.length, 5) },"],

  ["the-published-total-forgets-the-entries-behind-a-gate", "src/ranking.ts",
    "    tie_break: { ...result.tie_break, ranked_total: entries.length },",
    "    tie_break: { ...result.tie_break, ranked_total: result.ranked.length },"],

  ["the-published-total-counts-only-the-tied-band", "src/ranking.ts",
    "      ranked_total: ranked.length,",
    "      ranked_total: qualified.length,"],

  ["the-mcp-vendor-resource-caps-at-five-again", "src/server.ts",
    "      const alternatives = \"offer\" in details ? details.offer.alternatives ?? [] : [];",
    "      const alternatives = (\"offer\" in details ? details.offer.alternatives ?? [] : []).slice(0, 5);"],

  ["the-mcp-vendor-resource-stops-saying-how-much-it-names", "src/server.ts",
    "        text += `${wholeRankedOrderList(alternatives.length)}\\n\\n`;\n",
    ""],

  ["the-mcp-vendor-resource-claims-a-count-it-does-not-name", "src/server.ts",
    "        text += `${wholeRankedOrderList(alternatives.length)}\\n\\n`;",
    "        text += `${wholeRankedOrderList(alternatives.length + 1)}\\n\\n`;"],

  ["the-completeness-claim-is-reworded-into-a-prefix", "src/ranking.ts",
    "  return `every one of the ${total} entries in that order, not a prefix of it`;",
    "  return `the first ${total} entries in that order`;"],

  ["the-concise-mcp-projection-drops-the-alternatives", "src/server.ts",
    "          if (result.offer.alternatives) offerWithCode.alternatives = result.offer.alternatives.map(toConciseOffer);",
    "          if (result.offer.alternatives) offerWithCode.alternatives = result.offer.alternatives.slice(0, 5).map(toConciseOffer);"],

  ["the-vendor-page-stops-saying-the-list-is-whole", "src/serve.ts",
    "${renderAuditBlock(alternativesRanking.tie_break, { total: alternativesRanking.entries.length })}",
    "${renderAuditBlock(alternativesRanking.tie_break)}"],
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

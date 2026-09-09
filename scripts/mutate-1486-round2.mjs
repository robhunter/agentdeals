import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/one-published-risk.test.ts",
  "test/audit-stack.test.ts",
  "test/stacks.test.ts",
  "test/enrich.test.ts",
  "test/vendor-verdict.test.ts",
];

const MUTANTS = [
  ["the-gate-stops-withholding-a-level", "src/data.ts",
    "    gate !== null ||\n    assessment.rating_withheld !== null ||",
    "    assessment.rating_withheld !== null ||"],

  ["an-uncited-record-set-stops-withholding-a-level", "src/data.ts",
    "    gate !== null ||\n    assessment.rating_withheld !== null ||",
    "    gate !== null ||"],

  ["an-unread-source-page-stops-withholding-a-level", "src/data.ts",
    "    (cannotVouchForLevel(offer, link_unreachable) && assessment.level === \"stable\");",
    "    false;"],

  ["an-adverse-level-is-withheld-along-with-a-favourable-one", "src/data.ts",
    "    (cannotVouchForLevel(offer, link_unreachable) && assessment.level === \"stable\");",
    "    cannotVouchForLevel(offer, link_unreachable);"],

  ["the-withheld-level-carries-no-statement", "src/data.ts",
    "export function levelWithheldStatement(vendor: string, risk: PublishedRisk): string | null {\n  if (risk.risk_level !== null) return null;",
    "export function levelWithheldStatement(vendor: string, risk: PublishedRisk): string | null {\n  if (risk.risk_level !== null) return null;\n  if (risk.gate === null) return null;"],

  ["the-audit-derives-its-own-level", "src/data.ts",
    "    const published = publishedRisk(offer, vendorChanges);\n    const riskLevel = published.risk_level;",
    "    const published = publishedRisk(offer, vendorChanges);\n    const riskLevel = vendorRiskAssessment(vendorChanges).level;"],

  ["the-audit-carries-no-gate", "src/data.ts",
    "      gate: published.gate,\n      level_withheld_because: levelWithheldStatement(offer.vendor, published),",
    "      gate: null,\n      level_withheld_because: levelWithheldStatement(offer.vendor, published),"],

  ["a-swap-target-is-picked-without-the-withholding-rules", "src/data.ts",
    "      return publishedRisk(o, oChanges).risk_level === \"stable\";",
    "      return vendorRiskAssessment(oChanges).level === \"stable\";"],

  ["a-withheld-vendor-counts-as-a-risk-found", "src/data.ts",
    "    if (riskLevel === \"risky\" || riskLevel === \"caution\") risksFound++;",
    "    if (riskLevel !== \"stable\") risksFound++;"],

  ["the-stack-candidate-derives-its-own-level", "src/stacks.ts",
    "    risk_level: published.risk_level,",
    "    risk_level: published.history_level,"],

  ["the-vendor-page-substitutes-stable-for-a-withheld-level", "src/vendor-verdict.ts",
    "  if (level === null) return null;\n  return level === \"stable\" || cause ? level : \"stable\";",
    "  if (level === null) return \"stable\";\n  return level === \"stable\" || cause ? level : \"stable\";"],

  ["a-stack-of-nothing-we-rate-earns-a-letter", "src/stack-grade.ts",
    "  if (rated === 0) {",
    "  if (found < 0) {"],

  ["the-grade-divides-by-the-whole-stack-again", "src/stack-grade.ts",
    "  var riskyPct = counts.risky / rated;\n  var cautionPct = counts.caution / rated;",
    "  var riskyPct = counts.risky / found;\n  var cautionPct = counts.caution / found;"],

  ["a-withheld-vendor-counts-as-stable", "src/stack-grade.ts",
    "  var rated = found - counts.withheld;",
    "  var rated = found;"],

  ["the-letter-travels-without-its-denominator", "src/stack-grade.ts",
    "denominator: \"Grade based on \" + rated + \" of \" + servicesEntered + \" services.\" };",
    "denominator: \"\" };"],

  ["a-partial-stack-claims-every-service-is-stable", "src/stack-grade.ts",
    "    description = partial ? \"Every rated service is stable, with no recent pricing concerns.\" : \"All services are stable with no recent pricing concerns.\";",
    "    description = \"All services are stable with no recent pricing concerns.\";"],
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

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/free-tier-vouched-share.test.ts",
  "test/category-gate-lede.test.ts",
];

const MUTANTS = [
  ["tier-rule-drops-the-classifier", "src/free-tier-record.ts",
    `  if (classifyTier(tier).class !== "free") return false;`,
    `  if (false) return false;`],
  ["tier-rule-drops-the-labels", "src/free-tier-record.ts",
    `  return label.includes("free") || RECORDED_FREE_TIER_LABELS.has(label);`,
    `  return label.includes("free");`],
  ["tier-rule-accepts-anything", "src/free-tier-record.ts",
    `  return label.includes("free") || RECORDED_FREE_TIER_LABELS.has(label);`,
    `  return true;`],
  ["census-counts-an-ended-free-tier", "src/serve.ts",
    `    if (claim?.states === "ended") {
      census.ended++;
      continue;
    }`,
    `    if (claim?.states === "ended") {
      census.ended++;
    }`],
  ["census-vouches-for-the-unconfirmed", "src/serve.ts",
    `    if (claim?.states === "offered") census.vouched++;
    else census.unconfirmed++;`,
    `    census.vouched++;`],
  ["census-never-reports-an-ending", "src/serve.ts",
    `      census.ended++;`,
    `      census.ended += 0;`],
  ["claim-is-never-read", "src/serve.ts",
    `  const context = vendorVerdictContext(vendorName, servedOn);
  return context ? freeTierClaim(context.input) : null;`,
    `  return null;`],
  ["category-keeps-the-ended-record", "src/serve.ts",
    `  const catStanding = catOffers.filter((o) => !catEnded.includes(o));`,
    `  const catStanding = catOffers;`],
  ["category-finds-no-ending", "src/serve.ts",
    `  return population.filter(o => freeTierClaimFor(o.vendor, servedOn)?.states === "ended");`,
    `  return population.filter(o => freeTierClaimFor(o.vendor, servedOn)?.states === "offered" && false);`],
  ["intro-counts-the-ended-record", "src/serve.ts",
    `    <p>We track <strong>${"$"}{catStandingCount}</strong> ${"$"}{categoryName.toLowerCase()} services with free tiers.`,
    `    <p>We track <strong>${"$"}{catCount}</strong> ${"$"}{categoryName.toLowerCase()} services with free tiers.`],
  ["snippet-counts-the-ended-record", "src/serve.ts",
    `  const metaDesc = \`Compare ${"$"}{catStandingCount} free`,
    `  const metaDesc = \`Compare ${"$"}{catCount} free`],
  ["lede-says-nothing-about-an-ending", "src/eligibility.ts",
    `  if (ended <= 0) return "";`,
    `  return "";`],
  ["lede-loses-the-plural", "src/eligibility.ts",
    `  return \` We also track ${"$"}{ended} whose free tiers have ended.\`;`,
    `  return " We also track one whose free tier has ended.";`],
  ["lede-drops-the-clause-when-gated", "src/eligibility.ts",
    `  return \`${"$"}{counted}. ${"$"}{gateDisclosureSentence("them", total, codes)}${"$"}{alsoEnded}\`;`,
    `  return \`${"$"}{counted}. ${"$"}{gateDisclosureSentence("them", total, codes)}\`;`],
  ["report-leads-with-the-recorded-share", "src/serve.ts",
    `    <li><strong>${"$"}{vouchedPct}% of tracked services offer a free tier we can vouch for today</strong>`,
    `    <li><strong>${"$"}{recordedPct}% of tracked services offer a free tier we can vouch for today</strong>`],
  ["landscape-ranks-by-the-recorded-share", "src/serve.ts",
    `    b.vouchedPct - a.vouchedPct
    || b.census.vouched - a.census.vouched
    || b.census.total - a.census.total`,
    `    b.recordedPct - a.recordedPct
    || b.census.total - a.census.total`],
  ["landscape-drops-the-vouched-share", "src/serve.ts",
    `      <td style="text-align:right;color:var(--text);font-weight:600">${"$"}{c.vouchedPct}%</td>`,
    `      <td style="text-align:right;color:var(--text);font-weight:600">${"$"}{c.recordedPct}%</td>`],
  ["cards-keep-the-ended-vendor", "src/serve.ts",
    `      if (freeTierClaimFor(canonical, reportServedOn)?.states === "ended") {`,
    `      if (freeTierClaimFor(canonical, reportServedOn) === null) {`],
  ["cards-stop-resolving-the-slug", "src/serve.ts",
    `      const slug = resolution.type === "exact" || resolution.type === "redirect" ? resolution.slug : null;`,
    `      const slug = toSlug(name);`],
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
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  if (!original.includes(from)) {
    console.log(`SKIP  ${name} — the line it mutates is not in ${file}`);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const built = run("npm", ["run", "build"]);
  const green = built && run("node", ["--test", "--test-concurrency", "1", ...SUITE]);
  writeFileSync(file, original);
  console.log(`${green ? "SURVIVED" : built ? "killed  " : "killed (did not compile)"}  ${name}`);
  if (green) survivors.push(name);
}
run("npm", ["run", "build"]);
console.log(`\n${MUTANTS.length - survivors.length}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));

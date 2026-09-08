import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = ["test/faq-names-no-winner.test.ts"];

const MUTANTS = [
  ["the-comparison-faq-crowns-whichever-record-sorts-first", "src/serve.ts",
    "  const noBest = unrankedBestAnswer({",
    "  const noBestReinstated = `Based on our comparison of ${catOffers.length} ${catName.toLowerCase()} services, ${catOffers[0]?.vendor || catName} stands out for its free tier generosity.`;\n  const noBest = catOffers.length === 0 ? null : noBestReinstated || unrankedBestAnswer({"],

  ["the-category-faq-calls-the-first-five-records-the-most-popular", "src/serve.ts",
    "      q: `What is the best free ${categoryName.toLowerCase()} service?`,\n      a: catNoBest,",
    "      q: `What is the best free ${categoryName.toLowerCase()} service?`,\n      a: `Based on our data, the most popular free ${categoryName.toLowerCase()} services include ${catOffers.slice(0, 5).map(o => o.vendor).join(\", \")}.`,"],

  ["the-alternatives-faq-crowns-five-of-a-list-it-rotates-daily", "src/serve.ts",
    "  const faqBestAltsAnswer = unrankedBestAnswer({",
    "  const faqBestAltsAnswer = enrichedAlts.length > 0 ? `The best free alternatives to ${vendorName} include ${enrichedAlts.slice(0, 5).map(a => `${a.vendor} (${a.tier})`).join(\", \")}.` : unrankedBestAnswer({"],

  ["the-vendor-page-faq-crowns-the-top-five-alternatives", "src/serve.ts",
    "  const faqAlternativesAnswer = unrankedBestAnswer({",
    "  const faqAlternativesAnswer = alternatives.length > 0 ? `The top free alternatives to ${vendorName} in ${primary.category} include ${alternatives.slice(0, 5).map(a => `${a.vendor} (${a.tier})`).join(\", \")}.` : unrankedBestAnswer({"],

  ["a-hand-written-answer-names-one-vendors-tier-the-most-generous", "src/serve.ts",
    "Groq's free tier is 30 RPM with 100K-500K tokens/day, no credit card required",
    "Groq offers the most generous free tier: 30 RPM with 100K-500K tokens/day, no credit card required"],

  ["a-comparison-denominator-pools-two-catalogue-categories-again", "src/serve.ts",
    "  if (meta.catalogueCategory === null) return [];\n  return offers.filter(o => o.category === meta.catalogueCategory);",
    "  if (meta.catalogueCategory === null) return [];\n  return offers.filter(o => o.category === meta.catalogueCategory || o.category === \"Cloud Hosting\");"],

  ["a-comparison-page-claims-a-catalogue-category-we-hold-none-for", "src/serve.ts",
    "{ slug: \"serverless-free-tier-comparison-2026\", subject: \"Serverless\", catalogueCategory: null,",
    "{ slug: \"serverless-free-tier-comparison-2026\", subject: \"Serverless\", catalogueCategory: \"Serverless\","],

  ["an-answer-lists-a-record-that-denies-a-free-tier-among-free-ones", "src/serve.ts",
    "    basis: statedFreeTierBasis(catStatesFreeTier, catStatesNoFreeTier),",
    "    basis: `The ${categoryName.toLowerCase()} services include ${catOffers.slice(0, 5).map(o => o.vendor).join(\", \")}.`,"],

  ["the-answer-declines-to-rank-and-stops-naming-the-rule", "src/unranked.ts",
    "} Our ranking rule is published at ${CRITERIA_PATH}.`;",
    "}`;"],

  ["a-ranked-list-drops-the-quantity-it-claims-to-rank-by", "src/serve.ts",
    "The top programs by credit value are: Google Cloud for Startups Scale AI ($350K), Cloudflare High Growth ($250K), Google Cloud Scale ($200K), Microsoft Founders Hub Premium ($150K), IBM Cloud Premium ($120K), AWS Activate Portfolio ($100K), and DigitalOcean Hatch ($100K).",
    "The top programs are Google Cloud for Startups Scale AI, Cloudflare High Growth, Google Cloud Scale, Microsoft Founders Hub Premium, IBM Cloud Premium, AWS Activate Portfolio and DigitalOcean Hatch."],
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

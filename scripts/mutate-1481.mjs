import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = ["test/derived-page-freshness.test.ts"];

const MUTANTS = [
  ["the-span-collapses-to-the-newest-record-it-holds", "src/page-freshness.ts",
    "  if (earliest === latest) return `${FRESHNESS_VERB} ${earliest}.`;",
    "  if (true) return `${FRESHNESS_VERB} ${latest}.`;"],

  ["the-span-collapses-to-the-oldest-record-it-holds", "src/page-freshness.ts",
    "  if (earliest === latest) return `${FRESHNESS_VERB} ${earliest}.`;",
    "  if (true) return `${FRESHNESS_VERB} ${earliest}.`;"],

  ["a-single-year-span-repeats-the-year-on-both-ends", "src/page-freshness.ts",
    "  const opening = yearOf(earliest) === yearOf(latest)\n    ? earliest.slice(0, earliest.lastIndexOf(\" \"))\n    : earliest;",
    "  const opening = earliest;"],

  ["only-the-first-surface-is-given-the-claim", "src/page-freshness.ts",
    "  return html.split(FRESHNESS_TOKEN).join(claim);",
    "  return html.replace(FRESHNESS_TOKEN, claim);"],

  ["a-page-that-can-derive-nothing-keeps-its-placeholder", "src/page-freshness.ts",
    "  if (claim === \"\") return html.split(` ${FRESHNESS_TOKEN}`).join(\"\").split(FRESHNESS_TOKEN).join(\"\");",
    "  if (claim === \"\") return html;"],

  ["a-hand-compiled-page-is-dated-from-the-catalogue", "src/page-freshness.ts",
    "  if (review && !review.reads_index) return compiledClaimFor(review, today);",
    "  if (false) return compiledClaimFor(review!, today);"],

  ["a-catalogue-page-is-dated-from-its-own-publication", "src/page-freshness.ts",
    "  if (review && !review.reads_index) return compiledClaimFor(review, today);",
    "  if (review) return compiledClaimFor(review, today);"],

  ["the-claim-is-taken-from-links-that-are-not-records", "src/page-freshness.ts",
    "const VENDOR_HREF = /href=\"\\/vendor\\/([a-z0-9][a-z0-9-]*)\"/g;",
    "const VENDOR_HREF = /href=\"\\/alternative-to\\/([a-z0-9][a-z0-9-]*)\"/g;"],

  ["a-date-we-cannot-parse-is-published-as-a-month", "src/page-freshness.ts",
    "  const parts = ISO_DATE.exec(isoDate);\n  if (!parts) return \"\";",
    "  const parts = /^(\\d{4})-?(\\d{2})?/.exec(isoDate);\n  if (!parts) return \"\";"],

  ["the-response-stops-resolving-the-placeholder", "src/serve.ts",
    "      args[0] = withLedeBeforeNav(withPageFreshness(args[0], url.pathname));",
    "      args[0] = withLedeBeforeNav(args[0]);"],

  ["a-hardcoded-month-comes-back-into-a-page-description", "src/serve.ts",
    "Exact rate limits and token quotas. [[freshness]]\";",
    "Exact rate limits and token quotas. Updated March 2026.\";"],
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

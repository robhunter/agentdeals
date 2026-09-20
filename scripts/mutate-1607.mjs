import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = ["test/best-of-url-stability.test.ts"];

const MUTANTS = [
  ["src/best-of-publication.ts",
    "return input.qualified >= input.minPicks || input.publishedBefore;",
    "return input.qualified >= input.minPicks && input.publishedBefore;",
    "a path must both reach the floor and have published"],
  ["src/best-of-publication.ts",
    "return input.qualified >= input.minPicks || input.publishedBefore;",
    "return input.qualified >= input.minPicks;",
    "the ledger stops holding a path open"],
  ["src/best-of-publication.ts",
    "return input.qualified >= input.minPicks || input.publishedBefore;",
    "return input.qualified > input.minPicks || input.publishedBefore;",
    "the floor is read as strictly above the minimum"],
  ["src/best-of-publication.ts",
    "return input.qualified >= input.minPicks || input.publishedBefore;",
    "return true;",
    "every path resolves, published or not"],
  ["src/best-of-publication.ts",
    "  const held = new Set(previous.slugs);",
    "  const held = new Set();",
    "the recorder forgets every path the ledger held"],
  ["src/best-of-publication.ts",
    "    if (slug.startsWith(\"/\")) throw new Error(`${source} lists ${JSON.stringify(slug)} as a slug, expected the slug alone and not a path`);",
    "",
    "the ledger accepts a path where a slug belongs"],
  ["src/serve.ts",
    "  if (generallyAvailable.length < BEST_OF_MIN_VENDORS && !bestOfPublishedBefore.has(slug)) continue;",
    "  if (generallyAvailable.length < BEST_OF_MIN_VENDORS) continue;",
    "a published page drops out when its vendor count falls"],
  ["src/serve.ts",
    "      publishedBefore: bestOfPublishedBefore.has(slug),",
    "      publishedBefore: false,",
    "the route forgets that a path has published"],
  ["src/serve.ts",
    "    const retiredCategorySlug = bestOfRetiredCategorySlugs.get(slug);",
    "    const retiredCategorySlug = undefined;",
    "a retired category's best-of path 404s again"],
  ["src/serve.ts",
    "  if (bestOfPublishedBefore.has(`free-${slug}`) && !bestOfSlugMap.has(`free-${slug}`)) {",
    "  if (bestOfPublishedBefore.has(`free-${slug}`) && bestOfSlugMap.has(`free-${slug}`)) {",
    "the redirect takes the paths that still have a page"],
  ["src/serve.ts",
    "  const excludedHtml = excluded.length === 0 ? \"\" : `",
    "  const excludedHtml = true ? \"\" : `",
    "a page names none of the offers it gates"],
  ["src/serve.ts",
    "    excluded.map(e => e.gate.code),",
    "    [],",
    "the gate disclosure counts no gated offer"],
];

function build() {
  try {
    execFileSync("npx", ["tsc"], { encoding: "utf8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function run() {
  try {
    execFileSync("node", ["--test", "--test-concurrency", "1", ...SUITE], { encoding: "utf8", stdio: "pipe" });
    return "SURVIVED";
  } catch {
    return "killed";
  }
}

let killed = 0;
let notApplied = 0;
for (const [file, from, to, description] of MUTANTS) {
  const original = readFileSync(file, "utf8");
  const occurrences = original.split(from).length - 1;
  if (occurrences !== 1) {
    console.log(`  NOT APPLIED  ${description} — the target appears ${occurrences} times in ${file}`);
    notApplied++;
    continue;
  }
  writeFileSync(file, original.split(from).join(to));
  if (!build()) {
    console.log(`  NOT APPLIED  ${description} — the compiler rejected it`);
    notApplied++;
    writeFileSync(file, original);
    build();
    continue;
  }
  const verdict = run();
  if (verdict !== "SURVIVED") killed++;
  console.log(`  ${verdict.padEnd(12)} ${description}`);
  writeFileSync(file, original);
  build();
}

console.log(`\n${killed} of ${MUTANTS.length} killed, ${notApplied} not applied`);

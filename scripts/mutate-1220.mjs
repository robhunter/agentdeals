import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = ["test/shared-pricing-pages.test.ts", "test/vendor-merge-redirect.test.ts"];
const LINT = "scripts/lint-shared-pages.js";
const MERGES = "src/vendor-merges.ts";
const SLUG = "src/vendor-slug.ts";
const DATA = "src/data.ts";
const SERVE = "src/serve.ts";

const MUTANTS = [
  ["one-page-reads-as-two-through-a-www-prefix", LINT,
    '    .replace(/^www\\./, "")\n',
    ""],

  ["a-tracking-parameter-splits-a-page-in-two", LINT,
    '    .split("?")[0]\n',
    ""],

  ["an-aggregator-page-is-read-as-a-duplicate", LINT,
    "    if (members.some((o) => o.source_check?.outcome === AGGREGATOR_OUTCOME)) continue;",
    "    if (false) continue;"],

  ["a-registered-merge-stops-clearing-its-group", LINT,
    "    const live = members.filter((o) => !retiredKeys.has(vendorKey(o.vendor)));",
    "    const live = members.slice();"],

  ["a-registered-shared-page-covers-a-record-that-joins-it", LINT,
    "    if (allowSets.some((allowed) => sameVendorSet(vendors, allowed))) continue;",
    "    if (allowSets.some((allowed) => [...allowed].every((v) => vendors.has(v)))) continue;"],

  ["one-name-under-two-categories-is-read-as-two-products", LINT,
    "    if (vendors.size < 2) continue;",
    "    if (vendors.size < 1) continue;"],

  ["the-blocking-rule-stops-reading-the-category", LINT,
    "    const key = withinCategory ? `${url} ${offer.category}` : url;",
    "    const key = url;"],

  ["a-page-is-cleared-by-a-record-that-shares-only-its-host", LINT,
    '    .split("#")[0]\n    .split("?")[0]\n    .replace(/\\/+$/, "");',
    '    .split("#")[0]\n    .split("?")[0]\n    .replace(/\\/.*$/, "");'],

  ["a-slug-redirects-before-the-record-it-names-is-gone", MERGES,
    "    if (liveSlugs.has(from)) continue;",
    "    if (false) continue;"],

  ["a-slug-redirects-to-a-page-the-catalogue-does-not-answer", MERGES,
    "    if (!liveSlugs.has(to)) continue;",
    "    if (false) continue;"],

  ["a-change-record-moves-before-the-record-it-names-is-gone", MERGES,
    "    if (liveVendors.has(key)) return null;",
    "    if (false) return null;"],

  ["a-change-record-moves-to-a-name-the-catalogue-does-not-carry", MERGES,
    "    if (!liveVendors.has(merge.survivor.trim().toLowerCase())) return null;",
    "    if (false) return null;"],

  ["a-comparison-of-one-record-reads-as-a-comparison", MERGES,
    "    if (a && b) return a === b ? a : null;",
    "    if (a && b) return null;"],

  ["a-comparison-of-two-records-reads-as-one", MERGES,
    "    if (a && b) return a === b ? a : null;",
    "    if (a && b) return a;"],

  ["a-retired-path-answers-404-instead-of-moving", SLUG,
    "  const merged = retiredVendorSlugMap.get(input);\n  if (merged) return { type: \"redirect\", slug: merged };\n",
    ""],

  ["a-comparison-moves-to-a-page-the-catalogue-does-not-answer", MERGES,
    "    if (!liveSlugs.has(to)) continue;\n    map.set(from, to);",
    "    map.set(from, to);"],

  ["a-comparison-naming-a-retired-record-answers-404", SERVE,
    "    const a = recordNamedBySlug(slug.slice(0, at));\n    const b = recordNamedBySlug(slug.slice(at + 4));",
    "    const a = vendorSlugMap.get(slug.slice(0, at));\n    const b = vendorSlugMap.get(slug.slice(at + 4));"],

  ["a-merge-leaves-its-history-behind", DATA,
    "    const survivor = survivingVendorName(change.vendor, live);\n    return survivor ? { ...change, vendor: survivor } : change;",
    "    return change;"],
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

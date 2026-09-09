import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = ["test/function-naming.test.ts", "test/product-function-pages.test.ts"];

const MUTANTS = [
  ["two-labels-for-one-function-split-back-into-two-pages", "src/product-role.ts",
    "export function canonicalEntryFor(entry: TaxonomyEntryRef): TaxonomyEntryRef {\n  for (const ruling of CROSS_TAXONOMY_RULINGS) {",
    "export function canonicalEntryFor(entry: TaxonomyEntryRef): TaxonomyEntryRef {\n  if (entry.subtype.length > 0) return entry;\n  for (const ruling of CROSS_TAXONOMY_RULINGS) {"],

  ["the-page-namespace-keys-on-the-raw-label-again", "src/product-function.ts",
    "      const canonical = canonicalEntryFor({ taxonomy, subtype });\n      const key = functionKey(toSlug(canonical.subtype));",
    "      const canonical = canonicalEntryFor({ taxonomy, subtype });\n      const key = functionKey(toSlug(subtype));"],

  ["a-record-reaches-the-page-only-under-the-governing-label", "src/product-function.ts",
    "  const labels = (offer.product_subtypes?.labels ?? []).filter(l => fn.subtypes.includes(l.subtype));",
    "  const labels = (offer.product_subtypes?.labels ?? []).filter(l => toSlug(l.subtype) === fn.slug);"],

  ["the-register-loses-the-pair-it-was-filed-for", "src/product-role.ts",
    "    a: { taxonomy: \"Databases\", subtype: \"vector\" },\n    b: { taxonomy: \"AI / ML\", subtype: \"vector_store\" },",
    "    a: { taxonomy: \"Databases\", subtype: \"vector\" },\n    b: { taxonomy: \"AI / ML\", subtype: \"kv_cache\" },"],

  ["the-taxonomies-stop-being-read-against-each-other", "src/product-role.ts",
    "      if (!byDefinition && !byLabel) continue;",
    "      if (!byDefinition || !byLabel || overlap > 0.9) continue;"],

  ["a-merged-function-publishes-one-definition-per-parent", "src/product-function.ts",
    "      const governing = governingDefinition(taxonomy, subtype);\n      if (governing) definitions.add(governing);",
    "      const governing = subtypeDefinition(taxonomy, subtype);\n      if (governing) definitions.add(governing);"],

  ["the-definition-goes-back-behind-a-subject-pronoun", "src/product-function.ts",
    "  return definitions.length === 0 ? \"\" : `Our membership test: ${definitions.join(\"; or \")}.`;",
    "  return definitions.length === 0 ? \"\" : `We list a product here when it ${definitions.join(\"; or when it \")}.`;"],

  ["the-count-sentence-stops-agreeing-in-number", "src/serve.ts",
    "function countedNoun(count: number, noun: string): string {\n  return `${count} ${noun}${count === 1 ? \"\" : \"s\"}`;\n}",
    "function countedNoun(count: number, noun: string): string {\n  return `${count} ${noun}s`;\n}"],

  ["a-declared-class-name-is-ignored-for-the-title", "src/product-function.ts",
    "  const declared = subtypeEntry(canonical.taxonomy, canonical.subtype)?.name;",
    "  const declared = undefined as string | undefined;"],

  ["a-declared-name-borrows-a-noun-its-parent-does-not-supply", "src/product-role.ts",
    "{ subtype: \"vector\", name: \"Vector Databases\", definition:",
    "{ subtype: \"vector\", name: \"Vector Search\", definition:"],

  ["a-declared-name-is-published-with-the-generic-noun-appended", "src/product-function.ts",
    "  return { title, listNoun: declared ?? `${title} Tools` };",
    "  return { title, listNoun: `${title} Tools` };"],

  ["the-page-threshold-counts-what-the-function-could-reach", "src/serve.ts",
    "    if (rankFunction(fn, date).qualified.length >= BEST_OF_MIN_PICKS) publishing.set(slug, fn);",
    "    if (functionMembers(offers, fn).length >= BEST_OF_MIN_PICKS) publishing.set(slug, fn);"],

  ["a-page-with-one-pick-is-published-again", "src/serve.ts",
    "const BEST_OF_MIN_PICKS = 2;",
    "const BEST_OF_MIN_PICKS = 1;"],

  ["a-withheld-page-stays-in-the-sitemap", "src/serve.ts",
    "    for (const [s, fn] of publishedBestOf().entries()) {",
    "    for (const [s, fn] of bestOfSlugMap.entries()) {"],

  ["a-category-page-loses-the-title-its-category-gave-it", "src/product-function.ts",
    "    byKey.set(key, { slug, title: name, listNoun: `${name} Tools`,",
    "    byKey.set(key, { slug, title: name, listNoun: `${name} Free Tools`,"],
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

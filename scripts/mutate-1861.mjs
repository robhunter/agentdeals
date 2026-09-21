import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITES = [
  "test/disclaimed-provenance.test.ts",
  "test/check-finding-not-a-quotation.test.ts",
  "test/comparison-source-citation.test.ts",
  "test/vendor-page-states-the-reason-once.test.ts",
];

const MUTANTS = [
  ["a-restatement-stops-dating-our-terms", "src/read-date.ts",
    `  if (restated) return { read: "a_read_we_restated_them_from", on: restated };`,
    ""],

  ["a-stored-confirmation-stops-dating-our-terms", "src/read-date.ts",
    `  return confirmed ? { read: "a_read_that_confirmed_them", on: confirmed } : null;`,
    "  return null;"],

  ["every-record-reads-as-dated-to-a-read", "src/read-date.ts",
    `  return confirmed ? { read: "a_read_that_confirmed_them", on: confirmed } : null;`,
    `  return { read: "a_read_that_confirmed_them", on: confirmed ?? "" };`],

  ["the-catalogue-date-stands-in-for-a-confirmation", "src/read-date.ts",
    `  const confirmed = confirmationDate(offer);\n  return confirmed ? { read: "a_read_that_confirmed_them", on: confirmed } : null;`,
    `  const confirmed = offer?.verifiedDate ?? null;\n  return confirmed ? { read: "a_read_that_confirmed_them", on: confirmed } : null;`],

  ["a-restatement-is-dated-to-the-read-that-followed-it", "src/read-date.ts",
    `  if (restated) return { read: "a_read_we_restated_them_from", on: restated };`,
    `  if (restated) return { read: "a_read_we_restated_them_from", on: lastReadDate(offer) };`],

  ["a-restated-clause-loses-the-reading-it-was-taken-from", "src/read-date.ts",
    "  a_read_we_restated_them_from: (provenance, readOn) =>\n    theReadOurTermsCameFrom(readOn, provenance.on).trim(),",
    "  a_read_we_restated_them_from: (provenance, readOn) =>\n    theReadOurTermsCameFrom(readOn, readOn).trim(),"],

  ["a-confirmed-clause-loses-the-day-it-was-confirmed", "src/read-date.ts",
    "  a_read_that_confirmed_them: provenance => termsLastConfirmedOn(provenance.on),",
    "  a_read_that_confirmed_them: () => termsLastConfirmedOn(\"\"),"],

  ["the-vendor-page-disclaims-whatever-the-stores-hold", "src/serve.ts",
    "    const scope = whereOurTermsCameFrom(primary)\n      ? \"\"\n      : ` <span class=\"${CHECK_SCOPE_CLASS}\">${escHtmlServer(CHECK_ESTABLISHES)}</span>`;",
    "    const scope = ` <span class=\"${CHECK_SCOPE_CLASS}\">${escHtmlServer(CHECK_ESTABLISHES)}</span>`;"],

  ["the-vendor-page-disclaims-nothing-at-all", "src/serve.ts",
    "    const scope = whereOurTermsCameFrom(primary)\n      ? \"\"\n      : ` <span class=\"${CHECK_SCOPE_CLASS}\">${escHtmlServer(CHECK_ESTABLISHES)}</span>`;",
    "    const scope = \"\";"],

  ["a-cited-entry-stops-saying-where-its-figures-came-from", "src/serve.ts",
    "  return { vendor: vendorName, slug, source, termsCameFrom: termsCameFromClause(primary, source) };",
    "  return { vendor: vendorName, slug, source, termsCameFrom: null };"],

  ["an-entry-we-do-not-cite-speaks-for-its-figures-too", "src/serve.ts",
    "  if (!source.cited || !offer) return null;",
    "  if (!offer) return null;"],

  ["the-list-disclaims-every-entry-whatever-it-holds", "src/source-citation.ts",
    "  return ourOwn.length === services.length\n    ? CHECK_ESTABLISHES_ON_A_LIST\n    : CHECK_ESTABLISHES_ON_THE_REST_OF_A_LIST;",
    "  return CHECK_ESTABLISHES_ON_A_LIST;"],

  ["the-list-drops-its-note-as-soon-as-one-entry-is-dated", "src/source-citation.ts",
    "  if (ourOwn.length === 0) return null;",
    "  if (ourOwn.length < services.length) return null;"],

  ["the-list-counts-the-entries-it-no-longer-speaks-for", "src/source-citation.ts",
    "  return services.filter(service => !service.termsCameFrom);",
    "  return services.filter(service => Boolean(service.termsCameFrom));"],
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
  for (const file of SUITES) {
    if (!run("node", ["--test", "--test-concurrency", "1", file])) return false;
  }
  return true;
}

function occurrences(haystack, needle) {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
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
const notApplied = [];
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  const found = occurrences(original, from);
  if (found !== 1) {
    console.log(`NOT APPLIED  ${name} — its target appears ${found} times in ${file}, not once`);
    notApplied.push(name);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const built = run("npm", ["run", "build"]);
  const green = built && suitesPass();
  writeFileSync(file, original);
  if (!built) uncompiled.push(name);
  console.log(`${green ? "SURVIVED" : built ? "killed  " : "NOT APPLIED — did not compile"}  ${name}`);
  if (green) survivors.push(name);
}
run("npm", ["run", "build"]);
const scored = MUTANTS.length - notApplied.length - uncompiled.length;
console.log(`\n${scored - survivors.length}/${scored} killed, of ${MUTANTS.length} written`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (uncompiled.length > 0) console.log("did not compile:", uncompiled.join(", "));
if (notApplied.length > 0) console.log("not applied:", notApplied.join(", "));

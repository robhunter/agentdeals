import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITES = [
  "test/category-description-count.test.ts",
  "test/listing-reads-the-store.test.ts",
];

const MUTANTS = [
  ["a-read-that-confirmed-the-price-is-a-doubt-again", "src/vendor-verdict.ts",
    `  states_a_free_price: "the_read_confirmed_the_price",`,
    `  states_a_free_price: "the_page_did_not_answer",`],

  ["a-refused-change-reads-as-a-page-that-said-nothing", "src/vendor-verdict.ts",
    `  change_measured_no_difference: "our_read_did_not_confirm",`,
    `  change_measured_no_difference: "the_page_did_not_answer",`],

  ["a-confirmed-price-suppresses-the-contradiction-beside-it", "src/serve.ts",
    `    || termsTheVerdictWithholds(unconfirmedTermsFor(offer)) !== null;`,
    `    || unconfirmedTermsFor(offer) !== null;`],

  ["a-confirmed-price-is-counted-without-asking-what-else-we-hold", "src/serve.ts",
    `  if (where !== null && where !== "the_read_confirmed_the_price") return where;\n  return readContradictingTheTermsFor(offer) === null ? null : "our_read_did_not_confirm";`,
    `  if (where !== null) return where === "the_read_confirmed_the_price" ? "the_page_did_not_answer" : where;\n  return readContradictingTheTermsFor(offer) === null ? null : "our_read_did_not_confirm";`],

  ["a-superseded-row-states-the-doubt-a-second-time", "src/serve.ts",
    `  if (supersedingChangeFor(offer) !== null) return "";\n  const unconfirmed = reasonWeCannotConfirmFor(offer);\n  if (!unconfirmed || unconfirmed.because.reason === "link_unreachable") return "";`,
    `  const unconfirmed = reasonWeCannotConfirmFor(offer);\n  if (!unconfirmed || unconfirmed.because.reason === "link_unreachable") return "";`],

  ["a-confirmed-price-renders-as-a-reason-we-could-not-confirm", "src/serve.ts",
    `  return theReadConfirmedThePrice(unconfirmed)\n    ? confirmedPriceSpanHtml(unconfirmed)\n    : unconfirmedTermsSpanHtml(unconfirmed);`,
    `  return unconfirmedTermsSpanHtml(unconfirmed);`],

  ["the-count-names-one-part-and-drops-the-other", "src/serve.ts",
    `    : \`: \${named.map(part => \`on \${part.count} \${part.said}\`).join(", and ")}\`;`,
    `    : \`: \${named.slice(0, 1).map(part => \`on \${part.count} \${part.said}\`).join(", and ")}\`;`],

  ["the-count-is-the-first-part-rather-than-the-sum", "src/serve.ts",
    `  const count = named.reduce((total, part) => total + part.count, 0);`,
    `  const count = named.length === 0 ? 0 : named[0].count;`],

  ["the-vendor-list-goes-ahead-of-the-count", "src/serve.ts",
    `deals.\${catGatedClause ? \` \${catGatedClause}\` : ""}\${termsWeCannotConfirmMetaClause(catStanding)}\`;\n  const metaDesc = catMeasured\n    + uncontradictedVendorClause(catUncontradicted.map(o => o.vendor), DESCRIPTION_CHARACTER_CAP - catMeasured.length);`,
    `deals.\${catGatedClause ? \` \${catGatedClause}\` : ""}\`;\n  const metaDesc = catMeasured\n    + uncontradictedVendorClause(catUncontradicted.map(o => o.vendor), DESCRIPTION_CHARACTER_CAP - catMeasured.length)\n    + termsWeCannotConfirmMetaClause(catStanding);`],

  ["the-vendor-list-takes-no-notice-of-the-room-it-has", "src/serve.ts",
    `    if (clause.length <= room) return clause;`,
    `    return clause;`],

  ["the-cap-is-raised-to-fit-whatever-we-write", "src/serve.ts",
    `const DESCRIPTION_CHARACTER_CAP = 307;`,
    `const DESCRIPTION_CHARACTER_CAP = 420;`],

  ["a-vendor-we-count-is-named-as-uncontradicted", "src/serve.ts",
    `  return supersedingChangeFor(offer) === null && !statesTermsWeCannotConfirm(offer);`,
    `  return supersedingChangeFor(offer) === null;`],

  ["the-row-says-nothing-about-which-number-it-is-in", "src/serve.ts",
    `  return where === null ? "" : \` data-unconfirmed="\${where}"\`;`,
    `  return where === null ? "" : \` data-unconfirmed="the_page_did_not_answer"\`;`],
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

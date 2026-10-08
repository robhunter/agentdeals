import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITES = [
  "test/link-liveness.test.ts",
  "test/link-liveness-checker.test.ts",
  "test/a-referral-program-is-published-only-from-a-page-we-read.test.ts",
  "test/referral-programs.test.ts",
  "test/referral-disclosure-predicate.test.ts",
];

const SURFACES = "src/referral-surfaces.ts";
const HEALTH = "src/link-health.ts";
const SERVE = "src/serve.ts";
const CHECKER = "scripts/check-liveness.js";

const MUTANTS = [
  ["a-program-is-published-whatever-its-page-did", SURFACES,
    `  return programPageAnswersForUrl(program.program_url);`,
    `  return true;`],

  ["a-program-is-published-without-a-read-date", SURFACES,
    `  if (termsReadOn(program) === null) return false;\n`,
    ``],

  ["any-string-is-a-read-date", SURFACES,
    `  return typeof readOn === "string" && A_DATE.test(readOn) ? readOn : null;`,
    `  return typeof readOn === "string" ? readOn : null;`],

  ["a-refusal-withdraws-the-program", HEALTH,
    `  return !(record.outcome === "reachable" && typeof record.redirected_to === "string");`,
    `  return record.outcome === "reachable" && typeof record.redirected_to !== "string";`],

  ["a-redirect-to-another-page-still-answers", HEALTH,
    `  return !(record.outcome === "reachable" && typeof record.redirected_to === "string");`,
    `  return true;`],

  ["an-unreachable-page-answers-until-the-server-says-gone", HEALTH,
    `  if (record.outcome === "unreachable") return false;`,
    `  if (record.outcome === "unreachable" && record.terminal) return false;`],

  ["a-trailing-slash-is-another-page", HEALTH,
    "    return `${parsed.hostname.replace(/^www\\./, \"\")}${parsed.pathname.replace(/\\/+$/, \"\")}`;",
    "    return `${parsed.hostname.replace(/^www\\./, \"\")}${parsed.pathname}`;"],

  ["a-www-prefix-is-another-host", HEALTH,
    "    return `${parsed.hostname.replace(/^www\\./, \"\")}${parsed.pathname.replace(/\\/+$/, \"\")}`;",
    "    return `${parsed.hostname}${parsed.pathname.replace(/\\/+$/, \"\")}`;"],

  ["the-vendor-card-reads-only-the-flag", SERVE,
    "  const referralProgramHtml = documentsVendorReferralProgram(primary) ? `",
    "  const referralProgramHtml = primary.referral_program?.available ? `"],

  ["the-directory-reads-only-the-flag", SERVE,
    `    if (documentsVendorReferralProgram(o) && !seen.has(o.vendor)) {\n      seen.add(o.vendor);\n      const ourLink`,
    `    if (o.referral_program?.available && !seen.has(o.vendor)) {\n      seen.add(o.vendor);\n      const ourLink`],

  ["the-api-reads-only-the-flag", SERVE,
    `      if (documentsVendorReferralProgram(o) && !seen.has(o.vendor)) {\n        seen.add(o.vendor);\n        const catNormalized`,
    `      if (o.referral_program?.available && !seen.has(o.vendor)) {\n        seen.add(o.vendor);\n        const catNormalized`],

  ["the-disclosure-counts-only-the-flag", SERVE,
    `  const vendorsWithOwnProgram = new Set(offers.filter(o => documentsVendorReferralProgram(o)).map(o => toSlug(o.vendor)));`,
    `  const vendorsWithOwnProgram = new Set(offers.filter(o => o.referral_program?.available === true).map(o => toSlug(o.vendor)));`],

  ["the-directory-prints-no-read-date", SERVE,
    "        <td class=\"read-cell\">${escHtmlServer(v.read_on)}</td>",
    "        <td class=\"read-cell\"></td>"],

  ["the-vendor-card-prints-no-read-date", SERVE,
    "${TERMS_READ_LABEL} ${escHtmlServer(termsReadOn(primary.referral_program) ?? \"\")}</span>",
    "${TERMS_READ_LABEL}</span>"],

  ["the-api-returns-no-read-date", SERVE,
    `            read_on: termsReadOn(o.referral_program),`,
    `            read_on: null,`],

  ["the-checker-reads-no-program-page", CHECKER,
    `    const programUrl = offer.referral_program?.program_url;`,
    `    const programUrl = undefined;`],

  ["the-checker-records-no-redirect", CHECKER,
    `      record.redirected_to = result.finalUrl;\n`,
    ``],

  ["the-checker-records-redirects-on-listing-links", CHECKER,
    `    if ((target.programs ?? []).length > 0 && landsOnAnotherPage(target.url, result.finalUrl)) {`,
    `    if (landsOnAnotherPage(target.url, result.finalUrl)) {`],

  ["the-checker-forgets-a-redirected-page", CHECKER,
    `  return records.filter((r) => r.outcome !== "reachable" || typeof r.redirected_to === "string");`,
    `  return records.filter((r) => r.outcome !== "reachable");`],

  ["a-dead-program-page-queues-the-listing", CHECKER,
    `    .filter((r) => !programOnlyUrls.has(r.url))\n`,
    ``],

  ["a-shared-page-counts-as-a-program-only-page", CHECKER,
    `  return target.vendors.length === 0 && (target.programs ?? []).length > 0;`,
    `  return (target.programs ?? []).length > 0;`],

  ["a-program-page-is-dated-by-nothing", CHECKER,
    `    latestVerified: target.vendors.length > 0 ? target.latestVerified : latestRead,`,
    `    latestVerified: target.latestVerified,`],

  ["a-program-read-dates-the-listing-page", CHECKER,
    `    latestVerified: target.vendors.length > 0 ? target.latestVerified : latestRead,`,
    `    latestVerified: laterOf(target.latestVerified, latestRead),`],

  ["the-report-forgets-redirected-program-pages", CHECKER,
    `    (r) => programUrls.has(r.url) && (r.outcome === "unreachable" || typeof r.redirected_to === "string")`,
    `    (r) => programUrls.has(r.url) && r.outcome === "unreachable"`],

  ["the-report-names-listing-pages-as-programs", CHECKER,
    `    (r) => programUrls.has(r.url) && (r.outcome === "unreachable" || typeof r.redirected_to === "string")`,
    `    (r) => r.outcome === "unreachable" || typeof r.redirected_to === "string"`],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

function build() {
  if (!run("npx", ["tsc"])) throw new Error("the build failed");
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

build();
if (!suitesPass()) {
  console.error("the scoped suite is red before any mutant was applied — every mutant would score a false kill");
  process.exit(2);
}

const survivors = [];
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
  let green = null;
  try {
    if (file.startsWith("src/")) build();
    green = suitesPass();
  } catch (err) {
    console.log(`NOT APPLIED  ${name} — ${err.message}, so no test was asked`);
    notApplied.push(name);
  } finally {
    writeFileSync(file, original);
  }
  if (file.startsWith("src/")) build();
  if (green === null) continue;
  console.log(`${green ? "SURVIVED" : "killed  "}  ${name}`);
  if (green) survivors.push(name);
}

const scored = MUTANTS.length - notApplied.length;
console.log(`\n${scored - survivors.length}/${scored} killed, of ${MUTANTS.length} written`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (notApplied.length > 0) console.log("not applied:", notApplied.join(", "));

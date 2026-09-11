import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = ["test/page-lastmod.test.ts"];
const LEDGER = "src/page-lastmod.ts";
const SERVER = "src/serve.ts";

const MUTANTS = [
  ["a-rotating-page-is-dated-from-nothing", LEDGER,
    "  return isDailyEntry(entry) ? today : entry.changed;",
    "  return isDailyEntry(entry) ? null : entry.changed;"],

  ["no-entry-is-read-as-rotating", LEDGER,
    "  return (entry as PageLastmodDaily).daily === true;",
    "  return false;"],

  ["every-entry-is-read-as-rotating", LEDGER,
    "  return (entry as PageLastmodDaily).daily === true;",
    "  return true;"],

  ["a-rotating-page-is-dated-from-the-day-the-ledger-was-written", SERVER,
    "  return entryDay(pageLastmodLedger.pages[pagePath], utcToday());",
    "  return entryDay(pageLastmodLedger.pages[pagePath], pageLastmodLedger.generated);"],

  ["the-sitemap-dates-a-rotating-page-from-the-fallback", LEDGER,
    "  return entryDay(ledger.pages[pagePath], today) ?? fallback;",
    "  return entryDay(ledger.pages[pagePath], fallback) ?? fallback;"],

  ["an-entry-may-store-both-a-rotating-flag-and-a-hash", LEDGER,
    "      if (entry.hash !== undefined || entry.changed !== undefined) {",
    "      if (false) {"],

  ["any-rotating-flag-is-read-as-rotating", LEDGER,
    "      if (entry.daily !== true) {",
    "      if (false) {"],

  ["the-run-records-nothing-as-rotating", LEDGER,
    "    const next: PageLastmodEntry = daily.has(pagePath) ? { daily: true } : { hash, changed: today };",
    "    const next: PageLastmodEntry = { hash, changed: today };"],

  ["the-run-records-everything-as-rotating", LEDGER,
    "    const next: PageLastmodEntry = daily.has(pagePath) ? { daily: true } : { hash, changed: today };",
    "    const next: PageLastmodEntry = { daily: true };"],

  ["a-page-that-was-already-rotating-is-reported-as-moved", LEDGER,
    "    } else if (isDailyEntry(before) && isDailyEntry(next)) {",
    "    } else if (false) {"],

  ["a-page-that-stops-rotating-keeps-its-rotating-entry", LEDGER,
    "    } else if (!isDailyEntry(before) && !isDailyEntry(next) && before.hash === hash) {",
    "    } else if (isDailyEntry(before) || (!isDailyEntry(next) && before.hash === hash)) {"],

  ["a-page-the-run-never-read-may-be-recorded-as-rotating", LEDGER,
    "    if (!hashes.has(pagePath)) throw new Error(`${pagePath} is dated from the day it is served but was not read this run`);",
    "    if (false) throw new Error(`${pagePath} is dated from the day it is served but was not read this run`);"],

  ["the-newest-day-across-a-set-ignores-the-rotating-ones", LEDGER,
    "    const day = lastmodFor(ledger, pagePath, fallback, today);",
    "    const day = lastmodFor(ledger, pagePath, fallback, \"1970-01-01\");"],

  ["only-a-page-is-dated-so-the-feed-carries-no-day", SERVER,
    "      if (!res.hasHeader(\"Last-Modified\")) {",
    "      if (/^text\\/html/.test(servedContentType) && !res.hasHeader(\"Last-Modified\")) {"],

  ["a-revalidation-is-answered-against-a-day-nothing-advertises", SERVER,
    "    if (status === 200 && isNotModified(revalidation, pageLastmodHeader(url.pathname, url.search))) {",
    "    if (status === 200 && isNotModified(revalidation, httpDate(pageLastmodLedger.generated))) {"],

  ["the-vendor-pages-are-left-out-of-the-ledger", SERVER,
    "    ...vendorSitemapPaths(),\n    ...comparisonSitemapPaths(),",
    "    ...comparisonSitemapPaths(),"],

  ["the-reports-and-digests-are-left-out-of-the-ledger", SERVER,
    "    ...reportsSitemapPaths(),\n    ...miscSitemapLedgerPaths(),",
    "    ...miscSitemapLedgerPaths(),"],

  ["the-alternatives-pages-are-left-out-of-the-ledger", SERVER,
    "  paths.push(\"/x402-services\", ...alternativeToSitemapPaths());",
    "  paths.push(\"/x402-services\");"],

  ["the-trends-pages-are-left-out-of-the-ledger", SERVER,
    "  const paths = [\"/trends\"];\n  for (const c of categories) paths.push(\"/trends/\" + toSlug(c.name));",
    "  const paths = [\"/trends\"];"],

  ["a-vendor-page-is-dated-from-the-record-again", SERVER,
    "      xml += '  <url>\\n    <loc>' + BASE_URL + '/vendor/' + s + '</loc>\\n    <lastmod>' + pageLastmod(\"/vendor/\" + s) + '</lastmod>",
    "      xml += '  <url>\\n    <loc>' + BASE_URL + '/vendor/' + s + '</loc>\\n    <lastmod>' + pageLastmod(\"/\") + '</lastmod>"],

  ["a-best-of-page-is-dated-from-the-day-of-the-request", SERVER,
    "      xml += '  <url>\\n    <loc>' + BASE_URL + '/best/' + s + '</loc>\\n    <lastmod>' + pageLastmod(\"/best/\" + s) + '</lastmod>",
    "      xml += '  <url>\\n    <loc>' + BASE_URL + '/best/' + s + '</loc>\\n    <lastmod>' + utcToday() + '</lastmod>"],
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

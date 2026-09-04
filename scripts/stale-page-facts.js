import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STALE_FACT_PAGES_BASELINE, newestChangeBySlug, pageReviewsPath, parsePageReviews,
  staleFactPages, staleFactViolations, vendorsStatedBy,
} from "../dist/page-reviews.js";
import { toSlug } from "../dist/vendor-slug.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `List the editorial pages that state a vendor fact a record has moved under.

A page states a fact about a vendor two ways: its verdict blocks award something to that
vendor, or one of its tables puts a number beside it. Either is a published claim, so
either counts. A record dated after the page was last read means nobody has checked the
claim against the record since the record moved — the pair is reported, not judged.

The count of such pages is budgeted by stale_fact_pages in data/quality_budgets.json and the
budget does not rise. Run this when that budget refuses a build, to see which page entered.

Usage: node scripts/stale-page-facts.js [options]

  --date <date>   Day to measure, YYYY-MM-DD (default: today, UTC)
  --file <path>   Registry to read (default ${pageReviewsPath()})
  --json          Emit the cohort as JSON
  --help          This text
`;

function parseArgs(argv) {
  const opts = { date: new Date().toISOString().slice(0, 10), file: pageReviewsPath(), json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    else if (arg === "--date") opts.date = argv[++i];
    else if (arg === "--file") opts.file = argv[++i];
    else if (arg === "--json") opts.json = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      return { help: true, invalid: true };
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log(HELP);
  process.exit(opts.invalid ? 1 : 0);
}

const index = parsePageReviews(readFileSync(opts.file, "utf-8"));
const changes = JSON.parse(readFileSync(join(REPO, "data", "deal_changes.json"), "utf-8")).changes;
const newest = newestChangeBySlug(changes, opts.date, toSlug);
const changeDateFor = (slug) => newest.get(slug) ?? null;

const stale = staleFactPages(index.pages, opts.date, changeDateFor);
const violations = staleFactViolations(index.pages, opts.date, changeDateFor);

if (opts.json) {
  console.log(JSON.stringify({ generated_for: opts.date, budget: STALE_FACT_PAGES_BASELINE, pages: stale }, null, 2));
  process.exit(violations.length > 0 ? 1 : 0);
}

const pairs = stale.reduce((n, p) => n + p.facts.length, 0);
const tableOnlyPairs = stale.reduce((n, p) => n + p.facts.filter(f => f.surface === "table").length, 0);
const tableOnlyPages = stale.filter(p => p.facts.every(f => f.surface === "table")).length;

console.log(`${stale.length} of ${index.pages.length} pages state a vendor fact a record has moved under, on ${opts.date}`);
console.log(`${pairs} page-vendor pairs, of which ${tableOnlyPairs} are named only by a table; ${tableOnlyPages} pages are in the cohort on a table alone`);
console.log(`budget ${STALE_FACT_PAGES_BASELINE} (stale_fact_pages in data/quality_budgets.json)`);
console.log("");

for (const p of stale) {
  console.log(`${p.path}  (${p.state}, last read ${p.clock_starts})`);
  for (const f of p.facts) console.log(`    ${f.changed}  ${f.slug}  [${f.surface}]`);
}

const quiet = index.pages.filter(p => !stale.some(s => s.path === p.path));
console.log("");
console.log(`${quiet.length} pages are outside the cohort:`);
for (const p of quiet) {
  const stated = vendorsStatedBy(p);
  console.log(`    ${p.path}  states ${stated.length} vendor facts${stated.length === 0 ? " — it cannot enter" : ""}`);
}

for (const v of violations) console.error(`\n${v.problem}`);
process.exit(violations.length > 0 ? 1 : 0);

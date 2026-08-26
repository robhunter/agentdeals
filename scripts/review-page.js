import { readFileSync, writeFileSync } from "node:fs";
import { overdueReport, pageReviewsPath, parsePageReviews } from "../dist/page-reviews.js";

const HELP = `Record that an editorial page was re-read and found correct.

A review advances the page's freshness date. Nothing else may: a render, a deploy and a
data refresh all leave it alone, which is the point — the date has to mean a person or a
model actually read the prose.

A review is refused unless --checked names every vendor the page's verdict blocks commit
us to. A verdict that awards a badge to a vendor whose record has since moved is the
failure this guards against, so a review that skipped that vendor is not a review.

Usage: node scripts/review-page.js --path <route> --checked <slug,slug> --reviewer <name> [options]
       node scripts/review-page.js --list

  --path <route>      Page reviewed, e.g. /email-comparison-2026
  --checked <slugs>   Comma-separated vendor slugs verified against their current record
  --reviewer <name>   Who or what performed the review
  --date <date>       Review date, YYYY-MM-DD (default: today, UTC)
  --list              Print the overdue report and exit
  --file <path>       Registry to read and write (default ${pageReviewsPath()})
  --dry-run           Report the outcome, write nothing
  --help              This text
`;

function parseArgs(argv) {
  const opts = { path: null, checked: null, reviewer: null, date: null, list: false, file: pageReviewsPath(), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    else if (arg === "--path") opts.path = argv[++i];
    else if (arg === "--checked") opts.checked = argv[++i];
    else if (arg === "--reviewer") opts.reviewer = argv[++i];
    else if (arg === "--date") opts.date = argv[++i];
    else if (arg === "--list") opts.list = true;
    else if (arg === "--file") opts.file = argv[++i];
    else if (arg === "--dry-run") opts.dryRun = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      return { help: true, invalid: true };
    }
  }
  return opts;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log(HELP);
  process.exit(opts.invalid ? 1 : 0);
}

const today = new Date().toISOString().slice(0, 10);
const index = parsePageReviews(readFileSync(opts.file, "utf-8"));

if (opts.list) {
  const report = overdueReport(today, index);
  console.log(`${report.totals.pages} pages — ${report.totals.current} current, ${report.totals.overdue} overdue, ${report.totals.expired} expired, ${report.totals.never_reviewed} never reviewed`);
  for (const p of report.pages) {
    const flag = p.tier === "A" && p.vendors_asserted.length === 0 ? "  (names no resolvable vendor)" : "";
    console.log(`  ${String(p.days_overdue).padStart(4)}d over  tier ${p.tier}  ${p.state.padEnd(14)} ${p.path}${flag}`);
  }
  process.exit(0);
}

if (!opts.path) fail("--path is required");
if (!opts.reviewer) fail("--reviewer is required — a review has to be attributable");

const record = index.pages.find(p => p.path === opts.path);
if (!record) fail(`${opts.path} is not on the review register. Run scripts/sync-page-reviews.js if it is a new page.`);

const date = opts.date ?? today;
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`--date must be YYYY-MM-DD, got ${date}`);
if (date > today) fail(`--date ${date} is in the future`);
if (date < record.published) fail(`--date ${date} precedes the page's publication (${record.published})`);

const checked = new Set((opts.checked ?? "").split(",").map(s => s.trim()).filter(Boolean));
const missing = record.vendors_asserted.filter(slug => !checked.has(slug));
if (missing.length > 0) {
  fail(`${opts.path} states a verdict about ${record.vendors_asserted.length} vendors and --checked omits ${missing.length}: ${missing.join(", ")}`);
}
const unexpected = [...checked].filter(slug => !record.vendors_asserted.includes(slug));

record.reviewed_at = date;
record.reviewer = opts.reviewer;

console.log(`${opts.path} reviewed ${date} by ${opts.reviewer}`);
console.log(`  verdict vendors checked: ${record.vendors_asserted.length ? record.vendors_asserted.join(", ") : "(none stated)"}`);
if (unexpected.length > 0) console.log(`  also checked, not stated in a verdict block: ${unexpected.join(", ")}`);
if (opts.dryRun) {
  console.log("dry run — nothing written");
  process.exit(0);
}
writeFileSync(opts.file, JSON.stringify(index, null, 2) + "\n");
console.log(`  wrote ${opts.file}`);

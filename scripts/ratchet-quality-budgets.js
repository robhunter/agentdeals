import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  QUALITY_BUDGET_NAMES, newestChangeBySlug, pageReviewsPath, parsePageReviews, qualityBudgetsPath,
  readQualityBudgets, serializeQualityBudgets, staleFactPages, unsourcedTierAPaths,
} from "../dist/page-reviews.js";
import { toSlug } from "../dist/vendor-slug.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `Keep data/quality_budgets.json in step with what the shipped data measures.

Each budget is a ratchet: the count it caps may fall and the budget follows it down, but
neither may rise without a person deciding to allow it. The budgets used to be constants in
src/, which the scheduled data jobs and data-only pull requests cannot write — so clearing
a page was a breaking change for whoever cleared it. They are data now, and this lowers
them in the same commit as the improvement that earned it.

A budget above its measurement is lowered. A budget below its measurement is left alone and
reported: raising it is a decision, and the suite is what fails until someone makes it. The FAQ
budgets are measured by booting a server, which this does not do, so it reports them and leaves
them to be edited by hand from the number the suite prints.

Usage: node scripts/ratchet-quality-budgets.js [options]

  --lower         Write the lowered budgets (default: report only)
  --date <date>   Day to measure, YYYY-MM-DD (default: today, UTC)
  --json          Emit the measurement as JSON
  --help          This text

Exit status is 0 whenever the measurement was taken, including when a budget is below it.
`;

function parseArgs(argv) {
  const opts = { lower: false, date: new Date().toISOString().slice(0, 10), json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    else if (arg === "--lower") opts.lower = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--date") opts.date = argv[++i];
    else {
      console.error(`Unknown argument: ${arg}`);
      return { help: true, invalid: true };
    }
  }
  return opts;
}

export function measureBudgets(date) {
  const index = parsePageReviews(readFileSync(pageReviewsPath(), "utf-8"));
  const changes = JSON.parse(readFileSync(join(REPO, "data", "deal_changes.json"), "utf-8")).changes;
  const newest = newestChangeBySlug(changes, date, toSlug);
  const stale = staleFactPages(index.pages, date, slug => newest.get(slug) ?? null);
  return {
    stale_fact_pages: stale.length,
    unsourced_tier_a: unsourcedTierAPaths(index.pages).length,
  };
}

export function ratchet(budgets, measured) {
  const lowered = [];
  const over = [];
  const unmeasured = [];
  const next = { ...budgets };
  for (const name of QUALITY_BUDGET_NAMES) {
    const was = budgets[name];
    const is = measured[name];
    if (typeof is !== "number") {
      unmeasured.push(name);
    } else if (is < was) {
      next[name] = is;
      lowered.push({ name, from: was, to: is });
    } else if (is > was) {
      over.push({ name, budget: was, measured: is });
    }
  }
  return { next, lowered, over, unmeasured };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    process.exit(opts.invalid ? 1 : 0);
  }

  const file = readQualityBudgets();
  const measured = measureBudgets(opts.date);
  const { next, lowered, over, unmeasured } = ratchet(file.budgets, measured);

  if (opts.json) {
    console.log(JSON.stringify({ measured_for: opts.date, budgets: file.budgets, measured, lowered, over, unmeasured }, null, 2));
  } else {
    console.log(`── Quality budgets, measured for ${opts.date} ──`);
    for (const name of QUALITY_BUDGET_NAMES) {
      const was = file.budgets[name];
      const is = measured[name];
      if (typeof is !== "number") {
        console.log(`${name}: budget ${was}, measured only by the suite — this cannot lower it`);
        continue;
      }
      const verdict = is === was ? "at budget" : is < was ? `${was - is} below budget` : `${is - was} OVER BUDGET`;
      console.log(`${name}: budget ${was}, measured ${is} — ${verdict}`);
    }
  }

  if (lowered.length > 0 && opts.lower) {
    writeFileSync(qualityBudgetsPath(), serializeQualityBudgets({ version: file.version, budgets: next }));
    for (const l of lowered) console.log(`Lowered ${l.name} ${l.from} → ${l.to} in ${qualityBudgetsPath()}`);
  } else if (lowered.length > 0) {
    for (const l of lowered) console.log(`Would lower ${l.name} ${l.from} → ${l.to} — pass --lower to write it`);
  }

  for (const o of over) {
    console.log(
      `${o.name} is ${o.measured - o.budget} over its budget of ${o.budget}. A budget does not rise here: ` +
        `clear the entries that put it over, or raise it deliberately in ${qualityBudgetsPath()}.`
    );
  }
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) main();

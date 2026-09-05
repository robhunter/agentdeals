import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  QUALITY_BUDGET_NAMES, aDataRunMayRaise, newestChangeBySlug, pageReviewsPath, parsePageReviews,
  qualityBudgetsPath, readQualityBudgets, serializeQualityBudgets, staleFactPages, unsourcedTierAPaths,
} from "../dist/page-reviews.js";
import { toSlug } from "../dist/vendor-slug.js";
import { uncitedChanges } from "../dist/change-citation.js";
import { passedWithoutQuotingThePage } from "../dist/source-check.js";
import { supersededCensus } from "../dist/superseded-census.js";

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

Three budgets are exceptions, listed in QUALITY_BUDGETS_A_DATA_RUN_MAY_RAISE. They count the
records whose stored terms one of our own change records names as the previous ones, and the
pages that therefore withhold them. A record joins that population when the re-verification run
reads a vendor page and records a narrowing, which is the run doing its job on data it has just
fetched, not a regression in anything we ship. So this raises those three to what the run
measures, in the same commit as the data that moved them. Nothing outside a run of this script
can raise them: a code change that widened the predicate would leave the measurement over the
budget and the suite fails, which is the direction that carries information.

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
  const offers = JSON.parse(readFileSync(join(REPO, "data", "index.json"), "utf-8")).offers ?? [];
  return {
    stale_fact_pages: stale.length,
    unsourced_tier_a: unsourcedTierAPaths(index.pages).length,
    uncited_change_records: uncitedChanges(changes).length,
    source_checks_ok_without_quoted_evidence: offers.filter(passedWithoutQuotingThePage).length,
    ...supersededCensus(offers, changes, date),
  };
}

export function ratchet(budgets, measured) {
  const lowered = [];
  const raised = [];
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
    } else if (is > was && aDataRunMayRaise(name)) {
      next[name] = is;
      raised.push({ name, from: was, to: is });
    } else if (is > was) {
      over.push({ name, budget: was, measured: is });
    }
  }
  return { next, lowered, raised, over, unmeasured };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    process.exit(opts.invalid ? 1 : 0);
  }

  const file = readQualityBudgets();
  const measured = measureBudgets(opts.date);
  const { next, lowered, raised, over, unmeasured } = ratchet(file.budgets, measured);

  if (opts.json) {
    console.log(JSON.stringify({ measured_for: opts.date, budgets: file.budgets, measured, lowered, raised, over, unmeasured }, null, 2));
  } else {
    console.log(`── Quality budgets, measured for ${opts.date} ──`);
    for (const name of QUALITY_BUDGET_NAMES) {
      const was = file.budgets[name];
      const is = measured[name];
      if (typeof is !== "number") {
        console.log(`${name}: budget ${was}, measured only by the suite — this cannot lower it`);
        continue;
      }
      const verdict = is === was
        ? "at budget"
        : is < was
          ? `${was - is} below budget`
          : aDataRunMayRaise(name)
            ? `${is - was} more than the last run recorded`
            : `${is - was} OVER BUDGET`;
      console.log(`${name}: budget ${was}, measured ${is} — ${verdict}`);
    }
  }

  const moved = [...lowered, ...raised];
  if (moved.length > 0 && opts.lower) {
    writeFileSync(qualityBudgetsPath(), serializeQualityBudgets({ version: file.version, budgets: next }));
    for (const l of lowered) console.log(`Lowered ${l.name} ${l.from} → ${l.to} in ${qualityBudgetsPath()}`);
    for (const r of raised) {
      console.log(
        `Recorded ${r.name} ${r.from} → ${r.to} in ${qualityBudgetsPath()}. This run read the pages that ` +
          `moved it, so the count follows the data it fetched rather than holding the commit.`
      );
    }
  } else if (moved.length > 0) {
    for (const l of lowered) console.log(`Would lower ${l.name} ${l.from} → ${l.to} — pass --lower to write it`);
    for (const r of raised) console.log(`Would record ${r.name} ${r.from} → ${r.to} — pass --lower to write it`);
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

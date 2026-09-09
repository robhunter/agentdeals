import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  QUALITY_BUDGET_NAMES, newestChangeBySlug, pageReviewsPath, parsePageReviews, readQualityBudgets,
  staleFactPages, unsourcedTierAPaths,
} from "../dist/page-reviews.js";
import { toSlug } from "../dist/vendor-slug.js";
import { uncitedChangesAgainstBudget } from "../dist/change-reporting.js";
import { passedWithoutRecordingAFinding } from "../dist/source-check.js";
import { faqAnswerCounts, faqAnswersIn, namesADigitButNoFigure } from "../dist/faq-provenance.js";
import { budgetReportBody, measurementsFrom, overBudget } from "../dist/quality-budgets.js";
import { measureBudgets } from "./ratchet-quality-budgets.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const FAQ_PAGES_FLOOR = 25;

const HELP = `Report what each quality budget in data/quality_budgets.json measures today.

A budget is a ceiling on editorial debt — pages nobody has re-read, answers nobody has
classified. Exceeding one says the reading queue is deeper than it was, not that anything we
publish is wrong, so no assertion in the suite holds a commit on one. This is where the number
is read instead.

The three FAQ counts are measured from what a server serves, so this boots one and reads every
registered page. Pass --skip-faq to report the rest without it.

Usage: node scripts/report-quality-budgets.js [options]

  --date <date>      Day to measure, YYYY-MM-DD (default: today, UTC)
  --skip-faq         Do not boot a server; leave the three FAQ counts unmeasured
  --json             Emit the measurement as JSON
  --body <file>      Write the issue body to <file>
  --github-output    Append over=true|false and over_names to $GITHUB_OUTPUT
  --help             This text

Exit status is 0 whenever the measurement was taken, including when a budget is over ceiling.
`;

function parseArgs(argv) {
  const opts = {
    date: new Date().toISOString().slice(0, 10),
    skipFaq: false,
    json: false,
    body: null,
    githubOutput: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    else if (arg === "--skip-faq") opts.skipFaq = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--github-output") opts.githubOutput = true;
    else if (arg === "--body") opts.body = argv[++i];
    else if (arg === "--date") opts.date = argv[++i];
    else {
      console.error(`Unknown argument: ${arg}`);
      return { help: true, invalid: true };
    }
  }
  return opts;
}

function startServer() {
  return new Promise((resolvePort, reject) => {
    const child = spawn("node", [join(REPO, "dist", "serve.js")], {
      cwd: REPO,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost:3000" },
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("the server did not report a port within 30s"));
    }, 30000);
    child.stderr.on("data", buffer => {
      const found = buffer.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (found) {
        clearTimeout(timeout);
        resolvePort({ proc: child, port: Number(found[1]) });
      }
    });
    child.on("error", err => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function measureFaq(pages) {
  const server = await startServer();
  try {
    const answers = [];
    const served = new Set();
    for (const page of pages) {
      const html = await fetch(`http://localhost:${server.port}${page.path}`).then(r => r.text());
      const found = faqAnswersIn(page.path, html);
      if (found.length > 0) served.add(page.path);
      answers.push(...found);
    }
    if (served.size < FAQ_PAGES_FLOOR) {
      throw new Error(
        `only ${served.size} of ${pages.length} registered pages served a structured FAQ, under a floor of ${FAQ_PAGES_FLOOR}. ` +
          `That reads as a server that did not answer rather than as a catalogue with no answers in it, so nothing is reported.`,
      );
    }
    return { counts: faqAnswerCounts(answers), answers };
  } finally {
    server.proc.kill();
  }
}

export async function measureEverything(date, { skipFaq = false } = {}) {
  const index = parsePageReviews(readFileSync(pageReviewsPath(), "utf-8"));
  const changes = JSON.parse(readFileSync(join(REPO, "data", "deal_changes.json"), "utf-8")).changes;
  const offers = JSON.parse(readFileSync(join(REPO, "data", "index.json"), "utf-8")).offers ?? [];
  const newest = newestChangeBySlug(changes, date, toSlug);
  const stale = staleFactPages(index.pages, date, slug => newest.get(slug) ?? null);

  const measured = { ...measureBudgets(date) };
  const cohorts = {
    stale_fact_pages: stale.map(p => `\`${p.path}\` — ${p.facts.length} fact(s) recorded since it was last read`),
    unsourced_tier_a: unsourcedTierAPaths(index.pages).map(path => `\`${path}\``),
    uncited_change_records: uncitedChangesAgainstBudget(changes).map(
      change => `${change.vendor ?? "unnamed vendor"} — ${change.date ?? "undated"}`,
    ),
    source_checks_ok_without_quoted_evidence: offers
      .filter(passedWithoutRecordingAFinding)
      .map(offer => `${offer.vendor ?? "unnamed vendor"}`),
  };

  if (!skipFaq) {
    const faq = await measureFaq(index.pages);
    Object.assign(measured, faq.counts);
    cohorts.faq_answers_with_a_digit_but_no_figure = faq.answers
      .filter(a => namesADigitButNoFigure(a.text))
      .map(a => `\`${a.path}\` — ${a.question}`);
  }

  return { measured, cohorts };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    process.exit(opts.invalid ? 1 : 0);
  }

  const budgets = readQualityBudgets().budgets;
  const { measured, cohorts } = await measureEverything(opts.date, { skipFaq: opts.skipFaq });
  const measurements = measurementsFrom(budgets, measured, cohorts);
  const over = overBudget(measurements);
  const body = budgetReportBody(measurements, {
    measured_for: opts.date,
    run_url: process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY ?? "robhunter/agentdeals"}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined,
    commit: process.env.GITHUB_SHA?.slice(0, 7),
  });

  if (opts.json) {
    console.log(JSON.stringify({ measured_for: opts.date, budgets, measured, over }, null, 2));
  } else {
    console.log(`── Quality budgets, measured for ${opts.date} ──`);
    for (const name of QUALITY_BUDGET_NAMES) {
      const found = measurements.find(m => m.name === name);
      if (!found) {
        console.log(`${name}: ceiling ${budgets[name]}, not measured by this run`);
        continue;
      }
      const verdict =
        found.measured === found.budget
          ? "at ceiling"
          : found.measured < found.budget
            ? `${found.budget - found.measured} under ceiling`
            : `${found.measured - found.budget} OVER CEILING`;
      console.log(`${name}: ceiling ${found.budget}, measured ${found.measured} — ${verdict}`);
    }
  }

  if (opts.body) writeFileSync(opts.body, body);

  if (opts.githubOutput && process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `over=${over.length > 0}\nover_names=${over.map(m => m.name).join(" ")}\n`,
    );
  }
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main().catch(err => {
    console.error(err.message);
    process.exit(2);
  });
}

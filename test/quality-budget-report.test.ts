import { describe, it } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";
import { QUALITY_BUDGET_NAMES, readQualityBudgets, utcToday } from "../src/page-reviews.ts";
import {
  BUDGET_REPORT_MARKER, COHORT_SHOWN, budgetReportBody, measurementsFrom, overBudget,
  type BudgetMeasurement,
} from "../dist/quality-budgets.js";
import { faqAnswerCounts, faqAnswersIn, namesADigitButNoFigure } from "../dist/faq-provenance.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const REPORTER = path.join(REPO, "scripts", "report-quality-budgets.js");
const ANNOUNCER = path.join(REPO, "scripts", "report-quality-budgets.sh");

const AT_CEILING: BudgetMeasurement[] = QUALITY_BUDGET_NAMES.map(name => ({
  name,
  budget: 10,
  measured: 10,
  cohort: [],
}));

function over(name: string, by: number, cohort: string[] = []): BudgetMeasurement[] {
  return AT_CEILING.map(m => (m.name === name ? { ...m, measured: m.budget + by, cohort } : m));
}

describe("#1327 a budget over its ceiling is reported rather than asserted", () => {
  it("names the budget, the measurement and the cohort", () => {
    const body = budgetReportBody(over("stale_fact_pages", 3, ["`/one`", "`/two`"]), { measured_for: "2026-09-09" });
    assert.match(body, /stale_fact_pages/);
    assert.match(body, /\*\*3 over\*\* a ceiling of 10/);
    assert.match(body, /- `\/one`/);
    assert.match(body, /- `\/two`/);
    assert.match(body, /measured on 2026-09-09/);
  });

  it("says so plainly when a budget over ceiling names no entries, rather than printing nothing", () => {
    const body = budgetReportBody(over("faq_answers", 1), { measured_for: "2026-09-09" });
    assert.match(body, /The measurement names no entries\./);
  });

  it("shows a bounded slice of a long cohort and says how many it left out", () => {
    const cohort = Array.from({ length: COHORT_SHOWN + 7 }, (_, i) => `/page-${i}`);
    const body = budgetReportBody(over("stale_fact_pages", 1, cohort), { measured_for: "2026-09-09" });
    assert.match(body, /…and 7 more\./);
    assert.strictEqual(body.split("\n").filter(l => l.startsWith("  - /page-")).length, COHORT_SHOWN);
  });

  it("carries a marker, so the next run edits the issue it opened rather than opening another", () => {
    const body = budgetReportBody(AT_CEILING, { measured_for: "2026-09-09" });
    assert.ok(body.includes(`<!-- ${BUDGET_REPORT_MARKER} -->`), body);
  });

  it("prints every budget and its ceiling whether or not any is over", () => {
    const body = budgetReportBody(AT_CEILING, { measured_for: "2026-09-09" });
    for (const name of QUALITY_BUDGET_NAMES) assert.ok(body.includes(`| \`${name}\` |`), `${name} is missing`);
    assert.match(body, /is at or under its ceiling/);
  });

  it("names the budgets this run could not measure, so a silent gap does not read as a pass", () => {
    const measurements = AT_CEILING.filter(m => !m.name.startsWith("faq_"));
    const body = budgetReportBody(measurements, { measured_for: "2026-09-09" });
    assert.match(body, /Not measured by this run: `faq_answers`, `faq_answers_stating_a_figure`, `faq_answers_with_a_digit_but_no_figure`\./);
  });

  it("leaves the three counts a data run may raise out of the overrun, because a run raises them by doing its job", () => {
    assert.deepStrictEqual(overBudget(over("records_with_superseded_terms", 5)), []);
    assert.deepStrictEqual(overBudget(over("stale_fact_pages", 5)).map(m => m.name), ["stale_fact_pages"]);
  });

  it("drops a budget nothing measured rather than reading it as zero", () => {
    const budgets = Object.fromEntries(QUALITY_BUDGET_NAMES.map(n => [n, 5])) as Record<string, number>;
    const measurements = measurementsFrom(budgets as never, { stale_fact_pages: 9 });
    assert.deepStrictEqual(measurements.map(m => m.name), ["stale_fact_pages"]);
    assert.deepStrictEqual(overBudget(measurements).map(m => m.measured), [9]);
  });
});

describe("#1327 the reporter measures the data the site ships", () => {
  it("reads every budget in the file, and none of them decides its exit status", () => {
    const printed = execFileSync("node", [REPORTER, "--json"], { cwd: REPO, encoding: "utf-8" });
    const report = JSON.parse(printed);
    assert.strictEqual(report.measured_for, utcToday());
    for (const name of QUALITY_BUDGET_NAMES) {
      assert.ok(typeof report.measured[name] === "number", `${name} was not measured`);
      assert.strictEqual(report.budgets[name], readQualityBudgets().budgets[name]);
    }
  });

  it("leaves the three FAQ counts unmeasured when it is told not to boot a server", () => {
    const printed = execFileSync("node", [REPORTER, "--json", "--skip-faq"], { cwd: REPO, encoding: "utf-8" });
    const report = JSON.parse(printed);
    assert.strictEqual(report.measured.faq_answers, undefined);
    assert.ok(typeof report.measured.stale_fact_pages === "number");
  });

  it("refuses to report a zero it got from a server that answered nothing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "budget-report-"));
    try {
      const register = path.join(dir, "page-reviews.json");
      writeFileSync(register, JSON.stringify({
        version: 1,
        pages: Array.from({ length: 40 }, (_, i) => ({
          path: `/a-page-that-does-not-exist-${i}`, published: "2026-04-03", tier: "A",
        })),
      }));
      try {
        execFileSync("node", [REPORTER], {
          cwd: REPO,
          encoding: "utf-8",
          stdio: "pipe",
          env: { ...process.env, AGENTDEALS_PAGE_REVIEWS_PATH: register },
        });
        assert.fail("a register of pages that serve no FAQ was reported as a measurement of zero");
      } catch (err: any) {
        assert.strictEqual(err.status, 2);
        assert.match(err.stderr, /served a structured FAQ, under a floor/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a body an announcer can post", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "budget-report-"));
    try {
      const file = path.join(dir, "body.md");
      execFileSync("node", [REPORTER, "--skip-faq", "--body", file], { cwd: REPO, encoding: "utf-8" });
      const body = readFileSync(file, "utf-8");
      assert.ok(body.includes(`<!-- ${BUDGET_REPORT_MARKER} -->`), body);
      assertPopulationFloor(body.length, 400, "characters of issue body the reporter wrote");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#1327 the three FAQ counts are measured from what a page serves", () => {
  const page = (...answers: string[]) =>
    `<script type="application/ld+json">${JSON.stringify({
      "@type": "FAQPage",
      mainEntity: answers.map((text, i) => ({ "@type": "Question", name: `q${i}`, acceptedAnswer: { "@type": "Answer", text } })),
    })}</script>`;

  it("reads the answers out of a served FAQ block", () => {
    const found = faqAnswersIn("/p", page("Vercel Pro starts at $20/month.", "We index 54 services."));
    assert.deepStrictEqual(found.map(a => a.path), ["/p", "/p"]);
    assert.deepStrictEqual(found.map(a => a.question), ["q0", "q1"]);
  });

  it("reads nothing out of structured data that is not an FAQ, however like one it is shaped", () => {
    const shapedLikeOne = `<script type="application/ld+json">${JSON.stringify({
      "@type": "ItemList",
      mainEntity: [{ "@type": "Question", name: "q", acceptedAnswer: { "@type": "Answer", text: "$20/month." } }],
    })}</script>`;
    assert.deepStrictEqual(faqAnswersIn("/p", shapedLikeOne), []);
    assert.deepStrictEqual(faqAnswersIn("/p", `<script type="application/ld+json">{"@type":"Article"}</script>`), []);
  });

  it("counts a figure, a number the rule does not read as one, and neither", () => {
    const answers = faqAnswersIn(
      "/p",
      page("Vercel Pro starts at $20/month.", "We index 54 services.", "It depends on your stack."),
    );
    assert.deepStrictEqual(faqAnswerCounts(answers), {
      faq_answers: 3,
      faq_answers_stating_a_figure: 1,
      faq_answers_with_a_digit_but_no_figure: 1,
    });
  });

  it("names an answer carrying a digit the figure rule did not claim", () => {
    assert.ok(namesADigitButNoFigure("We index 54 services."));
    assert.ok(!namesADigitButNoFigure("Vercel Pro starts at $20/month."));
    assert.ok(!namesADigitButNoFigure("It depends on your stack."));
  });
});

describe("#1327 the announcer refuses a body it cannot find again", () => {
  function announce(body: string, over: string): { status: number; output: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "budget-announce-"));
    try {
      const file = path.join(dir, "body.md");
      writeFileSync(file, body);
      try {
        const output = execFileSync("bash", [ANNOUNCER, file, over], { cwd: REPO, encoding: "utf-8", stdio: "pipe" });
        return { status: 0, output };
      } catch (err: any) {
        return { status: err.status, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("refuses a body with no marker, because the next run would open a second issue", () => {
    const refused = announce("a budget went over\n", "true");
    assert.strictEqual(refused.status, 2);
    assert.match(refused.output, new RegExp(BUDGET_REPORT_MARKER));
  });

  it("refuses an empty body rather than opening an empty issue", () => {
    assert.strictEqual(announce("", "true").status, 2);
  });

  it("refuses an overrun flag that is neither true nor false", () => {
    const refused = announce(`body\n<!-- ${BUDGET_REPORT_MARKER} -->\n`, "maybe");
    assert.strictEqual(refused.status, 2);
    assert.match(refused.output, /must be true or false/);
  });

  it("looks the issue up by the literal marker rather than by a search over its words", () => {
    const source = readFileSync(ANNOUNCER, "utf-8");
    assert.doesNotMatch(
      source,
      /gh issue list[^\n]*--search/,
      "a marker passed to --search is split into words, so any open issue holding them silences this"
    );
    assert.match(source, /--jq[^\n]*contains\(/);
  });
});

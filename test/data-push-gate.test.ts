import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  driftedGuardOf, gateVerdict, parseFailures, parseDataGatingTests, readDataGatingTests,
  type TestFailure,
} from "../src/data-push-gate.ts";
import { qualityBudgetsPath } from "../src/page-reviews.ts";
import { VENDOR_KEYED_DATA } from "../src/data-push-holdback.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const WORKFLOWS = join(REPO, ".github", "workflows");
const GATE = join(REPO, "scripts", "gate-data-push.sh");


interface WorkflowStep {
  name: string;
  body: string;
}

function stepsOf(text: string): WorkflowStep[] {
  const out: WorkflowStep[] = [];
  for (const line of text.split("\n")) {
    const start = line.match(/^ {6}- (?:name|uses):\s*(.+)$/);
    if (start) out.push({ name: start[1]!.trim(), body: `${line}\n` });
    else if (out.length > 0) out[out.length - 1]!.body += `${line}\n`;
  }
  return out;
}

function gateStepOf(file: string): WorkflowStep {
  const step = stepsOf(source(file)).find((s) => /gate-data-push\.sh/.test(s.body));
  assert.ok(step, `${file} has no step that invokes the gate`);
  return step;
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort();
}

function source(file: string): string {
  return readFileSync(join(WORKFLOWS, file), "utf8");
}

const GATED_WORKFLOWS = workflowFiles().filter((f) => /bash scripts\/gate-data-push\.sh/.test(source(f)));

function nodeVersionsOf(text: string): string[] {
  return [...text.matchAll(/node-version:\s*"?([0-9][0-9.]*)"?/g)].map((m) => m[1]!);
}

function quarantineBranchOf(text: string): string | null {
  return text.match(/gate-data-push\.sh\s*\\?\s*\n?\s*([A-Za-z0-9/_.-]+)/)?.[1] ?? null;
}

describe("#1317 the suite sees every commit that reaches main", () => {
  it("reads the workflows, so the assertions below have subjects", () => {
    const files = workflowFiles();
    assert.ok(files.length >= 6, `this test needs the workflows to check, found ${files.length}`);
    assert.ok(
      GATED_WORKFLOWS.length >= 5,
      `every workflow that reaches main goes through the gate, so this list is read from the workflows themselves — it found ${GATED_WORKFLOWS.length}`,
    );
    for (const file of GATED_WORKFLOWS) {
      assert.ok(files.includes(file), `${file} is not among ${files.join(", ")}`);
    }
  });

  it("measures the review register again in the job that rewrites the stores its figures come from", () => {
    const syncing = GATED_WORKFLOWS.filter((f) => /GATE_SYNC_PAGE_REVIEWS:\s*"1"/.test(source(f)));
    assert.ok(
      syncing.length > 0,
      "no scheduled job measures the review register again, so every provenance byline states a figure count nobody has checked since a person last ran the script by hand",
    );
    const rewritesTheChangeLog = GATED_WORKFLOWS.filter((f) => /data\/deal_changes\.json/.test(gateStepOf(f).body));
    assert.deepStrictEqual(
      syncing,
      rewritesTheChangeLog,
      "the counts move when a change record with a quantity in it lands, so the job that lands one is the job that measures them again",
    );
    for (const file of syncing) {
      assert.match(
        gateStepOf(file).body,
        /data\/page-reviews\.json/,
        `${file} measures the register again and may not commit it, so what it measured is left in the workspace and main goes red on it`,
      );
    }
  });

  it("pushes to main from one place only, and that place runs the suite first", () => {
    const offenders: string[] = [];
    for (const file of workflowFiles()) {
      for (const line of source(file).split("\n")) {
        if (/git\s+push/.test(line) && /\bmain\b/.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    assert.deepStrictEqual(
      offenders,
      [],
      `a workflow pushes to main without the gate, so its commit reaches main untested: ${offenders.join("; ")}`,
    );

    const gate = readFileSync(GATE, "utf8");
    const pushes = gate.split("\n").filter((l) => /git push/.test(l) && /\bmain\b/.test(l));
    assert.strictEqual(pushes.length, 1, `the gate should hold exactly one push to main, holds ${pushes.length}`);
    assert.match(gate, /npm run test:gated/, "the gate does not run the suite");
  });

  it("runs the same test files under the gate as tests.yml runs on main", () => {
    const scripts = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).scripts;
    const stripReporters = (cmd: string) =>
      cmd.replace(/--test-reporter(-destination)?=\S+\s*/g, "").replace(/\s+/g, " ").trim();
    assert.strictEqual(
      stripReporters(scripts["test:gated"]),
      stripReporters(scripts.test),
      "the gate's suite and the suite main runs differ by more than which reporters they load",
    );
    assert.match(
      scripts["test:gated"],
      /--test-reporter=\.\/scripts\/reporters\/failing-tests\.js/,
      "the gate's suite does not record which tests failed, so it cannot tell what held the commit",
    );
  });

  it("holds the refused data on a ref of its own each time, so yesterday's is still there tomorrow", () => {
    const gate = readFileSync(GATE, "utf8");
    assert.doesNotMatch(gate, /git push --force/, "a forced push to a fixed ref overwrites the last refusal");
    assert.match(gate, /date -u \+/, "the quarantine ref carries no timestamp, so two refusals collide");
  });

  it("says what the gate did somewhere a person will see without opening the run", () => {
    for (const file of GATED_WORKFLOWS) {
      const text = source(file);
      assert.match(
        text,
        /bash scripts\/report-data-push-outcome\.sh "[^"]+" refused/,
        `${file} refuses a commit without saying so anywhere but its own log`,
      );
      assert.match(
        text,
        /bash scripts\/report-data-push-outcome\.sh "[^"]+" shipped-over-failures/,
        `${file} can leave main red and say so nowhere — a scheduled push carries no tests run behind it`,
      );
      assert.match(
        text,
        /steps\.gate\.outputs\.quarantined == 'true' \|\| steps\.gate\.outputs\.pushed_over_failures == 'true'/,
        `${file} does not report on both of the outcomes the gate can reach`,
      );
      assert.match(
        text,
        /bash scripts\/report-data-push-outcome\.sh "[^"]+" drifted-a-guard/,
        `${file} ships data over a guard that has drifted and says so nowhere`,
      );
      assert.match(
        text,
        /steps\.gate\.outputs\.drifted_guards != ''/,
        `${file} reports nothing on a run whose only red assertion was a drifted guard`,
      );
      assert.match(text, /issues: write/, `${file} cannot open the issue it is told to open`);
    }
  });

  it("gives every outcome a marker of its own, so none of them buries another", () => {
    const reporter = readFileSync(join(REPO, "scripts", "report-data-push-outcome.sh"), "utf8");
    const markers = [...reporter.matchAll(/^\s*MARKER="([a-z-]+)"$/gm)].map((m) => m[1]!);
    assert.deepStrictEqual(markers, [
      "data-push-refused",
      "data-push-over-failures",
      "data-push-vendorholdback",
      "data-push-drifted-guard",
    ]);
    for (const marker of markers) {
      const others = markers.filter((m) => m !== marker);
      const words = new Set(marker.split("-"));
      for (const other of others) {
        assert.ok(
          !other.split("-").every((word) => words.has(word)),
          `an open ${marker} issue would answer a search for ${other}, because every word of ${other} is a word of ${marker}`,
        );
      }
    }
  });

  it("says on an issue when the gate reached main by holding a vendor back, wherever that can happen", () => {
    for (const file of GATED_WORKFLOWS) {
      const text = source(file);
      const committable = gateStepOf(file).body;
      const carriesVendorRows = VENDOR_KEYED_DATA.some((f) => committable.includes(f.path));
      assert.strictEqual(
        /report-data-push-outcome\.sh "[^"]+" held-back-a-vendor/.test(text),
        carriesVendorRows,
        carriesVendorRows
          ? `${file} commits a file a vendor's rows live in and can hold one back without saying so`
          : `${file} reports a holdback it can never make`,
      );
      if (!carriesVendorRows) continue;
      assert.match(
        text,
        /steps\.gate\.outputs\.held_back_vendors != ''/,
        `${file} reports a holdback in a step that a holdback alone does not reach`,
      );
    }
  });

  it("routes every scheduled data writer through the gate, each with its own quarantine branch", () => {
    const branches = new Map<string, string>();
    for (const file of GATED_WORKFLOWS) {
      const text = source(file);
      assert.match(text, /bash scripts\/gate-data-push\.sh/, `${file} does not invoke the gate`);
      const branch = quarantineBranchOf(text);
      assert.ok(branch?.startsWith("data-quarantine/"), `${file} names no quarantine branch, got ${branch}`);
      assert.ok(!branches.has(branch!), `${file} shares the quarantine branch ${branch} with ${branches.get(branch!)}`);
      branches.set(branch!, file);
    }
    assert.strictEqual(branches.size, GATED_WORKFLOWS.length);
  });

  it("runs the gate on the Node the suite is pinned to, so the suite can load its own test files", () => {
    const pinned = nodeVersionsOf(source("tests.yml"));
    assert.strictEqual(pinned.length, 1, `tests.yml should pin one Node version, pins ${pinned.join(", ")}`);
    for (const file of GATED_WORKFLOWS) {
      assert.deepStrictEqual(
        nodeVersionsOf(source(file)),
        pinned,
        `${file} runs the suite on a different Node than tests.yml pins (${pinned[0]})`,
      );
    }
  });
});

const A_GUARD_THAT_DRIFTED = {
  site: "test/a-guard-that-measures-what-this-run-shrinks.test.ts:12",
  subject: "vendors have the refused read as the only reason we withhold",
  stated: "a floor of 80",
  measured: "102",
  clearsAt: "76",
};

const FAILING_BY_MODE: Record<string, Array<{ file: string; drifted?: typeof A_GUARD_THAT_DRIFTED }>> = {
  green: [],
  red: [{ file: "test/the-data-this-run-wrote-is-wrong.test.ts" }],
  excused: [{ file: "test/how-current-our-reading-is.test.ts" }],
  mixed: [
    { file: "test/how-current-our-reading-is.test.ts" },
    { file: "test/the-data-this-run-wrote-is-wrong.test.ts" },
  ],
  drifted: [{ file: "test/a-guard-that-measures-what-this-run-shrinks.test.ts", drifted: A_GUARD_THAT_DRIFTED }],
  "drifted-and-wrong": [
    { file: "test/a-guard-that-measures-what-this-run-shrinks.test.ts", drifted: A_GUARD_THAT_DRIFTED },
    { file: "test/the-data-this-run-wrote-is-wrong.test.ts" },
  ],
  "drifted-in-a-gating-file": [
    { file: "test/the-data-this-run-wrote-is-wrong.test.ts", drifted: A_GUARD_THAT_DRIFTED },
  ],
  "drifted-in-a-file-that-also-broke": [
    { file: "test/the-data-this-run-wrote-is-wrong.test.ts", drifted: A_GUARD_THAT_DRIFTED },
    { file: "test/the-data-this-run-wrote-is-wrong.test.ts" },
  ],
  crashed: [],
  vendor: [],
  "vendor-one-at-a-time": [],
  "budget-against-the-tree": [],
};

const GATE_CONFIGURATION = ["GATE_RATCHET_BUDGETS", "GATE_UPDATE_PAGE_LASTMOD", "GATE_REGENERATE_LLM_INDEX", "GATE_SYNC_PAGE_REVIEWS"];

const PAGES_THE_TREE_HOLDS = `readdirSync("data").filter((f) => f.endsWith(".json")).length`;

const SUITE = `import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
const modes = ${JSON.stringify(FAILING_BY_MODE)};
const mode = process.env.GATE_FIXTURE_TESTS || "green";
let failing = modes[mode];
let blamed = [];
let budgetDisagreement = "";
if (mode === "budget-against-the-tree") {
  const recorded = JSON.parse(readFileSync("data/quality_budgets.json", "utf8")).budgets.fixture_pages;
  const measured = ${PAGES_THE_TREE_HOLDS};
  if (measured !== recorded) {
    budgetDisagreement = measured + " pages, over the " + recorded + " recorded";
    failing = [{ file: "test/the-data-this-run-wrote-is-wrong.test.ts" }];
  }
}
if (mode.startsWith("vendor")) {
  const rows = JSON.parse(readFileSync("data/deal_changes.json", "utf8")).changes;
  blamed = rows.filter((r) => r.reading === "wrong").map((r) => r.vendor);
  if (mode === "vendor-one-at-a-time") blamed = blamed.slice(0, 1);
  failing = blamed.length > 0 ? [{ file: "test/the-data-this-run-wrote-is-wrong.test.ts" }] : [];
}
const red = mode === "crashed" || failing.length > 0;
writeFileSync(
  process.env.GATE_FAILING_TESTS,
  failing.map((f) => JSON.stringify({ file: f.file, name: "the fixture assertion", ...(f.drifted ? { drifted: f.drifted } : {}) }) + "\\n").join(""),
);
writeFileSync(
  process.env.GATE_FIXTURE_ENV_REPORT,
  ${JSON.stringify(GATE_CONFIGURATION)}.filter((name) => process.env[name]).join(","),
);
appendFileSync(process.env.GITHUB_OUTPUT, "a_test_spawned_a_script_that_wrote_this=yes\\n");
console.log("\\u2139 tests 2");
console.log("\\u2139 pass " + (red ? 1 : 2));
console.log("\\u2139 fail " + (red ? 1 : 0));
if (red) {
  console.log("\\u2716 failing tests:");
  for (const f of failing) console.log("the fixture assertion in " + f.file);
  if (budgetDisagreement) console.log("  the tree holds " + budgetDisagreement);
  for (const v of blamed) console.log("  the reading this run wrote for " + v + " is wrong");
  if (mode === "crashed") console.log("the suite died before it named a file");
  process.exit(1);
}
`;

const BUILD = `if (process.env.GATE_FIXTURE_BUILD === "fail") {
  console.log("the fixture build does not compile");
  process.exit(1);
}
`;

const BUDGETS_BEFORE = `${JSON.stringify({ version: 1, budgets: { fixture_pages: 57 } }, null, 2)}\n`;
const BUDGETS_AFTER = `${JSON.stringify({ version: 1, budgets: { fixture_pages: 56 } }, null, 2)}\n`;

const RATCHET = `import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const mode = process.env.GATE_FIXTURE_RATCHET || "lower";
if (mode === "throw") {
  console.log("the fixture ratchet could not read the data it measures");
  process.exit(1);
}
if (mode === "lower") {
  writeFileSync("data/quality_budgets.json", ${JSON.stringify(BUDGETS_AFTER)});
  console.log("Lowered fixture_pages 57 -> 56");
}
if (mode === "lowers-only-what-is-earned") {
  if (readFileSync("data/quality_budgets.json", "utf8") === ${JSON.stringify(BUDGETS_BEFORE)}) {
    writeFileSync("data/quality_budgets.json", ${JSON.stringify(BUDGETS_AFTER)});
    console.log("Lowered fixture_pages 57 -> 56");
  } else {
    console.log("No budget this run's data earned is lower than the one already recorded");
  }
}
if (mode === "measures-the-tree") {
  const pages = ${PAGES_THE_TREE_HOLDS};
  writeFileSync(
    "data/quality_budgets.json",
    JSON.stringify({ version: 1, budgets: { fixture_pages: pages } }, null, 2) + "\\n",
  );
  console.log("Recorded fixture_pages " + pages);
}
`;

const GATING_TESTS = JSON.stringify(
  {
    version: 1,
    rule: "the fixture stands in for the shipped list, so the behaviour under test does not move when that list does",
    tests: [
      {
        file: "test/the-data-this-run-wrote-is-wrong.test.ts",
        reason: "everything it fires on names a record this run wrote and says that record is wrong",
      },
    ],
  },
  null,
  2,
);

const PACKAGE = JSON.stringify(
  {
    name: "gate-fixture",
    version: "1.0.0",
    private: true,
    type: "module",
    scripts: {
      build: "node build.js",
      "test:gated": "node suite.js",
      "ratchet:budgets": "node ratchet.js",
    },
  },
  null,
  2,
);

interface FixtureChange {
  vendor: string;
  summary: string;
  reading?: string;
}

function changesFile(changes: FixtureChange[]): string {
  return `${JSON.stringify({ changes }, null, 2)}\n`;
}

const AS_MAIN_HAS_IT = "the reading main already carries";

const CHANGES_ON_MAIN = changesFile([
  { vendor: "Steadyvendor", summary: AS_MAIN_HAS_IT },
  { vendor: "Blamedvendor", summary: AS_MAIN_HAS_IT },
  { vendor: "Secondblamedvendor", summary: AS_MAIN_HAS_IT },
]);

function changesOn(origin: string, ref: string): FixtureChange[] {
  return JSON.parse(git(origin, "show", `${ref}:data/deal_changes.json`)).changes;
}

let scratch: string;

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.strictEqual(run.status, 0, `git ${args.join(" ")} -> ${run.status}: ${run.stderr}`);
  return run.stdout.trim();
}

const LEDGER_ON_MAIN = `${JSON.stringify({ version: 1, generated: "2026-01-01", pages: {} }, null, 2)}\n`;

const INDEX_ON_MAIN = `${JSON.stringify({ offers: [{ vendor: "Steadyvendor", tier: AS_MAIN_HAS_IT }] }, null, 2)}\n`;

function fixtureRepo(options: { shallow?: boolean; pageReviews?: boolean; index?: boolean } = {}): { work: string; origin: string } {
  const root = mkdtempSync(join(scratch, "repo-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  spawnSync("git", ["init", "--bare", "--initial-branch=main", origin], { encoding: "utf8" });
  git(root, "clone", origin, work);
  git(work, "config", "user.email", "fixture@example.com");
  git(work, "config", "user.name", "fixture");
  mkdirSync(join(work, "data"), { recursive: true });
  writeFileSync(join(work, "package.json"), PACKAGE);
  writeFileSync(join(work, "suite.js"), SUITE);
  writeFileSync(join(work, "build.js"), BUILD);
  writeFileSync(join(work, "ratchet.js"), RATCHET);
  writeFileSync(join(work, "gating-tests.json"), GATING_TESTS);
  writeFileSync(join(work, "data", "health.json"), '{"checked":1}\n');
  writeFileSync(join(work, "data", "deal_changes.json"), CHANGES_ON_MAIN);
  writeFileSync(join(work, "data", "quality_budgets.json"), BUDGETS_BEFORE);
  writeFileSync(join(work, "data", "page-lastmod.json"), LEDGER_ON_MAIN);
  if (options.index) {
    writeFileSync(join(work, "data", "index.json"), INDEX_ON_MAIN);
  }
  if (options.pageReviews) {
    writeFileSync(join(work, "data", "page-reviews.json"), readFileSync(join(REPO, "data", "page-reviews.json"), "utf8"));
  }
  mkdirSync(join(work, "artifacts", "free-llm-api-index"), { recursive: true });
  writeFileSync(join(work, "artifacts", "free-llm-api-index", "README.md"), "# the index this run has not regenerated yet\n");
  writeFileSync(join(work, "untracked-by-the-gate.txt"), "before\n");
  git(work, "add", "-A");
  git(work, "commit", "-m", "fixture");
  git(work, "push", "origin", "HEAD:main");
  if (options.shallow) {
    rmSync(work, { recursive: true, force: true });
    git(root, "clone", "--depth", "1", `file://${origin}`, work);
    git(work, "config", "user.email", "fixture@example.com");
    git(work, "config", "user.name", "fixture");
    assert.strictEqual(
      git(work, "rev-parse", "--is-shallow-repository"),
      "true",
      "the checkout this test needs to be shallow is not",
    );
  }
  return { work, origin };
}

type GateMode = keyof typeof FAILING_BY_MODE;

type RatchetMode = "lower" | "throw" | "measures-the-tree" | "lowers-only-what-is-earned";

interface GateRun {
  mode: GateMode;
  driftTo?: string;
  build?: "fail";
  ratchet?: RatchetMode;
  lastmod?: true;
  llmIndex?: true;
  pageReviews?: true;
  replays?: number;
  asking?: "answers" | "refuses";
}

const ASKED_FOR = "what-the-gate-asked-for.txt";

function aClientTheGateCanAsk(work: string, behaviour: "answers" | "refuses"): string {
  const bin = join(work, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>${JSON.stringify(join(work, ASKED_FOR))}\nexit ${behaviour === "answers" ? 0 : 1}\n`,
    { mode: 0o755 },
  );
  return bin;
}

function whatTheGateAskedFor(work: string): string[] {
  const log = join(work, ASKED_FOR);
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
}

function runGate(work: string, mode: GateMode | GateRun, ...args: string[]) {
  const opts: GateRun = typeof mode === "string" ? { mode } : mode;
  const outputs = join(work, "step-outputs.txt");
  const envReport = join(work, "the-environment-the-suite-ran-in.txt");
  const onPath = `${aClientTheGateCanAsk(work, opts.asking ?? "refuses")}:${process.env.PATH}`;
  const run = spawnSync("bash", [GATE, ...args], {
    cwd: work,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: onPath,
      GATE_FIXTURE_TESTS: opts.mode,
      GATE_FIXTURE_BUILD: opts.build ?? "ok",
      GATE_FIXTURE_RATCHET: opts.ratchet ?? "lower",
      GATE_FIXTURE_ENV_REPORT: envReport,
      GATE_RATCHET_BUDGETS: opts.ratchet === undefined ? "" : "1",
      GATE_UPDATE_PAGE_LASTMOD: opts.lastmod ? "1" : "",
      GATE_REGENERATE_LLM_INDEX: opts.llmIndex ? "1" : "",
      GATE_SYNC_PAGE_REVIEWS: opts.pageReviews ? "1" : "",
      GATE_REPLAYS_ONTO_A_MOVED_MAIN: opts.replays === undefined ? "" : String(opts.replays),
      GATE_DRIFTED_GUARDS: opts.driftTo ?? join(work, "drifted-guards.md"),
      GITHUB_OUTPUT: outputs,
      AGENTDEALS_DATA_GATING_TESTS_PATH: join(work, "gating-tests.json"),
      AGENTDEALS_PAGE_LASTMOD_PATH: join(work, "data", "page-lastmod.json"),
      AGENTDEALS_LLM_INDEX_PATH: join(work, "artifacts", "free-llm-api-index", "README.md"),
      AGENTDEALS_PAGE_REVIEWS_PATH: join(work, "data", "page-reviews.json"),
    },
  });
  return {
    ...run,
    outputs: existsSync(outputs) ? readFileSync(outputs, "utf8") : "",
    suiteSawGateConfig: existsSync(envReport) ? readFileSync(envReport, "utf8") : null,
  };
}

function mainSha(origin: string): string {
  return git(origin, "rev-parse", "main");
}

function quarantineRefs(origin: string, prefix: string): string[] {
  return git(origin, "for-each-ref", "--format=%(refname:short)", `refs/heads/${prefix}*`)
    .split("\n")
    .filter((r) => r.length > 0)
    .sort();
}

function commitToMainFromElsewhere(origin: string, file: string, contents: string): void {
  const elsewhere = mkdtempSync(join(scratch, "sibling-"));
  git(elsewhere, "clone", origin, ".");
  git(elsewhere, "config", "user.email", "sibling@example.com");
  git(elsewhere, "config", "user.name", "sibling");
  mkdirSync(dirname(join(elsewhere, file)), { recursive: true });
  writeFileSync(join(elsewhere, file), contents);
  git(elsewhere, "add", "-A");
  git(elsewhere, "commit", "-m", "data(auto): a sibling scheduled job");
  git(elsewhere, "push", "origin", "HEAD:main");
}

function suiteRuns(stdout: string): number {
  return stdout.split("\n").filter((line) => /tests 2$/.test(line)).length;
}


describe("#1317 the gate, run against a repository", () => {
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "gate-data-push-"));
  });

  after(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  it("stops a data change the suite refuses, and holds it on a quarantine ref", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);
    writeFileSync(join(work, "data", "health.json"), '{"checked":2}\n');

    const run = runGate(work, "red", "data-quarantine/fixture", "data(auto): fixture", "data/health.json");

    assert.strictEqual(run.status, 1, `the gate let a red suite through: ${run.stdout}${run.stderr}`);
    assert.strictEqual(mainSha(origin), before, "main moved on a commit the suite refused");
    const refs = quarantineRefs(origin, "data-quarantine/fixture");
    assert.strictEqual(refs.length, 1, `the refused commit was not held anywhere: ${refs.join(", ")}`);
    assert.strictEqual(
      git(origin, "show", `${refs[0]}:data/health.json`),
      '{"checked":2}',
      "the quarantine ref does not carry the data the run produced",
    );
    assert.match(run.stdout, /the-data-this-run-wrote-is-wrong/, "the failing test is not named in the log");
    assert.match(run.stdout, /main is unchanged/);
    assert.match(run.outputs, /quarantined=true/);
    assert.match(run.outputs, new RegExp(`quarantine_ref=${refs[0]}`));
  });

  it("pushes a data change the suite accepts", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);
    writeFileSync(join(work, "data", "health.json"), '{"checked":3}\n');

    const run = runGate(work, "green", "data-quarantine/fixture", "data(auto): fixture", "data/health.json");

    assert.strictEqual(run.status, 0, `the gate refused a green suite: ${run.stdout}${run.stderr}`);
    assert.notStrictEqual(mainSha(origin), before);
    assert.strictEqual(git(origin, "show", "main:data/health.json"), '{"checked":3}');
    assert.strictEqual(git(origin, "log", "-1", "--format=%s", "main"), "data(auto): fixture");
    assert.deepStrictEqual(quarantineRefs(origin, "data-quarantine/fixture"), [], "a green run quarantined something");
    assert.match(
      run.outputs,
      /pushed_commit=[0-9a-f]{7}/,
      "the push names no commit, so an alarm this job opened yesterday has nothing to close on",
    );
  });

  it("commits nothing when the run produced no data change, and leaves the suite unrun", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);

    const run = runGate(work, "red", "data-quarantine/fixture", "data(auto): fixture", "data/health.json");

    assert.strictEqual(run.status, 0, run.stdout + run.stderr);
    assert.strictEqual(mainSha(origin), before);
    assert.match(run.stdout, /nothing to commit or push/);
    assert.doesNotMatch(run.stdout, /tests 2/, "the gate ran the suite with nothing to push");
    assert.match(
      run.outputs,
      /pushed_nothing=true/,
      "a run that held nothing back looks the same from outside as one that was refused",
    );
  });

  it("commits only the paths it was given, so an unrelated file cannot ride along", () => {
    const { work, origin } = fixtureRepo();
    writeFileSync(join(work, "data", "health.json"), '{"checked":4}\n');
    writeFileSync(join(work, "untracked-by-the-gate.txt"), "after\n");

    const run = runGate(work, "green", "data-quarantine/fixture", "data(auto): fixture", "data/health.json");

    assert.strictEqual(run.status, 0, run.stdout + run.stderr);
    assert.strictEqual(git(origin, "show", "main:untracked-by-the-gate.txt"), "before");
    assert.strictEqual(git(work, "diff", "--name-only"), "untracked-by-the-gate.txt");
  });

  it("refuses to run without a quarantine branch, a message and a path", () => {
    const { work } = fixtureRepo();
    const run = runGate(work, "green", "data-quarantine/fixture", "data(auto): fixture");
    assert.strictEqual(run.status, 2);
    assert.match(run.stderr, /usage: gate-data-push\.sh/);
  });
});

describe("#1337 one refused reading costs one vendor, not the batch it arrived in", () => {
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "gate-holdback-"));
  });

  after(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  it("puts the rest of the run on main and leaves the blamed vendor as main already had it", () => {
    const { work, origin } = fixtureRepo();
    writeFileSync(
      join(work, "data", "deal_changes.json"),
      changesFile([
        { vendor: "Steadyvendor", summary: "a reading this run stands behind" },
        { vendor: "Blamedvendor", summary: "a reading the suite refuses", reading: "wrong" },
        { vendor: "Secondblamedvendor", summary: "another reading this run stands behind" },
      ]),
    );

    const run = runGate(work, "vendor", "data-quarantine/fixture", "data(auto): fixture", "data/deal_changes.json");

    assert.strictEqual(run.status, 0, `the gate refused the whole batch: ${run.stdout}${run.stderr}`);
    assert.deepStrictEqual(changesOn(origin, "main"), [
      { vendor: "Steadyvendor", summary: "a reading this run stands behind" },
      { vendor: "Blamedvendor", summary: AS_MAIN_HAS_IT },
      { vendor: "Secondblamedvendor", summary: "another reading this run stands behind" },
    ]);
    assert.deepStrictEqual(quarantineRefs(origin, "data-quarantine/fixture"), [], "a run that reached main quarantined something too");
    assert.match(run.outputs, /held_back_vendors=Blamedvendor/);
    assert.match(run.stdout, /Held back and left for the next run to read again: Blamedvendor/);
    assert.strictEqual(suiteRuns(run.stdout), 2, "what reached main was not read by the suite after the holdback");
  });

  it("refuses the batch when every vendor it moved is blamed, so nothing is left to push", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);
    writeFileSync(
      join(work, "data", "deal_changes.json"),
      changesFile([
        { vendor: "Steadyvendor", summary: AS_MAIN_HAS_IT },
        { vendor: "Blamedvendor", summary: "a reading the suite refuses", reading: "wrong" },
        { vendor: "Secondblamedvendor", summary: AS_MAIN_HAS_IT },
      ]),
    );

    const run = runGate(work, "vendor", "data-quarantine/fixture", "data(auto): fixture", "data/deal_changes.json");

    assert.strictEqual(run.status, 1, `the gate pushed a batch with nothing left in it: ${run.stdout}`);
    assert.strictEqual(mainSha(origin), before, "main moved on a batch that was entirely refused");
    assert.match(run.stdout, /holding them back would leave nothing to push/);
    assert.strictEqual(suiteRuns(run.stdout), 1, "the suite was run again on a batch nothing had been taken out of");
    assert.strictEqual(quarantineRefs(origin, "data-quarantine/fixture").length, 1);
  });

  it("refuses the batch when the failing test names no vendor this run moved", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);
    writeFileSync(
      join(work, "data", "deal_changes.json"),
      changesFile([
        { vendor: "Steadyvendor", summary: "a reading this run stands behind" },
        { vendor: "Blamedvendor", summary: AS_MAIN_HAS_IT },
        { vendor: "Secondblamedvendor", summary: AS_MAIN_HAS_IT },
      ]),
    );

    const run = runGate(work, "red", "data-quarantine/fixture", "data(auto): fixture", "data/deal_changes.json");

    assert.strictEqual(run.status, 1, `the gate pushed data it could not attribute a refusal to: ${run.stdout}`);
    assert.strictEqual(mainSha(origin), before);
    assert.match(run.stdout, /nothing to attribute the refusal to/);
    assert.strictEqual(suiteRuns(run.stdout), 1, "the suite was run again on a batch nothing had been taken out of");
  });

  it("holds one set of vendors back and no more, and quarantines the batch as the run wrote it", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);
    const asTheRunWroteIt: FixtureChange[] = [
      { vendor: "Steadyvendor", summary: "a reading this run stands behind" },
      { vendor: "Blamedvendor", summary: "a reading the suite refuses", reading: "wrong" },
      { vendor: "Secondblamedvendor", summary: "a second reading the suite refuses", reading: "wrong" },
    ];
    writeFileSync(join(work, "data", "deal_changes.json"), changesFile(asTheRunWroteIt));

    const run = runGate(work, "vendor-one-at-a-time", "data-quarantine/fixture", "data(auto): fixture", "data/deal_changes.json");

    assert.strictEqual(run.status, 1, `the gate pushed a batch the suite never passed: ${run.stdout}`);
    assert.strictEqual(mainSha(origin), before);
    assert.strictEqual(suiteRuns(run.stdout), 2, "the gate held back more than one set of vendors");
    assert.match(run.stdout, /the batch stands or falls as one/);
    const refs = quarantineRefs(origin, "data-quarantine/fixture");
    assert.strictEqual(refs.length, 1);
    assert.deepStrictEqual(
      changesOn(origin, refs[0]!),
      asTheRunWroteIt,
      "the quarantine ref carries the reduced batch rather than the one the run wrote",
    );
  });

  it("holds nothing back for a run whose committable paths carry no vendor's rows", () => {
    const { work, origin } = fixtureRepo();
    writeFileSync(join(work, "data", "health.json"), '{"checked":9}\n');

    const run = runGate(work, "red", "data-quarantine/fixture", "data(auto): fixture", "data/health.json");

    assert.strictEqual(run.status, 1);
    assert.match(run.stdout, /None of the files a vendor's rows live in is among the paths this run may commit/);
    assert.strictEqual(suiteRuns(run.stdout), 1);
    assert.strictEqual(quarantineRefs(origin, "data-quarantine/fixture").length, 1);
  });
});

describe("#1321 a measurement of our own reading does not stop the catalogue advancing", () => {
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "gate-split-"));
  });

  after(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  it("puts the data on main when no red test is one that gates the data", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);
    writeFileSync(join(work, "data", "health.json"), '{"checked":5}\n');

    const run = runGate(work, "excused", "data-quarantine/fixture", "data(auto): fixture", "data/health.json");

    assert.strictEqual(run.status, 0, `the gate held the data back: ${run.stdout}${run.stderr}`);
    assert.notStrictEqual(mainSha(origin), before, "the data did not reach main");
    assert.strictEqual(git(origin, "show", "main:data/health.json"), '{"checked":5}');
    assert.deepStrictEqual(quarantineRefs(origin, "data-quarantine/fixture"), []);
    assert.match(run.stdout, /how-current-our-reading-is/, "the failure that did not hold the commit is not named");
    assert.match(run.stdout, /Nothing that went red says this data is wrong/);
    assert.match(run.outputs, /pushed_over_failures=true/);
  });

  it("still holds the data back when a test says the data itself is wrong", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);
    writeFileSync(join(work, "data", "health.json"), '{"checked":6}\n');

    const run = runGate(work, "red", "data-quarantine/fixture", "data(auto): fixture", "data/health.json");

    assert.strictEqual(run.status, 1, "a data-validity failure no longer holds the commit");
    assert.strictEqual(mainSha(origin), before);
    assert.match(run.stdout, /hold the commit/);
  });

  it("holds the data back when a failure in a file that gates arrives beside one in a file that does not", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);
    writeFileSync(join(work, "data", "health.json"), '{"checked":7}\n');

    const run = runGate(work, "mixed", "data-quarantine/fixture", "data(auto): fixture", "data/health.json");

    assert.strictEqual(run.status, 1, "an excused failure carried a real one onto main with it");
    assert.strictEqual(mainSha(origin), before);
    assert.match(run.stdout, /the-data-this-run-wrote-is-wrong/);
  });

  it("puts the data on main when the only red assertion says a guard has drifted into its own headroom", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);
    const drift = join(work, "drifted-guards.md");
    writeFileSync(join(work, "data", "health.json"), '{"checked":11}\n');

    const run = runGate(work, { mode: "drifted", driftTo: drift }, "data-quarantine/fixture", "data(auto): fixture", "data/health.json");

    assert.strictEqual(run.status, 0, `a drifted guard held the data back: ${run.stdout}${run.stderr}`);
    assert.notStrictEqual(mainSha(origin), before, "the data did not reach main");
    assert.strictEqual(git(origin, "show", "main:data/health.json"), '{"checked":11}');
    assert.deepStrictEqual(quarantineRefs(origin, "data-quarantine/fixture"), []);
    assert.match(run.stdout, /name no record and no vendor/, "the gate does not say why the drift did not hold the commit");
    assert.match(run.outputs, /drifted_guards=1/);
    assert.match(run.outputs, new RegExp(`drifted_guards_body=${drift}`));
    assert.match(readFileSync(drift, "utf8"), /a floor of 80 \| 102 \| 76/, "the table the issue would carry names no figures");
  });

  it("still holds the data back when a drifted guard arrives beside a test that says the data is wrong", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);
    writeFileSync(join(work, "data", "health.json"), '{"checked":12}\n');

    const run = runGate(work, "drifted-and-wrong", "data-quarantine/fixture", "data(auto): fixture", "data/health.json");

    assert.strictEqual(run.status, 1, "a drifted guard carried a real failure onto main with it");
    assert.strictEqual(mainSha(origin), before);
    assert.match(run.stdout, /the-data-this-run-wrote-is-wrong/);
  });

  it("holds the data back when a drifted guard's own file gates the data and also failed on something else", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);
    writeFileSync(join(work, "data", "health.json"), '{"checked":13}\n');

    const run = runGate(work, "drifted-in-a-file-that-also-broke", "data-quarantine/fixture", "data(auto): fixture", "data/health.json");

    assert.strictEqual(run.status, 1, "a file excused one assertion at a time excused the whole file");
    assert.strictEqual(mainSha(origin), before);
    assert.match(run.stdout, /the-data-this-run-wrote-is-wrong/);
  });

  it("puts the data on main when a file that gates it went red on a drifted guard and nothing else", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);
    writeFileSync(join(work, "data", "health.json"), '{"checked":14}\n');

    const run = runGate(work, "drifted-in-a-gating-file", "data-quarantine/fixture", "data(auto): fixture", "data/health.json");

    assert.strictEqual(run.status, 0, `a drifted floor in a gating file held the data back: ${run.stdout}${run.stderr}`);
    assert.notStrictEqual(mainSha(origin), before, "the data did not reach main");
    assert.deepStrictEqual(quarantineRefs(origin, "data-quarantine/fixture"), []);
    assert.match(run.stdout, /name no record and no vendor/);
    assert.match(run.outputs, /drifted_guards=1/);
  });

  it("holds the data back when the suite is red and names no file", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);
    writeFileSync(join(work, "data", "health.json"), '{"checked":8}\n');

    const run = runGate(work, "crashed", "data-quarantine/fixture", "data(auto): fixture", "data/health.json");

    assert.strictEqual(run.status, 1, "a suite that failed without naming a file was treated as excused");
    assert.strictEqual(mainSha(origin), before);
    assert.match(run.stdout, /named no test file/);
  });

  it("holds the data back when the build does not compile, even with no failing test that gates the data", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);
    writeFileSync(join(work, "data", "health.json"), '{"checked":9}\n');

    const run = runGate(
      work,
      { mode: "excused", build: "fail" },
      "data-quarantine/fixture",
      "data(auto): fixture",
      "data/health.json",
    );

    assert.strictEqual(run.status, 1, "a build failure reached main");
    assert.strictEqual(mainSha(origin), before);
    assert.match(run.stdout, /does not compile/);
  });

  it("leaves each refusal its own ref, so the second does not overwrite the first", () => {
    const { work, origin } = fixtureRepo();
    writeFileSync(join(work, "data", "health.json"), '{"checked":10}\n');
    const first = runGate(work, "red", "data-quarantine/fixture", "data(auto): day one", "data/health.json");
    assert.strictEqual(first.status, 1, first.stdout + first.stderr);

    writeFileSync(join(work, "data", "health.json"), '{"checked":11}\n');
    const second = runGate(work, "red", "data-quarantine/fixture", "data(auto): day two", "data/health.json");
    assert.strictEqual(second.status, 1, second.stdout + second.stderr);

    const refs = quarantineRefs(origin, "data-quarantine/fixture");
    assert.strictEqual(refs.length, 2, `two refusals left ${refs.length} refs: ${refs.join(", ")}`);
    const held = refs.map((r) => git(origin, "show", `${r}:data/health.json`)).sort();
    assert.deepStrictEqual(held, ['{"checked":10}', '{"checked":11}'], "a day's findings were overwritten");
  });
});

describe("#1326 nothing that can fail stands between the day's data and the gate", () => {
  it("runs the gate as the next step after the one that produced the data", () => {
    for (const file of GATED_WORKFLOWS) {
      const steps = stepsOf(source(file));
      const gate = steps.findIndex((s) => /gate-data-push\.sh/.test(s.body));
      assert.ok(gate > 0, `${file} has no gate step, or the gate is its first step`);
      let producer = -1;
      for (let i = 0; i < gate; i++) if (/\$GITHUB_OUTPUT/.test(steps[i]!.body)) producer = i;
      assert.ok(producer >= 0, `${file} reaches its gate without a step that produced anything`);
      assert.strictEqual(
        gate,
        producer + 1,
        `${file} runs ${steps.slice(producer + 1, gate).map((s) => s.name).join(", ")} after producing the day's data ` +
          `and before the gate that holds it — a failure there takes the data with the runner`,
      );
    }
  });

  it("lowers the daily run's budgets from inside the gate, where a failure is quarantined", () => {
    const gate = gateStepOf("reverify.yml");
    assert.match(gate.body, /GATE_RATCHET_BUDGETS: "1"/, "the daily run no longer banks the improvement its data earned");
    assert.match(gate.body, /data\/quality_budgets\.json/, "the gate may lower a budget it is not allowed to commit");
    assert.doesNotMatch(
      source("reverify.yml"),
      /ratchet-quality-budgets/,
      "the ratchet still runs in a step of its own, upstream of every failure path the gate provides",
    );
  });

  it("asks for the ratchet only where a budget is in the paths being committed", () => {
    for (const file of GATED_WORKFLOWS) {
      const gate = gateStepOf(file);
      if (!/GATE_RATCHET_BUDGETS/.test(gate.body)) continue;
      assert.match(gate.body, /data\/quality_budgets\.json/, `${file} lowers a budget it then leaves in the workspace`);
    }
  });

  it("names the budgets file the code reads, so the shell and the code cannot drift", () => {
    const declared = readFileSync(GATE, "utf8").match(/^BUDGETS_PATH="([^"]+)"$/m)?.[1];
    assert.strictEqual(declared, relative(REPO, qualityBudgetsPath()).split(sep).join("/"));
  });

  it("tells the refusal issue which thing went wrong, not just that something did", () => {
    const gate = readFileSync(GATE, "utf8");
    const reasons = [...gate.matchAll(/^\s*quarantine "([^"]+)"$/gm)].map((m) => m[1]!);
    assert.ok(reasons.length >= 3, `the gate states ${reasons.length} reasons for holding a commit`);
    assert.strictEqual(
      new Set(reasons).size,
      reasons.length,
      `two paths hold a commit under the same reason, so the issue cannot tell them apart: ${reasons.join("; ")}`,
    );
    for (const reason of reasons) {
      assert.ok(reason.split(" ").length >= 4, `"${reason}" does not say what went wrong`);
    }
    for (const named of ["the build does not compile", "the quality budgets could not be measured", "the suite refused it"]) {
      assert.ok(reasons.includes(named), `nothing holds a commit for "${named}" any more`);
    }
    assert.match(gate, /echo "quarantine_reason=\$why"/, "the reason never reaches the step output");
    assert.match(
      readFileSync(join(REPO, "scripts", "report-data-push-outcome.sh"), "utf8"),
      /because \$REASON/,
      "the issue the gate opens does not carry the reason the gate gave it",
    );
    for (const file of GATED_WORKFLOWS) {
      assert.match(
        source(file),
        /report-data-push-outcome\.sh "[^"]+" refused "\$QUARANTINE_REF" "\$QUARANTINE_REASON"/,
        `${file} opens an issue that tells a reader to look for failing tests whatever went wrong`,
      );
    }
    assert.doesNotMatch(
      readFileSync(join(REPO, "scripts", "report-data-push-outcome.sh"), "utf8"),
      /read the failing tests in the run/,
      "the refusal issue still sends a reader to failing tests when the build is what broke",
    );
  });
});

describe("#1335 the gate's own configuration does not configure the suite it runs", () => {
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "gate-config-"));
  });

  after(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  const PATHS = [
    "data-quarantine/fixture",
    "data(auto): fixture",
    "data/health.json",
    "data/quality_budgets.json",
    "data/page-lastmod.json",
    "artifacts/free-llm-api-index/README.md",
  ];

  it("refuses to measure the register on a run that may not commit what it measures", () => {
    const { work } = fixtureRepo({ pageReviews: true });
    writeFileSync(join(work, "data", "health.json"), '{"checked":23}\n');

    const run = runGate(
      work,
      { mode: "green", pageReviews: true },
      "data-quarantine/fixture",
      "data(auto): fixture",
      "data/health.json",
    );

    assert.strictEqual(run.status, 2, `the gate measured a register it could not commit: ${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /GATE_SYNC_PAGE_REVIEWS is set but data\/page-reviews\.json is not among the paths/);
  });

  it("commits the figure counts it measured, and carries the tier it did not", () => {
    const { work, origin } = fixtureRepo({ pageReviews: true });
    const before = mainSha(origin);
    const at = join(work, "data", "page-reviews.json");
    const register = JSON.parse(readFileSync(at, "utf8"));
    const subject = register.pages.find((p: { path: string }) => p.path === "/storage-comparison-2026");
    assert.ok(subject, "the fixture register does not hold the page this asserts about");
    const measured = subject.table_figures;
    assert.ok(measured > 0, "the page this asserts about publishes no table figures, so a count cannot be corrected on it");
    subject.table_figures = 9;
    subject.tier = "B";
    writeFileSync(at, `${JSON.stringify(register, null, 2)}\n`);

    const run = runGate(
      work,
      { mode: "green", pageReviews: true },
      "data-quarantine/fixture",
      "data(auto): fixture",
      "data/health.json",
      "data/page-reviews.json",
    );

    assert.strictEqual(run.status, 0, `the gate refused a green run: ${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /Counting again, on every registered page/, "the gate no longer counts the figures this run's data renders");
    assert.strictEqual(
      git(origin, "rev-list", "--count", `${before}..main`),
      "1",
      "the figure counts arrived as a commit of their own rather than with the data that moved them",
    );
    const onMain = JSON.parse(git(origin, "show", "main:data/page-reviews.json"));
    const after = onMain.pages.find((p: { path: string }) => p.path === "/storage-comparison-2026");
    assert.strictEqual(after.table_figures, measured, "the gate committed a figure count its own render denies");
    assert.strictEqual(after.tier, "B", "the gate rewrote a tier, which is a judgement no run that read no page may make");
    const reviewed = onMain.pages.filter((p: { reviewed_at: string | null }) => p.reviewed_at !== null);
    assert.ok(reviewed.length >= 20, `the register the gate committed carries ${reviewed.length} review records, so the run blanked what a reviewer asserted`);
  });

  it("hands the suite neither variable, so a nested run reads its own arguments", () => {
    const { work } = fixtureRepo();
    writeFileSync(join(work, "data", "health.json"), '{"checked":21}\n');

    const run = runGate(work, { mode: "green", ratchet: "lower", lastmod: true, llmIndex: true }, ...PATHS);

    assert.notStrictEqual(run.suiteSawGateConfig, null, "the suite did not run, so this asserts nothing about what it saw");
    assert.strictEqual(
      run.suiteSawGateConfig,
      "",
      `the suite ran with ${run.suiteSawGateConfig} still set, so anything it starts is configured by this run rather than its own arguments`,
    );
  });

  it("still acts on both variables itself", () => {
    const { work, origin } = fixtureRepo();
    writeFileSync(join(work, "data", "health.json"), '{"checked":22}\n');

    const run = runGate(work, { mode: "green", ratchet: "lower", lastmod: true, llmIndex: true }, ...PATHS);

    assert.strictEqual(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /Lowering any quality budget/, "the gate no longer lowers the budget its data earned");
    assert.match(run.stdout, /Reading every page this run renders/, "the gate no longer dates the pages this run moved");
    assert.match(run.stdout, /Regenerating the AI and LLM free-tier index/, "the gate no longer regenerates the index from the records this run moved");
    assert.match(
      readFileSync(join(work, "artifacts", "free-llm-api-index", "README.md"), "utf8"),
      /free tiers for AI and LLM APIs/i,
      "the index the gate committed is still the placeholder",
    );
    assert.notStrictEqual(mainSha(origin), "", "the fixture origin has no main");
  });
});

describe("#1326 the gate, asked to lower a budget", () => {
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "gate-ratchet-"));
  });

  after(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  const PATHS = ["data-quarantine/fixture", "data(auto): fixture", "data/health.json", "data/quality_budgets.json"];

  it("puts the budget it lowers in the same commit as the data that earned it", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);
    writeFileSync(join(work, "data", "health.json"), '{"checked":12}\n');

    const run = runGate(work, { mode: "green", ratchet: "lower" }, ...PATHS);

    assert.strictEqual(run.status, 0, `the gate refused a green run: ${run.stdout}${run.stderr}`);
    assert.strictEqual(
      git(origin, "rev-list", "--count", `${before}..main`),
      "1",
      "the lowered budget arrived as a commit of its own rather than with the data",
    );
    assert.deepStrictEqual(
      git(origin, "show", "--name-only", "--format=", "main").split("\n").filter(Boolean).sort(),
      ["data/health.json", "data/quality_budgets.json"],
    );
    assert.strictEqual(git(origin, "show", "main:data/quality_budgets.json"), BUDGETS_AFTER.trim());
    assert.strictEqual(
      git(origin, "log", "-1", "--format=%s", "main"),
      "data(auto): fixture",
      "amending the commit lost the message the run wrote",
    );
  });

  it("holds the day's data on a ref of its own when the build the ratchet needs does not compile", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);
    writeFileSync(join(work, "data", "health.json"), '{"checked":13}\n');

    const run = runGate(work, { mode: "green", build: "fail", ratchet: "lower" }, ...PATHS);

    assert.strictEqual(run.status, 1, `a build failure reached main: ${run.stdout}${run.stderr}`);
    assert.strictEqual(mainSha(origin), before);
    const refs = quarantineRefs(origin, "data-quarantine/fixture");
    assert.strictEqual(refs.length, 1, `the day's data was discarded rather than held: ${refs.join(", ")}`);
    assert.strictEqual(
      git(origin, "show", `${refs[0]}:data/health.json`),
      '{"checked":13}',
      "the quarantine ref does not carry the data the run produced",
    );
    assert.match(run.stdout, /does not compile/);
    assert.match(run.outputs, /quarantined=true/, "nothing downstream can report a refusal it is not told of");
    assert.match(run.outputs, new RegExp(`quarantine_ref=${refs[0]}`));
    assert.match(run.outputs, /quarantine_reason=the build does not compile/);
  });

  it("holds the day's data on a ref of its own when the ratchet itself fails", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);
    writeFileSync(join(work, "data", "health.json"), '{"checked":14}\n');

    const run = runGate(work, { mode: "green", ratchet: "throw" }, ...PATHS);

    assert.strictEqual(run.status, 1, `a run that could not measure a budget pushed anyway: ${run.stdout}${run.stderr}`);
    assert.strictEqual(mainSha(origin), before);
    const refs = quarantineRefs(origin, "data-quarantine/fixture");
    assert.strictEqual(refs.length, 1, `failing to measure a budget cost the day's catalogue data: ${refs.join(", ")}`);
    assert.strictEqual(git(origin, "show", `${refs[0]}:data/health.json`), '{"checked":14}');
    assert.strictEqual(
      git(origin, "show", `${refs[0]}:data/quality_budgets.json`),
      BUDGETS_BEFORE.trim(),
      "a ratchet that failed still moved a budget",
    );
    assert.match(run.stdout, /budgets could not be measured/);
    assert.match(run.outputs, /quarantined=true/);
    assert.match(run.outputs, new RegExp(`quarantine_ref=${refs[0]}`));
    assert.match(run.outputs, /quarantine_reason=the quality budgets could not be measured/);
  });

  it("refuses to lower a budget it has not been given permission to commit", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);
    writeFileSync(join(work, "data", "health.json"), '{"checked":15}\n');

    const run = runGate(
      work,
      { mode: "green", ratchet: "lower" },
      "data-quarantine/fixture",
      "data(auto): fixture",
      "data/health.json",
    );

    assert.strictEqual(run.status, 2, `${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /not among the paths this run may commit/);
    assert.strictEqual(mainSha(origin), before);
  });

  it("keeps the suite's own writes out of the step outputs the reporting step reads", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);
    writeFileSync(join(work, "data", "health.json"), '{"checked":17}\n');

    const run = runGate(work, { mode: "red", ratchet: "lower" }, ...PATHS);

    assert.strictEqual(run.status, 1, `${run.stdout}${run.stderr}`);
    assert.strictEqual(mainSha(origin), before);
    assert.match(run.outputs, /quarantined=true/, "the gate's own outputs went missing with the redirect");
    assert.doesNotMatch(
      run.outputs,
      /a_test_spawned_a_script_that_wrote_this/,
      "a test in the suite can write a step output on the gate step's behalf, including one the gate sets itself",
    );
  });

  it("leaves the budgets where they are on a run that did not ask for the ratchet", () => {
    const { work, origin } = fixtureRepo();
    writeFileSync(join(work, "data", "health.json"), '{"checked":16}\n');

    const run = runGate(work, "green", ...PATHS);

    assert.strictEqual(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.strictEqual(
      git(origin, "show", "main:data/quality_budgets.json"),
      BUDGETS_BEFORE.trim(),
      "the gate lowered a budget for a job that never asked it to",
    );
  });
});

describe("#1785 a push the platform starts no run for asks for one itself", () => {
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "gate-asks-"));
  });

  after(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  const PATHS = ["data-quarantine/fixture", "data(auto): fixture", "data/health.json"];
  const SUITE_WORKFLOW = readFileSync(GATE, "utf8").match(/^SUITE_WORKFLOW="\$\{GATE_SUITE_WORKFLOW:-([^}"]+)\}"$/m)?.[1];

  it("names a workflow that exists and can be asked to run", () => {
    assert.ok(SUITE_WORKFLOW, "the gate names no workflow to ask for");
    assert.ok(
      workflowFiles().includes(SUITE_WORKFLOW!),
      `the gate asks for ${SUITE_WORKFLOW}, which is not among ${workflowFiles().join(", ")}`,
    );
    assert.match(
      source(SUITE_WORKFLOW!),
      /^ {2}workflow_dispatch:/m,
      `${SUITE_WORKFLOW} cannot be asked to run, so asking for it fails every time`,
    );
  });

  for (const file of GATED_WORKFLOWS) {
    it(`gives ${file} what asking for a run takes`, () => {
      assert.match(
        source(file),
        /^permissions:\n(?:.*\n)*? {2}actions: write$/m,
        `${file} cannot ask for a workflow run`,
      );
      assert.match(
        gateStepOf(file).body,
        /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/,
        `${file} runs the gate with no token to ask with`,
      );
    });
  }

  it("asks the suite to read main after a green push", () => {
    const { work, origin } = fixtureRepo();
    writeFileSync(join(work, "data", "health.json"), '{"checked":21}\n');

    const run = runGate(work, { mode: "green", asking: "answers" }, ...PATHS);

    assert.strictEqual(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.deepStrictEqual(whatTheGateAskedFor(work), [`workflow run ${SUITE_WORKFLOW} --ref main`]);
    assert.match(run.outputs, /^suite_run_requested=true$/m);
    assert.strictEqual(git(origin, "show", "main:data/health.json"), '{"checked":21}');
  });

  it("asks for one behind a push that went out over a red suite, which is the push nothing else reads", () => {
    const { work } = fixtureRepo();
    writeFileSync(join(work, "data", "health.json"), '{"checked":22}\n');

    const run = runGate(work, { mode: "excused", asking: "answers" }, ...PATHS);

    assert.strictEqual(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.outputs, /^pushed_over_failures=true$/m);
    assert.deepStrictEqual(whatTheGateAskedFor(work), [`workflow run ${SUITE_WORKFLOW} --ref main`]);
  });

  it("asks for nothing when the data never reached main", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);
    writeFileSync(join(work, "data", "health.json"), '{"checked":23}\n');

    const run = runGate(work, { mode: "red", asking: "answers" }, ...PATHS);

    assert.strictEqual(run.status, 1, "the gate pushed data the suite refused");
    assert.strictEqual(mainSha(origin), before);
    assert.deepStrictEqual(whatTheGateAskedFor(work), []);
  });

  it("asks once, for the push that landed, when main moved under the run", () => {
    const { work, origin } = fixtureRepo();
    writeFileSync(join(work, "data", "health.json"), '{"checked":25}\n');
    commitToMainFromElsewhere(origin, "another-job-wrote-this.txt", "landed while the suite ran\n");

    const run = runGate(work, { mode: "green", asking: "answers" }, ...PATHS);

    assert.strictEqual(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.strictEqual(git(origin, "show", "main:data/health.json"), '{"checked":25}');
    assert.deepStrictEqual(whatTheGateAskedFor(work), [`workflow run ${SUITE_WORKFLOW} --ref main`]);
  });

  it("keeps the data on main when the ask is refused, and says so", () => {
    const { work, origin } = fixtureRepo();
    writeFileSync(join(work, "data", "health.json"), '{"checked":24}\n');

    const run = runGate(work, { mode: "green", asking: "refuses" }, ...PATHS);

    assert.strictEqual(run.status, 0, `a refused ask stopped the run: ${run.stdout}${run.stderr}`);
    assert.strictEqual(git(origin, "show", "main:data/health.json"), '{"checked":24}');
    assert.match(run.outputs, /^suite_run_requested=false$/m);
    assert.match(run.stdout, /Could not ask/);
  });
});

const REFUSALS_THAT_NAMED_NO_RECORD: Array<[string, string]> = [
  ["test/ranking.test.ts", "2026-09-04, Databases: Firebase is the only demotion, on a named recorded fact — a second demotion arrived and the control named one"],
  ["test/data-push-gate.test.ts", "2026-09-05, stops a data change the suite refuses — the job's own configuration reached the suite it runs"],
  ["test/deal-changes.test.ts", "2026-09-07, getDealChanges filters by vendors (comma-separated) — 5 records where the test types 4"],
  ["test/http.test.ts", "2026-09-07, GET /vendor/:slug includes enriched JSON-LD with dateModified — JSON-LD should include an Offer"],
  ["test/change-feed-provenance.test.ts", "2026-09-08 and 2026-09-09, never stamps a feed as generated later than it was generated — by 5ms and by 3ms"],
  ["test/homepage-cites-what-it-serves.test.ts", "2026-09-09, reaches a page for every vendor it names in prose — a vendor the homepage names outside a link"],
  ["test/documented-route-citation.test.ts", "2026-09-11, /api/newest cites a page narrower than the site root — the citation resolved to a loopback address"],
];

const REFUSALS_THAT_NAMED_A_RECORD: Array<[string, string]> = [
  ["test/superseded-terms.test.ts", "2026-09-07, a vendor holding two changes that quote its stored terms as the previous ones"],
  ["test/removal-record-refuted-by-its-page.test.ts", "2026-09-10, does not call a withdrawn record a change the vendor made — the one change recorded did not narrow the terms"],
  ["test/change-direction-review.test.ts", "2026-09-11 and 2026-09-12, leaves every record it does not review carrying no direction — two records carried one from nowhere"],
  ["test/refused-change-not-stable.test.ts", "2026-09-13, publishes none of the records it refused — a refused record reached the published log"],
];

describe("#1645 which failures may hold a data commit, and nothing else may", () => {
  const shipped = readDataGatingTests();
  const gating = new Set(shipped.tests.map((t) => t.file));

  it("names test files that exist, so a rename cannot silently empty the gate", () => {
    for (const t of shipped.tests) {
      assert.ok(existsSync(join(REPO, t.file)), `${t.file} may hold a data commit and does not exist`);
    }
  });

  it("keeps the list short enough to read, and gives a reason for every entry", () => {
    assert.ok(shipped.tests.length > 0, "nothing gates the data, so the gate has no subject");
    assert.ok(shipped.tests.length <= 12, `${shipped.tests.length} files gate the data; the list is meant to be read`);
    for (const t of shipped.tests) {
      assert.ok(t.reason.length > 40, `${t.file} gates a data commit with ${t.reason.length} characters of reason`);
    }
  });

  it("names only files that read the catalogue a scheduled run rewrites", () => {
    const reachesTheCatalogue =
      /data", "(index|deal_changes|change_refusals|verification_state)\.json"|loadOffers|loadDealChanges|loadChangeRefusals|recordsInTheCatalogue/;
    for (const t of shipped.tests) {
      assert.match(
        readFileSync(join(REPO, t.file), "utf8"),
        reachesTheCatalogue,
        `${t.file} may hold a data commit and reads none of the files a run commits, so nothing it fires on can be this run's data`,
      );
    }
  });

  it("lives where no scheduled job can write it, so widening the gate takes a pull request", () => {
    assert.match(readFileSync(join(REPO, "src", "data-push-gate.ts"), "utf8"), /"scripts", "gate-blocking-tests\.json"/);
    for (const file of GATED_WORKFLOWS) {
      const gated = source(file).match(/gate-data-push\.sh[\s\S]*?\n\n/)?.[0] ?? "";
      assert.doesNotMatch(gated, /\bscripts\//, `${file} hands the gate a path under scripts/, which it could then commit`);
    }
  });

  it("lets the commit through for a file nobody named", () => {
    const verdict = gateVerdict([{ file: "test/somewhere-else.test.ts", name: "a test" }], shipped);
    assert.strictEqual(verdict.decision, "push");
    assert.deepStrictEqual(verdict.blocking, []);
    assert.deepStrictEqual(verdict.reported.map((t) => t.file), ["test/somewhere-else.test.ts"]);
  });

  it("holds the commit when a failing file is one that gates the data", () => {
    const verdict = gateVerdict(shipped.tests.map((t) => ({ file: t.file, name: "a test" })), shipped);
    assert.strictEqual(verdict.decision, "quarantine");
    assert.deepStrictEqual(verdict.blocking, shipped.tests.map((t) => t.file).sort());
  });

  it("lets a drifted floor through even in a file that gates the data", () => {
    const verdict = gateVerdict(
      [{ file: shipped.tests[0]!.file, name: "a test", drifted: A_GUARD_THAT_DRIFTED }],
      shipped,
    );
    assert.strictEqual(verdict.decision, "push");
    assert.deepStrictEqual(verdict.blocking, []);
  });

  it("names every file that went red, whether or not it held the commit", () => {
    const verdict = gateVerdict(
      [
        { file: "test/somewhere-else.test.ts", name: "a test" },
        { file: shipped.tests[0]!.file, name: "a test" },
      ],
      shipped,
    );
    assert.deepStrictEqual(verdict.files, [shipped.tests[0]!.file, "test/somewhere-else.test.ts"].sort());
    assert.deepStrictEqual(verdict.reported.map((t) => t.file), ["test/somewhere-else.test.ts"]);
  });

  it("says of every file that did not hold the commit why it did not", () => {
    const verdict = gateVerdict([{ file: "test/somewhere-else.test.ts", name: "a test" }], shipped, "the list");
    assert.match(verdict.reported[0]!.reason, /the list does not name it/);
  });

  it("holds the commit when the suite failed and named nothing", () => {
    const verdict = gateVerdict([], shipped);
    assert.strictEqual(verdict.decision, "quarantine");
    assert.match(verdict.reason, /named no test file/);
  });

  it("refuses a list that names something outside test/", () => {
    assert.throws(
      () => parseDataGatingTests(JSON.stringify({ version: 1, rule: "r", tests: [{ file: "src/serve.ts", reason: "x" }] }), "fixture"),
      /not a path under test\//,
    );
  });

  it("refuses a list that names a file with no reason", () => {
    assert.throws(
      () => parseDataGatingTests(JSON.stringify({ version: 1, rule: "r", tests: [{ file: "test/a.test.ts" }] }), "fixture"),
      /with no reason/,
    );
  });

  it("leaves outside the gate every scheduled refusal whose assertion named no record", () => {
    for (const [file, assertion] of REFUSALS_THAT_NAMED_NO_RECORD) {
      assert.ok(!gating.has(file), `${file} still holds a data commit, and it refused one on ${assertion}`);
    }
  });

  it("keeps inside the gate every scheduled refusal whose assertion named a record", () => {
    for (const [file, assertion] of REFUSALS_THAT_NAMED_A_RECORD) {
      assert.ok(gating.has(file), `${file} no longer holds a data commit, and it refused one on ${assertion}`);
    }
  });
});

describe("#1337 main moving under a run whose data the suite accepted", () => {
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "gate-moved-main-"));
  });

  after(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  it("replays onto the main it moved to, and pushes what the suite read after the replay", () => {
    const { work, origin } = fixtureRepo();
    writeFileSync(join(work, "data", "health.json"), '{"checked":5}\n');
    commitToMainFromElsewhere(origin, "another-job-wrote-this.txt", "landed while the suite ran\n");

    const run = runGate(work, "green", "data-quarantine/fixture", "data(auto): fixture", "data/health.json");

    assert.strictEqual(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.strictEqual(git(origin, "show", "main:data/health.json"), '{"checked":5}');
    assert.strictEqual(
      git(origin, "show", "main:another-job-wrote-this.txt"),
      "landed while the suite ran",
      "this run's push took main back over the commit that landed under it",
    );
    assert.strictEqual(git(origin, "log", "-1", "--format=%s", "main"), "data(auto): fixture");
    assert.deepStrictEqual(quarantineRefs(origin, "data-quarantine/fixture"), []);
    assert.strictEqual(
      suiteRuns(run.stdout),
      2,
      "the suite did not read the tree the replay produced, so what reached main is not what it passed",
    );
  });

  it("replays onto it from the shallow checkout the workflows actually run in", () => {
    const { work, origin } = fixtureRepo({ shallow: true });
    writeFileSync(join(work, "data", "health.json"), '{"checked":8}\n');
    commitToMainFromElsewhere(origin, "another-job-wrote-this.txt", "landed while the suite ran\n");

    const run = runGate(work, "green", "data-quarantine/fixture", "data(auto): fixture", "data/health.json");

    assert.strictEqual(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.strictEqual(git(origin, "show", "main:data/health.json"), '{"checked":8}');
    assert.strictEqual(git(origin, "show", "main:another-job-wrote-this.txt"), "landed while the suite ran");
    assert.deepStrictEqual(quarantineRefs(origin, "data-quarantine/fixture"), []);
  });

  it("holds the data on a ref of its own when it cannot be replayed onto that main", () => {
    const { work, origin } = fixtureRepo();
    writeFileSync(join(work, "data", "health.json"), '{"checked":6}\n');
    commitToMainFromElsewhere(origin, "data/health.json", '{"checked":99}\n');

    const run = runGate(work, "green", "data-quarantine/fixture", "data(auto): fixture", "data/health.json");

    assert.strictEqual(run.status, 1, `${run.stdout}${run.stderr}`);
    assert.strictEqual(git(origin, "show", "main:data/health.json"), '{"checked":99}');
    const refs = quarantineRefs(origin, "data-quarantine/fixture");
    assert.strictEqual(refs.length, 1, `this run's data is on no ref at all: ${refs.join(", ")}`);
    assert.strictEqual(git(origin, "show", `${refs[0]}:data/health.json`), '{"checked":6}');
    assert.match(run.outputs, /quarantined=true/);
    assert.match(run.stdout, /does not replay onto it/);
  });

  it("reports a refusal rather than a shipment when an excused red run cannot reach main", () => {
    const { work, origin } = fixtureRepo();
    writeFileSync(join(work, "data", "health.json"), '{"checked":9}\n');
    commitToMainFromElsewhere(origin, "data/health.json", '{"checked":99}\n');

    const run = runGate(
      work,
      { mode: "excused", replays: 0 },
      "data-quarantine/fixture",
      "data(auto): fixture",
      "data/health.json",
    );

    assert.strictEqual(run.status, 1, `${run.stdout}${run.stderr}`);
    assert.match(run.outputs, /quarantined=true/);
    assert.doesNotMatch(
      run.outputs,
      /pushed_over_failures=true/,
      "the workflow would report this run as shipped over failures, and it shipped nothing",
    );
    assert.strictEqual(quarantineRefs(origin, "data-quarantine/fixture").length, 1);
  });

  it("measures again what it derives from the tree, so the replay does not leave the run's own figures behind", () => {
    const { work, origin } = fixtureRepo();
    writeFileSync(join(work, "data", "health.json"), '{"checked":11}\n');
    commitToMainFromElsewhere(origin, "data/a-sibling-job-wrote-this.json", '{"rows":[]}\n');

    const run = runGate(
      work,
      { mode: "budget-against-the-tree", ratchet: "measures-the-tree" },
      "data-quarantine/fixture",
      "data(auto): fixture",
      "data/health.json",
      "data/quality_budgets.json",
    );

    assert.strictEqual(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.deepStrictEqual(
      quarantineRefs(origin, "data-quarantine/fixture"),
      [],
      "the replay left a figure measuring the tree before it moved, and the suite read it as the data being wrong",
    );
    assert.strictEqual(git(origin, "show", "main:data/health.json"), '{"checked":11}');
    assert.strictEqual(
      JSON.parse(git(origin, "show", "main:data/quality_budgets.json")).budgets.fixture_pages,
      5,
      "what reached main states a figure nothing in that tree measures",
    );
    assert.strictEqual(suiteRuns(run.stdout), 2);
  });

  it("bounds the replays, so a main that keeps moving quarantines rather than looping", () => {
    const { work, origin } = fixtureRepo();
    writeFileSync(join(work, "data", "health.json"), '{"checked":7}\n');
    commitToMainFromElsewhere(origin, "another-job-wrote-this.txt", "landed while the suite ran\n");

    const run = runGate(
      work,
      { mode: "green", replays: 0 },
      "data-quarantine/fixture",
      "data(auto): fixture",
      "data/health.json",
    );

    assert.strictEqual(run.status, 1, `${run.stdout}${run.stderr}`);
    assert.strictEqual(suiteRuns(run.stdout), 1);
    assert.strictEqual(quarantineRefs(origin, "data-quarantine/fixture").length, 1);
    assert.match(run.stdout, /more often than this run replays onto it/);
  });
});

describe("#1589 a replay conflicting only in what this run derives is resolved, not held back", () => {
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "gate-replay-derived-"));
  });

  after(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  const BUDGETS_ON_MAIN = `${JSON.stringify({ version: 1, budgets: { fixture_pages: 99 } }, null, 2)}\n`;

  const WITH_THE_BUDGET = [
    "data-quarantine/fixture",
    "data(auto): fixture",
    "data/health.json",
    "data/quality_budgets.json",
  ];

  it("pushes the batch when the only conflict is a budget the derivation measures again", () => {
    const { work, origin } = fixtureRepo();
    writeFileSync(join(work, "data", "health.json"), '{"checked":31}\n');
    commitToMainFromElsewhere(origin, "data/quality_budgets.json", BUDGETS_ON_MAIN);

    const run = runGate(work, { mode: "green", ratchet: "lower" }, ...WITH_THE_BUDGET);

    assert.strictEqual(run.status, 0, `the gate held a batch whose only conflict it overwrites: ${run.stdout}${run.stderr}`);
    assert.deepStrictEqual(quarantineRefs(origin, "data-quarantine/fixture"), []);
    assert.strictEqual(
      git(origin, "show", "main:data/health.json"),
      '{"checked":31}',
      "the reading this run made did not reach main",
    );
    assert.strictEqual(
      git(origin, "show", "main:data/quality_budgets.json"),
      BUDGETS_AFTER.trim(),
      "what reached main is a budget neither side measured against the tree it shipped with",
    );
    assert.strictEqual(suiteRuns(run.stdout), 2, "the suite did not read the tree the replay produced");
  });

  it("says in the log which files it resolved by regenerating rather than by merging", () => {
    const { work, origin } = fixtureRepo();
    writeFileSync(join(work, "data", "health.json"), '{"checked":32}\n');
    commitToMainFromElsewhere(origin, "data/quality_budgets.json", BUDGETS_ON_MAIN);

    const run = runGate(work, { mode: "green", ratchet: "lower" }, ...WITH_THE_BUDGET);

    assert.strictEqual(run.status, 0, `${run.stdout}${run.stderr}`);
    const said = run.stdout.split("\n").filter((line) => /Replayed over a conflict in/.test(line));
    assert.strictEqual(said.length, 1, `a reader of this run cannot tell it from a clean replay: ${run.stdout}`);
    assert.match(said[0]!, /data\/quality_budgets\.json/, `the line names no file: ${said[0]}`);
  });

  it("holds the batch when the conflict is in a reading this run made, and names that file", () => {
    const { work, origin } = fixtureRepo({ index: true });
    writeFileSync(join(work, "data", "health.json"), '{"checked":33}\n');
    writeFileSync(join(work, "data", "index.json"), '{"offers":[{"vendor":"Steadyvendor","tier":"what this run read"}]}\n');
    commitToMainFromElsewhere(origin, "data/index.json", '{"offers":[{"vendor":"Steadyvendor","tier":"what another job read"}]}\n');
    const before = mainSha(origin);

    const run = runGate(
      work,
      { mode: "green", ratchet: "lower" },
      "data-quarantine/fixture",
      "data(auto): fixture",
      "data/health.json",
      "data/index.json",
      "data/quality_budgets.json",
    );

    assert.strictEqual(run.status, 1, `the gate merged away a disagreement about what a page said: ${run.stdout}${run.stderr}`);
    assert.strictEqual(mainSha(origin), before, "main moved on a batch that conflicts in a reading");
    assert.strictEqual(quarantineRefs(origin, "data-quarantine/fixture").length, 1);
    assert.match(run.stdout, /does not replay onto it/);
    assert.match(run.stdout, /data\/index\.json/, "the refusal does not name the file that held the batch");
    assert.match(run.outputs, /quarantine_reason=.*data\/index\.json/);
  });

  it("holds the batch when the conflicted file is one this run was not asked to regenerate", () => {
    const { work, origin } = fixtureRepo();
    writeFileSync(join(work, "data", "page-lastmod.json"), '{"version":1,"generated":"2026-02-02","pages":{}}\n');
    commitToMainFromElsewhere(origin, "data/page-lastmod.json", '{"version":1,"generated":"2026-03-03","pages":{}}\n');
    const before = mainSha(origin);

    const run = runGate(
      work,
      "green",
      "data-quarantine/fixture",
      "data(auto): fixture",
      "data/page-lastmod.json",
    );

    assert.strictEqual(
      run.status,
      1,
      `the gate discarded a conflict in a file nothing downstream rewrites: ${run.stdout}${run.stderr}`,
    );
    assert.strictEqual(mainSha(origin), before);
    assert.strictEqual(quarantineRefs(origin, "data-quarantine/fixture").length, 1);
    assert.match(run.stdout, /data\/page-lastmod\.json/);
  });

  it("leaves a budget another job already lowered where it found it", () => {
    const { work, origin } = fixtureRepo();
    const LOWERED_BY_A_SIBLING = `${JSON.stringify({ version: 1, budgets: { fixture_pages: 40 } }, null, 2)}\n`;
    writeFileSync(join(work, "data", "health.json"), '{"checked":36}\n');
    commitToMainFromElsewhere(origin, "data/quality_budgets.json", LOWERED_BY_A_SIBLING);

    const run = runGate(work, { mode: "green", ratchet: "lowers-only-what-is-earned" }, ...WITH_THE_BUDGET);

    assert.strictEqual(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.strictEqual(git(origin, "show", "main:data/health.json"), '{"checked":36}');
    assert.strictEqual(
      git(origin, "show", "main:data/quality_budgets.json"),
      LOWERED_BY_A_SIBLING.trim(),
      "the resolution kept this run's own copy, so a budget another job had already lowered was raised back by a replay",
    );
  });

  it("keeps this run's commit when taking main's copy leaves it with nothing of its own", () => {
    const { work, origin } = fixtureRepo();
    writeFileSync(join(work, "data", "quality_budgets.json"), `${JSON.stringify({ version: 1, budgets: { fixture_pages: 70 } }, null, 2)}\n`);
    commitToMainFromElsewhere(origin, "data/quality_budgets.json", BUDGETS_ON_MAIN);
    const sibling = mainSha(origin);

    const run = runGate(
      work,
      { mode: "green", ratchet: "lower" },
      "data-quarantine/fixture",
      "data(auto): fixture",
      "data/quality_budgets.json",
    );

    assert.strictEqual(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.strictEqual(
      git(origin, "rev-list", "--count", `${sibling}..main`),
      "1",
      "the replay dropped this run's commit and the derivation then amended someone else's",
    );
    assert.strictEqual(
      git(origin, "log", "-1", "--format=%s", "main"),
      "data(auto): fixture",
      "what reached main carries another job's commit message, so this run rewrote a commit that was not its own",
    );
    assert.strictEqual(git(origin, "show", "main:data/quality_budgets.json"), BUDGETS_AFTER.trim());
  });

  it("pushes the rotation's own case — the page ledger and a budget at once, on a run that rebuilds both", () => {
    const { work, origin } = fixtureRepo();
    writeFileSync(join(work, "data", "health.json"), '{"checked":34}\n');
    commitToMainFromElsewhere(origin, "data/page-lastmod.json", '{"version":1,"generated":"2026-04-04","pages":{}}\n');
    commitToMainFromElsewhere(origin, "data/quality_budgets.json", BUDGETS_ON_MAIN);

    const run = runGate(
      work,
      { mode: "green", ratchet: "lower", lastmod: true },
      "data-quarantine/fixture",
      "data(auto): fixture",
      "data/health.json",
      "data/page-lastmod.json",
      "data/quality_budgets.json",
    );

    assert.strictEqual(run.status, 0, `the rotation's own refusal still holds the batch: ${run.stdout}${run.stderr}`);
    assert.deepStrictEqual(quarantineRefs(origin, "data-quarantine/fixture"), []);
    assert.strictEqual(git(origin, "show", "main:data/health.json"), '{"checked":34}');
    assert.strictEqual(
      git(origin, "show", "main:data/quality_budgets.json"),
      BUDGETS_AFTER.trim(),
      "the second of the two conflicted files reached main as neither side's copy nor a measurement",
    );
    const derivations = [...run.stdout.matchAll(/Read (\d+) pages twice/g)];
    assert.strictEqual(derivations.length, 2, `the ledger was not derived again after the replay: ${run.stdout}`);
    const ledger = JSON.parse(git(origin, "show", "main:data/page-lastmod.json"));
    assert.strictEqual(
      Object.keys(ledger.pages).length,
      Number(derivations[1]![1]),
      "what reached main is not the ledger the derivation wrote against the tree it replayed onto",
    );
    assert.match(run.stdout, /Replayed over a conflict in data\/page-lastmod\.json data\/quality_budgets\.json/);
  });
});

describe("#1710 a red main reaches the issue the reporter opened, not one that mentions it", () => {
  const REPORTER = join(REPO, "scripts", "report-data-push-outcome.sh");
  let bin = "";

  before(() => {
    bin = mkdtempSync(join(tmpdir(), "report-outcome-gh-"));
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [ "$1 $2" = "issue list" ]; then',
        '  EXPR=""',
        '  FROM="$GH_OPEN_ISSUES"',
        '  while [ "$#" -gt 0 ]; do',
        '    if [ "$1" = "--jq" ]; then EXPR="$2"; fi',
        '    if [ "$1" = "--search" ]; then FROM="$GH_INDEX_RETURNS"; fi',
        "    shift",
        "  done",
        '  jq -r "$EXPR" <"$FROM"',
        "  exit 0",
        "fi",
        'if [ "$1 $2" = "issue comment" ]; then echo "comment $3" >>"$GH_ACTIONS"; exit 0; fi',
        'if [ "$1 $2" = "issue create" ]; then echo "create" >>"$GH_ACTIONS"; exit 0; fi',
        'echo "unexpected gh call: $*" >&2; exit 3',
      ].join("\n"),
      { mode: 0o755 },
    );
  });

  after(() => {
    if (bin && existsSync(bin)) rmSync(bin, { recursive: true, force: true });
  });

  function report(
    outcome: string,
    openIssues: Array<{ number: number; body: string }>,
    indexReturns: Array<{ number: number; body: string }> = openIssues,
  ): string[] {
    const issues = join(bin, "issues.json");
    const indexed = join(bin, "indexed.json");
    const actions = join(bin, "actions.txt");
    const asTheSystemOpenedThem = (them: Array<{ number: number; body: string }>) =>
      them.map((issue) => ({ author: { login: "app/github-actions" }, ...issue }));
    writeFileSync(issues, JSON.stringify(asTheSystemOpenedThem(openIssues)));
    writeFileSync(indexed, JSON.stringify(asTheSystemOpenedThem(indexReturns)));
    writeFileSync(actions, "");
    const run = spawnSync("bash", [REPORTER, "Daily rolling re-verification", outcome, "test/some-file.test.ts"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_OPEN_ISSUES: issues,
        GH_INDEX_RETURNS: indexed,
        GH_ACTIONS: actions,
      },
    });
    assert.strictEqual(run.status, 0, `${run.stdout}${run.stderr}`);
    return readFileSync(actions, "utf8").split("\n").filter(Boolean);
  }

  const marked = (marker: string) => `A previous run said this.\n\n<!-- ${marker} -->`;

  it("comments on the open issue carrying its own marker", () => {
    assert.deepStrictEqual(report("shipped-over-failures", [{ number: 90, body: marked("data-push-over-failures") }]), ["comment 90"]);
  });

  it("opens its own issue rather than commenting on one that only writes the marker out", () => {
    const quoting = { number: 1531, body: "I replayed nine batches. The run reports `data-push-vendorholdback` at priority/medium." };
    assert.deepStrictEqual(report("shipped-over-failures", [quoting]), ["create"]);
    assert.deepStrictEqual(report("held-back-a-vendor", [quoting]), ["create"]);
  });

  it("keeps each outcome out of another outcome's issue", () => {
    const heldBack = { number: 77, body: marked("data-push-vendorholdback") };
    assert.deepStrictEqual(report("shipped-over-failures", [heldBack]), ["create"]);
    assert.deepStrictEqual(report("refused", [heldBack]), ["create"]);
    assert.deepStrictEqual(report("held-back-a-vendor", [heldBack]), ["comment 77"]);
  });

  it("finds the carrier among the open issues rather than among a search engine's hits", () => {
    const carrier = { number: 90, body: marked("data-push-over-failures") };
    assert.deepStrictEqual(report("shipped-over-failures", [carrier], []), ["comment 90"]);
  });

  it("picks the same issue every run when more than one carries the marker", () => {
    const carriers = [
      { number: 400, body: marked("data-push-over-failures") },
      { number: 120, body: marked("data-push-over-failures") },
    ];
    assert.deepStrictEqual(report("shipped-over-failures", carriers), ["comment 120"]);
    assert.deepStrictEqual(report("shipped-over-failures", [...carriers].reverse()), ["comment 120"]);
  });
});

const FAKE_GH_TRACKER = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  'STATE="$GH_STATE"',
  "record() { printf '%s\\n' \"$1\" >>\"$GH_ACTIONS\"; }",
  'sub="$1 $2"',
  "shift 2",
  'case "$sub" in',
  '  "issue list")',
  "    EXPR='.'",
  '    WANT="OPEN"',
  '    while [ "$#" -gt 0 ]; do',
  '      case "$1" in',
  '        --jq) EXPR="$2"; shift 2 ;;',
  '        --state) case "$2" in open) WANT="OPEN" ;; closed) WANT="CLOSED" ;; *) WANT="ANY" ;; esac; shift 2 ;;',
  "        *) shift ;;",
  "      esac",
  "    done",
  '    jq -c --arg want "$WANT" \'[.[] | select($want == "ANY" or .state == $want)]\' "$STATE" | jq -r "$EXPR"',
  "    ;;",
  '  "issue create")',
  '    TITLE=""; BODY_FILE=""',
  '    while [ "$#" -gt 0 ]; do',
  '      case "$1" in',
  '        --title) TITLE="$2"; shift 2 ;;',
  '        --body-file) BODY_FILE="$2"; shift 2 ;;',
  "        --label) shift 2 ;;",
  "        *) shift ;;",
  "      esac",
  "    done",
  '    NEXT="$(jq \'[.[].number] | max // 0 | . + 1\' "$STATE")"',
  '    jq --argjson n "$NEXT" --arg t "$TITLE" --rawfile b "$BODY_FILE" \\',
  "      '. + [{number: $n, title: $t, body: $b, author: {login: \"app/github-actions\"}, state: \"OPEN\"}]' \\",
  '      "$STATE" >"$STATE.next"',
  '    mv "$STATE.next" "$STATE"',
  '    record "create $NEXT"',
  "    ;;",
  '  "issue comment")',
  '    N="$1"; shift',
  '    BODY_FILE=""',
  '    while [ "$#" -gt 0 ]; do',
  '      case "$1" in --body-file) BODY_FILE="$2"; shift 2 ;; *) shift ;; esac',
  "    done",
  '    jq -c -n --argjson n "$N" --rawfile b "$BODY_FILE" \'{issue: $n, body: $b}\' >>"$GH_COMMENTS"',
  '    record "comment $N"',
  "    ;;",
  '  "issue close")',
  '    N="$1"',
  "    jq --argjson n \"$N\" 'map(if .number == $n then .state = \"CLOSED\" else . end)' \"$STATE\" >\"$STATE.next\"",
  '    mv "$STATE.next" "$STATE"',
  '    record "close $N"',
  "    ;;",
  '  *) echo "unexpected gh call: $sub $*" >&2; exit 3 ;;',
  "esac",
].join("\n");

describe("#1764 a refusal alarm belongs to one job, and the job that reaches main closes it", () => {
  const REPORTER = join(REPO, "scripts", "report-data-push-outcome.sh");
  const ROTATION = "Daily rolling re-verification";
  const DATES = "Page dates";
  const LIVENESS = "Link liveness";

  interface TrackedIssue {
    number: number;
    title: string;
    body: string;
    author: { login: string };
    state: "OPEN" | "CLOSED";
  }

  let bin = "";
  let elsewhere = "";

  before(() => {
    bin = mkdtempSync(join(tmpdir(), "alarm-tracker-"));
    elsewhere = mkdtempSync(join(tmpdir(), "alarm-no-repo-"));
    writeFileSync(join(bin, "gh"), FAKE_GH_TRACKER, { mode: 0o755 });
  });

  after(() => {
    for (const dir of [bin, elsewhere]) if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  class Tracker {
    readonly state: string;
    readonly actions: string;
    readonly comments: string;
    readonly cwd: string;

    constructor(seed: Array<Partial<TrackedIssue> & { number: number; body: string }>, cwd: string) {
      this.cwd = cwd;
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      this.state = join(bin, `issues-${stamp}.json`);
      this.actions = join(bin, `actions-${stamp}.txt`);
      this.comments = join(bin, `comments-${stamp}.jsonl`);
      writeFileSync(
        this.state,
        JSON.stringify(
          seed.map((issue) => ({
            title: "seeded",
            author: { login: "app/github-actions" },
            state: "OPEN" as const,
            ...issue,
          })),
        ),
      );
      writeFileSync(this.actions, "");
      writeFileSync(this.comments, "");
    }

    report(job: string, outcome: string, detail = "the-detail"): string[] {
      const before = readFileSync(this.actions, "utf8").split("\n").filter(Boolean);
      const run = spawnSync("bash", [REPORTER, job, outcome, detail], {
        cwd: this.cwd,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_STATE: this.state, GH_ACTIONS: this.actions, GH_COMMENTS: this.comments },
      });
      assert.strictEqual(run.status, 0, `${run.stdout}${run.stderr}`);
      return readFileSync(this.actions, "utf8").split("\n").filter(Boolean).slice(before.length);
    }

    issues(): TrackedIssue[] {
      return JSON.parse(readFileSync(this.state, "utf8")) as TrackedIssue[];
    }

    open(): TrackedIssue[] {
      return this.issues().filter((issue) => issue.state === "OPEN");
    }

    commentsOn(number: number): string[] {
      return readFileSync(this.comments, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { issue: number; body: string })
        .filter((comment) => comment.issue === number)
        .map((comment) => comment.body);
    }
  }

  const alarmFor = (job: string) => `an earlier run said this.\n\n<!-- data-push-refused:${job} -->`;

  function tracker(seed: Array<Partial<TrackedIssue> & { number: number; body: string }> = [], cwd = elsewhere): Tracker {
    return new Tracker(seed, cwd);
  }

  it("opens one alarm per job, so two refused jobs are two issues", () => {
    const t = tracker();
    assert.deepStrictEqual(t.report(ROTATION, "refused"), ["create 1"]);
    assert.deepStrictEqual(t.report(DATES, "refused"), ["create 2"]);
    assert.deepStrictEqual(
      t.open().map((issue) => issue.number),
      [1, 2],
    );
  });

  it("names the job in the title, which is the only part of an alarm a list of issues shows", () => {
    const t = tracker();
    t.report(ROTATION, "refused");
    t.report(DATES, "refused");
    const titles = t.open().map((issue) => issue.title);
    assert.ok(
      titles.every((title) => title.includes(ROTATION) || title.includes(DATES)),
      `neither alarm says which job is frozen: ${titles.join(" / ")}`,
    );
    assert.strictEqual(new Set(titles).size, 2, `both jobs are frozen under the same title: ${titles.join(" / ")}`);
  });

  it("comments on its own job's open alarm rather than opening a second one for the same freeze", () => {
    const t = tracker();
    t.report(ROTATION, "refused");
    assert.deepStrictEqual(t.report(ROTATION, "refused"), ["comment 1"]);
    assert.strictEqual(t.open().length, 1);
  });

  it("closes the refused job's alarm when that job reaches main, and names the commit that cleared it", () => {
    const t = tracker();
    t.report(ROTATION, "refused");
    assert.deepStrictEqual(t.report(ROTATION, "reached-main", "abc1234"), ["comment 1", "close 1"]);
    assert.deepStrictEqual(t.open(), []);
    assert.match(t.commentsOn(1).join("\n"), /abc1234/, "the alarm closes without saying which commit cleared it");
  });

  it("leaves another job's alarm open when this job reaches main", () => {
    const t = tracker();
    t.report(ROTATION, "refused");
    t.report(DATES, "refused");
    t.report(DATES, "reached-main", "abc1234");
    assert.deepStrictEqual(
      t.open().map((issue) => issue.number),
      [1],
    );
  });

  it("closes the alarm on a run that had nothing to push, because nothing was held back either", () => {
    const t = tracker();
    t.report(LIVENESS, "refused");
    t.report(LIVENESS, "reached-main", "");
    assert.deepStrictEqual(t.open(), []);
  });

  it("does nothing on a job that reaches main with no alarm of its own open", () => {
    const t = tracker();
    assert.deepStrictEqual(t.report(DATES, "reached-main", "abc1234"), []);
  });

  it("does not touch an issue that carries the marker but was not opened by the system", () => {
    const written = { number: 1131, body: `The alarm writes <!-- data-push-refused:page-dates --> into its body.`, author: { login: "robhunterclaude" } };
    const refusing = tracker([written]);
    assert.deepStrictEqual(refusing.report(DATES, "refused"), ["create 1132"]);

    const clearing = tracker([written]);
    assert.deepStrictEqual(clearing.report(DATES, "reached-main", "abc1234"), []);
    assert.deepStrictEqual(
      clearing.open().map((issue) => issue.number),
      [1131],
    );
  });

  it("closes an alarm that names no job once no job has one of its own, and not before", () => {
    const shared = { number: 1335, body: "A scheduled data push was refused.\n\n<!-- data-push-refused -->" };

    const stillFrozen = tracker([shared]);
    stillFrozen.report(ROTATION, "refused");
    stillFrozen.report(DATES, "reached-main", "abc1234");
    assert.ok(
      stillFrozen.open().some((issue) => issue.number === 1335),
      "an alarm that speaks for every job closed while one of them was still refused",
    );

    const clear = tracker([shared]);
    clear.report(DATES, "reached-main", "abc1234");
    assert.deepStrictEqual(clear.open(), []);
    assert.match(clear.commentsOn(1335).join("\n"), /names no job/);
  });

  it("holds the open set to the jobs whose last run did not reach main, replayed over a fortnight", () => {
    const history: Array<{ job: string; outcome: "refused" | "reached-main" }> = [
      { job: LIVENESS, outcome: "refused" },
      { job: ROTATION, outcome: "refused" },
      { job: DATES, outcome: "reached-main" },
      { job: LIVENESS, outcome: "reached-main" },
      { job: ROTATION, outcome: "reached-main" },
      { job: DATES, outcome: "reached-main" },
      { job: ROTATION, outcome: "refused" },
      { job: DATES, outcome: "reached-main" },
      { job: ROTATION, outcome: "reached-main" },
    ];
    const t = tracker();
    const lastOutcome = new Map<string, string>();
    for (const event of history) {
      t.report(event.job, event.outcome);
      lastOutcome.set(event.job, event.outcome);
      const frozen = [...lastOutcome.entries()].filter(([, outcome]) => outcome === "refused").map(([job]) => job);
      assert.strictEqual(
        t.open().length,
        frozen.length,
        `after ${event.job} ${event.outcome}, ${t.open().length} alarms are open and ${frozen.length} jobs are frozen`,
      );
      for (const job of frozen) {
        assert.ok(
          t.open().some((issue) => issue.title.includes(job)),
          `${job} is frozen and no open alarm says so`,
        );
      }
    }
    assert.deepStrictEqual(t.open(), [], "every job reached main and something is still open");
  });

  it("closes the alarm a morning refusal opened when the same job pushes that evening", () => {
    const t = tracker();
    t.report(ROTATION, "refused", "data-quarantine/rolling-reverification-20260913T110600Z-09fe52f");
    assert.strictEqual(t.open().length, 1);
    t.report(ROTATION, "reached-main", "8b02543");
    assert.deepStrictEqual(t.open(), [], "a refusal and a push the same day left an alarm open overnight");
  });

  describe("how long the catalogue has been frozen", () => {
    let repo = "";
    let shallow = "";

    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600 * 1000).toISOString();

    function commit(work: string, subject: string, when: string): void {
      writeFileSync(join(work, `${Math.random().toString(36).slice(2)}.txt`), `${subject}\n`);
      git(work, "add", "-A");
      const run = spawnSync("git", ["commit", "-q", "-m", subject], {
        cwd: work,
        encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
      });
      assert.strictEqual(run.status, 0, run.stderr);
    }

    before(() => {
      const root = mkdtempSync(join(tmpdir(), "alarm-history-"));
      const origin = join(root, "origin.git");
      repo = join(root, "work");
      spawnSync("git", ["init", "--bare", "--initial-branch=main", origin], { encoding: "utf8" });
      git(root, "clone", origin, repo);
      git(repo, "config", "user.email", "fixture@example.com");
      git(repo, "config", "user.name", "fixture");
      commit(repo, "data(auto): rolling re-verification — 4 verified of 75 drawn", hoursAgo(33));
      commit(repo, "data(auto): page dates — 11 pages whose output moved", hoursAgo(2));
      commit(repo, "a merge that is not a data push", hoursAgo(1));
      git(repo, "push", "origin", "HEAD:main");
      shallow = join(root, "shallow");
      git(root, "clone", "--depth", "1", `file://${origin}`, shallow);
      assert.strictEqual(git(shallow, "rev-parse", "--is-shallow-repository"), "true");
    });

    const statedHours = (body: string): number => {
      const stated = body.match(/Frozen for \*\*([0-9.]+) hours\*\*/);
      assert.ok(stated, `the alarm states no interval:\n${body}`);
      return Number(stated[1]);
    };

    it("measures from the last commit of the refused job, not of whichever job pushed last", () => {
      const t = tracker([], repo);
      t.report(ROTATION, "refused");
      t.report(DATES, "refused");
      const rotation = statedHours(t.commentsOn(1).join("") || t.issues()[0]!.body);
      const dates = statedHours(t.issues()[1]!.body);
      assert.ok(Math.abs(rotation - 33) < 0.2, `the rotation has been frozen 33 hours and its alarm says ${rotation}`);
      assert.ok(Math.abs(dates - 2) < 0.2, `page dates has been frozen 2 hours and its alarm says ${dates}`);
    });

    it("reads past the tip of a shallow checkout, which is the only kind a scheduled run has", () => {
      const t = tracker([], shallow);
      t.report(ROTATION, "refused");
      const stated = statedHours(t.issues()[0]!.body);
      assert.ok(Math.abs(stated - 33) < 0.2, `a one-commit checkout cannot see 33 hours back and the alarm says ${stated}`);
    });

    it("says it cannot measure rather than stating a number it did not measure", () => {
      const t = tracker();
      t.report(ROTATION, "refused");
      const body = t.issues()[0]!.body;
      assert.doesNotMatch(body, /Frozen for/);
      assert.match(body, /cannot be stated here/);
    });

    it("never measures from the run's own refused commit, which is the one that did not reach main", () => {
      const alone = mkdtempSync(join(tmpdir(), "alarm-unpushed-"));
      git(alone, "init", "--initial-branch=main", ".");
      git(alone, "config", "user.email", "fixture@example.com");
      git(alone, "config", "user.name", "fixture");
      commit(alone, "data(auto): rolling re-verification — what this run wrote and could not push", hoursAgo(0));

      const t = tracker([], alone);
      t.report(ROTATION, "refused");
      const body = t.issues()[0]!.body;
      assert.doesNotMatch(body, /Frozen for/, "the alarm measured the freeze from the commit the freeze is about");
      assert.match(body, /cannot be stated here/);
      rmSync(alone, { recursive: true, force: true });
    });
  });
});

describe("#1764 every scheduled data job reports the push that clears its alarm", () => {
  it("tells the reporter when the gate reached main, wherever the gate runs", () => {
    for (const file of GATED_WORKFLOWS) {
      const text = source(file);
      assert.match(
        text,
        /bash scripts\/report-data-push-outcome\.sh "[^"]+" reached-main "\$PUSHED_COMMIT"/,
        `${file} pushes and says nothing, so an alarm it opened yesterday stays open`,
      );
      assert.match(
        text,
        /steps\.gate\.outputs\.pushed_commit != '' \|\| steps\.gate\.outputs\.pushed_nothing == 'true'/,
        `${file} never reaches the step that would close its alarm`,
      );
      assert.match(
        text,
        /if \[ "\$PUSHED_OVER_FAILURES" = "true" \]; then\n\s+bash scripts\/report-data-push-outcome\.sh "[^"]+" shipped-over-failures/,
        `${file} reports a red main on a run that had none, now that the step also runs on a clean push`,
      );
    }
  });

  it("names the commit on every way a push can succeed, not only the clean one", () => {
    const gate = readFileSync(GATE, "utf8");
    const pushed = gate.slice(gate.indexOf("if push_to_main; then"));
    for (const branch of ["held_back_vendors=", "quarantined=false"]) {
      assert.ok(
        pushed.indexOf("pushed_commit=$COMMIT") < pushed.indexOf(branch),
        `a push that reached main under ${branch.replace("=", "")} names no commit, so it closes no alarm`,
      );
    }
  });

  it("clears the same marker the refusal writes", () => {
    const reporter = readFileSync(join(REPO, "scripts", "report-data-push-outcome.sh"), "utf8");
    const refused = reporter.match(/MARKER="(data-push-refused)"/);
    const clears = reporter.match(/CLEARS_MARKER="([a-z-]+)"/);
    assert.ok(refused && clears, "the refusal and the clearing name no marker between them");
    assert.strictEqual(clears[1], refused[1], "the push clears a marker no refusal ever writes");
  });

  it("scopes the refusal alarm to the job and leaves every other outcome shared", () => {
    const reporter = readFileSync(join(REPO, "scripts", "report-data-push-outcome.sh"), "utf8");
    const scoped = [...reporter.matchAll(/^\s*SCOPE="([^"]*)"$/gm)].map((m) => m[1]!);
    assert.deepStrictEqual(scoped, ["", "$JOB_SLUG"], "the outcomes that are scoped to a job are not the ones this work scopes");
  });

  it("looks only at issues the system opened, on every lookup that can change an issue", () => {
    const reporter = readFileSync(join(REPO, "scripts", "report-data-push-outcome.sh"), "utf8");
    const lookups = reporter.match(/gh issue list/g) ?? [];
    const filtered = reporter.match(/select\(\.author\.login == \\"\$OPENED_BY_THE_SYSTEM\\"\)/g) ?? [];
    assert.ok(lookups.length >= 2, `the reporter makes ${lookups.length} issue lookups`);
    assert.strictEqual(
      filtered.length,
      lookups.length,
      `${lookups.length - filtered.length} of ${lookups.length} lookups reach issues nobody's alarm wrote`,
    );
  });

  it("knows the commit each job writes, in the words that job's workflow commits", () => {
    const reporter = readFileSync(join(REPO, "scripts", "report-data-push-outcome.sh"), "utf8");
    const table = new Map(
      [...reporter.matchAll(/^\s*"([^"]+)"\) echo "(data\(auto\): [^"]+)" ;;$/gm)].map((m) => [m[1]!, m[2]!]),
    );
    for (const file of GATED_WORKFLOWS) {
      const text = source(file);
      const job = text.match(/report-data-push-outcome\.sh "([^"]+)" refused/)?.[1];
      assert.ok(job, `${file} reports a refusal for no named job`);
      const subject = table.get(job);
      assert.ok(subject, `${file} reports as "${job}" and the reporter cannot find that job's commits on main`);
      const message = gateStepOf(file).body.match(/"(data\(auto\): [^"]+)"/)?.[1];
      assert.ok(message, `${file} commits under no data(auto) message`);
      assert.ok(
        message.startsWith(subject),
        `${file} commits "${message}" and its alarm looks for "${subject}", so it can never say how long it has been frozen`,
      );
    }
  });
});

describe("#1744 the rotation stores the readings its withheld pages already show", () => {
  const RESTATE = "scripts/restate-superseded-terms.js";

  function restatingWorkflows(): string[] {
    return workflowFiles().filter((f) => source(f).includes(RESTATE));
  }

  function restateStepOf(file: string): WorkflowStep {
    const step = stepsOf(source(file)).find((s) => s.body.includes(RESTATE));
    assert.ok(step, `${file} has no step that runs ${RESTATE}`);
    return step;
  }

  it("runs the pass with --write, so a withheld page has a route out that needs no human", () => {
    const restating = restatingWorkflows();
    assert.ok(restating.length > 0, `no workflow runs ${RESTATE}, so nothing clears a withheld entry`);
    for (const file of restating) {
      assert.match(
        restateStepOf(file).body,
        new RegExp(`${RESTATE.replace(/[.]/g, "\\.")}\\s+--write`),
        `${file} runs the restatement pass and stores nothing — the entries it counts stay withheld for ever`,
      );
    }
  });

  it("commits every file the write writes, so no half of the write is left in the workspace", async () => {
    const { indexPath, restatementsPath } = await import("../scripts/restate-superseded-terms.js");
    const { corroborationPath } = await import("../scripts/change-corroboration.js");
    const written = [indexPath(), restatementsPath(), corroborationPath()].map((p) =>
      relative(REPO, p).split(sep).join("/"),
    );
    for (const file of restatingWorkflows()) {
      const committable = gateStepOf(file).body;
      for (const path of written) {
        assert.ok(
          committable.includes(path),
          `${file} writes ${path} and may not commit it, so the write reaches main in pieces`,
        );
      }
    }
  });

  it("says in the commit how many entries it restated, not only how many it could have", () => {
    for (const file of restatingWorkflows()) {
      const step = restateStepOf(file).body;
      assert.match(step, /\^Restated this run: /, `${file} never reads back what the write actually stored`);
      const message = gateStepOf(file).body.match(/"(data\(auto\): [^"]+)"/)?.[1] ?? "";
      const counted = [...step.matchAll(/echo "([a-z_]+)=\$/g)].map((m) => m[1]!);
      assert.ok(counted.includes("restated"), `${file} reads back no count of what the write stored`);
      for (const name of counted) {
        assert.ok(
          message.includes(`\${${name.toUpperCase()}}`),
          `${file} counts ${name} and the commit it writes never says it`,
        );
      }
    }
  });
});

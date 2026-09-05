import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  gateVerdict, parseNonBlockingTests, readNonBlockingTests,
} from "../src/data-push-gate.ts";
import { qualityBudgetsPath } from "../src/page-reviews.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const WORKFLOWS = join(REPO, ".github", "workflows");
const GATE = join(REPO, "scripts", "gate-data-push.sh");

const GATED_WORKFLOWS = ["reverify.yml", "liveness.yml", "analytics-rollup.yml"];

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
    for (const file of GATED_WORKFLOWS) {
      assert.ok(files.includes(file), `${file} is not among ${files.join(", ")}`);
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
      /--test-reporter=\.\/scripts\/reporters\/failing-test-files\.js/,
      "the gate's suite does not record which files failed, so it cannot tell what held the commit",
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
      assert.match(text, /issues: write/, `${file} cannot open the issue it is told to open`);
    }
  });

  it("gives the two outcomes different markers, so neither buries the other", () => {
    const reporter = readFileSync(join(REPO, "scripts", "report-data-push-outcome.sh"), "utf8");
    const markers = [...reporter.matchAll(/MARKER="([a-z-]+)"/g)].map((m) => m[1]!);
    assert.deepStrictEqual(markers, ["data-push-refused", "data-push-over-failures"]);
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

const FAILING_BY_MODE: Record<string, string[]> = {
  green: [],
  red: ["test/the-data-this-run-wrote-is-wrong.test.ts"],
  excused: ["test/how-current-our-reading-is.test.ts"],
  mixed: ["test/how-current-our-reading-is.test.ts", "test/the-data-this-run-wrote-is-wrong.test.ts"],
  crashed: [],
};

const GATE_CONFIGURATION = ["GATE_RATCHET_BUDGETS", "GATE_UPDATE_PAGE_LASTMOD"];

const SUITE = `import { appendFileSync, writeFileSync } from "node:fs";
const modes = ${JSON.stringify(FAILING_BY_MODE)};
const mode = process.env.GATE_FIXTURE_TESTS || "green";
const failing = modes[mode];
writeFileSync(process.env.GATE_FAILING_FILES, failing.map((f) => f + "\\n").join(""));
writeFileSync(
  process.env.GATE_FIXTURE_ENV_REPORT,
  ${JSON.stringify(GATE_CONFIGURATION)}.filter((name) => process.env[name]).join(","),
);
appendFileSync(process.env.GITHUB_OUTPUT, "a_test_spawned_a_script_that_wrote_this=yes\\n");
console.log("\\u2139 tests 2");
console.log("\\u2139 pass " + (mode === "green" ? 2 : 1));
console.log("\\u2139 fail " + (mode === "green" ? 0 : 1));
if (mode !== "green") {
  console.log("\\u2716 failing tests:");
  for (const f of failing) console.log("the fixture assertion in " + f);
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

const RATCHET = `import { writeFileSync } from "node:fs";
const mode = process.env.GATE_FIXTURE_RATCHET || "lower";
if (mode === "throw") {
  console.log("the fixture ratchet could not read the data it measures");
  process.exit(1);
}
if (mode === "lower") {
  writeFileSync("data/quality_budgets.json", ${JSON.stringify(BUDGETS_AFTER)});
  console.log("Lowered fixture_pages 57 -> 56");
}
`;

const ALLOWLIST = JSON.stringify(
  {
    version: 1,
    rule: "the fixture stands in for the shipped list, so the behaviour under test does not move when that list does",
    tests: [
      {
        file: "test/how-current-our-reading-is.test.ts",
        reason: "everything it fires on is unread rather than incorrect",
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

let scratch: string;

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.strictEqual(run.status, 0, `git ${args.join(" ")} -> ${run.status}: ${run.stderr}`);
  return run.stdout.trim();
}

function fixtureRepo(): { work: string; origin: string } {
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
  writeFileSync(join(work, "allowlist.json"), ALLOWLIST);
  writeFileSync(join(work, "data", "health.json"), '{"checked":1}\n');
  writeFileSync(join(work, "data", "quality_budgets.json"), BUDGETS_BEFORE);
  writeFileSync(join(work, "data", "page-lastmod.json"), '{"version":1,"pages":{}}\n');
  writeFileSync(join(work, "untracked-by-the-gate.txt"), "before\n");
  git(work, "add", "-A");
  git(work, "commit", "-m", "fixture");
  git(work, "push", "origin", "HEAD:main");
  return { work, origin };
}

type GateMode = keyof typeof FAILING_BY_MODE;

type RatchetMode = "lower" | "throw";

interface GateRun {
  mode: GateMode;
  build?: "fail";
  ratchet?: RatchetMode;
  lastmod?: true;
}

function runGate(work: string, mode: GateMode | GateRun, ...args: string[]) {
  const opts: GateRun = typeof mode === "string" ? { mode } : mode;
  const outputs = join(work, "step-outputs.txt");
  const envReport = join(work, "the-environment-the-suite-ran-in.txt");
  const run = spawnSync("bash", [GATE, ...args], {
    cwd: work,
    encoding: "utf8",
    env: {
      ...process.env,
      GATE_FIXTURE_TESTS: opts.mode,
      GATE_FIXTURE_BUILD: opts.build ?? "ok",
      GATE_FIXTURE_RATCHET: opts.ratchet ?? "lower",
      GATE_FIXTURE_ENV_REPORT: envReport,
      GATE_RATCHET_BUDGETS: opts.ratchet === undefined ? "" : "1",
      GATE_UPDATE_PAGE_LASTMOD: opts.lastmod ? "1" : "",
      GITHUB_OUTPUT: outputs,
      AGENTDEALS_NON_BLOCKING_TESTS_PATH: join(work, "allowlist.json"),
      AGENTDEALS_PAGE_LASTMOD_PATH: join(work, "data", "page-lastmod.json"),
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
  });

  it("commits nothing when the run produced no data change, and leaves the suite unrun", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);

    const run = runGate(work, "red", "data-quarantine/fixture", "data(auto): fixture", "data/health.json");

    assert.strictEqual(run.status, 0, run.stdout + run.stderr);
    assert.strictEqual(mainSha(origin), before);
    assert.match(run.stdout, /nothing to commit or push/);
    assert.doesNotMatch(run.stdout, /tests 2/, "the gate ran the suite with nothing to push");
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

describe("#1321 a measurement of our own reading does not stop the catalogue advancing", () => {
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "gate-split-"));
  });

  after(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  it("puts the data on main when the only red test measures how current our reading is", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);
    writeFileSync(join(work, "data", "health.json"), '{"checked":5}\n');

    const run = runGate(work, "excused", "data-quarantine/fixture", "data(auto): fixture", "data/health.json");

    assert.strictEqual(run.status, 0, `the gate held the data back: ${run.stdout}${run.stderr}`);
    assert.notStrictEqual(mainSha(origin), before, "the data did not reach main");
    assert.strictEqual(git(origin, "show", "main:data/health.json"), '{"checked":5}');
    assert.deepStrictEqual(quarantineRefs(origin, "data-quarantine/fixture"), []);
    assert.match(run.stdout, /how-current-our-reading-is/, "the failure that did not hold the commit is not named");
    assert.match(run.stdout, /none of them says this data is wrong/);
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

  it("holds the data back when one excused failure arrives beside one that is not", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);
    writeFileSync(join(work, "data", "health.json"), '{"checked":7}\n');

    const run = runGate(work, "mixed", "data-quarantine/fixture", "data(auto): fixture", "data/health.json");

    assert.strictEqual(run.status, 1, "an excused failure carried a real one onto main with it");
    assert.strictEqual(mainSha(origin), before);
    assert.match(run.stdout, /the-data-this-run-wrote-is-wrong/);
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

  it("holds the data back when the build does not compile, whatever the allowlist says", () => {
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

  it("tells the refusal issue which of the three things went wrong, not just that something did", () => {
    const gate = readFileSync(GATE, "utf8");
    const reasons = [...gate.matchAll(/^\s*quarantine "([^"]+)"$/gm)].map((m) => m[1]!);
    assert.deepStrictEqual(
      reasons.sort(),
      ["the build does not compile", "the quality budgets could not be measured", "the suite refused it"],
      "the gate can hold a commit for a reason the issue it opens cannot name",
    );
    assert.match(gate, /echo "quarantine_reason=\$why"/, "the reason never reaches the step output");
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
  ];

  it("hands the suite neither variable, so a nested run reads its own arguments", () => {
    const { work } = fixtureRepo();
    writeFileSync(join(work, "data", "health.json"), '{"checked":21}\n');

    const run = runGate(work, { mode: "green", ratchet: "lower", lastmod: true }, ...PATHS);

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

    const run = runGate(work, { mode: "green", ratchet: "lower", lastmod: true }, ...PATHS);

    assert.strictEqual(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /Lowering any quality budget/, "the gate no longer lowers the budget its data earned");
    assert.match(run.stdout, /Reading every page this run renders/, "the gate no longer dates the pages this run moved");
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

describe("#1321 which failures are allowed not to hold a data commit", () => {
  const shipped = readNonBlockingTests();

  it("names test files that exist, so a rename cannot silently widen the gate", () => {
    for (const t of shipped.tests) {
      assert.ok(existsSync(join(REPO, t.file)), `${t.file} is excused from holding a data commit and does not exist`);
    }
  });

  it("keeps the list short enough to read, and gives a reason for every entry", () => {
    assert.ok(shipped.tests.length > 0, "nothing is excused, so the split has no subject");
    assert.ok(shipped.tests.length <= 5, `${shipped.tests.length} files are excused; the list is meant to be read`);
    for (const t of shipped.tests) {
      assert.ok(t.reason.length > 40, `${t.file} is excused with ${t.reason.length} characters of reason`);
    }
  });

  it("lives where no scheduled job can write it, so widening the gate takes a pull request", () => {
    assert.match(readFileSync(join(REPO, "src", "data-push-gate.ts"), "utf8"), /"scripts", "gate-non-blocking-tests\.json"/);
    for (const file of GATED_WORKFLOWS) {
      const gated = source(file).match(/gate-data-push\.sh[\s\S]*?\n\n/)?.[0] ?? "";
      assert.doesNotMatch(gated, /\bscripts\//, `${file} hands the gate a path under scripts/, which it could then commit`);
    }
  });

  it("holds the commit for a file nobody excused", () => {
    const verdict = gateVerdict(["test/somewhere-else.test.ts"], shipped);
    assert.strictEqual(verdict.decision, "quarantine");
    assert.deepStrictEqual(verdict.blocking, ["test/somewhere-else.test.ts"]);
  });

  it("lets the commit through when every failing file is excused", () => {
    const verdict = gateVerdict(shipped.tests.map((t) => t.file), shipped);
    assert.strictEqual(verdict.decision, "push");
    assert.deepStrictEqual(verdict.blocking, []);
  });

  it("holds the commit when the suite failed and named nothing", () => {
    const verdict = gateVerdict([], shipped);
    assert.strictEqual(verdict.decision, "quarantine");
    assert.match(verdict.reason, /named no test file/);
  });

  it("refuses a list that excuses something outside test/", () => {
    assert.throws(
      () => parseNonBlockingTests(JSON.stringify({ version: 1, rule: "r", tests: [{ file: "src/serve.ts", reason: "x" }] }), "fixture"),
      /not a path under test\//,
    );
  });

  it("refuses a list that excuses a file with no reason", () => {
    assert.throws(
      () => parseNonBlockingTests(JSON.stringify({ version: 1, rule: "r", tests: [{ file: "test/a.test.ts" }] }), "fixture"),
      /with no reason/,
    );
  });

  it("counts the two ratchets the scheduled jobs can trip among the excused files", () => {
    const excused = new Set(shipped.tests.map((t) => t.file));
    assert.ok(excused.has("test/stale-page-facts.test.ts"), "the cohort this issue is about still holds the commit");
    assert.ok(excused.has("test/page-data-provenance.test.ts"));
  });
});

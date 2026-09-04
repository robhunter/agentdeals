import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const WORKFLOWS = join(REPO, ".github", "workflows");
const GATE = join(REPO, "scripts", "gate-data-push.sh");

const GATED_WORKFLOWS = ["reverify.yml", "liveness.yml", "analytics-rollup.yml"];

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
    assert.ok(
      gate.indexOf("npm test") < gate.indexOf("HEAD:main"),
      "the gate pushes to main before it runs the suite",
    );
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

const SUITE = `const red = process.env.GATE_FIXTURE_TESTS === "red";
console.log("\\u2139 tests 2");
console.log("\\u2139 pass " + (red ? 1 : 2));
console.log("\\u2139 fail " + (red ? 1 : 0));
if (red) {
  console.log("\\u2716 failing tests:");
  console.log("the fixture assertion the data broke");
  process.exit(1);
}
`;

const PACKAGE = JSON.stringify(
  { name: "gate-fixture", version: "1.0.0", private: true, scripts: { build: "node --version", test: "node suite.js" } },
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
  writeFileSync(join(work, "data", "health.json"), '{"checked":1}\n');
  writeFileSync(join(work, "untracked-by-the-gate.txt"), "before\n");
  git(work, "add", "-A");
  git(work, "commit", "-m", "fixture");
  git(work, "push", "origin", "HEAD:main");
  return { work, origin };
}

function runGate(work: string, red: boolean, ...args: string[]) {
  return spawnSync("bash", [GATE, ...args], {
    cwd: work,
    encoding: "utf8",
    env: { ...process.env, GATE_FIXTURE_TESTS: red ? "red" : "green" },
  });
}

function mainSha(origin: string): string {
  return git(origin, "rev-parse", "main");
}

function branchExists(origin: string, branch: string): boolean {
  return spawnSync("git", ["rev-parse", "--verify", branch], { cwd: origin, encoding: "utf8" }).status === 0;
}

describe("#1317 the gate, run against a repository", () => {
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "gate-data-push-"));
  });

  after(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  it("stops a data change the suite refuses, and holds it on the quarantine branch", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);
    writeFileSync(join(work, "data", "health.json"), '{"checked":2}\n');

    const run = runGate(work, true, "data-quarantine/fixture", "data(auto): fixture", "data/health.json");

    assert.strictEqual(run.status, 1, `the gate let a red suite through: ${run.stdout}${run.stderr}`);
    assert.strictEqual(mainSha(origin), before, "main moved on a commit the suite refused");
    assert.ok(branchExists(origin, "data-quarantine/fixture"), "the refused commit was not held anywhere");
    assert.strictEqual(
      git(origin, "show", "data-quarantine/fixture:data/health.json"),
      '{"checked":2}',
      "the quarantine branch does not carry the data the run produced",
    );
    assert.match(run.stdout, /the fixture assertion the data broke/, "the failing test is not named in the log");
    assert.match(run.stdout, /main is unchanged/);
  });

  it("pushes a data change the suite accepts", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);
    writeFileSync(join(work, "data", "health.json"), '{"checked":3}\n');

    const run = runGate(work, false, "data-quarantine/fixture", "data(auto): fixture", "data/health.json");

    assert.strictEqual(run.status, 0, `the gate refused a green suite: ${run.stdout}${run.stderr}`);
    assert.notStrictEqual(mainSha(origin), before);
    assert.strictEqual(git(origin, "show", "main:data/health.json"), '{"checked":3}');
    assert.strictEqual(git(origin, "log", "-1", "--format=%s", "main"), "data(auto): fixture");
    assert.ok(!branchExists(origin, "data-quarantine/fixture"), "a green run opened a quarantine branch");
  });

  it("commits nothing when the run produced no data change, and leaves the suite unrun", () => {
    const { work, origin } = fixtureRepo();
    const before = mainSha(origin);

    const run = runGate(work, true, "data-quarantine/fixture", "data(auto): fixture", "data/health.json");

    assert.strictEqual(run.status, 0, run.stdout + run.stderr);
    assert.strictEqual(mainSha(origin), before);
    assert.match(run.stdout, /nothing to commit or push/);
    assert.doesNotMatch(run.stdout, /tests 2/, "the gate ran the suite with nothing to push");
  });

  it("commits only the paths it was given, so an unrelated file cannot ride along", () => {
    const { work, origin } = fixtureRepo();
    writeFileSync(join(work, "data", "health.json"), '{"checked":4}\n');
    writeFileSync(join(work, "untracked-by-the-gate.txt"), "after\n");

    const run = runGate(work, false, "data-quarantine/fixture", "data(auto): fixture", "data/health.json");

    assert.strictEqual(run.status, 0, run.stdout + run.stderr);
    assert.strictEqual(git(origin, "show", "main:untracked-by-the-gate.txt"), "before");
    assert.strictEqual(git(work, "diff", "--name-only"), "untracked-by-the-gate.txt");
  });

  it("refuses to run without a quarantine branch, a message and a path", () => {
    const { work } = fixtureRepo();
    const run = runGate(work, false, "data-quarantine/fixture", "data(auto): fixture");
    assert.strictEqual(run.status, 2);
    assert.match(run.stderr, /usage: gate-data-push\.sh/);
  });
});

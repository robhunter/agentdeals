import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shipped = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
const command = (cwd: string, ...args: string[]) => {
  const run = spawnSync(args[0], args.slice(1), { cwd, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, `${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
};

function exercise(action: string, red = false) {
  const root = mkdtempSync(path.join(tmpdir(), "data-gate-candidate-"));
  try {
    const origin = path.join(root, "origin.git");
    const work = path.join(root, "work");
    mkdirSync(path.join(work, "data"), { recursive: true });
    mkdirSync(path.join(work, "test"));
    mkdirSync(path.join(work, "scripts", "reporters"), { recursive: true });
    for (const file of ["with-unchanged-data.js", "reject-tracked-data-writes.js", "local-test-fetch.js", "reporters/failing-tests.js"]) {
      writeFileSync(path.join(work, "scripts", file), readFileSync(path.join(ROOT, "scripts", file)));
    }
    mkdirSync(path.join(work, "dist"));
    writeFileSync(path.join(work, "dist", "data-push-gate.js"), readFileSync(path.join(ROOT, "dist", "data-push-gate.js")));
    writeFileSync(path.join(work, "package.json"), JSON.stringify({ type: "module", scripts: { build: "node -e ''", "test:gated": shipped["test:gated"] } }));
    writeFileSync(path.join(work, "data", "index.json"), '{"value":"baseline"}\n');
    writeFileSync(path.join(work, "runtime.json"), '{"value":"checked"}\n');
    writeFileSync(path.join(work, "test", "candidate.test.ts"), `
import { it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
it('reads the candidate runtime and data', () => {
  assert.equal(JSON.parse(readFileSync('runtime.json', 'utf8')).value, 'checked');
  assert.equal(JSON.parse(readFileSync('data/index.json', 'utf8')).value, 'prepared');
  writeFileSync(process.env.CANDIDATE_RECEIPT, JSON.stringify({ commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') }));
  if (process.env.CANDIDATE_RED === 'yes') assert.fail('Fixture refuses the candidate');
});
after(() => {
  const action = process.env.CANDIDATE_ACTION;
  if (action === 'unchanged') return;
  if (action === 'remote') {
    if (!existsSync(process.env.CANDIDATE_MOVED)) {
      writeFileSync(process.env.CANDIDATE_MOVED, 'yes');
      writeFileSync(process.env.CANDIDATE_OTHER + '/external.txt', 'remote change');
      git('-C', process.env.CANDIDATE_OTHER, 'add', 'external.txt');
      git('-C', process.env.CANDIDATE_OTHER, 'commit', '-qm', 'Fixture remote publication');
      git('-C', process.env.CANDIDATE_OTHER, 'push', 'origin', 'main');
    }
    return;
  }
  if (action === 'empty-commit') { git('commit', '--allow-empty', '-qm', 'Fixture empty commit'); return; }
  if (action === 'deleted') { unlinkSync('runtime.json'); return; }
  const before = readFileSync('runtime.json');
  writeFileSync('runtime.json', '{"value":"never tested"}\\n');
  if (['staged', 'committed', 'index-only'].includes(action)) git('add', 'runtime.json');
  if (action === 'index-only') writeFileSync('runtime.json', before);
  if (action === 'committed') git('commit', '-qm', 'Fixture hook changes runtime');
});
`);
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    command(root, "git", "init", "--bare", "--initial-branch=main", origin);
    command(work, "git", "init", "--initial-branch=main");
    command(work, "git", "config", "user.email", "fixture@example.com");
    command(work, "git", "config", "user.name", "Fixture");
    command(work, "git", "remote", "add", "origin", origin);
    command(work, "git", "add", ".");
    command(work, "git", "commit", "-qm", "Fixture baseline");
    command(work, "git", "push", "-u", "origin", "main");
    const before = command(origin, "git", "rev-parse", "main");
    const other = path.join(root, "other");
    if (action === "remote") {
      command(root, "git", "clone", origin, other);
      command(other, "git", "config", "user.email", "fixture@example.com");
      command(other, "git", "config", "user.name", "Fixture");
    }
    writeFileSync(path.join(work, "data", "index.json"), '{"value":"prepared"}\n');
    const outputs = path.join(root, "outputs");
    const receipt = path.join(root, "candidate.json");
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: outputs, CANDIDATE_RECEIPT: receipt, CANDIDATE_ACTION: action, CANDIDATE_OTHER: other, CANDIDATE_MOVED: path.join(root, "moved"), CANDIDATE_RED: red ? "yes" : "no", GATE_DRIFTED_GUARDS: path.join(root, "drift.md") };
    for (const key of ["GATE_RATCHET_BUDGETS", "GATE_UPDATE_PAGE_LASTMOD", "GATE_REGENERATE_LLM_INDEX", "GATE_SYNC_PAGE_REVIEWS", "NODE_TEST_CONTEXT"]) delete env[key];
    const run = spawnSync("bash", [path.join(ROOT, "scripts", "gate-data-push.sh"), "data-quarantine/fixture", "Fixture prepared data", "data/index.json"], { cwd: work, env, encoding: "utf8", timeout: 60_000 });
    const tested = JSON.parse(readFileSync(receipt, "utf8"));
    const outcome = readFileSync(outputs, "utf8");
    const published = command(origin, "git", "rev-parse", "main");
    const refs = command(origin, "git", "for-each-ref", "--format=%(refname)", "refs/heads/data-quarantine/").split("\n").filter(Boolean);
    if (action === "unchanged" || action === "remote") {
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.equal(published, tested.commit);
      assert.equal(command(origin, "git", "rev-parse", "main^{tree}"), tested.tree);
      assert.ok(outcome.includes(`pushed_commit=${published}\n`));
      assert.equal(refs.length, 0);
      if (action === "remote") {
        assert.equal(command(origin, "git", "show", "main:external.txt"), "remote change");
        assert.match(run.stdout, /Replaying this run's commit/);
      }
      assert.equal(command(origin, "git", "show", "main:runtime.json"), '{"value":"checked"}');
    } else {
      assert.equal(run.status, 1, run.stdout + run.stderr);
      assert.equal(published, before);
      assert.equal(refs.length, 1);
      assert.equal(command(origin, "git", "rev-parse", refs[0]), tested.commit);
      assert.equal(command(origin, "git", "rev-parse", `${refs[0]}^{tree}`), tested.tree);
      assert.doesNotMatch(outcome, /pushed_commit=|held_back_vendors=|pushed_over_failures=/);
      assert.match(outcome, /the suite changed its candidate commit or tracked tree/);
      assert.doesNotMatch(run.stdout, /Replaying this run's commit/);
      assert.equal(command(origin, "git", "show", `${refs[0]}:runtime.json`), '{"value":"checked"}');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("the data gate publishes the candidate read by the actual npm suite", () => {
  it("publishes an unchanged candidate and reports the actual pushed commit", () => exercise("unchanged"));
  it("tests and publishes a fresh candidate after replaying onto remote main", () => exercise("remote"));
  for (const action of ["committed", "empty-commit", "unstaged", "staged", "deleted", "index-only"]) {
    for (const red of [false, true]) {
      it(`refuses ${action} tracked mutation after a ${red ? "red" : "green"} suite`, () => exercise(action, red));
    }
  }
});

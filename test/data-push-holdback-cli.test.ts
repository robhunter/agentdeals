import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const STORE = "data/official_mcp_checks.json";
const INDEX = "data/index.json";
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const proposal = (vendor: string, reason: string) => ({ vendor, key: `${vendor}-entry`, reason });
const prior = proposal("Held", "previous failure");
const fresh = proposal("Held", "new failure");
const kept = proposal("Kept", "independent failure");
const steady = proposal("Steady", "unchanged failure");
const checks = { "entry-key": { checked_on: "2026-10-30", passed: false, failure_streak: 2, withheld: true } };

const cases = [
  { name: "reverts an edited proposal while keeping the other vendor's new proposal", before: [prior, steady], after: [fresh, kept, steady], expected: [prior, kept, steady] },
  { name: "removes new held proposals from a previously empty store", before: [], after: [fresh, kept], expected: [kept] },
  { name: "restores a deleted proposal", before: [prior, steady], after: [kept, steady], expected: [kept, steady, prior] },
  { name: "restores all held entries across case differences", before: [prior, { ...prior, key: "second-entry" }], after: [{ ...fresh, vendor: "HELD" }, kept], expected: [prior, { ...prior, key: "second-entry" }, kept] },
  { name: "preserves an empty proposal array when the catalogue supplies the held vendors", before: [], after: [], expected: [] },
  { name: "detects movement confined to the proposal store", before: [prior], after: [fresh, kept], expected: [prior, kept], proposalsOnly: true },
];

function fixture(before: unknown[], after: unknown[], proposalsOnly = false) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-proposal-holdback-"));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
  function git(...args: string[]) {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd: dir, env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  for (const part of ["data", "scripts", "dist"]) mkdirSync(join(dir, part));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  copyFileSync(join(REPO, "scripts/gate-hold-back-vendors.js"), join(dir, "scripts/gate-hold-back-vendors.js"));
  copyFileSync(join(REPO, "dist/data-push-holdback.js"), join(dir, "dist/data-push-holdback.js"));
  writeFileSync(join(dir, STORE), json({ checks: { "entry-key": { passed: true } }, proposals: before }));
  writeFileSync(join(dir, INDEX), json({ offers: [{ vendor: "Held", description: "before" }, { vendor: "Kept", description: "before" }] }));
  git("init", "--initial-branch=main");
  git("add", ".");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "baseline");
  const baseline = git("rev-parse", "HEAD");
  const current = json({ checks, proposals: after });
  writeFileSync(join(dir, STORE), current);
  if (!proposalsOnly) writeFileSync(join(dir, INDEX), json({ offers: [{ vendor: "Held", description: "after" }, { vendor: "Kept", description: "after" }] }));
  const runIndex = readFileSync(join(dir, INDEX), "utf8");
  function run(paths = [INDEX, STORE], blamed = "Held") {
    writeFileSync(join(dir, "failures.log"), `✖ failing tests:\nAssertionError: ${blamed}\n`);
    return spawnSync(process.execPath, ["scripts/gate-hold-back-vendors.js", "--baseline", baseline, "--failures", "failures.log", "--vendors-to", "vendors.txt", "--", ...paths], { cwd: dir, env, encoding: "utf8", timeout: 10_000 });
  }
  return { dir, baseline, git, current, runIndex, run };
}

for (const subject of cases) {
  it(subject.name, (t) => {
    const f = fixture(subject.before, subject.after, subject.proposalsOnly);
    t.after(() => rmSync(f.dir, { recursive: true, force: true }));
    const result = f.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(join(f.dir, STORE), "utf8"), json({ checks, proposals: subject.expected }));
    assert.match(readFileSync(join(f.dir, "vendors.txt"), "utf8"), /^held\n$/i);
    const index = JSON.parse(readFileSync(join(f.dir, INDEX), "utf8"));
    assert.deepEqual(index.offers, [{ vendor: "Held", description: "before" }, { vendor: "Kept", description: subject.proposalsOnly ? "before" : "after" }]);
    assert.equal(f.git("rev-parse", "HEAD"), f.baseline);
    assert.equal(f.git("remote"), "");
  });
}

it("leaves proposals outside the committable paths byte-identical", (t) => {
  const f = fixture([prior], [fresh, kept]);
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const result = f.run([INDEX]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(f.dir, STORE), "utf8"), f.current);
});

for (const blamed of ["Unknown", "Held Kept"]) {
  it(`leaves the complete batch intact when the failure names ${blamed}`, (t) => {
    const f = fixture([prior], [fresh, kept]);
    t.after(() => rmSync(f.dir, { recursive: true, force: true }));
    const result = f.run(undefined, blamed);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(readFileSync(join(f.dir, STORE), "utf8"), f.current);
    assert.equal(readFileSync(join(f.dir, INDEX), "utf8"), f.runIndex);
    assert.equal(existsSync(join(f.dir, "vendors.txt")), false);
  });
}

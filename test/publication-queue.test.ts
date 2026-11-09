import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const MERGER = join(REPO, "scripts/merge-reviewed.js");
const PUBLISHER = join(REPO, "scripts/push-tested-tree.sh");

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "publication-queue-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const sibling = join(root, "sibling");
  const bin = join(root, "bin");
  mkdirSync(bin);
  git(root, "init", "--bare", "--initial-branch=main", origin);
  git(root, "clone", origin, work);
  git(work, "config", "user.name", "Fixture");
  git(work, "config", "user.email", "fixture@example.com");
  mkdirSync(join(work, "scripts"));
  writeFileSync(join(work, "scripts/test-marked-conditions.mjs"), `process.exit(process.env.QUEUE_MODE === "marked-red" ? 1 : 0);\n`);
  writeFileSync(join(work, "app.txt"), "base\n");
  git(work, "add", ".");
  git(work, "commit", "-m", "base");
  git(work, "push", "origin", "HEAD:main");
  const base = git(origin, "rev-parse", "main");
  git(root, "clone", origin, sibling);
  git(sibling, "config", "user.name", "Fixture");
  git(sibling, "config", "user.email", "fixture@example.com");
  git(work, "checkout", "-b", "feature");
  writeFileSync(join(work, "app.txt"), "reviewed\n");
  git(work, "add", ".");
  git(work, "commit", "-m", "feature");
  git(work, "push", "origin", "HEAD:feature");
  const head = git(work, "rev-parse", "HEAD");
  const reviewedAt = new Date(Date.now() - 10000).toISOString();
  const pr = {
    state: "open", draft: false, base: { ref: "main" },
    head: { sha: head, repo: { full_name: "example/catalogue" } },
    title: "Publish tested data", body: "Refs #12", updated_at: "2026-01-01T00:00:00Z",
  };
  const prFile = join(root, "pr.json");
  const commentsFile = join(root, "comments.json");
  const reviewsFile = join(root, "reviews.json");
  const log = join(root, "calls.jsonl");
  writeFileSync(prFile, JSON.stringify(pr));
  writeFileSync(commentsFile, "[]");
  writeFileSync(reviewsFile, "[]");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
import { readFileSync, appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.QUEUE_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "pr") { console.log(JSON.stringify([{ name: "test", bucket: process.env.QUEUE_MODE === "ci-red" ? "fail" : "pass" }])); process.exit(0); }
if (args[0] === "workflow") process.exit(process.env.QUEUE_MODE === "dispatch-red" ? 1 : 0);
const path = args.at(-1);
if (/\\/pulls\\/34$/.test(path)) console.log(readFileSync(process.env.QUEUE_PR, "utf8"));
else if (/\\/issues\\/12$/.test(path)) console.log(JSON.stringify({ updated_at: process.env.QUEUE_MODE === "issue-edited" ? new Date().toISOString() : "2026-01-01T00:00:00Z" }));
else if (/\\/pulls\\/34\\/comments\\?/.test(path)) console.log((process.env.QUEUE_MODE === "inline-added" || (process.env.QUEUE_MODE === "inline-during" && readFileSync(process.env.QUEUE_LOG, "utf8").includes("tested-tree"))) ? JSON.stringify([[{ updated_at: new Date().toISOString() }]]) : "[[]]");
else if (/\\/comments\\?/.test(path)) console.log("[" + readFileSync(process.env.QUEUE_COMMENTS, "utf8") + "]");
else if (/\\/reviews\\?/.test(path)) console.log("[" + readFileSync(process.env.QUEUE_REVIEWS, "utf8") + "]");
else process.exit(2);
`, { mode: 0o755 });
  writeFileSync(join(bin, "npm"), `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const args = process.argv.slice(2);
appendFileSync(process.env.QUEUE_LOG, JSON.stringify(["npm", ...args]) + "\\n");
if (args[0] === "test") {
  if (process.env.TEST_SHARD) process.exit(3);
  appendFileSync(process.env.QUEUE_LOG, JSON.stringify(["tested-tree", execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim()]) + "\\n");
  const mode = process.env.QUEUE_MODE;
  if (mode === "red") process.exit(1);
  if (mode === "dirty") writeFileSync("app.txt", "unreviewed\\n");
  if (mode === "head-changed") {
    const pr = JSON.parse(readFileSync(process.env.QUEUE_PR, "utf8"));
    pr.head.sha = "a".repeat(40);
    writeFileSync(process.env.QUEUE_PR, JSON.stringify(pr));
  }
  if (mode === "comment-added") writeFileSync(process.env.QUEUE_COMMENTS, JSON.stringify([{ updated_at: new Date().toISOString() }]));
  if (mode === "review-added") writeFileSync(process.env.QUEUE_REVIEWS, JSON.stringify([{ submitted_at: new Date().toISOString() }]));
  if (mode === "main-moved") {
    const cwd = process.env.QUEUE_SIBLING;
    writeFileSync(cwd + "/sibling.txt", "concurrent\\n");
    for (const command of [["add", "."], ["commit", "-m", "concurrent"], ["push", "origin", "HEAD:main"]]) execFileSync("git", command, { cwd, stdio: "pipe" });
  }
}
`, { mode: 0o755 });
  function invoke(mode = "green", args = ["34", head, reviewedAt]) {
    return spawnSync("node", [MERGER, ...args], {
      cwd: work, encoding: "utf8", timeout: 30000,
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: "example/catalogue",
        GITHUB_STEP_SUMMARY: join(root, "summary.md"), TEST_SHARD: "1/3",
        QUEUE_MODE: mode, QUEUE_PR: prFile, QUEUE_COMMENTS: commentsFile, QUEUE_REVIEWS: reviewsFile,
        QUEUE_LOG: log, QUEUE_SIBLING: sibling,
      },
    });
  }
  return { root, work, sibling, origin, head, base, pr, prFile, commentsFile, reviewsFile, log, reviewedAt, invoke };
}

describe("data publishers share a retained queue", () => {
  const workflows = join(REPO, ".github/workflows");
  const writers = readdirSync(workflows).filter((file) => /gate-data-push\.sh/.test(readFileSync(join(workflows, file), "utf8")));
  it("serializes every main publisher regardless of dispatch ref before named-ref checkout", () => {
    assert.equal(writers.length, 6);
    for (const file of [...writers, "merge-reviewed.yml"]) {
      const text = readFileSync(join(workflows, file), "utf8");
      if (file !== "archive-settlement.yml") assert.match(text, /^      group: main-publication$/m, file);
      assert.match(text, /^    concurrency:\n      group: .*(?:main-publication)/m, file);
      assert.match(text, /^      queue: max\n      cancel-in-progress: false$/m, file);
      assert.match(text, /uses: actions\/checkout@v4\n        with:\n          ref: \$\{\{ github.ref \}\}/, file);
      assert.ok(text.indexOf("    concurrency:") < text.indexOf("uses: actions/checkout"), file);
    }
  });
  it("keeps read-only archive evaluation outside the publication queue", () => {
    const text = readFileSync(join(workflows, "archive-settlement.yml"), "utf8");
    assert.match(text, /inputs\.reviewed_report != '' && 'main-publication' \|\| format\('archive-read-only-\{0\}', github.run_id\)/);
  });
});

describe("reviewed merge publication uses the exact tested tree", () => {
  it("publishes the complete tested merge and requests every suppressed follow-up workflow", () => {
    const f = fixture();
    try {
      const result = f.invoke();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const published = git(f.origin, "rev-parse", "main");
      assert.equal(git(f.origin, "show", "main:app.txt"), "reviewed");
      assert.equal(git(f.origin, "rev-parse", "main^1"), f.base);
      assert.equal(git(f.origin, "rev-parse", "main^2"), f.head);
      const calls = readFileSync(f.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(calls.find((call) => call[0] === "tested-tree")[1], git(f.origin, "rev-parse", `${published}^{tree}`));
      assert.deepEqual(calls.filter((call) => call[0] === "npm"), [["npm", "ci"], ["npm", "run", "build"], ["npm", "test"]]);
      assert.deepEqual(calls.filter((call) => call[0] === "workflow").map((call) => call[2]), ["tests.yml", "page-lastmod.yml", "llm-api-readme.yml"]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("tests the current main combined with an older reviewed branch", () => {
    const f = fixture();
    try {
      writeFileSync(join(f.sibling, "new.txt"), "new main\n");
      git(f.sibling, "add", ".");
      git(f.sibling, "commit", "-m", "new main");
      git(f.sibling, "push", "origin", "HEAD:main");
      const result = f.invoke();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(git(f.origin, "show", "main:new.txt"), "new main");
      assert.equal(git(f.origin, "show", "main:app.txt"), "reviewed");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  for (const mode of ["red", "marked-red", "dirty", "head-changed", "comment-added", "review-added", "issue-edited", "ci-red", "inline-added", "inline-during"]) {
    it(`refuses publication when ${mode}`, () => {
      const f = fixture();
      try {
        const result = f.invoke(mode);
        assert.notEqual(result.status, 0, result.stdout + result.stderr);
        assert.equal(git(f.origin, "rev-parse", "main"), f.base);
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    });
  }

  it("rejects a competing push atomically instead of publishing an untested merge", () => {
    const f = fixture();
    try {
      const result = f.invoke("main-moved");
      assert.notEqual(result.status, 0);
      assert.equal(git(f.origin, "show", "main:app.txt"), "base");
      assert.equal(git(f.origin, "show", "main:sibling.txt"), "concurrent");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("rejects stale heads, forked heads, edited bodies and drafts before running tests", () => {
    for (const patch of [{ head: { sha: "a".repeat(40), repo: { full_name: "example/catalogue" } } },
      { head: { sha: null, repo: null } }, { updated_at: new Date().toISOString() }, { draft: true }]) {
      const f = fixture();
      try {
        writeFileSync(f.prFile, JSON.stringify({ ...f.pr, ...patch }));
        const result = f.invoke();
        assert.notEqual(result.status, 0);
        assert.equal(git(f.origin, "rev-parse", "main"), f.base);
        assert.doesNotMatch(readFileSync(f.log, "utf8"), /tested-tree/);
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    }
  });

  it("requires reading comments edited after the review even when created earlier", () => {
    const f = fixture();
    try {
      writeFileSync(f.commentsFile, JSON.stringify([{ created_at: "2026-01-01T00:00:00Z", updated_at: new Date().toISOString() }]));
      assert.notEqual(f.invoke().status, 0);
      assert.equal(git(f.origin, "rev-parse", "main"), f.base);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("reports a failed follow-up separately from the already-published merge", () => {
    const f = fixture();
    try {
      const result = f.invoke("dispatch-red");
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /Published https:/);
      assert.equal(git(f.origin, "show", "main:app.txt"), "reviewed");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("refuses publishing a commit different from the tested tree", () => {
    const f = fixture();
    try {
      const result = spawnSync("bash", [PUBLISHER, f.head, git(f.origin, "rev-parse", "main^{tree}")], { cwd: f.work, encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /differs from the tested tree/);
      assert.equal(git(f.origin, "rev-parse", "main"), f.base);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});

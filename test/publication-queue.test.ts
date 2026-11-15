import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(work, "scripts/test-marked-conditions.mjs"), `import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
if (process.env.TEST_SHARD) process.exit(3);
appendFileSync(process.env.QUEUE_LOG, JSON.stringify(["marked-tree", execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim()]) + "\\n");
process.exit(process.env.QUEUE_MODE === "marked-red" ? 1 : 0);\n`);
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
function comments(rows) {
  const since = Date.parse(new URL("https://api.example/" + path).searchParams.get("since"));
  console.log(JSON.stringify([rows.filter(row => Date.parse(row.updated_at) > since)]));
}
if (/\\/pulls\\/34$/.test(path)) console.log(readFileSync(process.env.QUEUE_PR, "utf8"));
else if (/\\/issues\\/12$/.test(path)) console.log(JSON.stringify({ updated_at: process.env.QUEUE_MODE === "issue-boundary" ? process.env.QUEUE_REVIEW_SECOND : process.env.QUEUE_MODE === "issue-edited" ? new Date().toISOString() : "2026-01-01T00:00:00Z" }));
else if (/\\/pulls\\/34\\/comments\\?/.test(path)) comments(process.env.QUEUE_MODE === "inline-boundary" ? [{ updated_at: process.env.QUEUE_REVIEW_SECOND }] : (process.env.QUEUE_MODE === "inline-added" || (process.env.QUEUE_MODE === "inline-during" && readFileSync(process.env.QUEUE_LOG, "utf8").includes("tested-tree"))) ? [{ updated_at: new Date().toISOString() }] : []);
else if (/\\/comments\\?/.test(path)) comments(JSON.parse(readFileSync(process.env.QUEUE_COMMENTS, "utf8")));
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
        GITHUB_RUN_ID: "", GITHUB_STEP_SUMMARY: join(root, "summary.md"), TEST_SHARD: "1/3",
        QUEUE_MODE: mode, QUEUE_PR: prFile, QUEUE_COMMENTS: commentsFile, QUEUE_REVIEWS: reviewsFile,
        QUEUE_LOG: log, QUEUE_SIBLING: sibling,
        QUEUE_REVIEW_SECOND: new Date(Math.floor(Date.parse(reviewedAt) / 1000) * 1000).toISOString(),
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

  for (const surface of ["pull", "issue", "thread", "inline", "review"]) {
    it(`refuses ${surface} edits in the review timestamp's second`, () => {
      const f = fixture();
      try {
        const second = Math.floor(Date.parse(f.reviewedAt) / 1000) * 1000;
        const boundary = new Date(second).toISOString();
        const reviewedAt = new Date(second + 500).toISOString();
        if (surface === "pull") writeFileSync(f.prFile, JSON.stringify({ ...f.pr, updated_at: boundary }));
        if (surface === "thread") writeFileSync(f.commentsFile, JSON.stringify([{ updated_at: boundary }]));
        if (surface === "review") writeFileSync(f.reviewsFile, JSON.stringify([{ submitted_at: boundary }]));
        const result = f.invoke(`${surface}-boundary`, ["34", f.head, reviewedAt]);
        assert.notEqual(result.status, 0, result.stdout + result.stderr);
        assert.equal(git(f.origin, "rev-parse", "main"), f.base);
        assert.doesNotMatch(readFileSync(f.log, "utf8"), /tested-tree/);
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    });
  }

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


function batchFixture() {
  const f = fixture();
  const bin = join(f.root, "bin");
  const metadata = join(f.root, "batch.json");
  const prs: Record<string, typeof f.pr> = { "34": f.pr };
  const runs: any[] = [];
  const heads: string[] = [];
  for (const number of [35, 36]) {
    git(f.sibling, "checkout", "-B", `feature-${number}`, f.base);
    writeFileSync(join(f.sibling, `${number}.txt`), `change ${number}\n`);
    git(f.sibling, "add", ".");
    git(f.sibling, "commit", "-m", `change ${number}`);
    git(f.sibling, "push", "origin", `HEAD:feature-${number}`);
    const head = git(f.sibling, "rev-parse", "HEAD");
    const reviewedAt = new Date(Date.parse(f.reviewedAt) - (37 - number) * 1000).toISOString();
    heads.push(head);
    prs[String(number)] = { ...f.pr, head: { ...f.pr.head, sha: head }, title: `Change ${number}` };
    runs.push({ id: number, run_attempt: 1, event: "workflow_dispatch", head_branch: "main", path: ".github/workflows/merge-reviewed.yml",
      status: "pending", created_at: new Date(Date.parse(f.reviewedAt) + number * 10).toISOString(),
      display_title: `reviewed-pr:${number}:${head}:${reviewedAt}` });
  }
  git(f.sibling, "checkout", "-B", "main", f.base);
  const state = { prs, runs: [runs[1], runs[0]], jobs: [{ name: "publish", status: "pending" }] };
  function save() { writeFileSync(metadata, JSON.stringify(state)); }
  save();
  renameSync(join(bin, "gh"), join(bin, "gh-single"));
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
import { readFileSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(${JSON.stringify(metadata)}, "utf8"));
const path = args.at(-1);
let response;
if (args[0] === "api" && path.includes("actions/workflows/")) {
  if (process.env.QUEUE_MODE === "discovery-red") process.exit(2);
  const status = new URL("https://api.example/" + path).searchParams.get("status");
  const runs = state.runs.filter(run => run.status === status);
  response = [{ workflow_runs: runs.slice(0, 1) }, { workflow_runs: runs.slice(1) }];
} else if (args[0] === "api" && /\\/actions\\/runs\\/[0-9]+$/.test(path)) response = state.runs.find(run => String(run.id) === path.split("/").at(-1));
else if (args[0] === "api" && path.includes("/jobs?")) response = [{ jobs: state.jobs }];
else if (args[0] === "api" && /\\/pulls\\/(35|36)$/.test(path)) response = state.prs[path.split("/").at(-1)];
else if (args[0] === "api" && /\\/pulls\\/(35|36)\\/(comments|reviews)\\?/.test(path)) {
  const number = path.match(/pulls\\/(35|36)/)[1];
  const since = Date.parse(new URL("https://api.example/" + path).searchParams.get("since"));
  const rows = state.prs[number][path.includes("/reviews?") ? "reviews" : "comments"] ?? [];
  response = [rows.filter(row => path.includes("/reviews?") || Date.parse(row.updated_at) > since)];
}
if (response !== undefined) {
  appendFileSync(process.env.QUEUE_LOG, JSON.stringify(args) + "\\n");
  console.log(JSON.stringify(response));
} else {
  const result = spawnSync(${JSON.stringify(join(bin, "gh-single"))}, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
`, { mode: 0o755 });
  renameSync(join(bin, "npm"), join(bin, "npm-single"));
  writeFileSync(join(bin, "npm"), `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
const args = process.argv.slice(2);
const mode = process.env.QUEUE_MODE;
if (args[0] === "test" && existsSync("batch-residue")) process.exit(5);
if (args[0] === "test" && existsSync("35.txt")) {
  if (mode === "batch-red" || mode === "marked-batch-red" || mode === "batch-residue") {
    if (mode === "batch-residue") writeFileSync("batch-residue", "failed candidate");
    if (mode === "marked-batch-red") writeFileSync("scripts/test-marked-conditions.mjs", "process.exit(1);\\n");
    else {
      appendFileSync(process.env.QUEUE_LOG, JSON.stringify(["failed-tree", execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim()]) + "\\n");
      process.exit(1);
    }
  }
  if (mode === "extra-head-changed" || mode === "extra-edited") {
    const state = JSON.parse(readFileSync(${JSON.stringify(metadata)}, "utf8"));
    if (mode === "extra-head-changed") state.prs["35"].head.sha = "a".repeat(40);
    else state.prs["35"].updated_at = new Date().toISOString();
    writeFileSync(${JSON.stringify(metadata)}, JSON.stringify(state));
  }
  if (["extra-canceled", "extra-dispatch-changed", "extra-rerun", "extra-job-started"].includes(mode)) {
    const state = JSON.parse(readFileSync(${JSON.stringify(metadata)}, "utf8"));
    const run = state.runs.find(run => run.id === 35);
    if (mode === "extra-canceled") { run.status = "completed"; run.conclusion = "cancelled"; }
    if (mode === "extra-dispatch-changed") run.display_title += "-changed";
    if (mode === "extra-rerun") run.run_attempt = 2;
    if (mode === "extra-job-started") { run.status = "in_progress"; state.jobs[0].status = "in_progress"; }
    writeFileSync(${JSON.stringify(metadata)}, JSON.stringify(state));
  }
  if (mode === "dirty-batch") writeFileSync("35.txt", "unreviewed\\n");
  if (mode === "batch-head-moved") execFileSync("git", ["checkout", "--detach", "HEAD^1"]);
}
const result = spawnSync(${JSON.stringify(join(bin, "npm-single"))}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  function invoke(mode = "green", number = "34", head = f.head) {
    return spawnSync("node", [MERGER, number, head, f.reviewedAt], {
      cwd: f.work, encoding: "utf8", timeout: 30000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: "example/catalogue", GITHUB_RUN_ID: "10",
        GITHUB_STEP_SUMMARY: join(f.root, "summary.md"), TEST_SHARD: "1/3",
        QUEUE_MODE: mode, QUEUE_PR: f.prFile, QUEUE_COMMENTS: f.commentsFile, QUEUE_REVIEWS: f.reviewsFile,
        QUEUE_LOG: f.log, QUEUE_SIBLING: f.sibling },
    });
  }
  function calls() { return readFileSync(f.log, "utf8").trim().split("\n").map((line) => JSON.parse(line)); }
  return { ...f, state, heads, save, invoke, calls };
}

describe("reviewed publications share one tested merge tree", () => {
  it("publishes three queued heads in arrival order with one complete suite pair and follow-up set", () => {
    const f = batchFixture();
    try {
      const result = f.invoke();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const published = git(f.origin, "rev-parse", "main");
      assert.equal(git(f.origin, "rev-parse", "main^2"), f.heads[1]);
      assert.equal(git(f.origin, "rev-parse", "main^1^2"), f.heads[0]);
      assert.equal(git(f.origin, "rev-parse", "main^1^1^2"), f.head);
      for (const [path, value] of [["app.txt", "reviewed"], ["35.txt", "change 35"], ["36.txt", "change 36"]]) {
        assert.equal(git(f.origin, "show", `main:${path}`), value);
      }
      assert.deepEqual(f.calls().filter((call) => call[0] === "npm"), [["npm", "ci"], ["npm", "run", "build"], ["npm", "test"]]);
      assert.deepEqual(f.calls().filter((call) => call[0] === "tested-tree"), [["tested-tree", git(f.origin, "rev-parse", `${published}^{tree}`)]]);
      assert.equal(f.calls().filter((call) => call[0] === "workflow").length, 3);
      assert.deepEqual(f.calls().filter((call) => call[0] === "marked-tree"), [["marked-tree", git(f.origin, "rev-parse", `${published}^{tree}`)]]);
      for (const number of [34, 35, 36]) assert.match(result.stdout, new RegExp(`Published https://github.com/example/catalogue/pull/${number} as ${published}`));
      assert.equal(git(f.work, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("later original turns retain their history and finish without repeating suites or publication", () => {
    const f = batchFixture();
    try {
      assert.equal(f.invoke().status, 0);
      const before = readFileSync(f.log, "utf8");
      const published = git(f.origin, "rev-parse", "main");
      for (let i = 0; i < f.heads.length; i++) {
        const result = f.invoke("green", String(i + 35), f.heads[i]);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /Already published/);
        assert.doesNotMatch(result.stdout, /complete regular and marked-condition suites read/);
      }
      assert.equal(git(f.origin, "rev-parse", "main"), published);
      assert.equal(readFileSync(f.log, "utf8").slice(before.length).includes('"npm"'), false);
      assert.equal(f.calls().filter((call) => call[0] === "workflow").length, 3);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  for (const mode of ["batch-red", "batch-residue", "marked-batch-red", "dirty-batch", "batch-head-moved", "extra-head-changed", "extra-edited", "extra-canceled", "extra-dispatch-changed", "extra-rerun", "extra-job-started", "discovery-red"]) {
    it(`publishes only the original request after ${mode}`, () => {
      const f = batchFixture();
      try {
        const result = f.invoke(mode);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(git(f.origin, "show", "main:app.txt"), "reviewed");
        assert.equal(git(f.origin, "ls-tree", "--name-only", "main", "35.txt", "36.txt"), "");
        const tested = f.calls().filter((call) => call[0] === "tested-tree");
        assert.equal(tested.at(-1)?.[1], git(f.origin, "rev-parse", "main^{tree}"));
        if (mode !== "discovery-red") assert.match(result.stdout, /Combined publication refused/);
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    });
  }

  it("falls back after conflicting heads without testing or publishing the conflicting tree", () => {
    const f = batchFixture();
    try {
      git(f.sibling, "checkout", "-B", "conflict", f.base);
      writeFileSync(join(f.sibling, "app.txt"), "incompatible\n");
      git(f.sibling, "add", ".");
      git(f.sibling, "commit", "-m", "conflict");
      git(f.sibling, "push", "origin", "HEAD:conflict");
      const head = git(f.sibling, "rev-parse", "HEAD");
      f.state.prs["35"].head.sha = head;
      f.state.runs.find((run) => run.id === 35).display_title = `reviewed-pr:35:${head}:${f.reviewedAt}`;
      f.save();
      const result = f.invoke();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /Combined publication refused/);
      assert.equal(git(f.origin, "show", "main:app.txt"), "reviewed");
      assert.equal(f.calls().filter((call) => call[0] === "tested-tree").length, 1);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("does not let a batch bypass original review changes or an atomic push refusal", () => {
    for (const mode of ["head-changed", "comment-added", "review-added", "inline-during", "main-moved"]) {
      const f = batchFixture();
      try {
        const result = f.invoke(mode);
        assert.notEqual(result.status, 0, result.stdout + result.stderr);
        assert.equal(git(f.origin, "show", "main:app.txt"), "base");
        assert.equal(git(f.origin, "ls-tree", "--name-only", "main", "35.txt", "36.txt"), "");
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    }
  });

  it("excludes legacy names, other refs, completed runs, invalid inputs and duplicate heads", () => {
    const f = batchFixture();
    try {
      const valid = f.state.runs.find((run) => run.id === 35);
      f.state.runs = [
        { ...valid, id: 99 }, valid,
        { ...valid, id: 101, display_title: "Publish a reviewed pull request" },
        { ...valid, id: 102, head_branch: "feature" },
        { ...valid, id: 103, status: "completed" },
        { ...valid, id: 104, event: "push" },
        { ...valid, id: 105, path: ".github/workflows/other.yml" },
        { ...valid, id: 106, display_title: `reviewed-pr:36:${f.heads[1]}:2099-01-01T00:00:00Z` },
        { ...valid, id: 107, display_title: `reviewed-pr:36:bad:${f.reviewedAt}` },
      ];
      f.save();
      const result = f.invoke();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(git(f.origin, "show", "main:35.txt"), "change 35");
      assert.equal(git(f.origin, "ls-tree", "--name-only", "main", "36.txt"), "");
      assert.equal(git(f.origin, "rev-parse", "main^2"), f.heads[0]);
      assert.equal(git(f.origin, "rev-parse", "main^1^2"), f.head);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("includes a waiting publication job but excludes another executing or finished job", () => {
    for (const status of ["pending", "in_progress", "completed"]) {
      const f = batchFixture();
      try {
        f.state.runs = [f.state.runs.find((run) => run.id === 35)];
        f.state.runs[0].status = "in_progress";
        f.state.jobs[0].status = status;
        f.save();
        const result = f.invoke();
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(git(f.origin, "ls-tree", "--name-only", "main", "35.txt"), status === "pending" ? "35.txt" : "");
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    }
  });

  it("leaves an independently invalid queued review to its own turn", () => {
    const f = batchFixture();
    try {
      f.state.prs["35"].draft = true;
      f.save();
      const result = f.invoke();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(git(f.origin, "ls-tree", "--name-only", "main", "35.txt"), "");
      assert.equal(git(f.origin, "show", "main:36.txt"), "change 36");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});


describe("each queued head keeps its own review boundary", () => {
  for (const surface of ["body", "inline", "review"]) {
    it(`excludes an additional ${surface} update before the primary review but after its own`, () => {
      const f = batchFixture();
      try {
        const at = new Date(Math.floor((Date.parse(f.reviewedAt) - 2000) / 1000) * 1000).toISOString();
        const pr = f.state.prs["35"] as typeof f.pr & { comments?: object[]; reviews?: object[] };
        if (surface === "body") pr.updated_at = at;
        if (surface === "inline") pr.comments = [{ updated_at: at }];
        if (surface === "review") pr.reviews = [{ submitted_at: at }];
        f.save();
        const result = f.invoke();
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(git(f.origin, "ls-tree", "--name-only", "main", "35.txt"), "");
        assert.equal(git(f.origin, "show", "main:36.txt"), "change 36");
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    });
  }
});

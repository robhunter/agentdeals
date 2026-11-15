import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [number, expectedHead, reviewedAt] = process.argv.slice(2);
const repository = process.env.GITHUB_REPOSITORY;
const reviewedTime = Date.parse(reviewedAt);
if (!/^[1-9][0-9]*$/.test(number ?? "") || !/^[a-f0-9]{40}$/.test(expectedHead ?? "") ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(reviewedAt ?? "") ||
    !Number.isFinite(reviewedTime) || reviewedTime > Date.now()) {
  throw new Error("Expected a pull request number, full head SHA, repository and past UTC review timestamp.");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr ?? ""}`);
  return result.stdout?.trim() ?? "";
}

function api(path, pages = false) {
  return JSON.parse(run("gh", ["api", ...(pages ? ["--paginate", "--slurp"] : []), `repos/${repository}/${path}`]));
}

function reviewedPullRequest({ number, expectedHead, reviewedAt }) {
  const reviewSecond = Math.floor(Date.parse(reviewedAt) / 1000) * 1000;
  const commentsSince = new Date(reviewSecond - 1000).toISOString().replace(".000Z", "Z");
  const pr = api(`pulls/${number}`);
  if (pr.state !== "open" || pr.draft || pr.base.ref !== "main" ||
      pr.head.repo?.full_name !== repository || pr.head.sha !== expectedHead) {
    throw new Error("The pull request is no longer the reviewed open head targeting main in this repository.");
  }
  if (Date.parse(pr.updated_at) >= reviewSecond) {
    throw new Error("The pull request changed in or after its review timestamp's second.");
  }
  const checks = JSON.parse(run("gh", ["pr", "checks", number, "--repo", repository, "--json", "name,bucket"]));
  if (!checks.some((check) => check.name === "test" && check.bucket === "pass") ||
      checks.some((check) => !["pass", "skipping"].includes(check.bucket))) {
    throw new Error("The reviewed head must have passing checks before publication.");
  }
  const threads = new Set([number]);
  for (const match of pr.body?.matchAll(/\bRefs\s+(?:#([0-9]+)|https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([0-9]+))/g) ?? []) {
    if (match[1]) threads.add(match[1]);
    else if (match[2] === repository) threads.add(match[3]);
  }
  if (threads.size < 2) throw new Error("The pull request must name its issue using Refs.");
  for (const thread of threads) {
    if (thread !== number && Date.parse(api(`issues/${thread}`).updated_at) >= reviewSecond) {
      throw new Error(`The linked issue ${repository} issue ${thread} changed in or after the review timestamp's second.`);
    }
    const comments = api(`issues/${thread}/comments?since=${encodeURIComponent(commentsSince)}&per_page=100`, true).flat();
    if (comments.some((comment) => Date.parse(comment.updated_at) >= reviewSecond)) {
      throw new Error(`New or edited comments on ${repository} issue ${thread} need review.`);
    }
  }
  const inlineComments = api(`pulls/${number}/comments?since=${encodeURIComponent(commentsSince)}&per_page=100`, true).flat();
  if (inlineComments.some((comment) => Date.parse(comment.updated_at) >= reviewSecond)) {
    throw new Error("New or edited inline review comments need reading.");
  }
  const reviews = api(`pulls/${number}/reviews?per_page=100`, true).flat();
  if (reviews.some((review) => Date.parse(review.submitted_at) >= reviewSecond)) {
    throw new Error("A new pull request review needs reading.");
  }
  return pr;
}

function requestFromTitle(title) {
  const match = /^reviewed-pr:([1-9][0-9]*):([a-f0-9]{40}):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/.exec(title ?? "");
  if (!match || !Number.isFinite(Date.parse(match[3])) || Date.parse(match[3]) > Date.now()) return null;
  return { number: match[1], expectedHead: match[2], reviewedAt: match[3] };
}

function queuedRequests() {
  if (!/^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ID ?? "")) return [];
  const pages = ["queued", "pending", "waiting", "requested", "in_progress"].flatMap((status) =>
    api(`actions/workflows/merge-reviewed.yml/runs?event=workflow_dispatch&branch=main&status=${status}&per_page=100`, true));
  const runs = pages.flatMap((page) => page.workflow_runs).filter((entry) =>
    String(entry.id) !== process.env.GITHUB_RUN_ID && entry.event === "workflow_dispatch" &&
    entry.head_branch === "main" && entry.path === ".github/workflows/merge-reviewed.yml" &&
    ["queued", "pending", "waiting", "requested", "in_progress"].includes(entry.status) &&
    Number.isFinite(Date.parse(entry.created_at)) && Number.isInteger(entry.run_attempt) && entry.run_attempt > 0)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
  const seen = new Set([number]);
  const requests = [];
  for (const entry of runs) {
    const request = requestFromTitle(entry.display_title);
    if (!request || seen.has(request.number) || Date.parse(request.reviewedAt) > Date.parse(entry.created_at)) continue;
    if (entry.status === "in_progress") {
      const jobs = api(`actions/runs/${entry.id}/jobs?filter=latest&per_page=100`, true).flatMap((page) => page.jobs);
      if (!jobs.some((job) => job.name === "publish" && ["queued", "pending", "waiting", "requested"].includes(job.status))) continue;
    }
    try {
      const pr = reviewedPullRequest(request);
      requests.push({ ...request, pr, runId: entry.id, runAttempt: entry.run_attempt });
      seen.add(request.number);
    } catch (error) {
      console.error(`Leaving queued pull request ${request.number} for its own turn: ${error.message}`);
    }
  }
  return requests;
}

function validateQueuedRequest(request) {
  if (!request.runId) return;
  const entry = api(`actions/runs/${request.runId}`);
  const input = requestFromTitle(entry.display_title);
  if (entry.id !== request.runId || entry.run_attempt !== request.runAttempt || entry.event !== "workflow_dispatch" ||
      entry.head_branch !== "main" || entry.path !== ".github/workflows/merge-reviewed.yml" ||
      !["queued", "pending", "waiting", "requested", "in_progress"].includes(entry.status) ||
      input?.number !== request.number || input?.expectedHead !== request.expectedHead || input?.reviewedAt !== request.reviewedAt) {
    throw new Error(`Queued publication ${request.runId} was withdrawn or changed.`);
  }
  if (entry.status === "in_progress") {
    const jobs = api(`actions/runs/${entry.id}/jobs?filter=latest&per_page=100`, true).flatMap((page) => page.jobs);
    if (!jobs.some((job) => job.name === "publish" && ["queued", "pending", "waiting", "requested"].includes(job.status))) {
      throw new Error(`Queued publication ${request.runId} no longer has a waiting publication job.`);
    }
  }
}

function record(message) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, message + "\n");
}

const primary = { number, expectedHead, reviewedAt };
run("git", ["fetch", "origin", "main", expectedHead]);
const base = run("git", ["rev-parse", "refs/remotes/origin/main"]);
const current = api(`pulls/${number}`);
if (current.head?.sha === expectedHead && current.head.repo?.full_name === repository && current.base?.ref === "main" &&
    spawnSync("git", ["merge-base", "--is-ancestor", expectedHead, base]).status === 0) {
  record(`Already published https://github.com/${repository}/pull/${number}: reviewed head ${expectedHead} is included in main at ${base}. No suites or publication ran in this turn.`);
  process.exit(0);
}
primary.pr = reviewedPullRequest(primary);
let additional = [];
try {
  additional = queuedRequests();
} catch (error) {
  console.error(`Queue discovery unavailable; publishing only the requested pull request: ${error.message}`);
}
run("git", ["config", "user.name", "github-actions[bot]"]);
run("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);

const pageLedger = "data/page-lastmod.json";

function mergeTree(candidate, head, index) {
  const result = spawnSync("git", ["merge-tree", "--write-tree", "--name-only", "-z", candidate, head], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const [tree, ...fields] = (result.stdout ?? "").split("\0");
  if (!/^[a-f0-9]{40}$/.test(tree)) throw new Error(`Merge failed: ${result.stderr}`);
  if (result.status === 0) return { tree, ledgerConflict: false };
  const boundary = fields.indexOf("");
  const conflicts = fields.slice(0, boundary);
  if (result.status !== 1 || boundary < 0 || conflicts.length !== 1 || conflicts[0] !== pageLedger) {
    throw new Error(`Merge conflicts require review: ${conflicts.join(", ")}. ${result.stderr}`);
  }
  let ledger;
  for (const revision of [candidate, head, base]) {
    const entry = run("git", ["ls-tree", revision, "--", pageLedger]);
    if (!/^100644 blob [a-f0-9]{40}\tdata\/page-lastmod\.json$/.test(entry)) {
      throw new Error("A conflicted page ledger must remain a regular file in both heads and main.");
    }
    ledger = entry.split(/\s+/)[2];
  }
  const env = { ...process.env, GIT_INDEX_FILE: index };
  run("git", ["read-tree", tree], { env });
  run("git", ["update-index", "--cacheinfo", `100644,${ledger},${pageLedger}`], { env });
  return { tree: run("git", ["write-tree"], { env }), ledgerConflict: true };
}

function testCandidate(requests) {
  let candidate = base;
  let tree;
  let ledgerConflict = false;
  let addedWorktree = false;
  const scratch = mkdtempSync(join(tmpdir(), "reviewed-publication-"));
  const cwd = join(scratch, "work");
  try {
    for (const request of requests) {
      validateQueuedRequest(request);
      reviewedPullRequest(request);
      run("git", ["fetch", "origin", request.expectedHead]);
      const merged = mergeTree(candidate, request.expectedHead, join(scratch, "index"));
      ledgerConflict ||= merged.ledgerConflict;
      candidate = run("git", ["commit-tree", merged.tree, "-p", candidate, "-p", request.expectedHead], {
        input: `${request.pr.title} (#${request.number})\n\nMerge reviewed head ${request.expectedHead}.\n`,
      });
    }
    run("git", ["worktree", "add", "--detach", cwd, candidate]);
    addedWorktree = true;
    run("npm", ["ci"], { cwd, stdio: "inherit" });
    run("npm", ["run", "build"], { cwd, stdio: "inherit" });
    const suiteEnv = { ...process.env, TZ: "UTC" };
    delete suiteEnv.TEST_SHARD;
    if (ledgerConflict) {
      run("git", ["diff", "--exit-code", "HEAD", "--"], { cwd });
      run("git", ["restore", "--source", base, "--worktree", "--", pageLedger], { cwd });
      run("node", ["scripts/update-page-lastmod.js"], { cwd, stdio: "inherit", env: suiteEnv });
      const changed = run("git", ["diff", "--name-only", "-z", "HEAD", "--"], { cwd }).split("\0").filter(Boolean);
      if (changed.some((path) => path !== pageLedger)) throw new Error("Page ledger regeneration changed another tracked file.");
      if (run("git", ["rev-parse", "HEAD"], { cwd }) !== candidate) throw new Error("Page ledger regeneration changed its merge commit.");
      run("git", ["add", "--", pageLedger], { cwd });
      tree = run("git", ["write-tree"], { cwd });
      if (tree !== run("git", ["rev-parse", `${candidate}^{tree}`], { cwd })) {
        candidate = run("git", ["commit-tree", tree, "-p", candidate], {
          cwd, input: "Regenerate page dates for the reviewed merge.\n",
        });
        run("git", ["checkout", "--detach", candidate], { cwd });
      }
      run("node", ["scripts/update-page-lastmod.js", "--check"], { cwd, stdio: "inherit", env: suiteEnv });
      record(`Regenerated the conflicted page ledger from main ${base} on the complete reviewed merge.`);
    }
    run("git", ["diff", "--exit-code", "HEAD", "--"], { cwd });
    tree = run("git", ["rev-parse", `${candidate}^{tree}`], { cwd });
    record(`Testing publication candidate ${candidate}, tree ${tree}, pull requests ${requests.map((request) => request.number).join(", ")}.`);
    run("npm", ["test"], { cwd, stdio: "inherit", env: suiteEnv });
    run("node", ["scripts/test-marked-conditions.mjs"], { cwd, stdio: "inherit", env: suiteEnv });
    if (run("git", ["rev-parse", "HEAD"], { cwd }) !== candidate) throw new Error("The suite changed its publication commit.");
    run("git", ["diff", "--exit-code", "HEAD", "--"], { cwd });
    for (const request of requests) {
      reviewedPullRequest(request);
      validateQueuedRequest(request);
    }
    return { candidate, tree, requests };
  } catch (error) {
    record(`Publication candidate ${candidate}, tree ${tree ?? "unprepared"}, refused: ${error.message}`);
    throw error;
  } finally {
    if (addedWorktree) run("git", ["worktree", "remove", "--force", cwd]);
    rmSync(scratch, { recursive: true, force: true });
  }
}

let tested;
if (additional.length) {
  try {
    tested = testCandidate([primary, ...additional]);
  } catch (error) {
    record(`Combined publication refused; testing only pull request ${number} from original main ${base}. ${error.message}`);
  }
}
if (!tested) tested = testCandidate([primary]);
run("bash", [fileURLToPath(new URL("./push-tested-tree.sh", import.meta.url)), tested.candidate, tested.tree], { stdio: "inherit" });
for (const request of tested.requests) {
  record(`Published https://github.com/${repository}/pull/${request.number} as ${tested.candidate}; complete regular and marked-condition suites read tree ${tested.tree}. Reviewed head ${request.expectedHead}; original workflow run ${request.runId ?? process.env.GITHUB_RUN_ID ?? "local"}, attempt ${request.runAttempt ?? process.env.GITHUB_RUN_ATTEMPT ?? "local"}.`);
}
let dispatchFailed = false;
for (const workflow of ["tests.yml", "page-lastmod.yml", "llm-api-readme.yml"]) {
  try {
    run("gh", ["workflow", "run", workflow, "--ref", "main"], { stdio: "inherit" });
  } catch (error) {
    console.error(`The merge is published, but ${workflow} could not be requested: ${error.message}`);
    dispatchFailed = true;
  }
}
if (dispatchFailed) process.exitCode = 1;

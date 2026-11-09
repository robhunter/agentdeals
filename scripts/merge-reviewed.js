import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
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
const reviewSecond = Math.floor(reviewedTime / 1000) * 1000;
const commentsSince = new Date(reviewSecond - 1000).toISOString().replace(".000Z", "Z");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr ?? ""}`);
  return result.stdout?.trim() ?? "";
}

function api(path, pages = false) {
  return JSON.parse(run("gh", ["api", ...(pages ? ["--paginate", "--slurp"] : []), `repos/${repository}/${path}`]));
}

function reviewedPullRequest() {
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

const pr = reviewedPullRequest();
run("git", ["fetch", "origin", "main", expectedHead]);
const base = run("git", ["rev-parse", "refs/remotes/origin/main"]);
const tree = run("git", ["merge-tree", "--write-tree", base, expectedHead]);
run("git", ["config", "user.name", "github-actions[bot]"]);
run("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
const candidate = run("git", ["commit-tree", tree, "-p", base, "-p", expectedHead], {
  input: `${pr.title} (#${number})\n\nMerge reviewed head ${expectedHead}.\n`,
});
run("git", ["checkout", "--detach", candidate]);
run("npm", ["ci"], { stdio: "inherit" });
run("npm", ["run", "build"], { stdio: "inherit" });
const suiteEnv = { ...process.env, TZ: "UTC" };
delete suiteEnv.TEST_SHARD;
run("npm", ["test"], { stdio: "inherit", env: suiteEnv });
run("node", ["scripts/test-marked-conditions.mjs"], { stdio: "inherit", env: suiteEnv });
if (run("git", ["rev-parse", "HEAD"]) !== candidate) throw new Error("The suite changed its publication commit.");
run("git", ["diff", "--exit-code", "HEAD", "--"]);
reviewedPullRequest();
run("bash", [fileURLToPath(new URL("./push-tested-tree.sh", import.meta.url)), candidate, tree], { stdio: "inherit" });
const summary = `Published https://github.com/${repository}/pull/${number} as ${candidate}; complete regular and marked-condition suites read tree ${tree}.\n`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
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

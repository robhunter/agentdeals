import { appendFileSync } from "node:fs";
import path from "node:path";

import { ROOT, heldIndex, indexPath, renderIndex, servedOnFrom } from "./llm-api-index-render.js";

const {
  publicationBranch,
  publicationCommitMessage,
  publicationDecision,
  publicationTarget,
} = await import(`${ROOT}/dist/llm-api-index-publication.js`);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const API = process.env.AGENTDEALS_GITHUB_API || "https://api.github.com";

function say(line) {
  console.log(line);
}

function report(fields) {
  const to = process.env.GITHUB_OUTPUT;
  if (!to) return;
  appendFileSync(to, `${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join("\n")}\n`);
}

function done(published, detail) {
  report({ published, ...detail });
  process.exit(0);
}

function stop(published, because) {
  console.error(because);
  report({ published, reason: because.replace(/\n/g, " ") });
  process.exit(1);
}

const reading = publicationTarget(process.env);
if (reading.state === "unnamed") {
  say(reading.because);
  say(`Nothing was published to any other repository. Set ${"AGENTDEALS_LLM_INDEX_REPO"} to turn publication on.`);
  done("unnamed", {});
}
if (reading.state === "unusable") stop("misconfigured", reading.because);

const target = reading.target;

async function call(route, init = {}) {
  const response = await fetch(`${API}${route}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${target.token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "agentdeals-llm-api-index",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text };
}

function apiFailure(what, response) {
  const message = response.body?.message ?? response.text.slice(0, 300);
  return `${what} answered HTTP ${response.status}: ${message}`;
}

let index;
try {
  index = await renderIndex(servedOnFrom(args));
} catch (error) {
  stop("failed", error.message);
}

const held = heldIndex();

const repo = await call(`/repos/${target.repo}`);
if (repo.status !== 200 && repo.status !== 404) stop("failed", apiFailure(`GET /repos/${target.repo}`, repo));

const remote = {
  repoExists: repo.status === 200,
  defaultBranch: repo.body?.default_branch ?? null,
  branchCount: 0,
  branchExists: false,
  file: null,
};

if (remote.repoExists) {
  const branches = await call(`/repos/${target.repo}/branches?per_page=100`);
  if (branches.status !== 200) stop("failed", apiFailure(`GET /repos/${target.repo}/branches`, branches));
  const names = (branches.body ?? []).map(b => b.name);
  remote.branchCount = names.length;
  const wanted = publicationBranch(target, remote);
  remote.branchExists = wanted !== null && names.includes(wanted);

  if (remote.branchExists) {
    const file = await call(`/repos/${target.repo}/contents/${target.path}?ref=${encodeURIComponent(wanted)}`);
    if (file.status === 200) {
      if (file.body?.encoding !== "base64" || typeof file.body?.content !== "string") {
        stop("failed", `${target.repo} returned ${target.path} in an encoding this run cannot read: ${file.body?.encoding}`);
      }
      remote.file = { content: Buffer.from(file.body.content, "base64").toString("utf8"), sha: file.body.sha ?? "" };
    } else if (file.status !== 404) {
      stop("failed", apiFailure(`GET /repos/${target.repo}/contents/${target.path}`, file));
    }
  }
}

const decision = publicationDecision({
  rows: index.census.rows,
  generated: index.rendered,
  held,
  target,
  remote,
});

const named = target.branch ?? remote.defaultBranch ?? "(the repository's first branch)";
say(`${path.relative(ROOT, indexPath())} → ${target.repo}:${named}/${target.path}`);

if (decision.action === "refuse") stop("refused", decision.because);
say(decision.because);
if (decision.action === "unchanged") done("unchanged", { rows: index.census.rows });

const message = publicationCommitMessage(index.census);
if (dryRun) {
  say(`--dry-run: would ${decision.action} with the message "${message}".`);
  done(`would-${decision.action}`, { rows: index.census.rows });
}

const write = await call(`/repos/${target.repo}/contents/${target.path}`, {
  method: "PUT",
  body: JSON.stringify({
    message,
    content: Buffer.from(index.rendered, "utf8").toString("base64"),
    ...(decision.sha ? { sha: decision.sha } : {}),
    ...(decision.branch ? { branch: decision.branch } : {}),
  }),
});
if (write.status !== 200 && write.status !== 201) {
  stop("failed", apiFailure(`PUT /repos/${target.repo}/contents/${target.path}`, write));
}

const commit = write.body?.commit?.sha ?? "";
say(`${decision.action === "create" ? "Created" : "Updated"} ${target.path} on ${target.repo} as ${commit.slice(0, 7)} — ${message}`);
say(write.body?.content?.html_url ?? `https://github.com/${target.repo}/blob/${decision.branch ?? "HEAD"}/${target.path}`);
done(decision.action === "create" ? "created" : "updated", { rows: index.census.rows, commit });

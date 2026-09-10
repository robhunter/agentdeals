import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const WORKFLOW = path.join(REPO, ".github", "workflows", "llm-api-readme.yml");
const PUBLISHER = path.join(REPO, "scripts", "publish-llm-api-index.js");
const GENERATOR = path.join(REPO, "scripts", "generate-llm-api-readme.js");

const {
  BRANCH_ENV,
  CATALOGUE_REPO,
  PATH_ENV,
  PUBLISHED_README_PATH,
  REPO_ENV,
  TOKEN_ENV,
  publicationBranch,
  publicationCommitMessage,
  publicationDecision,
  publicationTarget,
} = await import("../dist/llm-api-index-publication.js");

const SERVED_ON = "2026-09-01";

const TARGET = { repo: "robhunter/llm-api-free-tiers", branch: "main", path: "README.md", token: "t" };

function remote(over: Record<string, unknown> = {}) {
  return {
    repoExists: true,
    defaultBranch: "main",
    branchCount: 1,
    branchExists: true,
    file: null,
    ...over,
  };
}

function decide(over: Record<string, unknown> = {}) {
  return publicationDecision({
    rows: 31,
    generated: "INDEX",
    held: "INDEX",
    target: TARGET,
    remote: remote(),
    ...over,
  });
}

describe("#1497 the index names one repository to publish into, or none", () => {
  it("publishes nowhere when no repository is named", () => {
    for (const value of [undefined, "", "   "]) {
      const reading = publicationTarget(value === undefined ? {} : { [REPO_ENV]: value });
      assert.equal(reading.state, "unnamed", `${JSON.stringify(value)} should leave publication off`);
      assert.match(reading.because, new RegExp(REPO_ENV));
    }
  });

  it("refuses a repository that is not an owner/name pair", () => {
    for (const value of ["llm-api-free-tiers", "owner/name/extra", "owner /name", "https://github.com/o/n"]) {
      const reading = publicationTarget({ [REPO_ENV]: value, [TOKEN_ENV]: "t" });
      assert.equal(reading.state, "unusable", `${value} should not be accepted as a target`);
    }
  });

  it("refuses a named repository with no token, because that publishes a stale index rather than none", () => {
    const reading = publicationTarget({ [REPO_ENV]: "robhunter/llm-api-free-tiers" });
    assert.equal(reading.state, "unusable");
    assert.match(reading.because, new RegExp(TOKEN_ENV));
    assert.match(reading.because, /stale/);
  });

  it("refuses to write this repository's own front page", () => {
    const reading = publicationTarget({ [REPO_ENV]: CATALOGUE_REPO, [TOKEN_ENV]: "t" });
    assert.equal(reading.state, "unusable");
    assert.match(reading.because, new RegExp(PUBLISHED_README_PATH));
  });

  it("allows the catalogue repository at some other path, so the mechanism can be exercised against a real remote", () => {
    const reading = publicationTarget({
      [REPO_ENV]: CATALOGUE_REPO,
      [PATH_ENV]: "artifacts/publish-check/README.md",
      [TOKEN_ENV]: "t",
    });
    assert.equal(reading.state, "named");
    assert.equal(reading.target.path, "artifacts/publish-check/README.md");
  });

  it("defaults the path to the repository root README and leaves the branch for the remote to name", () => {
    const reading = publicationTarget({ [REPO_ENV]: "robhunter/llm-api-free-tiers", [TOKEN_ENV]: "t" });
    assert.equal(reading.state, "named");
    assert.equal(reading.target.path, PUBLISHED_README_PATH);
    assert.equal(reading.target.branch, null);
    assert.equal(publicationBranch(reading.target, remote({ defaultBranch: "trunk" })), "trunk");
  });

  it("takes a named branch over the remote's default", () => {
    const reading = publicationTarget({
      [REPO_ENV]: "robhunter/llm-api-free-tiers",
      [BRANCH_ENV]: "publish",
      [TOKEN_ENV]: "t",
    });
    assert.equal(reading.state, "named");
    assert.equal(publicationBranch(reading.target, remote({ defaultBranch: "main" })), "publish");
  });
});

describe("#1497 what reaches the published repository is what the catalogue generates", () => {
  it("refuses when the file held in the workspace is not what the catalogue generates", () => {
    const decision = decide({ held: "INDEX with a hand edit" });
    assert.equal(decision.action, "refuse");
    assert.match(decision.because, /stale or hand-edited/);
  });

  it("refuses when nothing has been generated in the workspace at all", () => {
    const decision = decide({ held: null });
    assert.equal(decision.action, "refuse");
  });

  it("refuses to publish an index holding no rows over one holding rows", () => {
    const decision = decide({ rows: 0, generated: "EMPTY", held: "EMPTY" });
    assert.equal(decision.action, "refuse");
    assert.match(decision.because, /index of nothing/);
  });

  it("refuses when the repository does not exist, rather than trying to make it", () => {
    const decision = decide({ remote: remote({ repoExists: false, defaultBranch: null, branchCount: 0, branchExists: false }) });
    assert.equal(decision.action, "refuse");
    assert.match(decision.because, /does not exist/);
  });

  it("refuses when the repository has branches but not the one named", () => {
    const decision = decide({ remote: remote({ branchExists: false, branchCount: 2 }) });
    assert.equal(decision.action, "refuse");
    assert.match(decision.because, /no branch main/);
  });

  it("writes the first README into a repository that holds none", () => {
    const decision = decide();
    assert.equal(decision.action, "create");
    assert.equal(decision.branch, "main");
    assert.equal(decision.sha, null);
  });

  it("lets a repository with no commits name its own first branch", () => {
    const decision = decide({ remote: remote({ branchCount: 0, branchExists: false }) });
    assert.equal(decision.action, "create");
    assert.equal(decision.branch, null);
  });

  it("writes no commit when the published README already reads what the catalogue generates", () => {
    const decision = decide({ remote: remote({ file: { content: "INDEX", sha: "abc" } }) });
    assert.equal(decision.action, "unchanged");
  });

  it("replaces a published README the catalogue no longer generates, naming the blob it replaces", () => {
    const decision = decide({ remote: remote({ file: { content: "an older index", sha: "abc" } }) });
    assert.equal(decision.action, "update");
    assert.equal(decision.sha, "abc");
  });

  it("refuses an update it cannot address, rather than overwriting blind", () => {
    const decision = decide({ remote: remote({ file: { content: "an older index", sha: "" } }) });
    assert.equal(decision.action, "refuse");
    assert.match(decision.because, /blind/);
  });
});

describe("#1497 the published commit says what moved", () => {
  const census = {
    rows: 31, rated: 19, ended: 2, withheld: 10, withheldByReason: {},
    withPriorTerms: 7, linkUnreachable: 0, stale: 0, caveated: 0,
  };

  it("names every count a reader of the history would check", () => {
    const message = publicationCommitMessage(census);
    for (const figure of ["31 record", "19 rated", "10 publishing a reason", "7 showing the terms"]) {
      assert.ok(message.includes(figure), `${JSON.stringify(message)} should carry ${figure}`);
    }
  });

  it("counts one record in the singular", () => {
    assert.match(publicationCommitMessage({ ...census, rows: 1 }), /1 record,/);
  });
});

describe("#1497 the publisher run end to end against a repository API", () => {
  let server: Server;
  let origin = "";
  let calls: { method: string; url: string; body: unknown }[] = [];
  let state: { repo: unknown; branches: unknown; file: { content: string; sha: string } | null } = {
    repo: null, branches: null, file: null,
  };
  let heldPath = "";
  let generated = "";

  before(async () => {
    heldPath = path.join(mkdtempSync(path.join(tmpdir(), "llm-index-publish-")), "README.md");
    const wrote = spawnSync("node", [GENERATOR, `--on=${SERVED_ON}`], {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env, AGENTDEALS_LLM_INDEX_PATH: heldPath, TZ: "UTC" },
    });
    assert.equal(wrote.status, 0, wrote.stderr);
    generated = readFileSync(heldPath, "utf8");

    server = createServer((req, res) => {
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        calls.push({ method: req.method ?? "", url: req.url ?? "", body: raw === "" ? null : JSON.parse(raw) });
        const answer = (status: number, body: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        const url = req.url ?? "";
        if (req.method === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(url)) {
          return state.repo === null ? answer(404, { message: "Not Found" }) : answer(200, state.repo);
        }
        if (req.method === "GET" && url.includes("/branches")) {
          return answer(200, state.branches ?? []);
        }
        if (req.method === "GET" && url.includes("/contents/")) {
          if (state.file === null) return answer(404, { message: "Not Found" });
          return answer(200, {
            encoding: "base64",
            content: Buffer.from(state.file.content, "utf8").toString("base64"),
            sha: state.file.sha,
          });
        }
        if (req.method === "PUT" && url.includes("/contents/")) {
          const body = calls[calls.length - 1]!.body as { content: string };
          state.file = { content: Buffer.from(body.content, "base64").toString("utf8"), sha: "written" };
          return answer(200, { commit: { sha: "0123456789" }, content: { html_url: "https://example.invalid/readme" } });
        }
        return answer(500, { message: `unrouted ${req.method} ${url}` });
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    origin = typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : "";
  });

  after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  function publish(env: Record<string, string | undefined> = {}, args: string[] = []) {
    calls = [];
    const child = spawn("node", [PUBLISHER, `--on=${SERVED_ON}`, ...args], {
      cwd: REPO,
      env: {
        ...process.env,
        TZ: "UTC",
        AGENTDEALS_GITHUB_API: origin,
        AGENTDEALS_LLM_INDEX_PATH: heldPath,
        [REPO_ENV]: "robhunter/llm-api-free-tiers",
        [TOKEN_ENV]: "a-token",
        ...env,
      },
    });
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", status => resolve({ status, stdout, stderr }));
    });
  }

  function puts() {
    return calls.filter(c => c.method === "PUT");
  }

  it("does nothing and says so when no repository is named", async () => {
    state = { repo: null, branches: null, file: null };
    const run = await publish({ [REPO_ENV]: "" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(REPO_ENV));
    assert.equal(calls.length, 0, "an unnamed target should not reach the API at all");
  });

  it("fails rather than publishing when a repository is named with no token", async () => {
    const run = await publish({ [TOKEN_ENV]: "" });
    assert.equal(run.status, 1);
    assert.equal(puts().length, 0);
  });

  it("fails loudly when the named repository does not exist", async () => {
    state = { repo: null, branches: null, file: null };
    const run = await publish();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /does not exist/);
    assert.equal(puts().length, 0);
  });

  it("writes the generated index, byte for byte, as the first README", async () => {
    state = { repo: { default_branch: "main" }, branches: [{ name: "main" }], file: null };
    const run = await publish();
    assert.equal(run.status, 0, run.stderr);
    assert.equal(puts().length, 1);
    const body = puts()[0]!.body as { content: string; branch?: string; sha?: string; message: string };
    assert.equal(Buffer.from(body.content, "base64").toString("utf8"), generated);
    assert.equal(body.branch, "main");
    assert.equal(body.sha, undefined, "a create carries no blob to replace");
    assert.match(body.message, /31 records/);
  });

  it("writes no commit on a second run over the same data", async () => {
    const run = await publish();
    assert.equal(run.status, 0, run.stderr);
    assert.equal(puts().length, 0, "identical content should produce no commit");
    assert.match(run.stdout, /already publishes/);
  });

  it("replaces a published README that has drifted, naming the blob it replaces", async () => {
    state.file = { content: "an index somebody edited by hand", sha: "deadbeef" };
    const run = await publish();
    assert.equal(run.status, 0, run.stderr);
    assert.equal(puts().length, 1);
    assert.equal((puts()[0]!.body as { sha: string }).sha, "deadbeef");
    assert.equal(state.file.content, generated);
  });

  it("refuses to publish a workspace file the catalogue does not generate", async () => {
    writeFileSync(heldPath, `${generated}\nan extra line nobody generated\n`);
    try {
      const run = await publish();
      assert.equal(run.status, 1);
      assert.match(run.stderr, /stale or hand-edited/);
      assert.equal(puts().length, 0);
    } finally {
      writeFileSync(heldPath, generated);
    }
  });

  it("reads the remote and writes nothing under --dry-run", async () => {
    state.file = { content: "something else", sha: "cafe" };
    const run = await publish({}, ["--dry-run"]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(puts().length, 0);
    assert.match(run.stdout, /--dry-run/);
  });
});

describe("#1497 the workflow that owns the index is the workflow that publishes it", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  function stepsOf(text: string) {
    const out: { name: string; body: string }[] = [];
    for (const line of text.split("\n")) {
      const start = line.match(/^ {6}- (?:name|uses):\s*(.+)$/);
      if (start) out.push({ name: start[1]!.trim(), body: `${line}\n` });
      else if (out.length > 0) out[out.length - 1]!.body += `${line}\n`;
    }
    return out;
  }

  const steps = stepsOf(workflow);
  const publisher = steps.find(s => /publish-llm-api-index\.js/.test(s.body));
  const gate = steps.findIndex(s => /gate-data-push\.sh/.test(s.body));

  it("invokes the publisher", () => {
    assert.ok(publisher, "the index workflow should publish the index it regenerates");
  });

  it("publishes only what the gate has already put on main", () => {
    assert.ok(gate >= 0, "the index workflow should still gate its own commit");
    assert.ok(steps.indexOf(publisher!) > gate, "publication should follow the gate, not precede it");
    assert.doesNotMatch(
      publisher!.body,
      /if:\s*(always\(\)|failure\(\)|!cancelled\(\))/,
      "a quarantined index must not be published, so the publish step runs only on success",
    );
  });

  it("takes its target from repository configuration rather than a literal in the workflow", () => {
    assert.match(publisher!.body, new RegExp(`${REPO_ENV}:\\s*\\$\\{\\{\\s*vars\\.`));
    assert.match(publisher!.body, new RegExp(`${TOKEN_ENV}:\\s*\\$\\{\\{\\s*secrets\\.`));
  });

  it("keeps publishing current even when a data run reaches main without firing a push event", () => {
    assert.match(workflow, /^\s+schedule:/m, "a GITHUB_TOKEN push fires no push event, so the mirror needs its own clock");
  });
});

describe("#1497 one path holds the index, and both scripts read it from one place", () => {
  for (const script of [GENERATOR, PUBLISHER]) {
    it(`${path.basename(script)} takes the index path from the shared renderer`, () => {
      const source = readFileSync(script, "utf8");
      assert.match(source, /from "\.\/llm-api-index-render\.js"/);
      assert.doesNotMatch(source, /free-llm-api-index/, "the path is named once, in the renderer");
    });
  }
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerWith } from "./page-review-fixture.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRELOAD = `
import http from "node:http";
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const record = value => appendFileSync(process.env.REGISTER_TRANSPORT_LOG, JSON.stringify({ pid: process.pid, ...value }) + "\\n");
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function(...args) {
  this.keepAliveTimeout = 25;
  this.keepAliveTimeoutBuffer = 0;
  record({ kind: "server", timeout: this.keepAliveTimeout });
  this.prependListener("request", (req, res) => {
    record({ kind: "request", route: req.url, connection: req.headers.connection, userAgent: req.headers["user-agent"] });
    res.setHeader("Keep-Alive", "timeout=60");
    if (req.url === "/ai-coding-tools-pricing" && process.env.REGISTER_TRANSPORT_FAILURE) {
      if (process.env.REGISTER_TRANSPORT_FAILURE === "status") {
        res.writeHead(503);
        res.end("unavailable");
      } else req.socket.destroy();
    }
  });
  return listen.apply(this, args);
};
const exec = childProcess.execFileSync;
childProcess.execFileSync = function(command, args, ...rest) {
  const result = exec.call(this, command, args, ...rest);
  if (command === "git" && args.includes("--reverse") && args.includes("-S")) {
    record({ kind: "history", route: args[args.indexOf("-S") + 1] });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  }
  return result;
};
syncBuiltinESMExports();
`;

function run(failure = "", measuredOnly = false) {
  const fixture = registerWith(REPO, "register-connections-", {
    "/agent-payments": { published: "" },
    "/agent-stack": { published: "" },
  });
  const preload = join(fixture.dir, "transport.mjs");
  const log = join(fixture.dir, "transport.jsonl");
  const out = join(fixture.dir, "written.json");
  writeFileSync(preload, PRELOAD);
  writeFileSync(log, "");
  writeFileSync(out, "unchanged output\n");
  const source = readFileSync(fixture.file, "utf8");
  const result = spawnSync(process.execPath, [join(REPO, "scripts/sync-page-reviews.js"), "--out", out, ...(measuredOnly ? ["--measured-only"] : [])], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`,
      AGENTDEALS_PAGE_REVIEWS_PATH: fixture.file,
      REGISTER_TRANSPORT_LOG: log,
      REGISTER_TRANSPORT_FAILURE: failure,
    },
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const events = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { fixture, result, events, out, source, cleanup: () => rmSync(fixture.dir, { recursive: true, force: true }) };
}

function assertSuccessful(result: ReturnType<typeof run>) {
  assert.equal(result.result.error, undefined);
  assert.equal(result.result.status, 0, result.result.stderr);
  assert.match(result.result.stdout, /2 of \d+ pages carry no publication date/);
  assert.match(result.result.stdout, /wrote /);
  const history = result.events.filter(event => event.kind === "history");
  assert.deepEqual(history.map(event => event.route), ['"/agent-payments"', '"/agent-stack"']);
  const servers = result.events.filter(event => event.kind === "server");
  assert.equal(servers.length, 4);
  assert.ok(servers.every(event => event.timeout === 25));
  const requests = result.events.filter(event => event.kind === "request");
  const original = JSON.parse(readFileSync(join(REPO, "data/page-reviews.json"), "utf8"));
  assert.equal(requests.length, original.pages.length * 4);
  assert.ok(requests.every(event => event.connection === "close"));
  assert.ok(requests.every(event => event.userAgent === "agentdeals-internal/1.0 (sync-page-reviews)"));
  const written = JSON.parse(readFileSync(result.out, "utf8"));
  assert.equal(written.pages.length, original.pages.length);
  for (const before of original.pages) {
    const after = written.pages.find((page: { path: string }) => page.path === before.path);
    assert.ok(after, before.path);
    const fields = ["reviewed_at", "reviewer", "review_outcome", "review_note", "partial_recheck", "reads_index", "reads_changes", "tables_read_index", "table_figures", "table_figures_from_records", "tables", "vendors_tabulated"];
    for (const field of fields) assert.deepEqual(after[field], before[field], `${before.path} ${field}`);
    assert.match(after.published, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.equal(readFileSync(result.fixture.file, "utf8"), result.source);
}

describe("rendering a review register across publication history walks", () => {
  for (const measuredOnly of [false, true]) {
    it(`completes ${measuredOnly ? "a measured-only" : "a full"} rebuild after two walks with short server keep-alive`, () => {
      const result = run("", measuredOnly);
      try { assertSuccessful(result); } finally { result.cleanup(); }
    });
  }

  for (const failure of ["status", "socket"]) {
    it(`keeps a ${failure} failure visible without replacing the output or retrying`, () => {
      const result = run(failure);
      try {
        assert.equal(result.result.error, undefined);
        assert.equal(result.result.status, 1);
        assert.match(result.result.stderr, failure === "status" ? /\/ai-coding-tools-pricing returned 503/ : /fetch failed/);
        const failed = result.events.filter(event => event.kind === "request" && event.route === "/ai-coding-tools-pricing");
        assert.ok(failed.length >= 1 && failed.length <= 4);
        assert.equal(new Set(failed.map(event => event.pid)).size, failed.length);
        assert.equal(readFileSync(result.out, "utf8"), "unchanged output\n");
        assert.equal(readFileSync(result.fixture.file, "utf8"), result.source);
        assert.doesNotMatch(result.result.stdout, /wrote /);
      } finally { result.cleanup(); }
    });
  }
});

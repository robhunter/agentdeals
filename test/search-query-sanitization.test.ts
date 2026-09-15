import { describe, it, after, before } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoversPopulation, pathsThatRecordASearch } from "./population-floor.ts";
import { searchRecordingCalls } from "./search-recording-paths.ts";

const { sanitizeQuery } = await import("../dist/search-query.js");
const { loadTelemetry, getSearchAnalytics, resetCounters } = await import("../dist/stats.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "..", "dist", "serve.js");
const telemetryPath = path.join(__dirname, "..", "data", "telemetry.json");
const telemetryBackup = `${telemetryPath}.sanitization-test-backup`;

const PUNCTUATION = `'(a)&b"`;

let port = 0;
let proc: ChildProcess;
let movedAside = false;

function probeFor(label: string): string {
  return `probe-${process.pid}-${label} ${PUNCTUATION}`;
}

function tokenOf(probe: string): string {
  return probe.split(" ")[0]!.toLowerCase();
}

before(async () => {
  if (existsSync(telemetryPath)) {
    renameSync(telemetryPath, telemetryBackup);
    movedAside = true;
  }

  proc = spawn("node", [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("server start timeout")); }, 20000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) { port = parseInt(match[1], 10); clearTimeout(timeout); resolve(); }
    });
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
});

after(() => {
  proc?.kill("SIGKILL");
  if (movedAside) renameSync(telemetryBackup, telemetryPath);
  else if (existsSync(telemetryPath)) rmSync(telemetryPath);
});

async function getJson(pathname: string): Promise<any> {
  const res = await fetch(`http://localhost:${port}${pathname}`);
  assert.strictEqual(res.status, 200, `${pathname} answered ${res.status}`);
  return res.json();
}

async function exerciseWeb(query: string): Promise<void> {
  const res = await fetch(`http://localhost:${port}/search?q=${encodeURIComponent(query)}`);
  assert.strictEqual(res.status, 200, `/search answered ${res.status}`);
  await res.text();
}

async function exerciseApi(query: string): Promise<void> {
  await getJson(`/api/offers?q=${encodeURIComponent(query)}&limit=1`);
}

async function exerciseMcp(query: string): Promise<void> {
  const sessionId = await mcpInitialize();
  const res = await fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "search_deals", arguments: { query } },
    }),
  });
  assert.strictEqual(res.status, 200, `search_deals answered ${res.status}`);
  await res.text();
}

const EXERCISE: Record<string, (query: string) => Promise<void>> = {
  web: exerciseWeb,
  api: exerciseApi,
  mcp: exerciseMcp,
};

async function publishedQueryLists(): Promise<[string, { query: string; count: number }[]][]> {
  const metrics = await getJson("/api/metrics");
  const analytics = metrics.search_analytics ?? {};
  return [
    ["top_search_queries_7d", metrics.top_search_queries_7d ?? []],
    ["search_analytics.top_queries_7d", analytics.top_queries_7d ?? []],
    ["search_analytics.zero_result_queries_7d", analytics.zero_result_queries_7d ?? []],
    ["search_analytics.filtered_to_zero_queries_7d", analytics.filtered_to_zero_queries_7d ?? []],
  ];
}

async function recordedQueryFor(probe: string): Promise<string> {
  const token = tokenOf(probe);
  const top = (await getJson("/api/metrics")).search_analytics.top_queries_7d as { query: string }[];
  const found = top.filter((entry) => entry.query.includes(token));
  assert.strictEqual(found.length, 1, `${found.length} published entries carry ${token}, expected exactly one`);
  return found[0]!.query;
}

async function mcpInitialize(): Promise<string> {
  const res = await fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "sanitization-test", version: "1.0" } },
    }),
  });
  assert.strictEqual(res.status, 200);
  await res.text();
  const sessionId = res.headers.get("mcp-session-id");
  assert.ok(sessionId, "initialize should return a session id");
  return sessionId!;
}

describe("a recorded search query is the sanitized one", () => {
  it("records the sanitized form on every path that records a search", async () => {
    const calls = searchRecordingCalls();
    assert.deepStrictEqual(
      calls.filter((call) => call.source === null).map((call) => `${call.file}:${call.line}`),
      [],
      "every call site that records a search must name the surface it records for",
    );

    const surfaces = [...new Set(calls.map((call) => call.source!))].sort();
    const exercised: string[] = [];
    for (const surface of surfaces) {
      const run = EXERCISE[surface];
      assert.ok(run, `no probe exercises the ${surface} search path`);
      const probe = probeFor(surface);
      await run(probe);
      assert.strictEqual(
        await recordedQueryFor(probe),
        sanitizeQuery(probe).toLowerCase(),
        `the ${surface} path published a query that is not the sanitizer's own output`,
      );
      exercised.push(surface);
    }

    assertCoversPopulation(exercised.length, pathsThatRecordASearch(), "search surfaces exercised with punctuation");
  });

  it("publishes no query that differs from its own sanitized form", async () => {
    const carried: string[] = [];
    for (const [name, list] of await publishedQueryLists()) {
      for (const entry of list) {
        if (entry.query !== sanitizeQuery(entry.query).toLowerCase()) {
          carried.push(`${name} ${JSON.stringify(entry.query)}`);
        }
      }
    }
    assert.deepStrictEqual(carried, [], "a published search metric carries characters the sanitizer removes");
  });

  it("sanitizes entries already in the persisted ring rather than waiting for them to age out", async () => {
    const dir = path.join(tmpdir(), `search-ring-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const at = path.join(dir, "telemetry.json");
    const carried = `' order by 1-- -`;
    writeFileSync(at, JSON.stringify({
      cumulative_search_queries: [
        { query: carried, timestamp: new Date().toISOString(), results_count: 0, unfiltered_count: 0 },
        { query: "  DATABASE  ", timestamp: new Date().toISOString(), results_count: 4, unfiltered_count: 4 },
        { query: "``", timestamp: new Date().toISOString(), results_count: 0, unfiltered_count: 0 },
      ],
    }));

    try {
      resetCounters();
      await loadTelemetry(at);
      const published = getSearchAnalytics().top_queries_7d.map((entry: { query: string }) => entry.query);
      assert.deepStrictEqual(
        published.sort(),
        [sanitizeQuery(carried), "database"].sort(),
        "a query persisted before the sanitizer moved to the recording boundary must be sanitized when it is read back",
      );
    } finally {
      resetCounters();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

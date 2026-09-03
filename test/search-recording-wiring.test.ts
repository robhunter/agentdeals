import { describe, it, after, before } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "..", "dist", "serve.js");
const telemetryPath = path.join(__dirname, "..", "data", "telemetry.json");
const telemetryBackup = `${telemetryPath}.wiring-test-backup`;

let port = 0;
let proc: ChildProcess;
let movedAside = false;

const GAP_QUERY = `wiring-gap-${process.pid}`;
const COVERED_QUERY = "database";
let emptyingCategory = "";

before(async () => {
  if (existsSync(telemetryPath)) {
    renameSync(telemetryPath, telemetryBackup);
    movedAside = true;
  }

  proc = spawn("node", [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PORT: "0" },
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("server start timeout")); }, 20000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) { port = parseInt(match[1], 10); clearTimeout(timeout); resolve(); }
    });
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });

  emptyingCategory = await categoryThatEmpties(COVERED_QUERY);
});

after(() => {
  proc?.kill("SIGKILL");
  if (movedAside) renameSync(telemetryBackup, telemetryPath);
  else if (existsSync(telemetryPath)) rmSync(telemetryPath);
});

async function get(pathname: string): Promise<any> {
  const res = await fetch(`http://localhost:${port}${pathname}`);
  assert.strictEqual(res.status, 200, `${pathname} -> ${res.status}`);
  return res.json();
}

async function analytics(): Promise<any> {
  return (await get("/api/metrics")).search_analytics;
}

function countFor(list: { query: string; count: number }[], query: string): number {
  return list.find(e => e.query === query.toLowerCase())?.count ?? 0;
}

async function categoryThatEmpties(query: string): Promise<string> {
  const covered = await get(`/api/offers?q=${query}&limit=2000`);
  assert.ok(covered.total > 0, `${query} matches nothing in the catalog, so it is no longer a covered query`);
  const matched = new Set<string>(covered.offers.map((o: { category: string }) => o.category.toLowerCase()));
  const catalog = await get("/api/offers?limit=2000");
  const outside = catalog.offers
    .map((o: { category: string }) => o.category)
    .find((c: string) => !matched.has(c.toLowerCase()));
  assert.ok(
    outside,
    `every one of the catalog's categories now holds a match for "${query}", so no filter can narrow it to zero`,
  );
  return outside;
}

describe("search recording wiring (#1018 Defect C)", () => {
  it("a filter that empties a covered query is not recorded as a catalog gap", async () => {
    const covered = await get(`/api/offers?q=${COVERED_QUERY}&limit=1`);
    assert.ok(covered.total > 0, `${COVERED_QUERY} should match offers; got ${covered.total}`);

    const before = await analytics();
    const filtered = await get(`/api/offers?q=${COVERED_QUERY}&category=${encodeURIComponent(emptyingCategory)}&limit=1`);
    assert.strictEqual(
      filtered.total,
      0,
      `no offer in ${emptyingCategory} matched "${COVERED_QUERY}" when the category was chosen; the catalog now holds ${filtered.total} that do`,
    );
    const after = await analytics();

    assert.strictEqual(
      countFor(after.zero_result_queries_7d, COVERED_QUERY) - countFor(before.zero_result_queries_7d, COVERED_QUERY),
      0,
      "a query we cover must never be added to the gap list because the caller narrowed it",
    );
    assert.strictEqual(
      countFor(after.filtered_to_zero_queries_7d, COVERED_QUERY) - countFor(before.filtered_to_zero_queries_7d, COVERED_QUERY),
      1,
      "it belongs on the filtered-to-zero list instead",
    );
  });

  it("a query the catalog genuinely has nothing for is still recorded as a gap", async () => {
    const before = await analytics();
    const res = await get(`/api/offers?q=${GAP_QUERY}&limit=1`);
    assert.strictEqual(res.total, 0);
    const after = await analytics();

    assert.strictEqual(
      countFor(after.zero_result_queries_7d, GAP_QUERY) - countFor(before.zero_result_queries_7d, GAP_QUERY),
      1,
      "a real gap must survive the fix",
    );
  });

  it("attributes recorded queries to the surface they arrived on", async () => {
    await get(`/api/offers?q=${COVERED_QUERY}&limit=1`);
    const a = await analytics();
    assert.ok(a.queries_by_source_7d.api > 0, "/api/offers should report source=api");
  });

  it("applies the same rule to the MCP search_deals tool", async () => {
    const sessionId = await mcpInitialize();

    const before = await analytics();
    const filtered = await mcpSearch(sessionId, { query: COVERED_QUERY, category: emptyingCategory });
    assert.strictEqual(
      filtered.total,
      0,
      `no offer in ${emptyingCategory} matched "${COVERED_QUERY}" when the category was chosen; the catalog now holds ${filtered.total} that do`,
    );
    const mid = await analytics();

    assert.strictEqual(
      countFor(mid.zero_result_queries_7d, COVERED_QUERY) - countFor(before.zero_result_queries_7d, COVERED_QUERY),
      0,
      "an MCP call filtered to zero is not a catalog gap",
    );
    assert.strictEqual(
      countFor(mid.filtered_to_zero_queries_7d, COVERED_QUERY) - countFor(before.filtered_to_zero_queries_7d, COVERED_QUERY),
      1,
    );

    const mcpGap = `${GAP_QUERY}-mcp`;
    const gap = await mcpSearch(sessionId, { query: mcpGap });
    assert.strictEqual(gap.total, 0);
    const after = await analytics();
    assert.strictEqual(
      countFor(after.zero_result_queries_7d, mcpGap) - countFor(mid.zero_result_queries_7d, mcpGap),
      1,
      "an unfiltered MCP search with no matches is still a gap",
    );
    assert.ok(after.queries_by_source_7d.mcp > 0, "MCP searches should report source=mcp");
  });
});

function parseSse(body: string): any {
  const lines = body.split("\n").filter(l => l.startsWith("data:"));
  assert.ok(lines.length > 0, `no SSE data frame in: ${body.slice(0, 200)}`);
  return JSON.parse(lines[lines.length - 1].slice("data:".length).trim());
}

async function mcpInitialize(): Promise<string> {
  const res = await fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "wiring-test", version: "1.0" } },
    }),
  });
  assert.strictEqual(res.status, 200);
  await res.text();
  const sessionId = res.headers.get("mcp-session-id");
  assert.ok(sessionId, "initialize should return a session id");
  return sessionId!;
}

async function mcpSearch(sessionId: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_deals", arguments: args } }),
  });
  assert.strictEqual(res.status, 200);
  const payload = parseSse(await res.text());
  return JSON.parse(payload.result.content[0].text);
}

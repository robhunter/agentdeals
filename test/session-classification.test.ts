import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  classifyMcpClient,
  getSessionClassification,
  recordSessionConnect,
  resetCounters,
  CRAWLER_CLIENT_PATTERNS,
} = await import("../src/stats.ts");

describe("classifyMcpClient heuristic", () => {
  it("classifies every documented crawler pattern as 'crawler'", () => {
    for (const pattern of CRAWLER_CLIENT_PATTERNS) {
      assert.strictEqual(
        classifyMcpClient(pattern),
        "crawler",
        `pattern "${pattern}" should classify as crawler`,
      );
    }
  });

  it("classifies known crawlers by exact name", () => {
    assert.strictEqual(classifyMcpClient("mcpdd"), "crawler");
    assert.strictEqual(classifyMcpClient("glama"), "crawler");
    assert.strictEqual(classifyMcpClient("yellowmcp-health"), "crawler");
    assert.strictEqual(classifyMcpClient("MCPScoringEngine"), "crawler");
    assert.strictEqual(classifyMcpClient("fabrique-noauth-probe"), "crawler");
  });

  it("classifies crawler patterns as substrings anywhere in the name", () => {
    assert.strictEqual(classifyMcpClient("some-random-crawler-v2"), "crawler");
    assert.strictEqual(classifyMcpClient("my-probe-bot"), "crawler");
    assert.strictEqual(classifyMcpClient("acme-registry-lister"), "crawler");
    assert.strictEqual(classifyMcpClient("MCP-Health-Check"), "crawler");
  });

  it("is case-insensitive", () => {
    assert.strictEqual(classifyMcpClient("GLAMA"), "crawler");
    assert.strictEqual(classifyMcpClient("Mcpdd"), "crawler");
    assert.strictEqual(classifyMcpClient("MCPSCORINGENGINE"), "crawler");
  });

  it("classifies real-looking agent names as 'agent'", () => {
    assert.strictEqual(classifyMcpClient("Kai"), "agent");
    assert.strictEqual(classifyMcpClient("Agent iOS"), "agent");
    assert.strictEqual(classifyMcpClient("scout"), "agent");
    assert.strictEqual(classifyMcpClient("axiom"), "agent");
    assert.strictEqual(classifyMcpClient("openclaw"), "agent");
    assert.strictEqual(classifyMcpClient("codex-mcp-client"), "agent");
    assert.strictEqual(classifyMcpClient("lobehub-mcp-client"), "agent");
    assert.strictEqual(classifyMcpClient("opencode"), "agent");
    assert.strictEqual(classifyMcpClient("mcp-client"), "agent");
  });

  it("defaults to 'agent' for unknown or empty names", () => {
    assert.strictEqual(classifyMcpClient("unknown"), "agent");
    assert.strictEqual(classifyMcpClient(""), "agent");
    assert.strictEqual(classifyMcpClient("SomeBrandNewClient"), "agent");
  });
});

describe("getSessionClassification aggregation", () => {
  beforeEach(() => {
    resetCounters();
  });

  it("buckets current-deployment sessions by classification and totals correctly", () => {
    recordSessionConnect("mcpdd");
    recordSessionConnect("mcpdd");
    recordSessionConnect("glama");
    recordSessionConnect("opencode");
    recordSessionConnect("Kai");
    recordSessionConnect("scout");
    recordSessionConnect("scout");

    const c = getSessionClassification();
    assert.strictEqual(c.sessions_by_type.crawler, 3);
    assert.strictEqual(c.sessions_by_type.agent, 4);
    assert.strictEqual(c.sessions_by_type.total, 7);
  });

  it("returns clients_top sorted descending by sessions, capped at 10", () => {
    // 12 crawlers + 3 agents with varying counts
    for (let i = 0; i < 12; i++) {
      const name = `crawler-${i}`;
      for (let j = 0; j <= i; j++) recordSessionConnect(name);
    }
    recordSessionConnect("Kai");
    recordSessionConnect("Kai");
    recordSessionConnect("scout");

    const c = getSessionClassification();
    assert.strictEqual(c.clients_top.length, 10);
    assert.strictEqual(c.clients_top[0].name, "crawler-11");
    assert.strictEqual(c.clients_top[0].sessions, 12);
    assert.strictEqual(c.clients_top[0].type, "crawler");
    // Sorted descending
    for (let i = 1; i < c.clients_top.length; i++) {
      assert.ok(c.clients_top[i - 1].sessions >= c.clients_top[i].sessions);
    }
    // Every entry has a type field
    for (const entry of c.clients_top) {
      assert.ok(entry.type === "agent" || entry.type === "crawler");
    }
  });

  it("classifies 'unknown' (missing client name) as agent", () => {
    // recordSessionConnect(undefined) uses "unknown" as the bucket key
    recordSessionConnect();
    recordSessionConnect();
    const c = getSessionClassification();
    assert.strictEqual(c.sessions_by_type.agent, 2);
    assert.strictEqual(c.sessions_by_type.crawler, 0);
    const unknown = c.clients_top.find(e => e.name === "unknown");
    assert.ok(unknown);
    assert.strictEqual(unknown.type, "agent");
  });

  it("returns empty buckets when no sessions have been recorded", () => {
    const c = getSessionClassification();
    assert.strictEqual(c.sessions_by_type.agent, 0);
    assert.strictEqual(c.sessions_by_type.crawler, 0);
    assert.strictEqual(c.sessions_by_type.total, 0);
    assert.deepStrictEqual(c.clients_top, []);
  });
});

describe("GET /api/metrics — sessions_by_type + clients_top", () => {
  let serverPort = 0;
  let serverProc: ChildProcess;

  before(async () => {
    serverProc = await new Promise<ChildProcess>((resolve, reject) => {
      const serverPath = path.join(__dirname, "..", "dist", "serve.js");
      const proc = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
      });
      const timeout = setTimeout(() => { proc.kill(); reject(new Error("Server startup timeout")); }, 15000);
      proc.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) {
          serverPort = parseInt(match[1], 10);
          clearTimeout(timeout);
          resolve(proc);
        }
      });
      proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
  });

  after(() => {
    serverProc?.kill();
  });

  it("returns sessions_by_type block with agent/crawler/total numeric fields", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/metrics`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as any;
    assert.ok(body.sessions_by_type, "sessions_by_type block missing");
    assert.strictEqual(typeof body.sessions_by_type.agent, "number");
    assert.strictEqual(typeof body.sessions_by_type.crawler, "number");
    assert.strictEqual(typeof body.sessions_by_type.total, "number");
    // Invariant: agent + crawler === total
    assert.strictEqual(
      body.sessions_by_type.agent + body.sessions_by_type.crawler,
      body.sessions_by_type.total,
    );
  });

  it("returns clients_top as an array where each entry has name, sessions, type", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/metrics`);
    const body = await res.json() as any;
    assert.ok(Array.isArray(body.clients_top), "clients_top must be an array");
    assert.ok(body.clients_top.length <= 10, "clients_top must be capped at 10");
    for (const entry of body.clients_top) {
      assert.strictEqual(typeof entry.name, "string");
      assert.strictEqual(typeof entry.sessions, "number");
      assert.ok(entry.type === "agent" || entry.type === "crawler", `entry.type must be 'agent' or 'crawler', got ${entry.type}`);
    }
    // clients_top sorted descending by sessions
    for (let i = 1; i < body.clients_top.length; i++) {
      assert.ok(body.clients_top[i - 1].sessions >= body.clients_top[i].sessions);
    }
  });

  it("keeps cumulative_sessions unchanged and total <= cumulative_sessions", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/metrics`);
    const body = await res.json() as any;
    assert.strictEqual(typeof body.cumulative_sessions, "number");
    // sessions_by_type.total tracks the clients map, which may be a subset of
    // cumulative_sessions if older deployments didn't track per-client counts.
    assert.ok(body.sessions_by_type.total <= body.cumulative_sessions);
  });

  it("still returns existing blocks (backward-compat)", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/metrics`);
    const body = await res.json() as any;
    assert.strictEqual(typeof body.cumulative_tool_calls, "number");
    assert.strictEqual(typeof body.cumulative_api_hits, "number");
    assert.ok(body.referral_marketplace, "referral_marketplace block must still be present");
  });
});

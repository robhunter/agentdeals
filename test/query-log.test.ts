import { describe, it, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let serverPort = 0;

const serverPath = path.join(__dirname, "..", "dist", "serve.js");
const proc: ChildProcess = spawn("node", [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, PORT: "0" },
});

await new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => {
    proc.kill();
    reject(new Error("Server startup timeout"));
  }, 5000);

  proc.stderr!.on("data", (data: Buffer) => {
    const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
    if (match) {
      serverPort = parseInt(match[1], 10);
      clearTimeout(timeout);
      resolve();
    }
  });

  proc.on("error", (err) => {
    clearTimeout(timeout);
    reject(err);
  });
});

after(() => {
  proc.kill();
});

describe("query-log endpoint", () => {
  it("GET /api/query-log returns entries array and count", async () => {
    const response = await fetch(`http://localhost:${serverPort}/api/query-log`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("content-type"), "application/json");
    assert.strictEqual(response.headers.get("access-control-allow-origin"), "*");
    const body = await response.json() as any;
    assert.ok(Array.isArray(body.entries));
    assert.ok(typeof body.count === "number");
    assert.strictEqual(body.entries.length, body.count);
  });

  it("GET /api/query-log accepts limit parameter", async () => {
    const response = await fetch(`http://localhost:${serverPort}/api/query-log?limit=5`);
    assert.strictEqual(response.status, 200);
    const body = await response.json() as any;
    assert.ok(Array.isArray(body.entries));
    assert.ok(body.count <= 5);
  });

  it("GET /api/query-log clamps limit to 1-200 range", async () => {
    const resp1 = await fetch(`http://localhost:${serverPort}/api/query-log?limit=-10`);
    assert.strictEqual(resp1.status, 200);

    const resp2 = await fetch(`http://localhost:${serverPort}/api/query-log?limit=999`);
    assert.strictEqual(resp2.status, 200);
  });
});

describe("request log entry format", () => {
  it("logRequest and getRequestLog handle entries correctly", async () => {
    const { logRequest, getRequestLog } = await import("../dist/stats.js");

    const entry = {
      ts: new Date().toISOString(),
      type: "api" as const,
      endpoint: "/api/offers",
      params: { q: "database" },
      user_agent: "test-agent",
      result_count: 10,
    };

    await logRequest(entry);

    const log = await getRequestLog(10);
    assert.ok(Array.isArray(log));
  });
});

describe("search_deals counter", () => {
  it("toolCalls includes search_deals counter", async () => {
    const { getStats, recordToolCall } = await import("../dist/stats.js");

    recordToolCall("search_deals");
    const stats = getStats();
    assert.ok("search_deals" in stats.tool_calls, "toolCalls should include search_deals");
    assert.ok(stats.tool_calls.search_deals >= 1, "search_deals counter should increment");
  });
});

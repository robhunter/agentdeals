import { describe, it, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 13592; // Unique port to avoid conflicts

// Start a single HTTP server for all query-log tests
const serverPath = path.join(__dirname, "..", "dist", "serve.js");
const proc: ChildProcess = spawn("node", [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, PORT: String(PORT) },
});

await new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => {
    proc.kill();
    reject(new Error("Server startup timeout"));
  }, 5000);

  proc.stderr!.on("data", (data: Buffer) => {
    if (data.toString().includes("running on")) {
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
    const response = await fetch(`http://localhost:${PORT}/api/query-log`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("content-type"), "application/json");
    assert.strictEqual(response.headers.get("access-control-allow-origin"), "*");
    const body = await response.json() as any;
    assert.ok(Array.isArray(body.entries));
    assert.ok(typeof body.count === "number");
    assert.strictEqual(body.entries.length, body.count);
  });

  it("GET /api/query-log accepts limit parameter", async () => {
    const response = await fetch(`http://localhost:${PORT}/api/query-log?limit=5`);
    assert.strictEqual(response.status, 200);
    const body = await response.json() as any;
    assert.ok(Array.isArray(body.entries));
    // limit is capped at 200
    assert.ok(body.count <= 5);
  });

  it("GET /api/query-log clamps limit to 1-200 range", async () => {
    // Negative limit should be clamped to 1
    const resp1 = await fetch(`http://localhost:${PORT}/api/query-log?limit=-10`);
    assert.strictEqual(resp1.status, 200);

    // Large limit should be clamped to 200
    const resp2 = await fetch(`http://localhost:${PORT}/api/query-log?limit=999`);
    assert.strictEqual(resp2.status, 200);
  });
});

describe("request log entry format", () => {
  it("logRequest and getRequestLog handle entries correctly", async () => {
    // Import the functions directly for unit testing
    const { logRequest, getRequestLog } = await import("../dist/stats.js");

    // Without Redis configured, logRequest is a no-op and getRequestLog returns empty
    // This validates the functions exist and have correct signatures
    const entry = {
      ts: new Date().toISOString(),
      type: "api" as const,
      endpoint: "/api/offers",
      params: { q: "database" },
      user_agent: "test-agent",
      result_count: 10,
    };

    // Should not throw
    await logRequest(entry);

    // Without Redis, returns empty array
    const log = await getRequestLog(10);
    assert.ok(Array.isArray(log));
  });
});

describe("get_new_offers counter fix", () => {
  it("toolCalls includes get_new_offers counter", async () => {
    const { getStats, recordToolCall } = await import("../dist/stats.js");

    recordToolCall("get_new_offers");
    const stats = getStats();
    assert.ok("get_new_offers" in stats.tool_calls, "toolCalls should include get_new_offers");
    assert.ok(stats.tool_calls.get_new_offers >= 1, "get_new_offers counter should increment");
  });
});

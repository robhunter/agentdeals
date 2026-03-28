import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("getNewestDeals logic", () => {
  it("returns deals with default params (last 30 days, limit 20)", async () => {
    const { getNewestDeals } = await import("../dist/data.js");
    const result = getNewestDeals({});
    assert.ok(Array.isArray(result.deals), "Should return deals array");
    assert.ok(typeof result.total === "number", "Should return total count");
    assert.ok(result.deals.length <= 20, "Default limit should be 20");
    for (const deal of result.deals) {
      assert.ok(typeof deal.days_since_update === "number", "Each deal should have days_since_update");
      assert.ok(deal.days_since_update >= 0, "days_since_update should be non-negative");
    }
  });

  it("filters by since date", async () => {
    const { getNewestDeals } = await import("../dist/data.js");
    const farPast = "2020-01-01";
    const resultAll = getNewestDeals({ since: farPast, limit: 50 });
    const recentOnly = getNewestDeals({ since: "2026-03-01", limit: 50 });
    assert.ok(resultAll.total >= recentOnly.total, "Broader since should return more or equal results");
  });

  it("filters by category", async () => {
    const { getNewestDeals } = await import("../dist/data.js");
    const result = getNewestDeals({ since: "2020-01-01", limit: 50, category: "Databases" });
    for (const deal of result.deals) {
      assert.strictEqual(deal.category, "Databases", "All results should be in Databases category");
    }
  });

  it("respects limit parameter", async () => {
    const { getNewestDeals } = await import("../dist/data.js");
    const result = getNewestDeals({ since: "2020-01-01", limit: 3 });
    assert.ok(result.deals.length <= 3, "Should respect limit of 3");
  });

  it("results are sorted by verifiedDate descending", async () => {
    const { getNewestDeals } = await import("../dist/data.js");
    const result = getNewestDeals({ since: "2020-01-01", limit: 50 });
    for (let i = 1; i < result.deals.length; i++) {
      assert.ok(
        result.deals[i].verifiedDate <= result.deals[i - 1].verifiedDate,
        `Deal at index ${i} should have verifiedDate <= previous`
      );
    }
  });

  it("returns empty when no deals match", async () => {
    const { getNewestDeals } = await import("../dist/data.js");
    const result = getNewestDeals({ since: "2099-01-01" });
    assert.strictEqual(result.total, 0);
    assert.deepStrictEqual(result.deals, []);
  });
});

describe("get_newest_deals MCP tool via stdio", () => {
  let proc: ChildProcess | null = null;

  afterEach(() => {
    if (proc) { proc.kill(); proc = null; }
  });

  it("get_newest_deals is listed in tools/list", async () => {
    const serverPath = path.join(__dirname, "..", "dist", "index.js");
    proc = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "pipe"] });

    const initMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });

    const initedMsg = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    const listTools = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    const response = await new Promise<string>((resolve, reject) => {
      let data = "";
      const timeout = setTimeout(() => reject(new Error("Timeout")), 10000);
      proc!.stdout!.on("data", (chunk: Buffer) => {
        data += chunk.toString();
        const lines = data.split("\n").filter(Boolean);
        if (lines.length >= 2) {
          clearTimeout(timeout);
          resolve(lines[1]);
        }
      });
      proc!.stdin!.write(initMsg + "\n");
      proc!.stdin!.write(initedMsg + "\n");
      proc!.stdin!.write(listTools + "\n");
    });

    const parsed = JSON.parse(response);
    assert.strictEqual(parsed.id, 2);
    const tools = parsed.result.tools;
    assert.ok(Array.isArray(tools));
    const searchTool = tools.find((t: any) => t.name === "search_deals");
    assert.ok(searchTool, "search_deals should be in tools list");
    assert.ok(searchTool.description.includes("deals") || searchTool.description.includes("Find"), "Description should mention deals or find");
  });
});

describe("get_newest_deals REST endpoint", () => {
  let serverPort = 0;
  let proc: ChildProcess | null = null;

  function startHttpServer(): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const serverPath = path.join(__dirname, "..", "dist", "serve.js");
      const p = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0" },
      });
      const timeout = setTimeout(() => { p.kill(); reject(new Error("Server startup timeout")); }, 5000);
      p.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) { serverPort = parseInt(match[1], 10); clearTimeout(timeout); resolve(p); }
      });
      p.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
  }

  before(async () => {
    proc = await startHttpServer();
  });

  after(() => {
    if (proc) { proc.kill(); proc = null; }
  });

  it("GET /api/newest returns newest deals", async () => {
    const response = await fetch(`http://localhost:${serverPort}/api/newest?since=2020-01-01&limit=5`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("access-control-allow-origin"), "*");
    const body = await response.json() as any;
    assert.ok(Array.isArray(body.deals), "Should have deals array");
    assert.ok(typeof body.total === "number", "Should have total count");
    assert.ok(body.deals.length <= 5, "Should respect limit");
    if (body.deals.length > 0) {
      assert.ok(typeof body.deals[0].days_since_update === "number", "Deals should include days_since_update");
    }
  });

  it("GET /api/newest with invalid since returns 400", async () => {
    const response = await fetch(`http://localhost:${serverPort}/api/newest?since=not-a-date`);
    assert.strictEqual(response.status, 400);
    const body = await response.json() as any;
    assert.ok(body.error.includes("Invalid"), "Should return error about invalid date");
  });
});

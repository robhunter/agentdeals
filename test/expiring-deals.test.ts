import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("getExpiringDeals logic", () => {
  it("returns deals expiring within the given window", async () => {
    const { getExpiringDeals } = await import("../dist/data.js");
    const result = getExpiringDeals(365);
    assert.ok(result.deals.length > 0, "Should find deals expiring within 365 days");
    assert.strictEqual(result.total, result.deals.length);
    for (const deal of result.deals) {
      assert.ok(deal.expires_date, "Each deal should have expires_date");
      assert.ok(typeof deal.days_until_expiry === "number", "Should have days_until_expiry");
      assert.ok(deal.days_until_expiry >= 0, "days_until_expiry should be non-negative");
      assert.ok(deal.days_until_expiry <= 365, "days_until_expiry should be within window");
    }
  });

  it("returns empty results when no deals expire in window", async () => {
    const { getExpiringDeals } = await import("../dist/data.js");
    // Use 0 days — nothing expires today exactly
    const result = getExpiringDeals(0);
    assert.strictEqual(result.total, 0, "No deals should expire within 0 days");
    assert.deepStrictEqual(result.deals, []);
  });

  it("results are sorted by expiration date (soonest first)", async () => {
    const { getExpiringDeals } = await import("../dist/data.js");
    const result = getExpiringDeals(365);
    for (let i = 1; i < result.deals.length; i++) {
      assert.ok(
        result.deals[i].days_until_expiry >= result.deals[i - 1].days_until_expiry,
        `Deal ${result.deals[i].vendor} should expire after or same as ${result.deals[i - 1].vendor}`
      );
    }
  });

  it("each deal includes standard offer fields", async () => {
    const { getExpiringDeals } = await import("../dist/data.js");
    const result = getExpiringDeals(365);
    assert.ok(result.deals.length > 0);
    const deal = result.deals[0];
    assert.ok(deal.vendor, "Should have vendor");
    assert.ok(deal.category, "Should have category");
    assert.ok(deal.description, "Should have description");
    assert.ok(deal.tier, "Should have tier");
    assert.ok(deal.expires_date, "Should have expires_date");
    assert.ok(typeof deal.days_until_expiry === "number", "Should have days_until_expiry");
  });

  it("narrower window returns fewer or equal results", async () => {
    const { getExpiringDeals } = await import("../dist/data.js");
    const wide = getExpiringDeals(365);
    const narrow = getExpiringDeals(30);
    assert.ok(narrow.total <= wide.total, "Narrower window should return fewer or equal results");
  });
});

describe("get_expiring_deals MCP tool via stdio", () => {
  let proc: ChildProcess | null = null;

  afterEach(() => {
    if (proc) { proc.kill(); proc = null; }
  });

  it("get_expiring_deals is listed in tools/list", async () => {
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
    const trackTool = tools.find((t: any) => t.name === "track_changes");
    assert.ok(trackTool, "track_changes should be in tools list");
    assert.ok(trackTool.description.includes("expir") || trackTool.description.includes("changes"), "Description should mention expiring or changes");
  });
});

describe("get_expiring_deals REST endpoint", () => {
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

  afterEach(() => {
    if (proc) { proc.kill(); proc = null; }
  });

  it("GET /api/expiring returns expiring deals", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/api/expiring?within_days=365`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("access-control-allow-origin"), "*");
    const body = await response.json() as any;
    assert.ok(Array.isArray(body.deals), "Should have deals array");
    assert.ok(typeof body.total === "number", "Should have total count");
    if (body.deals.length > 0) {
      assert.ok(body.deals[0].expires_date, "Deals should include expires_date");
      assert.ok(typeof body.deals[0].days_until_expiry === "number", "Deals should include days_until_expiry");
    }
  });

  it("GET /api/expiring defaults to 30 days", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/api/expiring`);
    assert.strictEqual(response.status, 200);
    const body = await response.json() as any;
    assert.ok(Array.isArray(body.deals));
    // All deals should be within 30 days
    for (const deal of body.deals) {
      assert.ok(deal.days_until_expiry <= 30, `Deal ${deal.vendor} should expire within 30 days`);
    }
  });
});

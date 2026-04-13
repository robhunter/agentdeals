import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("deadlines REST endpoint", () => {
  let serverPort = 0;
  let proc: ChildProcess | null = null;

  function startHttpServer(): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const serverPath = path.join(__dirname, "..", "dist", "serve.js");
      const p = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0" },
      });
      const timeout = setTimeout(() => { p.kill(); reject(new Error("Server startup timeout")); }, 10000);
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

  it("GET /api/deadlines returns future-dated changes with countdown_days", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/api/deadlines`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("access-control-allow-origin"), "*");
    const body = await response.json() as any;
    assert.ok(Array.isArray(body.deadlines), "Should have deadlines array");
    assert.ok(typeof body.count === "number", "Should have count");
    assert.strictEqual(body.count, body.deadlines.length, "Count should match array length");
    if (body.deadlines.length > 0) {
      const first = body.deadlines[0];
      assert.ok(first.vendor, "Should have vendor");
      assert.ok(first.date, "Should have date");
      assert.ok(first.summary, "Should have summary");
      assert.ok(first.change_type, "Should have change_type");
      assert.ok(typeof first.countdown_days === "number", "Should have countdown_days");
      assert.ok(first.countdown_days > 0, "countdown_days should be positive (future date)");
    }
  });

  it("GET /api/deadlines results are sorted by date ascending", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/api/deadlines`);
    const body = await response.json() as any;
    for (let i = 1; i < body.deadlines.length; i++) {
      assert.ok(
        body.deadlines[i].date >= body.deadlines[i - 1].date,
        `Deadline ${body.deadlines[i].vendor} (${body.deadlines[i].date}) should be after or same as ${body.deadlines[i - 1].vendor} (${body.deadlines[i - 1].date})`
      );
    }
  });

  it("GET /api/deadlines supports type filter", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/api/deadlines?type=product_deprecated`);
    assert.strictEqual(response.status, 200);
    const body = await response.json() as any;
    for (const d of body.deadlines) {
      assert.strictEqual(d.change_type, "product_deprecated", "All results should match the type filter");
    }
  });

  it("GET /api/deadlines with unknown type returns empty", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/api/deadlines?type=nonexistent_type`);
    assert.strictEqual(response.status, 200);
    const body = await response.json() as any;
    assert.strictEqual(body.count, 0, "Unknown type should return no results");
    assert.deepStrictEqual(body.deadlines, []);
  });

  it("GET /api/deadlines all dates are in the future", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/api/deadlines`);
    const body = await response.json() as any;
    const today = new Date().toISOString().slice(0, 10);
    for (const d of body.deadlines) {
      assert.ok(d.date > today, `Deadline ${d.vendor} date ${d.date} should be after today (${today})`);
    }
  });

  it("GET /api/deadlines countdown_days are consistent with dates", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/api/deadlines`);
    const body = await response.json() as any;
    for (const d of body.deadlines) {
      assert.ok(d.countdown_days >= 1, `countdown_days for ${d.vendor} should be at least 1`);
    }
  });
});

describe("deadlines page data", () => {
  it("loadDealChanges includes future-dated entries", async () => {
    const { loadDealChanges } = await import("../dist/data.js");
    const changes = loadDealChanges();
    const today = new Date().toISOString().slice(0, 10);
    const future = changes.filter((c: any) => c.date > today);
    assert.ok(future.length > 0, "Should have future-dated changes for the deadlines page");
  });
});

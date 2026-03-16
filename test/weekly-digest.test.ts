import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("getWeeklyDigest logic", () => {
  it("returns a well-formed digest object", async () => {
    const { getWeeklyDigest } = await import("../dist/data.js");
    const digest = getWeeklyDigest();
    assert.ok(digest.week, "should have week field");
    assert.ok(digest.date_range, "should have date_range field");
    assert.ok(Array.isArray(digest.deal_changes), "deal_changes should be an array");
    assert.ok(Array.isArray(digest.new_offers), "new_offers should be an array");
    assert.ok(Array.isArray(digest.upcoming_deadlines), "upcoming_deadlines should be an array");
    assert.ok(typeof digest.summary === "string" && digest.summary.length > 0, "summary should be a non-empty string");
  });
});

describe("get_weekly_digest REST endpoint", () => {
  const PORT = 3465;
  let proc: ChildProcess | null = null;

  function startHttpServer(): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const serverPath = path.join(__dirname, "..", "dist", "serve.js");
      const p = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: String(PORT) },
      });
      const timeout = setTimeout(() => { p.kill(); reject(new Error("Server startup timeout")); }, 5000);
      p.stderr!.on("data", (data: Buffer) => {
        if (data.toString().includes("running on http")) { clearTimeout(timeout); resolve(p); }
      });
      p.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
  }

  afterEach(() => {
    if (proc) { proc.kill(); proc = null; }
  });

  it("GET /api/digest returns weekly digest", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${PORT}/api/digest`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("content-type"), "application/json");
    assert.strictEqual(res.headers.get("access-control-allow-origin"), "*");
    const body = await res.json() as any;
    assert.ok(body.week);
    assert.ok(body.date_range);
    assert.ok(Array.isArray(body.deal_changes));
    assert.ok(Array.isArray(body.new_offers));
    assert.ok(Array.isArray(body.upcoming_deadlines));
    assert.ok(typeof body.summary === "string");
  });
});

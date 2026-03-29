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

  it("upcoming_deadlines includes deal changes with future dates", async () => {
    const { getWeeklyDigest, loadDealChanges } = await import("../dist/data.js");
    const allChanges = loadDealChanges() as Array<{ vendor: string; date: string; change_type: string; summary: string }>;
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const futureChanges = allChanges.filter((c) => c.date >= today && c.date <= thirtyDaysFromNow);

    const digest = getWeeklyDigest();

    // Every future deal change within 30 days should appear in upcoming_deadlines
    for (const fc of futureChanges) {
      const found = digest.upcoming_deadlines.find(
        (d: any) => d.vendor === fc.vendor && d.date === fc.date
      );
      assert.ok(found, `Expected upcoming_deadlines to include ${fc.vendor} (${fc.date})`);
      assert.strictEqual(found.change_type, fc.change_type, `change_type should match for ${fc.vendor}`);
      assert.ok(found.summary && found.summary.length > 0, `summary should be non-empty for ${fc.vendor}`);
    }
  });

  it("upcoming_deadlines does not include past deal changes", async () => {
    const { getWeeklyDigest, loadDealChanges } = await import("../dist/data.js");
    const allChanges = loadDealChanges() as Array<{ vendor: string; date: string }>;
    const today = new Date().toISOString().slice(0, 10);
    const pastChanges = allChanges.filter((c) => c.date < today);

    const digest = getWeeklyDigest();

    for (const pc of pastChanges) {
      const found = digest.upcoming_deadlines.find(
        (d: any) => d.vendor === pc.vendor && d.date === pc.date && d.change_type !== "deal_expiring"
      );
      assert.ok(!found, `Past change ${pc.vendor} (${pc.date}) should NOT be in upcoming_deadlines`);
    }
  });

  it("upcoming_deadlines are sorted by date ascending", async () => {
    const { getWeeklyDigest } = await import("../dist/data.js");
    const digest = getWeeklyDigest();
    const deadlines = digest.upcoming_deadlines;

    for (let i = 1; i < deadlines.length; i++) {
      assert.ok(
        deadlines[i].date >= deadlines[i - 1].date,
        `Deadlines should be sorted ascending: ${deadlines[i - 1].date} should come before ${deadlines[i].date}`
      );
    }
  });

  it("upcoming_deadlines entries have required fields", async () => {
    const { getWeeklyDigest } = await import("../dist/data.js");
    const digest = getWeeklyDigest();

    for (const d of digest.upcoming_deadlines) {
      assert.ok(typeof d.vendor === "string" && d.vendor.length > 0, "vendor required");
      assert.ok(typeof d.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.date), "date required in YYYY-MM-DD format");
      assert.ok(typeof d.change_type === "string" && d.change_type.length > 0, "change_type required");
      assert.ok(typeof d.summary === "string" && d.summary.length > 0, "summary required");
    }
  });
});

describe("get_weekly_digest REST endpoint", () => {
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

  it("GET /api/digest returns weekly digest", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/api/digest`);
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

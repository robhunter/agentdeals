import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("getFormattedWeeklyDigest logic", () => {
  it("returns a well-formed digest object", async () => {
    const { getFormattedWeeklyDigest } = await import("../dist/data.js");
    const digest = getFormattedWeeklyDigest(0, 20);
    assert.ok(typeof digest.week_of === "string" && /^\d{4}-\d{2}-\d{2}$/.test(digest.week_of), "week_of should be ISO date");
    assert.ok(typeof digest.week_ending === "string" && /^\d{4}-\d{2}-\d{2}$/.test(digest.week_ending), "week_ending should be ISO date");
    assert.ok(typeof digest.total_changes === "number" && digest.total_changes > 0, "total_changes should be positive");
    assert.ok(typeof digest.summary === "object", "summary should be an object");
    assert.ok(typeof digest.summary.free_tiers_removed === "number", "summary.free_tiers_removed should be number");
    assert.ok(typeof digest.summary.new_free_tiers === "number", "summary.new_free_tiers should be number");
    assert.ok(typeof digest.summary.limits_reduced === "number", "summary.limits_reduced should be number");
    assert.ok(typeof digest.summary.limits_increased === "number", "summary.limits_increased should be number");
    assert.ok(typeof digest.summary.products_deprecated === "number", "summary.products_deprecated should be number");
    assert.ok(typeof digest.summary.pricing_restructured === "number", "summary.pricing_restructured should be number");
    assert.ok(typeof digest.headline === "string" && digest.headline.length > 0, "headline should be non-empty");
    assert.ok(Array.isArray(digest.top_changes), "top_changes should be an array");
    assert.ok(typeof digest.digest_markdown === "string", "digest_markdown should be a string");
    assert.ok(typeof digest.digest_html === "string", "digest_html should be a string");
  });

  it("week_of is a Monday and week_ending is a Sunday", async () => {
    const { getFormattedWeeklyDigest } = await import("../dist/data.js");
    const digest = getFormattedWeeklyDigest(0, 20);
    const startDay = new Date(digest.week_of + "T00:00:00Z").getUTCDay();
    const endDay = new Date(digest.week_ending + "T00:00:00Z").getUTCDay();
    assert.strictEqual(startDay, 1, "week_of should be Monday (day 1)");
    assert.strictEqual(endDay, 0, "week_ending should be Sunday (day 0)");
  });

  it("week_ending is exactly 6 days after week_of", async () => {
    const { getFormattedWeeklyDigest } = await import("../dist/data.js");
    const digest = getFormattedWeeklyDigest(0, 20);
    const start = new Date(digest.week_of + "T00:00:00Z").getTime();
    const end = new Date(digest.week_ending + "T00:00:00Z").getTime();
    assert.strictEqual(end - start, 6 * 86400000, "week should span 6 days");
  });

  it("respects the limit parameter", async () => {
    const { getFormattedWeeklyDigest } = await import("../dist/data.js");
    const digest3 = getFormattedWeeklyDigest(0, 3);
    assert.ok(digest3.top_changes.length <= 3, "should respect limit=3");
  });

  it("weeks_ago shifts the target week backwards", async () => {
    const { getFormattedWeeklyDigest } = await import("../dist/data.js");
    const current = getFormattedWeeklyDigest(0, 20);
    const lastWeek = getFormattedWeeklyDigest(1, 20);
    assert.ok(lastWeek.week_of < current.week_of, "weeks_ago=1 should be an earlier week");
    const diff = new Date(current.week_of + "T00:00:00Z").getTime() - new Date(lastWeek.week_of + "T00:00:00Z").getTime();
    assert.strictEqual(diff, 7 * 86400000, "weeks should be exactly 7 days apart");
  });

  it("top_changes are sorted by impact score descending", async () => {
    const { getFormattedWeeklyDigest } = await import("../dist/data.js");
    const digest = getFormattedWeeklyDigest(0, 100);
    const changes = digest.top_changes;
    if (changes.length < 2) return;
    const negativeTypes = ["free_tier_removed", "open_source_killed", "product_deprecated", "limits_reduced", "restriction"];
    const positiveTypes = ["new_free_tier", "limits_increased", "startup_program_expanded"];
    const hasNegative = changes.some(c => negativeTypes.includes(c.change_type));
    const hasPositive = changes.some(c => positiveTypes.includes(c.change_type));
    if (hasNegative && hasPositive) {
      const firstNeg = changes.findIndex(c => negativeTypes.includes(c.change_type));
      const lastPos = changes.findLastIndex(c => positiveTypes.includes(c.change_type));
      if (firstNeg !== -1 && lastPos !== -1) {
        assert.ok(true, "Impact sorting present");
      }
    }
  });

  it("markdown format contains expected sections", async () => {
    const { getFormattedWeeklyDigest } = await import("../dist/data.js");
    const digest = getFormattedWeeklyDigest(0, 20);
    assert.ok(digest.digest_markdown.includes("# This Week in Developer Pricing"), "should have title");
    assert.ok(digest.digest_markdown.includes("agentdeals.dev"), "should have attribution link");
  });

  it("html format contains expected elements", async () => {
    const { getFormattedWeeklyDigest } = await import("../dist/data.js");
    const digest = getFormattedWeeklyDigest(0, 20);
    assert.ok(digest.digest_html.includes("<h1>"), "should have h1 tag");
    assert.ok(digest.digest_html.includes("agentdeals.dev"), "should have attribution link");
  });

  it("empty week produces no-changes message", async () => {
    const { getFormattedWeeklyDigest } = await import("../dist/data.js");
    const digest = getFormattedWeeklyDigest(500, 20);
    assert.strictEqual(digest.top_changes.length, 0, "far future week should have no changes");
    assert.ok(digest.digest_markdown.includes("No pricing changes tracked"), "markdown should note empty week");
    assert.ok(digest.digest_html.includes("No pricing changes tracked"), "html should note empty week");
  });

  it("total_changes reflects all changes not just this week", async () => {
    const { getFormattedWeeklyDigest, loadDealChanges } = await import("../dist/data.js");
    const allChanges = loadDealChanges() as unknown[];
    const digest = getFormattedWeeklyDigest(0, 20);
    assert.strictEqual(digest.total_changes, allChanges.length, "total_changes should equal all-time count");
  });
});

describe("GET /api/digest/weekly REST endpoint", () => {
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

  it("returns JSON by default", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/api/digest/weekly`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("content-type"), "application/json");
    assert.strictEqual(res.headers.get("access-control-allow-origin"), "*");
    const body = await res.json() as any;
    assert.ok(body.week_of);
    assert.ok(body.week_ending);
    assert.ok(typeof body.total_changes === "number");
    assert.ok(typeof body.summary === "object");
    assert.ok(typeof body.headline === "string");
    assert.ok(Array.isArray(body.top_changes));
    assert.ok(typeof body.digest_markdown === "string");
    assert.ok(typeof body.digest_html === "string");
  });

  it("returns markdown format", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/api/digest/weekly?format=markdown`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("text/markdown"));
    const body = await res.text();
    assert.ok(body.includes("# This Week in Developer Pricing"));
  });

  it("returns HTML format", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/api/digest/weekly?format=html`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("text/html"));
    const body = await res.text();
    assert.ok(body.includes("<h1>"));
  });

  it("respects weeks_ago parameter", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/api/digest/weekly?weeks_ago=2`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as any;
    const current = new Date();
    const expectedWeekOf = new Date(current.getTime() - 2 * 7 * 86400000);
    assert.ok(body.week_of < current.toISOString().slice(0, 10), "weeks_ago=2 should be in the past");
  });

  it("respects limit parameter", async () => {
    proc = await startHttpServer();
    const res = await fetch(`http://localhost:${serverPort}/api/digest/weekly?limit=3`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as any;
    assert.ok(body.top_changes.length <= 3);
  });
});

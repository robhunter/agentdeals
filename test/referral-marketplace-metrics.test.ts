import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  recordReferralListingCall,
  recordReferralVendorLookup,
  getReferralMarketplaceStats,
  loadTelemetry,
  flushTelemetry,
  resetCounters,
} = await import("../src/stats.ts");

describe("referral marketplace stats module", () => {
  beforeEach(() => {
    resetCounters();
  });

  it("recordReferralListingCall(null) increments total + null bucket", () => {
    recordReferralListingCall(null);
    recordReferralListingCall(null);
    const s = getReferralMarketplaceStats();
    assert.strictEqual(s.total_listing_calls, 2);
    assert.strictEqual(s.listing_calls_by_source.null, 2);
    assert.strictEqual(s.listing_calls_by_source.platform, 0);
    assert.strictEqual(s.listing_calls_by_source.agent, 0);
  });

  it("recordReferralListingCall buckets by source", () => {
    recordReferralListingCall("platform");
    recordReferralListingCall("platform");
    recordReferralListingCall("agent");
    recordReferralListingCall(null);
    const s = getReferralMarketplaceStats();
    assert.strictEqual(s.total_listing_calls, 4);
    assert.deepStrictEqual(s.listing_calls_by_source, { platform: 2, agent: 1, null: 1 });
  });

  it("recordReferralVendorLookup aggregates by lowercased vendor", () => {
    recordReferralVendorLookup("Railway");
    recordReferralVendorLookup("railway");
    recordReferralVendorLookup("Vercel");
    const s = getReferralMarketplaceStats();
    assert.strictEqual(s.total_vendor_lookups, 3);
    const railway = s.vendor_lookups_top.find(v => v.vendor === "railway");
    assert.ok(railway);
    assert.strictEqual(railway.count, 2);
  });

  it("vendor_lookups_top returns descending-count list, capped at 10", () => {
    for (let i = 0; i < 15; i++) {
      const vendor = `vendor${i}`;
      for (let j = 0; j <= i; j++) {
        recordReferralVendorLookup(vendor);
      }
    }
    const s = getReferralMarketplaceStats();
    assert.strictEqual(s.vendor_lookups_top.length, 10);
    assert.strictEqual(s.vendor_lookups_top[0].vendor, "vendor14");
    assert.strictEqual(s.vendor_lookups_top[0].count, 15);
    // Sorted descending
    for (let i = 1; i < s.vendor_lookups_top.length; i++) {
      assert.ok(s.vendor_lookups_top[i - 1].count >= s.vendor_lookups_top[i].count);
    }
  });

  it("empty-string vendor is ignored", () => {
    recordReferralVendorLookup("");
    const s = getReferralMarketplaceStats();
    assert.strictEqual(s.total_vendor_lookups, 0);
  });
});

describe("referral marketplace telemetry persistence", () => {
  it("seeds cumulative counts from telemetry file and accumulates new activity", async () => {
    const tmpDir = join(tmpdir(), `referral-metrics-${randomUUID()}`);
    const telemetryFile = join(tmpDir, "telemetry.json");
    mkdirSync(tmpDir, { recursive: true });

    resetCounters();

    const seed = {
      cumulative_sessions: 0,
      cumulative_tool_calls: 0,
      cumulative_api_hits: 0,
      cumulative_landing_views: 0,
      first_session_at: "2026-04-01T00:00:00.000Z",
      last_deploy_at: "2026-04-15T00:00:00.000Z",
      cumulative_referral_listing_calls: 25,
      cumulative_referral_listing_by_source: { platform: 10, agent: 7, null: 8 },
      cumulative_referral_vendor_lookups: 42,
      cumulative_referral_vendor_counts: { railway: 20, vercel: 15, supabase: 7 },
    };
    writeFileSync(telemetryFile, JSON.stringify(seed));

    await loadTelemetry(telemetryFile);

    const s0 = getReferralMarketplaceStats();
    assert.strictEqual(s0.total_listing_calls, 25);
    assert.deepStrictEqual(s0.listing_calls_by_source, { platform: 10, agent: 7, null: 8 });
    assert.strictEqual(s0.total_vendor_lookups, 42);
    assert.strictEqual(s0.vendor_lookups_top[0].vendor, "railway");
    assert.strictEqual(s0.vendor_lookups_top[0].count, 20);

    // Simulate new activity this deployment
    recordReferralListingCall("platform");
    recordReferralListingCall(null);
    recordReferralVendorLookup("railway");
    recordReferralVendorLookup("newvendor");

    const s1 = getReferralMarketplaceStats();
    assert.strictEqual(s1.total_listing_calls, 27);
    assert.deepStrictEqual(s1.listing_calls_by_source, { platform: 11, agent: 7, null: 9 });
    assert.strictEqual(s1.total_vendor_lookups, 44);
    const railway = s1.vendor_lookups_top.find(v => v.vendor === "railway");
    assert.ok(railway);
    assert.strictEqual(railway.count, 21);
    const newv = s1.vendor_lookups_top.find(v => v.vendor === "newvendor");
    assert.ok(newv);
    assert.strictEqual(newv.count, 1);

    // Flush and confirm persisted
    await flushTelemetry();
    const persisted = JSON.parse(readFileSync(telemetryFile, "utf-8"));
    assert.strictEqual(persisted.cumulative_referral_listing_calls, 27);
    assert.deepStrictEqual(persisted.cumulative_referral_listing_by_source, { platform: 11, agent: 7, null: 9 });
    assert.strictEqual(persisted.cumulative_referral_vendor_lookups, 44);
    assert.strictEqual(persisted.cumulative_referral_vendor_counts.railway, 21);
    assert.strictEqual(persisted.cumulative_referral_vendor_counts.newvendor, 1);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializes cleanly with no prior telemetry", async () => {
    resetCounters();
    const tmpDir = join(tmpdir(), `referral-metrics-empty-${randomUUID()}`);
    const missingFile = join(tmpDir, "nonexistent", "telemetry.json");
    await loadTelemetry(missingFile);

    const s = getReferralMarketplaceStats();
    assert.strictEqual(s.total_listing_calls, 0);
    assert.strictEqual(s.total_vendor_lookups, 0);
    assert.deepStrictEqual(s.listing_calls_by_source, { platform: 0, agent: 0, null: 0 });
    assert.deepStrictEqual(s.vendor_lookups_top, []);
  });
});

describe("GET /api/metrics endpoint", () => {
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

  it("returns a referral_marketplace block with the documented shape", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/metrics`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("application/json"));
    const body = await res.json() as any;
    assert.ok(body.referral_marketplace, "referral_marketplace block missing");
    const rm = body.referral_marketplace;
    assert.strictEqual(typeof rm.total_listing_calls, "number");
    assert.strictEqual(typeof rm.total_vendor_lookups, "number");
    assert.strictEqual(typeof rm.listing_calls_by_source.platform, "number");
    assert.strictEqual(typeof rm.listing_calls_by_source.agent, "number");
    assert.strictEqual(typeof rm.listing_calls_by_source.null, "number");
    assert.ok(Array.isArray(rm.vendor_lookups_top));
    // Existing stats should still be present
    assert.strictEqual(typeof body.cumulative_tool_calls, "number");
    assert.strictEqual(typeof body.cumulative_api_hits, "number");
  });

  it("increments counters when listing endpoint is called", async () => {
    const before = await (await fetch(`http://localhost:${serverPort}/api/metrics`)).json() as any;
    const beforeTotal = before.referral_marketplace.total_listing_calls;
    const beforePlatform = before.referral_marketplace.listing_calls_by_source.platform;

    await fetch(`http://localhost:${serverPort}/api/referral-codes?source=platform`);
    await fetch(`http://localhost:${serverPort}/api/referral-codes?source=platform`);
    await fetch(`http://localhost:${serverPort}/api/referral-codes`);

    const after = await (await fetch(`http://localhost:${serverPort}/api/metrics`)).json() as any;
    assert.strictEqual(after.referral_marketplace.total_listing_calls, beforeTotal + 3);
    assert.strictEqual(after.referral_marketplace.listing_calls_by_source.platform, beforePlatform + 2);
    assert.strictEqual(after.referral_marketplace.listing_calls_by_source.null, before.referral_marketplace.listing_calls_by_source.null + 1);
  });

  it("increments vendor_lookups on /api/referral-codes/:vendor call", async () => {
    const before = await (await fetch(`http://localhost:${serverPort}/api/metrics`)).json() as any;
    const beforeTotal = before.referral_marketplace.total_vendor_lookups;

    await fetch(`http://localhost:${serverPort}/api/referral-codes/railway`);
    await fetch(`http://localhost:${serverPort}/api/referral-codes/railway`);
    await fetch(`http://localhost:${serverPort}/api/referral-codes/nonexistent-vendor-xyz`);

    const after = await (await fetch(`http://localhost:${serverPort}/api/metrics`)).json() as any;
    assert.strictEqual(after.referral_marketplace.total_vendor_lookups, beforeTotal + 3);
    const railway = after.referral_marketplace.vendor_lookups_top.find((v: any) => v.vendor === "railway");
    assert.ok(railway);
    assert.ok(railway.count >= 2);
  });

  it("/api/metrics responds to HEAD", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/metrics`, { method: "HEAD" });
    assert.strictEqual(res.status, 200);
  });
});

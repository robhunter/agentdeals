import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const {
  loadTelemetry,
  flushTelemetry,
  recordApiHit,
  recordSearchQuery,
  getApiHitsByEndpoint,
  getSearchAnalytics,
  resetCounters,
} = await import("../src/stats.ts");

describe("per-endpoint API analytics persistence (#965)", () => {
  beforeEach(() => {
    resetCounters();
  });

  it("persists cumulative_api_hits_by_endpoint across simulated restart", async () => {
    const tmpDir = join(tmpdir(), `api-hits-${randomUUID()}`);
    const telemetryFile = join(tmpDir, "telemetry.json");
    mkdirSync(tmpDir, { recursive: true });

    // Seed file with prior cumulative hits
    const seed = {
      cumulative_sessions: 0,
      cumulative_tool_calls: 0,
      cumulative_api_hits: 50,
      cumulative_landing_views: 0,
      first_session_at: "",
      last_deploy_at: "",
      cumulative_api_hits_by_endpoint: {
        "/api/offers": 30,
        "/api/changes": 20,
      },
    };
    writeFileSync(telemetryFile, JSON.stringify(seed));

    await loadTelemetry(telemetryFile);

    // Before any activity, cumulative breakdown reflects seed
    const before = getApiHitsByEndpoint();
    assert.strictEqual(before["/api/offers"], 30);
    assert.strictEqual(before["/api/changes"], 20);

    // Simulate this-deploy traffic
    recordApiHit("/api/offers");
    recordApiHit("/api/offers");
    recordApiHit("/api/categories");

    const after = getApiHitsByEndpoint();
    assert.strictEqual(after["/api/offers"], 32, "merges seed (30) + current (2)");
    assert.strictEqual(after["/api/changes"], 20, "preserves seed-only endpoints");
    assert.strictEqual(after["/api/categories"], 1, "adds new endpoints not in seed");

    await flushTelemetry();

    const persisted = JSON.parse(readFileSync(telemetryFile, "utf-8"));
    assert.strictEqual(persisted.cumulative_api_hits_by_endpoint["/api/offers"], 32);
    assert.strictEqual(persisted.cumulative_api_hits_by_endpoint["/api/changes"], 20);
    assert.strictEqual(persisted.cumulative_api_hits_by_endpoint["/api/categories"], 1);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads cleanly when telemetry file lacks cumulative_api_hits_by_endpoint (backward compat)", async () => {
    const tmpDir = join(tmpdir(), `api-hits-back-${randomUUID()}`);
    const telemetryFile = join(tmpDir, "telemetry.json");
    mkdirSync(tmpDir, { recursive: true });

    // Pre-#965 telemetry shape (no api_hits_by_endpoint, no search_queries)
    const oldShape = {
      cumulative_sessions: 100,
      cumulative_tool_calls: 50,
      cumulative_api_hits: 200,
      cumulative_landing_views: 25,
      first_session_at: "2026-03-01T00:00:00.000Z",
      last_deploy_at: "2026-03-01T00:00:00.000Z",
    };
    writeFileSync(telemetryFile, JSON.stringify(oldShape));

    await loadTelemetry(telemetryFile);

    // No throws, breakdown starts empty
    const breakdown = getApiHitsByEndpoint();
    assert.deepStrictEqual(breakdown, {});

    // Recording works after backward-compat load
    recordApiHit("/api/offers");
    const breakdown2 = getApiHitsByEndpoint();
    assert.strictEqual(breakdown2["/api/offers"], 1);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("search query ring buffer persistence (#965)", () => {
  beforeEach(() => {
    resetCounters();
  });

  it("persists cumulative_search_queries across simulated restart", async () => {
    const tmpDir = join(tmpdir(), `search-ring-${randomUUID()}`);
    const telemetryFile = join(tmpDir, "telemetry.json");
    mkdirSync(tmpDir, { recursive: true });

    // Seed file with prior queries (recent timestamps so they fall within 7d window)
    const recentISO = new Date(Date.now() - 60_000).toISOString();
    const seed = {
      cumulative_sessions: 0,
      cumulative_tool_calls: 0,
      cumulative_api_hits: 0,
      cumulative_landing_views: 0,
      first_session_at: "",
      last_deploy_at: "",
      cumulative_search_queries: [
        { query: "redis", timestamp: recentISO, results_count: 5, category: "databases" },
        { query: "redis", timestamp: recentISO, results_count: 5, category: "databases" },
        { query: "missing-thing", timestamp: recentISO, results_count: 0 },
      ],
    };
    writeFileSync(telemetryFile, JSON.stringify(seed));

    await loadTelemetry(telemetryFile);

    // Hydrated entries appear in analytics immediately (no need to re-record)
    const analytics = getSearchAnalytics();
    const redisEntry = analytics.top_queries_7d.find((q) => q.query === "redis");
    assert.ok(redisEntry, "redis should appear in top queries");
    assert.strictEqual(redisEntry!.count, 2);
    assert.strictEqual(analytics.zero_result_queries_7d.length, 1);
    assert.strictEqual(analytics.zero_result_queries_7d[0].query, "missing-thing");
    assert.strictEqual(analytics.queries_by_category_7d["databases"], 2);

    // Add a new query this deploy, flush, and verify it joined the persisted ring
    recordSearchQuery("postgres", 8, "databases");
    await flushTelemetry();

    const persisted = JSON.parse(readFileSync(telemetryFile, "utf-8"));
    assert.ok(Array.isArray(persisted.cumulative_search_queries));
    assert.strictEqual(persisted.cumulative_search_queries.length, 4);
    const lastEntry = persisted.cumulative_search_queries[3];
    assert.strictEqual(lastEntry.query, "postgres");
    assert.strictEqual(lastEntry.results_count, 8);
    assert.strictEqual(lastEntry.category, "databases");
    assert.ok(typeof lastEntry.timestamp === "string");
    assert.ok(!Number.isNaN(new Date(lastEntry.timestamp).getTime()));

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("caps the ring buffer at 1000 entries and evicts oldest", async () => {
    // Push 1100 entries, expect last 1000 to remain
    for (let i = 0; i < 1100; i++) {
      recordSearchQuery(`q${i}`, 1);
    }

    const tmpDir = join(tmpdir(), `search-ring-cap-${randomUUID()}`);
    const telemetryFile = join(tmpDir, "telemetry.json");
    mkdirSync(tmpDir, { recursive: true });

    await loadTelemetry(telemetryFile);
    // loadTelemetry without a prior file resets buffer; re-push to test cap
    for (let i = 0; i < 1100; i++) {
      recordSearchQuery(`q${i}`, 1);
    }
    await flushTelemetry();

    const persisted = JSON.parse(readFileSync(telemetryFile, "utf-8"));
    assert.strictEqual(persisted.cumulative_search_queries.length, 1000);
    // Oldest 100 evicted — first persisted should be q100
    assert.strictEqual(persisted.cumulative_search_queries[0].query, "q100");
    assert.strictEqual(persisted.cumulative_search_queries[999].query, "q1099");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ignores malformed persisted entries on load (defensive)", async () => {
    const tmpDir = join(tmpdir(), `search-ring-malformed-${randomUUID()}`);
    const telemetryFile = join(tmpDir, "telemetry.json");
    mkdirSync(tmpDir, { recursive: true });

    const recentISO = new Date(Date.now() - 60_000).toISOString();
    const seed = {
      cumulative_sessions: 0,
      cumulative_tool_calls: 0,
      cumulative_api_hits: 0,
      cumulative_landing_views: 0,
      first_session_at: "",
      last_deploy_at: "",
      cumulative_search_queries: [
        { query: "valid", timestamp: recentISO, results_count: 1 },
        { query: "missing-timestamp", results_count: 1 },
        { timestamp: recentISO, results_count: 1 },
        null,
        "garbage",
        { query: "valid2", timestamp: recentISO, results_count: 0 },
      ],
    };
    writeFileSync(telemetryFile, JSON.stringify(seed));

    await loadTelemetry(telemetryFile);

    const analytics = getSearchAnalytics();
    const queries = new Set(analytics.top_queries_7d.map((q) => q.query));
    assert.ok(queries.has("valid"));
    assert.ok(queries.has("valid2"));
    assert.ok(!queries.has("missing-timestamp"));

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("backward compat: telemetry.json without cumulative_search_queries loads cleanly", async () => {
    const tmpDir = join(tmpdir(), `search-ring-back-${randomUUID()}`);
    const telemetryFile = join(tmpDir, "telemetry.json");
    mkdirSync(tmpDir, { recursive: true });

    const oldShape = {
      cumulative_sessions: 1,
      cumulative_tool_calls: 1,
      cumulative_api_hits: 1,
      cumulative_landing_views: 1,
      first_session_at: "2026-03-01T00:00:00.000Z",
      last_deploy_at: "2026-03-01T00:00:00.000Z",
    };
    writeFileSync(telemetryFile, JSON.stringify(oldShape));

    await loadTelemetry(telemetryFile);

    const analytics = getSearchAnalytics();
    assert.deepStrictEqual(analytics.top_queries_7d, []);

    // After load, recording new queries works
    recordSearchQuery("vercel", 3, "hosting");
    const analytics2 = getSearchAnalytics();
    assert.strictEqual(analytics2.top_queries_7d.length, 1);
    assert.strictEqual(analytics2.top_queries_7d[0].query, "vercel");

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

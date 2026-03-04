import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
const {
  loadTelemetry,
  flushTelemetry,
  recordSessionConnect,
  recordToolCall,
  recordApiHit,
  recordLandingPageView,
  getStats,
  useRedis,
  resetCounters,
} = await import("../src/stats.ts");

describe("telemetry persistence", () => {
  const tmpDir = join(tmpdir(), `telemetry-test-${randomUUID()}`);
  const telemetryFile = join(tmpDir, "telemetry.json");

  it("loads seed data and accumulates across simulated restart", async () => {
    // Simulate pre-existing telemetry from a previous deploy
    mkdirSync(tmpDir, { recursive: true });
    const seed = {
      cumulative_sessions: 95,
      cumulative_tool_calls: 412,
      cumulative_api_hits: 203,
      cumulative_landing_views: 87,
      first_session_at: "2026-03-01T00:00:00.000Z",
      last_deploy_at: "2026-03-03T12:00:00.000Z",
    };
    writeFileSync(telemetryFile, JSON.stringify(seed));

    // Load telemetry (simulates server startup)
    await loadTelemetry(telemetryFile);

    // Before any activity, cumulative should reflect seed values
    const stats0 = getStats();
    assert.strictEqual(stats0.cumulative_sessions, 95);
    assert.strictEqual(stats0.cumulative_tool_calls, 412);
    assert.strictEqual(stats0.cumulative_api_hits, 203);
    assert.strictEqual(stats0.cumulative_landing_views, 87);
    assert.strictEqual(stats0.first_session_at, "2026-03-01T00:00:00.000Z");
    assert.ok(stats0.last_deploy_at); // Updated to current server start
    assert.strictEqual(stats0.total_sessions, 0); // No sessions this deploy yet

    // Simulate activity
    recordSessionConnect();
    recordSessionConnect();
    recordToolCall("search_offers");
    recordToolCall("search_offers");
    recordToolCall("list_categories");
    recordApiHit("/api/offers");
    recordLandingPageView();

    // Current stats should show both session-level and cumulative
    const stats1 = getStats();
    assert.strictEqual(stats1.total_sessions, 2);
    assert.strictEqual(stats1.cumulative_sessions, 97); // 95 + 2
    assert.strictEqual(stats1.total_tool_calls, 3);
    assert.strictEqual(stats1.cumulative_tool_calls, 415); // 412 + 3
    assert.strictEqual(stats1.total_api_hits, 1);
    assert.strictEqual(stats1.cumulative_api_hits, 204); // 203 + 1
    assert.strictEqual(stats1.landing_page_views, 1);
    assert.strictEqual(stats1.cumulative_landing_views, 88); // 87 + 1

    // Flush to disk
    await flushTelemetry();

    // Verify file contents
    const persisted = JSON.parse(readFileSync(telemetryFile, "utf-8"));
    assert.strictEqual(persisted.cumulative_sessions, 97);
    assert.strictEqual(persisted.cumulative_tool_calls, 415);
    assert.strictEqual(persisted.cumulative_api_hits, 204);
    assert.strictEqual(persisted.cumulative_landing_views, 88);
    assert.strictEqual(persisted.first_session_at, "2026-03-01T00:00:00.000Z");
    assert.ok(persisted.last_deploy_at);

    // Clean up
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializes cleanly when no telemetry file exists", async () => {
    const missingFile = join(tmpDir, "nonexistent", "telemetry.json");
    // Should not throw
    await loadTelemetry(missingFile);

    const stats = getStats();
    assert.ok(typeof stats.cumulative_sessions === "number");
    assert.ok(typeof stats.last_deploy_at === "string");
  });
});

describe("redis telemetry", () => {
  beforeEach(() => {
    resetCounters();
  });

  it("useRedis returns false when env vars not set", () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    assert.strictEqual(useRedis(), false);
  });

  it("useRedis returns true when both env vars are set", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://fake-redis.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
    assert.strictEqual(useRedis(), true);
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it("useRedis returns false when only URL is set", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://fake-redis.upstash.io";
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    assert.strictEqual(useRedis(), false);
    delete process.env.UPSTASH_REDIS_REST_URL;
  });

  it("loads from redis when configured and data exists", async () => {
    const tmpDir2 = join(tmpdir(), `telemetry-redis-${randomUUID()}`);
    const telemetryFile2 = join(tmpDir2, "telemetry.json");

    const redisData = {
      cumulative_sessions: 200,
      cumulative_tool_calls: 500,
      cumulative_api_hits: 300,
      cumulative_landing_views: 100,
      first_session_at: "2026-01-01T00:00:00.000Z",
      last_deploy_at: "2026-03-03T00:00:00.000Z",
    };

    // Mock fetch to simulate Upstash REST API
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url: string | URL | Request, _init?: RequestInit) => {
      const body = JSON.parse(_init?.body as string);
      if (body[0] === "GET") {
        return new Response(JSON.stringify({ result: JSON.stringify(redisData) }));
      }
      if (body[0] === "SET") {
        return new Response(JSON.stringify({ result: "OK" }));
      }
      return new Response(JSON.stringify({ result: null }));
    };

    process.env.UPSTASH_REDIS_REST_URL = "https://fake-redis.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";

    await loadTelemetry(telemetryFile2);

    const stats = getStats();
    assert.strictEqual(stats.cumulative_sessions, 200);
    assert.strictEqual(stats.cumulative_tool_calls, 500);
    assert.strictEqual(stats.first_session_at, "2026-01-01T00:00:00.000Z");

    // Restore
    globalThis.fetch = originalFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    rmSync(tmpDir2, { recursive: true, force: true });
  });

  it("flushes to both redis and file when redis configured", async () => {
    const tmpDir3 = join(tmpdir(), `telemetry-flush-${randomUUID()}`);
    const telemetryFile3 = join(tmpDir3, "telemetry.json");
    mkdirSync(tmpDir3, { recursive: true });

    let redisSaved: string | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url: string | URL | Request, _init?: RequestInit) => {
      const body = JSON.parse(_init?.body as string);
      if (body[0] === "GET") {
        return new Response(JSON.stringify({ result: null }));
      }
      if (body[0] === "SET") {
        redisSaved = body[2];
        return new Response(JSON.stringify({ result: "OK" }));
      }
      return new Response(JSON.stringify({ result: null }));
    };

    process.env.UPSTASH_REDIS_REST_URL = "https://fake-redis.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";

    await loadTelemetry(telemetryFile3);
    await flushTelemetry();

    // Verify Redis received the data
    assert.ok(redisSaved, "Redis SET should have been called");
    const redisData = JSON.parse(redisSaved);
    assert.ok(typeof redisData.cumulative_sessions === "number");
    assert.ok(redisData.last_deploy_at);

    // Verify file also written
    const fileData = JSON.parse(readFileSync(telemetryFile3, "utf-8"));
    assert.ok(typeof fileData.cumulative_sessions === "number");

    // Restore
    globalThis.fetch = originalFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    rmSync(tmpDir3, { recursive: true, force: true });
  });

  it("falls back to file when redis GET fails", async () => {
    const tmpDir4 = join(tmpdir(), `telemetry-fallback-${randomUUID()}`);
    const telemetryFile4 = join(tmpDir4, "telemetry.json");
    mkdirSync(tmpDir4, { recursive: true });

    // Write file-based seed data
    const seed = {
      cumulative_sessions: 42,
      cumulative_tool_calls: 100,
      cumulative_api_hits: 50,
      cumulative_landing_views: 25,
      first_session_at: "2026-02-01T00:00:00.000Z",
      last_deploy_at: "2026-03-01T00:00:00.000Z",
    };
    writeFileSync(telemetryFile4, JSON.stringify(seed));

    // Mock fetch to simulate failure
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("Network error");
    };

    process.env.UPSTASH_REDIS_REST_URL = "https://fake-redis.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";

    await loadTelemetry(telemetryFile4);

    const stats = getStats();
    // Should have loaded from file despite Redis failure
    assert.strictEqual(stats.cumulative_sessions, 42);
    assert.strictEqual(stats.first_session_at, "2026-02-01T00:00:00.000Z");

    // Restore
    globalThis.fetch = originalFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    rmSync(tmpDir4, { recursive: true, force: true });
  });
});

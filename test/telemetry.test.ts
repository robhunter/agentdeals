import { describe, it } from "node:test";
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
} = await import("../src/stats.ts");

describe("telemetry persistence", () => {
  const tmpDir = join(tmpdir(), `telemetry-test-${randomUUID()}`);
  const telemetryFile = join(tmpDir, "telemetry.json");

  it("loads seed data and accumulates across simulated restart", () => {
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
    loadTelemetry(telemetryFile);

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
    flushTelemetry();

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

  it("initializes cleanly when no telemetry file exists", () => {
    const missingFile = join(tmpDir, "nonexistent", "telemetry.json");
    // Should not throw
    loadTelemetry(missingFile);

    const stats = getStats();
    assert.ok(typeof stats.cumulative_sessions === "number");
    assert.ok(typeof stats.last_deploy_at === "string");
  });
});

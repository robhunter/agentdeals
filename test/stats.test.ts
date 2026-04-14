import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";

const {
  recordToolCall,
  recordApiHit,
  recordSessionConnect,
  recordSessionDisconnect,
  recordLandingPageView,
  recordPageView,
  getStats,
  getConnectionStats,
  getPageViewsToday,
  resetCounters,
  useRedis,
} = await import("../dist/stats.js");

describe("stats", () => {
  beforeEach(() => {
    resetCounters();
  });

  describe("recordToolCall", () => {
    it("increments known tool counters", () => {
      recordToolCall("search_deals");
      recordToolCall("search_deals");
      recordToolCall("plan_stack");
      const stats = getStats();
      assert.strictEqual(stats.tool_calls.search_deals, 2);
      assert.strictEqual(stats.tool_calls.plan_stack, 1);
      assert.strictEqual(stats.total_tool_calls, 3);
    });

    it("ignores unknown tool names", () => {
      recordToolCall("nonexistent_tool");
      const stats = getStats();
      assert.strictEqual(stats.total_tool_calls, 0);
    });
  });

  describe("recordApiHit", () => {
    it("increments known API endpoint counters", () => {
      recordApiHit("/api/offers");
      recordApiHit("/api/offers");
      recordApiHit("/api/categories");
      const stats = getStats();
      assert.strictEqual(stats.api_hits["/api/offers"], 2);
      assert.strictEqual(stats.api_hits["/api/categories"], 1);
      assert.strictEqual(stats.total_api_hits, 3);
    });

    it("ignores unknown endpoints", () => {
      recordApiHit("/api/unknown");
      const stats = getStats();
      assert.strictEqual(stats.total_api_hits, 0);
    });
  });

  describe("recordSessionConnect", () => {
    it("increments session counters", () => {
      recordSessionConnect("claude-desktop");
      recordSessionConnect("claude-desktop");
      recordSessionConnect("cursor");
      const stats = getStats();
      assert.strictEqual(stats.total_sessions, 3);
      assert.strictEqual(stats.cumulative_sessions, 3);
    });

    it("tracks sessions today with daily reset", () => {
      recordSessionConnect();
      recordSessionConnect();
      const connStats = getConnectionStats(1);
      assert.strictEqual(connStats.sessionsToday, 2);
    });

    it("defaults to 'unknown' when no client name provided", () => {
      recordSessionConnect();
      const connStats = getConnectionStats(0);
      assert.ok(connStats.clients["unknown"] >= 1);
    });

    it("tracks client names in connection stats", () => {
      recordSessionConnect("claude-desktop");
      recordSessionConnect("cursor");
      recordSessionConnect("claude-desktop");
      const connStats = getConnectionStats(0);
      assert.strictEqual(connStats.clients["claude-desktop"], 2);
      assert.strictEqual(connStats.clients["cursor"], 1);
    });
  });

  describe("recordSessionDisconnect", () => {
    it("increments disconnect counter", () => {
      recordSessionDisconnect();
      recordSessionDisconnect();
      const stats = getStats();
      assert.strictEqual(stats.total_disconnects, 2);
    });
  });

  describe("recordLandingPageView", () => {
    it("increments landing page view counter", () => {
      recordLandingPageView();
      recordLandingPageView();
      recordLandingPageView();
      const stats = getStats();
      assert.strictEqual(stats.landing_page_views, 3);
      assert.strictEqual(stats.cumulative_landing_views, 3);
    });
  });

  describe("recordPageView", () => {
    it("increments in-memory page view counter for non-bots", () => {
      const before = getPageViewsToday();
      recordPageView("/", "Mozilla/5.0 Chrome/120");
      recordPageView("/about", "Mozilla/5.0 Firefox/120");
      assert.strictEqual(getPageViewsToday() - before, 2);
    });

    it("skips bot user agents", () => {
      const before = getPageViewsToday();
      recordPageView("/", "Googlebot/2.1");
      recordPageView("/", "bingbot/2.0");
      recordPageView("/", "AhrefsBot/7.0");
      recordPageView("/", "GPTBot/1.0");
      recordPageView("/", "ClaudeBot/1.0");
      assert.strictEqual(getPageViewsToday() - before, 0);
    });

    it("skips spider and crawler user agents", () => {
      const before = getPageViewsToday();
      recordPageView("/", "Mozilla/5.0 (compatible; spider-bot)");
      recordPageView("/", "SomeCrawler/1.0");
      assert.strictEqual(getPageViewsToday() - before, 0);
    });
  });

  describe("getStats", () => {
    it("returns all expected fields", () => {
      const stats = getStats();
      assert.strictEqual(typeof stats.uptime_seconds, "number");
      assert.strictEqual(typeof stats.total_tool_calls, "number");
      assert.ok(typeof stats.tool_calls === "object");
      assert.strictEqual(typeof stats.total_api_hits, "number");
      assert.ok(typeof stats.api_hits === "object");
      assert.strictEqual(typeof stats.total_sessions, "number");
      assert.strictEqual(typeof stats.total_disconnects, "number");
      assert.strictEqual(typeof stats.landing_page_views, "number");
      assert.strictEqual(typeof stats.cumulative_sessions, "number");
      assert.strictEqual(typeof stats.cumulative_tool_calls, "number");
      assert.strictEqual(typeof stats.cumulative_api_hits, "number");
      assert.strictEqual(typeof stats.cumulative_landing_views, "number");
      assert.strictEqual(typeof stats.page_views_today, "number");
      assert.strictEqual(typeof stats.first_session_at, "string");
      assert.strictEqual(typeof stats.last_deploy_at, "string");
    });

    it("starts with zero counters after reset", () => {
      const stats = getStats();
      assert.strictEqual(stats.total_tool_calls, 0);
      assert.strictEqual(stats.total_api_hits, 0);
      assert.strictEqual(stats.total_sessions, 0);
      assert.strictEqual(stats.total_disconnects, 0);
      assert.strictEqual(stats.landing_page_views, 0);
    });

    it("returns uptime greater than or equal to zero", () => {
      const stats = getStats();
      assert.ok(stats.uptime_seconds >= 0);
    });
  });

  describe("getConnectionStats", () => {
    it("returns activeSessions from argument", () => {
      const connStats = getConnectionStats(5);
      assert.strictEqual(connStats.activeSessions, 5);
    });

    it("includes serverStarted ISO string", () => {
      const connStats = getConnectionStats(0);
      assert.ok(connStats.serverStarted);
      assert.ok(connStats.serverStarted.includes("T"));
    });

    it("accumulates all-time stats correctly", () => {
      recordSessionConnect("test");
      recordToolCall("search_deals");
      recordApiHit("/api/offers");
      const connStats = getConnectionStats(1);
      assert.strictEqual(connStats.totalSessionsAllTime, 1);
      assert.strictEqual(connStats.totalToolCallsAllTime, 1);
      assert.strictEqual(connStats.totalApiHitsAllTime, 1);
    });
  });

  describe("resetCounters", () => {
    it("resets all counters to zero", () => {
      recordToolCall("search_deals");
      recordApiHit("/api/offers");
      recordSessionConnect("test");
      recordSessionDisconnect();
      recordLandingPageView();
      resetCounters();
      const stats = getStats();
      assert.strictEqual(stats.total_tool_calls, 0);
      assert.strictEqual(stats.total_api_hits, 0);
      assert.strictEqual(stats.total_sessions, 0);
      assert.strictEqual(stats.total_disconnects, 0);
      assert.strictEqual(stats.landing_page_views, 0);
      assert.strictEqual(stats.cumulative_sessions, 0);
    });
  });

  describe("useRedis", () => {
    it("returns false when env vars are not set", () => {
      const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
      const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      assert.strictEqual(useRedis(), false);
      if (originalUrl) process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      if (originalToken) process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
    });
  });

  describe("getPageViewsToday", () => {
    it("returns a number", () => {
      assert.strictEqual(typeof getPageViewsToday(), "number");
    });

    it("increases when page views are recorded", () => {
      const before = getPageViewsToday();
      recordPageView("/test", "Mozilla/5.0");
      recordPageView("/test2", "Mozilla/5.0");
      assert.strictEqual(getPageViewsToday() - before, 2);
    });
  });
});

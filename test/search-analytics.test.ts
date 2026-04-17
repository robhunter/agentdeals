import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";

const {
  recordSearchQuery,
  getSearchAnalytics,
  resetCounters,
} = await import("../src/stats.ts");

describe("search analytics", () => {
  beforeEach(() => {
    resetCounters();
  });

  it("returns empty analytics when no queries recorded", () => {
    const analytics = getSearchAnalytics();
    assert.deepStrictEqual(analytics.top_queries_7d, []);
    assert.deepStrictEqual(analytics.zero_result_queries_7d, []);
    assert.deepStrictEqual(analytics.queries_by_category_7d, {});
  });

  it("tracks top queries sorted by frequency", () => {
    recordSearchQuery("redis", 5);
    recordSearchQuery("redis", 3);
    recordSearchQuery("redis", 2);
    recordSearchQuery("postgres", 10);
    recordSearchQuery("postgres", 8);
    recordSearchQuery("mongodb", 4);
    const analytics = getSearchAnalytics();
    assert.strictEqual(analytics.top_queries_7d.length, 3);
    assert.strictEqual(analytics.top_queries_7d[0].query, "redis");
    assert.strictEqual(analytics.top_queries_7d[0].count, 3);
    assert.strictEqual(analytics.top_queries_7d[1].query, "postgres");
    assert.strictEqual(analytics.top_queries_7d[1].count, 2);
    assert.strictEqual(analytics.top_queries_7d[2].query, "mongodb");
    assert.strictEqual(analytics.top_queries_7d[2].count, 1);
  });

  it("normalizes queries to lowercase and trimmed", () => {
    recordSearchQuery("  Redis  ", 5);
    recordSearchQuery("REDIS", 3);
    recordSearchQuery("redis", 2);
    const analytics = getSearchAnalytics();
    assert.strictEqual(analytics.top_queries_7d.length, 1);
    assert.strictEqual(analytics.top_queries_7d[0].query, "redis");
    assert.strictEqual(analytics.top_queries_7d[0].count, 3);
  });

  it("ignores undefined and empty queries", () => {
    recordSearchQuery(undefined, 5);
    recordSearchQuery("", 3);
    recordSearchQuery("   ", 2);
    const analytics = getSearchAnalytics();
    assert.deepStrictEqual(analytics.top_queries_7d, []);
  });

  it("tracks zero-result queries", () => {
    recordSearchQuery("graphql hosting", 0);
    recordSearchQuery("graphql hosting", 0);
    recordSearchQuery("redis", 5);
    recordSearchQuery("nonexistent tool", 0);
    const analytics = getSearchAnalytics();
    assert.strictEqual(analytics.zero_result_queries_7d.length, 2);
    assert.strictEqual(analytics.zero_result_queries_7d[0].query, "graphql hosting");
    assert.strictEqual(analytics.zero_result_queries_7d[0].count, 2);
    assert.strictEqual(analytics.zero_result_queries_7d[1].query, "nonexistent tool");
    assert.strictEqual(analytics.zero_result_queries_7d[1].count, 1);
  });

  it("tracks queries by category", () => {
    recordSearchQuery("redis", 5, "databases");
    recordSearchQuery("postgres", 10, "databases");
    recordSearchQuery("vercel", 3, "hosting");
    recordSearchQuery("stripe", 2);
    const analytics = getSearchAnalytics();
    assert.strictEqual(analytics.queries_by_category_7d["databases"], 2);
    assert.strictEqual(analytics.queries_by_category_7d["hosting"], 1);
    assert.strictEqual(analytics.queries_by_category_7d["stripe"], undefined);
  });

  it("caps top_queries_7d at 20", () => {
    for (let i = 0; i < 25; i++) {
      recordSearchQuery(`query${i}`, 1);
    }
    const analytics = getSearchAnalytics();
    assert.strictEqual(analytics.top_queries_7d.length, 20);
  });

  it("caps zero_result_queries_7d at 10", () => {
    for (let i = 0; i < 15; i++) {
      recordSearchQuery(`missing${i}`, 0);
    }
    const analytics = getSearchAnalytics();
    assert.strictEqual(analytics.zero_result_queries_7d.length, 10);
  });

  it("resetCounters clears search analytics", () => {
    recordSearchQuery("redis", 5);
    recordSearchQuery("nothing", 0);
    resetCounters();
    const analytics = getSearchAnalytics();
    assert.deepStrictEqual(analytics.top_queries_7d, []);
    assert.deepStrictEqual(analytics.zero_result_queries_7d, []);
    assert.deepStrictEqual(analytics.queries_by_category_7d, {});
  });

  it("search_analytics appears in expected shape", () => {
    recordSearchQuery("test", 3, "testing");
    const analytics = getSearchAnalytics();
    assert.ok(Array.isArray(analytics.top_queries_7d));
    assert.ok(Array.isArray(analytics.zero_result_queries_7d));
    assert.strictEqual(typeof analytics.queries_by_category_7d, "object");
    assert.ok(!Array.isArray(analytics.queries_by_category_7d));
  });
});

import { describe, it } from "node:test";
import assert from "node:assert";

describe("sanitizeQuery", () => {
  it("strips backticks and other special characters from queries", async () => {
    const { sanitizeQuery } = await import("../dist/data.js");

    // Backtick (the real user case from analytics)
    assert.strictEqual(sanitizeQuery("database`"), "database");

    // Quotes, brackets, parentheses, semicolons, pipes
    assert.strictEqual(sanitizeQuery('database"hosting'), "databasehosting");
    assert.strictEqual(sanitizeQuery("redis[free]"), "redisfree");
    assert.strictEqual(sanitizeQuery("postgres(free)"), "postgresfree");
    assert.strictEqual(sanitizeQuery("test;drop"), "testdrop");
    assert.strictEqual(sanitizeQuery("a|b"), "ab");

    // Preserves valid characters: hyphens, spaces, dots, plus signs
    assert.strictEqual(sanitizeQuery("ci-cd tools"), "ci-cd tools");
    assert.strictEqual(sanitizeQuery("node.js"), "node.js");
    assert.strictEqual(sanitizeQuery("c++"), "c++");

    // Trims and normalizes whitespace
    assert.strictEqual(sanitizeQuery("  database  hosting  "), "database hosting");

    // Empty after sanitization
    assert.strictEqual(sanitizeQuery("```"), "");
  });

  it("sanitized queries return the same results as clean queries", async () => {
    const { searchOffers, sanitizeQuery } = await import("../dist/data.js");

    const cleanResults = searchOffers("database");
    const dirtyResults = searchOffers(sanitizeQuery("database`"));

    assert.ok(cleanResults.length > 0, "database should return results");
    assert.strictEqual(cleanResults.length, dirtyResults.length, "database` should return same count as database");
  });
});

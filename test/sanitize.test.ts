import { describe, it } from "node:test";
import assert from "node:assert";

describe("sanitizeQuery", () => {
  it("strips backticks and other special characters from queries", async () => {
    const { sanitizeQuery } = await import("../dist/data.js");

    assert.strictEqual(sanitizeQuery("database`"), "database");

    assert.strictEqual(sanitizeQuery('database"hosting'), "database hosting");
    assert.strictEqual(sanitizeQuery("redis[free]"), "redis free");
    assert.strictEqual(sanitizeQuery("postgres(free)"), "postgres free");
    assert.strictEqual(sanitizeQuery("test;drop"), "test drop");
    assert.strictEqual(sanitizeQuery("a|b"), "a b");

    assert.strictEqual(sanitizeQuery("ci-cd tools"), "ci-cd tools");
    assert.strictEqual(sanitizeQuery("node.js"), "node.js");
    assert.strictEqual(sanitizeQuery("c++"), "c++");

    assert.strictEqual(sanitizeQuery("  database  hosting  "), "database hosting");

    assert.strictEqual(sanitizeQuery("```"), "");
  });

  it("sanitized queries return the same results as clean queries", async () => {
    const { searchOffers, sanitizeQuery } = await import("../dist/data.js");

    const cleanResults = searchOffers("database");
    const dirtyResults = searchOffers(sanitizeQuery("database`"));

    assert.ok(cleanResults.length > 0, "database should return results");
    assert.strictEqual(cleanResults.length, dirtyResults.length, "database` should return same count as database");
  });

  it("finds a vendor by its own name when the name carries a character the sanitizer replaces", async () => {
    const { searchOffers, sanitizeQuery, loadOffers } = await import("../dist/data.js");
    const vendors: string[] = [...new Set<string>(loadOffers().map((o: { vendor: string }) => o.vendor))];
    const punctuated = vendors.filter((vendor) => sanitizeQuery(vendor) !== vendor);
    assert.ok(punctuated.length > 0, "no vendor name carries a character the sanitizer replaces, so this census proves nothing");

    const unfound = punctuated.filter(
      (vendor) => !searchOffers(sanitizeQuery(vendor)).some((o: { vendor: string }) => o.vendor === vendor),
    );
    assert.deepStrictEqual(unfound, [], "a search for a vendor's own name does not return that vendor");
  });
});

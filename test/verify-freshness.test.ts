import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { findStaleOffers, fetchPageText, verifyWithHaiku, verifyFreshness } =
  await import("../scripts/verify-freshness.js");

describe("verify-freshness", () => {
  const now = new Date("2026-03-16T00:00:00Z");

  describe("findStaleOffers", () => {
    it("skips fresh entries", () => {
      const offers = [
        { vendor: "Fresh", category: "Hosting", url: "https://example.com", verifiedDate: "2026-03-10" },
        { vendor: "AlsoFresh", category: "CI/CD", url: "https://example.com", verifiedDate: "2026-03-15" },
      ];
      const { stale, freshCount } = findStaleOffers(offers, 25, now);
      assert.strictEqual(stale.length, 0);
      assert.strictEqual(freshCount, 2);
    });

    it("identifies stale entries beyond threshold", () => {
      const offers = [
        { vendor: "Fresh", category: "Hosting", url: "https://example.com", verifiedDate: "2026-03-10" },
        { vendor: "Stale", category: "Databases", url: "https://example.com", verifiedDate: "2026-02-01" },
        { vendor: "VeryStale", category: "CI/CD", url: "https://example.com", verifiedDate: "2025-12-01" },
      ];
      const { stale, freshCount } = findStaleOffers(offers, 25, now);
      assert.strictEqual(stale.length, 2);
      assert.strictEqual(freshCount, 1);
    });

    it("treats missing verifiedDate as stale", () => {
      const offers = [
        { vendor: "NoDate", category: "Auth", url: "https://example.com" },
      ];
      const { stale } = findStaleOffers(offers, 25, now);
      assert.strictEqual(stale.length, 1);
      assert.strictEqual(stale[0].offer.vendor, "NoDate");
    });

    it("sorts stale entries by staleness descending", () => {
      const offers = [
        { vendor: "A", category: "A", url: "https://example.com", verifiedDate: "2026-02-10" },
        { vendor: "B", category: "B", url: "https://example.com", verifiedDate: "2025-12-01" },
        { vendor: "C", category: "C", url: "https://example.com", verifiedDate: "2026-01-15" },
      ];
      const { stale } = findStaleOffers(offers, 25, now);
      assert.strictEqual(stale.length, 3);
      // B is oldest (106 days), then C (60 days), then A (34 days)
      assert.strictEqual(stale[0].offer.vendor, "B");
      assert.strictEqual(stale[1].offer.vendor, "C");
      assert.strictEqual(stale[2].offer.vendor, "A");
    });

    it("preserves original index for data updates", () => {
      const offers = [
        { vendor: "Fresh", category: "A", url: "https://example.com", verifiedDate: "2026-03-15" },
        { vendor: "Stale", category: "B", url: "https://example.com", verifiedDate: "2026-01-01" },
        { vendor: "AlsoStale", category: "C", url: "https://example.com", verifiedDate: "2026-01-15" },
      ];
      const { stale } = findStaleOffers(offers, 25, now);
      // Stale (index 1) is 74 days old, AlsoStale (index 2) is 60 days — sorted by staleness
      assert.strictEqual(stale[0].index, 1);
      assert.strictEqual(stale[0].offer.vendor, "Stale");
      assert.strictEqual(stale[1].index, 2);
      assert.strictEqual(stale[1].offer.vendor, "AlsoStale");
    });

    it("respects custom threshold", () => {
      const offers = [
        { vendor: "A", category: "Hosting", url: "https://example.com", verifiedDate: "2026-03-10" },
        { vendor: "B", category: "Hosting", url: "https://example.com", verifiedDate: "2026-03-14" },
      ];
      const { stale, freshCount } = findStaleOffers(offers, 5, now);
      assert.strictEqual(stale.length, 1);
      assert.strictEqual(stale[0].offer.vendor, "A");
      assert.strictEqual(freshCount, 1);
    });
  });

  describe("fetchPageText", () => {
    it("returns error for unreachable URLs", async () => {
      const result = await fetchPageText("http://localhost:19999/nonexistent");
      assert.strictEqual(result.ok, false);
      assert.ok(result.error);
    });

    it("returns error for non-200 responses", async () => {
      const result = await fetchPageText("https://httpstat.us/404");
      assert.strictEqual(result.ok, false);
      assert.ok(result.error?.includes("404") || result.error?.includes("timeout") || result.error);
    });
  });

  describe("verifyWithHaiku", () => {
    it("parses confirmed response", async () => {
      const mockClient = {
        messages: {
          create: async () => ({
            content: [{ text: '{"status":"confirmed"}' }],
          }),
        },
      };
      const offer = { vendor: "Test", category: "Hosting", tier: "Free", description: "Free hosting" };
      const result = await verifyWithHaiku(mockClient, offer, "Free hosting plan available");
      assert.strictEqual(result.status, "confirmed");
    });

    it("parses changed response", async () => {
      const mockClient = {
        messages: {
          create: async () => ({
            content: [{ text: '{"status":"changed","summary":"Free tier removed"}' }],
          }),
        },
      };
      const offer = { vendor: "Test", category: "Hosting", tier: "Free", description: "Free hosting" };
      const result = await verifyWithHaiku(mockClient, offer, "Paid plans start at $5/mo");
      assert.strictEqual(result.status, "changed");
      assert.strictEqual(result.summary, "Free tier removed");
    });

    it("handles unclear response", async () => {
      const mockClient = {
        messages: {
          create: async () => ({
            content: [{ text: '{"status":"unclear","summary":"Page requires login"}' }],
          }),
        },
      };
      const offer = { vendor: "Test", category: "Hosting", tier: "Free", description: "Free hosting" };
      const result = await verifyWithHaiku(mockClient, offer, "Please sign in");
      assert.strictEqual(result.status, "unclear");
    });

    it("handles malformed AI response gracefully", async () => {
      const mockClient = {
        messages: {
          create: async () => ({
            content: [{ text: "I think the deal looks correct" }],
          }),
        },
      };
      const offer = { vendor: "Test", category: "Hosting", tier: "Free", description: "Free hosting" };
      const result = await verifyWithHaiku(mockClient, offer, "Free hosting");
      assert.strictEqual(result.status, "unclear");
    });

    it("extracts JSON from verbose AI response", async () => {
      const mockClient = {
        messages: {
          create: async () => ({
            content: [{ text: 'The deal is still valid. {"status":"confirmed"}' }],
          }),
        },
      };
      const offer = { vendor: "Test", category: "Hosting", tier: "Free", description: "Free hosting" };
      const result = await verifyWithHaiku(mockClient, offer, "Free hosting plan available");
      assert.strictEqual(result.status, "confirmed");
    });
  });

  describe("verifyFreshness (integration with mock)", () => {
    let tmpDir;
    let indexPath;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "verify-freshness-"));
      indexPath = join(tmpDir, "index.json");
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("reports all fresh when no stale entries", async () => {
      const data = {
        offers: [
          { vendor: "Fresh", category: "Hosting", url: "https://example.com", verifiedDate: "2026-04-01", tier: "Free", description: "Free plan" },
        ],
      };
      writeFileSync(indexPath, JSON.stringify(data));

      const result = await verifyFreshness({ thresholdDays: 25, dryRun: true, indexPath });
      assert.strictEqual(result.verified, 0);
      assert.strictEqual(result.alreadyFresh, 1);
    });

    it("dry-run does not modify index file", async () => {
      const data = {
        offers: [
          { vendor: "Stale", category: "Hosting", url: "http://localhost:19999/fake", verifiedDate: "2025-01-01", tier: "Free", description: "Free plan" },
        ],
      };
      writeFileSync(indexPath, JSON.stringify(data));
      const before = readFileSync(indexPath, "utf-8");

      await verifyFreshness({ thresholdDays: 25, dryRun: true, indexPath });
      const after = readFileSync(indexPath, "utf-8");
      assert.strictEqual(before, after);
    });

    it("respects limit parameter", async () => {
      const offers = Array.from({ length: 10 }, (_, i) => ({
        vendor: `V${i}`,
        category: "Hosting",
        url: "http://localhost:19999/fake",
        verifiedDate: "2025-01-01",
        tier: "Free",
        description: "Free plan",
      }));
      writeFileSync(indexPath, JSON.stringify({ offers }));

      const result = await verifyFreshness({ thresholdDays: 25, dryRun: true, limit: 3, indexPath });
      // Should attempt at most 3, skip the rest
      assert.strictEqual(result.skipped, 7);
      assert.ok(result.failed <= 3);
    });
  });
});

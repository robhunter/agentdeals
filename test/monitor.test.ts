import { describe, it } from "node:test";
import assert from "node:assert";

const { extractTextContent, isDueForCheck } = await import("../scripts/monitor-pricing.js");

describe("pricing monitor", () => {
  describe("extractTextContent", () => {
    it("strips HTML tags and returns visible text", () => {
      const html = "<html><body><h1>Pricing</h1><p>Free tier: 100 requests/day</p></body></html>";
      const text = extractTextContent(html);
      assert.ok(text.includes("Pricing"));
      assert.ok(text.includes("Free tier: 100 requests/day"));
      assert.ok(!text.includes("<h1>"));
    });

    it("removes head, script, style, and SVG content", () => {
      const html = `
        <html>
          <head><title>Page</title><script>var x=1;</script></head>
          <body>
            <script>console.log('hi');</script>
            <style>.red{color:red}</style>
            <svg><path d="M0 0"/></svg>
            <p>Visible content</p>
          </body>
        </html>`;
      const text = extractTextContent(html);
      assert.ok(text.includes("Visible content"));
      assert.ok(!text.includes("console.log"));
      assert.ok(!text.includes(".red"));
      assert.ok(!text.includes("M0 0"));
    });

    it("removes hex hashes and UUIDs for stability", () => {
      const html = "<body><p>Build abcdef1234567890</p><p>ID: 550e8400-e29b-41d4-a716-446655440000</p><p>Price: $10/mo</p></body>";
      const text = extractTextContent(html);
      assert.ok(text.includes("Price: $10/mo"));
      assert.ok(!text.includes("abcdef1234567890"));
      assert.ok(!text.includes("550e8400"));
    });

    it("removes ISO timestamps and Unix timestamps", () => {
      const html = "<body><p>Updated 2026-03-01T12:00:00Z</p><p>ts=1709308800000</p><p>$5/month</p></body>";
      const text = extractTextContent(html);
      assert.ok(text.includes("$5/month"));
      assert.ok(!text.includes("2026-03-01T12:00"));
    });
  });

  describe("isDueForCheck", () => {
    const now = new Date("2026-03-03T12:00:00Z");

    it("returns true when no previous check exists", () => {
      assert.strictEqual(isDueForCheck({ interval: "daily" }, null, now), true);
      assert.strictEqual(isDueForCheck({ interval: "weekly" }, undefined, now), true);
    });

    it("returns true for daily vendors checked >24h ago", () => {
      const lastCheck = "2026-03-02T10:00:00Z"; // 26 hours ago
      assert.strictEqual(isDueForCheck({ interval: "daily" }, lastCheck, now), true);
    });

    it("returns false for daily vendors checked <24h ago", () => {
      const lastCheck = "2026-03-03T10:00:00Z"; // 2 hours ago
      assert.strictEqual(isDueForCheck({ interval: "daily" }, lastCheck, now), false);
    });

    it("returns true for weekly vendors checked >168h ago", () => {
      const lastCheck = "2026-02-24T10:00:00Z"; // 8 days ago
      assert.strictEqual(isDueForCheck({ interval: "weekly" }, lastCheck, now), true);
    });

    it("returns false for weekly vendors checked <168h ago", () => {
      const lastCheck = "2026-03-01T12:00:00Z"; // 2 days ago
      assert.strictEqual(isDueForCheck({ interval: "weekly" }, lastCheck, now), false);
    });
  });
});

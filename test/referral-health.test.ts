import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";

const { runHealthCheck, isUrlSuspended, getLastReport, resetHealthState, getFailureCount } = await import("../dist/referral-health.js");

describe("referral-health", () => {
  beforeEach(() => {
    resetHealthState();
  });

  it("runHealthCheck returns a report with expected shape", async () => {
    const report = await runHealthCheck();
    assert.ok(report.checked_at);
    assert.strictEqual(typeof report.total, "number");
    assert.strictEqual(typeof report.valid, "number");
    assert.strictEqual(typeof report.invalid, "number");
    assert.ok(Array.isArray(report.results));
    assert.strictEqual(report.total, report.valid + report.invalid);
  });

  it("each result has vendor, url, status, valid, source", async () => {
    const report = await runHealthCheck();
    for (const r of report.results) {
      assert.ok(r.vendor, "result should have vendor");
      assert.ok(r.url, "result should have url");
      assert.strictEqual(typeof r.valid, "boolean");
      assert.ok(["curated", "agent-submitted"].includes(r.source));
    }
  });

  it("getLastReport returns null before first check", () => {
    const report = getLastReport();
    assert.strictEqual(report, null);
  });

  it("getLastReport returns report after check", async () => {
    await runHealthCheck();
    const report = getLastReport();
    assert.ok(report);
    assert.ok(report!.checked_at);
  });

  it("isUrlSuspended returns false for unchecked URLs", () => {
    assert.strictEqual(isUrlSuspended("https://example.com/ref"), false);
  });

  it("getFailureCount returns 0 for unknown URLs", () => {
    assert.strictEqual(getFailureCount("https://example.com/ref"), 0);
  });

  it("valid URLs are not suspended after a single check", async () => {
    const report = await runHealthCheck();
    for (const r of report.results) {
      if (r.valid) {
        assert.strictEqual(isUrlSuspended(r.url), false);
      }
    }
  });

  it("valid URLs have failure count reset to 0", async () => {
    const report = await runHealthCheck();
    for (const r of report.results) {
      if (r.valid) {
        assert.strictEqual(getFailureCount(r.url), 0);
      }
    }
  });

  it("resetHealthState clears all state", async () => {
    await runHealthCheck();
    assert.ok(getLastReport());
    resetHealthState();
    assert.strictEqual(getLastReport(), null);
  });
});

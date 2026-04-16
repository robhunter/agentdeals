import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_CODES_PATH = path.join(__dirname, "..", "data", "platform_codes.json");

const {
  getPlatformCodeForVendor,
  getAllPlatformCodes,
  resetPlatformCodesCache,
} = await import("../dist/platform-codes.js");

const originalData = fs.existsSync(PLATFORM_CODES_PATH)
  ? fs.readFileSync(PLATFORM_CODES_PATH, "utf-8")
  : "";

after(() => {
  if (originalData) {
    fs.writeFileSync(PLATFORM_CODES_PATH, originalData, "utf-8");
  }
  resetPlatformCodesCache();
});

describe("Platform Codes", () => {
  beforeEach(() => {
    // Restore original data and reset cache before each test
    if (originalData) {
      fs.writeFileSync(PLATFORM_CODES_PATH, originalData, "utf-8");
    }
    resetPlatformCodesCache();
  });

  it("loads platform codes from data file", () => {
    const codes = getAllPlatformCodes();
    assert.ok(Array.isArray(codes));
    assert.ok(codes.length >= 1, "Should have at least 1 platform code (Railway)");
  });

  it("returns Railway platform code", () => {
    const code = getPlatformCodeForVendor("Railway");
    assert.ok(code, "Railway should have a platform code");
    assert.strictEqual(code.vendor, "Railway");
    assert.strictEqual(code.code, "7RZL9q");
    assert.strictEqual(code.source, "platform");
    assert.ok(code.referral_url.includes("7RZL9q"));
    assert.strictEqual(code.referee_benefit, "$20 in credits");
  });

  it("returns null for vendor without platform code", () => {
    const code = getPlatformCodeForVendor("NonExistentVendor");
    assert.strictEqual(code, null);
  });

  it("is case-insensitive for vendor lookup", () => {
    const code = getPlatformCodeForVendor("railway");
    assert.ok(code, "Should match case-insensitively");
    assert.strictEqual(code.vendor, "Railway");
  });

  it("only returns active codes", () => {
    const testData = {
      platform_codes: [
        {
          vendor: "TestVendor",
          code: "TEST123",
          referral_url: "https://example.com?ref=TEST123",
          referrer_benefit: "10%",
          referee_benefit: "$10",
          source: "platform",
          active: false,
          added_at: "2026-04-15",
        },
      ],
    };
    fs.writeFileSync(PLATFORM_CODES_PATH, JSON.stringify(testData), "utf-8");
    resetPlatformCodesCache();

    const code = getPlatformCodeForVendor("TestVendor");
    assert.strictEqual(code, null, "Inactive codes should not be returned");

    const all = getAllPlatformCodes();
    assert.strictEqual(all.length, 0, "getAllPlatformCodes should only return active codes");
  });

  it("handles missing data file gracefully", () => {
    const backup = fs.readFileSync(PLATFORM_CODES_PATH, "utf-8");
    fs.unlinkSync(PLATFORM_CODES_PATH);
    resetPlatformCodesCache();

    const codes = getAllPlatformCodes();
    assert.deepStrictEqual(codes, []);

    const code = getPlatformCodeForVendor("Railway");
    assert.strictEqual(code, null);

    // Restore
    fs.writeFileSync(PLATFORM_CODES_PATH, backup, "utf-8");
    resetPlatformCodesCache();
  });
});

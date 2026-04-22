import { describe, it } from "node:test";
import assert from "node:assert";

const { findDuplicateCandidates, tierTokens, sharedTierTokens, formatMarkdown } = await import(
  "../scripts/lint-duplicates.js"
);

describe("tierTokens", () => {
  it("lowercases and splits on whitespace", () => {
    assert.deepStrictEqual([...tierTokens("Free")], ["free"]);
    assert.deepStrictEqual([...tierTokens("Startup Program")], ["startup", "program"]);
  });

  it("strips parens and punctuation", () => {
    assert.deepStrictEqual([...tierTokens("Free (Starter)")].sort(), ["free", "starter"]);
  });

  it("filters stopwords and short tokens", () => {
    assert.deepStrictEqual([...tierTokens("Basic Plan")], ["basic"]);
    assert.deepStrictEqual([...tierTokens("Hobby tier")], ["hobby"]);
  });

  it("handles empty and missing tiers", () => {
    assert.deepStrictEqual([...tierTokens("")], []);
    assert.deepStrictEqual([...tierTokens(undefined)], []);
    assert.deepStrictEqual([...tierTokens(null)], []);
  });
});

describe("sharedTierTokens", () => {
  it("returns shared tokens across tier strings", () => {
    assert.deepStrictEqual(sharedTierTokens("Starter", "Free (Starter)"), ["starter"]);
    assert.deepStrictEqual(sharedTierTokens("Free", "Free"), ["free"]);
  });

  it("returns empty for disjoint tiers", () => {
    assert.deepStrictEqual(sharedTierTokens("Developer", "OSS Sponsored"), []);
    assert.deepStrictEqual(sharedTierTokens("Free", "Student Program"), []);
    assert.deepStrictEqual(sharedTierTokens("Startup Program", "Free (Basic)"), []);
    assert.deepStrictEqual(sharedTierTokens("Credits", "Hatch"), []);
  });
});

describe("findDuplicateCandidates", () => {
  it("flags same-vendor same-tier multi-category pairs", () => {
    const offers = [
      { vendor: "Proton Mail", category: "Email", tier: "Free" },
      { vendor: "Proton Mail", category: "Consumer Email", tier: "Free" },
    ];
    const result = findDuplicateCandidates(offers);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].vendor, "Proton Mail");
    assert.deepStrictEqual(result[0].sharedTierTokens, ["free"]);
    assert.strictEqual(result[0].entries.length, 2);
  });

  it("flags Figma despite tier-string variation (Starter vs Free (Starter))", () => {
    const offers = [
      { vendor: "Figma", category: "Design", tier: "Starter" },
      { vendor: "Figma", category: "Design & Creative", tier: "Free (Starter)" },
    ];
    const result = findDuplicateCandidates(offers);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].vendor, "Figma");
    assert(result[0].sharedTierTokens.includes("starter"));
  });

  it("does NOT flag different vendor names (Amazon Kiro dual-entry)", () => {
    const offers = [
      { vendor: "Amazon Kiro (AWS Startups)", category: "Startup Programs", tier: "Startup Program" },
      { vendor: "Amazon Kiro", category: "AI Coding", tier: "Free" },
    ];
    const result = findDuplicateCandidates(offers);
    assert.strictEqual(result.length, 0);
  });

  it("does NOT flag distinct products under same brand (Proton Mail vs Proton VPN)", () => {
    const offers = [
      { vendor: "Proton Mail", category: "Email", tier: "Free" },
      { vendor: "Proton VPN", category: "VPN", tier: "Free" },
    ];
    const result = findDuplicateCandidates(offers);
    assert.strictEqual(result.length, 0);
  });

  it("does NOT flag same vendor with different tiers (Sentry, PostHog pattern)", () => {
    const offers = [
      { vendor: "Sentry", category: "Monitoring", tier: "Developer" },
      { vendor: "Sentry", category: "Startup Programs", tier: "OSS Sponsored" },
      { vendor: "PostHog", category: "Analytics", tier: "Free" },
      { vendor: "PostHog", category: "Startup Programs", tier: "YC Deal" },
    ];
    const result = findDuplicateCandidates(offers);
    assert.strictEqual(result.length, 0);
  });

  it("does NOT flag same vendor, same tier, but same single category", () => {
    const offers = [
      { vendor: "FooBar", category: "Analytics", tier: "Free" },
      { vendor: "FooBar", category: "Analytics", tier: "Free" },
    ];
    const result = findDuplicateCandidates(offers);
    assert.strictEqual(result.length, 0);
  });

  it("handles offers missing vendor or category without throwing", () => {
    const offers = [
      { category: "Email", tier: "Free" },
      { vendor: "Bar", tier: "Free" },
      { vendor: "Baz" },
    ];
    const result = findDuplicateCandidates(offers);
    assert.strictEqual(result.length, 0);
  });

  it("returns results sorted alphabetically by vendor", () => {
    const offers = [
      { vendor: "Zulu", category: "A", tier: "Free" },
      { vendor: "Zulu", category: "B", tier: "Free" },
      { vendor: "Alpha", category: "A", tier: "Free" },
      { vendor: "Alpha", category: "B", tier: "Free" },
    ];
    const result = findDuplicateCandidates(offers);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].vendor, "Alpha");
    assert.strictEqual(result[1].vendor, "Zulu");
  });
});

describe("formatMarkdown", () => {
  it("produces a friendly message when no candidates", () => {
    const out = formatMarkdown([]);
    assert.match(out, /No same-vendor-same-tier multi-category duplicates detected/);
  });

  it("includes each candidate and tier info", () => {
    const out = formatMarkdown([
      {
        vendor: "Figma",
        entries: [
          { category: "Design", tier: "Starter" },
          { category: "Design & Creative", tier: "Free (Starter)" },
        ],
        sharedTierTokens: ["starter"],
      },
    ]);
    assert.match(out, /### Figma/);
    assert.match(out, /Design — Starter/);
    assert.match(out, /Design & Creative — Free \(Starter\)/);
    assert.match(out, /starter/);
  });
});

describe("lint-duplicates against current data/index.json", () => {
  it("detects Figma, Proton Pass, and Proton Mail as candidates", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const indexPath = resolve(process.cwd(), "data", "index.json");
    const data = JSON.parse(readFileSync(indexPath, "utf-8"));
    const result = findDuplicateCandidates(data.offers || []);
    const vendors = result.map((c) => c.vendor);
    assert(vendors.includes("Figma"), `expected Figma in ${vendors.join(", ")}`);
    assert(vendors.includes("Proton Pass"), `expected Proton Pass in ${vendors.join(", ")}`);
    assert(vendors.includes("Proton Mail"), `expected Proton Mail in ${vendors.join(", ")}`);
  });

  it("does not flag Amazon Kiro (different vendor names)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const indexPath = resolve(process.cwd(), "data", "index.json");
    const data = JSON.parse(readFileSync(indexPath, "utf-8"));
    const result = findDuplicateCandidates(data.offers || []);
    const kiroFlagged = result.some((c) => c.vendor.toLowerCase().includes("kiro"));
    assert.strictEqual(kiroFlagged, false);
  });
});

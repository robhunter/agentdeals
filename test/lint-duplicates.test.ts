import { describe, it } from "node:test";
import assert from "node:assert";

const { findDuplicateCandidates, tierTokens, sharedTierTokens, formatMarkdown, normalizeVendor } =
  await import("../scripts/lint-duplicates.js");

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

describe("normalizeVendor", () => {
  it("lowercases and trims", () => {
    assert.strictEqual(normalizeVendor("  Foo  "), "foo");
    assert.strictEqual(normalizeVendor("FOO"), "foo");
  });

  it("strips TLD suffixes", () => {
    assert.strictEqual(normalizeVendor("photopea.com"), "photopea");
    assert.strictEqual(normalizeVendor("Cal.com"), "cal");
    assert.strictEqual(normalizeVendor("trigger.dev"), "trigger");
    assert.strictEqual(normalizeVendor("Adapty.io"), "adapty");
    assert.strictEqual(normalizeVendor("Daily.co"), "daily");
    assert.strictEqual(normalizeVendor("Neptune.ai"), "neptune");
    assert.strictEqual(normalizeVendor("BinShare.net"), "binshare");
    assert.strictEqual(normalizeVendor("Cron-job.org"), "cron-job");
    assert.strictEqual(normalizeVendor("Updrafts.app"), "updrafts");
  });

  it("does not strip TLD-shaped fragments mid-name", () => {
    // .com at start or middle is not a TLD suffix
    assert.strictEqual(normalizeVendor("com Foo"), "com foo");
    assert.strictEqual(normalizeVendor("Foo.com Bar"), "foo.com bar");
  });

  it("strips Inc./LLC/Ltd. corporate suffixes", () => {
    assert.strictEqual(normalizeVendor("Acme Inc."), "acme");
    assert.strictEqual(normalizeVendor("Acme Inc"), "acme");
    assert.strictEqual(normalizeVendor("Acme LLC"), "acme");
    assert.strictEqual(normalizeVendor("Acme Ltd"), "acme");
    assert.strictEqual(normalizeVendor("Acme Ltd."), "acme");
  });

  it("preserves parenthetical disambiguators (Amazon Kiro pattern)", () => {
    assert.notStrictEqual(
      normalizeVendor("Amazon Kiro"),
      normalizeVendor("Amazon Kiro (AWS Startups)"),
    );
  });

  it("handles empty/null/undefined", () => {
    assert.strictEqual(normalizeVendor(""), "");
    assert.strictEqual(normalizeVendor(null), "");
    assert.strictEqual(normalizeVendor(undefined), "");
  });

  it("groups TLD variants of the same vendor together", () => {
    assert.strictEqual(normalizeVendor("Photopea"), normalizeVendor("photopea.com"));
    assert.strictEqual(normalizeVendor("Evernote"), normalizeVendor("evernote.com"));
    assert.strictEqual(normalizeVendor("ClickUp"), normalizeVendor("clickup.com"));
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

  it("flags TLD-suffix variants of the same vendor (Photopea pattern)", () => {
    const offers = [
      { vendor: "photopea.com", category: "Design", tier: "Free" },
      { vendor: "Photopea", category: "Design & Creative", tier: "Free" },
    ];
    const result = findDuplicateCandidates(offers);
    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(result[0].vendorNameVariants, ["Photopea", "photopea.com"]);
    assert.deepStrictEqual(result[0].sharedTierTokens, ["free"]);
  });

  it("flags case-only variants of the same vendor", () => {
    const offers = [
      { vendor: "Trello", category: "Productivity & Notes", tier: "Free" },
      { vendor: "trello.com", category: "Project Management", tier: "Free" },
    ];
    const result = findDuplicateCandidates(offers);
    assert.strictEqual(result.length, 1);
    assert(result[0].vendorNameVariants);
    assert.strictEqual(result[0].vendorNameVariants.length, 2);
  });

  it("flags Inc./LLC corporate-suffix variants", () => {
    const offers = [
      { vendor: "Acme Inc.", category: "Monitoring", tier: "Free" },
      { vendor: "Acme", category: "Analytics", tier: "Free" },
    ];
    const result = findDuplicateCandidates(offers);
    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(result[0].vendorNameVariants, ["Acme", "Acme Inc."]);
  });

  it("does NOT flag TLD-variants when same category (case-variant in one category)", () => {
    const offers = [
      { vendor: "clickup.com", category: "Project Management", tier: "Free" },
      { vendor: "ClickUp", category: "Project Management", tier: "Free" },
    ];
    const result = findDuplicateCandidates(offers);
    assert.strictEqual(result.length, 0);
  });

  it("does NOT flag different vendors that share a root word (AWS S3 vs AWS EC2)", () => {
    const offers = [
      { vendor: "AWS S3", category: "Storage", tier: "Free" },
      { vendor: "AWS EC2", category: "Compute", tier: "Free" },
    ];
    const result = findDuplicateCandidates(offers);
    assert.strictEqual(result.length, 0);
  });

  it("omits vendorNameVariants field when all raw names match", () => {
    const offers = [
      { vendor: "Figma", category: "Design", tier: "Starter" },
      { vendor: "Figma", category: "Design & Creative", tier: "Free (Starter)" },
    ];
    const result = findDuplicateCandidates(offers);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].vendorNameVariants, undefined);
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

  it("surfaces vendor name variants when entries use different raw names", () => {
    const out = formatMarkdown([
      {
        vendor: "Photopea",
        entries: [
          { vendor: "photopea.com", category: "Design", tier: "Free" },
          { vendor: "Photopea", category: "Design & Creative", tier: "Free" },
        ],
        sharedTierTokens: ["free"],
        vendorNameVariants: ["Photopea", "photopea.com"],
      },
    ]);
    assert.match(out, /Vendor name variants: "Photopea", "photopea\.com"/);
    assert.match(out, /photopea\.com — Design — Free/);
    assert.match(out, /Photopea — Design & Creative — Free/);
  });
});

describe("lint-duplicates against current data/index.json", () => {
  // After PR #1003 added vendor-name normalization (TLD/corp suffix stripping),
  // 5 latent dups surfaced that the exact-match key missed. Each resolved in a
  // follow-up dedup PR. When the count reaches 0, flip this assertion to
  // `result.length === 0` (the original form).
  const EXPECTED_PENDING_VARIANTS = ["evernote", "internxt", "pcloud"];

  it("surfaces only known-pending normalized duplicate candidates", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const indexPath = resolve(process.cwd(), "data", "index.json");
    const data = JSON.parse(readFileSync(indexPath, "utf-8"));
    const result = findDuplicateCandidates(data.offers || []);
    const normalized = result.map((c) => normalizeVendor(c.vendor)).sort();
    assert.deepStrictEqual(
      normalized,
      EXPECTED_PENDING_VARIANTS,
      `candidate list drifted from expected — update EXPECTED_PENDING_VARIANTS after resolving in a dedup PR, or investigate if new ones appeared. got: ${normalized.join(", ")}`,
    );
  });

  it("all surfaced candidates are vendor-name variants (not straight dedup gaps)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const indexPath = resolve(process.cwd(), "data", "index.json");
    const data = JSON.parse(readFileSync(indexPath, "utf-8"));
    const result = findDuplicateCandidates(data.offers || []);
    // Every pending candidate should have vendorNameVariants set, confirming
    // the normalization (not the exact-match path) is what surfaced it.
    for (const c of result) {
      assert(
        c.vendorNameVariants && c.vendorNameVariants.length > 1,
        `${c.vendor} lacks vendorNameVariants — if this is a pure same-name dup, it should have been caught pre-normalization`,
      );
    }
  });

  it("does not flag Amazon Kiro (parenthetical suffix preserved)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const indexPath = resolve(process.cwd(), "data", "index.json");
    const data = JSON.parse(readFileSync(indexPath, "utf-8"));
    const result = findDuplicateCandidates(data.offers || []);
    const kiroFlagged = result.some((c) => c.vendor.toLowerCase().includes("kiro"));
    assert.strictEqual(kiroFlagged, false);
  });
});

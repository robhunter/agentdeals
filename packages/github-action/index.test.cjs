const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  parseDependencies,
  loadVendorMap,
  matchDependenciesToVendors,
  formatSummaryTable,
  formatPRComment,
  slugify,
  meetsThreshold,
  stabilityLevel,
} = require("./index.cjs");

// --- parseDependencies ---

describe("parseDependencies", () => {
  const tmpDir = path.join(__dirname, ".tmp-test");
  const tmpPkg = path.join(tmpDir, "package.json");

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts dependencies and devDependencies", () => {
    fs.writeFileSync(tmpPkg, JSON.stringify({
      dependencies: { "stripe": "^12.0.0", "@supabase/supabase-js": "^2.0.0" },
      devDependencies: { "vitest": "^1.0.0" },
    }));
    const deps = parseDependencies(tmpPkg);
    assert.ok(deps.includes("stripe"));
    assert.ok(deps.includes("@supabase/supabase-js"));
    assert.ok(deps.includes("vitest"));
    assert.equal(deps.length, 3);
  });

  it("handles missing dependencies field", () => {
    fs.writeFileSync(tmpPkg, JSON.stringify({ name: "test" }));
    const deps = parseDependencies(tmpPkg);
    assert.equal(deps.length, 0);
  });

  it("deduplicates entries across deps and devDeps", () => {
    fs.writeFileSync(tmpPkg, JSON.stringify({
      dependencies: { "stripe": "^12.0.0" },
      devDependencies: { "stripe": "^12.0.0" },
    }));
    const deps = parseDependencies(tmpPkg);
    assert.equal(deps.length, 1);
  });

  it("throws on invalid JSON", () => {
    fs.writeFileSync(tmpPkg, "not json");
    assert.throws(() => parseDependencies(tmpPkg));
  });
});

// --- loadVendorMap ---

describe("loadVendorMap", () => {
  it("loads mappings array", () => {
    const mappings = loadVendorMap();
    assert.ok(Array.isArray(mappings));
    assert.ok(mappings.length >= 50, `Expected at least 50 mappings, got ${mappings.length}`);
  });

  it("each mapping has pattern and vendor", () => {
    const mappings = loadVendorMap();
    for (const m of mappings) {
      assert.ok(typeof m.pattern === "string", `Missing pattern: ${JSON.stringify(m)}`);
      assert.ok(typeof m.vendor === "string", `Missing vendor: ${JSON.stringify(m)}`);
    }
  });
});

// --- matchDependenciesToVendors ---

describe("matchDependenciesToVendors", () => {
  const mappings = [
    { pattern: "@supabase/*", vendor: "Supabase" },
    { pattern: "supabase", vendor: "Supabase" },
    { pattern: "stripe", vendor: "Stripe" },
    { pattern: "@sentry/*", vendor: "Sentry" },
    { pattern: "openai", vendor: "OpenAI" },
  ];

  it("matches exact package names", () => {
    const result = matchDependenciesToVendors(["stripe", "openai"], mappings);
    assert.equal(result.size, 2);
    assert.deepEqual(result.get("Stripe"), ["stripe"]);
    assert.deepEqual(result.get("OpenAI"), ["openai"]);
  });

  it("matches scoped packages", () => {
    const result = matchDependenciesToVendors(["@supabase/supabase-js", "@supabase/auth-helpers"], mappings);
    assert.equal(result.size, 1);
    assert.deepEqual(result.get("Supabase"), ["@supabase/supabase-js", "@supabase/auth-helpers"]);
  });

  it("groups multiple packages under same vendor", () => {
    const result = matchDependenciesToVendors(["supabase", "@supabase/supabase-js"], mappings);
    // supabase matches exact, @supabase/supabase-js matches scope — but both go to Supabase
    // Actually, "supabase" matches "@supabase/*" first since scope check happens first
    // Let's check what happens
    assert.equal(result.size, 1);
    assert.ok(result.has("Supabase"));
  });

  it("ignores unrecognized packages", () => {
    const result = matchDependenciesToVendors(["express", "lodash", "react"], mappings);
    assert.equal(result.size, 0);
  });

  it("handles empty dependency list", () => {
    const result = matchDependenciesToVendors([], mappings);
    assert.equal(result.size, 0);
  });
});

// --- slugify ---

describe("slugify", () => {
  it("converts vendor names to URL slugs", () => {
    assert.equal(slugify("Supabase"), "supabase");
    assert.equal(slugify("Cloudflare Workers"), "cloudflare-workers");
    assert.equal(slugify("Fly.io"), "fly-io");
    assert.equal(slugify("MongoDB Atlas"), "mongodb-atlas");
  });
});

// --- stabilityLevel / meetsThreshold ---

describe("stabilityLevel", () => {
  it("orders stability correctly", () => {
    assert.ok(stabilityLevel("stable") < stabilityLevel("watch"));
    assert.ok(stabilityLevel("watch") < stabilityLevel("volatile"));
    assert.ok(stabilityLevel("improving") < stabilityLevel("watch"));
  });
});

describe("meetsThreshold", () => {
  it("watch threshold catches watch and volatile", () => {
    assert.equal(meetsThreshold("watch", "watch"), true);
    assert.equal(meetsThreshold("volatile", "watch"), true);
    assert.equal(meetsThreshold("stable", "watch"), false);
    assert.equal(meetsThreshold("improving", "watch"), false);
  });

  it("volatile threshold only catches volatile", () => {
    assert.equal(meetsThreshold("volatile", "volatile"), true);
    assert.equal(meetsThreshold("watch", "volatile"), false);
    assert.equal(meetsThreshold("stable", "volatile"), false);
  });
});

// --- formatSummaryTable ---

describe("formatSummaryTable", () => {
  it("generates markdown table with vendor data", () => {
    const vendorDataMap = new Map([
      ["Supabase", { vendor: "Supabase", description: "500 MB Postgres, 50K MAU", stability: "watch", recent_change: "Project pause policy tightened" }],
      ["Cloudflare Workers", { vendor: "Cloudflare Workers", description: "100K requests/day", stability: "stable", recent_change: null }],
    ]);
    const vendorPackagesMap = new Map([
      ["Supabase", ["@supabase/supabase-js"]],
      ["Cloudflare Workers", ["wrangler"]],
    ]);

    const { markdown, alertVendors } = formatSummaryTable(vendorDataMap, vendorPackagesMap);
    assert.ok(markdown.includes("Free Tier Monitor Report"));
    assert.ok(markdown.includes("Supabase"));
    assert.ok(markdown.includes("Cloudflare Workers"));
    assert.ok(markdown.includes("Watch"));
    assert.ok(markdown.includes("Stable"));
    assert.ok(markdown.includes("agentdeals.dev"));
    assert.equal(alertVendors.length, 1);
    assert.equal(alertVendors[0].vendor, "Supabase");
  });

  it("handles null vendor data gracefully", () => {
    const vendorDataMap = new Map([["Unknown", null]]);
    const vendorPackagesMap = new Map([["Unknown", ["unknown-pkg"]]]);
    const { markdown } = formatSummaryTable(vendorDataMap, vendorPackagesMap);
    assert.ok(markdown.includes("Not found"));
  });

  it("truncates long descriptions", () => {
    const vendorDataMap = new Map([
      ["Test", { vendor: "Test", description: "A".repeat(100), stability: "stable" }],
    ]);
    const { markdown } = formatSummaryTable(vendorDataMap, new Map([["Test", ["test"]]]));
    assert.ok(markdown.includes("..."));
  });
});

// --- formatPRComment ---

describe("formatPRComment", () => {
  it("returns null when no vendors meet threshold", () => {
    const vendorDataMap = new Map([
      ["Stripe", { vendor: "Stripe", description: "2.9% + 30c", stability: "stable" }],
    ]);
    const vendorPackagesMap = new Map([["Stripe", ["stripe"]]]);
    const result = formatPRComment(vendorDataMap, vendorPackagesMap, "watch");
    assert.equal(result, null);
  });

  it("generates alert comment for watch/volatile vendors", () => {
    const vendorDataMap = new Map([
      ["Supabase", { vendor: "Supabase", description: "500 MB", stability: "watch", recent_change: "Policy change" }],
      ["Stripe", { vendor: "Stripe", description: "2.9%", stability: "stable" }],
    ]);
    const vendorPackagesMap = new Map([
      ["Supabase", ["@supabase/supabase-js"]],
      ["Stripe", ["stripe"]],
    ]);
    const result = formatPRComment(vendorDataMap, vendorPackagesMap, "watch");
    assert.ok(result !== null);
    assert.ok(result.includes("Supabase"));
    assert.ok(!result.includes("Stripe")); // Stable, below threshold
    assert.ok(result.includes("Alert"));
  });

  it("skips null vendor data", () => {
    const vendorDataMap = new Map([["Unknown", null]]);
    const vendorPackagesMap = new Map([["Unknown", ["pkg"]]]);
    const result = formatPRComment(vendorDataMap, vendorPackagesMap, "watch");
    assert.equal(result, null);
  });
});

// --- Integration: full vendor map matching ---

describe("vendor map integration", () => {
  it("matches real-world dependencies to vendors", () => {
    const mappings = loadVendorMap();
    const deps = [
      "@supabase/supabase-js",
      "stripe",
      "@sentry/node",
      "openai",
      "@anthropic-ai/sdk",
      "next",
      "resend",
      "inngest",
      "@upstash/redis",
      "posthog-node",
      "express", // not mapped
      "react",   // not mapped
    ];
    const result = matchDependenciesToVendors(deps, mappings);
    assert.ok(result.has("Supabase"));
    assert.ok(result.has("Stripe"));
    assert.ok(result.has("Sentry"));
    assert.ok(result.has("OpenAI"));
    assert.ok(result.has("Anthropic API"));
    assert.ok(result.has("Vercel"));
    assert.ok(result.has("Resend"));
    assert.ok(result.has("Inngest"));
    assert.ok(result.has("Upstash"));
    assert.ok(result.has("PostHog"));
    assert.ok(!result.has("express"));
    assert.ok(!result.has("react"));
    assert.equal(result.size, 10);
  });
});

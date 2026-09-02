import { describe, it } from "node:test";
import assert from "node:assert";

const { findVendor, loadOffers, checkVendorRisk, auditStack, compareServices } = await import(
  "../dist/data.js"
);
const { toSlug, isSubSlug } = await import("../dist/slug.js");
const vendorSlug = await import("../dist/vendor-slug.js");

const offers = loadOffers();

const WORDS_THAT_NAME_NO_VENDOR = [
  "hosting",
  "models",
  "memory",
  "projects",
  "testing",
  "community",
  "redis",
  "postgresql",
  "credit",
  "https",
  "support",
  "website",
  "repository",
  "mandatory",
];

const NAMES_QUALIFIED_BY_EXTRA_WORDS: Array<[string, string]> = [
  ["AWS Lambda Free", "AWS"],
  ["Vercel Pro plan", "Vercel"],
  ["Neon free tier", "Neon"],
  ["Supabase database", "Supabase"],
  ["github-hosted", "GitHub"],
  ["openai-compatible", "OpenAI"],
  ["launchdarkly.com", "LaunchDarkly"],
  ["postman-alternative", "Postman"],
  ["gitbook.io", "GitBook"],
];

function vocabularyFromDescriptions(): string[] {
  const words = new Set<string>();
  for (const o of offers) {
    for (const word of String(o.description || "").toLowerCase().match(/[a-z0-9][a-z0-9+.#-]*/g) || []) {
      if (word.length >= 5) words.add(word);
    }
  }
  return [...words];
}

describe("vendor matching: one boundary rule, shared with the slug path", () => {
  it("uses the same isSubSlug the slug resolver uses, not a copy", () => {
    assert.strictEqual(vendorSlug.isSubSlug, isSubSlug);
    assert.strictEqual(vendorSlug.toSlug, toSlug);
  });

  it("never matches a vendor name that falls inside a longer word", () => {
    assert.strictEqual(isSubSlug("ory", "memory"), false);
    assert.strictEqual(isSubSlug("ory", "mandatory"), false);
    assert.strictEqual(isSubSlug("redis", "rediscover"), false);
    assert.strictEqual(isSubSlug("neon", "neondescript"), false);
  });

  it("still matches a vendor name that is a whole hyphenated word", () => {
    assert.strictEqual(isSubSlug("front", "front-end"), true);
    assert.strictEqual(isSubSlug("aws", "aws-lambda-free"), true);
  });
});

describe("findVendor", () => {
  it("returns an exact match as exact", () => {
    const match = findVendor(offers, "Vercel");
    assert.strictEqual(match.type, "exact");
    assert.strictEqual(match.offer.vendor, "Vercel");
  });

  it("matches case-insensitively without leaving the exact branch", () => {
    const match = findVendor(offers, "vErCeL");
    assert.strictEqual(match.type, "exact");
    assert.strictEqual(match.offer.vendor, "Vercel");
  });

  it("resolves a vendor name carrying extra words, and marks it inferred", () => {
    for (const [query, vendor] of NAMES_QUALIFIED_BY_EXTRA_WORDS) {
      const match = findVendor(offers, query);
      assert.strictEqual(match.type, "inferred", query);
      assert.strictEqual(match.offer.vendor, vendor, query);
    }
  });

  it("returns not-found for a word that only appears inside a longer vendor name", () => {
    for (const word of WORDS_THAT_NAME_NO_VENDOR) {
      const match = findVendor(offers, word);
      assert.strictEqual(match.type, "none", `${word} should not resolve to a vendor`);
    }
  });

  it("offers the longer vendor names as suggestions instead of answering as one of them", () => {
    assert.deepStrictEqual(findVendor(offers, "hosting").suggestions, ["Hosting Checker"]);
    assert.deepStrictEqual(findVendor(offers, "models").suggestions, ["GitHub Models"]);
    assert.deepStrictEqual(findVendor(offers, "redis").suggestions, ["Redis Cloud"]);
  });

  it("returns not-found when a query names more than one vendor", () => {
    const match = findVendor(offers, "GitHub Actions minutes");
    assert.strictEqual(match.type, "none");
    assert.deepStrictEqual(match.suggestions, ["GitHub Actions", "GitHub"]);
  });

  it("suggests each vendor once even where several records share the name", () => {
    for (const query of ["hosting", "models", "GitHub Actions minutes", "Cloudflare R2 storage"]) {
      const match = findVendor(offers, query);
      if (match.type !== "none") continue;
      assert.deepStrictEqual(
        match.suggestions,
        [...new Set(match.suggestions)],
        `${query} repeats a suggestion`,
      );
    }
  });

  it("returns not-found for input that slugs to nothing", () => {
    for (const query of ["", "   ", "!!!", "稀宇科技"]) {
      assert.strictEqual(findVendor(offers, query).type, "none");
    }
  });

  it("resolves every word it does resolve by naming that vendor in full", () => {
    for (const word of vocabularyFromDescriptions()) {
      const match = findVendor(offers, word);
      if (match.type !== "inferred") continue;
      assert.ok(
        isSubSlug(toSlug(match.offer.vendor), toSlug(word)),
        `${word} resolved to ${match.offer.vendor} without naming it at a boundary`,
      );
    }
  });

  it("leaves far fewer description words resolving to a vendor they do not name", () => {
    const misresolved = vocabularyFromDescriptions().filter((word) => {
      const match = findVendor(offers, word);
      return match.type === "inferred" && match.offer.vendor.toLowerCase() !== word;
    });
    assert.ok(
      misresolved.length < 150,
      `${misresolved.length} words still resolve to a vendor they do not name`,
    );
  });
});

describe("checkVendorRisk names the record it answered about", () => {
  it("reports an exact match as exact", () => {
    const result = checkVendorRisk("Vercel");
    assert.ok(!("error" in result));
    assert.deepStrictEqual(result.result.vendor_match, {
      requested: "Vercel",
      matched: "Vercel",
      type: "exact",
    });
  });

  it("reports an inferred match, and says so in the summary", () => {
    const result = checkVendorRisk("AWS Lambda Free");
    assert.ok(!("error" in result));
    assert.deepStrictEqual(result.result.vendor_match, {
      requested: "AWS Lambda Free",
      matched: "AWS",
      type: "inferred",
    });
    assert.ok(
      result.result.summary.includes("AWS Lambda Free") && result.result.summary.includes("AWS"),
      "summary does not name both the requested and the matched name",
    );
  });

  it("answers a word that names no vendor with an error, not a vendor", () => {
    for (const word of WORDS_THAT_NAME_NO_VENDOR) {
      const result = checkVendorRisk(word);
      assert.ok("error" in result, `${word} returned a vendor`);
    }
  });
});

describe("auditStack analyses only the services it was actually given", () => {
  it("reports a name it could not match exactly as not_found with suggestions", () => {
    const result = auditStack(["hosting", "memory", "models", "redis"]);
    assert.strictEqual(result.risks_found, 0);
    assert.strictEqual(result.savings_opportunities, 0);
    for (const svc of result.services) {
      assert.strictEqual(svc.status, "not_found", svc.vendor);
      assert.strictEqual(svc.cheaper_alternative, undefined, svc.vendor);
      assert.strictEqual(svc.risk_level, undefined, svc.vendor);
    }
    assert.deepStrictEqual(
      result.services.map((s) => s.vendor),
      ["hosting", "memory", "models", "redis"],
    );
  });

  it("keeps the requested name on the row rather than substituting one", () => {
    const result = auditStack(["hosting"]);
    assert.strictEqual(result.services[0].vendor, "hosting");
    assert.deepStrictEqual(result.services[0].suggestions, ["Hosting Checker"]);
  });

  it("does not count an inferred match as a service it audited", () => {
    const result = auditStack(["AWS Lambda Free"]);
    assert.strictEqual(result.services[0].status, "not_found");
    assert.deepStrictEqual(result.services[0].suggestions, ["AWS"]);
    assert.strictEqual(result.risks_found, 0);
  });

  it("still audits a stack of exactly named vendors", () => {
    const result = auditStack(["Vercel", "Supabase"]);
    for (const svc of result.services) {
      assert.strictEqual(svc.status, "found");
      assert.ok(svc.category);
      assert.ok(svc.risk_level);
    }
  });

  it("does not treat a category as covered by a service it could not match", () => {
    const unmatched = auditStack(["hosting", "memory", "models", "redis"]);
    const nothing = auditStack([]);
    assert.deepStrictEqual(
      unmatched.gaps.map((g) => g.category),
      nothing.gaps.map((g) => g.category),
    );
  });
});

describe("compareServices", () => {
  it("refuses to compare a word that names no vendor", () => {
    const result = compareServices("hosting", "netlify");
    assert.ok("error" in result);
    assert.deepStrictEqual(result.suggestions_a, ["Hosting Checker"]);
  });

  it("names the records it compared, on both sides", () => {
    const result = compareServices("Supabase database", "Neon");
    assert.ok(!("error" in result));
    assert.deepStrictEqual(result.comparison.vendor_a_match, {
      requested: "Supabase database",
      matched: "Supabase",
      type: "inferred",
    });
    assert.deepStrictEqual(result.comparison.vendor_b_match, {
      requested: "Neon",
      matched: "Neon",
      type: "exact",
    });
  });

  it("still compares two exactly named vendors", () => {
    const result = compareServices("Supabase", "Neon");
    assert.ok(!("error" in result));
    assert.strictEqual(result.comparison.vendor_a.vendor, "Supabase");
    assert.strictEqual(result.comparison.vendor_b.vendor, "Neon");
  });
});

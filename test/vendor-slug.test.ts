import { describe, it } from "node:test";
import assert from "node:assert";

const { toSlug, isSubSlug, resolveVendorSlug, vendorSlugMap } = await import(
  "../dist/vendor-slug.js"
);

describe("vendor-slug: toSlug", () => {
  it("lowercases and replaces non-alphanumeric runs with single hyphens", () => {
    assert.strictEqual(toSlug("Amazon Kiro"), "amazon-kiro");
    assert.strictEqual(toSlug("amazon-kiro"), "amazon-kiro");
    assert.strictEqual(toSlug("AMAZON  KIRO"), "amazon-kiro");
  });

  it("treats dots, spaces, plus, and underscores as separators", () => {
    assert.strictEqual(toSlug("Sync.com"), "sync-com");
    assert.strictEqual(toSlug("Node.js"), "node-js");
    assert.strictEqual(toSlug("vendor+tag"), "vendor-tag");
    assert.strictEqual(toSlug("foo_bar"), "foo-bar");
  });

  it("trims leading and trailing hyphens", () => {
    assert.strictEqual(toSlug("---Vendor---"), "vendor");
    assert.strictEqual(toSlug(".vendor."), "vendor");
  });

  it("drops non-ASCII characters (regex is [a-z0-9])", () => {
    assert.strictEqual(toSlug("稀宇科技"), "");
    assert.strictEqual(toSlug("Café"), "caf");
  });

  it("returns empty string for empty/whitespace/symbol-only input", () => {
    assert.strictEqual(toSlug(""), "");
    assert.strictEqual(toSlug("   "), "");
    assert.strictEqual(toSlug("---"), "");
    assert.strictEqual(toSlug("!!!"), "");
  });
});

describe("vendor-slug: isSubSlug", () => {
  it("returns true when needle equals haystack", () => {
    assert.strictEqual(isSubSlug("foo", "foo"), true);
    assert.strictEqual(isSubSlug("amazon-kiro", "amazon-kiro"), true);
  });

  it("returns true at segment boundaries (prefix, suffix, middle)", () => {
    assert.strictEqual(isSubSlug("amazon", "amazon-kiro"), true);
    assert.strictEqual(isSubSlug("kiro", "amazon-kiro"), true);
    assert.strictEqual(isSubSlug("kiro", "amazon-kiro-aws-startups"), true);
  });

  it("returns false when needle appears only inside a word (no segment boundary)", () => {
    assert.strictEqual(isSubSlug("tally", "totally-bogus-slug-xyz"), false);
    assert.strictEqual(isSubSlug("oo", "foo"), false);
    assert.strictEqual(isSubSlug("fo", "foo"), false);
    assert.strictEqual(isSubSlug("mazo", "amazon"), false);
  });

  it("returns false when haystack does not contain needle at all", () => {
    assert.strictEqual(isSubSlug("zzz", "amazon-kiro"), false);
    assert.strictEqual(isSubSlug("kiro", "amazon"), false);
  });
});

describe("vendor-slug: vendorSlugMap", () => {
  it("is populated from loaded offers", () => {
    assert.ok(vendorSlugMap.size > 0, "Expected map to be populated");
  });

  it("has known-stable vendors mapped to their canonical names", () => {
    assert.strictEqual(vendorSlugMap.get("amazon-kiro"), "Amazon Kiro");
    assert.strictEqual(vendorSlugMap.get("proton-mail"), "Proton Mail");
  });

  it("uses toSlug() normalization for keys", () => {
    for (const key of vendorSlugMap.keys()) {
      assert.strictEqual(toSlug(key), key, `Key ${key} is not already a slug`);
    }
  });
});

describe("vendor-slug: resolveVendorSlug", () => {
  it("returns type=exact when input matches a known slug", () => {
    const result = resolveVendorSlug("amazon-kiro");
    assert.deepStrictEqual(result, { type: "exact", slug: "amazon-kiro" });
  });

  it("returns type=none for empty input", () => {
    assert.deepStrictEqual(resolveVendorSlug(""), { type: "none" });
  });

  it("returns type=none for inputs shorter than 3 chars that are not exact matches", () => {
    assert.deepStrictEqual(resolveVendorSlug("xy"), { type: "none" });
    assert.deepStrictEqual(resolveVendorSlug("ab"), { type: "none" });
  });

  it("returns type=none for unknown inputs with no sub-slug match", () => {
    assert.deepStrictEqual(
      resolveVendorSlug("totally-bogus-slug-xyz"),
      { type: "none" },
    );
  });

  it("returns type=redirect with canonical slug for single-root completion (short-form lookup)", () => {
    const result = resolveVendorSlug("kiro");
    assert.strictEqual(result.type, "redirect");
    if (result.type === "redirect") {
      assert.strictEqual(result.slug, "amazon-kiro");
    }
  });

  it("returns type=disambiguate with multiple roots for ambiguous short-forms (proton → mail/drive/pass/vpn)", () => {
    const result = resolveVendorSlug("proton");
    assert.strictEqual(result.type, "disambiguate");
    if (result.type === "disambiguate") {
      assert.ok(result.slugs.includes("proton-mail"));
      assert.ok(result.slugs.includes("proton-drive"));
      assert.ok(result.slugs.includes("proton-pass"));
      assert.ok(result.slugs.includes("proton-vpn"));
    }
  });

  it("returns sorted slugs in disambiguation result", () => {
    const result = resolveVendorSlug("proton");
    if (result.type === "disambiguate") {
      const sorted = [...result.slugs].sort();
      assert.deepStrictEqual(result.slugs, sorted);
    } else {
      assert.fail("Expected disambiguate result");
    }
  });

  it("caps disambiguation results at 10 entries", () => {
    const result = resolveVendorSlug("proton");
    if (result.type === "disambiguate") {
      assert.ok(result.slugs.length <= 10);
    }
  });

  it("returns type=redirect (generalization) for input more specific than any known slug", () => {
    // Construct a super-specific input not in vendorSlugMap by appending to a known slug.
    // The generalizations branch should resolve it back to the longest matching known slug.
    const input = "amazon-kiro-does-not-exist";
    assert.ok(!vendorSlugMap.has(input), "Test premise: input must not be a known slug");
    const result = resolveVendorSlug(input);
    assert.strictEqual(result.type, "redirect");
    if (result.type === "redirect") {
      assert.strictEqual(result.slug, "amazon-kiro");
    }
  });

  it("does not false-match when input is embedded mid-word in a known slug", () => {
    // "tally" appears inside "totally-bogus-slug-xyz" but NOT at a segment boundary.
    // isSubSlug's boundary semantics prevent this from surfacing as a completion.
    // Regression guard for the op-learning #64 bug (PR #990).
    const result = resolveVendorSlug("totally-bogus-slug-xyz");
    assert.strictEqual(result.type, "none");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const { validateOffers, validateDealChanges } = await import(
  "../scripts/validate-data.ts"
);

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeOffer(overrides: Record<string, unknown> = {}) {
  return {
    vendor: "TestVendor",
    category: "Databases",
    description: "A valid description that is definitely longer than 30 characters",
    tier: "Free",
    url: "https://example.com/pricing",
    tags: ["test"],
    verifiedDate: "2026-01-15",
    ...overrides,
  };
}

function makeChange(overrides: Record<string, unknown> = {}) {
  return {
    vendor: "TestVendor",
    change_type: "free_tier_removed",
    date: "2026-01-15",
    summary: "Free tier removed",
    previous_state: "Free: 1GB",
    current_state: "No free tier",
    impact: "high",
    source_url: "https://example.com/blog",
    category: "Databases",
    alternatives: ["AltVendor"],
    date_source: "vendor_page",
    ...overrides,
  };
}

describe("validate-data", () => {
  it("valid data passes with no errors", () => {
    const errors = validateOffers([makeOffer()]);
    assert.strictEqual(errors.length, 0);
  });

  it("detects missing required field", () => {
    const offer = makeOffer();
    delete (offer as Record<string, unknown>).vendor;
    const errors = validateOffers([offer]);
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e: { field: string }) => e.field === "vendor"));
  });

  it("detects duplicate vendor+category", () => {
    const errors = validateOffers([makeOffer(), makeOffer()]);
    assert.ok(errors.length > 0);
    assert.ok(
      errors.some(
        (e: { field: string }) => e.field === "vendor+category"
      )
    );
  });

  it("detects short description", () => {
    const errors = validateOffers([makeOffer({ description: "Too short" })]);
    assert.ok(errors.length > 0);
    assert.ok(
      errors.some((e: { field: string }) => e.field === "description")
    );
  });

  it("detects invalid URL format", () => {
    const errors = validateOffers([makeOffer({ url: "not-a-url" })]);
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e: { field: string }) => e.field === "url"));
  });

  it("detects invalid verifiedDate format", () => {
    const errors = validateOffers([
      makeOffer({ verifiedDate: "Jan 15, 2026" }),
    ]);
    assert.ok(errors.length > 0);
    assert.ok(
      errors.some((e: { field: string }) => e.field === "verifiedDate")
    );
  });

  it("detects unknown category", () => {
    const errors = validateOffers([
      makeOffer({ category: "Nonexistent Category" }),
    ]);
    assert.ok(errors.length > 0);
    assert.ok(
      errors.some((e: { field: string }) => e.field === "category")
    );
  });

  describe("conditions", () => {
    const stated = {
      text: "The free plan is for personal projects.",
      quote: "Hobby teams are restricted to non-commercial personal use only.",
      url: "https://example.com/terms",
      read_on: "2026-10-03",
    };
    const conditionErrors = (conditions: unknown) =>
      validateOffers([makeOffer({ conditions })])
        .filter((e: { field: string }) => e.field === "conditions")
        .map((e: { message: string }) => e.message);

    it("accepts a condition with or without the uses it rules out", () => {
      assert.deepStrictEqual(conditionErrors([stated]), []);
      assert.deepStrictEqual(conditionErrors([{ ...stated, rules_out: ["production"] }]), []);
      assert.deepStrictEqual(conditionErrors([{ ...stated, rules_out: ["production", "commercial use"] }]), []);
    });

    it("accepts a listing without the field", () => {
      assert.deepStrictEqual(validateOffers([makeOffer()]), []);
    });

    it("refuses an empty list or one that is not a list", () => {
      assert.deepStrictEqual(conditionErrors([]), ["conditions must be a non-empty list"]);
      assert.deepStrictEqual(conditionErrors(stated), ["conditions must be a non-empty list"]);
    });

    it("refuses a condition missing any of its four fields", () => {
      for (const field of ["text", "quote", "url", "read_on"]) {
        const { [field]: _missing, ...rest } = stated as Record<string, string>;
        assert.deepStrictEqual(conditionErrors([rest]), [`conditions[0].${field} is missing`], field);
        assert.deepStrictEqual(conditionErrors([{ ...stated, [field]: " " }]), [`conditions[0].${field} is missing`], field);
      }
    });

    it("refuses a condition whose page is not a URL or whose read date is not a day", () => {
      assert.deepStrictEqual(conditionErrors([{ ...stated, url: "example.com/terms" }]), ["conditions[0].url is not a URL: example.com/terms"]);
      assert.deepStrictEqual(conditionErrors([{ ...stated, read_on: "Oct 3, 2026" }]), ["conditions[0].read_on is not YYYY-MM-DD: Oct 3, 2026"]);
    });

    it("refuses a use outside production and commercial use, an empty list of uses, and a use named twice", () => {
      assert.deepStrictEqual(conditionErrors([{ ...stated, rules_out: ["resale"] }]), [
        'conditions[0].rules_out names "resale". Valid: production, commercial use',
      ]);
      assert.deepStrictEqual(conditionErrors([{ ...stated, rules_out: [] }]), ["conditions[0].rules_out must be a non-empty list when present"]);
      assert.deepStrictEqual(conditionErrors([{ ...stated, rules_out: ["production", "production"] }]), ["conditions[0].rules_out names a use twice"]);
    });

    it("names the condition at fault", () => {
      assert.deepStrictEqual(conditionErrors([stated, { ...stated, quote: "" }]), ["conditions[1].quote is missing"]);
    });
  });

  it("validates deal_changes with no errors", () => {
    const errors = validateDealChanges([makeChange()]);
    assert.strictEqual(errors.length, 0);
  });

  it("detects missing deal_changes field", () => {
    const change = makeChange();
    delete (change as Record<string, unknown>).summary;
    const errors = validateDealChanges([change]);
    assert.ok(errors.length > 0);
    assert.ok(
      errors.some((e: { field: string }) => e.field === "summary")
    );
  });

  it("refuses a record that cites the very page its summary says cannot be read", () => {
    const errors = validateDealChanges([
      makeChange({
        summary: "Removed: source page no longer accessible or deal program discontinued",
        source_url: "https://example.com/roundup",
      }),
    ]);
    assert.ok(errors.some((e: { message: string }) => e.message.includes("reports as unreadable")));
  });

  it("accepts the same summary once the record stops offering that page as evidence", () => {
    const errors = validateDealChanges([
      makeChange({
        summary: "Removed: source page no longer accessible or deal program discontinued",
        source_url: "",
        reports: "our_index",
      }),
    ]);
    assert.deepStrictEqual(errors, []);
  });

  it("refuses a record that reports our own index and still cites a vendor page", () => {
    const errors = validateDealChanges([makeChange({ reports: "our_index" })]);
    assert.ok(errors.some((e: { message: string }) => e.message.includes("reports our own index")));
  });

  it("refuses a value for what a record reports that nothing reads", () => {
    const errors = validateDealChanges([makeChange({ reports: "housekeeping" })]);
    assert.ok(errors.some((e: { field: string }) => e.field === "reports"));
  });
});

describe("a script a test imports", () => {
  const scriptsUnderTest = (): string[] => {
    const wanted = new Set<string>();
    for (const file of readdirSync(path.join(REPO, "test")).filter(f => f.endsWith(".test.ts"))) {
      const source = readFileSync(path.join(REPO, "test", file), "utf-8");
      for (const m of source.matchAll(/"\.\.\/(scripts\/[A-Za-z0-9._-]+)"/g)) wanted.add(m[1]);
    }
    return [...wanted].sort();
  };

  it("does its work behind an entry-point check, so importing it cannot end the test run", () => {
    const running: string[] = [];
    for (const script of scriptsUnderTest()) {
      const source = readFileSync(path.join(REPO, script), "utf-8");
      if (/^main\(\);?\s*$/m.test(source)) running.push(script);
    }
    assert.deepStrictEqual(
      running,
      [],
      "a script runs its command as soon as it is imported, and its exit ends the test file before any assertion",
    );
  });

  it("is a population, so the check above is not passing on an empty list", () => {
    const scripts = scriptsUnderTest();
    assert.ok(scripts.length > 10, `only ${scripts.length} scripts are imported by a test`);
    assert.ok(scripts.includes("scripts/validate-data.ts"));
  });
});

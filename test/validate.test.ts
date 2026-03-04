import { describe, it } from "node:test";
import assert from "node:assert";
const { validateOffers, validateDealChanges } = await import(
  "../scripts/validate-data.ts"
);

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
});

import { describe, it } from "node:test";
import assert from "node:assert";

describe("guides module", () => {
  describe("getGuideList", () => {
    it("returns non-empty array of guides", async () => {
      const { getGuideList } = await import("../dist/guides.js");
      const guides = getGuideList();
      assert.ok(guides.length > 50);
    });

    it("each guide has required fields", async () => {
      const { getGuideList } = await import("../dist/guides.js");
      const guides = getGuideList();
      for (const guide of guides) {
        assert.ok(guide.slug, "slug required");
        assert.ok(guide.title, "title required");
        assert.ok(guide.description, "description required");
        assert.ok(["pricing", "comparison", "stack", "alternatives", "report", "integration"].includes(guide.type),
          "type must be valid: " + guide.type);
      }
    });

    it("has no duplicate slugs", async () => {
      const { getGuideList } = await import("../dist/guides.js");
      const guides = getGuideList();
      const slugs = guides.map(g => g.slug);
      const unique = new Set(slugs);
      assert.strictEqual(unique.size, slugs.length, "duplicate slugs found");
    });

    it("classifies comparison guides correctly", async () => {
      const { getGuideList } = await import("../dist/guides.js");
      const guides = getGuideList();
      const vsGuides = guides.filter(g => g.slug.includes("-vs-"));
      for (const g of vsGuides) {
        assert.strictEqual(g.type, "comparison", g.slug + " should be comparison type");
      }
    });

    it("classifies stack guides correctly", async () => {
      const { getGuideList } = await import("../dist/guides.js");
      const guides = getGuideList();
      const stackGuides = guides.filter(g => g.slug.startsWith("free-") && g.slug.endsWith("-stack"));
      assert.ok(stackGuides.length >= 5, "should have multiple stack guides");
      for (const g of stackGuides) {
        assert.strictEqual(g.type, "stack", g.slug + " should be stack type");
      }
    });

    it("classifies integration guides correctly", async () => {
      const { getGuideList } = await import("../dist/guides.js");
      const guides = getGuideList();
      const integrationGuides = guides.filter(g => g.slug.startsWith("guides/"));
      assert.ok(integrationGuides.length >= 3);
      for (const g of integrationGuides) {
        assert.strictEqual(g.type, "integration", g.slug + " should be integration type");
      }
    });

    it("classifies alternatives guides correctly", async () => {
      const { getGuideList } = await import("../dist/guides.js");
      const guides = getGuideList();
      const altGuides = guides.filter(g => g.slug.endsWith("-alternatives"));
      assert.ok(altGuides.length >= 5);
      for (const g of altGuides) {
        assert.strictEqual(g.type, "alternatives", g.slug + " should be alternatives type");
      }
    });
  });

  describe("getGuideBySlug", () => {
    it("returns guide for valid slug", async () => {
      const { getGuideBySlug } = await import("../dist/guides.js");
      const guide = getGuideBySlug("ai-free-tiers");
      assert.ok(guide);
      assert.strictEqual(guide.slug, "ai-free-tiers");
      assert.ok(guide.title.length > 0);
    });

    it("returns null for nonexistent slug", async () => {
      const { getGuideBySlug } = await import("../dist/guides.js");
      const guide = getGuideBySlug("nonexistent-guide-xyz");
      assert.strictEqual(guide, null);
    });

    it("returns correct type for integration guide", async () => {
      const { getGuideBySlug } = await import("../dist/guides.js");
      const guide = getGuideBySlug("guides/langchain");
      assert.ok(guide);
      assert.strictEqual(guide.type, "integration");
    });

    it("returns correct type for comparison guide", async () => {
      const { getGuideBySlug } = await import("../dist/guides.js");
      const guide = getGuideBySlug("supabase-vs-firebase");
      assert.ok(guide);
      assert.strictEqual(guide.type, "comparison");
    });
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shutdownPageContent as renderShutdownPage } from "../dist/shutdown-page.js";

const entry = { service: "Chroma Cloud", vendorSlug: "chroma", what: "Writes stop & reads end.", deadline: "2026-12-22", dateSource: "https://example.com/source?a=1&b=2", stages: [{ date: "2026-12-22", label: "stops serving reads" }, { date: "2026-12-07", label: "read-only" }] };

const options = { vendorPath: "/vendor/chroma", conditionsHtml: () => "" };
const shutdownPageContent = (item, today, overrides = {}) => renderShutdownPage(item, today, { ...options, ...overrides });
const stated = (sentence, sourceUrl) => ({ vendor: "Example", category: "API", date: "2026-12-22", sentence, sourceUrl, statedIn: "description" });

describe("shutdown page content", () => {
  for (const state of ["cancelled", "retracted"] as const) {
    it(`shows the ${state} correction instead of the original stages`, () => {
      const page = shutdownPageContent({ ...entry, what: "It shuts down on December 22.", resolution: { state, date: "2026-11-13", detail: "Correction & detail.", source_url: "https://example.com/correction" } }, "2026-11-20");
      assert.match(page.title, state === "cancelled" ? /shutdown called off/ : /record retracted/);
      assert.match(page.body, /November 13, 2026/);
      assert.match(page.body, /Correction &amp; detail/);
      assert.match(page.body, /https:\/\/example.com\/correction/);
      assert.doesNotMatch(page.body, /shuts down on|December 7|December 22|Upcoming|Completed/);
    });
  }
  it("includes each ordered stage and preserves the record and source safely", () => {
    const page = shutdownPageContent(entry, "2026-11-20");
    assert.equal(page.title, "Chroma Cloud: read-only on December 7, 2026, stops serving reads on December 22, 2026");
    assert.match(page.body, /Writes stop &amp; reads end/);
    assert.match(page.body, /href="https:\/\/example.com\/source\?a=1&amp;b=2"/);
    assert.match(page.body, /href="\/vendor\/chroma"/);
    assert.match(page.body, /href="\/shutdowns"/);
  });
  it("stays identical before the first date and marks completion after the last", () => {
    assert.deepEqual(shutdownPageContent(entry, "2026-11-20"), shutdownPageContent(entry, "2026-12-06"));
    assert.doesNotMatch(shutdownPageContent(entry, "2026-12-07").body, /read-only: December 7, 2026 — Completed/);
    assert.match(shutdownPageContent(entry, "2026-12-08").body, /read-only: December 7, 2026 — Completed/);
    assert.doesNotMatch(shutdownPageContent(entry, "2026-12-08").body, /stops serving reads: December 22, 2026 — Completed/);
    assert.match(shutdownPageContent(entry, "2026-12-22").body, /Upcoming/);
    assert.match(shutdownPageContent(entry, "2026-12-23").body, /Completed/);
  });
  it("does not invent a day for month-only dates or expose unsafe markup", () => {
    const page = shutdownPageContent({ service: "<Service>", vendorSlug: "vendor", what: "<script>", deadline: "2027-03", dateSource: "javascript:alert(1)" }, "2027-03-31");
    assert.equal(page.title, "<Service>: March 2027");
    assert.match(page.body, /&lt;Service&gt;/);
    assert.match(page.body, /&lt;script&gt;/);
    assert.doesNotMatch(page.body, /javascript:/);
    assert.match(page.body, /Upcoming/);
    assert.match(shutdownPageContent({ service: "A", vendorSlug: "a", what: "B", deadline: "2027-03" }, "2027-04-01").body, /Completed/);
  });
  it("carries card details and each grouped source", () => {
    const page = shutdownPageContent({ ...entry, whoAffected: "Users & teams", impact: "Calls stop", migrationPath: "Use <GA>", migrationLink: "/migration", groupedDeadlines: [stated("First model ends", "https://example.com/first?a=1&b=2"), stated("Second model ends", "https://example.com/second")] }, "2026-11-20");
    for (const text of ["Users &amp; teams", "Calls stop", "Use &lt;GA&gt;", "First model ends", "Second model ends", "/migration", "https://example.com/first?a=1&amp;b=2", "https://example.com/second"]) assert.ok(page.body.includes(text));
  });
  it("rejects unsafe grouped source and migration links", () => {
    const page = shutdownPageContent({ ...entry, migrationLink: "//evil.example", groupedDeadlines: [stated("Model ends", "javascript:alert(1)")] }, "2026-11-20");
    assert.doesNotMatch(page.body, /evil\.example|javascript:/);
  });
  it("places listing conditions beside each corresponding description", () => {
    const first = stated("First model ends", "https://example.com/first");
    const second = stated("Second model ends", "https://example.com/second");
    const conditionsHtml = item => `<strong>Conditions for ${item.sentence}</strong>`;
    const ordinary = shutdownPageContent({ ...entry, statedDeadline: first }, "2026-11-20", { conditionsHtml });
    assert.match(ordinary.body, /Writes stop &amp; reads end\.<\/p><strong>Conditions for First model ends<\/strong>/);
    const grouped = shutdownPageContent({ ...entry, groupedDeadlines: [first, second] }, "2026-11-20", { conditionsHtml });
    assert.match(grouped.body, /First model ends.*Conditions for First model ends<\/strong><\/li>/);
    assert.match(grouped.body, /Second model ends.*Conditions for Second model ends<\/strong><\/li>/);
  });
  it("omits the vendor link when no vendor page is served", () => {
    const page = shutdownPageContent(entry, "2026-11-20", { vendorPath: null });
    assert.doesNotMatch(page.body, /href="\/vendor\//);
    assert.match(page.body, /href="\/shutdowns"/);
  });

});

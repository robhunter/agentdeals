import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shutdownPageContent } from "../dist/shutdown-page.js";

const entry = { service: "Chroma Cloud", vendorSlug: "chroma", what: "Writes stop & reads end.", deadline: "2026-12-22", dateSource: "https://example.com/source?a=1&b=2", stages: [{ date: "2026-12-22", label: "stops serving reads" }, { date: "2026-12-07", label: "read-only" }] };

describe("shutdown page content", () => {
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
});

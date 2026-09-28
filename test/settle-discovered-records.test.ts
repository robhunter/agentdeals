import { describe, it } from "node:test";
import assert from "node:assert";

const { firstReadingsInForce, splitOf, listingFor, settleFirstReadings, SPLIT } = await import("../scripts/settle-discovered-records.js");

type Change = Record<string, unknown>;

function change(fields: Change): Change {
  return { change_type: "limits_reduced", impact: "medium", category: "Databases", source_url: "https://example.com/pricing", recorded_date: fields.date, ...fields };
}

describe("the first readings the archive check settles", () => {
  it("takes discovered records in force whose before is our catalogue text, not an earlier reading of ours", () => {
    const changes = [
      change({ vendor: "Alpha", date: "2026-09-01", date_source: "discovered", previous_state: "our Alpha text", current_state: "Alpha read once" }),
      change({ vendor: "Alpha", date: "2026-09-10", date_source: "discovered", previous_state: "Alpha read once", current_state: "Alpha read twice" }),
      change({ vendor: "Beta", date: "2026-09-02", date_source: "discovered", previous_state: "our Beta text", current_state: "Beta read", resolution: { state: "retracted" } }),
      change({ vendor: "Gamma", date: "2026-09-03", date_source: "hand_written", previous_state: "Gamma before", current_state: "Gamma after" }),
      change({ vendor: "Delta", date: "2026-09-12", date_source: "discovered", previous_state: "Alpha read once", current_state: "Delta read" }),
    ];
    assert.deepStrictEqual(
      firstReadingsInForce(changes).map((c: Change) => `${c.vendor} ${c.date}`),
      ["Alpha 2026-09-01", "Delta 2026-09-12"],
    );
  });

  it("counts an earlier reading even when that reading was later retracted", () => {
    const changes = [
      change({ vendor: "Alpha", date: "2026-09-01", date_source: "discovered", previous_state: "our Alpha text", current_state: "Alpha read once", resolution: { state: "retracted" } }),
      change({ vendor: "Alpha", date: "2026-09-10", date_source: "discovered", previous_state: "Alpha read once", current_state: "Alpha read twice" }),
    ];
    assert.deepStrictEqual(firstReadingsInForce(changes), []);
  });
});

describe("the split posted on the issue", () => {
  const TODAY = "2026-09-28";

  it("puts a vendor change inside or before the 180 days by the first capture with the new terms", () => {
    const moved = (first_new: string | null, last_old: string) => ({ outcome: "vendor_changed", brackets: [{ last_old, first_new }] });
    assert.strictEqual(splitOf(moved("2026-04-01", "2026-03-31"), TODAY), SPLIT.recentVendorChange);
    assert.strictEqual(splitOf(moved("2026-03-31", "2026-03-30"), TODAY), SPLIT.olderVendorChange);
    assert.strictEqual(splitOf(moved(null, "2026-09-01"), TODAY), SPLIT.recentVendorChange);
  });

  it("reads a record whose terms moved more than once by its latest move", () => {
    const settled = { outcome: "vendor_changed", brackets: [{ last_old: "2025-06-01", first_new: "2025-06-02" }, { last_old: "2026-07-01", first_new: "2026-07-02" }] };
    assert.strictEqual(splitOf(settled, TODAY), SPLIT.recentVendorChange);
  });

  it("names our own difference, a missing capture, an unknown text day and an unreadable page apart", () => {
    assert.strictEqual(splitOf({ outcome: "ours" }, TODAY), SPLIT.ours);
    assert.strictEqual(splitOf({ outcome: "no_usable_capture" }, TODAY), SPLIT.noCapture);
    assert.strictEqual(splitOf({ outcome: "text_day_unknown" }, TODAY), SPLIT.textDayUnknown);
    assert.strictEqual(splitOf({ outcome: "page_unreadable_today" }, TODAY), SPLIT.pageUnreadable);
  });
});

describe("settling the backlog", () => {
  it("reads each record's own page with the listing it names, and tallies the split", async () => {
    const changes = [
      change({ vendor: "Alpha", tier: "Hobby", date: "2026-09-01", date_source: "discovered", previous_state: "A", current_state: "B", source_url: "https://alpha.example/pricing" }),
      change({ vendor: "Beta", date: "2026-09-02", date_source: "discovered", previous_state: "A", current_state: "B", source_url: "https://beta.example/pricing" }),
      change({ vendor: "Gamma", date: "2026-09-03", date_source: "discovered", previous_state: "A", current_state: "B", source_url: "https://gamma.example/pricing" }),
    ];
    const offers = [
      { vendor: "Alpha", tier: "Free", category: "Databases" },
      { vendor: "Alpha", tier: "Hobby", category: "Databases" },
      { vendor: "Beta", tier: "Free", category: "Hosting" },
    ];
    const page = (terms: string) => `<html><body><p>TERMS=${terms}</p><p>${"Plans and limits. ".repeat(40)}</p></body></html>`;
    const termsOn: Record<string, (day: string) => string> = {
      "https://alpha.example/pricing": (day) => (day <= "2026-05-01" ? "A" : "B"),
      "https://beta.example/pricing": () => "B",
    };
    const asked: string[] = [];
    const archive = {
      captures: async (url: string) => {
        asked.push(url);
        return { captures: ["20260201120000", "20260501120000", "20260502120000", "20260901120000"].map((timestamp) => ({ timestamp, original: url, statuscode: "200", mimetype: "text/html" })) };
      },
      captureHtml: async ({ timestamp, original }: { timestamp: string; original: string }) => ({
        html: page(termsOn[original](`${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`)),
      }),
    };
    const listings: string[] = [];
    const readerForListing = (listing: { vendor: string; tier: string }) => {
      listings.push(`${listing.vendor}/${listing.tier}`);
      return async (stored: string, text: string) => {
        const found = text.match(/TERMS=(\w+)/);
        if (!found) return { status: "unclear" };
        return found[1] === stored ? { status: "confirmed" } : { status: "changed", current_state: found[1] };
      };
    };
    const report = await settleFirstReadings({
      changes,
      offers,
      today: "2026-09-28",
      archive,
      readerForListing,
      fetchToday: async (url: string) => (url.includes("gamma") ? { ok: false, error: "HTTP 403" } : { ok: true, text: "TERMS=B" }),
      textDayOf: () => "2026-02-10",
    });
    assert.deepStrictEqual(report.results.map((r: { vendor: string; outcome: string }) => `${r.vendor} ${r.outcome}`), [
      "Alpha vendor_changed",
      "Beta ours",
      "Gamma page_unreadable_today",
    ]);
    assert.deepStrictEqual(report.results[0].brackets, [{ last_old: "2026-05-01", first_new: "2026-05-02", narrowed_to_adjacent_captures: true }]);
    assert.deepStrictEqual(listings, ["Alpha/Hobby", "Beta/Free"]);
    assert.deepStrictEqual(asked, ["https://alpha.example/pricing", "https://beta.example/pricing"]);
    assert.strictEqual(report.records, 3);
    assert.strictEqual(report.split[SPLIT.recentVendorChange], 1);
    assert.strictEqual(report.split[SPLIT.ours], 1);
    assert.strictEqual(report.split[SPLIT.pageUnreadable], 1);
  });

  it("falls back to a listing named for the record when the catalogue holds none for its vendor", () => {
    assert.deepStrictEqual(listingFor({ vendor: "Gone", category: "CDN", tier: "Free" }, []), { vendor: "Gone", category: "CDN", tier: "Free" });
  });
});

describe("checking the method on records whose outcome is already known", () => {
  it("can include resolved first readings, and names the resolution each one carries", async () => {
    const changes = [
      change({ vendor: "Alpha", date: "2026-09-01", date_source: "discovered", previous_state: "A", current_state: "B", resolution: { state: "retracted" } }),
      change({ vendor: "Beta", date: "2026-09-02", date_source: "discovered", previous_state: "A", current_state: "B" }),
    ];
    assert.deepStrictEqual(firstReadingsInForce(changes).map((c: Change) => c.vendor), ["Beta"]);
    assert.deepStrictEqual(firstReadingsInForce(changes, { includeResolved: true }).map((c: Change) => c.vendor), ["Alpha", "Beta"]);
    const report = await settleFirstReadings({
      changes,
      offers: [],
      today: "2026-09-28",
      archive: { captures: async () => ({ captures: [] }), captureHtml: async () => ({ unavailable: "unused" }) },
      readerForListing: () => async () => ({ status: "unclear" }),
      fetchToday: async () => ({ ok: true, text: "TERMS=B" }),
      textDayOf: () => "2026-02-10",
      vendors: ["Alpha"],
      includeResolved: true,
    });
    assert.deepStrictEqual(report.results.map((r: { vendor: string; resolution: string | null; outcome: string }) => [r.vendor, r.resolution, r.outcome]), [["Alpha", "retracted", "no_usable_capture"]]);
  });
});

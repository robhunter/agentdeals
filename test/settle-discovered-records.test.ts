import { describe, it } from "node:test";
import assert from "node:assert";

const { firstReadingsInForce, splitOf, listingFor, settleFirstReadings, SPLIT, badgesByRecord, recordKey, inShard, parseShard, reviewList } = await import("../scripts/settle-discovered-records.js");

type Change = Record<string, unknown>;

const statesItAlready = async () => ({ status: "stated", stated_then: [{ record: "the change", old: "the line" }] });

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

describe("a backlog settled in shards", () => {
  it("gives every record to exactly one of the shards, and every shard its share", () => {
    const backlog = Array.from({ length: 23 }, (_, at) => ({ vendor: `Vendor ${at}` }));
    const shards = Array.from({ length: 8 }, (_, index) => inShard(backlog, { index, count: 8 }));
    assert.deepStrictEqual(shards.flat().map((record) => record.vendor).sort(), backlog.map((record) => record.vendor).sort());
    assert.deepStrictEqual(shards.map((shard) => shard.length), [3, 3, 3, 3, 3, 3, 3, 2]);
    assert.strictEqual(inShard(backlog, null), backlog);
  });

  it("reads a shard as k/n with k below n, and refuses anything else", () => {
    assert.deepStrictEqual(parseShard("0/8"), { index: 0, count: 8 });
    assert.deepStrictEqual(parseShard("7/8"), { index: 7, count: 8 });
    for (const refused of ["8/8", "1/0", "1", "a/8", "-1/8", "", undefined]) assert.strictEqual(parseShard(refused), null, String(refused));
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

  it("names our own difference, a missing capture, an unknown text day, an unreadable page and a failed reader apart", () => {
    assert.strictEqual(splitOf({ outcome: "ours" }, TODAY), SPLIT.ours);
    assert.strictEqual(splitOf({ outcome: "no_usable_capture" }, TODAY), SPLIT.noCapture);
    assert.strictEqual(splitOf({ outcome: "text_day_unknown" }, TODAY), SPLIT.textDayUnknown);
    assert.strictEqual(splitOf({ outcome: "page_unreadable_today" }, TODAY), SPLIT.pageUnreadable);
    assert.strictEqual(splitOf({ outcome: "reader_failed" }, TODAY), SPLIT.readerFailed);
  });

  it("gives a record that set a caution or risky badge and found no usable capture its own row", () => {
    assert.strictEqual(splitOf({ outcome: "no_usable_capture" }, TODAY, "caution"), SPLIT.noCaptureBadgeToReview);
    assert.strictEqual(splitOf({ outcome: "no_usable_capture" }, TODAY, "risky"), SPLIT.noCaptureBadgeToReview);
    assert.strictEqual(splitOf({ outcome: "no_usable_capture" }, TODAY, "stable"), SPLIT.noCapture);
    assert.strictEqual(splitOf({ outcome: "no_usable_capture" }, TODAY, null), SPLIT.noCapture);
    assert.strictEqual(splitOf({ outcome: "ours" }, TODAY, "risky"), SPLIT.ours);
    assert.strictEqual(splitOf({ outcome: "text_day_unknown" }, TODAY, "risky"), SPLIT.textDayUnknown);
    assert.strictEqual(splitOf({ outcome: "vendor_changed", brackets: [{ last_old: "2026-09-01", first_new: "2026-09-02" }] }, TODAY, "risky"), SPLIT.recentVendorChange);
  });

  it("gives a removal the older capture already states its own row, whatever badge it set", () => {
    for (const badge of ["risky", "caution", null]) assert.strictEqual(splitOf({ outcome: "removal_stated_before" }, TODAY, badge), SPLIT.removalStatedBefore);
  });
});

describe("the review list", () => {
  it("carries a removal the older capture already states, with its badge and the lines that state it, and leaves our own differences off", () => {
    const statedThen = [{ record: "Sunset is shutting down", old: "We are sunsetting the product" }];
    const review = reviewList([
      { vendor: "Sunset", date: "2026-08-28", change_type: "product_deprecated", badge: "risky", split: SPLIT.removalStatedBefore, why: "the capture 2026-02-09 already states the removal, so it predates our text: to be dated", stated_then: statedThen },
      { vendor: "Ours", date: "2026-08-28", change_type: "limits_reduced", badge: "caution", split: SPLIT.ours, stated_then: statedThen },
    ]);
    assert.deepStrictEqual(
      review.map((entry: { vendor: string; badge: string; why: string; stated_then?: unknown }) => [entry.vendor, entry.badge, entry.why, entry.stated_then]),
      [["Sunset", "risky", "the capture 2026-02-09 already states the removal, so it predates our text: to be dated", statedThen]],
    );
  });
});

describe("the badge a record sets", () => {
  const record = (date: string, summary: string) => ({ vendor: "Alpha", date, change_type: "limits_reduced", recorded_date: date, summary });

  it("is the caution or risky level a listing publishes citing that record, and the higher one where two listings cite it", () => {
    const cut = record("2026-09-01", "Alpha cut its free plan");
    const moved = record("2026-09-02", "Alpha moved a limit");
    const trimmed = record("2026-09-03", "Alpha trimmed a quota");
    const withheld = record("2026-09-04", "Alpha renamed a plan");
    const badges = badgesByRecord([
      { risk_level: "caution", cause: cut },
      { risk_level: "risky", cause: { ...cut, vendor: "Alpha, as published after a rename" } },
      { risk_level: "risky", cause: moved },
      { risk_level: "caution", cause: moved },
      { risk_level: "caution", cause: trimmed },
      { risk_level: null, cause: withheld },
      { risk_level: "stable", cause: withheld },
      { risk_level: "risky", cause: null },
    ]);
    assert.deepStrictEqual(
      [cut, moved, trimmed, withheld].map((r) => badges.get(recordKey(r)) ?? null),
      ["risky", "risky", "caution", null],
    );
    assert.strictEqual(badges.size, 3);
  });
});

type Page = { text: string };

function termsOf(page: Page) {
  return page.text.match(/TERMS=(\w+)/)?.[1];
}

function termsPairReader() {
  return async (older: Page, newer: Page) => {
    const was = termsOf(older);
    const now = termsOf(newer);
    if (!was || !now) return { status: "unquotable", side: "both", why: "no terms on the page" };
    const quoted = { old_terms: [`TERMS=${was}`], new_terms: [`TERMS=${now}`] };
    return was === now ? { status: "same", ...quoted } : { status: "differ", ...quoted, differences: [{ old: `TERMS=${was}`, new: `TERMS=${now}` }] };
  };
}

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
    const pairReaderForListing = (listing: { vendor: string; tier: string }) => {
      listings.push(`${listing.vendor}/${listing.tier}`);
      return termsPairReader();
    };
    const settledInTurn: string[] = [];
    const report = await settleFirstReadings({
      statedReaderForRecord: () => statesItAlready,
      changes,
      offers,
      today: "2026-09-28",
      archive,
      pairReaderForListing,
      fetchToday: async (url: string) => (url.includes("gamma") ? { ok: false, error: "HTTP 403" } : { ok: true, text: "TERMS=B" }),
      textDayOf: () => "2026-02-10",
      onSettled: (result: { vendor: string; split: string }) => settledInTurn.push(`${result.vendor} ${result.split}`),
    });
    assert.deepStrictEqual(settledInTurn, report.results.map((r: { vendor: string; split: string }) => `${r.vendor} ${r.split}`));
    assert.deepStrictEqual(report.results.map((r: { vendor: string; outcome: string }) => `${r.vendor} ${r.outcome}`), [
      "Alpha vendor_changed",
      "Beta ours",
      "Gamma page_unreadable_today",
    ]);
    assert.deepStrictEqual(report.results[0].brackets, [{ last_old: "2026-05-01", first_new: "2026-05-02", narrowed_to_adjacent_captures: true, relative_to_record: "before" }]);
    assert.strictEqual(report.results[0].record_day, "2026-09-01");
    assert.strictEqual(report.results[0].date, "2026-09-01");
    assert.strictEqual(report.results[0].date_from_captures, "2026-05-02");
    assert.strictEqual(report.results[1].date, "2026-09-02");
    assert.strictEqual("date_from_captures" in report.results[1], false);
    assert.deepStrictEqual(listings, ["Alpha/Hobby", "Beta/Free"]);
    assert.deepStrictEqual(asked, ["https://alpha.example/pricing", "https://beta.example/pricing"]);
    assert.strictEqual(report.records, 3);
    assert.strictEqual(report.split[SPLIT.recentVendorChange], 1);
    assert.strictEqual(report.split[SPLIT.ours], 1);
    assert.strictEqual(report.split[SPLIT.pageUnreadable], 1);
  });

  it("lists the lines left for review on a record that set a badge, counts it as no usable capture, and leaves a record that set none off the list", async () => {
    const changes = [
      change({ vendor: "Delta", date: "2026-09-01", change_type: "limits_reduced", date_source: "discovered", previous_state: "A", current_state: "B", source_url: "https://delta.example/pricing" }),
      change({ vendor: "Epsilon", date: "2026-09-02", change_type: "limits_reduced", date_source: "discovered", previous_state: "A", current_state: "B", source_url: "https://epsilon.example/pricing" }),
      change({ vendor: "Zeta", date: "2026-09-03", change_type: "limits_reduced", date_source: "discovered", previous_state: "A", current_state: "B", source_url: "https://zeta.example/pricing" }),
    ];
    const line = { old: "7-day history", new: "", why: "only the old page states it" };
    const archive = {
      captures: async (url: string) => ({ captures: ["20260201120000", "20260901120000"].map((timestamp) => ({ timestamp, original: url, statuscode: "200", mimetype: "text/html" })) }),
      captureHtml: async () => ({ html: `<html><body><p>TERMS=A</p><p>${"Plans and limits. ".repeat(40)}</p></body></html>` }),
    };
    const report = await settleFirstReadings({
      statedReaderForRecord: () => statesItAlready,
      changes,
      offers: [],
      today: "2026-09-28",
      archive,
      pairReaderForListing: (listing: { vendor: string }) => async () =>
        listing.vendor === "Epsilon"
          ? { status: "same", old_terms: ["TERMS=A"], new_terms: ["TERMS=A"] }
          : { status: "review", old_terms: ["TERMS=A"], new_terms: ["TERMS=A"], review: [line], why: "no difference is a value both pages state moving, so the lines go to review" },
      fetchToday: async () => ({ ok: true, text: "TERMS=A" }),
      textDayOf: () => "2026-02-10",
      badgeSetBy: (r: { vendor: string }) => (r.vendor === "Delta" ? "caution" : null),
    });
    assert.deepStrictEqual(report.review, [{
      vendor: "Delta",
      date: "2026-09-01",
      change_type: "limits_reduced",
      badge: "caution",
      compared_with: { page: "capture 2026-09-01", day: "2026-09-01", gap_days: 0, side: "on" },
      why: "no difference is a value both pages state moving, so the lines go to review",
      lines: [line],
    }]);
    assert.strictEqual(report.split[SPLIT.noCaptureBadgeToReview], 1);
    assert.strictEqual(report.split[SPLIT.noCapture], 1);
    assert.strictEqual(report.results.find((r: { vendor: string }) => r.vendor === "Zeta").review.length, 1);
    assert.strictEqual(report.split[SPLIT.ours], 1);
  });

  it("puts every record that set a badge and found no usable capture on the review list with its why, whatever stopped it, and no other record", async () => {
    const record = (vendor: string) =>
      change({ vendor, date: "2026-09-01", date_source: "discovered", previous_state: "A", current_state: "B", source_url: `https://${vendor.toLowerCase()}.example/pricing`, summary: `${vendor} cut its free plan` });
    const changes = ["Misquoted", "Uncaptured", "Unreadable", "Unbadged", "Settled"].map(record);
    const badges: Record<string, string | null> = { Misquoted: "risky", Uncaptured: "caution", Unreadable: "risky", Unbadged: null, Settled: "risky" };
    const fullPage = `<html><body><p>TERMS=A</p><p>${"Plans and limits. ".repeat(40)}</p></body></html>`;
    const archive = {
      captures: async (url: string) => ({
        captures: url.includes("uncaptured") ? [] : ["20260201120000", "20260901120000"].map((timestamp) => ({ timestamp, original: url, statuscode: "200", mimetype: "text/html" })),
      }),
      captureHtml: async ({ original }: { original: string }) => ({ html: original.includes("unreadable") ? "<html><body><p>Loading</p></body></html>" : fullPage }),
    };
    const report = await settleFirstReadings({
      statedReaderForRecord: () => statesItAlready,
      changes,
      offers: [],
      today: "2026-09-28",
      archive,
      pairReaderForListing: (listing: { vendor: string }) =>
        listing.vendor === "Misquoted" || listing.vendor === "Unbadged"
          ? async () => ({ status: "unquotable", side: "old", why: "not on the old page: \"2 user seats\"" })
          : termsPairReader(),
      fetchToday: async () => ({ ok: true, text: "TERMS=A" }),
      textDayOf: () => "2026-02-10",
      badgeSetBy: (r: { vendor: string }) => badges[r.vendor],
    });
    assert.deepStrictEqual(
      report.results.map((r: { vendor: string; outcome: string; badge: string | null }) => `${r.vendor} ${r.outcome} ${r.badge}`),
      ["Misquoted no_usable_capture risky", "Uncaptured no_usable_capture caution", "Unreadable no_usable_capture risky", "Unbadged no_usable_capture null", "Settled ours risky"],
    );
    assert.deepStrictEqual(
      report.review.map((entry: { vendor: string; badge: string; why: string; tried?: Array<{ why: string }>; lines: unknown[] }) => [entry.vendor, entry.badge, entry.why, (entry.tried ?? []).map((t) => t.why), entry.lines]),
      [
        ["Misquoted", "risky", "no capture settled it", ["the capture settles nothing: not on the old page: \"2 user seats\""], []],
        ["Uncaptured", "caution", "no capture on or before our text's day, nor within 60 days after it", [], []],
        ["Unreadable", "risky", "no capture settled it", ["the capture could not be read"], []],
      ],
    );
    assert.strictEqual(report.split[SPLIT.noCaptureBadgeToReview], 3);
    assert.strictEqual(report.split[SPLIT.noCapture], 1);
    assert.strictEqual(report.split[SPLIT.ours], 1);
    assert.strictEqual(Object.values(report.split).reduce((sum: number, n) => sum + (n as number), 0), report.records);
  });

  it("lists every same-answer match whose only shared words are words of the listing's tier name, with its record, and no other match", async () => {
    const record = (vendor: string, date: string) =>
      change({ vendor, tier: "Free Developer", date, date_source: "discovered", previous_state: "A", current_state: "B", source_url: `https://${vendor.toLowerCase()}.example/pricing` });
    const changes = [record("Zeta", "2026-09-01"), record("Eta", "2026-09-02")];
    const offers = [
      { vendor: "Zeta", tier: "Free Developer", category: "Databases" },
      { vendor: "Eta", tier: "Free Developer", category: "Databases" },
    ];
    const archive = {
      captures: async (url: string) => ({ captures: ["20260201120000", "20260901120000"].map((timestamp) => ({ timestamp, original: url, statuscode: "200", mimetype: "text/html" })) }),
      captureHtml: async () => ({ html: `<html><body><p>TERMS=A</p><p>${"Plans and limits. ".repeat(40)}</p></body></html>` }),
    };
    const matched: Record<string, { old: string; new: string; shared: string[] }[]> = {
      Zeta: [
        { old: "Free developer: 3 projects", new: "Free developer: 3 users", shared: ["developer", "free"] },
        { old: "1 GB of storage", new: "Storage: 1 GB", shared: ["storage"] },
      ],
      Eta: [
        { old: "Free storage: 1 GB", new: "1 GB of free storage", shared: ["free", "storage"] },
        { old: "$0/mo", new: "$0 per month", shared: [] },
      ],
    };
    const report = await settleFirstReadings({
      statedReaderForRecord: () => statesItAlready,
      changes,
      offers,
      today: "2026-09-28",
      archive,
      pairReaderForListing: (listing: { vendor: string }) => async () => ({ status: "same", old_terms: ["TERMS=A"], new_terms: ["TERMS=A"], matched: matched[listing.vendor] }),
      fetchToday: async () => ({ ok: true, text: "TERMS=A" }),
      textDayOf: () => "2026-02-10",
    });
    assert.deepStrictEqual(report.matches_sharing_only_the_tier_name, [{
      vendor: "Zeta",
      date: "2026-09-01",
      change_type: "limits_reduced",
      tier: "Free Developer",
      split: SPLIT.ours,
      matches: [{ older: "capture 2026-02-01", newer: "capture 2026-09-01", old: "Free developer: 3 projects", new: "Free developer: 3 users", shared: ["developer", "free"] }],
    }]);
    assert.strictEqual(report.results.find((r: { vendor: string }) => r.vendor === "Eta").matches_sharing_only_the_tier_name, undefined);
  });

  it("falls back to a listing named for the record when the catalogue holds none for its vendor", () => {
    assert.deepStrictEqual(listingFor({ vendor: "Gone", category: "CDN", tier: "Free" }, []), { vendor: "Gone", category: "CDN", tier: "Free" });
  });
});

describe("records the Archive did not answer", () => {
  it("are asked again once every other record has settled, and the second answer is the one reported", async () => {
    const changes = [
      change({ vendor: "Alpha", date: "2026-09-01", date_source: "discovered", previous_state: "A", current_state: "B", source_url: "https://alpha.example/pricing" }),
      change({ vendor: "Beta", date: "2026-09-02", date_source: "discovered", previous_state: "A", current_state: "B", source_url: "https://beta.example/pricing" }),
    ];
    const asked: string[] = [];
    const archive = {
      captures: async (url: string) => {
        asked.push(url);
        if (url.includes("alpha") && asked.filter((u) => u === url).length === 1) return { unavailable: "network error: fetch failed after 4 attempts" };
        return { captures: [{ timestamp: "20260205120000", original: url, statuscode: "200", mimetype: "text/html" }] };
      },
      captureHtml: async () => ({ html: `<html><body><p>TERMS=B</p><p>${"Plans and limits. ".repeat(40)}</p></body></html>` }),
    };
    const settledInTurn: string[] = [];
    const report = await settleFirstReadings({
      statedReaderForRecord: () => statesItAlready,
      changes,
      offers: [],
      today: "2026-09-28",
      archive,
      pairReaderForListing: termsPairReader,
      fetchToday: async () => ({ ok: true, text: "TERMS=B" }),
      textDayOf: () => "2026-02-10",
      onSettled: (result: { vendor: string; outcome: string }) => settledInTurn.push(`${result.vendor} ${result.outcome}`),
    });
    assert.deepStrictEqual(asked, ["https://alpha.example/pricing", "https://beta.example/pricing", "https://alpha.example/pricing"]);
    assert.deepStrictEqual(settledInTurn, ["Alpha no_usable_capture", "Beta ours", "Alpha ours"]);
    assert.deepStrictEqual(report.results.map((r: { vendor: string; outcome: string }) => `${r.vendor} ${r.outcome}`), ["Alpha ours", "Beta ours"]);
    assert.strictEqual(report.split[SPLIT.noCapture], 0);
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
      statedReaderForRecord: () => statesItAlready,
      changes,
      offers: [],
      today: "2026-09-28",
      archive: { captures: async () => ({ captures: [] }), captureHtml: async () => ({ unavailable: "unused" }) },
      pairReaderForListing: () => async () => ({ status: "unquotable", side: "both", why: "no terms on the page" }),
      fetchToday: async () => ({ ok: true, text: "TERMS=B" }),
      textDayOf: () => "2026-02-10",
      vendors: ["Alpha"],
      includeResolved: true,
    });
    assert.deepStrictEqual(report.results.map((r: { vendor: string; resolution: string | null; outcome: string }) => [r.vendor, r.resolution, r.outcome]), [["Alpha", "retracted", "no_usable_capture"]]);
  });
});

describe("the readings behind each outcome", () => {
  it("are kept in each record's result only when asked for", async () => {
    const changes = [change({ vendor: "Alpha", date: "2026-09-01", date_source: "discovered", previous_state: "A", current_state: "B" })];
    const run = (logReads: boolean) =>
      settleFirstReadings({
        statedReaderForRecord: () => statesItAlready,
        changes,
        offers: [],
        today: "2026-09-28",
        archive: {
          captures: async (url: string) => ({ captures: [{ timestamp: "20260205120000", original: url, statuscode: "200", mimetype: "text/html" }] }),
          captureHtml: async () => ({ html: `<html><body><p>TERMS=B</p><p>${"Plans and limits. ".repeat(40)}</p></body></html>` }),
        },
        pairReaderForListing: termsPairReader,
        fetchToday: async () => ({ ok: true, text: "TERMS=B" }),
        textDayOf: () => "2026-02-10",
        logReads,
      });
    const quiet = await run(false);
    assert.ok(!("readings" in quiet.results[0]));
    const logged = await run(true);
    assert.deepStrictEqual(
      logged.results[0].readings.map((r: { older: string; newer: string; verdict: { status: string } }) => `${r.older} | ${r.newer} ${r.verdict.status}`),
      ["capture 2026-02-05 | today same", "capture 2026-02-05 | the record stated"],
    );
  });
});

describe("a reader that fails on one record", () => {
  it("does not stop the others, and that record is asked again once the rest have settled", async () => {
    const changes = [
      change({ vendor: "Alpha", date: "2026-09-01", date_source: "discovered", previous_state: "A", current_state: "B", source_url: "https://alpha.example/pricing" }),
      change({ vendor: "Beta", date: "2026-09-02", date_source: "discovered", previous_state: "A", current_state: "B", source_url: "https://beta.example/pricing" }),
    ];
    let alphaCalls = 0;
    const pairReaderForListing = (listing: { vendor: string }) => async (older: Page, newer: Page) => {
      if (listing.vendor === "Alpha" && alphaCalls++ === 0) throw new Error("google/gemma-3-27b-it request failed: HTTP 504");
      return termsPairReader()(older, newer);
    };
    const settledInTurn: string[] = [];
    const report = await settleFirstReadings({
      statedReaderForRecord: () => statesItAlready,
      changes,
      offers: [{ vendor: "Alpha", tier: "Free", category: "Databases" }],
      today: "2026-09-28",
      archive: {
        captures: async (url: string) => ({ captures: [{ timestamp: "20260205120000", original: url, statuscode: "200", mimetype: "text/html" }] }),
        captureHtml: async () => ({ html: `<html><body><p>TERMS=B</p><p>${"Plans and limits. ".repeat(40)}</p></body></html>` }),
      },
      pairReaderForListing,
      fetchToday: async () => ({ ok: true, text: "TERMS=B" }),
      textDayOf: () => "2026-02-10",
      onSettled: (result: { vendor: string; outcome: string }) => settledInTurn.push(`${result.vendor} ${result.outcome}`),
    });
    assert.deepStrictEqual(settledInTurn, ["Alpha reader_failed", "Beta ours", "Alpha ours"]);
    assert.deepStrictEqual(report.results.map((r: { vendor: string; outcome: string }) => `${r.vendor} ${r.outcome}`), ["Alpha ours", "Beta ours"]);
    assert.strictEqual(report.split[SPLIT.readerFailed], 0);
  });

  it("is reported as a reader failure, with the reader's error, when the second ask fails too", async () => {
    const report = await settleFirstReadings({
      statedReaderForRecord: () => statesItAlready,
      changes: [change({ vendor: "Alpha", date: "2026-09-01", date_source: "discovered", previous_state: "A", current_state: "B" })],
      offers: [],
      today: "2026-09-28",
      archive: {
        captures: async (url: string) => ({ captures: [{ timestamp: "20260205120000", original: url, statuscode: "200", mimetype: "text/html" }] }),
        captureHtml: async () => ({ html: `<html><body><p>TERMS=B</p><p>${"Plans and limits. ".repeat(40)}</p></body></html>` }),
      },
      pairReaderForListing: () => async () => {
        throw new Error("google/gemma-3-27b-it request failed: HTTP 504");
      },
      fetchToday: async () => ({ ok: true, text: "TERMS=B" }),
      textDayOf: () => "2026-02-10",
    });
    assert.strictEqual(report.results[0].outcome, "reader_failed");
    assert.match(report.results[0].why, /HTTP 504/);
    assert.strictEqual(report.split[SPLIT.readerFailed], 1);
  });
});

describe("each result names its record and the archived copy that settled it", () => {
  it("carries the key a writer finds the record by, distinct for two records that differ only in their summary, and the copy's address in the Archive", async () => {
    const changes = ["Alpha cut its free plan to 1 project", "Alpha cut its free plan to 2 projects"].map((summary) =>
      change({ vendor: "Alpha", date: "2026-09-01", date_source: "discovered", previous_state: "A", current_state: "B", source_url: "https://alpha.example/pricing", summary }));
    const archive = {
      captures: async (url: string) => ({ captures: [{ timestamp: "20260205120000", original: url, statuscode: "200", mimetype: "text/html" }] }),
      captureHtml: async () => ({ html: `<html><body><p>TERMS=B</p><p>${"Plans and limits. ".repeat(40)}</p></body></html>` }),
    };
    const report = await settleFirstReadings({
      statedReaderForRecord: () => statesItAlready,
      changes,
      offers: [],
      today: "2026-09-28",
      archive,
      pairReaderForListing: termsPairReader,
      fetchToday: async () => ({ ok: true, text: "TERMS=B" }),
      textDayOf: () => "2026-02-10",
    });
    assert.deepStrictEqual(report.results.map((r: { record_key: string }) => r.record_key), changes.map(recordKey));
    assert.strictEqual(new Set(report.results.map((r: { record_key: string }) => r.record_key)).size, 2);
    for (const result of report.results) {
      assert.strictEqual(result.outcome, "ours");
      assert.deepStrictEqual(result.capture, { day: "2026-02-05", gap_days: 5, side: "before", url: "https://web.archive.org/web/20260205120000/https://alpha.example/pricing" });
    }
  });
});

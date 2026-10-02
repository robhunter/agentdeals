import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changeLogSections, earliestMonthListedAheadOfUndatedChanges } from "../dist/change-log-sections.js";
import { changeTypeFeedLabel, feedEntryTitle } from "../dist/change-feed.js";
import { isEventDated } from "../dist/change-dates.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = new Date().toISOString().slice(0, 10);

type Logged = {
  vendor: string;
  change_type: string;
  date: string;
  date_source: string;
  recorded_date: string;
  resolution?: { state: string; date: string; detail?: string };
};

const isOurs = (c: Logged) => c.change_type === "record_corrected" || c.resolution?.state === "retracted";

describe("the order of the change log", () => {
  const logged = (vendor: string, change_type: string, date: string, date_source: string, extra: Partial<Logged> = {}): Logged =>
    ({ vendor, change_type, date, date_source, recorded_date: "2026-10-02", ...extra });
  const retracted = { resolution: { state: "retracted", date: "2026-10-02" } };
  const reversed = { resolution: { state: "reversed", date: "2026-10-02" } };
  const log = [
    logged("Undated older", "limits_reduced", "2026-06-01", "discovered"),
    logged("Older", "limits_reduced", "2026-07-31", "vendor_page"),
    logged("Retracted undated", "limits_reduced", "2026-09-01", "discovered", retracted),
    logged("Undated", "pricing_restructured", "2026-09-15", "discovered"),
    logged("This month", "limits_increased", "2026-10-01", "vendor_page"),
    logged("Correction", "record_corrected", "2026-10-02", "hand_written"),
    logged("Retracted dated", "free_tier_removed", "2026-10-01", "vendor_page", retracted),
    logged("Two months back", "new_free_tier", "2026-08-01", "vendor_page"),
    logged("Announced", "limits_reduced", "2026-11-15", "vendor_page"),
    logged("Reversed", "free_tier_removed", "2026-09-20", "vendor_page", reversed),
  ];
  const sections = changeLogSections(log, "2026-10-02");
  const vendors = (changes: Logged[]) => changes.map(c => c.vendor);
  const months = (groups: { month: string; changes: Logged[] }[]) => groups.map(g => `${g.month}: ${vendors(g.changes).join(", ")}`);

  it("starts with the effective-dated changes of the current month and the two before it, after any announced for later months", () => {
    assert.deepStrictEqual(months(sections.recentMonths), [
      "2026-11: Announced",
      "2026-10: This month",
      "2026-09: Reversed",
      "2026-08: Two months back",
    ]);
  });

  it("lists the changes with no known effective date next, then the older months", () => {
    assert.deepStrictEqual(vendors(sections.undated), ["Undated", "Undated older"]);
    assert.deepStrictEqual(months(sections.olderMonths), ["2026-07: Older"]);
  });

  it("lists our corrections and retracted records last, newest first, and nowhere else", () => {
    assert.deepStrictEqual(vendors(sections.ours), ["Correction", "Retracted dated", "Retracted undated"]);
    const vendorChanges = [
      ...sections.recentMonths.flatMap(g => g.changes),
      ...sections.undated,
      ...sections.olderMonths.flatMap(g => g.changes),
    ];
    assert.deepStrictEqual(vendors(vendorChanges.filter(isOurs)), []);
    assert.strictEqual(vendorChanges.length + sections.ours.length, log.length);
  });

  it("counts back three calendar months from today, across a year end", () => {
    assert.strictEqual(earliestMonthListedAheadOfUndatedChanges("2026-10-02"), "2026-08");
    assert.strictEqual(earliestMonthListedAheadOfUndatedChanges("2026-10-31"), "2026-08");
    assert.strictEqual(earliestMonthListedAheadOfUndatedChanges("2026-03-31"), "2026-01");
    assert.strictEqual(earliestMonthListedAheadOfUndatedChanges("2026-02-28"), "2025-12");
    assert.strictEqual(earliestMonthListedAheadOfUndatedChanges("2027-01-05"), "2026-11");
  });
});

describe("a change feed entry's title", () => {
  it("says a retracted record was our error and does not name the change it reported", () => {
    const title = feedEntryTitle({ vendor: "Example", change_type: "free_tier_removed", resolution: { state: "retracted", date: "2026-10-01" } });
    assert.strictEqual(title, "Example: Retracted — this record was our error (2026-10-01).");
    assert.ok(!title.includes(changeTypeFeedLabel("free_tier_removed")), title);
  });

  it("names the change type of every other record, including one the vendor reversed", () => {
    assert.strictEqual(feedEntryTitle({ vendor: "Example", change_type: "free_tier_removed" }), "Example: Free Tier Removed");
    assert.strictEqual(
      feedEntryTitle({ vendor: "Example", change_type: "free_tier_removed", resolution: { state: "reversed", date: "2026-10-01" } }),
      "Example: Free Tier Removed",
    );
    assert.strictEqual(feedEntryTitle({ vendor: "Example", change_type: "record_corrected" }), "Example: Record Corrected");
  });
});

const liveLog = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8"));
const catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8"));
const vendorsWithARecord = new Set<string>(liveLog.changes.map((c: Logged) => c.vendor.toLowerCase()));
const quietOffer: { vendor: string; category: string } | undefined = catalogue.offers.find(
  (o: { vendor: string }) => /^[A-Za-z][A-Za-z0-9 ]+$/.test(o.vendor) && !vendorsWithARecord.has(o.vendor.toLowerCase()),
);

const MARK = "pricing-changes-order-fixture";
const EARLIEST_RECENT_MONTH = earliestMonthListedAheadOfUndatedChanges(TODAY);
const monthBefore = (month: string) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
const OLDER_MONTH = monthBefore(EARLIEST_RECENT_MONTH);
const retractedToday = { resolution: { state: "retracted", date: TODAY, detail: "Fixture." } };

const fixture = (name: string, change_type: string, date: string, date_source: string, extra: object = {}) => ({
  vendor: quietOffer?.vendor ?? "",
  change_type,
  date,
  date_source,
  recorded_date: TODAY,
  summary: `${MARK} ${name}`,
  source_url: "https://example.com/pricing",
  impact: "medium",
  category: quietOffer?.category ?? "",
  alternatives: [],
  ...extra,
});

const injected = [
  fixture("recent-month", "limits_increased", `${EARLIEST_RECENT_MONTH}-15`, "vendor_page"),
  fixture("older-month", "limits_reduced", `${OLDER_MONTH}-15`, "vendor_page"),
  fixture("undated", "pricing_restructured", TODAY, "discovered"),
  fixture("correction", "record_corrected", TODAY, "hand_written"),
  fixture("retracted-dated", "free_tier_removed", `${EARLIEST_RECENT_MONTH}-15`, "vendor_page", retractedToday),
  fixture("retracted-undated", "limits_reduced", TODAY, "discovered", retractedToday),
];
const scratchLog: Logged[] = [...liveLog.changes, ...injected];

const scratch = mkdtempSync(path.join(tmpdir(), "pricing-changes-order-"));
const changesPath = path.join(scratch, "deal_changes.json");
writeFileSync(changesPath, JSON.stringify({ ...liveLog, changes: scratchLog }));

function serve(env: Record<string, string>): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

describe("/pricing-changes", () => {
  let server: ChildProcess;
  let port = 0;
  let html = "";

  before(async () => {
    assert.ok(quietOffer, "the catalogue holds no vendor without a change record, so the fixtures have no vendor of their own");
    ({ child: server, port } = await serve({ AGENTDEALS_CHANGES_PATH: changesPath }));
    html = await (await fetch(`http://localhost:${port}/pricing-changes`)).text();
  });

  after(() => {
    server?.kill();
    rmSync(scratch, { recursive: true, force: true });
  });

  const fixtureAt = (name: string) => {
    const at = html.indexOf(`${MARK} ${name}`);
    assert.ok(at >= 0, `the ${name} fixture is not on the page`);
    return at;
  };
  const headingAt = (id: string) => {
    const at = html.indexOf(`<h2 class="month-heading" id="${id}"`);
    assert.ok(at >= 0, `no heading with id ${id} on the page`);
    return at;
  };
  const headings = () => [...html.matchAll(/<h2 class="month-heading" id="([^"]+)"/g)].map(m => ({ id: m[1], at: m.index }));
  const entriesBetween = (from: number, to: number) => html.slice(from, to).split('<div class="pc-entry').length - 1;

  it("lists the effective-dated changes of the last three calendar months before any change with no known effective date", () => {
    assert.ok(fixtureAt("recent-month") < headingAt("month-undated"));
    assert.ok(headingAt("month-undated") < fixtureAt("undated"));
    const ids = headings().map(h => h.id);
    const undated = ids.indexOf("month-undated");
    const recent = ids.slice(0, undated).map(id => id.replace(/^month-/, ""));
    assert.ok(recent.includes(EARLIEST_RECENT_MONTH), `${EARLIEST_RECENT_MONTH} is not listed ahead of the undated changes`);
    assert.deepStrictEqual(recent.filter(month => month < EARLIEST_RECENT_MONTH), []);
    assert.deepStrictEqual(recent, [...recent].sort().reverse());
  });

  it("lists older months after the changes with no known effective date, newest first", () => {
    assert.ok(fixtureAt("undated") < fixtureAt("older-month"));
    const ids = headings().map(h => h.id);
    const older = ids.slice(ids.indexOf("month-undated") + 1, ids.indexOf("month-ours")).map(id => id.replace(/^month-/, ""));
    assert.ok(older.includes(OLDER_MONTH), `${OLDER_MONTH} is not listed after the undated changes`);
    assert.deepStrictEqual(older.filter(month => month >= EARLIEST_RECENT_MONTH), []);
    assert.deepStrictEqual(older, [...older].sort().reverse());
  });

  it("lists every correction and retracted record after the last vendor change, in a section of their own", () => {
    const ours = headingAt("month-ours");
    assert.strictEqual(headings().at(-1)?.id, "month-ours");
    for (const name of ["correction", "retracted-dated", "retracted-undated"]) {
      assert.ok(fixtureAt(name) > ours, `the ${name} fixture is listed before our records' section`);
    }
    assert.ok(fixtureAt("older-month") < ours);
    const afterTheLog = html.indexOf('<div class="cross-links">');
    assert.strictEqual(entriesBetween(ours, afterTheLog), scratchLog.filter(isOurs).length);
  });

  it("prints no retraction and no correction of ours before that section", () => {
    const beforeOurs = html.slice(0, headingAt("month-ours"));
    assert.ok(!beforeOurs.includes("Retracted — this record was our error"), "a retracted record is listed among the vendor changes");
    assert.ok(!beforeOurs.includes('data-type="record_corrected"'), "a correction of ours is listed among the vendor changes");
  });

  it("lists under the undated heading only the vendor changes with no known effective date, and counts those", () => {
    const ids = headings();
    const undated = ids.findIndex(h => h.id === "month-undated");
    const expected = scratchLog.filter(c => !isOurs(c) && !isEventDated(c)).length;
    assert.strictEqual(entriesBetween(ids[undated].at!, ids[undated + 1].at!), expected);
    assert.match(html, new RegExp(`id="month-undated">Effective date unknown \\(${expected} changes?, of `));
  });

  it("titles the feed's entries for retracted records as our error", async () => {
    const vendor = quietOffer!.vendor;
    const res = await fetch(`http://localhost:${port}/pricing-changes/feed.xml?vendor=${encodeURIComponent(vendor)}`);
    assert.strictEqual(res.status, 200);
    const titles = [...(await res.text()).matchAll(/<entry>\s*<title>([^<]*)<\/title>/g)].map(m => m[1]);
    const retractedTitle = `${vendor}: Retracted — this record was our error (${TODAY}).`;
    assert.strictEqual(titles.filter(t => t === retractedTitle).length, 2, titles.join(" | "));
    assert.ok(!titles.includes(`${vendor}: Free Tier Removed`), titles.join(" | "));
    assert.ok(titles.includes(`${vendor}: Limits Increased`), titles.join(" | "));
  });
});

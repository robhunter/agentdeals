import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isoWeekWindow,
  withinWindow,
  changesInWindow,
  discoveryBatchNote,
  firstReadHeading,
  partitionByDateProvenance,
} from "../dist/change-dates.js";
import { FEED_CORRECTIONS } from "../dist/feed-corrections.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const publishedChanges = JSON.parse(
  readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")
).changes as Array<{ date: string; date_source: string; change_type: string; vendor: string }>;

function eventDated(c: { date_source?: string }): boolean {
  return c.date_source === "vendor_page" || c.date_source === "hand_written";
}

function dated(dateSource: string, date: string) {
  return { vendor: "Acme", date, date_source: dateSource, change_type: "limits_reduced" };
}

describe("one definition of the week a digest is about", () => {
  it("runs Monday to Sunday whichever day of the week it is handed", () => {
    assert.deepStrictEqual(isoWeekWindow(new Date("2026-08-26T09:00:00Z")), {
      start: "2026-08-24",
      end: "2026-08-30",
    });
    assert.deepStrictEqual(isoWeekWindow(new Date("2026-08-24T00:00:00Z")), {
      start: "2026-08-24",
      end: "2026-08-30",
    });
    assert.deepStrictEqual(isoWeekWindow(new Date("2026-08-30T23:59:00Z")), {
      start: "2026-08-24",
      end: "2026-08-30",
    });
  });

  it("includes both end dates and stays open when no end is given", () => {
    const week = { start: "2026-08-24", end: "2026-08-30" };
    assert.strictEqual(withinWindow("2026-08-24", week), true);
    assert.strictEqual(withinWindow("2026-08-30", week), true);
    assert.strictEqual(withinWindow("2026-08-23", week), false);
    assert.strictEqual(withinWindow("2026-08-31", week), false);
    assert.strictEqual(withinWindow("2099-01-01", { start: "2026-08-24" }), true);
  });

  it("keeps a record dated outside the window out of both halves", () => {
    const week = { start: "2026-08-24", end: "2026-08-30" };
    const { dated: inside, discovered } = changesInWindow(
      [
        dated("hand_written", "2026-08-26"),
        dated("discovered", "2026-08-28"),
        dated("hand_written", "2026-09-30"),
        dated("hand_written", "2026-08-20"),
        dated("discovered", "2026-09-01"),
      ] as never[],
      week
    );
    assert.deepStrictEqual(inside.map((c: { date: string }) => c.date), ["2026-08-26"]);
    assert.deepStrictEqual(discovered.map((c: { date: string }) => c.date), ["2026-08-28"]);
  });

  it("answers the Last 30 Days question with the same call the week uses", () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const viaWindow = changesInWindow(publishedChanges as never[], { start: thirtyDaysAgo }).dated.length;
    const viaPartition = partitionByDateProvenance(publishedChanges as never[]).dated.filter(
      (c: { date: string }) => c.date >= thirtyDaysAgo
    ).length;
    assert.strictEqual(viaWindow, viaPartition);
  });
});

describe("the sentence a discovery batch gets", () => {
  it("names the window twice and never calls the batch a change", () => {
    const note = discoveryBatchNote(153, "this week");
    assert.match(note, /^153 pricing pages read for the first time this week\./);
    assert.match(note, /not counted as changes that took effect this week\.$/);
    assert.ok(!/153 (pricing )?changes/.test(note), note);
  });

  it("reads as one page when there is one", () => {
    const note = discoveryBatchNote(1, "this week");
    assert.match(note, /^1 pricing page read for the first time this week\./);
    assert.match(note, /it is dated by discovery and is not counted as a change that took effect this week\./);
  });

  it("counts the batch in its own heading", () => {
    assert.strictEqual(firstReadHeading(153), "Pages read for the first time (153)");
  });
});

describe("a weekly digest counts only changes with an effective date", () => {
  it("puts every discovered record on the discovery side and none in the change count", async () => {
    const { getFormattedWeeklyDigest } = await import("../dist/data.js");
    const digest = getFormattedWeeklyDigest(0, 200);
    const window = { start: digest.week_of, end: digest.week_ending };
    const expectedDated = publishedChanges.filter((c) => eventDated(c) && withinWindow(c.date, window));
    const expectedDiscovered = publishedChanges.filter((c) => !eventDated(c) && withinWindow(c.date, window));

    assert.strictEqual(digest.changes_in_week, expectedDated.length);
    assert.strictEqual(digest.discovered_in_week, expectedDiscovered.length);
    for (const c of digest.top_changes) assert.ok(eventDated(c), `${c.vendor} ${c.date_source}`);
    for (const c of digest.discovered_changes) assert.ok(!eventDated(c), `${c.vendor} ${c.date_source}`);
  });

  it("counts each change type over the dated half only", async () => {
    const { getFormattedWeeklyDigest } = await import("../dist/data.js");
    const digest = getFormattedWeeklyDigest(0, 200);
    const window = { start: digest.week_of, end: digest.week_ending };
    const inWeek = publishedChanges.filter((c) => eventDated(c) && withinWindow(c.date, window));
    const count = (t: string) => inWeek.filter((c) => c.change_type === t).length;
    assert.strictEqual(digest.summary.free_tiers_removed, count("free_tier_removed"));
    assert.strictEqual(digest.summary.limits_reduced, count("limits_reduced"));
    assert.strictEqual(digest.summary.new_free_tiers, count("new_free_tier"));
    assert.strictEqual(digest.summary.limits_increased, count("limits_increased"));
    assert.strictEqual(digest.summary.products_deprecated, count("product_deprecated"));
    assert.strictEqual(digest.summary.pricing_restructured, count("pricing_restructured"));
  });

  it("never states the combined total as a number of changes", async () => {
    const { getFormattedWeeklyDigest } = await import("../dist/data.js");
    const digest = getFormattedWeeklyDigest(0, 200);
    const combined = digest.changes_in_week + digest.discovered_in_week;
    assert.ok(digest.discovered_in_week > 0, "the corpus should carry a discovery batch to guard against");
    assert.ok(
      !digest.headline.includes(`across ${combined} developer tool pricing change`),
      digest.headline
    );
    assert.ok(digest.headline.includes(String(digest.changes_in_week)), digest.headline);
    assert.ok(!digest.digest_markdown.includes(`> ${combined} developer tool pricing change`));
  });

  it("agrees with itself on singular and plural", async () => {
    const { getFormattedWeeklyDigest } = await import("../dist/data.js");
    for (let weeksAgo = 0; weeksAgo < 40; weeksAgo++) {
      const digest = getFormattedWeeklyDigest(weeksAgo, 200);
      if (digest.changes_in_week === 1) {
        assert.ok(
          !digest.headline.includes("1 developer tool pricing changes"),
          `${weeksAgo}: ${digest.headline}`
        );
      }
    }
  });

  it("gives the discovery batch its own heading and its own sentence", async () => {
    const { getFormattedWeeklyDigest } = await import("../dist/data.js");
    const digest = getFormattedWeeklyDigest(0, 200);
    assert.ok(digest.discovery_note.length > 0);
    assert.ok(digest.digest_markdown.includes(`## ${firstReadHeading(digest.discovered_in_week)}`));
    assert.ok(digest.digest_markdown.includes(digest.discovery_note));
    assert.ok(digest.digest_html.includes(`<h2>${firstReadHeading(digest.discovered_in_week)}</h2>`));
  });

  it("says nothing about discovery in a week that has none", async () => {
    const { getFormattedWeeklyDigest } = await import("../dist/data.js");
    const quiet: number[] = [];
    for (let weeksAgo = 1; weeksAgo < 60; weeksAgo++) {
      const digest = getFormattedWeeklyDigest(weeksAgo, 200);
      if (digest.discovered_in_week !== 0) continue;
      quiet.push(weeksAgo);
      assert.strictEqual(digest.discovery_note, "");
      assert.strictEqual(digest.discovered_changes.length, 0);
      assert.ok(!digest.digest_markdown.includes("read for the first time"), String(weeksAgo));
      assert.ok(!digest.digest_html.includes("read for the first time"), String(weeksAgo));
      assert.strictEqual(Math.min(digest.changes_in_week, 200), digest.top_changes.length);
    }
    assert.ok(quiet.length > 20, `expected most archived weeks to carry no discovery batch, got ${quiet.length}`);
  });
});

describe("the digest returns only what the window it names contains", () => {
  it("keeps every returned change inside the range it publishes", async () => {
    const { getWeeklyDigest } = await import("../dist/data.js");
    const digest = getWeeklyDigest();
    const [start, end] = digest.date_range.split(" to ");
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end), digest.date_range);
    for (const c of digest.deal_changes) {
      assert.ok(eventDated(c), `${c.vendor} ${c.date_source}`);
      assert.ok(withinWindow(c.date, { start, end }), `${c.vendor} ${c.date} outside ${digest.date_range}`);
    }
  });

  it("keeps every first-read record inside the week it names", async () => {
    const { getWeeklyDigest } = await import("../dist/data.js");
    const digest = getWeeklyDigest();
    const [start, end] = digest.week.split(" to ");
    for (const c of digest.discovered_changes) {
      assert.ok(!eventDated(c), `${c.vendor} ${c.date_source}`);
      assert.ok(withinWindow(c.date, { start, end }), `${c.vendor} ${c.date} outside ${digest.week}`);
    }
  });

  it("routes a future-dated change to the deadlines rather than to the week", async () => {
    const { getWeeklyDigest } = await import("../dist/data.js");
    const digest = getWeeklyDigest();
    const today = new Date().toISOString().slice(0, 10);
    const future = publishedChanges.filter((c) => eventDated(c) && c.date > today);
    assert.ok(future.length > 0, "the corpus should carry a future-dated change to place");
    for (const c of future) {
      assert.ok(
        digest.upcoming_deadlines.some((d) => d.vendor === c.vendor && d.date === c.date),
        `${c.vendor} ${c.date} should be an upcoming deadline`
      );
      assert.ok(
        !digest.deal_changes.some((d) => d.vendor === c.vendor && d.date === c.date && d.date > today),
        `${c.vendor} ${c.date} should not be reported as a change already tracked`
      );
    }
  });

  it("opens its summary with the number of changes it actually returns", async () => {
    const { getWeeklyDigest } = await import("../dist/data.js");
    const digest = getWeeklyDigest();
    assert.match(digest.summary, new RegExp(`^${digest.deal_changes.length} pricing change`));
    assert.ok(digest.summary.includes("with a known effective date"), digest.summary);
    if (digest.discovered_changes.length > 0) {
      assert.ok(digest.summary.includes("read for the first time this week"), digest.summary);
    }
  });
});

describe("the feed corrects a published week with an entry of its own", () => {
  it("gives the correction an id no weekly entry can collide with", () => {
    assert.ok(FEED_CORRECTIONS.length > 0);
    for (const c of FEED_CORRECTIONS) {
      assert.ok(c.id.startsWith("urn:agentdeals:correction:"), c.id);
      assert.ok(!c.id.startsWith("urn:agentdeals:weekly-digest:"), c.id);
      assert.match(c.updated, /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(c.summaryHtml.includes("<p>"), c.id);
    }
  });

  it("quotes the count it is correcting and names what replaced it", () => {
    const correction = FEED_CORRECTIONS.find((c) => c.id.includes("weekly-digest-2026-08-24"));
    assert.ok(correction, "the week of 2026-08-24 should carry a correction");
    assert.ok(correction!.summaryHtml.includes("154 developer tool pricing changes"), correction!.summaryHtml);
    assert.ok(correction!.summaryHtml.includes("2026-08-28"), correction!.summaryHtml);
    assert.ok(correction!.summaryHtml.includes("known effective date"), correction!.summaryHtml);
  });
});

describe("every weekly surface reports the same week", () => {
  let serverPort = 0;
  let proc: ChildProcess | null = null;

  function startHttpServer(): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const serverPath = path.join(REPO, "dist", "serve.js");
      const p = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1" },
      });
      const timeout = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("Server startup timeout")); }, 20000);
      p.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) { serverPort = parseInt(match[1], 10); clearTimeout(timeout); resolve(p); }
      });
      p.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
  }

  afterEach(() => {
    if (proc) { proc.kill("SIGKILL"); proc = null; }
  });

  it("publishes one count for the week across the page, the API and the feed", async () => {
    proc = await startHttpServer();
    const base = `http://127.0.0.1:${serverPort}`;
    const weekly = await (await fetch(`${base}/api/digest/weekly?limit=200`)).json() as {
      changes_in_week: number; discovered_in_week: number; headline: string;
    };
    const page = await (await fetch(`${base}/this-week`)).text();
    const feed = await (await fetch(`${base}/feed.xml`)).text();

    const combined = weekly.changes_in_week + weekly.discovered_in_week;
    assert.ok(weekly.discovered_in_week > 0, "the corpus should carry a discovery batch to guard against");
    const inflated = `across ${combined} developer tool pricing change`;

    assert.ok(!page.includes(inflated), "/this-week");
    assert.ok(page.includes(weekly.headline), "/this-week should carry the headline");
    assert.ok(page.includes(firstReadHeading(weekly.discovered_in_week)), "/this-week");

    const entries = feed.split("<entry>").slice(1);
    const corrections = entries.filter((e) => e.includes("urn:agentdeals:correction:"));
    const weeks = entries.filter((e) => !e.includes("urn:agentdeals:correction:"));
    assert.ok(weeks.length > 0, "/feed.xml should carry weekly entries");
    for (const entry of weeks) assert.ok(!entry.includes(inflated), "/feed.xml weekly entry");
    assert.ok(
      corrections.some((e) => e.includes(inflated)),
      "a corrected count should survive only inside the entry correcting it"
    );
  });

  it("counts the last thirty days on /changes the way the week is counted", async () => {
    proc = await startHttpServer();
    const base = `http://127.0.0.1:${serverPort}`;
    const changesPage = await (await fetch(`${base}/changes`)).text();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const expected = changesInWindow(publishedChanges as never[], { start: thirtyDaysAgo }).dated.length;
    const rendered = changesPage.match(/<div class="stat-value">(\d+)<\/div>\s*<div class="stat-label">Last 30 Days<\/div>/);
    assert.ok(rendered, "/changes should publish a Last 30 Days count");
    assert.strictEqual(parseInt(rendered![1], 10), expected);
  });

  it("labels the discovery batch on the archived week that holds it", async () => {
    proc = await startHttpServer();
    const base = `http://127.0.0.1:${serverPort}`;
    const week = await (await fetch(`${base}/digest/2026-w35`)).text();
    assert.ok(week.includes("Week 35, 2026. 1 change tracked."), "the archived week should count one change");
    assert.ok(week.includes(firstReadHeading(153)), "the archived week should name its discovery batch");
    assert.ok(!week.includes("154 changes tracked"), "the archived week should not count the batch as changes");
  });

  it("separates the two counts in the archive index", async () => {
    proc = await startHttpServer();
    const base = `http://127.0.0.1:${serverPort}`;
    const archive = await (await fetch(`${base}/digest/archive`)).text();
    assert.ok(archive.includes("1 change + 153 first read"), "the archive should split the week it holds");
    assert.ok(!archive.includes("154 changes"), "the archive should not count the batch as changes");
  });

  it("tells an API caller how many of its records carry an effective date", async () => {
    proc = await startHttpServer();
    const base = `http://127.0.0.1:${serverPort}`;
    const body = await (await fetch(`${base}/api/changes?since=2026-08-22`)).json() as {
      changes: Array<{ date_source: string }>;
      date_provenance: { event_dated: number; discovered: number; note: string };
    };
    const expectedDated = body.changes.filter(eventDated).length;
    const expectedDiscovered = body.changes.length - expectedDated;
    assert.ok(expectedDiscovered > 0, "the window should carry a discovery batch to report");
    assert.strictEqual(body.date_provenance.event_dated, expectedDated);
    assert.strictEqual(body.date_provenance.discovered, expectedDiscovered);
    assert.ok(body.date_provenance.note.startsWith(`${expectedDiscovered} pricing pages read`), body.date_provenance.note);
  });

  it("leaves an archived week with no discovery batch alone", async () => {
    proc = await startHttpServer();
    const base = `http://127.0.0.1:${serverPort}`;
    const week = await (await fetch(`${base}/digest/2026-w34`)).text();
    assert.ok(week.includes("1 change tracked."), "week 34 should count one change");
    assert.ok(!week.includes("read for the first time"), "week 34 has no discovery batch to report");
  });
});

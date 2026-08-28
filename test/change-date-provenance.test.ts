import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isEventDated,
  partitionByDateProvenance,
  changeLogFreshness,
  DATE_SOURCES,
  EVENT_DATED_SOURCES,
} from "../dist/data.js";
import {
  capListSections,
  changeDateLabel,
  changeDatePublished,
  feedEntryUpdated,
  undatedGroupHeading,
  DISCOVERED_DATE_PREFIX,
  UNDATED_GROUP_NOTE,
} from "../dist/change-dates.js";

const { buildChangeEntry } = await import("../scripts/change-log.js");
const { planBackfill } = await import("../scripts/backfill-change-date-sources.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const TODAY = new Date().toISOString().slice(0, 10);
const TEN_DAYS_AGO = new Date(Date.parse(TODAY) - 10 * 86400000).toISOString().slice(0, 10);
const SUBJECT = "Xata";
const CONTROL = "Hyperping";

const OFFER = {
  vendor: SUBJECT,
  category: "Databases",
  description: "15 GB storage on the free plan.",
  url: "https://xata.io/pricing",
};

function fixtureChange(dateSource: string) {
  return {
    vendor: SUBJECT,
    change_type: "limits_reduced",
    date: TODAY,
    date_source: dateSource,
    summary: "Free storage allowance cut.",
    previous_state: "15 GB storage",
    current_state: "5 GB storage",
    impact: "high",
    source_url: "https://xata.io/pricing",
    category: "Databases",
    alternatives: [],
    detected_by: "reverify-ai",
    recorded_date: TODAY,
  };
}

function controlChange() {
  return {
    vendor: CONTROL,
    change_type: "limits_reduced",
    date: TEN_DAYS_AGO,
    date_source: "vendor_page",
    summary: "Monitor allowance cut.",
    previous_state: "10 monitors",
    current_state: "5 monitors",
    impact: "medium",
    source_url: "https://hyperping.io/pricing",
    category: "Monitoring",
    alternatives: [],
    recorded_date: TEN_DAYS_AGO,
  };
}

describe("what a date_source means", () => {
  it("treats only an explicitly recorded provenance as an event date", () => {
    for (const source of EVENT_DATED_SOURCES) {
      assert.strictEqual(isEventDated({ date_source: source } as any), true, source);
    }
    assert.strictEqual(isEventDated({ date_source: "discovered" } as any), false);
  });

  it("under-claims rather than over-claims when the provenance is absent or unrecognised", () => {
    assert.strictEqual(isEventDated({} as any), false);
    assert.strictEqual(isEventDated({ date_source: "" } as any), false);
    assert.strictEqual(isEventDated({ date_source: "from_somewhere" } as any), false);
  });

  it("has exactly one value that is not an event date", () => {
    const notEventDated = DATE_SOURCES.filter((s: string) => !EVENT_DATED_SOURCES.includes(s as any));
    assert.deepStrictEqual(notEventDated, ["discovered"]);
  });

  it("splits a mixed log without losing or duplicating an entry", () => {
    const mixed = [
      fixtureChange("vendor_page"),
      fixtureChange("discovered"),
      fixtureChange("hand_written"),
      { ...fixtureChange("discovered"), date_source: undefined },
    ];
    const { dated, discovered } = partitionByDateProvenance(mixed as any);
    assert.strictEqual(dated.length, 2);
    assert.strictEqual(discovered.length, 2);
    assert.strictEqual(dated.length + discovered.length, mixed.length);
  });
});

describe("the writer refuses to pass a sweep date off as an effective date", () => {
  const NOW = new Date("2026-09-10T06:00:00Z");
  const result = { change_type: "limits_reduced", summary: "Cut.", current_state: "5 GB" };

  it("records where the date came from when the page states one", () => {
    const { entry } = buildChangeEntry(OFFER, { ...result, effective_date: "2026-07-01" }, { now: NOW });
    assert.strictEqual(entry.date, "2026-07-01");
    assert.strictEqual(entry.date_source, "vendor_page");
  });

  it("marks the run date as a discovery when the page states none", () => {
    const { entry } = buildChangeEntry(OFFER, result, { now: NOW });
    assert.strictEqual(entry.date, "2026-09-10");
    assert.strictEqual(entry.recorded_date, "2026-09-10");
    assert.strictEqual(entry.date_source, "discovered");
  });

  it("marks a malformed page-stated date as a discovery rather than keeping it", () => {
    for (const bad of ["July 2026", "2026-7-1", "", "   ", "2026-07-01T00:00:00Z"]) {
      const { entry } = buildChangeEntry(OFFER, { ...result, effective_date: bad }, { now: NOW });
      assert.strictEqual(entry.date_source, "discovered", `expected discovery for ${JSON.stringify(bad)}`);
      assert.strictEqual(entry.date, "2026-09-10");
    }
  });

  it("never emits a provenance outside the published set", () => {
    for (const effective_date of ["2026-07-01", undefined]) {
      const { entry } = buildChangeEntry(OFFER, { ...result, effective_date }, { now: NOW });
      assert.ok(DATE_SOURCES.includes(entry.date_source), entry.date_source);
    }
  });
});

describe("backfilling the entries written before the field existed", () => {
  it("labels a hand-written entry and leaves an already-labelled one alone", () => {
    const changes = [
      { vendor: "A", date: "2026-01-01" },
      { vendor: "B", date: "2026-01-01", date_source: "vendor_page" },
    ];
    const { toLabel, alreadyLabelled, machineWritten } = planBackfill(changes);
    assert.deepStrictEqual(toLabel.map((c: any) => c.vendor), ["A"]);
    assert.deepStrictEqual(alreadyLabelled.map((c: any) => c.vendor), ["B"]);
    assert.strictEqual(machineWritten.length, 0);
  });

  it("does not claim a machine-written entry was hand-written", () => {
    const changes = [{ vendor: "A", date: "2026-01-01", detected_by: "reverify-ai" }];
    const { toLabel, machineWritten } = planBackfill(changes);
    assert.strictEqual(toLabel.length, 0);
    assert.strictEqual(machineWritten.length, 1);
  });

  it("left every published entry carrying a provenance", () => {
    const published = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes;
    const freshness = changeLogFreshness(published, new Date());
    assert.strictEqual(freshness.entries_without_date_source, 0);
    assert.ok(published.length > 100, `expected the real log, got ${published.length} entries`);
  });

  it("counts entries whose date is only a discovery", () => {
    const freshness = changeLogFreshness(
      [fixtureChange("vendor_page"), fixtureChange("discovered"), fixtureChange("discovered")] as any,
      new Date()
    );
    assert.strictEqual(freshness.discovered_date_total, 2);
  });
});

describe("the rendering helpers", () => {
  it("prefixes a discovery date and leaves an event date bare", () => {
    assert.strictEqual(changeDateLabel(fixtureChange("vendor_page") as any), TODAY);
    assert.strictEqual(changeDateLabel(fixtureChange("hand_written") as any), TODAY);
    assert.strictEqual(
      changeDateLabel(fixtureChange("discovered") as any),
      `${DISCOVERED_DATE_PREFIX} ${TODAY}`
    );
  });

  it("omits datePublished from structured data rather than publishing a discovery date", () => {
    assert.deepStrictEqual(changeDatePublished(fixtureChange("vendor_page") as any), { datePublished: TODAY });
    assert.deepStrictEqual(changeDatePublished(fixtureChange("discovered") as any), {});
  });

  it("says in the group heading and note that the effective date is what is missing", () => {
    assert.match(undatedGroupHeading(1), /1 change\b/);
    assert.match(undatedGroupHeading(3), /3 changes\b/);
    assert.match(UNDATED_GROUP_NOTE, /not when they took effect/);
    assert.match(UNDATED_GROUP_NOTE, /excluded from the monthly groups/);
  });
});

function countEntriesFor(html: string, prefix: string, vendor: string): number {
  const link = new RegExp(`class="${prefix}-vendor">${vendor}</a>`, "g");
  return (html.match(link) ?? []).length;
}

function regionFrom(html: string, start: string, end?: string): string {
  const i = html.indexOf(start);
  if (i === -1) return "";
  const j = end ? html.indexOf(end, i + start.length) : -1;
  return j === -1 ? html.slice(i) : html.slice(i, j);
}

function structuredItemFor(html: string, vendor: string): { datePublished?: string } | null {
  for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const json = JSON.parse(block[1]);
    if (!Array.isArray(json.itemListElement)) continue;
    const found = json.itemListElement
      .map((el: any) => el.item)
      .find((item: any) => typeof item?.headline === "string" && item.headline.startsWith(`${vendor}:`));
    if (found) return found;
  }
  return null;
}

function last30DaysTile(html: string): number {
  const m = html.match(/<div class="stat-value">(\d+)<\/div>\s*<div class="stat-label">Last 30 Days<\/div>/);
  assert.ok(m, "could not find the Last 30 Days tile");
  return parseInt(m![1], 10);
}

const CHANGE_SURFACES = [
  "/",
  "/changes",
  "/expiring",
  "/pricing-changes",
  "/reports",
  `/reports/${TODAY.slice(0, 7)}`,
  `/vendor/${SUBJECT.toLowerCase()}`,
  "/api/changes",
  "/api/digest",
];

describe("no surface renders a discovery date as the date the vendor changed something", () => {
  let tmp: string;
  let datedPort = 0;
  let discoveredPort = 0;
  let datedProc: ChildProcess;
  let discoveredProc: ChildProcess;

  function start(changesPath: string): Promise<{ proc: ChildProcess; port: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PORT: "0",
          BASE_URL: "http://localhost:3000",
          AGENTDEALS_CHANGES_PATH: changesPath,
        },
      });
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("Server startup timeout"));
      }, 30000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) {
          clearTimeout(timeout);
          resolve({ proc: child, port: parseInt(m[1], 10) });
        }
      });
      child.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "date-provenance-"));
    const datedPath = path.join(tmp, "dated.json");
    const discoveredPath = path.join(tmp, "discovered.json");
    writeFileSync(datedPath, JSON.stringify({ changes: [controlChange(), fixtureChange("vendor_page")] }, null, 2));
    writeFileSync(discoveredPath, JSON.stringify({ changes: [controlChange(), fixtureChange("discovered")] }, null, 2));
    const dated = await start(datedPath);
    const discovered = await start(discoveredPath);
    datedProc = dated.proc;
    datedPort = dated.port;
    discoveredProc = discovered.proc;
    discoveredPort = discovered.port;
  });

  after(() => {
    if (datedProc) datedProc.kill();
    if (discoveredProc) discoveredProc.kill();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  async function bodies(route: string) {
    const [a, b] = await Promise.all([
      fetch(`http://localhost:${datedPort}${route}`),
      fetch(`http://localhost:${discoveredPort}${route}`),
    ]);
    return { dated: await a.text(), discovered: await b.text(), status: [a.status, b.status] };
  }

  it("serves the fixture entry on the surfaces under test", async () => {
    let mentioning = 0;
    for (const route of CHANGE_SURFACES) {
      const { dated } = await bodies(route);
      if (dated.includes(SUBJECT)) mentioning += 1;
    }
    assert.ok(
      mentioning >= 5,
      `only ${mentioning} of ${CHANGE_SURFACES.length} surfaces rendered the fixture — the sweep below would prove nothing`
    );
  });

  it("renders differently when the same entry carries only a discovery date", async () => {
    const absorbed: string[] = [];
    for (const route of CHANGE_SURFACES) {
      const { dated, discovered } = await bodies(route);
      if (!dated.includes(SUBJECT)) continue;
      if (dated === discovered) absorbed.push(route);
    }
    assert.deepStrictEqual(
      absorbed,
      [],
      `these surfaces show the entry but render a discovery date identically to an effective date: ${absorbed.join(", ")}`
    );
  });

  it("keeps the discovery out of every month group and off the upcoming list", async () => {
    const renderedBadge = /<div class="(chg|pc)-upcoming-badge">/;
    for (const route of ["/changes", "/pricing-changes"]) {
      const { dated, discovered } = await bodies(route);
      assert.ok(
        renderedBadge.test(dated),
        `${route} did not mark the dated control as upcoming, so the check below would pass for the wrong reason`
      );
      assert.ok(discovered.includes(undatedGroupHeading(1)), `${route} has no undated group`);
      assert.ok(!renderedBadge.test(discovered), `${route} marked a discovery as upcoming`);
    }
  });

  it("never puts the discovery inside a calendar month", async () => {
    for (const [route, prefix] of [["/changes", "chg"], ["/pricing-changes", "pc"]] as const) {
      const { dated, discovered } = await bodies(route);
      const monthsOf = (html: string) => regionFrom(html, '<div class="month-group">');
      assert.ok(
        countEntriesFor(monthsOf(discovered), prefix, CONTROL) >= 1,
        `${route} rendered no dated entry in a month group, so the absence below proves nothing`
      );
      assert.strictEqual(
        countEntriesFor(monthsOf(dated), prefix, SUBJECT) >= 1,
        true,
        `${route} should put the dated control in a month group`
      );
      assert.strictEqual(
        countEntriesFor(monthsOf(discovered), prefix, SUBJECT),
        0,
        `${route} put a change with no known effective date into a calendar month`
      );
    }
  });

  it("never lists the discovery among changes that recently took effect", async () => {
    const { dated, discovered } = await bodies("/expiring");
    const recentOf = (html: string) =>
      regionFrom(html, "<h2>Recently Changed</h2>", "<h2>Recently Discovered</h2>");
    assert.ok(
      countEntriesFor(recentOf(dated), "exp", CONTROL) >= 1,
      "/expiring listed nothing under Recently Changed, so the absence below proves nothing"
    );
    assert.strictEqual(
      countEntriesFor(recentOf(discovered), "exp", SUBJECT),
      0,
      "/expiring listed a change with no known effective date as having recently changed"
    );
    assert.ok(
      discovered.includes("<h2>Recently Discovered</h2>"),
      "/expiring dropped the discovery instead of listing it separately"
    );
  });

  it("leaves the Last 30 Days tile counting only changes that took effect in the window", async () => {
    const { dated, discovered } = await bodies("/changes");
    assert.strictEqual(last30DaysTile(dated), 2, "both fixture changes fall inside the window when both are dated");
    assert.strictEqual(
      last30DaysTile(discovered),
      1,
      "a change with no known effective date was counted as having taken effect in the last 30 days"
    );
  });

  it("says on the page how many entries it could not date", async () => {
    const { dated, discovered } = await bodies("/changes");
    assert.ok(!dated.includes("Effective Date Unknown"), "the dated control should show no such tile");
    assert.ok(discovered.includes("Effective Date Unknown"), "/changes hid the undateable count");
    assert.ok(discovered.includes(UNDATED_GROUP_NOTE), "/changes dropped the note explaining the group");
  });

  it("keeps the discovery out of the monthly report it would otherwise land in", async () => {
    const { dated, discovered } = await bodies(`/reports/${TODAY.slice(0, 7)}`);
    assert.ok(dated.includes(SUBJECT), "the dated control should appear in this month's report");
    assert.ok(discovered.includes(CONTROL), "the report did not render at all, so the absence below proves nothing");
    assert.ok(!discovered.includes(SUBJECT), "a change with no known effective date was counted in a monthly report");
  });

  it("does not publish a discovery date as datePublished in structured data", async () => {
    for (const route of ["/", "/changes", "/expiring"]) {
      const { dated, discovered } = await bodies(route);
      assert.strictEqual(
        structuredItemFor(dated, SUBJECT)?.datePublished,
        TODAY,
        `${route} carries no structured item for the entry when its date is an effective date, so the check below proves nothing`
      );
      const item = structuredItemFor(discovered, SUBJECT);
      assert.ok(item, `${route} dropped the entry from its structured data rather than listing it undated`);
      assert.ok(
        !("datePublished" in item!),
        `${route} published a discovery date as datePublished`
      );
    }
  });

  it("hands agents the provenance alongside the date", async () => {
    const res = await fetch(`http://localhost:${discoveredPort}/api/changes`);
    const body = (await res.json()) as any;
    const entry = body.changes.find((c: any) => c.vendor === SUBJECT);
    assert.ok(entry, "the API dropped the entry");
    assert.strictEqual(entry.date_source, "discovered");
  });

  it("counts the discovery separately from changes that took effect in the window", async () => {
    const datedRes = await (await fetch(`http://localhost:${datedPort}/api/changes`)).json() as any;
    const discoveredRes = await (await fetch(`http://localhost:${discoveredPort}/api/changes`)).json() as any;
    assert.strictEqual(datedRes.change_log_freshness.discovered_date_total, 0);
    assert.strictEqual(discoveredRes.change_log_freshness.discovered_date_total, 1);
  });

  it("does not turn a discovery into a deadline in the agent digest", async () => {
    const body = (await (await fetch(`http://localhost:${discoveredPort}/api/digest`)).json()) as any;
    const deadlines = body.upcoming_deadlines ?? [];
    assert.ok(
      !deadlines.some((d: any) => d.vendor === SUBJECT),
      "a change with no known effective date was published as an upcoming deadline"
    );
  });
});

describe("capping a list built from several sections", () => {
  const big = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  it("keeps every section in the order the page renders them when everything fits", () => {
    assert.deepStrictEqual(capListSections([["a"], ["b", "c"], ["d"]], 50), ["a", "b", "c", "d"]);
  });

  it("leaves no non-empty section unrepresented once the cap bites", () => {
    const capped = capListSections([big("up", 60), big("recent", 40), ["discovery"]], 50);
    assert.strictEqual(capped.length, 50);
    assert.ok(capped.includes("recent0"), "a whole section was crowded out of the capped list");
    assert.ok(capped.includes("discovery"), "the last section was crowded out of the capped list");
  });

  it("skips empty sections rather than reserving them a slot", () => {
    assert.deepStrictEqual(capListSections([["a", "b"], [], ["c"]], 2), ["a", "c"]);
  });

  it("spends the whole cap when the sections fit inside it exactly", () => {
    assert.deepStrictEqual(capListSections([["a", "b"], ["c", "d"]], 4), ["a", "b", "c", "d"]);
  });

  it("fills the earlier sections first with whatever the reservations leave", () => {
    assert.deepStrictEqual(capListSections([big("up", 5), big("recent", 5)], 4), ["up0", "up1", "up2", "recent0"]);
  });
});

describe("feed entry updated timestamps", () => {
  it("never stamps an entry later than the moment the feed is built", () => {
    const now = new Date("2026-08-28T01:03:00Z");
    assert.strictEqual(feedEntryUpdated("2026-08-28", now), "2026-08-28T01:03:00.000Z");
  });

  it("still stamps noon for a day that is already over", () => {
    const now = new Date("2026-08-28T01:03:00Z");
    assert.strictEqual(feedEntryUpdated("2026-08-27", now), "2026-08-27T12:00:00.000Z");
  });

  it("stamps noon once the day's noon has passed", () => {
    const now = new Date("2026-08-28T18:00:00Z");
    assert.strictEqual(feedEntryUpdated("2026-08-28", now), "2026-08-28T12:00:00.000Z");
  });

  it("falls back to now when the day is not a date", () => {
    const now = new Date("2026-08-28T01:03:00Z");
    assert.strictEqual(feedEntryUpdated("not-a-date", now), "2026-08-28T01:03:00.000Z");
  });
});

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { assertPopulationFloor } from "./population-floor.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { monthlyChangeSeries, groupByMonth, discoveryMonthSeriesHeading } from "../dist/change-dates.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const EVENT_DATED = ["vendor_page", "hand_written"];

const MONTHS_IN_A_QUARTER = 3;

const INJECTED_MONTH = "2026-02";
const INJECTED_DATE = `${INJECTED_MONTH}-15`;
const INJECTED_COUNT = 40;

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const DISCOVERY_SERIES_LEAD = discoveryMonthSeriesHeading(1).split(" (")[0];

interface StoredChange {
  vendor: string;
  date: string;
  date_source: string;
  change_type: string;
  impact: string;
  summary: string;
  category?: string;
  resolution?: { state: string } | null;
}

function storedChanges(): StoredChange[] {
  const raw = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8"));
  return Array.isArray(raw) ? raw : raw.changes;
}

function injectedChange(n: number): StoredChange {
  return {
    vendor: `Fixture Vendor ${n}`,
    change_type: "limits_reduced",
    date: INJECTED_DATE,
    date_source: "discovered",
    summary: "Free storage allowance differs from what we had stored.",
    impact: "low",
    category: "Databases",
    ...({ source_url: "https://example.com/pricing", alternatives: [], recorded_date: INJECTED_DATE, detected_by: "reverify-ai" } as Record<string, unknown>),
  } as StoredChange;
}

function startServer(changesPath?: string): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: "0",
        BASE_URL: "http://localhost:3000",
        ...(changesPath ? { AGENTDEALS_CHANGES_PATH: changesPath } : {}),
      },
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Server startup timeout"));
    }, 60000);
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

function monthKeyFromHeading(heading: string): string | null {
  const m = heading.match(/^(\w+) (\d{4})$/);
  if (!m) return null;
  const index = MONTH_NAMES.indexOf(m[1]);
  if (index < 0) return null;
  return `${m[2]}-${String(index + 1).padStart(2, "0")}`;
}

function changeLogMonths(body: string): Map<string, number> {
  const months = new Map<string, number>();
  for (const group of body.split(/<h2 class="month-heading">/).slice(1)) {
    const heading = group.slice(0, group.indexOf("<"));
    const key = monthKeyFromHeading(heading);
    if (!key) continue;
    const entries = [...group.matchAll(/<div class="(chg-entry[^"]*)"/g)];
    months.set(key, entries.filter(([, classes]) => !classes.includes("chg-resolved")).length);
  }
  return months;
}

function renderedSeries(body: string, series: string): Map<string, number> {
  const months = new Map<string, number>();
  for (const element of body.matchAll(/<[a-z]+[^>]*\sdata-month="[^"]*"[^>]*>/g)) {
    const tag = element[0];
    const attribute = (name: string) => tag.match(new RegExp(`\\sdata-${name}="([^"]*)"`))?.[1];
    if (attribute("series") !== series) continue;
    months.set(attribute("month")!, parseInt(attribute("count")!, 10));
  }
  return months;
}

function sectionText(body: string, opening: string, closing: RegExp): string {
  const start = body.indexOf(opening);
  assert.notStrictEqual(start, -1, `section ${JSON.stringify(opening)} is not on the page`);
  const rest = body.slice(start + opening.length);
  const end = rest.search(closing);
  return (end < 0 ? rest : rest.slice(0, end))
    .replace(/<[^>]+>/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&rsquo;/g, "’")
    .replace(/\s+/g, " ");
}

const SURFACES = [
  { route: "/state-of-free-tiers", name: "the Monthly Pricing Change Trend chart" },
  { route: "/free-tier-risk", name: "the Changes by Month card" },
];

describe("the month a change is counted in", () => {
  it("puts a record in the effective series only when its date is the date the terms changed", () => {
    const changes = storedChanges();
    const { effective, discovered } = monthlyChangeSeries(changes as never);

    const expectedEffective = new Map<string, number>();
    const expectedDiscovered = new Map<string, number>();
    for (const c of changes) {
      const bucket = EVENT_DATED.includes(c.date_source) ? expectedEffective : expectedDiscovered;
      bucket.set(c.date.slice(0, 7), (bucket.get(c.date.slice(0, 7)) ?? 0) + 1);
    }

    assertPopulationFloor(expectedEffective.size, 12, "months holding a change dated by its own terms");
    assertPopulationFloor(expectedDiscovered.size, 1, "months holding a change dated by discovery");

    for (const [month, records] of effective) {
      assert.strictEqual(records.length, expectedEffective.get(month) ?? 0, month);
    }
    for (const [month, records] of discovered) {
      assert.strictEqual(records.length, expectedDiscovered.get(month) ?? 0, month);
    }
    assert.deepStrictEqual([...effective.keys()].sort(), [...expectedEffective.keys()].sort());
    assert.deepStrictEqual([...discovered.keys()].sort(), [...expectedDiscovered.keys()].sort());
  });

  it("keeps the months in ascending order so a series reads left to right", () => {
    const months = [...groupByMonth(storedChanges() as never).keys()];
    assert.deepStrictEqual(months, [...months].sort());
  });
});

describe("every surface that bins changes by month", () => {
  const servers: ChildProcess[] = [];
  let tmp = "";
  let live = 0;
  let injected = 0;

  before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "monthly-change-series-"));
    const withBatch = [
      ...storedChanges(),
      ...Array.from({ length: INJECTED_COUNT }, (_, i) => injectedChange(i)),
    ];
    const fixture = path.join(tmp, "with-discovery-batch.json");
    writeFileSync(fixture, JSON.stringify({ changes: withBatch }));

    const [a, b] = await Promise.all([startServer(), startServer(fixture)]);
    servers.push(a.proc, b.proc);
    live = a.port;
    injected = b.port;
  });

  after(() => {
    for (const proc of servers) proc.kill();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  async function body(port: number, route: string): Promise<string> {
    const res = await fetch(`http://localhost:${port}${route}`);
    assert.strictEqual(res.status, 200, route);
    return res.text();
  }

  it("counts the same changes into a month as the change log does", async () => {
    const expected = changeLogMonths(await body(live, "/changes"));
    assertPopulationFloor(expected.size, 12, "months the change log groups by");
    assertPopulationFloor(
      [...expected.values()].reduce((a, b) => a + b, 0),
      200,
      "changes the change log groups into a month"
    );

    for (const surface of SURFACES) {
      const rendered = renderedSeries(await body(live, surface.route), "effective");
      assert.deepStrictEqual(
        Object.fromEntries([...rendered].sort()),
        Object.fromEntries([...expected].sort()),
        `${surface.name} disagrees with the change log about which changes took effect in which month`
      );
    }
  });

  it("counts into a quarter report only the changes whose terms took effect in it", async () => {
    const expected = changeLogMonths(await body(live, "/changes"));
    const quarter = new Map([...expected].filter(([m]) => m >= "2026-01" && m <= "2026-03"));
    assert.ok(
      quarter.size >= 2 && quarter.size <= MONTHS_IN_A_QUARTER,
      `the quarter the report covers holds changes in ${quarter.size} months, of the ${MONTHS_IN_A_QUARTER} a quarter has`,
    );

    const rendered = renderedSeries(await body(live, "/q1-2026-developer-pricing-report"), "effective");
    assert.deepStrictEqual(Object.fromEntries([...rendered].sort()), Object.fromEntries([...quarter].sort()));
  });

  it("does not move a month when a batch of pages is read and none of them says when it changed", async () => {
    const routes = [...SURFACES.map(s => s.route), "/q1-2026-developer-pricing-report", "/changes"];
    const everyMonth = changeLogMonths(await body(live, "/changes")).size;
    for (const route of routes) {
      const control = await body(live, route);
      const after = await body(injected, route);
      const [before, later] = route === "/changes"
        ? [changeLogMonths(control), changeLogMonths(after)]
        : [renderedSeries(control, "effective"), renderedSeries(after, "effective")];
      assert.ok(
        before.size >= 2 && before.size <= everyMonth,
        `${route} bins changes into ${before.size} months, of the ${everyMonth} the change log holds`,
      );
      assert.deepStrictEqual(
        Object.fromEntries([...later].sort()),
        Object.fromEntries([...before].sort()),
        `${route} counted a discovery batch into the month we read it`
      );
    }
  });

  it("shows the discovery batch under a label saying the date is when we read the page", async () => {
    for (const surface of SURFACES) {
      const control = renderedSeries(await body(live, surface.route), "discovered");
      const after = renderedSeries(await body(injected, surface.route), "discovered");
      assert.strictEqual(
        (after.get(INJECTED_MONTH) ?? 0) - (control.get(INJECTED_MONTH) ?? 0),
        INJECTED_COUNT,
        `${surface.name} did not show the batch as pages read in ${INJECTED_MONTH}`
      );

      const page = await body(injected, surface.route);
      const start = page.indexOf(DISCOVERY_SERIES_LEAD);
      assert.notStrictEqual(start, -1, `${surface.name} does not head the batch as changes found by reading a page`);
      const lead = page.slice(start, page.indexOf("data-series=\"discovered\"", start));
      assert.ok(
        /the month we read the page/.test(lead),
        `${surface.name} shows a discovery month without saying the date is when we read the page: ${lead.replace(/<[^>]+>/g, " ")}`
      );
    }
  });

  it("states a period comparison in figures taken from the records", async () => {
    const eventDated = storedChanges().filter(c => EVENT_DATED.includes(c.date_source) && !c.resolution);
    const inWindow = (start: string, end: string) =>
      eventDated.filter(c => c.date >= start && c.date <= end).length;
    const quarter = inWindow("2026-01-01", "2026-03-31");
    const half = inWindow("2025-07-01", "2025-12-31");
    assertPopulationFloor(quarter, 10, "changes whose terms took effect in the quarter compared");

    const text = sectionText(await body(live, "/free-tier-risk"), "Changes by Month", /<\/div>/);
    assert.ok(
      text.includes(`Q1 2026 holds ${quarter} `),
      `the comparison does not state the ${quarter} the records hold: ${text.slice(-260)}`
    );
    assert.ok(
      text.includes(`against ${half} in the second half of 2025`),
      `the comparison does not state the ${half} the records hold: ${text.slice(-260)}`
    );

    const moved = sectionText(await body(injected, "/free-tier-risk"), "Changes by Month", /<\/div>/);
    assert.ok(
      moved.includes(`Q1 2026 holds ${quarter} `),
      "a discovery batch dated inside the quarter moved the figure the comparison states"
    );
  });

  it("claims no rate or direction over a month series", async () => {
    const sections = [
      { route: "/state-of-free-tiers", opening: "<h2>Monthly Pricing Change Trend</h2>", closing: /<h2/ },
      { route: "/free-tier-risk", opening: "Changes by Month", closing: /<\/div>/ },
    ];
    for (const section of sections) {
      const text = sectionText(await body(live, section.route), section.opening, section.closing);
      assertPopulationFloor(text.length, 200, `characters of prose around the ${section.route} month series`);
      assert.ok(!/accelerat|the pace/i.test(text), `${section.route} states a rate over a month series: ${text}`);
    }
  });
});

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDailyRollup,
  parseRollup,
  readRollups,
  readRollupCoverage,
  coverageOf,
  writeRollup,
  ROLLUP_EXCLUSIONS,
  ROLLUP_SCHEMA_VERSION,
} from "../src/analytics-rollup.ts";
import type { RollupDaySource } from "../src/stats.ts";

function sourceFor(date: string, overrides: Partial<RollupDaySource> = {}): RollupDaySource {
  return {
    date,
    page_views: { served: 0, not_found: 0, redirects: 0, unclassified_legacy: 0, by_route: {} },
    referrers: {},
    classes: {},
    class_routes: {},
    families: {},
    mcp_tool_calls: 0,
    not_found: {},
    redirects: {},
    signals: {
      total: 0,
      by_event: {},
      by_transport: {},
      by_client_class: {},
      by_source: {},
      by_reporting_agent: {},
      by_vendor: {},
      unresolved_vendor_names: {},
      unrecognized_events: {},
    },
    available: true,
    reason: null,
    ...overrides,
  };
}

const POPULATED = sourceFor("2026-08-20", {
  page_views: {
    served: 180,
    not_found: 17,
    redirects: 9,
    unclassified_legacy: 30,
    by_route: { "/vendor/:slug": 100, "/search": 50, "/": 30 },
  },
  referrers: { "news.ycombinator.com": 12, "google.com": 40 },
  classes: { ai_agent: 30, browser: 120, seo_crawler: 30 },
  class_routes: { "ai_agent|/vendor/:slug": 25, "browser|/search": 40 },
  families: { claude: 20, gptbot: 10 },
  mcp_tool_calls: 77,
  not_found: { other_bot: 17 },
  redirects: { browser: 9 },
  signals: {
    total: 6,
    by_event: { recommended: 5, converted: 1 },
    by_transport: { post: 6 },
    by_client_class: { ai_agent: 6 },
    by_source: { "/vendor/:slug": 4 },
    by_reporting_agent: { "some-agent": 6 },
    by_vendor: { "recommended:neon": 3, "recommended:supabase": 2, "converted:neon": 1 },
    unresolved_vendor_names: { "a vendor we do not carry": 2 },
    unrecognized_events: { "some-unlisted-event": 1 },
  },
});

describe("daily analytics rollup", () => {
  it("keeps served, not-found and redirect counts apart from each other", () => {
    const rollup = buildDailyRollup(POPULATED, "2026-08-21T04:30:00.000Z");
    assert.equal(rollup.page_views.served, 180);
    assert.equal(rollup.page_views.not_found, 17);
    assert.equal(rollup.page_views.redirects, 9);
    assert.equal(rollup.page_views.unclassified_legacy, 30);
  });

  it("carries every route, not only the ones a top-N list would show", () => {
    const by_route: Record<string, number> = {};
    for (let i = 0; i < 120; i++) by_route[`/route-${i}`] = 120 - i;
    const wide = sourceFor("2026-08-20", {
      page_views: { served: 7260, not_found: 0, redirects: 0, unclassified_legacy: 0, by_route },
    });
    const rollup = buildDailyRollup(wide, "2026-08-21T00:00:00.000Z");
    assert.equal(Object.keys(rollup.page_views.by_route).length, 120);
  });

  it("summarizes signals by event, transport, class, source and reporting agent", () => {
    const { signals } = buildDailyRollup(POPULATED, "2026-08-21T04:30:00.000Z");
    assert.equal(signals.total, 6);
    assert.deepEqual(signals.by_event, { recommended: 5, converted: 1 });
    assert.deepEqual(signals.by_transport, { post: 6 });
    assert.deepEqual(signals.by_client_class, { ai_agent: 6 });
    assert.deepEqual(signals.by_source, { "/vendor/:slug": 4 });
    assert.deepEqual(signals.by_reporting_agent, { "some-agent": 6 });
  });

  it("records how many vendor keys existed without recording which vendors", () => {
    const rollup = buildDailyRollup(POPULATED, "2026-08-21T04:30:00.000Z");
    assert.equal(rollup.signals.vendor_key_count, 3);
    assert.equal(rollup.vendors, null);
    const serialized = JSON.stringify(rollup);
    for (const slug of ["neon", "supabase"]) {
      assert.ok(!serialized.includes(slug), `vendor slug ${slug} must not reach the artifact`);
    }
  });

  it("counts caller-supplied strings without transcribing them", () => {
    const rollup = buildDailyRollup(POPULATED, "2026-08-21T04:30:00.000Z");
    assert.equal(rollup.signals.unresolved_vendor_name_count, 1);
    assert.equal(rollup.signals.unrecognized_event_count, 1);
    const serialized = JSON.stringify(rollup);
    assert.ok(!serialized.includes("a vendor we do not carry"));
    assert.ok(!serialized.includes("some-unlisted-event"));
  });

  it("states what it deliberately leaves out", () => {
    const rollup = buildDailyRollup(POPULATED, "2026-08-21T04:30:00.000Z");
    assert.deepEqual(rollup.excluded, ROLLUP_EXCLUSIONS);
    assert.ok(ROLLUP_EXCLUSIONS.length > 0);
  });

  it("marks a same-day rollup incomplete and a past day final", () => {
    const sameDay = buildDailyRollup(sourceFor("2026-08-21"), "2026-08-21T12:00:00.000Z");
    const pastDay = buildDailyRollup(sourceFor("2026-08-20"), "2026-08-21T00:00:00.000Z");
    assert.equal(sameDay.complete, false);
    assert.equal(pastDay.complete, true);
  });

  it("carries traffic, referrers and MCP calls through unchanged", () => {
    const rollup = buildDailyRollup(POPULATED, "2026-08-21T04:30:00.000Z");
    assert.deepEqual(rollup.traffic.by_class, { browser: 120, ai_agent: 30, seo_crawler: 30 });
    assert.deepEqual(rollup.traffic.ai_agent_families, { claude: 20, gptbot: 10 });
    assert.deepEqual(rollup.traffic.by_class_route, { "browser|/search": 40, "ai_agent|/vendor/:slug": 25 });
    assert.deepEqual(rollup.traffic.not_found_by_class, { other_bot: 17 });
    assert.deepEqual(rollup.traffic.redirects_by_class, { browser: 9 });
    assert.deepEqual(rollup.referrers, { "google.com": 40, "news.ycombinator.com": 12 });
    assert.equal(rollup.mcp_tool_calls, 77);
  });

  it("round-trips through JSON without losing a field", () => {
    const rollup = buildDailyRollup(POPULATED, "2026-08-21T04:30:00.000Z");
    const back = parseRollup(JSON.parse(JSON.stringify(rollup)));
    assert.deepEqual(back, rollup);
  });

  it("refuses a payload with no usable date", () => {
    assert.equal(parseRollup(null), null);
    assert.equal(parseRollup({}), null);
    assert.equal(parseRollup({ date: "not-a-date" }), null);
    assert.equal(parseRollup({ date: "2026-8-1" }), null);
  });
});

describe("rollup files on disk", () => {
  function withTempDir(run: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "rollup-"));
    try {
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("reads back what it wrote", () => {
    withTempDir(dir => {
      const rollup = buildDailyRollup(POPULATED, "2026-08-21T04:30:00.000Z");
      const path = writeRollup(dir, rollup);
      assert.ok(path.endsWith("2026-08-20.json"));
      const [read] = readRollups(dir);
      assert.deepEqual(read, rollup);
    });
  });

  it("reports coverage across the days present, and names the last complete one", () => {
    withTempDir(dir => {
      writeRollup(dir, buildDailyRollup(sourceFor("2026-08-18"), "2026-08-21T00:00:00.000Z"));
      writeRollup(dir, buildDailyRollup(sourceFor("2026-08-19"), "2026-08-21T00:00:00.000Z"));
      writeRollup(dir, buildDailyRollup(sourceFor("2026-08-21"), "2026-08-21T09:00:00.000Z"));
      const coverage = readRollupCoverage(dir);
      assert.equal(coverage.first_date, "2026-08-18");
      assert.equal(coverage.last_date, "2026-08-21");
      assert.equal(coverage.last_complete_date, "2026-08-19");
      assert.equal(coverage.days, 3);
      assert.equal(coverage.path, dir);
    });
  });

  it("skips files that are not dated rollups instead of failing the whole read", () => {
    withTempDir(dir => {
      writeRollup(dir, buildDailyRollup(sourceFor("2026-08-18"), "2026-08-21T00:00:00.000Z"));
      writeFileSync(join(dir, "README.md"), "not a rollup", "utf-8");
      writeFileSync(join(dir, "notes.json"), "{}", "utf-8");
      writeFileSync(join(dir, "2026-08-19.json"), "{ broken", "utf-8");
      const rollups = readRollups(dir);
      assert.equal(rollups.length, 1);
      assert.equal(rollups[0].date, "2026-08-18");
    });
  });

  it("ignores a stray copy whose body is a valid rollup but whose name is not a date", () => {
    withTempDir(dir => {
      const real = buildDailyRollup(sourceFor("2026-08-18"), "2026-08-21T00:00:00.000Z");
      writeRollup(dir, real);
      writeFileSync(join(dir, "latest.json"), JSON.stringify(real), "utf-8");
      writeFileSync(join(dir, "2026-08-18.json.bak"), JSON.stringify(real), "utf-8");
      const rollups = readRollups(dir);
      assert.equal(rollups.length, 1);
      assert.equal(readRollupCoverage(dir).days, 1);
    });
  });

  it("reports empty coverage for a directory that does not exist", () => {
    const coverage = readRollupCoverage(join(tmpdir(), "rollup-absent-directory"));
    assert.equal(coverage.days, 0);
    assert.equal(coverage.last_date, null);
    assert.equal(coverage.last_complete_date, null);
  });

  it("writes a schema version so a later reader can tell the shape", () => {
    withTempDir(dir => {
      writeRollup(dir, buildDailyRollup(POPULATED, "2026-08-21T04:30:00.000Z"));
      const raw = JSON.parse(readFileSync(join(dir, "2026-08-20.json"), "utf-8"));
      assert.equal(raw.schema, ROLLUP_SCHEMA_VERSION);
    });
  });

  it("computes coverage from the rollups it is given", () => {
    const coverage = coverageOf(
      [
        buildDailyRollup(sourceFor("2026-08-02"), "2026-08-03T00:00:00.000Z"),
        buildDailyRollup(sourceFor("2026-08-01"), "2026-08-03T00:00:00.000Z"),
      ],
      "somewhere",
    );
    assert.equal(coverage.first_date, "2026-08-01");
    assert.equal(coverage.last_date, "2026-08-02");
    assert.equal(coverage.days, 2);
  });
});

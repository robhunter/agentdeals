import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const {
  recordTraffic: recordTrafficRaw,
  normalizePagePath,
  setReservedRouteKeys,
  reservedRoutePathsCovering,
  summarizeClassRouteTruncation,
  getRollupDaySource,
  resetCounters,
  resetTelemetryBuffers,
  resetTelemetryHealth,
  loadTelemetry,
  MAX_CLASS_ROUTE_KEYS_PER_DAY,
  OVERFLOW_PAGE_KEY,
  CLASS_ROUTE_SEP,
  DISCARDED_KEY_OVERFLOW,
} = await import("../dist/stats.js");
const { classifyRequest } = await import("../dist/client-class.js");
const {
  AGENT_OPENS_WINDOW_DAYS,
  HOMEPAGE_GUIDE_COUNT,
  RANKED_TRAFFIC_CLASS,
  agentOpensByPath,
  agentOpensWindow,
  agentRequestAttribution,
  guideSelectionSentence,
  guidesTiedAtCut,
  opensDecidedPrefix,
  rankableDays,
  rankGuidesByAgentOpens,
} = await import("../dist/homepage-routing.js");
const { buildDailyRollup, parseRollup, ROLLUP_DIR } = await import("../dist/analytics-rollup.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const AGENT_UA = "Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)";
const CONTROL_SLUG = "hetzner-pricing-2026";

type Rollup = ReturnType<typeof buildDailyRollup>;

function agentKey(path: string): string {
  return `${RANKED_TRAFFIC_CLASS}${CLASS_ROUTE_SEP}${path}`;
}

function guideEntry(slug: string) {
  return { slug, title: slug, heading: "Answers" };
}

function dayWith(
  date: string,
  byClassRoute: Record<string, number>,
  reservedPaths: string[] = [],
): Rollup {
  return {
    schema: 1,
    date,
    generated_at: `${date}T00:00:00.000Z`,
    complete: true,
    page_views: { served: 0, not_found: 0, redirects: 0, unclassified_legacy: 0, by_route: {} },
    traffic: {
      by_class: {},
      by_class_route: byClassRoute,
      ai_agent_families: {},
      not_found_by_class: {},
      redirects_by_class: {},
      class_route_truncation: reservedPaths.length === 0
        ? null
        : {
          key_cap: MAX_CLASS_ROUTE_KEYS_PER_DAY,
          keys_kept: Object.keys(byClassRoute).length,
          keys_discarded: 0,
          keys_discarded_is_exact: true,
          requests_discarded: 0,
          reserved_paths: [...reservedPaths].sort(),
        },
    },
    mcp_tool_calls: 0,
    referrers: {},
    signals: {
      total: 0,
      by_event: {},
      by_transport: {},
      by_client_class: {},
      by_source: {},
      by_reporting_agent: {},
      unresolved_vendor_name_count: 0,
      unrecognized_event_count: 0,
      vendor_key_count: 0,
    },
    vendors: null,
    excluded: [],
  } as Rollup;
}

const OTHER_SLUGS = Array.from({ length: 25 }, (_, i) => `guide-${String(i).padStart(2, "0")}`);
const POPULATION = [CONTROL_SLUG, ...OTHER_SLUGS].map(guideEntry);
const WINDOW_DATES = Array.from(
  { length: AGENT_OPENS_WINDOW_DAYS },
  (_, i) => `2026-09-${String(i + 7).padStart(2, "0")}`,
);

function everyGuideKeyedFixture(): Rollup[] {
  return WINDOW_DATES.map((date) => {
    const map: Record<string, number> = { [agentKey(`/${CONTROL_SLUG}`)]: 11 };
    for (const slug of OTHER_SLUGS) map[agentKey(`/${slug}`)] = 10;
    return dayWith(date, map);
  });
}

function distinctlyRankedFixture(): Rollup[] {
  return WINDOW_DATES.map((date) => {
    const map: Record<string, number> = { [agentKey(`/${CONTROL_SLUG}`)]: POPULATION.length + 1 };
    OTHER_SLUGS.forEach((slug, i) => { map[agentKey(`/${slug}`)] = POPULATION.length - i; });
    return dayWith(date, map);
  });
}

function controlFoldedOnSixDays(): Rollup[] {
  return everyGuideKeyedFixture().map((day, index) => {
    if (index >= 6) return day;
    const map = { ...day.traffic.by_class_route };
    const folded = map[agentKey(`/${CONTROL_SLUG}`)];
    delete map[agentKey(`/${CONTROL_SLUG}`)];
    map[agentKey(OVERFLOW_PAGE_KEY)] = folded;
    return dayWith(day.date, map);
  });
}

function rankByTotalOverEveryDay(days: readonly Rollup[]): string[] {
  const totals = new Map<string, number>();
  for (const guide of POPULATION) totals.set(guide.slug, 0);
  for (const day of days) {
    for (const [key, count] of Object.entries(day.traffic.by_class_route)) {
      const slug = key.slice(key.indexOf(CLASS_ROUTE_SEP) + 2);
      if (totals.has(slug)) totals.set(slug, totals.get(slug)! + count);
    }
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([slug]) => slug);
}

describe("the homepage guide ranking and the class-route key cap (#1863)", () => {
  describe("AC-1 a day in overflow is not a day with zero opens", () => {
    it("ranks over every day when every guide holds a key on every day", () => {
      const days = everyGuideKeyedFixture();
      const ranked = rankableDays(days, POPULATION, AGENT_OPENS_WINDOW_DAYS);
      assert.equal(ranked.length, AGENT_OPENS_WINDOW_DAYS);

      const selected = rankGuidesByAgentOpens(POPULATION, agentOpensByPath(ranked));
      assert.deepEqual(selected.map((g) => g.slug), rankByTotalOverEveryDay(days));
    });

    it("holds the control's rank when its key is folded into overflow on six of the fourteen days", () => {
      const days = controlFoldedOnSixDays();
      const ranked = rankableDays(days, POPULATION, AGENT_OPENS_WINDOW_DAYS);
      assert.equal(ranked.length, AGENT_OPENS_WINDOW_DAYS - 6);
      assert.ok(
        ranked.every((day) => agentKey(`/${CONTROL_SLUG}`) in day.traffic.by_class_route),
        "a day kept for the ranking must measure the control",
      );

      const selected = rankGuidesByAgentOpens(POPULATION, agentOpensByPath(ranked)).slice(0, HOMEPAGE_GUIDE_COUNT);
      assert.equal(selected[0].slug, CONTROL_SLUG);

      const overEveryDay = rankByTotalOverEveryDay(days);
      assert.ok(
        overEveryDay.indexOf(CONTROL_SLUG) >= HOMEPAGE_GUIDE_COUNT,
        `summing every day drops ${CONTROL_SLUG} out of the top ${HOMEPAGE_GUIDE_COUNT}; it ranked ${overEveryDay.indexOf(CONTROL_SLUG) + 1}`,
      );
    });

    it("counts a day with no overflow even where a guide holds no key", () => {
      const quiet = dayWith("2026-09-21", { [agentKey(`/${CONTROL_SLUG}`)]: 4 });
      assert.deepEqual(rankableDays([quiet], POPULATION, AGENT_OPENS_WINDOW_DAYS), [quiet]);
    });

    it("counts a day that overflowed but kept a key for every guide, with nothing reserved", () => {
      const map: Record<string, number> = { [agentKey(OVERFLOW_PAGE_KEY)]: 900 };
      for (const guide of POPULATION) map[agentKey(`/${guide.slug}`)] = 3;
      const day = dayWith("2026-09-21", map);
      assert.equal(day.traffic.class_route_truncation, null);
      assert.deepEqual(rankableDays([day], POPULATION, AGENT_OPENS_WINDOW_DAYS), [day]);

      const withoutOne = { ...map };
      delete withoutOne[agentKey(`/${POPULATION[1].slug}`)];
      assert.deepEqual(
        rankableDays([dayWith("2026-09-21", withoutOne)], POPULATION, AGENT_OPENS_WINDOW_DAYS),
        [],
      );
    });

    it("counts a day whose reserved paths cover the population even where a guide holds no key", () => {
      const reserved = dayWith(
        "2026-09-21",
        { [agentKey(`/${CONTROL_SLUG}`)]: 4, [agentKey(OVERFLOW_PAGE_KEY)]: 900 },
        POPULATION.map((g) => `/${g.slug}`),
      );
      assert.deepEqual(rankableDays([reserved], POPULATION, AGENT_OPENS_WINDOW_DAYS), [reserved]);

      const missingOne = dayWith(
        "2026-09-21",
        { [agentKey(`/${CONTROL_SLUG}`)]: 4, [agentKey(OVERFLOW_PAGE_KEY)]: 900 },
        POPULATION.slice(0, -1).map((g) => `/${g.slug}`),
      );
      assert.deepEqual(rankableDays([missingOne], POPULATION, AGENT_OPENS_WINDOW_DAYS), []);
    });
  });

  describe("AC-2 the page does not claim completeness it does not have", () => {
    const published = (days: Rollup[]) =>
      opensDecidedPrefix(rankGuidesByAgentOpens(POPULATION, agentOpensByPath(days)), HOMEPAGE_GUIDE_COUNT);

    const selection = (days: Rollup[], heldDays: number) => {
      const shown = published(days);
      return guideSelectionSentence({
        selectedCount: shown.length,
        populationCount: POPULATION.length,
        heldDays,
        rankedWindow: agentOpensWindow(days, AGENT_OPENS_WINDOW_DAYS),
        attribution: agentRequestAttribution(days),
        opensDecided: shown.length > 0,
      });
    };

    it("claims the ranking and nothing else where every request reached a path of its own", () => {
      const days = distinctlyRankedFixture();
      assert.equal(agentRequestAttribution(days).unattributed, 0);
      assert.match(selection(days, days.length), /Membership is that ranking and nothing else/);
    });

    it("publishes the leader alone on a fixture whose guides all tie below it", () => {
      const days = everyGuideKeyedFixture();
      assert.equal(agentRequestAttribution(days).unattributed, 0);
      const shown = published(days);
      assert.equal(shown.length, 1);
      assert.equal(guidesTiedAtCut(
        rankGuidesByAgentOpens(POPULATION, agentOpensByPath(days)),
        shown.length,
      ), 0);
      const sentence = selection(days, days.length);
      assert.match(sentence, new RegExp(`The 1 of ${POPULATION.length} guides AI agents opened most`));
      assert.match(sentence, /Membership is that ranking and nothing else/);
      assert.doesNotMatch(sentence, /tie on opens/);
    });

    it("states the share that reached no path where any request did not", () => {
      const days = everyGuideKeyedFixture();
      days[0] = dayWith(days[0].date, {
        ...days[0].traffic.by_class_route,
        [agentKey(OVERFLOW_PAGE_KEY)]: 100,
      });
      const attribution = agentRequestAttribution(days);
      assert.equal(attribution.unattributed, 100);

      const sentence = selection(days, days.length);
      assert.doesNotMatch(sentence, /and nothing else/);
      assert.ok(
        sentence.includes(`${attribution.unattributed} of ${attribution.total} agent requests`),
        `expected the counts in: ${sentence}`,
      );
      assert.match(sentence, /2\.7%/);
    });

    it("reports a non-zero share too small to round as under a tenth of a percent", () => {
      const days = everyGuideKeyedFixture();
      days[0] = dayWith(days[0].date, {
        ...days[0].traffic.by_class_route,
        [agentKey(OVERFLOW_PAGE_KEY)]: 1,
      });
      const sentence = selection(days, days.length);
      assert.match(sentence, /under 0\.1%/);
      assert.doesNotMatch(sentence, /0\.0%/);
    });

    it("makes no ranking claim where no day in the window can be ranked", () => {
      const days = controlFoldedOnSixDays().slice(0, 6);
      assert.deepEqual(rankableDays(days, POPULATION, AGENT_OPENS_WINDOW_DAYS), []);
      const sentence = guideSelectionSentence({
        selectedCount: POPULATION.length,
        populationCount: POPULATION.length,
        heldDays: days.length,
        rankedWindow: null,
        attribution: agentRequestAttribution([]),
        opensDecided: false,
      });
      assert.doesNotMatch(sentence, /opened most/);
      assert.doesNotMatch(sentence, /and nothing else/);
      assert.match(sentence, /can rank on none of them/);
    });

    it("says only what /guides orders where no traffic is held at all", () => {
      const sentence = guideSelectionSentence({
        selectedCount: POPULATION.length,
        populationCount: POPULATION.length,
        heldDays: 0,
        rankedWindow: null,
        attribution: agentRequestAttribution([]),
        opensDecided: false,
      });
      assert.equal(sentence, `All ${POPULATION.length} guides we publish, in the order /guides lists them.`);
    });
  });

  describe("AC-3 the truncation is readable without reading the source", () => {
    it("counts the keys the cap discarded and the requests they carried", () => {
      const kept = { [agentKey("/a")]: 5, [agentKey(OVERFLOW_PAGE_KEY)]: 40 };
      const discards = { [agentKey("/b")]: 15, [agentKey("/c")]: 25 };
      const truncation = summarizeClassRouteTruncation(kept, discards, ["/a"]);
      assert.equal(truncation.keys_kept, 1);
      assert.equal(truncation.keys_discarded, 2);
      assert.equal(truncation.keys_discarded_is_exact, true);
      assert.equal(truncation.requests_discarded, 40);
      assert.deepEqual(truncation.reserved_paths, ["/a"]);
    });

    it("refuses to call the discarded-key count exact once its own tracker saturates", () => {
      const truncation = summarizeClassRouteTruncation(
        { [agentKey(OVERFLOW_PAGE_KEY)]: 301 },
        { [agentKey("/b")]: 1, [DISCARDED_KEY_OVERFLOW]: 300 },
        [],
      );
      assert.equal(truncation.keys_discarded_is_exact, false);
      assert.equal(truncation.keys_discarded, 1);
      assert.equal(truncation.requests_discarded, 301);
    });

    it("carries the block through the rollup it builds and the rollup it reads back", () => {
      const source = getRollupDaySource("2026-09-21");
      const built = buildDailyRollup({
        ...source,
        class_route_truncation: summarizeClassRouteTruncation(
          { [agentKey("/a")]: 5, [agentKey(OVERFLOW_PAGE_KEY)]: 7 },
          { [agentKey("/b")]: 7 },
          ["/a"],
        ),
      }, "2026-09-22T00:00:00.000Z");
      const round = parseRollup(JSON.parse(JSON.stringify(built)));
      assert.deepEqual(round?.traffic.class_route_truncation, built.traffic.class_route_truncation);
    });

    it("reads a rollup written before the block existed as no measurement rather than a zero", () => {
      const legacy = parseRollup({ date: "2026-09-01", traffic: { by_class_route: {} } });
      assert.equal(legacy?.traffic.class_route_truncation, null);
    });

    it("#1877 summarises a day with no key-level record as no measurement rather than a zero", () => {
      const truncation = summarizeClassRouteTruncation(
        { [agentKey("/a")]: 5, [agentKey(OVERFLOW_PAGE_KEY)]: 20785 },
        {},
        [],
      );
      assert.equal(truncation.keys_discarded, null);
      assert.equal(truncation.keys_discarded_is_exact, false);
      assert.equal(truncation.requests_discarded, 20785);
    });

    it("#1877 counts a day that discarded nothing as a measured zero, not as an absence", () => {
      const truncation = summarizeClassRouteTruncation({ [agentKey("/a")]: 5 }, {}, []);
      assert.equal(truncation.keys_discarded, 0);
      assert.equal(truncation.keys_discarded_is_exact, true);
      assert.equal(truncation.requests_discarded, 0);
    });

    it("#1877 calls the key count a lower bound where the record covers part of the day", () => {
      const truncation = summarizeClassRouteTruncation(
        { [agentKey(OVERFLOW_PAGE_KEY)]: 8994 },
        { [agentKey("/b")]: 2803 },
        [],
      );
      assert.equal(truncation.requests_discarded, 8994);
      assert.equal(truncation.keys_discarded, 1);
      assert.equal(truncation.keys_discarded_is_exact, false);
    });

    it("#1877 reads a stored null key count back as a null and not as a zero", () => {
      const parsed = parseRollup({
        date: "2026-09-20",
        traffic: {
          by_class_route: {},
          class_route_truncation: {
            key_cap: 200,
            keys_kept: 200,
            keys_discarded: null,
            keys_discarded_is_exact: false,
            requests_discarded: 20785,
            reserved_paths: [],
          },
        },
      });
      assert.equal(parsed?.traffic.class_route_truncation?.keys_discarded, null);
      assert.equal(parsed?.traffic.class_route_truncation?.requests_discarded, 20785);
    });

    it("reports no reserved paths for a day the reservation did not cover in full", () => {
      setReservedRouteKeys(["/a", "/b"], [RANKED_TRAFFIC_CLASS]);
      assert.deepEqual(reservedRoutePathsCovering("2026-09-20", "2026-09-20"), []);
      assert.deepEqual(reservedRoutePathsCovering("2026-09-19", "2026-09-20"), []);
      assert.deepEqual(reservedRoutePathsCovering("2026-09-21", "2026-09-20"), ["/a", "/b"]);
      assert.deepEqual(reservedRoutePathsCovering("2026-09-21", ""), []);
      setReservedRouteKeys([], []);
    });
  });

  describe("AC-4 the cap cannot silently re-bind", () => {
    const realFetch = globalThis.fetch;
    let stored = new Map<string, string>();

    beforeEach(async () => {
      process.env.UPSTASH_REDIS_REST_URL = "https://stub.upstash.invalid";
      process.env.UPSTASH_REDIS_REST_TOKEN = "stub-token";
      stored = new Map();
      globalThis.fetch = (async (_url: string, init: { body: string }) => {
        const parsed = JSON.parse(init.body) as unknown[];
        const cmd = String(parsed[0]).toUpperCase();
        const args = parsed.slice(1);
        if (cmd === "SET") stored.set(String(args[0]), String(args[1]));
        const result = cmd === "GET"
          ? (stored.get(String(args[0])) ?? null)
          : cmd === "MGET"
            ? args.map((k) => stored.get(String(k)) ?? null)
            : cmd === "SCAN"
              ? ["0", []]
              : 1;
        return { ok: true, status: 200, json: async () => ({ result }) };
      }) as unknown as typeof fetch;
      resetCounters();
      resetTelemetryBuffers();
      resetTelemetryHealth();
      await loadTelemetry(join(tmpdir(), `guide-cap-${randomUUID()}.json`));
    });

    afterEach(() => {
      globalThis.fetch = realFetch;
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      setReservedRouteKeys([], []);
    });

    it("keeps a key for every reserved guide that took traffic after the cap bound", () => {
      const guides = Array.from({ length: 12 }, (_, i) => `/reserved-guide-${i}`);
      setReservedRouteKeys(guides, [RANKED_TRAFFIC_CLASS]);

      const flood = MAX_CLASS_ROUTE_KEYS_PER_DAY + 50;
      for (let i = 0; i < flood; i++) {
        const path = `/flood${String(i).padStart(4, "0")}`;
        recordTrafficRaw(classifyRequest(path, AGENT_UA), path, 200);
      }
      for (const guide of guides) {
        recordTrafficRaw(classifyRequest(guide, AGENT_UA), guide, 200);
      }

      const today = new Date().toISOString().slice(0, 10);
      const source = getRollupDaySource(today);
      assert.equal(source.available, true);

      for (const guide of guides) {
        assert.ok(
          agentKey(guide) in source.class_routes,
          `${guide} took traffic and must hold its own key, not the overflow bucket`,
        );
        assert.equal(source.class_routes[agentKey(guide)], 1);
      }
      assert.ok(
        source.class_routes[agentKey(OVERFLOW_PAGE_KEY)] > 0,
        "the flood must still bind the cap, or this proves nothing",
      );
      assert.equal(source.class_route_truncation.keys_discarded > 0, true);
      assert.equal(
        source.class_route_truncation.requests_discarded,
        source.class_routes[agentKey(OVERFLOW_PAGE_KEY)],
      );
    });

    it("spends the whole cap on unreserved keys even where reservations came first", () => {
      const guides = Array.from({ length: 12 }, (_, i) => `/reserved-guide-${i}`);
      setReservedRouteKeys(guides, [RANKED_TRAFFIC_CLASS]);
      for (const guide of guides) {
        recordTrafficRaw(classifyRequest(guide, AGENT_UA), guide, 200);
      }

      const flood = MAX_CLASS_ROUTE_KEYS_PER_DAY + 50;
      for (let i = 0; i < flood; i++) {
        const path = `/flood${String(i).padStart(4, "0")}`;
        recordTrafficRaw(classifyRequest(path, AGENT_UA), path, 200);
      }

      const source = getRollupDaySource(new Date().toISOString().slice(0, 10));
      const unreserved = Object.keys(source.class_routes).filter((key) => {
        const path = key.slice(key.indexOf(CLASS_ROUTE_SEP) + 1);
        return path !== OVERFLOW_PAGE_KEY && !guides.includes(path);
      });
      assert.equal(
        unreserved.length,
        MAX_CLASS_ROUTE_KEYS_PER_DAY,
        "reserving a key must not spend the budget the cap holds for everything else",
      );
    });

    it("folds an unreserved path once the cap binds", () => {
      setReservedRouteKeys(["/reserved-only"], [RANKED_TRAFFIC_CLASS]);
      const flood = MAX_CLASS_ROUTE_KEYS_PER_DAY + 10;
      for (let i = 0; i < flood; i++) {
        const path = `/flood${String(i).padStart(4, "0")}`;
        recordTrafficRaw(classifyRequest(path, AGENT_UA), path, 200);
      }
      recordTrafficRaw(classifyRequest("/latecomer", AGENT_UA), "/latecomer", 200);

      const source = getRollupDaySource(new Date().toISOString().slice(0, 10));
      assert.ok(!(agentKey("/latecomer") in source.class_routes));
      assert.ok(agentKey(OVERFLOW_PAGE_KEY) in source.class_routes);
    });

    it("reserves a key only for the class the ranking reads", () => {
      setReservedRouteKeys(["/reserved-guide"], [RANKED_TRAFFIC_CLASS]);
      const flood = MAX_CLASS_ROUTE_KEYS_PER_DAY + 10;
      for (let i = 0; i < flood; i++) {
        const path = `/flood${String(i).padStart(4, "0")}`;
        recordTrafficRaw(classifyRequest(path, "curl/8.5.0"), path, 200);
      }
      recordTrafficRaw(classifyRequest("/reserved-guide", "curl/8.5.0"), "/reserved-guide", 200);

      const source = getRollupDaySource(new Date().toISOString().slice(0, 10));
      assert.ok(!(`sdk_client${CLASS_ROUTE_SEP}/reserved-guide` in source.class_routes));
      recordTrafficRaw(classifyRequest("/reserved-guide", AGENT_UA), "/reserved-guide", 200);
      const after = getRollupDaySource(new Date().toISOString().slice(0, 10));
      assert.ok(agentKey("/reserved-guide") in after.class_routes);
    });
  });

  describe("a reserved path keeps its own key rather than a prefix template", () => {
    afterEach(() => setReservedRouteKeys([], []));

    it("stops collapsing a nested guide path once it is reserved", () => {
      assert.equal(normalizePagePath("/guides/langchain"), "/guides/:slug");
      setReservedRouteKeys(["/guides/langchain"], [RANKED_TRAFFIC_CLASS]);
      assert.equal(normalizePagePath("/guides/langchain"), "/guides/langchain");
      assert.equal(normalizePagePath("/guides/crewai"), "/guides/:slug");
    });

    it("refuses a reserved path that is not a plain lowercase route", () => {
      setReservedRouteKeys(["/Guides/LangChain", "/ok-path", "../escape"], [RANKED_TRAFFIC_CLASS]);
      assert.equal(normalizePagePath("/ok-path"), "/ok-path");
      assert.equal(normalizePagePath("/Guides/LangChain"), "__unmatched__");
    });
  });

  describe("the server reserves the population it ranks", () => {
    let proc: ChildProcess | undefined;
    let history: any;
    let guideCount = 0;

    before(async () => {
      const started = await new Promise<{ proc: ChildProcess; port: number }>((resolve, reject) => {
        const child = spawn("node", [join(REPO, "dist", "serve.js")], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, PORT: "0", BASE_URL: "http://localhost:3000" },
        });
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("Server startup timeout"));
        }, 40000);
        child.stderr!.on("data", (data: Buffer) => {
          const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
          if (m) {
            clearTimeout(timer);
            resolve({ proc: child, port: Number(m[1]) });
          }
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      proc = started.proc;
      history = await (await fetch(`http://localhost:${started.port}/api/analytics/history`)).json();
      const guides = await (await fetch(`http://localhost:${started.port}/guides`)).text();
      guideCount = [...guides.matchAll(/<a href="\/([^"]+)" class="guide-card"/g)].length;
    });

    after(() => proc?.kill());

    it("reserves a key for every guide it publishes, and only for the class it ranks", () => {
      assert.ok(guideCount > 0, "/guides listed no guides, so this proves nothing");
      assert.equal(history.class_route_keys.reserved_paths, guideCount);
      assert.deepEqual(history.class_route_keys.reserved_classes, [RANKED_TRAFFIC_CLASS]);
      assert.equal(history.class_route_keys.cap, MAX_CLASS_ROUTE_KEYS_PER_DAY);
    });

    it("publishes each held day's truncation beside the day it belongs to", () => {
      assert.ok(Array.isArray(history.days) && history.days.length > 0, "no days published");
      for (const day of history.days) {
        assert.ok("class_route_truncation" in day, `${day.date} publishes no truncation field`);
      }
    });
  });

  describe("the rollups on disk", () => {
    it("reads every day written before this change as no truncation measurement", () => {
      const dir = join(REPO, ROLLUP_DIR);
      const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      assert.ok(files.length > 0, "expected daily rollups on disk");
      for (const file of files) {
        const parsed = parseRollup(JSON.parse(readFileSync(join(dir, file), "utf8")));
        assert.ok(parsed, `${file} must parse`);
        const truncation = parsed!.traffic.class_route_truncation;
        if (truncation === null) continue;
        const overflow = Object.entries(parsed!.traffic.by_class_route)
          .filter(([key]) => key.slice(key.indexOf(CLASS_ROUTE_SEP) + 1) === OVERFLOW_PAGE_KEY)
          .reduce((sum, [, count]) => sum + count, 0);
        assert.equal(
          truncation.requests_discarded,
          overflow,
          `${file} reports ${truncation.requests_discarded} requests discarded against ${overflow} in the overflow buckets`,
        );
        assert.notEqual(
          truncation.keys_discarded === 0 && overflow > 0,
          true,
          `${file} counts 0 keys discarded against ${overflow} requests in the overflow buckets, so it states an absence as a zero`,
        );
      }
    });
  });
});

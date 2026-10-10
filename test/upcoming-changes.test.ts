import { describe, it, before } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const { splitAtTheDayServed, UPCOMING_CHANGES_HEADING, UPCOMING_CHANGES_INTRO } = await import("../dist/upcoming-changes.js");

type Change = { vendor: string; date: string; change_type: string; summary: string };

const TODAY = new Date().toISOString().slice(0, 10);
const dayOffset = (days: number) => new Date(Date.parse(TODAY) + days * 86400000).toISOString().slice(0, 10);

const PAGES = [
  { route: "/llm-api-pricing", inEffectAnchor: "changes", shownAtMost: 20, vendor: "OpenAI" },
  { route: "/openai-assistants-alternatives", inEffectAnchor: "openai-timeline", shownAtMost: null, vendor: "OpenAI" },
  { route: "/openai-assistants-migration-2026", inEffectAnchor: "openai-changes", shownAtMost: null, vendor: "OpenAI" },
  { route: "/openai-assistants-migration", inEffectAnchor: "openai-changes", shownAtMost: 10, vendor: "OpenAI" },
  { route: "/shutdowns", inEffectAnchor: "pricing-changes", shownAtMost: 10, vendor: "OpenAI" },
  { route: "/ai-coding-tools-pricing", inEffectAnchor: "changes", shownAtMost: null, vendor: "OpenAI Codex" },
];

function fixture(vendor: string, date: string, change_type: string, summary: string) {
  return {
    vendor,
    change_type,
    date,
    date_source: "vendor_page",
    summary,
    previous_state: "The fixture model is served.",
    current_state: "The fixture model is retired.",
    impact: "medium",
    source_url: "https://example.com/fixture/deprecations",
    category: "AI / ML",
    alternatives: [],
    recorded_date: TODAY,
    ...(change_type === "product_deprecated" ? { listing_effect: "narrows" } : {}),
  };
}

function fixturesFor(vendor: string) {
  return {
    later: fixture(vendor, dayOffset(75), "product_deprecated", `The later ${vendor} fixture model retires.`),
    sooner: fixture(vendor, dayOffset(12), "product_deprecated", `The sooner ${vendor} fixture model retires.`),
    onTheDayServed: fixture(vendor, TODAY, "pricing_restructured", `The ${vendor} fixture price change takes effect on the day served.`),
  };
}

const FIXTURES = new Map([...new Set(PAGES.map((p) => p.vendor))].map((vendor) => [vendor, fixturesFor(vendor)]));
const MORE_THAN_90_DAYS_AWAY = { ...fixture("OpenAI", dayOffset(200), "product_deprecated", "The far-off OpenAI fixture model retires."), what_ends: "The far-off fixture model" };

function escapedLikeThePage(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sectionFrom(html: string, anchor: string): string | null {
  const at = html.search(new RegExp(`<h[23] id="${anchor}"`));
  if (at < 0) return null;
  const rest = html.slice(at + 1);
  const next = rest.search(/<h[23][ >]/);
  return next < 0 ? rest : rest.slice(0, next);
}

function h2SectionFrom(html: string, anchor: string): string | null {
  const at = html.indexOf(`<h2 id="${anchor}">`);
  if (at < 0) return null;
  const next = html.indexOf("<h2", at + 1);
  return next < 0 ? html.slice(at) : html.slice(at, next);
}

function rowCount(section: string): number {
  return (section.split("<tbody>")[1]?.split("</tbody>")[0].match(/<tr>/g) ?? []).length;
}

async function servedPages(changes: unknown[]): Promise<Map<string, string>> {
  const dir = mkdtempSync(path.join(tmpdir(), "upcoming-changes-"));
  const changesPath = path.join(dir, "changes.json");
  writeFileSync(changesPath, JSON.stringify({ changes }));
  const proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_CHANGES_PATH: changesPath },
  });
  try {
    const base = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      proc.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(`http://localhost:${match[1]}`);
        }
      });
      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    const pages = new Map<string, string>();
    for (const { route } of PAGES) {
      const response = await fetch(base + route);
      assert.strictEqual(response.status, 200, `${route} answered ${response.status}`);
      pages.set(route, await response.text());
    }
    return pages;
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

const shipped: Change[] = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes;

describe("splitting a change list at the day served", () => {
  it("keeps a record dated on the day served in effect and lists later records soonest first", () => {
    const newestFirst = [{ date: "2026-11-30" }, { date: "2026-10-14" }, { date: "2026-10-10" }, { date: "2026-09-28" }, { date: "2026-09-28" }];
    const { inEffect, upcoming } = splitAtTheDayServed(newestFirst, "2026-10-10");
    assert.deepStrictEqual(inEffect.map((c: { date: string }) => c.date), ["2026-10-10", "2026-09-28", "2026-09-28"]);
    assert.deepStrictEqual(upcoming.map((c: { date: string }) => c.date), ["2026-10-14", "2026-11-30"]);
  });
});

describe("announced records added to a copy of the change log", () => {
  let pages = new Map<string, string>();

  before(async () => {
    pages = await servedPages([...shipped, ...[...FIXTURES.values()].flatMap((f) => [f.later, f.sooner, f.onTheDayServed]), MORE_THAN_90_DAYS_AWAY]);
  });

  for (const { route, inEffectAnchor, vendor } of PAGES) {
    const { later: LATER, sooner: SOONER, onTheDayServed: ON_THE_DAY_SERVED } = FIXTURES.get(vendor)!;
    it(`${route} lists them under ${UPCOMING_CHANGES_HEADING}, soonest first, and not in its table of changes in effect`, () => {
      const html = pages.get(route)!;
      const upcoming = sectionFrom(html, "upcoming-changes");
      const inEffect = sectionFrom(html, inEffectAnchor);
      assert.ok(upcoming, `${route} prints no ${UPCOMING_CHANGES_HEADING} section`);
      assert.ok(inEffect, `${route} prints no table of changes in effect`);
      assert.ok(upcoming.includes(`>${UPCOMING_CHANGES_HEADING}</h`), `${route}'s section is not headed ${UPCOMING_CHANGES_HEADING}`);
      assert.ok(upcoming.includes(UPCOMING_CHANGES_INTRO), `${route}'s ${UPCOMING_CHANGES_HEADING} section does not open with its intro`);
      const sooner = upcoming.indexOf(SOONER.summary);
      const later = upcoming.indexOf(LATER.summary);
      assert.ok(sooner >= 0 && later >= 0, `${route} leaves an announced change out of ${UPCOMING_CHANGES_HEADING}`);
      assert.ok(sooner < later, `${route} lists the change dated ${LATER.date} before the one dated ${SOONER.date}`);
      for (const announced of [SOONER, LATER]) {
        assert.ok(!inEffect.includes(announced.summary), `${route} lists the change dated ${announced.date} among changes in effect`);
      }
    });

    it(`${route} keeps a change dated on the day served in its table of changes in effect`, () => {
      const html = pages.get(route)!;
      assert.ok(sectionFrom(html, inEffectAnchor)!.includes(ON_THE_DAY_SERVED.summary), `${route} leaves out the change dated ${TODAY}`);
      assert.ok(!sectionFrom(html, "upcoming-changes")!.includes(ON_THE_DAY_SERVED.summary), `${route} lists the change dated ${TODAY} as upcoming`);
    });
  }

  for (const { route, inEffectAnchor, shownAtMost } of PAGES.filter((p) => p.route === "/llm-api-pricing" || p.route === "/shutdowns")) {
    it(`prints no record dated after the day served in ${route}'s table of changes in effect, and still shows ${shownAtMost} rows`, () => {
      const inEffect = sectionFrom(pages.get(route)!, inEffectAnchor)!;
      const announced = [...shipped, ...[...FIXTURES.values()].flatMap((f) => [f.later, f.sooner])].filter((c) => c.date > TODAY);
      assert.ok(announced.length >= 2);
      for (const c of announced) {
        assert.ok(!inEffect.includes(escapedLikeThePage(c.summary)), `${route} lists ${c.vendor}'s change dated ${c.date} among changes in effect`);
      }
      assert.strictEqual(rowCount(inEffect), shownAtMost);
    });
  }

  it("heads /shutdowns' section for shutdowns more than 90 days away Later, and no text there says later this year", () => {
    const html = pages.get("/shutdowns")!;
    const later = h2SectionFrom(html, "later");
    assert.ok(later, "/shutdowns prints no section for shutdowns more than 90 days away");
    assert.ok(later.startsWith('<h2 id="later">Later <span class="section-count">'), `the section is headed: ${later.slice(0, 60)}`);
    assert.ok(later.includes('<p class="section-intro">These shutdowns are more than 90 days away.</p>'), "the section does not open with its intro");
    assert.ok(later.includes(MORE_THAN_90_DAYS_AWAY.what_ends), "the shutdown 200 days out is not in the section");
    assert.ok(html.includes("up to 90 is Upcoming, beyond that is Later."), "the calendar notice does not name the section Later");
    assert.ok(!/later this year/i.test(html), "/shutdowns still says later this year");
  });

  for (const route of ["/llm-api-pricing", "/ai-coding-tools-pricing"]) {
    it(`links the section from ${route}'s list of sections`, () => {
      assert.ok(pages.get(route)!.includes(`<li><a href="#upcoming-changes">${UPCOMING_CHANGES_HEADING}</a></li>`));
    });
  }
});

describe("a copy of the change log with no record dated after the day served", () => {
  let pages = new Map<string, string>();

  before(async () => {
    pages = await servedPages(shipped.filter((c) => c.date <= TODAY));
  });

  for (const { route, inEffectAnchor, shownAtMost } of PAGES) {
    it(`${route} prints no ${UPCOMING_CHANGES_HEADING} section and keeps its table of changes in effect`, () => {
      const html = pages.get(route)!;
      assert.ok(!html.includes('id="upcoming-changes"'), `${route} prints an empty ${UPCOMING_CHANGES_HEADING} section`);
      assert.ok(!html.includes(`>${UPCOMING_CHANGES_HEADING}<`), `${route} names ${UPCOMING_CHANGES_HEADING} with nothing to list`);
      const rows = rowCount(sectionFrom(html, inEffectAnchor)!);
      assert.ok(rows > 0, `${route} prints no changes in effect`);
      if (shownAtMost !== null) assert.ok(rows <= shownAtMost, `${route} prints ${rows} rows, more than ${shownAtMost}`);
    });
  }
});

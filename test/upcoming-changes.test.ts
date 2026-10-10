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
  { route: "/llm-api-pricing", inEffectAnchor: "changes", shownAtMost: 20 },
  { route: "/openai-assistants-alternatives", inEffectAnchor: "openai-timeline", shownAtMost: null },
  { route: "/openai-assistants-migration-2026", inEffectAnchor: "openai-changes", shownAtMost: null },
  { route: "/openai-assistants-migration", inEffectAnchor: "openai-changes", shownAtMost: 10 },
];

function fixture(date: string, change_type: string, summary: string) {
  return {
    vendor: "OpenAI",
    change_type,
    date,
    date_source: "vendor_page",
    summary,
    previous_state: "The fixture model is served.",
    current_state: "The fixture model is retired.",
    impact: "medium",
    source_url: "https://example.com/openai/deprecations",
    category: "AI / ML",
    alternatives: [],
    recorded_date: TODAY,
    ...(change_type === "product_deprecated" ? { listing_effect: "narrows" } : {}),
  };
}

const LATER = fixture(dayOffset(75), "product_deprecated", "The later fixture model retires from the API.");
const SOONER = fixture(dayOffset(12), "product_deprecated", "The sooner fixture model retires from the API.");
const ON_THE_DAY_SERVED = fixture(TODAY, "pricing_restructured", "The fixture price change takes effect on the day served.");

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
    pages = await servedPages([...shipped, LATER, SOONER, ON_THE_DAY_SERVED]);
  });

  for (const { route, inEffectAnchor } of PAGES) {
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

  it("prints no record dated after the day served under Recent Pricing Changes on /llm-api-pricing, and still shows 20 rows", () => {
    const recent = sectionFrom(pages.get("/llm-api-pricing")!, "changes")!;
    const announced = [...shipped, LATER, SOONER].filter((c) => c.date > TODAY);
    assert.ok(announced.length >= 2);
    for (const c of announced) {
      assert.ok(!recent.includes(escapedLikeThePage(c.summary)), `Recent Pricing Changes lists ${c.vendor}'s change dated ${c.date}`);
    }
    assert.strictEqual(rowCount(recent), 20);
  });

  it("links the section from /llm-api-pricing's list of sections", () => {
    assert.ok(pages.get("/llm-api-pricing")!.includes(`<li><a href="#upcoming-changes">${UPCOMING_CHANGES_HEADING}</a></li>`));
  });
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

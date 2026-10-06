import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const DAY_MS = 86_400_000;
const dayFromToday = (days: number): string => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

const A_NAME_EVERY_LIST_SELECTS =
  "Fixture OpenAI Railway Supabase Sentry GitHub Actions Postman Cloudflare PostHog SendGrid Resend Figma Slack Cursor Vercel Neon Clerk Langfuse Portkey Deepgram Roboflow";

const BOXES: Record<string, number> = {
  "/ai-free-tiers": 6,
  "/ai-ml-alternatives": 8,
  "/analytics-alternatives": 8,
  "/api-development-alternatives": 8,
  "/ci-cd-alternatives": 8,
  "/database-alternatives": 6,
  "/design-alternatives": 8,
  "/email-alternatives": 8,
  "/free-llm-apis": 8,
  "/hosting-alternatives": 8,
  "/ide-code-editors-alternatives": 8,
  "/monitoring-alternatives": 8,
  "/project-management-alternatives": 8,
  "/security-alternatives": 8,
  "/storage-alternatives": 8,
  "/team-collaboration-alternatives": 8,
  "/testing-alternatives": 8,
};

const STACKS: Record<string, number> = {
  "/free-startup-stack": 12,
  "/free-ai-stack": 12,
  "/free-devops-stack": 12,
  "/free-frontend-stack": 12,
  "/free-nextjs-stack": 12,
  "/free-django-stack": 12,
  "/free-fastapi-stack": 12,
  "/free-go-stack": 12,
  "/free-saas-stack": 12,
};

function aChange(daysFromToday: number, summary: string, extra: Record<string, unknown> = {}) {
  return {
    vendor: A_NAME_EVERY_LIST_SELECTS,
    change_type: "limits_reduced",
    date: dayFromToday(daysFromToday),
    date_source: "vendor_page",
    summary,
    previous_state: "More was free.",
    current_state: "Less is free.",
    impact: "medium",
    source_url: `https://example.com/changes/${Math.abs(daysFromToday)}${daysFromToday < 0 ? "-ago" : "-ahead"}`,
    category: "Developer Tools",
    alternatives: [],
    recorded_date: dayFromToday(Math.min(daysFromToday, 0) - 1),
    ...extra,
  };
}

const IN_EFFECT_OUT_OF_ORDER = [50, 10, 130, 30, 110, 70, 20, 90, 60, 120, 40, 100, 80].map((days) =>
  aChange(-days, `Fixture change that took effect ${days} days ago.`),
);
const NEWEST_FIRST = [...IN_EFFECT_OUT_OF_ORDER].sort((a, b) => b.date.localeCompare(a.date)).map((c) => c.summary);

const NOT_YET_IN_EFFECT = aChange(15, "Fixture change that takes effect in 15 days.");
const UNDATED = aChange(-2, "Fixture change dated only by the day we found it.", { date_source: "discovered" });
const BESIDE_THE_LISTING = aChange(-1, "Fixture retirement of a product the listing does not state.", {
  change_type: "product_deprecated",
  listing_effect: "none",
});
const LEFT_OUT = [NOT_YET_IN_EFFECT, UNDATED, BESIDE_THE_LISTING].map((c) => c.summary);

const FIXTURES = [
  ...IN_EFFECT_OUT_OF_ORDER.slice(0, 5),
  NOT_YET_IN_EFFECT,
  ...IN_EFFECT_OUT_OF_ORDER.slice(5, 9),
  BESIDE_THE_LISTING,
  UNDATED,
  ...IN_EFFECT_OUT_OF_ORDER.slice(9),
];

const ALL_SUMMARIES = [...NEWEST_FIRST, ...LEFT_OUT];

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function summariesIn(items: string[]): string[] {
  return items.map((item) => ALL_SUMMARIES.find((summary) => textOf(item).includes(summary)) ?? `unknown: ${textOf(item).slice(0, 80)}`);
}

function boxItems(page: string): string[] | null {
  const box = page.match(/Recent [^<]*Pricing Changes<\/div>\s*<ul[^>]*>([\s\S]*?)<\/ul>/);
  return box ? [...box[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]) : null;
}

function stabilityNoteItems(page: string): string[] | null {
  const start = page.indexOf('<div class="stability-list">');
  if (start < 0) return null;
  const end = page.indexOf("<h2", start);
  return [...page.slice(start, end < 0 ? undefined : end).matchAll(/<div class="stability-item">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
}

describe("every Recent Pricing Changes box and every stack page's Stability Notes list the newest changes in effect first", () => {
  let dir = "";
  let proc: ChildProcess | null = null;
  const pages = new Map<string, string>();

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "recent-changes-newest-first-"));
    const changesPath = path.join(dir, "deal_changes.json");
    writeFileSync(changesPath, JSON.stringify({ changes: FIXTURES }));
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_CHANGES_PATH: changesPath },
    });
    proc = child;
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timeout); resolve(parseInt(m[1], 10)); }
      });
      child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
    for (const route of [...Object.keys(BOXES), ...Object.keys(STACKS)]) {
      pages.set(route, await (await fetch(`http://localhost:${port}${route}`)).text());
    }
  });

  after(() => {
    proc?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists, in each of the 17 boxes, the newest dated changes already in effect that touch a listing, cut to the box's length", () => {
    const listed = Object.fromEntries(Object.keys(BOXES).map((route) => [route, summariesIn(boxItems(pages.get(route)!) ?? [])]));
    const expected = Object.fromEntries(Object.entries(BOXES).map(([route, length]) => [route, NEWEST_FIRST.slice(0, length)]));
    assert.deepStrictEqual(listed, expected);
  });

  it("lists, on each of the 9 stack pages, the newest dated changes already in effect that touch a listing, cut to the notes' length", () => {
    const listed = Object.fromEntries(Object.keys(STACKS).map((route) => [route, summariesIn(stabilityNoteItems(pages.get(route)!) ?? [])]));
    const expected = Object.fromEntries(Object.entries(STACKS).map(([route, length]) => [route, NEWEST_FIRST.slice(0, length)]));
    assert.deepStrictEqual(listed, expected);
  });

  it("lists no change dated in the future, dated only by the day we found it, or about a product the listing does not state", () => {
    const listed = [...pages].flatMap(([route, page]) =>
      summariesIn([...(boxItems(page) ?? []), ...(stabilityNoteItems(page) ?? [])])
        .filter((summary) => LEFT_OUT.includes(summary))
        .map((summary) => `${route}: ${summary}`));
    assert.deepStrictEqual(listed, []);
  });
});

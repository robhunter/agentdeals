import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = new Date().toISOString().slice(0, 10);
const day = (offset: number) => new Date(Date.parse(TODAY) + offset * 86_400_000).toISOString().slice(0, 10);
const scratch = mkdtempSync(path.join(tmpdir(), "comparison-effective-dates-"));
const children: ChildProcess[] = [];
const required = ["/auth-comparison-2026", "/database-free-tier-comparison-2026", "/testing-free-tier-comparison-2026", "/openai-assistants-alternatives", "/openai-assistants-migration-2026", "/firebase-studio-shutdown", "/tenor-alternatives", "/trends/databases", "/aws-app-runner-migration"];
const log = JSON.parse(readFileSync(path.join(ROOT, "data/deal_changes.json"), "utf8"));
const pairs = [...new Map<string, { vendor: string; category: string }>(log.changes.map((c: { vendor: string; category: string }) => [JSON.stringify([c.vendor, c.category]), c])).values()];
const record = (vendor: string, category: string, offset: number, summary: string, extra = {}) => ({
  vendor, category, date: day(offset), date_source: "vendor_page", recorded_date: day(-2),
  change_type: "pricing_restructured", summary, previous_state: "Earlier plan", current_state: "Changed plan",
  impact: "medium", source_url: "https://example.com/pricing", alternatives: [], ...extra,
});
const fixtures = pairs.flatMap((c, i) => [
  record(c.vendor, c.category, 40, `Timeline fixture ${i} later`),
  record(c.vendor, c.category, -1, `Timeline fixture ${i} past`),
  record(c.vendor, c.category, 1, `Timeline fixture ${i} sooner`),
  record(c.vendor, c.category, 0, `Timeline fixture ${i} today`),
]);
const flood = Array.from({ length: 15 }, (_, i) => record("Firebase", "Testing", 5 + i, `Future Firebase fixture ${i}`));
const firebase = [
  record("Firebase", "Testing", 100, "Firebase Test Lab fixture shutdown", { change_type: "product_deprecated", listing_effect: "none", discontinued_date: day(100), what_ends: "Test Lab" }),
  record("Firebase", "Databases", 80, "Firebase Extensions fixture shutdown", { change_type: "product_deprecated", listing_effect: "none", discontinued_date: day(80), what_ends: "Extensions" }),
];

type PageSection = { heading: string; html: string };
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
function sections(html: string): PageSection[] {
  const headings = [...html.matchAll(/<h([23])\b[^>]*>([\s\S]*?)<\/h\1>/g)];
  return headings.map((match, i) => ({ heading: text(match[2]), html: html.slice(match.index! + match[0].length, headings[i + 1]?.index ?? html.length) }));
}
const timelines = (html: string) => sections(html).filter(section => /(?:Pricing Changes?|AWS Change) Timeline/i.test(section.heading));
const announced = (html: string) => sections(html).filter(section => /^(Upcoming Changes|Announced)/i.test(section.heading)).map(section => section.html).join("\n");
function dates(section: string): string[] {
  const cells = [...section.matchAll(/<tr\b[^>]*>\s*<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(match => text(match[1]));
  const spans = [...section.matchAll(/<span class="timeline-date">([\s\S]*?)<\/span>/g)].map(match => text(match[1]));
  return [...cells, ...spans].flatMap(cell => {
    const iso = [...cell.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(match => match[0]);
    if (iso.length) return iso;
    const long = cell.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}, \d{4}\b/g) ?? [];
    return long.map(value => new Date(value + " UTC").toISOString().slice(0, 10));
  });
}

async function start(changes: unknown[], offset = 0): Promise<string> {
  const file = path.join(scratch, `changes-${children.length}.json`);
  writeFileSync(file, JSON.stringify({ changes }));
  const child = spawn(process.execPath, ["--import", path.join(ROOT, "scripts/shifted-clock.mjs"), path.join(ROOT, "dist/serve.js")], {
    cwd: ROOT, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, TZ: "UTC", PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_REFERRAL_HEALTH: "off", AGENTDEALS_CHANGES_PATH: file, AGENTDEALS_CLOCK_SHIFT_MS: String(offset * 86_400_000) },
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30_000);
    child.stderr!.on("data", chunk => {
      const port = String(chunk).match(/running on http:\/\/localhost:(\d+)/)?.[1];
      if (port) { clearTimeout(timer); resolve(`http://localhost:${port}`); }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Server exited with ${code}`)); });
  });
}

async function get(base: string, route: string): Promise<string> {
  const response = await fetch(base + route, { redirect: "error" });
  assert.equal(response.status, 200, route);
  return response.text();
}

async function crawl(base: string): Promise<Map<string, string>> {
  const pending = ["/sitemap.xml"];
  const maps = new Set<string>();
  const routes = new Set<string>();
  while (pending.length) {
    const route = pending.pop()!;
    if (maps.has(route)) continue;
    maps.add(route);
    for (const match of (await get(base, route)).matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const pathname = new URL(match[1].replaceAll("&amp;", "&")).pathname;
      if (pathname.endsWith(".xml")) pending.push(pathname);
      else routes.add(pathname);
    }
  }
  const list = [...routes];
  const found = new Map<string, string>();
  for (let i = 0; i < list.length; i += 8) await Promise.all(list.slice(i, i + 8).map(async route => {
    const html = await get(base, route);
    if (timelines(html).length) found.set(route, html);
  }));
  for (const route of required) assert.ok(found.has(route), `inventory missed ${route}`);
  return found;
}

after(() => {
  for (const child of children) child.kill();
  rmSync(scratch, { recursive: true, force: true });
});

describe("pricing timelines separate history from announced changes", () => {
  it("checks every sitemap route's timeline with the saved log and Firebase shutdown records", async () => {
    const pages = await crawl(await start([...log.changes, ...firebase]));
    const invalid: string[] = [];
    let dated = 0;
    for (const [route, html] of pages) for (const section of timelines(html)) {
      const values = dates(section.html);
      dated += values.length;
      for (const value of values) if (value > TODAY) invalid.push(`${route}: ${value}`);
    }
    assert.ok(dated > 0);
    assert.deepEqual(invalid, []);
    for (const route of ["/database-free-tier-comparison-2026", "/testing-free-tier-comparison-2026", "/firebase-studio-shutdown"]) {
      for (const change of route === "/testing-free-tier-comparison-2026" ? firebase.slice(0, 1) : firebase) assert.ok(announced(pages.get(route)!).includes(change.summary), `${route}: ${change.summary}`);
    }
  });

  it("discovers all timeline renderers with future, today and past records for every stored subject", async () => {
    const pages = await crawl(await start([...fixtures, ...flood]));
    const invalid: string[] = [];
    let matched = 0;
    for (const [route, html] of pages) for (const section of timelines(html)) {
      for (const value of dates(section.html)) if (value > TODAY) invalid.push(`${route}: ${value}`);
      for (const marker of text(section.html).matchAll(/Timeline fixture (\d+) today/g)) {
        matched++;
        const future = announced(html);
        assert.ok(future.includes(`Timeline fixture ${marker[1]} sooner`), `${route}: missing nearer announcement`);
        assert.ok(future.includes(`Timeline fixture ${marker[1]} later`), `${route}: missing later announcement`);
      }
      assert.doesNotMatch(section.html, /Future Firebase fixture/);
    }
    assert.ok(matched > 0);
    assert.deepEqual(invalid, []);
    for (const route of ["/database-free-tier-comparison-2026", "/testing-free-tier-comparison-2026", "/firebase-studio-shutdown"]) {
      const html = pages.get(route)!;
      for (const change of flood) assert.ok(announced(html).includes(change.summary), `${route}: truncated ${change.summary}`);
      assert.ok(timelines(html).some(section => /Timeline fixture \d+ today/.test(section.html)), `${route}: announcements displaced history`);
    }
    for (const route of required.filter(route => !route.startsWith("/trends/"))) {
      const shown = dates(announced(pages.get(route)!));
      assert.ok(shown.length > 0, `${route}: no announced dates`);
      assert.deepEqual(shown, [...shown].sort(), `${route}: announcements are not soonest first`);
      assert.ok(shown.every(value => value > TODAY));
    }
  });

  it("moves announcements into history on their effective day while preserving a separate retirement", async () => {
    const records = [
      record("Firebase", "Databases", 1, "Effective-day event"),
      record("Firebase", "Databases", -1, "Earlier announcement with later retirement", { change_type: "product_deprecated", listing_effect: "none", discontinued_date: day(10), what_ends: "A product" }),
      record("Firebase", "Databases", 30, "Later event"),
    ];
    const tomorrow = await start(records, 1);
    const before = await start(records);
    for (const route of ["/database-free-tier-comparison-2026", "/firebase-studio-shutdown"]) {
      const old = await get(before, route);
      const fresh = await get(tomorrow, route);
      const history = timelines(fresh).map(section => section.html).join("\n");
      assert.ok(announced(old).includes("Effective-day event"));
      assert.ok(history.includes("Effective-day event"));
      assert.ok(!announced(fresh).includes("Effective-day event"));
      assert.ok(history.includes("Earlier announcement with later retirement"));
      assert.ok(announced(fresh).includes("Earlier announcement with later retirement"));
      assert.ok(dates(announced(fresh)).includes(day(10)));
      assert.ok(announced(fresh).includes("Later event"));
    }
  });

  it("clears the original history table when every relevant record is still announced", async () => {
    const records = [record("Firebase", "Databases", 5, "Only future database change")];
    const base = await start(records);
    for (const route of ["/database-free-tier-comparison-2026", "/firebase-studio-shutdown"]) {
      const html = await get(base, route);
      for (const section of timelines(html)) {
        assert.deepEqual(dates(section.html), []);
        assert.ok(!section.html.includes(records[0].summary));
      }
      assert.ok(announced(html).includes(records[0].summary));
    }
  });
});

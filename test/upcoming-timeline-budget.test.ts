import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDocument } from "@mixmark-io/domino";
import { assertChangeTimelineReadingBudget, changeTimelineMarkdown } from "./change-timeline-reading-budget.ts";
import { assertChangeVendorIndex } from "./change-vendor-index-observer.ts";
import { renderUpcomingTimeline, UPCOMING_TIMELINE_END } from "../dist/upcoming-timeline-budget.js";
import { changesTheVendorMade } from "../dist/data.js";
import { recordsStillInForce } from "../dist/change-resolution.js";
import { trackedChanges } from "../dist/change-census.js";
import { partitionByDateProvenance } from "../dist/change-dates.js";
import { upcomingDateOf } from "../dist/upcoming-changes.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const today = new Date().toISOString().slice(0, 10);
const day = (offset: number) => new Date(Date.parse(today) + offset * 86_400_000).toISOString().slice(0, 10);
const formatDate = (date: string) => new Date(date + "T00:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const syntheticPage = (count: number, overflow: string, rows: string[], prefix = "") =>
  `<html><head><style>${"s".repeat(100_000)}</style></head><body><p>${prefix}</p><section class="latest-section">Latest</section><section class="upcoming-section">${rows.slice(0, count).join("")}${overflow}${UPCOMING_TIMELINE_END}</section><p>${"h".repeat(100_001)}</p></body></html>`;

function section(html: string, name: string) {
  const document = createDocument(html);
  const node = document.querySelector(`.${name}-section`);
  assert.ok(node);
  return node;
}

describe("upcoming timeline selection", () => {
  it("keeps a fitting page byte-identical, including its long history and hidden styles", () => {
    const rows = ["<p>One</p>", "<p>Two</p>"];
    const page = syntheticPage(2, "", rows).replace(UPCOMING_TIMELINE_END, "");
    assert.equal(renderUpcomingTimeline([{ date: day(1) }, { date: day(2) }], (n, note) => syntheticPage(n, note, rows)), page);
    assert.equal(section(page, "upcoming").querySelector(".upcoming-overflow") ?? null, null);
  });

  it("keeps an empty schedule unchanged", () => {
    assert.equal(renderUpcomingTimeline([], (count, note) => { assert.equal(count, 0); assert.equal(note, ""); return "empty"; }), "empty");
  });

  it("bounds candidate conversion when thousands of future entries exceed the window", () => {
    const entries = Array.from({ length: 10_000 }, () => ({ date: day(1) }));
    const rows = entries.map(() => `<p>${"a".repeat(800)}</p>`);
    const result = renderUpcomingTimeline(entries, (count, note) => {
      assert.ok(count < entries.length / 2, "a candidate must stay far below this oversized schedule");
      return syntheticPage(count, note, rows);
    });
    assert.ok(assertChangeTimelineReadingBudget(result).ends.upcoming <= 95_000);
    assert.ok(section(result, "upcoming").querySelector('.upcoming-overflow'));
  });

  it("measures served decorations while returning the undecorated page", () => {
    const rows = ["<p>" + "a".repeat(47_000) + "</p>", "<p>" + "b".repeat(47_000) + "</p>"];
    const decorate = (page: string) => page.replace("<body>", `<body><p data-decoration="yes">${"d".repeat(5_000)}</p>`);
    const result = renderUpcomingTimeline([{ date: day(1) }, { date: day(2) }], (n, note) => syntheticPage(n, note, rows), decorate);
    assert.doesNotMatch(result, /data-decoration/);
    assert.equal(section(result, "upcoming").querySelectorAll("p").length, 2);
    assert.ok(assertChangeTimelineReadingBudget(decorate(result)).ends.upcoming <= 95_000);
  });

  it("includes a complete entry ending exactly at character 95000", () => {
    const row = `<p>${"a".repeat(94_992)}</p>`;
    const result = renderUpcomingTimeline([{ date: day(1) }], (n, note) => syntheticPage(n, note, [row]));
    assert.equal(changeTimelineMarkdown(result).ends.upcoming, 95_000);
    assert.equal(section(result, "upcoming").querySelector(".upcoming-overflow") ?? null, null);
  });

  it("counts earlier content, markdown destinations and the overflow line before selecting a maximal prefix", () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ date: day(i + 1) }));
    const rows = entries.map((_, i) => `<p data-row="${i}"><a href="https://example.com/${"q".repeat(790)}">${i}</a></p>`);
    const result = renderUpcomingTimeline(entries, (n, note) => syntheticPage(n, note, rows, "p".repeat(80_000)));
    const upcoming = section(result, "upcoming");
    const kept = upcoming.querySelectorAll("[data-row]").length;
    assert.ok(kept > 0 && kept < entries.length);
    assert.ok(assertChangeTimelineReadingBudget(result).ends.upcoming <= 95_000);
    assert.deepEqual([...upcoming.querySelectorAll("[data-row]")].map(node => Number(node.getAttribute("data-row"))), Array.from({ length: kept }, (_, i) => i));
    assert.equal(upcoming.querySelector(".upcoming-overflow")!.textContent, `${entries.length - kept} more scheduled changes from ${formatDate(entries[kept].date)} are listed on /deadlines.`);
    const oneMore = syntheticPage(kept + 1, `<p>${entries.length - kept - 1} more scheduled changes from ${formatDate(entries[kept + 1].date)} are listed on <a href="/deadlines">/deadlines</a>.</p>`, rows, "p".repeat(80_000));
    assert.equal(changeTimelineMarkdown(oneMore).ends.upcoming <= 95_000, false);
  });

  it("still links the complete schedule when the first entry alone is too large", () => {
    const result = renderUpcomingTimeline([{ date: day(1) }], (n, note) => syntheticPage(n, note, [`<p data-row="0">${"a".repeat(96_000)}</p>`]));
    assert.equal(section(result, "upcoming").querySelectorAll("[data-row]").length, 0);
    assert.equal(section(result, "upcoming").querySelector("a")!.getAttribute("href"), "/deadlines");
    assert.ok(assertChangeTimelineReadingBudget(result).ends.upcoming <= 95_000);
  });

  it("keeps an oversized index after the summary when its original position cannot fit", () => {
    let moved = false;
    const result = renderUpcomingTimeline([{ date: day(1) }], (n, note, afterUpcoming) => {
      moved ||= afterUpcoming;
      return syntheticPage(n, note, ["<p>One</p>"], afterUpcoming ? "" : "p".repeat(95_001)).replace("</body>", (afterUpcoming ? "<p>" + "p".repeat(95_001) + "</p>" : "") + "</body>");
    });
    assert.equal(moved, true);
    assert.ok(assertChangeTimelineReadingBudget(result).ends.upcoming <= 95_000);
    assert.ok(result.includes("p".repeat(95_001)));
  });

  it("refuses a prefix that leaves no room even for the schedule link", () => {
    assert.throws(() => renderUpcomingTimeline([{ date: day(1) }], (n, note) => syntheticPage(n, note, ["<p>One</p>"], "p".repeat(95_001))), /Content before Upcoming Changes/);
  });
});

const scratch = mkdtempSync(path.join(tmpdir(), "upcoming-budget-"));
const children: ChildProcess[] = [];
const pages = new Map<string, string>();
const feedTargets = new Map<string, string[]>();
const stored = JSON.parse(readFileSync(path.join(ROOT, "data/deal_changes.json"), "utf8"));
const extra = Array.from({ length: 40 }, (_, i) => ({
  vendor: `Budget Future ${String(i).padStart(2, "0")}`, date: day(180 + i), date_source: "vendor_page",
  recorded_date: today, change_type: "product_deprecated", discontinued_date: day(180 + i),
  what_ends: "The service", summary: `Future retirement ${i} ${"a".repeat(700)}`,
  previous_state: "b".repeat(150), current_state: "c".repeat(300), impact: "high", category: "APIs",
  source_url: "https://example.com/pricing", alternatives: [],
}));
const records = { live: stored.changes, expanded: [...stored.changes, ...extra] };

async function readPages(name: keyof typeof records) {
  const filename = path.join(scratch, `${name}.json`);
  writeFileSync(filename, JSON.stringify({ ...stored, changes: records[name] }));
  const child = spawn("node", [path.join(ROOT, "dist/serve.js")], {
    cwd: ROOT, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, TZ: "UTC", PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_REFERRAL_HEALTH: "off", AGENTDEALS_CHANGES_PATH: filename },
  });
  children.push(child);
  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30_000);
    child.stderr!.on("data", chunk => {
      const match = String(chunk).match(/running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", code => { clearTimeout(timer); reject(new Error(`Server exited with code ${code}`)); });
  });
  for (const route of ["/changes", "/pricing-changes"]) {
    const response = await fetch(`http://localhost:${port}${route}`, { redirect: "error" });
    assert.equal(response.status, 200);
    pages.set(`${name} ${route}`, await response.text());
  }
  const feed = await (await fetch(`http://localhost:${port}/pricing-changes/feed.xml`)).text();
  feedTargets.set(name, [...feed.matchAll(/<entry>[\s\S]*?<link href="([^"]+)" rel="alternate"\/>/g)].map(match => match[1].replace(/&amp;/g, "&")));
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

before(async () => { await readPages("live"); await readPages("expanded"); });
after(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  rmSync(scratch, { recursive: true, force: true });
});

describe("upcoming timeline budget on served pages", () => {
  for (const name of ["live", "expanded"]) it(`${name} feed entries retain their dated target in the complete timeline`, () => {
    const document = createDocument(pages.get(`${name} /pricing-changes`)!);
    const targets = feedTargets.get(name)!;
    assert.equal(targets.length, 50);
    for (const href of targets) {
      const link = new URL(href);
      assert.equal(link.pathname, '/pricing-changes');
      assert.ok(document.getElementById(link.hash.slice(1)), href);
    }
  });
  for (const name of ["live", "expanded"] as const) for (const route of ["/changes", "/pricing-changes"]) it(`${name} ${route} keeps every dated future record exactly once across summary and months`, () => {
    const expected = new Map<string, number>();
    const actual = new Map<string, number>();
    const add = (map: Map<string, number>, vendor: string, date: string) => {
      const key = `${vendor}\0${date}`;
      map.set(key, (map.get(key) ?? 0) + 1);
    };
    for (const record of partitionByDateProvenance(records[name]).dated) if (record.date > today) add(expected, record.vendor, record.date);
    const document = createDocument(pages.get(`${name} ${route}`)!);
    for (const node of document.querySelectorAll('.pc-entry:not(.pc-undated), .chg-entry:not(.chg-undated)')) {
      const date = node.getAttribute('data-event-date') ?? node.querySelector('.pc-date, .chg-date')!.textContent!.match(/\d{4}-\d{2}-\d{2}/)![0];
      if (date > today) add(actual, node.querySelector('.pc-vendor, .chg-vendor')!.textContent!, date);
    }
    assert.deepEqual([...actual].sort(), [...expected].sort());
  });
  for (const name of ["live", "expanded"] as const) for (const route of ["/changes", "/pricing-changes"]) {
    it(`${name} ${route} retains the earliest entries within character 95000 and counts the rest`, () => {
      const html = pages.get(`${name} ${route}`)!;
      assert.ok(!html.includes(UPCOMING_TIMELINE_END));
      const all = partitionByDateProvenance(records[name]).dated.sort((a, b) => b.date.localeCompare(a.date));
      const expected = changesTheVendorMade(route === "/pricing-changes" ? trackedChanges(all) : recordsStillInForce(all))
        .map(c => ({ vendor: c.vendor, date: upcomingDateOf(c, today) })).filter(c => c.date > today).sort((a, b) => a.date.localeCompare(b.date));
      const upcoming = section(html, "upcoming");
      const kept = [...upcoming.querySelectorAll('.pc-entry, .chg-entry, .chg-preview')].map(node => ({
        vendor: node.querySelector('.pc-vendor, .chg-vendor')!.textContent,
        date: node.querySelector('.pc-date, .chg-date')!.textContent.match(/\d{4}-\d{2}-\d{2}/)![0],
      }));
      assert.ok(kept.length > 0);
      assert.deepEqual(kept, expected.slice(0, kept.length));
      assert.ok(assertChangeTimelineReadingBudget(html).ends.upcoming <= 95_000, JSON.stringify(changeTimelineMarkdown(html).ends));
      const overflow = upcoming.querySelector('.upcoming-overflow');
      if (kept.length < expected.length) {
        assert.ok(overflow);
        assert.equal(overflow.textContent, `${expected.length - kept.length} more scheduled changes from ${formatDate(expected[kept.length].date)} are listed on /deadlines.`);
        assert.equal(overflow.querySelector('a')!.getAttribute('href'), '/deadlines');
        assert.equal(upcoming.lastElementChild, overflow);
      } else assert.equal(overflow ?? null, null);
      if (name === "expanded") {
        assert.ok(overflow);
        assert.ok(expected.length - kept.length > 0);
        if (route === "/changes") {
          const document = createDocument(html);
          const list = [...document.querySelectorAll('script[type="application/ld+json"]')].map(node => JSON.parse(node.textContent!)).find(node => node['@type'] === 'ItemList');
          assert.equal(list.numberOfItems, document.querySelectorAll('.chg-entry').length);
          assert.equal(list.numberOfItems, records[name].length);
          assert.match(html, /history is complete/);
        }
      }
      if (name === "live") assert.deepEqual(kept.filter(c => c.date <= day(90)), expected.filter(c => c.date <= day(90)));
      assertChangeVendorIndex(html, route);
      const document = createDocument(html);
      for (const link of document.querySelectorAll('.change-vendor-index a[href^="#"]')) {
        assert.ok(document.getElementById(link.getAttribute('href')!.slice(1)));
      }
    });
  }

  for (const route of ["/changes", "/pricing-changes"]) it(`${route} keeps Latest unchanged when forty future records are added`, () => {
    assert.equal(section(pages.get(`live ${route}`)!, "latest").outerHTML, section(pages.get(`expanded ${route}`)!, "latest").outerHTML);
    assert.equal(section(pages.get(`expanded ${route}`)!, "latest").querySelectorAll('.pc-preview, .chg-preview').length, 10);
  });
});

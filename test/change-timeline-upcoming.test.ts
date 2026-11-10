import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { visibleText } from "./change-vendor-index-observer.ts";
import { assertChangeTimelineReadingBudget } from "./change-timeline-reading-budget.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(path.join(tmpdir(), "timeline-upcoming-"));
const children: ChildProcess[] = [];
const today = new Date().toISOString().slice(0, 10);
const day = (offset: number) => new Date(Date.parse(today) + offset * 86_400_000).toISOString().slice(0, 10);
const record = (vendor: string, offset: number, extra = {}) => ({
  vendor, date: day(offset), date_source: "vendor_page", recorded_date: today,
  change_type: "pricing_restructured", summary: `${vendor} changes its plan`,
  previous_state: "Before", current_state: "After", impact: "medium",
  category: "APIs", source_url: "https://example.com/pricing", alternatives: [], ...extra,
});
const fixtures = [
  record("Later Future", 40), record("Sooner Future", 1), record("Today Event", 0),
  record("Future Announcement", 5, { change_type: "product_deprecated", discontinued_date: day(30), what_ends: "The service" }),
  ...Array.from({ length: 13 }, (_, i) => record(`Past Event ${i}`, -i - 1)),
  record("Retiring Service", -10, { change_type: "product_deprecated", discontinued_date: day(20), what_ends: "The service" }),
  record("Already Recorded", -12, { change_type: "product_deprecated", discontinued_date: day(-3), what_ends: "The service" }),
  record("Already Recorded", -3, { change_type: "product_deprecated" }),
  record("Retiring Service", 20, { change_type: "product_deprecated", date_source: "discovered" }),
  record("Undated Service", 50, { date_source: "discovered" }),
  record("Correction Service", 60, { change_type: "record_corrected" }),
  record("Retracted Service", 70, { resolution: { state: "retracted", date: today, detail: "An incorrect record" } }),
];
const pages = new Map<string, string>();

async function readPages(name: string, offset = 0, fixture = false) {
  const file = path.join(scratch, "changes.json");
  if (fixture) writeFileSync(file, JSON.stringify({ changes: fixtures }));
  const child = spawn("node", ["--import", path.join(ROOT, "scripts/shifted-clock.mjs"), path.join(ROOT, "dist/serve.js")], {
    cwd: ROOT, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, TZ: "UTC", PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_REFERRAL_HEALTH: "off", AGENTDEALS_CLOCK_SHIFT_MS: String(offset * 86_400_000), ...(fixture ? { AGENTDEALS_CHANGES_PATH: file } : {}) },
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
}

function upcoming(html: string) {
  const start = html.indexOf('class="upcoming-section"');
  if (start < 0) return "";
  const end = html.indexOf('<div class="pc-filters">', start);
  return html.slice(start, end >= 0 ? end : html.indexOf("</section>", start));
}

function timeline(html: string) {
  const start = html.search(/<h2 class="month-heading" id="month-(?!ours)/);
  assert.ok(start >= 0);
  const ours = html.indexOf('id="month-ours"', start);
  return html.slice(start, ours < 0 ? undefined : ours);
}

function dates(html: string) {
  return [...html.matchAll(/<div class="(?:pc|chg)-date">[\s\S]*?(\d{4}-\d{2}-\d{2})[\s\S]*?<\/div>/g)].map(match => match[1]);
}

before(async () => {
  await readPages("catalogue");
  await readPages("fixtures", 0, true);
  await readPages("tomorrow", 1, true);
  await readPages("after", 2, true);
  await readPages("announcementDay", 5, true);
  await readPages("retirementDay", 20, true);
  await readPages("retired", 21, true);
});

after(() => {
  for (const child of children) child.kill();
  rmSync(scratch, { recursive: true, force: true });
});

describe("the change timelines separate announced changes from their history", () => {
  for (const name of ["catalogue", "fixtures"]) for (const route of ["/changes", "/pricing-changes"]) {
    it(`lists ${name} ${route}'s announced changes once, soonest first, outside the month timeline`, () => {
      const html = pages.get(`${name} ${route}`)!;
      const announced = dates(upcoming(html));
      assert.ok(announced.length > 0);
      assert.deepEqual(announced, [...announced].sort());
      assert.ok(announced.every(date => date > today));
      assert.ok(dates(timeline(html)).every(date => date <= today));
      assert.match(upcoming(html), /class="(?:pc|chg)-upcoming-badge"/);
      assert.doesNotMatch(upcoming(html), /Undated Service/);
      for (const vendor of ["Sooner Future", "Later Future"]) if (name === "fixtures") {
        const summaries = [...html.matchAll(/class="(?:pc|chg)-summary">([\s\S]*?)<\/div>/g)].map(match => visibleText(match[1]));
        assert.equal(summaries.filter(summary => summary.startsWith(`${vendor} changes its plan`)).length, 1);
        assert.ok(upcoming(html).includes(vendor));
      }
      assert.match(upcoming(html), /listed soonest first/);
      const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
      if (name === "fixtures") {
        assert.equal(ids.length, new Set(ids).size, `${route}: duplicate anchor`);
        if (route === "/changes") assert.equal((html.match(/<div class="chg-entry/g) ?? []).length, fixtures.length);
      }
    });

    it(`marks future dates in ${name} ${route}'s vendor index`, () => {
      const html = pages.get(`${name} ${route}`)!;
      const index = html.match(/<section class="change-vendor-index"[^>]*>([\s\S]*?)<\/section>/)?.[1];
      assert.ok(index);
      let future = 0;
      for (const match of visibleText(index).matchAll(/effective (\d{4}-\d{2}-\d{2})( \(upcoming\))?/g)) {
        assert.equal(Boolean(match[2]), match[1] > today);
        if (match[1] > today) future++;
      }
      assert.ok(future > 0);
    });
  }

  for (const name of ["catalogue", "fixtures"]) for (const route of ["/changes", "/pricing-changes"]) it(`puts ${name} ${route}'s ten latest changes before the upcoming section and within the reading budget`, () => {
    const html = pages.get(`${name} ${route}`)!;
    const indexEnd = html.indexOf('</section>', html.indexOf('class="change-vendor-index"'));
    const latestStart = html.indexOf('class="latest-section"');
    const latestEnd = html.indexOf('</section>', latestStart);
    const upcomingStart = html.indexOf('class="upcoming-section"');
    assert.ok(indexEnd < latestStart && latestEnd < upcomingStart);
    const latest = html.slice(latestStart, latestEnd);
    assert.match(latest, /Latest Pricing Changes/);
    assert.match(latest, /older entries leave this summary/);
    assert.ok(latest.includes(`href="${route}"`));
    assert.equal(dates(latest).length, 10);
    assert.deepEqual(dates(latest), [...dates(latest)].sort().reverse());
    assert.ok(dates(latest).every(date => date <= today));
    assertChangeTimelineReadingBudget(html);
    if (name === "fixtures") {
      assert.deepEqual(dates(latest), [0, -1, -2, -3, -3, -4, -5, -6, -7, -8].map(day));
      assert.doesNotMatch(latest, /Correction Service|Retracted Service|Undated Service/);
    }
  });

  for (const route of ["/changes", "/pricing-changes"]) {

    it(`treats today's event as in effect throughout ${route}`, () => {
      for (const [name, vendor, effectiveDay] of [["fixtures", "Today Event", today], ["tomorrow", "Sooner Future", day(1)], ["retirementDay", "Retiring Service", day(20)]]) {
        const html = pages.get(`${name} ${route}`)!;
        const latest = html.slice(html.indexOf('class="latest-section"'), html.indexOf('</section>', html.indexOf('class="latest-section"')));
        assert.match(latest, new RegExp(vendor));
        assert.doesNotMatch(latest, /upcoming-badge|(?:pc|chg)-upcoming/);
        assert.doesNotMatch(upcoming(html), new RegExp(vendor));
        const history = timeline(html);
        assert.ok(history.includes(`id="month-${effectiveDay.slice(0, 7)}"`));
        assert.match(history, new RegExp(vendor));
        assert.doesNotMatch(history, /upcoming-badge|(?:pc|chg)-upcoming/);
        const tile = html.match(/<div class="stat-value">(\d+)<\/div>\s*<div class="stat-label">Upcoming<\/div>/);
        assert.ok(tile);
        assert.equal(Number(tile[1]), dates(upcoming(html)).length);
        const servedDay = name === "fixtures" ? today : name === "tomorrow" ? day(1) : day(20);
        assert.match(upcoming(html), new RegExp(`effective date is later than ${servedDay}`));
        assert.match(upcoming(html), /On that date it stops being upcoming and is listed only under the month it falls in/);
      }
    });

    it(`keeps a separate future retirement when its announcement becomes effective on ${route}`, () => {
      const html = pages.get(`announcementDay ${route}`)!;
      const latest = html.slice(html.indexOf('class="latest-section"'), html.indexOf('</section>', html.indexOf('class="latest-section"')));
      assert.match(latest, /Future Announcement/);
      assert.doesNotMatch(latest, /upcoming-badge/);
      assert.match(upcoming(html), /Future Announcement/);
      assert.ok(dates(upcoming(html)).includes(day(30)));
      assert.match(timeline(html), /Future Announcement/);
      assert.ok(dates(timeline(html)).includes(day(5)));
      if (route === "/changes") assert.equal((html.match(/<div class="chg-entry/g) ?? []).length, fixtures.length);
      const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
      assert.equal(ids.length, new Set(ids).size);
    });

    it(`keeps a retirement in ${route}'s effective month after it leaves Upcoming, beside its earlier event`, () => {
      const onDay = pages.get(`retirementDay ${route}`)!;
      const retired = pages.get(`retired ${route}`)!;
      assert.doesNotMatch(upcoming(onDay), /Retiring Service/);
      assert.match(timeline(onDay), /Retiring Service/);
      assert.doesNotMatch(upcoming(retired), /Retiring Service/);
      const retirement = new RegExp(`<div class="(?:pc-entry|chg-preview)[^"]*"[^>]*data-event-date="${day(-10)}"[\\s\\S]*?<div class="(?:pc|chg)-date">[\\s\\S]*?${day(20)}[\\s\\S]*?Retiring Service`);
      const history = timeline(retired);
      assert.match(history, retirement);
      const monthAt = history.indexOf(`id="month-${day(20).slice(0, 7)}"`);
      assert.ok(monthAt >= 0 && history.search(retirement) > monthAt);
      assert.match(history, new RegExp(`effective ${day(-10)}`));
      const alreadyRecorded = [...history.matchAll(/class="(?:pc|chg)-summary">([^<]*)/g)].filter(match => match[1].startsWith("Already Recorded changes"));
      assert.equal(alreadyRecorded.length, 2);
      {
        if (route === "/changes") assert.equal((retired.match(/<div class="chg-entry/g) ?? []).length, fixtures.length);
        const latest = retired.slice(retired.indexOf('class="latest-section"'), retired.indexOf('</section>', retired.indexOf('class="latest-section"')));
        assert.ok(dates(latest).includes(day(20)));
      }
    });

    it(`moves an effective event from ${route}'s upcoming section to its month on its effective day`, () => {
      const onDay = pages.get(`tomorrow ${route}`)!;
      const after = pages.get(`after ${route}`)!;
      const before = pages.get(`fixtures ${route}`)!;
      assert.match(upcoming(before), /Sooner Future/);
      assert.doesNotMatch(timeline(before), /Sooner Future/);
      assert.doesNotMatch(upcoming(onDay), /Sooner Future/);
      assert.match(timeline(onDay), /Sooner Future/);
      assert.doesNotMatch(upcoming(after), /Sooner Future/);
      assert.match(timeline(after), /Sooner Future/);
      assert.match(timeline(after), new RegExp(`id="month-${day(1).slice(0, 7)}"`));
      assert.match(upcoming(after), /Later Future/);
      assert.match(upcoming(after), /Retiring Service/);
      assert.match(timeline(after), /Retiring Service/);
    });
  }
});

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { COMING_UP_HEADING, lastDayComingUp } = await import("../dist/coming-up.js");
const { A_DATED_SECTION_MARKER } = await import("../dist/change-dates.js");

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const SUNDAY = "2026-11-15T12:00:00Z";
const WEDNESDAY = "2026-11-11T12:00:00Z";
const NOTHING_AHEAD = "2099-06-03T12:00:00Z";

const THIS_WEEK = "/this-week";
const LAST_WEEK_ON_THIS_WEEK = "/this-week?week=1";
const THE_CURRENT_DIGEST = "/digest";
const THE_WEEK = "/digest/2026-w46";
const THE_WEEK_BEFORE = "/digest/2026-w45";
const THE_WEEK_AFTER = "/digest/2026-w47";
const THE_WEEK_PAGES = [THIS_WEEK, THE_WEEK];

function shutdown(vendor: string, date: string) {
  return {
    vendor,
    change_type: "product_deprecated",
    date,
    date_source: "vendor_page",
    summary: `${vendor} keeps running until ${date}, when its vendor shuts it down.`,
    previous_state: `${vendor} could be used.`,
    current_state: `The vendor lists ${date} as the shutdown date.`,
    impact: "medium",
    source_url: `https://example.com/${vendor.toLowerCase().replace(/\W+/g, "-")}`,
    category: "AI / ML",
    alternatives: [],
    recorded_date: "2026-10-01",
    listing_effect: "none",
  };
}

const YESTERDAY_S = shutdown("Ends Saturday Vendor", "2026-11-14");
const TODAY_S = shutdown("Ends Sunday Vendor", "2026-11-15");
const TOMORROW_S = shutdown("Ends Monday Vendor", "2026-11-16");
const DAY_30 = shutdown("Ends On Day Thirty Vendor", "2026-12-15");
const DAY_31 = shutdown("Ends On Day Thirty One Vendor", "2026-12-16");
const LATER_IN_THE_WEEK = shutdown("Ends Friday Vendor", "2026-11-13");
const QUOTED_DATE = {
  ...shutdown("Quoted Date Vendor", "2026-11-10"),
  change_type: "limits_reduced",
  summary: "Quoted Date Vendor keeps its old limits until 2026-11-20, when the new ones take effect.",
};

const TWO_STEPS_SECOND = shutdown("Two Step Vendor", "2026-11-15");
const TWO_STEPS_NOTICE = {
  ...shutdown("Two Step Vendor", "2026-11-02"),
  change_type: "restriction",
  summary: "Two Step Vendor closes sign-ups on 2026-11-15 and keeps existing workspaces running until 2026-11-16.",
};

const CHANGE_LOG = { changes: [YESTERDAY_S, TODAY_S, TOMORROW_S, DAY_30, DAY_31, LATER_IN_THE_WEEK, QUOTED_DATE, TWO_STEPS_SECOND, TWO_STEPS_NOTICE] };

type ApiDeadline = { vendor: string; date: string; summary: string; stated_in?: string };

interface Line {
  dateLabel: string;
  vendorHtml: string;
  vendor: string;
  summaryHtml: string;
  text: string;
}

interface Served {
  today: string;
  api: ApiDeadline[];
  deadlinesHtml: string;
  pages: Map<string, string>;
}

function startServer(env: Record<string, string>): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", ["--import", path.join(REPO, "scripts", "shifted-clock.mjs"), path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 30000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ proc, base: `http://localhost:${match[1]}` });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nearr;/g, "↗")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function textOf(html: string): string {
  return decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function sectionOf(html: string): string | null {
  const heading = html.indexOf(`<h2>${COMING_UP_HEADING}</h2>`);
  if (heading === -1) return null;
  const end = html.indexOf("</section>", heading);
  return html.slice(heading, end);
}

function withoutTheSection(html: string): string {
  const section = sectionOf(html);
  return section === null ? html : html.replace(section, "");
}

const LINE_START = '<li><span class="coming-up-date">';

function linesOf(html: string): Line[] {
  const section = sectionOf(html);
  if (section === null) return [];
  const list = section.slice(0, section.indexOf('<p class="dated-rule">'));
  return list.split(LINE_START).slice(1).map(item => {
    const match = item.match(/^([^<]*)<\/span> (<(?:a|span)[^>]*>([^<]*)<\/(?:a|span)>): ([\s\S]*)<\/li>\s*(?:<\/ul>\s*)?$/);
    assert.ok(match, `an entry under "${COMING_UP_HEADING}" reads as neither date, vendor and summary: ${item.slice(0, 200)}`);
    const [, dateLabel, vendorHtml, vendor, summaryHtml] = match!;
    return { dateLabel: decode(dateLabel!), vendorHtml: vendorHtml!, vendor: decode(vendor!), summaryHtml: summaryHtml!, text: textOf(summaryHtml!) };
  });
}

function deadlineCardsOf(html: string): { dateLabel: string; vendorHref: string | null; vendor: string; summaryHtml: string }[] {
  return [...html.matchAll(/<div class="dl-card [^"]*">[\s\S]*?<(?:a|span)( href="[^"]*")? class="dl-vendor">([^<]*)<\/(?:a|span)>[\s\S]*?<div class="dl-date">([^<]*)<\/div>\s*<div class="dl-summary">([\s\S]*?)<\/div>\n/g)]
    .map(([, href, vendor, dateLabel, summaryHtml]) => ({
      dateLabel: decode(dateLabel),
      vendorHref: href ? href.slice(' href="'.length, -1) : null,
      vendor: decode(vendor),
      summaryHtml,
    }));
}

function hrefOf(vendorHtml: string): string | null {
  return vendorHtml.match(/ href="([^"]*)"/)?.[1] ?? null;
}

function dateOf(line: Line): string {
  return line.dateLabel.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
}

function mondayOf(today: string): string {
  const day = new Date(`${today}T00:00:00Z`);
  const back = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - back * 86400000).toISOString().slice(0, 10);
}

function sundayOf(today: string): string {
  return new Date(Date.parse(`${mondayOf(today)}T00:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10);
}

function recordsListedInTheWeek(served: Served): ApiDeadline[] {
  return served.api.filter(entry => entry.stated_in === undefined && entry.date <= sundayOf(served.today));
}

function expectedLines(served: Served): ApiDeadline[] {
  const listed = new Set(recordsListedInTheWeek(served));
  return served.api.filter(entry => entry.date <= lastDayComingUp(served.today) && !listed.has(entry));
}

const servedAt = new Map<string, Served>();
const servers: ChildProcess[] = [];
let scratch = "";

before(async () => {
  scratch = mkdtempSync(path.join(tmpdir(), "coming-up-"));
  const changesPath = path.join(scratch, "deal_changes.json");
  writeFileSync(changesPath, JSON.stringify(CHANGE_LOG, null, 2));
  for (const instant of [SUNDAY, WEDNESDAY, NOTHING_AHEAD]) {
    const { proc, base } = await startServer({
      AGENTDEALS_CHANGES_PATH: changesPath,
      AGENTDEALS_CLOCK_SHIFT_MS: String(Date.parse(instant) - Date.now()),
    });
    servers.push(proc);
    const api = await fetch(`${base}/api/deadlines`);
    assert.strictEqual(api.status, 200, `/api/deadlines at ${instant}`);
    const deadlines = await fetch(`${base}/deadlines`);
    assert.strictEqual(deadlines.status, 200, `/deadlines at ${instant}`);
    const pages = new Map<string, string>();
    for (const route of [THIS_WEEK, LAST_WEEK_ON_THIS_WEEK, THE_CURRENT_DIGEST, THE_WEEK, THE_WEEK_BEFORE, THE_WEEK_AFTER]) {
      const res = await fetch(base + route);
      assert.strictEqual(res.status, 200, `${route} at ${instant}`);
      pages.set(route, await res.text());
    }
    servedAt.set(instant, {
      today: instant.slice(0, 10),
      api: ((await api.json()) as { deadlines: ApiDeadline[] }).deadlines,
      deadlinesHtml: await deadlines.text(),
      pages,
    });
  }
});

after(() => {
  for (const proc of servers) proc.kill();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const at = (instant: string) => servedAt.get(instant)!;

const vendorsListed = (instant: string, route: string) => linesOf(at(instant).pages.get(route)!).map(line => line.vendor);

describe("the coming-up section on the week's pages", () => {
  it("lists a deadline dated tomorrow and one dated 30 days ahead, and nothing dated today, yesterday or 31 days ahead", () => {
    for (const route of THE_WEEK_PAGES) {
      const vendors = vendorsListed(SUNDAY, route);
      assert.ok(vendors.includes(TOMORROW_S.vendor), `${route}: ${vendors.join(", ")}`);
      assert.ok(vendors.includes(DAY_30.vendor), `${route}: ${vendors.join(", ")}`);
      for (const outside of [YESTERDAY_S, TODAY_S, DAY_31]) {
        assert.ok(!vendors.includes(outside.vendor), `${route} lists ${outside.vendor}, dated ${outside.date}`);
      }
    }
  });

  it("leaves out today's record because the deadline tracker no longer holds it, while the week lists it", () => {
    const served = at(SUNDAY);
    assert.ok(!served.api.some(entry => entry.vendor === TODAY_S.vendor), "/api/deadlines holds a record dated the day it is served");
    for (const route of THE_WEEK_PAGES) {
      const page = served.pages.get(route)!;
      assert.ok(withoutTheSection(page).includes(TODAY_S.vendor), `${route} does not list ${TODAY_S.vendor} in its week`);
    }
  });

  it("keeps tomorrow's date quoted by a vendor whose record is dated today, as the deadline tracker does", () => {
    const served = at(SUNDAY);
    assert.ok(
      served.api.some(entry => entry.vendor === TWO_STEPS_NOTICE.vendor && entry.date === "2026-11-16"),
      "/api/deadlines does not hold the quoted date, so the check below reads nothing",
    );
    for (const route of THE_WEEK_PAGES) {
      const lines = linesOf(served.pages.get(route)!).filter(line => line.vendor === TWO_STEPS_NOTICE.vendor);
      assert.deepStrictEqual(lines.map(dateOf), ["2026-11-16"], route);
    }
  });

  it("prints exactly the tracker's entries from tomorrow through 30 days ahead, less the records the page lists in its week", () => {
    for (const instant of [SUNDAY, WEDNESDAY]) {
      const served = at(instant);
      const expected = expectedLines(served).map(entry => `${entry.date} ${entry.vendor}`);
      assert.ok(expected.length >= 3, `${instant}: only ${expected.length} entries fall in the window, too few to read`);
      for (const route of THE_WEEK_PAGES) {
        const lines = linesOf(served.pages.get(route)!);
        assert.deepStrictEqual(lines.map(line => `${dateOf(line)} ${line.vendor}`), expected, `${route} at ${instant}`);
        const summaries = expectedLines(served).map(entry => entry.summary);
        lines.forEach((line, i) => assert.ok(line.text.startsWith(summaries[i]!), `${route} at ${instant}: "${line.text}" does not print "${summaries[i]}"`));
      }
    }
  });

  it("leaves out a record the week already lists, and keeps a date quoted from a record the week lists", () => {
    const served = at(WEDNESDAY);
    assert.ok(served.api.some(entry => entry.vendor === LATER_IN_THE_WEEK.vendor), "/api/deadlines does not hold the record dated later this week, so the check below reads nothing");
    for (const route of THE_WEEK_PAGES) {
      const page = served.pages.get(route)!;
      assert.ok(withoutTheSection(page).includes(LATER_IN_THE_WEEK.vendor), `${route} does not list ${LATER_IN_THE_WEEK.vendor} in its week`);
      const vendors = vendorsListed(WEDNESDAY, route);
      assert.ok(!vendors.includes(LATER_IN_THE_WEEK.vendor), `${route} lists ${LATER_IN_THE_WEEK.vendor} in its week and again as coming up`);
      assert.ok(vendors.includes(TOMORROW_S.vendor), `${route}: ${vendors.join(", ")}`);
      const quoted = linesOf(page).find(line => line.vendor === QUOTED_DATE.vendor);
      assert.ok(quoted, `${route} leaves out the date ${QUOTED_DATE.vendor}'s record quotes`);
      assert.strictEqual(dateOf(quoted!), "2026-11-20");
    }
  });

  it("prints each entry's date, vendor link and summary as the deadline tracker prints them", () => {
    for (const instant of [SUNDAY, WEDNESDAY]) {
      const cards = deadlineCardsOf(at(instant).deadlinesHtml);
      assert.ok(cards.length >= 3, `${instant}: read only ${cards.length} cards on /deadlines`);
      for (const route of THE_WEEK_PAGES) {
        for (const line of linesOf(at(instant).pages.get(route)!)) {
          const card = cards.find(c => c.dateLabel === line.dateLabel && c.vendor === line.vendor && c.summaryHtml === line.summaryHtml);
          assert.ok(card, `${route} at ${instant}: no /deadlines card prints ${line.dateLabel} ${line.vendor}: ${line.text}`);
          assert.strictEqual(hrefOf(line.vendorHtml), card!.vendorHref, `${route} at ${instant}: ${line.vendor}'s link`);
        }
      }
    }
  });

  it("links the vendor's page wherever the deadline tracker does", () => {
    const linked = THE_WEEK_PAGES.flatMap(route => linesOf(at(SUNDAY).pages.get(route)!)).filter(line => hrefOf(line.vendorHtml) !== null);
    assert.ok(linked.length > 0, "no entry links a vendor page, so the link check above reads nothing");
  });

  it("says the calendar decides the section and links the deadline tracker and the change log", () => {
    for (const route of THE_WEEK_PAGES) {
      const section = sectionOf(at(SUNDAY).pages.get(route)!)!;
      const rule = section.match(/<p class="dated-rule">([\s\S]*?)<\/p>/)?.[1];
      assert.ok(rule, `${route} prints no rule under the section`);
      assert.ok(rule!.startsWith(A_DATED_SECTION_MARKER), `${route}: ${rule}`);
      assert.ok(rule!.includes('href="/deadlines"'), `${route}: ${rule}`);
      assert.ok(rule!.includes('href="/changes"'), `${route}: ${rule}`);
      assert.ok(section.lastIndexOf("<li>") < section.indexOf('<p class="dated-rule">'), `${route} prints its rule before its last entry`);
    }
  });

  it("follows the week's changes and comes before the share links on /this-week and the RSS box on the digest", () => {
    const thisWeek = at(SUNDAY).pages.get(THIS_WEEK)!;
    const section = thisWeek.indexOf(`<h2>${COMING_UP_HEADING}</h2>`);
    assert.ok(section > thisWeek.lastIndexOf('<section class="tw-section">'), "/this-week prints the section before the week's changes");
    assert.ok(section < thisWeek.indexOf('<div class="tw-share">'), "/this-week prints the section after its share links");
    const digest = at(SUNDAY).pages.get(THE_WEEK)!;
    const inTheDigest = digest.indexOf(`<h2>${COMING_UP_HEADING}</h2>`);
    assert.ok(inTheDigest > digest.lastIndexOf('<div class="impact-section">'), `${THE_WEEK} prints the section before the week's changes`);
    assert.ok(inTheDigest < digest.indexOf('<div class="rss-cta">'), `${THE_WEEK} prints the section after its RSS box`);
  });

  it("leaves a week that has ended, a week that has not started and an earlier week on /this-week as they were", () => {
    for (const instant of [SUNDAY, WEDNESDAY]) {
      for (const route of [THE_WEEK_BEFORE, THE_WEEK_AFTER, LAST_WEEK_ON_THIS_WEEK]) {
        assert.strictEqual(sectionOf(at(instant).pages.get(route)!), null, `${route} at ${instant} prints the section`);
      }
    }
    assert.ok(expectedLines(at(SUNDAY)).length > 0, "nothing falls in the window on the day read, so the absence above proves nothing");
  });

  it("prints no section when no deadline falls in the next 30 days", () => {
    const served = at(NOTHING_AHEAD);
    assert.deepStrictEqual(expectedLines(served), [], `${NOTHING_AHEAD}: the tracker holds an entry in the window, so this reads nothing`);
    for (const route of [THIS_WEEK, THE_CURRENT_DIGEST]) {
      const page = served.pages.get(route)!;
      assert.ok(page.includes("This Week in Developer Pricing") || page.includes("Pricing Changes:"), `${route} at ${NOTHING_AHEAD} is not the week's page`);
      assert.ok(!page.includes(COMING_UP_HEADING), `${route} prints the heading with nothing under it`);
    }
  });

  it("serves the section on the digest page of the week holding the day served", () => {
    for (const instant of [SUNDAY, WEDNESDAY]) {
      assert.strictEqual(at(instant).pages.get(THE_CURRENT_DIGEST), at(instant).pages.get(THE_WEEK), `${THE_CURRENT_DIGEST} at ${instant} is not ${THE_WEEK}`);
      assert.ok(sectionOf(at(instant).pages.get(THE_WEEK)!) !== null, `${THE_WEEK} at ${instant}`);
    }
  });
});

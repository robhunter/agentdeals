import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { assertPopulationFloor } from "./population-floor.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PER_CHANGE_FEED,
  WEEKLY_DIGEST_FEED,
  CHANGE_FEED_ENTRY_LIMIT,
  changeTypeFeedLabel,
  channelUpdatedTimestamp,
  feedEntrySummary,
  recordedOn,
} from "../dist/change-feed.js";
import { weekRangeLabel, changeEntryDateLabel, DISCOVERED_DATE_PREFIX, EFFECTIVE_DATE_PREFIX, UNKNOWN_EFFECTIVE_DATE_MARKER } from "../dist/change-dates.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const ATOM = "{http://www.w3.org/2005/Atom}";
const FEED_ROUTES = ["/pricing-changes/feed.xml", "/feed.xml", "/api/feed"];
const FEED_ALIASES = ["/rss", "/feed", "/atom"];

const TODAY = new Date().toISOString().slice(0, 10);
const dayOffset = (days: number) =>
  new Date(Date.parse(TODAY) + days * 86400000).toISOString().slice(0, 10);

interface Entry {
  title: string;
  updated: string;
  summary: string;
  dateSource: string;
  recordedDate: string;
  effectiveDate: string | null;
  anchorDate: string;
}

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? unescapeXml(m[1]) : null;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function argumentList(source: string, openParen: number): string | null {
  let depth = 0;
  for (let i = openParen; i < source.length; i++) {
    const c = source[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return source.slice(openParen + 1, i);
    }
  }
  return null;
}

function holdsATopLevelComma(args: string): boolean {
  let depth = 0;
  for (const c of args) {
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) return true;
  }
  return false;
}

function parseEntries(doc: string): Entry[] {
  return [...doc.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
    const body = m[1];
    return {
      title: tag(body, "title") ?? "",
      updated: tag(body, "updated") ?? "",
      summary: tag(body, "summary") ?? "",
      dateSource: tag(body, "ad:date_source") ?? "",
      recordedDate: tag(body, "ad:recorded_date") ?? "",
      effectiveDate: tag(body, "ad:effective_date"),
      anchorDate: (body.match(/#[a-z0-9-]*?(\d{4}-\d{2}-\d{2})" rel="alternate"/) ?? ["", ""])[1],
    };
  });
}

function storedChanges(): Record<string, unknown>[] {
  const raw = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8"));
  return Array.isArray(raw) ? raw : raw.changes;
}

function fixtureChange(vendor: string, date: string, dateSource: string, recordedDate: string) {
  return {
    vendor,
    change_type: "limits_reduced",
    date,
    date_source: dateSource,
    summary: `${vendor} free allowance cut.`,
    previous_state: "15 GB storage",
    current_state: "5 GB storage",
    impact: "high",
    source_url: `https://example.com/${vendor.toLowerCase()}/pricing`,
    category: "Databases",
    alternatives: [],
    recorded_date: recordedDate,
    ...(dateSource === "discovered" ? { detected_by: "reverify-ai" } : {}),
  };
}

function startServer(changesPath?: string): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: "0",
        BASE_URL: "http://localhost:3000",
        TZ: "UTC",
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

describe("the change feeds date every entry by when we recorded it and say what its date means", () => {
  const servers: ChildProcess[] = [];
  let tmp = "";
  let port = 0;
  let perChange = "";
  let weekly = "";
  let entries: Entry[] = [];
  let apiChanges: Record<string, any> = {};
  let startedAt = "";

  before(async () => {
    const live = await startServer();
    servers.push(live.proc);
    port = live.port;
    startedAt = new Date().toISOString();
    perChange = await (await fetch(`http://localhost:${port}${PER_CHANGE_FEED.path}`)).text();
    weekly = await (await fetch(`http://localhost:${port}${WEEKLY_DIGEST_FEED.path}`)).text();
    entries = parseEntries(perChange);
    apiChanges = await (
      await fetch(`http://localhost:${port}/api/changes?limit=2000&since=2000-01-01`)
    ).json();
  });

  after(() => {
    for (const proc of servers) proc.kill();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("carries an entry for each of the most recently recorded changes", () => {
    assert.strictEqual(entries.length, CHANGE_FEED_ENTRY_LIMIT);
  });

  function recordFor(entry: Entry): Record<string, any> | undefined {
    const vendor = entry.title.slice(0, entry.title.lastIndexOf(": "));
    return apiChanges.changes.find(
      (c: any) => c.vendor === vendor && c.date === entry.anchorDate
    );
  }

  it("agrees with /api/changes about the provenance of every entry it publishes", () => {
    let checked = 0;
    for (const entry of entries) {
      const record = recordFor(entry);
      if (!record) continue;
      checked++;
      assert.strictEqual(
        entry.dateSource,
        record.date_source,
        `${entry.title}: feed says ${entry.dateSource}, /api/changes says ${record.date_source}`
      );
    }
    assert.strictEqual(checked, entries.length, `matched only ${checked} of ${entries.length} entries back to /api/changes`);
  });

  it("states inside every entry whether its date is when the terms changed or when we read the page", () => {
    const unlabelled = entries.filter((e) => {
      const record = recordFor(e);
      if (!record) return true;
      return !e.summary.startsWith(changeEntryDateLabel(record as any));
    });
    assert.deepStrictEqual(unlabelled.map((e) => `${e.title} — ${e.summary.slice(0, 60)}`), []);
  });

  it("dates an entry in the same words as the page the entry links to", async () => {
    const page = await (await fetch(`http://localhost:${port}/pricing-changes`)).text();
    const rendered = page.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const absent = entries.filter((e) => {
      const record = recordFor(e);
      return !record || !rendered.includes(changeEntryDateLabel(record as any));
    });
    assert.deepStrictEqual(absent.map((e) => `${e.title} — ${e.summary.slice(0, 50)}`), []);
  });

  it("tells an entry read on its own that a discovery date is a reading date", () => {
    const discovered = entries.filter((e) => e.dateSource === "discovered");
    assert.ok(discovered.length > 0, "no discovered entry in the feed to check");
    for (const entry of discovered) {
      assert.match(entry.summary, /when we read the vendor's pricing page/);
      assert.match(entry.summary, /does not say when they changed/);
    }
  });

  it("gives every entry a typed date_source and recorded_date, and an effective_date only when it has one", () => {
    for (const entry of entries) {
      assert.ok(["discovered", "hand_written", "vendor_page"].includes(entry.dateSource), entry.title);
      assert.match(entry.recordedDate, /^\d{4}-\d{2}-\d{2}$/, entry.title);
      if (entry.dateSource === "discovered") assert.strictEqual(entry.effectiveDate, null, entry.title);
      else assert.match(entry.effectiveDate ?? "", /^\d{4}-\d{2}-\d{2}$/, entry.title);
    }
  });

  it("declares in the feed document how many of its entries are dated by discovery", () => {
    const subtitle = tag(perChange, "subtitle") ?? "";
    const discovered = entries.filter((e) => e.dateSource === "discovered").length;
    assert.ok(
      subtitle.includes(`${discovered} of ${entries.length} are dated by discovery`),
      `subtitle does not state the ${discovered} discovered entries: ${subtitle}`
    );
  });

  it("says in each feed which population it counts, so the two are reconcilable", () => {
    assert.match(tag(perChange, "subtitle") ?? "", /Weekly Pricing Digest/);
    assert.match(tag(weekly, "subtitle") ?? "", /only changes with a known effective date/);
    assert.match(tag(weekly, "subtitle") ?? "", /read for the first time/);
  });

  it("never stamps a feed as generated later than it was generated", async () => {
    const now = new Date().toISOString();
    for (const route of FEED_ROUTES) {
      const doc = await (await fetch(`http://localhost:${port}${route}`)).text();
      const channel = doc.slice(0, doc.indexOf("<entry>"));
      const updated = tag(channel, "updated") ?? "";
      assert.ok(updated <= now, `${route} channel <updated> is ${updated}, later than ${now}`);
      assert.ok(updated >= "2000-01-01", `${route} has no channel <updated>`);
    }
  });

  it("never dates an entry later than the moment the document was served", () => {
    const late = entries.filter((e) => e.updated > startedAt);
    assert.deepStrictEqual(late.map((e) => `${e.title} ${e.updated}`), []);
  });

  it("dates every stamp in a document from the clock the document was built with", () => {
    const source = readFileSync(path.join(REPO, "src", "serve.ts"), "utf8");
    const readsItsOwnClock: string[] = [];
    for (const call of ["feedEntryFields", "feedEntryUpdated", "feedUpdatedTimestamp", "channelUpdatedTimestamp"]) {
      for (const m of source.matchAll(new RegExp(`\\b${call}\\(`, "g"))) {
        const args = argumentList(source, m.index! + m[0].length - 1);
        if (args !== null && !holdsATopLevelComma(args)) readsItsOwnClock.push(`${call}(${args})`);
      }
    }
    assert.deepStrictEqual(readsItsOwnClock, [], `feed stamps built from a clock of their own: ${readsItsOwnClock.join(", ")}`);
  });

  it("hands a reader who polls twice the same stamps, so nothing is re-announced", async () => {
    const stamps = (doc: string) => [...doc.matchAll(/<updated>([^<]+)<\/updated>/g)].map(([, s]) => s);
    for (const route of [...FEED_ROUTES, WEEKLY_DIGEST_FEED.path]) {
      const first = stamps(await (await fetch(`http://localhost:${port}${route}`)).text());
      const second = stamps(await (await fetch(`http://localhost:${port}${route}`)).text());
      assert.ok(first.length > 0, `${route} carries no <updated>`);
      assert.deepStrictEqual(second, first, `${route} dates its entries by the moment it was asked`);
    }
  });

  it("orders entries newest recorded first", () => {
    for (let i = 0; i + 1 < entries.length; i++) {
      assert.ok(
        entries[i].updated >= entries[i + 1].updated,
        `${entries[i].title} (${entries[i].updated}) precedes ${entries[i + 1].title} (${entries[i + 1].updated})`
      );
    }
  });

  it("serves every feed route as parseable Atom and points every alias at one of them", async () => {
    for (const route of FEED_ROUTES) {
      const res = await fetch(`http://localhost:${port}${route}`);
      assert.strictEqual(res.status, 200, route);
      assert.match(res.headers.get("content-type") ?? "", /application\/atom\+xml/, route);
      const doc = await res.text();
      assert.ok(doc.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), route);
      assert.ok(doc.includes(ATOM.slice(1, -1)), `${route} is not in the Atom namespace`);
      assert.ok((tag(doc, "title") ?? "").length > 0, `${route} has no title`);
    }
    for (const alias of FEED_ALIASES) {
      const res = await fetch(`http://localhost:${port}${alias}`, { redirect: "manual" });
      assert.strictEqual(res.status, 301, alias);
      const target = res.headers.get("location") ?? "";
      assert.ok(FEED_ROUTES.includes(target), `${alias} redirects to ${target}, which is not a feed route`);
    }
  });

  it("gives a feed link the title of the document it resolves to, on every page in the sitemap", async () => {
    const index = await (await fetch(`http://localhost:${port}/sitemap.xml`)).text();
    const paths = new Set<string>();
    for (const m of index.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const child = new URL(m[1]).pathname;
      if (!/\.xml$/.test(child)) {
        paths.add(child);
        continue;
      }
      const inner = await (await fetch(`http://localhost:${port}${child}`)).text();
      for (const loc of inner.matchAll(/<loc>([^<]+)<\/loc>/g)) paths.add(new URL(loc[1]).pathname);
    }
    assertPopulationFloor(paths.size, 1500, "pages in the sitemap");

    const documentTitle = new Map<string, string>();
    for (const route of FEED_ROUTES) {
      const doc = await (await fetch(`http://localhost:${port}${route}`)).text();
      documentTitle.set(route, tag(doc, "title") ?? "");
    }

    const queue = [...paths];
    const mismatched: string[] = [];
    let carrying = 0;
    async function worker() {
      for (;;) {
        const route = queue.shift();
        if (!route) return;
        const res = await fetch(`http://localhost:${port}${route}`);
        if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/html")) continue;
        const html = await res.text();
        for (const m of html.matchAll(/<link[^>]*rel="alternate"[^>]*>/g)) {
          if (!/application\/atom\+xml/.test(m[0])) continue;
          carrying++;
          const title = unescapeXml((m[0].match(/title="([^"]*)"/) ?? ["", ""])[1]);
          const href = (m[0].match(/href="([^"]*)"/) ?? ["", ""])[1];
          const target = href.replace(/^https?:\/\/[^/]+/, "");
          const served = documentTitle.get(target);
          if (served === undefined) mismatched.push(`${route} links ${href}, which is not a feed route`);
          else if (served !== title) mismatched.push(`${route} advertises "${title}" and ${target} is titled "${served}"`);
        }
      }
    }
    await Promise.all(Array.from({ length: 8 }, worker));
    assertPopulationFloor(carrying, 1500, "feed links across the sitemap");
    assert.deepStrictEqual(mismatched.slice(0, 20), []);
  });

  it("names every change type the catalogue holds", () => {
    const raw = new Set<string>();
    for (const c of storedChanges()) {
      const label = changeTypeFeedLabel(String(c.change_type));
      if (/_/.test(label) || label === String(c.change_type)) raw.add(String(c.change_type));
    }
    assert.deepStrictEqual([...raw], []);
  });

  it("keeps a future effective date out of the newest position", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "change-feed-provenance-"));
    const changesPath = path.join(tmp, "changes.json");
    const injected = [
      fixtureChange("Fixture Announced", dayOffset(30), "vendor_page", dayOffset(-400)),
      fixtureChange("Fixture Recorded Today", dayOffset(-1), "discovered", TODAY),
    ];
    writeFileSync(changesPath, JSON.stringify({ changes: [...storedChanges(), ...injected] }));
    const fixture = await startServer(changesPath);
    servers.push(fixture.proc);
    const doc = await (
      await fetch(`http://localhost:${fixture.port}${PER_CHANGE_FEED.path}`)
    ).text();
    const fixtureEntries = parseEntries(doc);
    assert.ok(
      !fixtureEntries.some((e) => e.title.startsWith("Fixture Announced")),
      "a change effective in 30 days, recorded over a year ago, reached the newest 50"
    );
    const recordedToday = fixtureEntries.findIndex((e) => e.title.startsWith("Fixture Recorded Today"));
    assert.notStrictEqual(recordedToday, -1, "a change recorded today did not reach the feed");
    const channel = doc.slice(0, doc.indexOf("<entry>"));
    assert.ok((tag(channel, "updated") ?? "") <= new Date().toISOString(), "the injected future date reached the channel stamp");
  });
});

describe("a week that crosses a month or a year says so", () => {
  it("names the month a week ends in when it differs from the month it starts in", () => {
    assert.strictEqual(weekRangeLabel("2026-08-31", "2026-09-06"), "August 31–September 6, 2026");
  });

  it("names one month when the week sits inside it", () => {
    assert.strictEqual(weekRangeLabel("2026-09-07", "2026-09-13"), "September 7–13, 2026");
  });

  it("names both years when a week crosses one", () => {
    assert.strictEqual(weekRangeLabel("2026-12-28", "2027-01-03"), "December 28, 2026–January 3, 2027");
  });
});

describe("a feed entry summary states its own date provenance", () => {
  const base = {
    vendor: "Example",
    change_type: "limits_reduced" as const,
    summary: "The free tier now offers 1 GB.",
    previous_state: "",
    current_state: "",
    impact: "low" as const,
    source_url: "https://example.com/pricing",
    category: "Databases",
    alternatives: [] as string[],
  };

  it("reports a discovered date as a reading date", () => {
    const text = feedEntrySummary({
      ...base,
      date: "2026-09-05",
      date_source: "discovered",
      recorded_date: "2026-09-05",
    } as any);
    assert.ok(text.startsWith(`${DISCOVERED_DATE_PREFIX} 2026-09-05 · ${UNKNOWN_EFFECTIVE_DATE_MARKER}`), text);
    assert.ok(text.endsWith(base.summary), text);
  });

  it("reports an event date as an effective date beside the day we recorded it", () => {
    const text = feedEntrySummary({
      ...base,
      date: "2026-06-15",
      date_source: "vendor_page",
      recorded_date: "2026-09-04",
    } as any);
    assert.ok(text.startsWith(`${EFFECTIVE_DATE_PREFIX} 2026-06-15 · recorded 2026-09-04.`), text);
  });

  it("falls back to the change date when no recorded date is stored", () => {
    assert.strictEqual(recordedOn({ date: "2026-01-01", date_source: "discovered" } as any), "2026-01-01");
  });
});

describe("a channel stamp is held to the moment the document was generated", () => {
  const now = new Date("2026-09-07T18:00:00.000Z");

  it("takes the newest entry stamp when every entry is in the past", () => {
    const stamps = ["2026-09-01T12:00:00.000Z", "2026-09-05T12:00:00.000Z", "2026-08-30T12:00:00.000Z"];
    assert.strictEqual(channelUpdatedTimestamp(stamps, now), "2026-09-05T12:00:00.000Z");
  });

  it("does not adopt an entry stamp that is later than now", () => {
    const stamps = ["2026-09-05T12:00:00.000Z", "2026-10-07T00:00:00.000Z"];
    assert.strictEqual(channelUpdatedTimestamp(stamps, now), now.toISOString());
  });

  it("stamps an empty feed with the moment it was generated", () => {
    assert.strictEqual(channelUpdatedTimestamp([], now), now.toISOString());
  });
});

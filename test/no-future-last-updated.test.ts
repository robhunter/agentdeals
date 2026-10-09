import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DealChange } from "../dist/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const { vendorPageLastUpdated, newestChangeInEffect, latestEventDate } = await import("../dist/change-dates.js");
const { loadDealChanges, freeTierLongevityStart } = await import("../dist/data.js");
const { vendorSlugMap } = await import("../dist/vendor-slug.js");
const { isNoLongerInForce } = await import("../dist/change-resolution.js");

const SERVED_ON = "2026-10-06";
const TOMORROW = "2026-10-07";
const LAST_WEEK = "2026-09-29";
const LAST_READ = "2026-09-20";

function record(date: string, over: Partial<DealChange> = {}): DealChange {
  return {
    vendor: "Fixture Vendor",
    change_type: "product_deprecated",
    date,
    date_source: "vendor_page",
    summary: `Something happens on ${date}.`,
    impact: "low",
    source_url: "https://fixture.example/notice",
    ...over,
  } as DealChange;
}

describe("a vendor page is last updated no later than the day it is served", () => {
  it("does not take a record dated tomorrow as the page's last update", () => {
    assert.strictEqual(vendorPageLastUpdated([record(TOMORROW), record(LAST_WEEK)], LAST_READ, SERVED_ON), LAST_WEEK);
  });

  it("falls back to the last read when every record is dated after the serve date", () => {
    assert.strictEqual(vendorPageLastUpdated([record(TOMORROW)], LAST_READ, SERVED_ON), LAST_READ);
  });

  it("takes a record dated on the serve date as the page's last update", () => {
    assert.strictEqual(vendorPageLastUpdated([record(TOMORROW), record(SERVED_ON)], LAST_READ, SERVED_ON), SERVED_ON);
  });
});

describe("the most recent change a page names has taken effect", () => {
  it("skips a change dated after the serve date", () => {
    const newest = newestChangeInEffect([record(TOMORROW), record(LAST_WEEK)], SERVED_ON);
    assert.strictEqual(newest?.date, LAST_WEEK);
  });

  it("names a change dated on the serve date", () => {
    const newest = newestChangeInEffect([record(TOMORROW), record(SERVED_ON), record(LAST_WEEK)], SERVED_ON);
    assert.strictEqual(newest?.date, SERVED_ON);
  });

  it("names none when every change is still ahead", () => {
    assert.strictEqual(newestChangeInEffect([record(TOMORROW)], SERVED_ON), null);
  });
});

describe("a free tier's age and the latest event date count only changes that have taken effect", () => {
  it("starts a free tier's age at the last narrowing in effect, not at one dated tomorrow", () => {
    const start = freeTierLongevityStart(
      [record(TOMORROW, { change_type: "limits_reduced" }), record(LAST_WEEK, { change_type: "limits_reduced" })],
      new Date(LAST_READ),
      SERVED_ON,
    );
    assert.strictEqual(start.toISOString().slice(0, 10), LAST_WEEK);
  });

  it("starts a free tier's age at its verified date while its only narrowing is still ahead", () => {
    const start = freeTierLongevityStart([record(TOMORROW, { change_type: "free_tier_removed" })], new Date(LAST_READ), SERVED_ON);
    assert.strictEqual(start.toISOString().slice(0, 10), LAST_READ);
  });

  it("leaves a record dated after today out of the latest event date when no day is given", () => {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10);
    assert.strictEqual(latestEventDate([record(tomorrow), record(LAST_WEEK)]), LAST_WEEK);
  });
});

describe("a record that has not taken effect is not a listing's recent change, does not restart its free tier's age, and does not date the change log", () => {
  const today = new Date().toISOString().slice(0, 10);
  const dayOffset = (days: number) => new Date(Date.parse(today) + days * 86400000).toISOString().slice(0, 10);
  const DAY_MS = 86400000;
  let proc: ChildProcess | null = null;
  let base = "";
  let scratch = "";

  const listing = (vendor: string, category = "Databases", verifiedDate = dayOffset(-60)) => ({
    vendor,
    category,
    description: `${vendor} publishes a free allowance of 10 GB storage and 1M reads per month.`,
    tier: "Free",
    url: `https://example.com/${vendor.toLowerCase()}/pricing`,
    tags: ["database"],
    verifiedDate,
    source_check: { checked: verifiedDate, outcome: "ok", detail: `the page names ${vendor} and states "10 GB storage"` },
  });

  const change = (vendor: string, date: string, change_type: string) => ({
    vendor,
    change_type,
    date,
    date_source: "vendor_page",
    summary: `${vendor} changes the terms of its free allowance on ${date}.`,
    previous_state: "10 GB storage",
    current_state: "2 GB storage",
    impact: "medium",
    source_url: `https://example.com/${vendor.toLowerCase()}/pricing`,
    category: "Databases",
    alternatives: [],
    recorded_date: dayOffset(-1),
  });

  before(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "not-yet-in-effect-"));
    const indexPath = path.join(scratch, "index.json");
    const changesPath = path.join(scratch, "deal_changes.json");
    writeFileSync(indexPath, JSON.stringify({
      offers: [
        ...["Larkspurdb", "Moorhenapi", "Nettlecache", "Pipitstore"].map((vendor) => listing(vendor)),
        listing("Osprelay", "Monitoring", dayOffset(2)),
      ],
    }));
    writeFileSync(changesPath, JSON.stringify({
      changes: [
        change("Larkspurdb", dayOffset(1), "limits_reduced"),
        change("Larkspurdb", dayOffset(-30), "limits_reduced"),
        change("Moorhenapi", dayOffset(5), "new_tier"),
        change("Pipitstore", dayOffset(-400), "free_tier_removed"),
      ],
    }));
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_INDEX_PATH: indexPath, AGENTDEALS_CHANGES_PATH: changesPath },
    });
    proc = child;
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timeout); resolve(parseInt(m[1], 10)); }
      });
    });
    base = `http://localhost:${port}`;
  });

  after(() => {
    proc?.kill();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  const recentChangeOf = async (vendor: string) => {
    const body = await (await fetch(`${base}/api/offers?q=${vendor}`)).json();
    const offer = body.offers.find((o: { vendor: string }) => o.vendor === vendor);
    assert.ok(offer, `/api/offers?q=${vendor} did not return ${vendor}`);
    return offer.recent_change as string | null;
  };

  const jsonLdOf = (html: string) =>
    [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

  it("names the change in effect, not tomorrow's, as the listing's recent change on the API and the search page", async () => {
    assert.match((await recentChangeOf("Larkspurdb")) ?? "", new RegExp(`^${dayOffset(-30)}: `));
    const search = await (await fetch(`${base}/search?q=Larkspurdb`)).text();
    const cardLines = search.match(/<div class="result-meta">[\s\S]*?<\/div>/)?.[0] ?? "";
    assert.ok(cardLines.includes(`${dayOffset(-30)}: Larkspurdb`), "the search card does not print the change in effect");
    assert.ok(!cardLines.includes(dayOffset(1)), `the search card prints the change dated ${dayOffset(1)} as its recent change`);
  });

  it("names no recent change for a listing whose only record is still ahead", async () => {
    assert.strictEqual(await recentChangeOf("Moorhenapi"), null);
  });

  it("counts a free tier's age from the narrowing in effect, not from tomorrow's", async () => {
    const expected = Math.floor((Date.now() - Date.parse(dayOffset(-30))) / DAY_MS);
    const served = (await (await fetch(`${base}/api/vendor-risk/larkspurdb`)).json()).free_tier_longevity_days;
    assert.ok(Math.abs(served - expected) <= 1, `Larkspurdb's free tier is ${served} days old where ${expected} were expected`);
  });

  it("gives a free tier verified after the day it is served an age that cannot be read as a measurement, not 0", async () => {
    const served = (await (await fetch(`${base}/api/vendor-risk/osprelay`)).json()).free_tier_longevity_days;
    assert.ok(typeof served === "number" && served < 0, `Osprelay, verified on ${dayOffset(2)}, has a free tier ${served} days old`);
  });

  it("dates the change log's last modification and its coverage by the newest change in effect", async () => {
    const dataset = jsonLdOf(await (await fetch(`${base}/pricing-changes`)).text()).find((ld) => ld["@type"] === "Dataset");
    assert.ok(dataset, "/pricing-changes publishes no Dataset");
    assert.strictEqual(dataset.dateModified, dayOffset(-30));
    assert.strictEqual(dataset.temporalCoverage, `${dayOffset(-400)}/${dayOffset(-30)}`);
  });

  it("dates the vendor page by the change in effect", async () => {
    const page = await (await fetch(`${base}/vendor/larkspurdb`)).text();
    const modified = [...page.matchAll(/"dateModified":"(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]);
    assert.ok(modified.length > 0, "/vendor/larkspurdb publishes no dateModified");
    assert.deepStrictEqual([...new Set(modified)], [dayOffset(-30)]);
  });

  it("keeps out of Stable Picks a vendor whose only record is still ahead and a vendor rated below stable, and names the stable vendor with no record", async () => {
    const page = await (await fetch(`${base}/trends/databases`)).text();
    const section = page.split("<h2>Stable Picks</h2>")[1]?.split("<h2")[0] ?? "";
    const named = [...section.matchAll(/href="\/vendor\/([^"]+)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(named, ["nettlecache"]);
  });
});

describe("served vendor and alternatives pages print no date after the serve date as a past update", () => {
  let proc: ChildProcess | null = null;
  let port = 0;

  before(async () => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    proc = child;
    port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timeout); resolve(parseInt(m[1], 10)); }
      });
    });
  });

  after(() => { proc?.kill(); });

  it("keeps Last updated, dateModified and the most recent change on or before today, and still lists what is ahead", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const ahead = new Map<string, DealChange[]>();
    for (const c of loadDealChanges() as DealChange[]) {
      if (c.date <= today || isNoLongerInForce(c)) continue;
      for (const [slug, vendor] of vendorSlugMap as Map<string, string>) {
        if (vendor.toLowerCase() === c.vendor.toLowerCase()) ahead.set(slug, [...(ahead.get(slug) ?? []), c]);
      }
    }
    const wrong: string[] = [];
    const slugs = [...(vendorSlugMap as Map<string, string>).keys()];
    for (let i = 0; i < slugs.length; i += 16) {
      await Promise.all(slugs.slice(i, i + 16).map(async (slug) => {
        const page = await (await fetch(`http://localhost:${port}/vendor/${slug}`)).text();
        if (!page.includes("<h1")) return;
        const lastUpdated = page.match(/Last updated (\d{4}-\d{2}-\d{2})\./)?.[1];
        const modified = [...page.matchAll(/"dateModified":"(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]);
        if (lastUpdated && lastUpdated > today) wrong.push(`/vendor/${slug}: Last updated ${lastUpdated}`);
        const changedAnswer = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
          .map((m) => JSON.parse(m[1]))
          .find((ld) => ld["@type"] === "FAQPage")
          ?.mainEntity?.find((q: { name: string }) => /^What changed in /.test(q.name))?.acceptedAnswer?.text as string | undefined;
        const mostRecently = changedAnswer?.match(/Most recently: [\s\S]*\(([^()]*?(\d{4}-\d{2}-\d{2})[^()]*)\)\.(?: [^()]*)?$/)?.[2];
        if (mostRecently && mostRecently > today) wrong.push(`/vendor/${slug}: most recent change ${mostRecently}`);
        for (const d of modified) if (d > today) wrong.push(`/vendor/${slug}: dateModified ${d}`);
        for (const upcoming of ahead.get(slug) ?? []) {
          if (!page.includes(upcoming.date)) wrong.push(`/vendor/${slug}: no longer lists the change dated ${upcoming.date}`);
        }
      }));
    }
    for (const slug of ahead.keys()) {
      const response = await fetch(`http://localhost:${port}/alternative-to/${slug}`);
      if (response.status !== 200) continue;
      const text = (await response.text()).replace(/<[^>]+>/g, " ");
      const named = text.match(/The most recent was (?:on|discovered) (\d{4}-\d{2}-\d{2})/)?.[1];
      if (named && named > today) wrong.push(`/alternative-to/${slug}: most recent change ${named}`);
    }
    assert.deepStrictEqual(wrong, []);
  });
});

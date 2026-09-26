import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DealChange } from "../dist/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const { vendorPageLastUpdated, newestChangeInEffect } = await import("../dist/change-dates.js");
const { loadDealChanges } = await import("../dist/data.js");
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

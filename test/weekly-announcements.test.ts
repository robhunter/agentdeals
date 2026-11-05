import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateDealChanges } from "../scripts/validate-data.ts";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const note = "3 changes announced this week take effect later.";
const intro = "These changes were announced this week but take effect after this week. A change announced and taking effect in the same week is listed with the changes that took effect.";
const unescapeXml = (s: string) => s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
const text = (s: string) => unescapeXml(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

function change(vendor: string, date: string, announced_on?: string) {
  return { vendor, date, ...(announced_on ? { announced_on } : {}), change_type: "pricing_restructured", date_source: "vendor_page", category: "AI / ML", impact: "medium", summary: `${vendor} changes its pricing.`, previous_state: "Earlier terms", current_state: "Later terms", source_url: `https://example.com/${vendor.replaceAll(" ", "-")}`, alternatives: [], listing_effect: "none" };
}

type Record = ReturnType<typeof change>;
async function withServer(records: Record[], check: (get: (route: string) => Promise<string>) => Promise<void>) {
  const scratch = mkdtempSync(path.join(tmpdir(), "weekly-announcements-"));
  writeFileSync(path.join(scratch, "changes.json"), JSON.stringify({ changes: records }));
  writeFileSync(path.join(scratch, "index.json"), JSON.stringify({ offers: [{ vendor: "Sooner Vendor", category: "AI / ML", description: "A developer service with a documented public pricing plan.", tier: "Free", url: "https://example.com/pricing", tags: [], verifiedDate: "2026-11-02" }] }));
  let proc: ChildProcess | undefined;
  try {
    const base = await new Promise<string>((resolve, reject) => {
      proc = spawn("node", ["--import", path.join(REPO, "scripts/shifted-clock.mjs"), path.join(REPO, "dist/serve.js")], {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, TZ: "UTC", PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_INDEX_PATH: path.join(scratch, "index.json"), AGENTDEALS_CHANGES_PATH: path.join(scratch, "changes.json"), AGENTDEALS_CLOCK_SHIFT_MS: String(Date.parse("2026-11-05T12:00:00Z") - Date.now()) },
      });
      const timeout = setTimeout(() => { proc?.kill(); reject(new Error("Server startup timeout")); }, 30000);
      proc.stderr!.on("data", data => {
        const port = String(data).match(/running on http:\/\/localhost:(\d+)/)?.[1];
        if (port) { clearTimeout(timeout); resolve(`http://localhost:${port}`); }
      });
      proc.once("error", error => { clearTimeout(timeout); reject(error); });
      proc.once("exit", code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
    });
    await check(async route => {
      const res = await fetch(base + route);
      assert.equal(res.status, 200, route);
      return res.text();
    });
  } finally {
    if (proc && proc.exitCode === null) {
      proc.kill();
      await new Promise(resolve => proc!.once("exit", resolve));
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

function announcedSection(html: string) {
  const body = html.match(/<section class="[^"]*weekly-announcements">([\s\S]*?)<\/section>/)?.[1];
  assert.ok(body, "weekly announcement section exists");
  return body;
}

describe("weekly vendor announcements", () => {
  it("validates real calendar dates and rejects dates after the effective date", () => {
    for (const value of [null, undefined, "", true, 20261102, [], {}, "2026-1-02", "2026-02-29", "2026-04-31", "2026-13-01", "not-a-date", "2026-01-15T00:00:00Z", "2026-11-10"]) {
      const row = { ...change("Example", "2026-11-09"), announced_on: value };
      assert.ok(validateDealChanges([row as never]).some(e => e.field === "announced_on"), JSON.stringify(value));
    }
    for (const value of ["2024-02-29", "2026-11-09", "2026-11-02"]) {
      assert.deepEqual(validateDealChanges([{ ...change("Example", "2026-11-09"), announced_on: value }]), []);
    }
    assert.deepEqual(validateDealChanges([change("Example", "2026-11-09")]), []);
  });

  it("lists the same ordered announcements and count on every weekly surface", async () => {
    const records = [
      change("Later Vendor", "2026-12-20", "2026-11-02"),
      change("Same Week", "2026-11-05", "2026-11-02"),
      change("Last Week", "2026-12-03", "2026-11-01"),
      change("Sooner Vendor", "2026-11-09", "2026-11-08"),
      change("Middle Vendor", "2026-12-01", "2026-11-04"),
      change("Next Week", "2026-12-02", "2026-11-09"),
      change("Week Ends", "2026-11-08", "2026-11-08"),
      change("No Announcement", "2026-12-04"),
      { ...change("Correction", "2026-12-04", "2026-11-02"), change_type: "record_corrected" },
      { ...change("Withdrawn", "2026-12-04", "2026-11-02"), resolution: { state: "retracted", date: "2026-11-03", summary: "Withdrawn", source_url: "https://example.com/withdrawn" } },
      { ...change("Housekeeping", "2026-12-04", "2026-11-02"), current_state: "Removed from index" },
    ];
    await withServer(records, async get => {
      const digest = JSON.parse(await get("/api/digest/weekly?limit=1"));
      assert.equal(digest.announced_in_week, 3);
      assert.equal(digest.announcement_note, note);
      assert.deepEqual(digest.announced_changes.map((c: Record) => c.vendor), ["Sooner Vendor", "Middle Vendor", "Later Vendor"]);
      assert.equal(digest.changes_in_week, 2);
      assert.equal(digest.top_changes.length, 1);
      assert.ok(digest.headline.includes("across 2 developer tool pricing changes"));
      for (const route of ["/this-week", "/this-week?week=0", "/digest/2026-w45"]) {
        const html = await get(route);
        const section = announcedSection(html);
        assert.match(text(section), /Announced this week \(3\)/);
        assert.ok(text(section).includes(intro));
        assert.ok(section.indexOf("Sooner Vendor") < section.indexOf("Middle Vendor"));
        assert.ok(section.indexOf("Middle Vendor") < section.indexOf("Later Vendor"));
        for (const vendor of ["Same Week", "Last Week", "Week Ends", "Next Week", "No Announcement", "Correction", "Withdrawn", "Housekeeping"]) assert.ok(!section.includes(vendor), vendor);
        assert.ok(text(section).includes("announced 2026-11-08 · effective 2026-11-09"));
        assert.ok(section.includes('href="https://example.com/Sooner-Vendor"'));
        assert.match(section, /class="change-source"/);
        assert.match(section, /href="\/vendor\/sooner-vendor"/);
        assert.ok(text(html).includes(note));
        assert.ok(html.match(/<meta name="description" content="([^"]*)"/)![1]!.includes(note));
        if (html.includes("Coming up (next 30 days)")) assert.ok(html.indexOf("weekly-announcements") < html.indexOf("Coming up (next 30 days)"));
      }
      for (const route of ["/api/digest/weekly?format=markdown", "/api/digest/weekly?format=html"]) {
        const body = await get(route);
        assert.ok(body.includes(note));
        assert.ok(body.includes("Announced this week (3)"));
        assert.ok(body.includes(intro));
        assert.ok(body.includes("announced 2026-11-08 · effective 2026-11-09"));
        assert.ok(body.indexOf("Sooner Vendor") < body.indexOf("Middle Vendor"));
        assert.ok(body.indexOf("Middle Vendor") < body.indexOf("Later Vendor"));
        assert.ok(body.includes("https://example.com/Sooner-Vendor"));
      }
      const xml = await get("/feed.xml");
      const entry = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]!).find(body => body.includes("urn:agentdeals:weekly-digest:2026-11-02"));
      assert.ok(entry);
      const summary = unescapeXml(entry.match(/<summary type="html">([\s\S]*?)<\/summary>/)![1]!);
      assert.ok(summary.includes(note));
      assert.ok(summary.includes("Announced this week (3)"));
      assert.ok(summary.indexOf("Sooner Vendor") < summary.indexOf("Middle Vendor"));
      assert.ok(summary.indexOf("Middle Vendor") < summary.indexOf("Later Vendor"));
      assert.ok(entry.includes('<link href="https://example.com/Sooner-Vendor" rel="via"/>'));
      assert.ok(!entry.includes("2026-12-20T00:00:00"));
      const previous = announcedSection(await get("/this-week?week=1"));
      assert.ok(previous.includes("Last Week"));
      assert.ok(!previous.includes("Sooner Vendor"));
      assert.ok(text(await get("/this-week?week=1")).includes("1 change announced this week takes effect later."));
      assert.ok(announcedSection(await get("/digest/2026-w44")).includes("Last Week"));
    });
  });

  it("keeps every announcement despite effective-list limits", async () => {
    const records = Array.from({ length: 55 }, (_, n) => change(`Announcement ${n}`, `2026-12-${String(n % 28 + 1).padStart(2, "0")}`, "2026-11-02"));
    await withServer(records, async get => {
      const digest = JSON.parse(await get("/api/digest/weekly?limit=1"));
      assert.equal(digest.announced_in_week, 55);
      assert.equal(digest.announced_changes.length, 55);
      const section = announcedSection(await get("/this-week"));
      assert.equal((section.match(/<li>/g) ?? []).length, 55);
      assert.ok(section.includes("Announcement 54"));
    });
  });

  it("publishes announcements-only weeks without dating a change as already effective", async () => {
    await withServer([change("Only Announcement", "2026-12-01", "2026-11-04")], async get => {
      const digest = JSON.parse(await get("/api/digest/weekly"));
      assert.equal(digest.changes_in_week, 0);
      assert.deepEqual(digest.top_changes, []);
      assert.equal(digest.announced_in_week, 1);
      assert.ok(announcedSection(await get("/digest/2026-w45")).includes("Only Announcement"));
      const xml = await get("/feed.xml");
      const entry = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]!).find(body => body.includes("urn:agentdeals:weekly-digest:2026-11-02"));
      assert.ok(entry);
      assert.match(entry, /<updated>2026-11-04T12:00:00(?:\.000)?Z<\/updated>/);
      assert.ok(entry.includes('<link href="https://example.com/Only-Announcement" rel="via"/>'));
      assert.ok(unescapeXml(entry).includes("1 change announced this week takes effect later."));
    });
  });

  it("omits optional announcement fields and markup when no record declares an announcement", async () => {
    await withServer([change("Effective Vendor", "2026-11-03"), change("Future Vendor", "2026-12-01")], async get => {
      const digest = JSON.parse(await get("/api/digest/weekly"));
      for (const key of ["announced_in_week", "announced_changes", "announcement_note"]) assert.ok(!Object.hasOwn(digest, key), key);
      for (const route of ["/this-week", "/digest/2026-w45", "/api/digest/weekly?format=markdown", "/api/digest/weekly?format=html", "/feed.xml"]) {
        const body = await get(route);
        assert.ok(!body.includes("Announced this week"), route);
        assert.ok(!body.includes("weekly-announcements"), route);
      }
    });
  });
});

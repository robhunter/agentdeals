import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nextShutdownDate, shutdownDates } from "../dist/shutdown-deadline.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const stages = [
  { date: "2026-12-01", label: "First <stage> & pause" },
  { date: "2027-01-10", label: "Final stage" },
];
const fixture = {
  vendor: "Stage fixture", date: "2027-01-10", recorded_date: "2026-11-01",
  change_type: "product_deprecated", date_source: "vendor_page", listing_effect: "none",
  summary: "The fixture service shuts down in stages.", previous_state: "Available", current_state: "Shut down",
  source_url: "https://example.com/stages", category: "Developer Tools", impact: "high", alternatives: [],
  shutdown_stages: [...stages].reverse(),
};

function text(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

function card(page: string, title: string, sourceUrl?: string): { html: string; section: string } {
  let section = "";
  for (const part of page.split(/(?=<h2 id=")|(?=<div class="shutdown-card")/)) {
    section = part.match(/^<h2 id="([^"]+)"/)?.[1] ?? section;
    if ((sourceUrl === undefined || part.includes(`href="${sourceUrl}"`)) && part.startsWith('<div class="shutdown-card"') && text(part.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? "") === title) {
      return { html: part.split('<div class="shutdown-links">')[0], section };
    }
  }
  throw new Error(`Missing card: ${title}`);
}

async function pages(day: string, zone: string, changes?: string, index?: string): Promise<Record<string, string>> {
  const child = spawn("node", ["--import", path.join(REPO, "scripts/shifted-clock.mjs"), path.join(REPO, "dist/serve.js")], {
    cwd: REPO, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, TZ: zone, PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_REFERRAL_HEALTH: "off",
      AGENTDEALS_CLOCK_SHIFT_MS: String(Date.parse(`${day}T12:00:00Z`) - Date.now()),
      ...(changes ? { AGENTDEALS_CHANGES_PATH: changes } : {}), ...(index ? { AGENTDEALS_INDEX_PATH: index } : {}) },
  });
  try {
    const port = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      let stderr = "";
      child.stderr!.on("data", chunk => {
        stderr += chunk.toString();
        const match = stderr.match(/running on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("exit", code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    });
    const result: Record<string, string> = {};
    for (const route of ["/shutdowns", "/deadlines"]) {
      const response = await fetch(`http://localhost:${port}${route}`);
      assert.equal(response.status, 200);
      result[route] = await response.text();
    }
    return result;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
    }
  }
}

describe("staged shutdown dates", () => {
  const entry = { deadline: "2027-01-10", stages: [...stages].reverse() };
  it("orders stages without changing their stored order", () => {
    assert.deepEqual(shutdownDates(entry), stages);
    assert.deepEqual(entry.stages, [...stages].reverse());
  });
  for (const [day, expected] of [["2026-11-14", "2026-12-01"], ["2026-12-01", "2026-12-01"], ["2026-12-02", "2027-01-10"], ["2027-01-10", "2027-01-10"], ["2027-01-11", "2027-01-10"]]) {
    it(`selects the pending date on ${day}`, () => assert.equal(nextShutdownDate(entry, day), expected));
  }
  it("moves through more than one earlier stage", () => {
    const middle = { date: "2026-12-15", label: "Middle stage" };
    const multiple = { ...entry, stages: [stages[1], middle, stages[0]] };
    assert.equal(nextShutdownDate(multiple, "2026-12-02"), middle.date);
    assert.equal(nextShutdownDate(multiple, middle.date), middle.date);
    assert.equal(nextShutdownDate(multiple, "2026-12-16"), stages[1].date);
  });
  it("retains the final date when no stages are supplied", () => {
    assert.deepEqual(shutdownDates({ deadline: entry.deadline }), [{ date: entry.deadline, label: "" }]);
  });
  it("retains the final date when a schedule omits it", () => {
    assert.deepEqual(shutdownDates({ ...entry, stages: [stages[0]] }), [{ date: entry.deadline, label: "" }]);
  });
});

describe("staged shutdown cards and deadline lists", () => {
  let scratch: string;
  let changes: string;
  let index: string;
  let initial: Record<string, string>;
  before(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "shutdown-stages-"));
    changes = path.join(scratch, "changes.json");
    index = path.join(scratch, "index.json");
    writeFileSync(changes, JSON.stringify({ changes: [fixture] }));
    writeFileSync(index, JSON.stringify({ offers: [] }));
    initial = await pages("2026-11-14", "UTC", changes, index);
  });
  after(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

  it("shows all sourced stages in the header and counts to the first", () => {
    const found = card(initial["/shutdowns"], fixture.vendor);
    assert.equal(found.section, "imminent");
    const header = found.html.split('<p class="shutdown-what">')[0];
    assert.match(text(header), /December 1, 2026 : First <stage> & pause/);
    assert.match(text(header), /January 10, 2027 : Final stage/);
    assert.ok(header.indexOf("December 1") < header.indexOf("January 10"));
    assert.match(header, /17 days left/);
    assert.equal((header.match(/class="days-badge"/g) ?? []).length, 1);
    assert.equal((header.match(/href="https:\/\/example.com\/stages"/g) ?? []).length, 2);
    assert.match(header, /First &lt;stage&gt; &amp; pause/);
  });
  it("puts each pending stage in its own month", () => {
    const months = initial["/shutdowns"].match(/<section aria-labelledby="by-month">([\s\S]*?)<\/section>/)![1];
    const december = months.match(/data-month="2026-12">([\s\S]*?)<\/li>/);
    const january = months.match(/data-month="2027-01">([\s\S]*?)<\/li>/);
    assert.ok(december);
    assert.ok(january);
    assert.match(text(december[1]), /Stage fixture: First <stage> & pause \(December 1\)/);
    assert.match(text(january[1]), /Stage fixture: Final stage \(January 10\)/);
  });
  it("lists the earlier stage in deadlines even when the summary names no date", () => {
    const page = initial["/deadlines"];
    assert.match(page, /2026-12-01/);
    assert.match(page, /2027-01-10/);
    assert.match(page, /https:\/\/example.com\/stages/);
  });
  for (const [day, date, badge, completed] of [
    ["2026-12-01", "December 1, 2026", "Today", false],
    ["2026-12-02", "January 10, 2027", "39 days left", false],
    ["2027-01-10", "January 10, 2027", "Today", false],
    ["2027-01-11", "December 1, 2026", "Completed", true],
  ] as const) {
    it(`advances the countdown and keeps passed stages on ${day}`, async () => {
      const response = await pages(day, "UTC", changes, index);
      const found = card(response["/shutdowns"], fixture.vendor);
      assert.equal(found.section === "completed", completed);
      const header = found.html.split('<p class="shutdown-what">')[0];
      assert.equal(header.match(/<span class="deadline-icon">[^<]*<\/span>\s*<span>([^<]+)<\/span>/)![1], date);
      assert.match(header, new RegExp(`>${badge}<`));
      if (day > "2026-12-01") assert.match(text(header), /December 1, 2026 : First <stage> & pause.*Completed/);
      if (completed) assert.doesNotMatch(response["/shutdowns"], /Stage fixture[^<]*\(January 10\)/);
    });
  }
  it("uses the same pending dates and month groups west of Greenwich", async () => {
    const west = await pages("2026-11-14", "America/Los_Angeles", changes, index);
    assert.equal(card(west["/shutdowns"], fixture.vendor).html, card(initial["/shutdowns"], fixture.vendor).html);
  });
  it("keeps a listing stage on the existing card without adding a duplicate", async () => {
    const listing = path.join(scratch, "listing.json");
    writeFileSync(listing, JSON.stringify({ offers: [{ vendor: fixture.vendor, category: fixture.category,
      description: "Stage fixture shuts down on December 1, 2026 and January 10, 2027.",
      tier: "Free", url: fixture.source_url, verifiedDate: "2026-11-01" }] }));
    const response = await pages("2026-11-14", "UTC", changes, listing);
    const titles = [...response["/shutdowns"].matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)].map(match => text(match[1]));
    assert.equal(titles.filter(title => title === fixture.vendor).length, 1);
    assert.match(text(card(response["/shutdowns"], fixture.vendor).html), /December 1, 2026/);
  });
  it("excludes stages whose source record is withdrawn or unconfirmed", async () => {
    const rejected = path.join(scratch, "rejected.json");
    writeFileSync(rejected, JSON.stringify({ changes: [
      { ...fixture, vendor: "Withdrawn stage", resolution: { state: "retracted", date: "2026-11-12", detail: "Withdrawn" } },
      { ...fixture, vendor: "Unconfirmed stage", archive_check: { checked: "2026-11-12", outcome: "no_usable_capture" } },
      { ...fixture, vendor: "Unsourced stage", source_url: "" },
    ] }));
    const response = await pages("2026-11-14", "UTC", rejected, index);
    for (const vendor of ["Withdrawn stage", "Unconfirmed stage", "Unsourced stage"]) {
      assert.ok(!response["/shutdowns"].includes(vendor));
      const december = response["/deadlines"].split('<div class="dl-card').filter(part => part.includes(vendor));
      assert.deepEqual(december.filter(part => part.includes('class="dl-date">2026-12-01<')), []);
    }
  });
  it("retains the three published schedules and source summaries", async () => {
    const live = await pages("2026-11-14", "UTC");
    const records = JSON.parse(readFileSync(path.join(REPO, "data/deal_changes.json"), "utf8")).changes;
    for (const [vendor, service, first, last] of [["Zeabur", "Zeabur", "December 1, 2026", "December 31, 2026"], ["Chroma", "Chroma Cloud", "December 7, 2026", "December 22, 2026"], ["Val Town", "Val Town", "December 10, 2026", "January 10, 2027"]]) {
      const record = records.find((value: { vendor: string; shutdown_stages?: unknown }) => value.vendor === vendor && value.shutdown_stages);
      assert.ok(record);
      const found = card(live["/shutdowns"], service, record.source_url);
      assert.equal(found.section, "imminent");
      const header = text(found.html.split('<p class="shutdown-what">')[0]);
      assert.ok(header.includes(first) && header.includes(last), header);
      assert.equal(text(found.html.match(/<p class="shutdown-what">([\s\S]*?)<\/p>/)![1]), record.summary);
    }
    assert.match(live["/deadlines"], /2026-12-01/);
  });
});

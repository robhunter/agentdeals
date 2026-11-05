import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 86400000;
const TODAY = new Date().toISOString().slice(0, 10);
const dateIn = (days: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const text = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&#39;|&#x27;|&rsquo;/g, "'").trim();

function entries(html: string, prefix: "exp" | "dl") {
  return html.split(new RegExp(`<div class="${prefix === "exp" ? "exp-entry" : "dl-card"}[^\"]*">`)).slice(1).map(body => ({
    body,
    vendor: text(body.match(new RegExp(`<[^>]*class="${prefix}-vendor"[^>]*>(.*?)<\\/[^>]+>`))?.[1] ?? ""),
    date: text(body.match(new RegExp(`<div class="${prefix}-date[^\"]*">([^<]*)<\\/div>`))?.[1] ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "",
    countdown: text(body.match(/<div class="exp-countdown[^\"]*">([^<]*)<\/div>/)?.[1] ?? ""),
  }));
}

function monthEntries(html: string) {
  const end = html.search(/<div class="recent-section|<div class="mcp-cta"/);
  return entries(html.slice(html.indexOf('<div class="month-group">'), end), "exp");
}

async function withServer(env: Record<string, string>, check: (base: string) => Promise<void>) {
  const server = spawn("node", [path.join(REPO, "dist/serve.js")], {
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_REFERRAL_HEALTH: "off", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      server.on("error", error => { clearTimeout(timer); reject(error); });
      server.stderr.on("data", data => {
        const port = data.toString().match(/running on http:\/\/localhost:(\d+)/)?.[1];
        if (port) { clearTimeout(timer); resolve(`http://localhost:${port}`); }
      });
    });
    await check(base);
  } finally {
    server.kill();
    await new Promise<void>(resolve => server.exitCode !== null ? resolve() : server.once("exit", () => resolve()));
  }
}

async function checkPages(base: string) {
  const get = async (route: string) => {
    const response = await fetch(base + route, { redirect: "error" });
    assert.equal(response.status, 200, route);
    return response.text();
  };
  const html = await get("/expiring");
  const due = entries(await get("/deadlines"), "dl");
  const upcoming = monthEntries(html);
  const pair = ({ vendor, date }: { vendor: string; date: string }) => `${vendor}\u0000${date}`;
  assert.ok(due.length > 0);
  assert.deepEqual(upcoming.filter(entry => entry.date > TODAY).map(pair).sort(), due.map(pair).sort());
  for (const entry of upcoming) {
    const days = Math.round((Date.parse(entry.date) - Date.parse(TODAY)) / DAY);
    assert.equal(entry.countdown, days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`, pair(entry));
  }
  const groups = html.split('<div class="month-group">').slice(1);
  for (const group of groups) {
    const heading = text(group.match(/<h2 class="month-heading">([^<]*)<\/h2>/)?.[1] ?? "");
    const end = group.search(/<div class="recent-section|<div class="mcp-cta"/);
    for (const entry of entries(end < 0 ? group : group.slice(0, end), "exp")) {
      const month = new Date(`${entry.date}T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
      assert.equal(heading, month, pair(entry));
    }
  }
  const tile = (label: string) => Number(html.match(new RegExp(`<div class="stat-value">(\\d+)<\\/div>\\s*<div class="stat-label">${label}<\\/div>`))?.[1]);
  assert.equal(tile("Upcoming"), upcoming.length);
  assert.equal(tile("Within 14 Days"), upcoming.filter(entry => entry.date <= dateIn(14)).length);
  assert.match(html, new RegExp(`<p class="page-intro">${upcoming.length} upcoming pricing changes tracked\\.`));
  assert.match(html, new RegExp(`<meta name="description" content="${upcoming.length} upcoming pricing changes tracked\\.`));
  const discovered = html.split('<h2>Recently Discovered</h2>')[1] ?? "";
  return { html, upcoming, discovered };
}

describe("expiring month groups include the deadline tracker's stated dates", () => {
  it("matches every live future vendor and date, including HiveMQ and Workers Logs", async () => {
    await withServer({}, async base => {
      const { upcoming, discovered } = await checkPages(base);
      if (TODAY < "2026-12-31") {
        const hive = upcoming.find(entry => entry.vendor === "HiveMQ" && entry.date === "2026-12-31");
        assert.ok(hive);
        assert.match(hive.body, /Serverless/);
        assert.ok(!entries(discovered, "exp").some(entry => entry.vendor === "HiveMQ"));
      }
      if (TODAY < "2026-12-01") {
        const workers = upcoming.find(entry => entry.vendor === "Cloudflare Workers" && entry.date === "2026-12-01");
        assert.ok(workers);
        assert.match(workers.body, /Workers Logs/);
      }
    });
  });

  it("keeps today, lists multiple dates, removes only the matching discovery and preserves source and condition roles", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "expiring-stated-"));
    const index = JSON.parse(readFileSync(path.join(REPO, "data/index.json"), "utf8"));
    const changes = JSON.parse(readFileSync(path.join(REPO, "data/deal_changes.json"), "utf8"));
    const vendor = "Month Fixture Hosting";
    const recordVendor = "Month Fixture Messaging";
    const listingUrl = "https://month-fixture.example/pricing";
    const conditionUrl = "https://month-fixture.example/conditions";
    const recordUrl = "https://month-fixture.example/end";
    const sentence = `The free hosting plan shuts down on ${dateIn(10)}.`;
    const condition = "Free projects hold 1,000 rows.";
    index.offers = [{ vendor, category: "Cloud Hosting", tier: "Free", url: listingUrl, description: sentence, verifiedDate: TODAY,
      conditions: [{ text: condition, quote: condition, url: conditionUrl, read_on: TODAY }] }];
    const record = (name: string, date: string, summary: string, extra = {}) => ({ vendor: name, category: "Messaging", change_type: "product_deprecated", impact: "high", date, summary, previous_state: "Available", current_state: "Retiring", source_url: recordUrl, alternatives: [], recorded_date: dateIn(-2), date_source: "vendor_page", listing_effect: "none", ...extra });
    changes.changes = [
      record(recordVendor, dateIn(-2), `The free plan retires on ${dateIn(20)}.`, { date_source: "discovered", discontinued_date: dateIn(20) }),
      record(vendor, dateIn(-2), sentence, { date_source: "discovered", discontinued_date: dateIn(10) }),
      record("Month Fixture Other", dateIn(-2), "The product was deprecated.", { date_source: "discovered" }),
      record("Month Fixture Today", TODAY, "The new limits take effect today."),
      record(vendor, dateIn(40), "The legacy API ends."),
      record(vendor, dateIn(-3), `A different API retires on ${dateIn(50)}.`),
    ];
    writeFileSync(path.join(dir, "index.json"), JSON.stringify(index));
    writeFileSync(path.join(dir, "changes.json"), JSON.stringify(changes));
    try {
      await withServer({ AGENTDEALS_INDEX_PATH: path.join(dir, "index.json"), AGENTDEALS_CHANGES_PATH: path.join(dir, "changes.json") }, async base => {
        const { html, upcoming, discovered } = await checkPages(base);
        assert.equal(upcoming.length, 5);
        assert.ok(upcoming.some(entry => entry.vendor === "Month Fixture Today" && entry.countdown === "today"));
        assert.deepEqual(entries(discovered, "exp").map(entry => entry.vendor), ["Month Fixture Other"]);
        const listing = upcoming.find(entry => entry.vendor === vendor && entry.date === dateIn(10))!;
        assert.ok(listing);
        assert.match(listing.body, /class="record-source"/);
        assert.ok(listing.body.includes(listingUrl));
        assert.ok(listing.body.indexOf(condition) > listing.body.indexOf(sentence));
        assert.ok(!listing.body.includes('class="badge"'));
        const recordLine = upcoming.find(entry => entry.vendor === recordVendor)!;
        assert.match(recordLine.body, /class="change-source"/);
        assert.ok(recordLine.body.includes(recordUrl));
        assert.match(recordLine.body, /class="badge"/);
        const structured = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]);
        assert.equal(structured.numberOfItems, entries(html, "exp").length);
        const items = structured.itemListElement.map((entry: any) => entry.item);
        const statedItem = items.find((entry: any) => entry.headline === vendor && entry.datePublished === dateIn(10));
        assert.ok(statedItem.description.startsWith(sentence) && statedItem.description.includes(condition));
        assert.ok(items.some((entry: any) => entry.headline.startsWith(recordVendor) && entry.datePublished === dateIn(20)));
        assert.ok(!("datePublished" in items.find((entry: any) => entry.headline.startsWith("Month Fixture Other"))));
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

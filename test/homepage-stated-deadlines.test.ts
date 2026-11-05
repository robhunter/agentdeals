import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { UPCOMING_DEADLINES_ON_THE_HOME_PAGE, NOTHING_CHANGING_SOON_HTML } = await import("../dist/homepage-claims.js");
const { changeTouchesTheListing } = await import("../dist/product-deprecation.js");
const { changesTheVendorMade } = await import("../dist/data.js");
const TODAY = new Date().toISOString().slice(0, 10);
const DAY = 86400000;
const dateIn = (days: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const text = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&#39;|&#x27;|&rsquo;/g, "'").trim();
const pair = (entry: { vendor: string; date: string }) => `${entry.vendor}\u0000${entry.date}`;

function section(html: string) {
  const start = html.indexOf('<div class="section" id="changing-soon">');
  assert.ok(start >= 0);
  const end = html.indexOf('href="/changes" class="see-all-link"', start);
  assert.ok(end > start);
  return html.slice(start, end);
}

function entries(html: string, prefix: "cs" | "dl") {
  return html.split(new RegExp(`<div class="${prefix === "cs" ? "cs-entry" : "dl-card"}[^\"]*">`)).slice(1).map(body => ({
    body,
    vendor: text(body.match(new RegExp(`<[^>]*class="${prefix}-vendor"[^>]*>(.*?)<\\/[^>]+>`))?.[1] ?? ""),
    date: text(body.match(prefix === "cs" ? /<span class="cs-rel">([^<]*)<\/span>/ : /<div class="dl-date">([^<]*)<\/div>/)?.[1] ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "",
  }));
}

async function withPages(offers: unknown[] | null, changes: unknown[] | null, check: (home: string, deadlines: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "home-stated-deadlines-"));
  const env: Record<string, string> = {};
  if (offers !== null) {
    env.AGENTDEALS_INDEX_PATH = path.join(dir, "index.json");
    writeFileSync(env.AGENTDEALS_INDEX_PATH, JSON.stringify({ offers }));
  }
  if (changes !== null) {
    env.AGENTDEALS_CHANGES_PATH = path.join(dir, "changes.json");
    writeFileSync(env.AGENTDEALS_CHANGES_PATH, JSON.stringify({ changes }));
  }
  const server = spawn("node", [path.join(REPO, "dist/serve.js")], {
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_REFERRAL_HEALTH: "off", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { server.kill(); reject(new Error("Server startup timeout")); }, 30000);
      server.on("error", error => { clearTimeout(timer); reject(error); });
      server.stderr.on("data", data => {
        const port = data.toString().match(/running on http:\/\/localhost:(\d+)/)?.[1];
        if (port) { clearTimeout(timer); resolve(`http://localhost:${port}`); }
      });
    });
    const get = async (route: string) => {
      const response = await fetch(base + route, { redirect: "error" });
      assert.equal(response.status, 200, route);
      return response.text();
    };
    check(await get("/"), await get("/deadlines"));
  } finally {
    server.kill();
    await new Promise<void>(resolve => server.exitCode !== null ? resolve() : server.once("exit", () => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

const offer = (vendor: string, description: string, conditions: unknown[] = []) => ({ vendor, description, conditions, tier: "Free", category: "Cloud Hosting", url: `https://deadline-fixture.example/${vendor}/pricing`, verifiedDate: TODAY });
const record = (vendor: string, offset: number, summary: string, extra = {}) => ({ vendor, category: "Cloud Hosting", change_type: "product_deprecated", date: dateIn(offset), summary, previous_state: "Available", current_state: "Retiring", impact: "high", source_url: `https://deadline-fixture.example/${vendor}/change`, alternatives: [], date_source: "vendor_page", listing_effect: "ends", ...extra });
const condition = (value: string) => ({ text: value, quote: value, url: "https://deadline-fixture.example/conditions", read_on: TODAY });

function assertCountdowns(rows: ReturnType<typeof entries>) {
  for (const row of rows) {
    const days = Math.round((Date.parse(row.date) - Date.parse(TODAY)) / DAY);
    assert.match(row.body, new RegExp(`class="cs-countdown${days <= 14 ? " cs-urgent" : ""}">${days}<span class="cs-unit">${days === 1 ? "day" : "days"}</span>`), pair(row));
    assert.ok(row.body.includes(days === 1 ? "tomorrow" : `in ${days} days`), pair(row));
  }
}

describe("the home page includes stated deadlines in its soonest five", () => {
  it("matches the deadline tracker's first five qualifying vendor/date pairs on live data", async () => {
    const records = changesTheVendorMade(JSON.parse(readFileSync(path.join(REPO, "data/deal_changes.json"), "utf8")).changes).filter(c => c.date > TODAY);
    await withPages(null, null, (home, deadlines) => {
      const expected = entries(deadlines, "dl").filter(entry => {
        const dated = records.find(record => pair(record) === pair(entry));
        return !dated || changeTouchesTheListing(dated);
      }).slice(0, UPCOMING_DEADLINES_ON_THE_HOME_PAGE);
      const actual = entries(section(home), "cs");
      assert.deepEqual(actual.map(pair), expected.map(pair));
      assertCountdowns(actual);
      if (TODAY < "2026-11-25") assert.ok(actual.some(entry => entry.vendor === "Mem0" && entry.date === "2026-11-25"));
      if (TODAY < "2026-12-01") assert.ok(actual.some(entry => entry.vendor === "Cloudflare AI Search" && entry.date === "2026-12-01"));
    });
  });

  it("orders and caps mixed listing and record dates while preserving sources, quotations and conditions", async () => {
    const full = `The free plan retires on ${dateIn(5)}.`;
    const excerpt = `The legacy runtime retires on ${dateIn(6)}.`;
    const offers = [
      offer("Condition", "The free plan includes hosting.", [condition(`Free usage ends on ${dateIn(1)}.`)]),
      offer("Recorded", `The legacy API retires on ${dateIn(3)}.`),
      offer("Whole", full, [condition("Free projects hold 1,000 rows.")]),
      offer("Excerpt", `The plan includes queues. ${excerpt}`, [condition("Queues require a payment card.")]),
      offer("Late", `The free allowance ends on ${dateIn(9)}.`),
      offer("Today", `The free plan ends on ${TODAY}.`),
    ];
    const changes = [
      record("Recorded", 3, "The listed API retires."),
      record("Sibling", 2, "Another product retires.", { listing_effect: "none" }),
      record("Discovered", -2, `The free plan retires on ${dateIn(4)}.`, { date_source: "discovered", listing_effect: "none" }),
    ];
    await withPages(offers, changes, (home, deadlines) => {
      const soon = section(home);
      const rows = entries(soon, "cs");
      assert.deepEqual(rows.map(pair), ["Condition", "Recorded", "Discovered", "Whole", "Excerpt"].map((vendor, i) => pair({ vendor, date: dateIn([1, 3, 4, 5, 6][i]) })));
      assert.deepEqual(rows.map(pair), entries(deadlines, "dl").filter(entry => entry.vendor !== "Sibling").slice(0, UPCOMING_DEADLINES_ON_THE_HOME_PAGE).map(pair));
      assertCountdowns(rows);
      for (const row of rows) {
        const expected = entries(deadlines, "dl").find(entry => pair(entry) === pair(row))!;
        const summary = expected.body.match(/<div class="dl-summary">([\s\S]*?)<\/div>/)?.[1];
        assert.ok(summary && row.body.includes(summary), pair(row));
        assert.equal(row.body.includes('class="change-badge"'), ["Recorded", "Discovered"].includes(row.vendor), row.vendor);
      }
      assert.match(rows[0].body, /class="record-source"/);
      assert.match(rows[0].body, /https:\/\/deadline-fixture.example\/conditions/);
      assert.match(rows[1].body, /class="change-source"/);
      assert.match(rows[1].body, /Recorded\/change/);
      assert.match(rows[2].body, /class="change-source"/);
      assert.ok(rows[3].body.indexOf("Free projects hold 1,000 rows.") > rows[3].body.indexOf(full));
      assert.ok(!rows[4].body.includes("Queues require a payment card."));
      assert.ok(!soon.includes("On the day its date arrives it moves to"));
      assert.match(soon, /href="\/deadlines"/);
      assert.ok(!soon.includes(NOTHING_CHANGING_SOON_HTML));
    });
  });

  it("shows listing-only dates without requiring a change record and withdraws them on their day", async () => {
    const offers = [offer("Tomorrow", `The free plan ends on ${dateIn(1)}.`), offer("Today", `The free plan ends on ${TODAY}.`), offer("Past", `The free plan ends on ${dateIn(-1)}.`)];
    await withPages(offers, [], (home, deadlines) => {
      const rows = entries(section(home), "cs");
      assert.deepEqual(rows.map(pair), [pair({ vendor: "Tomorrow", date: dateIn(1) })]);
      assert.deepEqual(rows.map(pair), entries(deadlines, "dl").map(pair));
      assertCountdowns(rows);
      assert.ok(!rows[0].body.includes('class="change-badge"'));
    });
  });

  it("retains the empty notice when no stated date or listing-affecting record qualifies", async () => {
    await withPages([], [record("Sibling", 2, "Another product retires.", { listing_effect: "none" })], home => {
      assert.deepEqual(entries(section(home), "cs"), []);
      assert.ok(section(home).includes(NOTHING_CHANGING_SOON_HTML));
    });
  });
});

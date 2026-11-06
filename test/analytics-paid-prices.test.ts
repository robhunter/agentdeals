import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const route = "/analytics-free-tier-comparison-2026";
const cardSentence = "Beyond the free tier, PostHog charges $0.00005 an event from 1M to 2M events a month and $0.0000343 from 2M to 15M, falling with volume; events with person profiles (identified events) cost $0.000198 more each from 1M to 2M.";
const billingNote = "Prices are each vendor's published prices for monthly billing, read 2026-11-05. PostHog's column is for anonymous events; events with person profiles cost more, $248 a month at 2M and $1,080 at 10M. Mixpanel costs $185 and $840 a month at 2M and 10M billed yearly, and sells only Enterprise above 20M. Amplitude sells only its Growth plan above 70M, and Plausible quotes custom prices above 10M pageviews.";

const plain = (html: string) => html.replace(/<[^>]+>/g, " ")
  .replace(/&#39;|&rsquo;/g, "'").replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim();

describe("analytics prices distinguish monthly billing and identified events", () => {
  let child: ChildProcess;
  let base = "";
  let page = "";
  let table = "";
  let headers: string[] = [];
  let rows: string[][] = [];

  before(async () => {
    child = spawn(process.execPath, [root + "dist/serve.js"], {
      cwd: root,
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const port = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
      let stderr = "";
      child.stderr!.on("data", data => {
        stderr += data;
        const match = stderr.match(/running on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); });
    });
    base = `http://localhost:${port}`;
    const response = await fetch(base + route, { redirect: "error" });
    assert.equal(response.status, 200);
    page = await response.text();
    const tables = [...page.matchAll(/<table class="growth-table">[\s\S]*?<\/table>/g)];
    assert.equal(tables.length, 1);
    table = tables[0][0];
    headers = [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(cell => plain(cell[1]));
    rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].slice(1)
      .map(row => [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(cell => plain(cell[1])));
  });

  after(() => child?.kill());

  it("states both PostHog anonymous-event bands and the additional person-profile rate in its card", () => {
    const card = page.match(/<h3>PostHog[\s\S]*?<div class="diff-desc">([\s\S]*?)<\/div>/)?.[1];
    assert.ok(card);
    assert.ok(plain(card).includes(cardSentence));
    assert.doesNotMatch(plain(card), /\$0\.00031/);
    assert.ok(plain(card).includes("1M events/month"));
  });

  it("gives the Next.js Analytics row the first paid anonymous-event rate", async () => {
    const response = await fetch(base + "/free-nextjs-stack", { redirect: "error" });
    assert.equal(response.status, 200);
    const html = await response.text();
    const growth = html.match(/<table class="growth-table">[\s\S]*?<\/table>/)?.[0];
    assert.ok(growth);
    const matches = [...growth.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)].filter(row => plain(row[0]).startsWith("Analytics "));
    assert.equal(matches.length, 1);
    const cells = [...matches[0][0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(cell => plain(cell[1]));
    assert.ok(cells.includes("$0.00005/event"), JSON.stringify(cells));
    assert.doesNotMatch(matches[0][0], /\$0\.00031/);
  });

  it("keeps each published monthly price under its vendor and usage scenario", () => {
    assert.deepEqual(headers, ["Usage Scenario", "PostHog", "Mixpanel", "Amplitude", "Google Analytics", "Plausible Cloud"]);
    assert.deepEqual(rows, [
      ["500K events/mo", "$0 (free)", "$0 (free)", "$0 (free)", "$0 (free)", "$49/mo"],
      ["2M events/mo", "$50/mo", "$259/mo", "$0 (free)", "$0 (free, sampled)", "$89/mo"],
      ["10M events/mo", "$324/mo", "$1,176/mo", "$720/mo", "$0 (free, heavily sampled)", "$169/mo"],
      ["50M events/mo", "$1,528/mo", "Custom", "$4,140/mo", "$0 (free, data quality issues)", "Custom"],
      ["100M events/mo", "$2,618/mo", "Custom", "Custom", "$0 or GA360 ($150K+/yr)", "Custom"],
    ]);
  });

  it("puts the billing, identified-event and plan limits directly after the table", () => {
    const end = page.indexOf(table) + table.length;
    const freePlans = page.indexOf("<strong>Free plans count events:</strong>", end);
    assert.ok(freePlans > end);
    const between = page.slice(end, freePlans);
    assert.equal(plain(between), billingNote);
    assert.equal((page.match(/Prices are each vendor's published prices/g) ?? []).length, 1);
  });
});

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEEK = "/digest/2026-w44";
const clocks = ["2026-10-21", "2026-10-27", "2026-11-04"];
const pages = new Map<string, string>();
const processes: ChildProcess[] = [];
let scratch = "";
let base = "";

function record(vendor: string, date: string, summary: string) {
  return {
    vendor, date, summary, category: "Cloud Hosting", change_type: "product_deprecated",
    date_source: "vendor_page", recorded_date: "2026-10-01", impact: "medium",
    previous_state: "The service is available.", current_state: "A retirement is announced.",
    source_url: `https://example.com/${vendor.toLowerCase().replaceAll(" ", "-")}`,
    alternatives: [], listing_effect: "none",
  };
}

function listing(vendor: string, description: string, conditions: unknown[] = [], hold?: { record_date: string; change_type: string; reason: string }) {
  return {
    vendor, description, conditions, category: "Cloud Hosting", tier: "Free",
    url: `https://example.com/${vendor.toLowerCase().replaceAll(" ", "-")}/pricing`,
    verifiedDate: "2026-10-01", ...(hold ? { free_plan_excerpt_hold: hold } : {}),
  };
}

async function startAt(day: string): Promise<string> {
  const proc = spawn("node", ["--import", path.join(REPO, "scripts/shifted-clock.mjs"), path.join(REPO, "dist/serve.js")], {
    cwd: REPO, stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC",
      AGENTDEALS_CLOCK_SHIFT_MS: String(Date.parse(`${day}T12:00:00Z`) - Date.now()),
      AGENTDEALS_INDEX_PATH: path.join(scratch, "index.json"),
      AGENTDEALS_CHANGES_PATH: path.join(scratch, "changes.json"),
    },
  });
  processes.push(proc);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("Server startup timeout")); }, 30000);
    let stderr = "";
    proc.stderr!.on("data", chunk => {
      stderr += chunk.toString();
      const port = stderr.match(/running on http:\/\/localhost:(\d+)/)?.[1];
      if (port) { clearTimeout(timeout); resolve(`http://localhost:${port}`); }
    });
    proc.on("error", error => { clearTimeout(timeout); reject(error); });
    proc.on("exit", code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${stderr}`)); });
  });
}

async function read(baseUrl: string, route: string): Promise<string> {
  const response = await fetch(baseUrl + route, { redirect: "error" });
  assert.equal(response.status, 200, route);
  return response.text();
}

function statedSection(html: string): string {
  return html.split('<div class="impact-section stated-deadlines">')[1]?.split('<div class="impact-section">')[0]?.split('<div class="trending">')[0]?.split('<section class=')[0] ?? "";
}

function cards(html: string): string[] {
  return [...html.matchAll(/<div class="change-entry"[^>]*>([\s\S]*?)<div class="change-summary">([\s\S]*?)<\/div>\s*<\/div>/g)].map(match => match[0]);
}

before(async () => {
  scratch = mkdtempSync(path.join(tmpdir(), "digest-stated-"));
  writeFileSync(path.join(scratch, "index.json"), JSON.stringify({ offers: [
    listing("Monday Cloud", "The hosted console shuts down on 2026-10-26.", [{
      text: "A billing email is required.", quote: "A billing email is required.",
      url: "https://example.com/billing", read_on: "2026-10-01",
    }], { record_date: "2026-10-01", change_type: "restriction", reason: "Personal-account access ended on 2026-10-01." }),
    listing("Sunday Cloud", "The free runtime is retired on 2026-11-01.", [{
      text: "Search remains free through 2026-10-31, then costs $2 from 2026-11-01.",
      quote: "Search pricing changes.", url: "https://example.com/search-prices", read_on: "2026-10-01",
    }]),
    listing("New Year Cloud", "The legacy API shuts down on 2027-01-01."),
    listing("Following Year Week", "The legacy API shuts down on 2027-01-04."),
    listing("Only Listing", "The old API shuts down on 2026-10-18."),
    listing("Prior Sunday", "The old API shuts down on 2026-10-25."),
    listing("Next Monday", "The old API shuts down on 2026-11-02."),
    listing("Duplicate Cloud", "The dashboard shuts down on 2026-10-28."),
    listing("Adjacent Cloud", "The dashboard shuts down on 2026-11-01."),
    listing("Observed Cloud", "The page checked 2026-10-28 says the endpoint is retired; the shutdown date is not given."),
    listing("Published Cloud", "The endpoint retires on 2026-11-15 (its change log of 2026-10-28 announced the retirement)."),
    listing("Launched Cloud", "The new model became generally available on 2026-10-28. The old model retires on 2026-11-15."),
  ] }));
  writeFileSync(path.join(scratch, "changes.json"), JSON.stringify({ changes: [
    { ...record("Monday Cloud", "2026-10-01", "Personal-account access ended on 2026-10-01; the hosted console remains until its stated shutdown date."), change_type: "restriction" },
    { ...record("Duplicate Cloud", "2026-10-27", "The dashboard shuts down on 2026-10-27."), source_url: "https://example.com/duplicate-cloud/pricing" },
    { ...record("Adjacent Cloud", "2026-11-02", "The dashboard shuts down on 2026-11-02."), source_url: "https://example.com/adjacent-cloud/pricing" },
    record("Later Record", "2026-11-10", "The legacy endpoint retired on 2026-10-29."),
    record("Earlier Record", "2026-10-20", "The legacy endpoint retires on 2026-10-30."),
    record("Same Week Record", "2026-10-26", "The old importer retires on 2026-11-01."),
    { ...record("Reversed Record", "2026-10-20", "The beta retires on 2026-10-29."),
      resolution: { state: "reversed", date: "2026-10-21", detail: "The beta remains available." } },
    { ...record("First Read Cloud", "2026-10-28", "The page states a paid plan."), date_source: "discovered" },
  ] }));
  for (const day of clocks) {
    const origin = await startAt(day);
    if (day === clocks[0]) base = origin;
    pages.set(day, await read(origin, WEEK));
  }
});

after(() => {
  for (const proc of processes) proc.kill();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("each digest week includes stated deadlines beside its dated changes", () => {
  it("keeps Monday, Sunday and earlier-record deadlines in the week's list before, during and after the week", () => {
    for (const [day, html] of pages) {
      const section = statedSection(html);
      assert.equal(cards(section).length, 4, day);
      for (const vendor of ["Monday Cloud", "Sunday Cloud", "Earlier Record", "Same Week Record"]) {
        assert.ok(section.includes(`<span class="change-vendor">${vendor}</span>`), `${day}: ${vendor}`);
      }
      for (const vendor of ["Prior Sunday", "Next Monday", "Reversed Record", "Duplicate Cloud", "Adjacent Cloud", "Later Record"]) {
        assert.ok(!section.includes(vendor), `${day}: ${vendor}`);
      }
      assert.deepEqual(cards(section).map(card => card.match(/class="change-date">([^<]+)/)?.[1]), ["2026-10-26", "2026-10-30", "2026-11-01", "2026-11-01"]);
    }
  });

  it("prefers the condition source, suppresses adjacent duplicate dates and retains record source links", () => {
    const section = statedSection(pages.get(clocks[0])!);
    const card = (vendor: string) => cards(section).find(card => card.includes(`>${vendor}</span>`))!;
    assert.match(card("Monday Cloud"), /href="https:\/\/example.com\/monday-cloud\/pricing"[^>]*class="record-source"/);
    assert.match(card("Sunday Cloud"), /Search remains free through 2026-10-31, then costs \$2 from 2026-11-01/);
    assert.match(card("Sunday Cloud"), /href="https:\/\/example.com\/search-prices"[^>]*class="record-source"/);
    assert.ok(!card("Sunday Cloud").includes("free runtime"));
    assert.match(card("Earlier Record"), /href="https:\/\/example.com\/earlier-record"[^>]*class="change-source"/);
  });

  it("keeps conditions beside a quoted description when that quotation is the whole description", () => {
    const section = statedSection(pages.get(clocks[0])!);
    const card = cards(section).find(card => card.includes(">Monday Cloud</span>"))!;
    assert.ok(card.includes("A billing email is required."));
    assert.ok(card.includes('href="https://example.com/billing"'));
    assert.ok(card.includes("read 2026-10-01"));
  });

  it("keeps the restriction record beside a deadline quoted from a listing whose free-plan excerpt is held", () => {
    const card = cards(statedSection(pages.get(clocks[0])!)).find(card => card.includes(">Monday Cloud</span>"))!;
    assert.ok(card.includes("Personal-account access ended on 2026-10-01"));
    assert.match(card, /href="https:\/\/example.com\/monday-cloud"[^>]*class="change-source"/);
  });

  it("counts the same six dated events in headline, description, structured metadata and total tile", () => {
    for (const [day, html] of pages) {
      const headline = html.match(/<p class="page-meta">([^<]*)/)?.[1] ?? "";
      const meta = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";
      const structured = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)![1]);
      assert.match(headline, /6 events .*week 44, 2026/, day);
      assert.match(meta, /^6 events for developer tools/, day);
      for (const text of [headline, meta]) {
        assert.match(text, /2 (?:pricing )?changes (?:scheduled|tracked)/, day);
        assert.match(text, /2 deadlines our listings state and 2 deadlines stated in earlier change records/, day);
      }
      assert.equal(structured.description, meta);
      assert.match(html, /<div class="stat-pill"><strong>6<\/strong> events<\/div>/);
      assert.match(html, /<div class="stat-pill"><strong>4<\/strong> stated deadlines<\/div>/);
      assert.equal(cards(html.split('<section class=')[0]).length, 7, "six events plus one separately labelled first read");
    }
  });

  it("preserves a week's entries unchanged as its deadlines leave the live tracker", () => {
    const sections = [...pages.values()].map(statedSection);
    assert.equal(sections[0], sections[1]);
    assert.equal(sections[1], sections[2]);
  });

  it("excludes check, publication and launch dates from past, current and future weeks and the live tracker", async () => {
    for (const [day, html] of pages) {
      const section = statedSection(html);
      for (const vendor of ["Observed Cloud", "Published Cloud", "Launched Cloud"]) {
        assert.ok(!section.includes(vendor), `${day}: ${vendor}`);
      }
      assert.equal(cards(section).length, 4, day);
    }
    for (const route of ["/api/deadlines", "/deadlines", "/this-week"]) {
      const body = await read(base, route);
      assert.ok(!body.includes("Observed Cloud"), route);
      if (route === "/api/deadlines") {
        const entries = JSON.parse(body).deadlines;
        assert.ok(!entries.some((entry: { vendor: string; date: string }) =>
          ["Published Cloud", "Launched Cloud"].includes(entry.vendor) && entry.date === "2026-10-28"));
        for (const vendor of ["Published Cloud", "Launched Cloud"]) {
          assert.ok(entries.some((entry: { vendor: string; date: string }) => entry.vendor === vendor && entry.date === "2026-11-15"));
        }
      }
    }
  });

  it("lists and counts a week with only a listing deadline, without an empty-week claim", async () => {
    const html = await read(base, "/digest/2026-w42");
    assert.match(html, /<strong>1<\/strong> event<\/div>/);
    assert.match(html, /1 deadline our listings state/);
    assert.ok(statedSection(html).includes("Only Listing"));
    assert.ok(!html.includes("No pricing changes tracked this week"));
  });

  it("keeps a January deadline in the ISO week that starts in December", async () => {
    const html = await read(base, "/digest/2026-w53");
    assert.match(html, /<strong>1<\/strong> event<\/div>/);
    assert.ok(statedSection(html).includes("New Year Cloud"));
    assert.ok(!statedSection(html).includes("Following Year Week"));
    const following = statedSection(await read(base, "/digest/2027-w01"));
    assert.ok(following.includes("Following Year Week"));
    assert.ok(!following.includes("New Year Cloud"));
  });

  it("covers every live-tracker entry inside the week, while keeping API and feed records distinct", async () => {
    const deadlines = JSON.parse(await read(base, "/api/deadlines")).deadlines;
    const inWeek = deadlines.filter((entry: { date: string }) => entry.date >= "2026-10-26" && entry.date <= "2026-11-01");
    assert.equal(inWeek.length, 6);
    const html = pages.get(clocks[0])!;
    for (const entry of inWeek) {
      assert.ok(cards(html).some(card => card.includes(`>${entry.vendor}</span>`) && card.includes(entry.date)), entry.vendor);
    }
    const changes = JSON.parse(await read(base, "/api/changes?limit=10000")).changes;
    assert.ok(!changes.some((entry: { vendor: string }) => entry.vendor === "Only Listing"));
    assert.ok(!(await read(base, "/feed.xml")).includes("Only Listing"));
  });
});

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEADING = "Deprecations and Other Changes";
const INTRO = "Changes counted as neither negative nor positive, such as products and models retired or closed to new users";
const { loadDealChanges, changesTheVendorMade } = await import("../dist/data.js");
const { trackedChanges } = await import("../dist/change-census.js");
const { isEventDated } = await import("../dist/change-dates.js");
const { POSITIVE_CHANGE_TYPES } = await import("../dist/change-direction.js");
const { countsAsANegativeChange } = await import("../dist/product-deprecation.js");

function record(vendor: string, change_type: string, date: string, extra = {}) {
  return {
    vendor, change_type, date, date_source: "vendor_page", recorded_date: "2026-08-01",
    summary: `${vendor} changed <legacy> & current products.`,
    previous_state: "The old product was available.", current_state: "The product changed.",
    source_url: `https://example.com/${date}?a=1&b=2`,
    impact: "medium", category: "AI / ML", alternatives: [], listing_effect: "none", ...extra,
  };
}

const EARLY = record("Twin & Tools", "product_deprecated", "2026-08-03");
const LATE = record("Twin & Tools", "product_deprecated", "2026-08-24");
const REBRAND = record("Renamed <Tool>", "rebranded", "2026-08-12");
const REMOVED = record("Ended Tool", "product_deprecated", "2026-08-05", { listing_effect: "ends" });
const WINNER = record("Expanded Tool", "limits_increased", "2026-08-07");
const EMPTY_MONTH = record("Another Expanded Tool", "new_free_tier", "2026-07-05");
const SCHEDULED = record("Scheduled Tool", "product_deprecated", "2026-10-31");
const EFFECTIVE = record("Effective Tool", "rebranded", "2026-10-03");
const DISCOVERY = record("Discovered Tool", "rebranded", "2026-08-09", { date_source: "discovered" });
const MANY = Array.from({ length: 12 }, (_, i) => record(`Neutral Tool ${i + 1}`, "product_deprecated", `2026-09-${String(i + 1).padStart(2, "0")}`));
const FIXTURE = { changes: [LATE, REMOVED, REBRAND, WINNER, EARLY, EMPTY_MONTH, SCHEDULED, EFFECTIVE, DISCOVERY, ...MANY] };
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function section(html: string): string {
  const start = html.indexOf(`<h2>${HEADING}</h2>`);
  return start < 0 ? "" : html.slice(start, html.indexOf("<h2>", start + 1));
}

function entries(html: string): string[] {
  return [...section(html).matchAll(/<li><strong>[\s\S]*?<\/ul><\/li>/g)].map(m => m[0]);
}

function neutralCount(html: string): number {
  return Number(html.match(/class="stat-value stat-neutral">(\d+)<\/div>/)?.[1] ?? 0);
}

async function startServer(env: Record<string, string>) {
  const proc = spawn("node", ["--import", path.join(REPO, "scripts/shifted-clock.mjs"), path.join(REPO, "dist/serve.js")], {
    cwd: REPO, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
  });
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { proc.kill(); reject(new Error("Server startup timeout")); }, 30000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://localhost:${match[1]}`); }
    });
    proc.on("error", error => { clearTimeout(timer); reject(error); });
  });
  return { proc, base };
}

const children: ChildProcess[] = [];
const fixturePages = new Map<string, string>();
const cataloguePages = new Map<string, string>();
let scratch = "";
let servedOn = "";

before(async () => {
  scratch = mkdtempSync(path.join(tmpdir(), "report-neutral-"));
  const fixturePath = path.join(scratch, "changes.json");
  writeFileSync(fixturePath, JSON.stringify(FIXTURE));
  const fixture = await startServer({
    AGENTDEALS_CHANGES_PATH: fixturePath,
    AGENTDEALS_CLOCK_SHIFT_MS: String(Date.parse("2026-10-18T12:00:00Z") - Date.now()),
  });
  children.push(fixture.proc);
  for (const month of ["2026-07", "2026-08", "2026-09", "2026-10"]) {
    const response = await fetch(`${fixture.base}/reports/${month}`);
    assert.equal(response.status, 200, month);
    fixturePages.set(month, await response.text());
  }
  const catalogue = await startServer({});
  children.push(catalogue.proc);
  servedOn = new Date().toISOString().slice(0, 10);
  const sitemap = await fetch(catalogue.base + "/sitemap-reports.xml").then(r => r.text());
  const routes = new Set([...sitemap.matchAll(/\/reports\/(\d{4}-\d{2})</g)].map(m => m[1]));
  assert.ok(routes.size > 0, "the report sitemap has no months");
  for (const month of routes) {
    const response = await fetch(`${catalogue.base}/reports/${month}`);
    assert.equal(response.status, 200, month);
    cataloguePages.set(month, await response.text());
  }
});

after(() => {
  children.forEach(proc => proc.kill());
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("monthly neutral changes", () => {
  it("uses the supplied heading and introduction between winners and category breakdown", () => {
    const html = fixturePages.get("2026-08")!;
    assert.ok(section(html).startsWith(`<h2>${HEADING}</h2><p class="section-desc">${INTRO}</p>`));
    assert.ok(html.indexOf("<h2>Biggest Winners</h2>") < html.indexOf(`<h2>${HEADING}</h2>`));
    assert.ok(html.indexOf(`<h2>${HEADING}</h2>`) < html.indexOf("<h2>Category Breakdown</h2>"));
  });

  it("lists each record once oldest first, including separate changes by the same vendor", () => {
    const rows = entries(fixturePages.get("2026-08")!);
    assert.equal(rows.length, 3);
    [EARLY, REBRAND, LATE].forEach((record, i) => {
      assert.ok(rows[i].startsWith(`<li><strong>${escape(record.vendor)}</strong> (${record.change_type.replace(/_/g, " ")} ${record.date})`), rows[i]);
      assert.ok(rows[i].includes(escape(record.summary)), rows[i]);
    });
  });

  it("cites each record's own source and escapes vendor names, summaries and URLs", () => {
    const rows = entries(fixturePages.get("2026-08")!);
    [EARLY, REBRAND, LATE].forEach((record, i) => {
      assert.ok(rows[i].includes(`href="${escape(record.source_url)}"`), rows[i]);
      assert.match(rows[i], /class="change-source"/);
      assert.ok(!rows[i].includes("<legacy>") && !rows[i].includes("<Tool>"), rows[i]);
    });
  });

  it("leaves listing-ending deprecations and positive changes in their existing sections", () => {
    const html = fixturePages.get("2026-08")!;
    assert.ok(!section(html).includes(REMOVED.vendor));
    assert.ok(!section(html).includes(WINNER.vendor));
    assert.ok(!section(html).includes(DISCOVERY.vendor));
    assert.match(html, /<strong>Ended Tool<\/strong> \(1 negative change/);
    assert.match(html, /<strong>Expanded Tool<\/strong> \(1 positive change/);
    assert.match(html, /class="stat-value">5<\/div><div class="stat-label">Total Changes/);
    assert.match(html, /class="stat-value stat-neg">1<\/div>/);
    assert.match(html, /class="stat-value stat-pos">1<\/div>/);
    assert.equal(neutralCount(html), 3);
    assert.match(html, /Product Deprecated<\/td><td>3<\/td>/);
    assert.match(html, /Rebranded<\/td><td>1<\/td>/);
    assert.match(html, /Limits Increased<\/td><td>1<\/td>/);
  });

  it("omits the section when the month has effective changes but no neutral ones", () => {
    const html = fixturePages.get("2026-07")!;
    assert.equal(neutralCount(html), 0);
    assert.equal(section(html), "");
  });

  it("keeps future changes scheduled and lists only effective neutral changes", () => {
    const html = fixturePages.get("2026-10")!;
    assert.equal(neutralCount(html), 1);
    assert.equal(entries(html).length, 1);
    assert.ok(section(html).includes(EFFECTIVE.vendor));
    assert.ok(!section(html).includes(SCHEDULED.vendor));
    assert.ok(html.slice(html.indexOf("<h2>Scheduled</h2>")).includes(SCHEDULED.vendor));
  });

  it("lists more than ten neutral records even when there are no winners or losers", () => {
    const html = fixturePages.get("2026-09")!;
    assert.equal(neutralCount(html), MANY.length);
    const rows = entries(html);
    assert.equal(rows.length, MANY.length);
    MANY.forEach((record, i) => assert.ok(rows[i].includes(`<strong>${record.vendor}</strong>`)));
    assert.ok(!html.includes("<h2>Biggest Winners</h2>"));
    assert.ok(!html.includes("<h2>Biggest Losers</h2>"));
  });

  it("matches every report's Neutral figure and complete effective neutral population", () => {
    const held = changesTheVendorMade(trackedChanges(loadDealChanges()));
    for (const [month, html] of cataloguePages) {
      const expected = held.filter(c => isEventDated(c) && c.date.startsWith(month) && c.date <= servedOn
        && !countsAsANegativeChange(c) && !POSITIVE_CHANGE_TYPES.has(c.change_type))
        .sort((a, b) => a.date.localeCompare(b.date));
      const rows = entries(html);
      assert.equal(rows.length, neutralCount(html), `${month}: rows versus Neutral count`);
      assert.equal(rows.length, expected.length, `${month}: rows versus records`);
      if (expected.length === 0) assert.equal(section(html), "", month);
      expected.forEach((record, i) => {
        const where = `${month}: ${record.vendor} ${record.date}`;
        assert.ok(rows[i].startsWith(`<li><strong>${escape(record.vendor)}</strong> (${record.change_type.replace(/_/g, " ")} ${record.date})`), where);
        assert.ok(rows[i].includes(escape(record.summary)), where);
        if (record.source_url) assert.ok(rows[i].includes(`href="${escape(record.source_url.trim())}"`), where);
      });
    }
  });
});

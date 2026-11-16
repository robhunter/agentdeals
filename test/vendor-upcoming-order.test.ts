import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDocument } from "@mixmark-io/domino";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const today = new Date().toISOString().slice(0, 10);
const day = (offset: number) => new Date(Date.parse(today) + offset * 86_400_000).toISOString().slice(0, 10);
const catalogue = JSON.parse(readFileSync(path.join(ROOT, "data/index.json"), "utf8"));
const stored = JSON.parse(readFileSync(path.join(ROOT, "data/deal_changes.json"), "utf8"));
const scratch = mkdtempSync(path.join(tmpdir(), "vendor-upcoming-order-"));
const pages = new Map<string, string>();
const record = (vendor: string, offset: number, options = {}) => ({
  vendor, date: day(offset), date_source: "vendor_page", recorded_date: day(-100),
  change_type: "pricing_restructured", summary: `${vendor} changes plan ${offset}.`,
  previous_state: "Earlier plan", current_state: "Revised plan", impact: "high", category: "APIs",
  source_url: `https://example.com/${vendor.replaceAll(" ", "-")}/${offset}`, alternatives: [], ...options,
});
const fixtures = [
  { vendor: "Timeline Order", rows: [30, -20, 10, 0, 20, -5].map(offset => record("Timeline Order", offset)) },
  { vendor: "Timeline Positive", rows: [record("Timeline Positive", 30), record("Timeline Positive", 5, { change_type: "new_free_tier" }), record("Timeline Positive", 10)] },
  { vendor: "Timeline Eligibility", rows: [
    record("Timeline Eligibility", 1, { source_url: "" }),
    record("Timeline Eligibility", 2, { resolution: { state: "reversed", date: day(-1), summary: "Plan restored", source_url: "https://example.com/restored" } }),
    record("Timeline Eligibility", 10), record("Timeline Eligibility", 20),
  ] },
  { vendor: "Timeline Past", rows: [-20, -5, -10].map(offset => record("Timeline Past", offset, { change_type: "pricing_restructured" })) },
  { vendor: "Timeline Positive Only", rows: [record("Timeline Positive Only", 10, { change_type: "new_free_tier" })] },
  { vendor: "Timeline Empty", rows: [] },
];
const slug = (vendor: string) => vendor.toLowerCase().replaceAll(" ", "-");

before(async () => {
  const indexFile = path.join(scratch, "index.json");
  const changesFile = path.join(scratch, "changes.json");
  const template = catalogue.offers.find((offer: any) => offer.vendor === "Supabase");
  assert.ok(template);
  writeFileSync(indexFile, JSON.stringify({ ...catalogue, offers: fixtures.map(({ vendor }) => ({ ...template, vendor, name: vendor, url: `https://example.com/${slug(vendor)}`, category: "APIs" })) }));
  writeFileSync(changesFile, JSON.stringify({ ...stored, changes: fixtures.flatMap(fixture => fixture.rows) }));
  const child = spawn(process.execPath, [path.join(ROOT, "dist/serve.js")], {
    cwd: ROOT, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, TZ: "UTC", PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_REFERRAL_HEALTH: "off", AGENTDEALS_INDEX_PATH: indexFile, AGENTDEALS_CHANGES_PATH: changesFile },
  });
  try {
    const port = await new Promise<string>((resolve, reject) => {
      let log = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Server startup timeout: ${log}`)); }, 30_000);
      child.stderr!.on("data", chunk => {
        log += String(chunk);
        const match = log.match(/running on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${log}`)); });
    });
    for (const route of [...fixtures.map(fixture => `/vendor/${slug(fixture.vendor)}`), "/stability", "/api/changes?limit=100"]) {
      const response = await fetch(`http://localhost:${port}${route}`, { redirect: "error" });
      assert.equal(response.status, 200, route);
      assert.equal(response.url, `http://localhost:${port}${route}`);
      pages.set(route, await response.text());
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  }
});
after(() => rmSync(scratch, { recursive: true, force: true }));

function document(vendor: string) { return createDocument(pages.get(`/vendor/${slug(vendor)}`)!); }
function history(vendor: string) { return document(vendor).querySelector("#changes")!.parentNode! as any; }
function card(vendor: string) {
  const found = Array.from(createDocument(pages.get("/stability")!).querySelectorAll(".vendor-card")).find(node => node.querySelector(".vendor-name")?.textContent === vendor);
  assert.ok(found, vendor);
  return found;
}

describe("vendor upcoming change order", () => {
  it("names the soonest of three out-of-order future records in the notice", () => {
    const notice = document("Timeline Order").querySelector(".change-notice");
    assert.ok(notice);
    assert.ok(notice.textContent.includes("Timeline Order changes plan 10."), notice.textContent);
    assert.ok(notice.textContent.includes(day(10)), notice.textContent);
    assert.equal(notice.querySelector("a[href^='/pricing-changes#']")!.getAttribute("href"), `/pricing-changes#timeline-order-${day(10)}`);
  });

  it("prints three future records soonest first followed by today and past records latest first", () => {
    const section = history("Timeline Order");
    const dates = Array.from(section.querySelectorAll(".change-item .change-date")).map((node: any) => node.textContent.trim().replace(/^effective /, ""));
    assert.deepEqual(dates, [10, 20, 30, 0, -5, -20].map(day));
  });

  it("labels both nonempty history groups with the supplied headings", () => {
    const children = Array.from(history("Timeline Order").children) as any[];
    const heads = children.filter(node => node.tagName === "H3");
    assert.deepEqual(heads.map(node => node.textContent), ["Upcoming, soonest first", "Past, latest first"]);
    assert.equal(children.indexOf(heads[0]) + 4, children.indexOf(heads[1]));
    assert.equal(heads[0].nextElementSibling.querySelector(".change-date").textContent.trim().replace(/^effective /, ""), day(10));
    assert.equal(heads[1].nextElementSibling.querySelector(".change-date").textContent.trim().replace(/^effective /, ""), today);
  });

  it("keeps every history card, complete summary, before/after state and source", () => {
    for (const fixture of fixtures) {
      const cards = Array.from(history(fixture.vendor).querySelectorAll(".change-item")) as any[];
      assert.equal(cards.length, fixture.rows.length, fixture.vendor);
      for (const row of fixture.rows) {
        const found = cards.find(node => node.querySelector(".change-summary").textContent.includes(row.summary));
        assert.ok(found, row.summary);
        assert.ok(found.textContent.includes(row.previous_state));
        assert.ok(found.textContent.includes(row.current_state));
        if (row.source_url) assert.ok(Array.from(found.querySelectorAll("a")).some((node: any) => node.getAttribute("href") === row.source_url));
      }
    }
  });

  it("selects a negative notice even when an earlier positive record exists", () => {
    const notice = document("Timeline Positive").querySelector(".change-notice");
    assert.ok(notice?.textContent.includes("Timeline Positive changes plan 10."), notice?.textContent);
  });

  it("does not choose an uncited or resolved upcoming record for the notice", () => {
    const notice = document("Timeline Eligibility").querySelector(".change-notice");
    assert.ok(notice?.textContent.includes("Timeline Eligibility changes plan 10."), notice?.textContent);
  });

  it("keeps a positive-only vendor free of a negative change notice", () => {
    assert.equal(document("Timeline Positive Only").querySelector(".change-notice") ?? null, null);
    assert.deepEqual(Array.from(history("Timeline Positive Only").querySelectorAll("h3")).map(node => node.textContent), ["Upcoming, soonest first"]);
  });

  it("preserves latest-first history and duplicate-cause suppression without upcoming records", () => {
    const section = history("Timeline Past");
    assert.deepEqual(Array.from(section.querySelectorAll(".change-date")).map(node => node.textContent.trim().replace(/^effective /, "")), [-5, -10, -20].map(day));
    assert.deepEqual(Array.from(section.querySelectorAll("h3")).map(node => node.textContent), ["Past, latest first"]);
    assert.equal(document("Timeline Past").querySelector(".change-notice") ?? null, null);
    assert.ok(document("Timeline Past").querySelector(".risk-cause-line")?.textContent.includes("Timeline Past changes plan -5."));
  });

  it("keeps an empty history without group headings or a notice", () => {
    assert.equal(history("Timeline Empty").querySelectorAll("h3").length, 0);
    assert.equal(document("Timeline Empty").querySelector(".change-notice") ?? null, null);
    assert.ok(history("Timeline Empty").querySelector(".no-changes"));
  });

  it("names the soonest upcoming record on the stability card", () => {
    const found = card("Timeline Order");
    assert.ok(found.querySelector(".vendor-summary")!.textContent.includes("Timeline Order changes plan 10."));
    assert.equal(found.querySelector(".change-date")!.textContent.replace(/^effective /, ""), day(10));
    assert.equal(found.querySelector(".change-count")!.textContent, "6 changes tracked");
  });

  it("lets an earlier positive upcoming record lead the stability card", () => {
    assert.ok(card("Timeline Positive").querySelector(".vendor-summary")!.textContent.includes("Timeline Positive changes plan 5."));
    assert.equal(card("Timeline Positive").querySelector(".change-type")!.textContent, "new free tier");
  });

  it("keeps the latest stability record when all records are past", () => {
    assert.ok(card("Timeline Past").querySelector(".vendor-summary")!.textContent.includes("Timeline Past changes plan -5."));
    assert.equal(card("Timeline Past").querySelector(".change-date")!.textContent.replace(/^effective /, ""), day(-5));
  });

  it("preserves every stored record in the changes API", () => {
    const response = JSON.parse(pages.get("/api/changes?limit=100")!);
    assert.equal(response.changes.length, fixtures.flatMap(fixture => fixture.rows).length);
    for (const row of fixtures.flatMap(fixture => fixture.rows)) {
      const found = response.changes.find((change: any) => change.vendor === row.vendor && change.date === row.date);
      assert.ok(found, row.summary);
      for (const key of Object.keys(row)) {
        const expected = key === "summary" && "resolution" in row ? `No longer in force (${day(-1)}). ${row.summary}` : (row as any)[key];
        assert.deepEqual(found[key], expected, `${row.vendor} ${key}`);
      }
    }
  });
});

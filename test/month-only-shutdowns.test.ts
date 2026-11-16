import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDocument } from "@mixmark-io/domino";
import { isShutdownMonth, statedShutdownDateOf, statedShutdownMonthOf, shutdownDateStart, shutdownDateEnd } from "../dist/shutdown-date.js";
import { forecastShutdownsWithoutACard, shutdownDateOf } from "../dist/forecast-shutdowns.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const changes = JSON.parse(readFileSync(path.join(root, "data/deal_changes.json"), "utf8")).changes;
const deno = changes.find((r: any) => r.vendor === "Deno Deploy" && r.change_type === "product_deprecated");
const summary = "Deno says Deno Deploy will be sunset in April 2027 and gives no day. Existing applications keep running until then. Deno announced on October 9, 2026 that its team is joining Cloudflare. Deno will help paying customers move to Cloudflare Workers.";
const fullDates = ["2027-04-01", "2027-04-15", "2027-05-01"].map((date, i) => ({
  ...deno, vendor: `Calendar Service ${i}`, what_ends: `Calendar Service ${i}`, discontinued_date: date,
  summary: `Calendar Service ${i} retires on ${date}.`, source_url: `https://example.com/calendar/${i}`,
}));

async function pages(day: string, records: any[], directory: string, zone = "UTC") {
  const file = path.join(directory, "changes.json");
  writeFileSync(file, JSON.stringify({ changes: records }));
  const child = spawn("node", ["--import", path.join(root, "scripts/shifted-clock.mjs"), path.join(root, "dist/serve.js")], {
    cwd: root, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, TZ: zone, PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_REFERRAL_HEALTH: "off",
      AGENTDEALS_CHANGES_PATH: file, AGENTDEALS_CLOCK_SHIFT_MS: String(Date.parse(`${day}T12:00:00Z`) - Date.now()) },
  });
  try {
    const port = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      let stderr = "";
      child.stderr!.on("data", chunk => { stderr += chunk; const match = stderr.match(/running on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); } });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    });
    const result: Record<string, string> = {};
    for (const route of ["/shutdowns", "/deadlines", "/api/deadlines"]) {
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

function cards(page: string, selector: string) {
  return Array.from(createDocument(page).querySelectorAll(selector));
}

function card(page: string, selector: string, name: string) {
  const found = cards(page, selector).filter(element => element.querySelector("h3, .dl-vendor")?.textContent === name);
  assert.equal(found.length, 1, `${name} appears once`);
  return found[0];
}

function sectionOf(element: any): string {
  let previous = element.previousElementSibling;
  while (previous && previous.tagName !== "H2") previous = previous.previousElementSibling;
  return previous?.id ?? "";
}

describe("shutdown months preserve calendar precision", () => {
  for (const month of ["2027-01", "2027-04", "2027-12", "2028-02"]) {
    it(`accepts ${month} without converting it into a stated day`, () => {
      assert.equal(isShutdownMonth(month), true);
      assert.equal(statedShutdownMonthOf({ discontinued_date: month }), month);
      assert.equal(statedShutdownDateOf({ discontinued_date: month }), null);
      assert.equal(shutdownDateStart(month), `${month}-01`);
    });
  }
  for (const value of ["2027-00", "2027-13", "2027-4", "2027-04-01", "unknown", ""]) {
    it(`does not treat ${JSON.stringify(value)} as a month`, () => assert.equal(statedShutdownMonthOf({ discontinued_date: value }), null));
  }
  for (const [month, end] of [["2027-04", "2027-04-30"], ["2028-02", "2028-02-29"], ["1900-02", "1900-02-28"], ["2000-02", "2000-02-29"], ["2027-12", "2027-12-31"]]) {
    it(`uses calendar month end for ${month}`, () => assert.equal(shutdownDateEnd(month), end));
  }
  it("keeps full dates unchanged", () => {
    assert.equal(statedShutdownDateOf({ discontinued_date: "2027-04-15" }), "2027-04-15");
    assert.equal(shutdownDateStart("2027-04-15"), "2027-04-15");
    assert.equal(shutdownDateEnd("2027-04-15"), "2027-04-15");
  });
  it("stores the Deno announcement, month, source and scope", () => {
    assert.equal(deno.discontinued_date, "2027-04");
    assert.equal(deno.date, "2026-10-09");
    assert.equal(deno.source_url, "https://docs.deno.com/deploy/");
    assert.equal(deno.summary, summary);
    assert.equal(deno.listing_effect, "none");
    assert.equal(deno.what_ends, "Deno Deploy");
    assert.equal(shutdownDateOf(deno), "2027-04");
  });
  it("retains sourced month forecasts and excludes withdrawn or unconfirmed records", () => {
    const recordedDuringMonth = { ...deno, recorded_date: "2027-04-30" };
    assert.deepEqual(forecastShutdownsWithoutACard([recordedDuringMonth], []).map(s => s.deadline), ["2027-04"]);
    assert.equal(forecastShutdownsWithoutACard([{ ...deno, source_url: "" }], []).length, 0);
    assert.equal(forecastShutdownsWithoutACard([{ ...deno, resolution: { state: "retracted", date: "2026-11-15", detail: "Withdrawn" } }], []).length, 0);
    assert.equal(forecastShutdownsWithoutACard([{ ...deno, archive_check: { checked: "2026-11-15", outcome: "no_usable_capture" } }], []).length, 0);
  });
});

describe("month-only shutdowns on HTTP pages", () => {
  let directory: string;
  before(() => { directory = mkdtempSync(path.join(tmpdir(), "shutdown-months-")); });
  after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [day, section] of [["2026-11-16", "later"], ["2027-01-01", "upcoming"], ["2027-03-02", "imminent"], ["2027-04-01", "imminent"], ["2027-04-15", "imminent"], ["2027-04-30", "imminent"], ["2027-05-01", "completed"]]) {
    it(`keeps the month card in ${section} on ${day}`, async () => {
      const result = await pages(day, [deno, ...fullDates], directory);
      const shutdown = card(result["/shutdowns"], ".shutdown-card", "Deno Deploy");
      assert.equal(sectionOf(shutdown), section);
      if (section === "imminent") assert.ok(shutdown.getAttribute("style")!.includes("#f85149"));
      assert.equal(shutdown.querySelector(".shutdown-deadline > span:nth-child(2)")!.textContent, "April 2027 (no day is given)");
      assert.ok(!shutdown.querySelector(".days-badge"));
      assert.equal(shutdown.querySelector(".shutdown-what")!.textContent, summary);
      assert.equal(shutdown.querySelector("a.figure-source")!.getAttribute("href"), "https://docs.deno.com/deploy/");
      assert.doesNotMatch(shutdown.outerHTML, /Invalid Date|NaN|2027-04-\d{2}|April (?:1|30), 2027/);
      const active = day <= "2027-04-30";
      const monthList = createDocument(result["/shutdowns"]).querySelector('[data-month="2027-04"]');
      assert.equal(monthList?.textContent?.includes("Deno Deploy (April 2027)") ?? false, active);
      const deadlines = cards(result["/deadlines"], ".dl-card").filter(c => c.querySelector(".dl-vendor")?.textContent === "Deno Deploy");
      const api = JSON.parse(result["/api/deadlines"]).deadlines.filter((d: any) => d.vendor === "Deno Deploy");
      assert.equal(deadlines.length, active ? 1 : 0);
      assert.equal(api.length, active ? 1 : 0);
      if (active) {
        assert.equal(deadlines[0].querySelector(".dl-date")!.textContent, "April 2027 (no day is given)");
        assert.ok(!deadlines[0].querySelector(".dl-countdown"));
        assert.ok(deadlines[0].textContent!.includes(summary));
        assert.equal(api[0].date, "2027-04");
        assert.equal(api[0].countdown_days, null);
        assert.equal(api[0].record_date, "2026-10-09");
      }
      const control = await pages(day, fullDates, directory);
      for (const selector of [".shutdown-card", ".dl-card"]) {
        const route = selector === ".shutdown-card" ? "/shutdowns" : "/deadlines";
        const withoutDeno = cards(result[route], selector).filter(c => c.querySelector("h3, .dl-vendor")?.textContent !== "Deno Deploy");
        assert.deepEqual(withoutDeno.map(c => c.outerHTML), cards(control[route], selector).map(c => c.outerHTML));
      }
    });
  }
  it("orders an undated April shutdown ahead of April 1 on both pages and in By month", async () => {
    const result = await pages("2026-11-16", [...fullDates, deno], directory);
    for (const [route, selector] of [["/shutdowns", ".shutdown-card"], ["/deadlines", ".dl-card"]]) {
      const names = cards(result[route], selector).map(c => c.querySelector("h3, .dl-vendor")?.textContent);
      assert.ok(names.indexOf("Deno Deploy") < names.indexOf("Calendar Service 0"));
    }
    const april = createDocument(result["/shutdowns"]).querySelector('[data-month="2027-04"]')!;
    assert.ok(april.textContent!.indexOf("Deno Deploy") < april.textContent!.indexOf("Calendar Service 0"));
  });
  it("uses the effective month once when the announcement itself is still in the future", async () => {
    const record = { ...deno, date: "2026-12-01" };
    const result = await pages("2026-11-16", [record], directory);
    const found = card(result["/deadlines"], ".dl-card", "Deno Deploy");
    assert.equal(found.querySelector(".dl-date")!.textContent, "April 2027 (no day is given)");
    const api = JSON.parse(result["/api/deadlines"]).deadlines.filter((d: any) => d.vendor === "Deno Deploy");
    assert.equal(api.length, 1);
    assert.equal(api[0].date, "2027-04");
  });
  it("does not turn the next month-only shutdown into a banner's day countdown", async () => {
    const result = await pages("2028-02-15", [{ ...deno, discontinued_date: "2028-02" }], directory);
    const header = createDocument(result["/shutdowns"]).querySelector(".pub-date")!;
    assert.doesNotMatch(header.textContent!, /Next deadline in/);
  });
  it("keeps a leap-year February shutdown active through February 29 in a non-UTC timezone", async () => {
    const record = { ...deno, discontinued_date: "2028-02" };
    const active = await pages("2028-02-29", [record], directory, "Pacific/Honolulu");
    assert.equal(sectionOf(card(active["/shutdowns"], ".shutdown-card", "Deno Deploy")), "imminent");
    assert.equal(card(active["/deadlines"], ".dl-card", "Deno Deploy").querySelector(".dl-date")!.textContent, "February 2028 (no day is given)");
    const completed = await pages("2028-03-01", [record], directory, "Pacific/Honolulu");
    assert.equal(sectionOf(card(completed["/shutdowns"], ".shutdown-card", "Deno Deploy")), "completed");
    assert.ok(!cards(completed["/deadlines"], ".dl-card").some(c => c.querySelector(".dl-vendor")?.textContent === "Deno Deploy"));
  });
});

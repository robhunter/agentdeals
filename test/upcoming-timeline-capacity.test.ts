import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDocument } from "@mixmark-io/domino";
import TurndownService from "turndown";
import { changeTimelineMarkdown } from "./change-timeline-reading-budget.ts";
import { changesTheVendorMade } from "../dist/data.js";
import { trackedChanges } from "../dist/change-census.js";
import { partitionByDateProvenance } from "../dist/change-dates.js";
import { atUpcomingDate } from "../dist/upcoming-changes.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const today = new Date().toISOString().slice(0, 10);
const day = (offset: number) => new Date(Date.parse(today) + offset * 86_400_000).toISOString().slice(0, 10);
const stored = JSON.parse(readFileSync(path.join(ROOT, "data/deal_changes.json"), "utf8"));
const opening = (i: number) => `Capacity Future ${i} changes its $12.50 plan for Node.js 2.0.`;
const tail = ` The next sentence retains the full migration terms ${"a".repeat(700)}.`;
const extra = Array.from({ length: 40 }, (_, i) => ({
  vendor: `Capacity Future ${i}`, date: day(1 + i * 2), date_source: "vendor_page", recorded_date: today,
  change_type: "pricing_restructured", summary: opening(i) + tail, previous_state: "Earlier plan", current_state: "Revised plan",
  impact: "high", category: "APIs", source_url: `https://example.com/pricing/${i}`, alternatives: [],
}));
const boundary = [30, 31, 90, 91].map(offset => ({ ...extra[0], vendor: `Capacity Boundary ${offset}`, date: day(offset), summary: `Version 2.0 costs $12.50. More terms <after> & details! Another sentence?` }));
const textCases = [
  { vendor: "Capacity Single", summary: "A single sentence without final punctuation" },
  { vendor: "Capacity Question", summary: "Does the plan change? Yes, the later sentence explains." },
  { vendor: "Capacity Quote", summary: 'The plan says "Pay $12.50." More terms follow.' },
].map(record => ({ ...extra[0], ...record, date: day(40), source_url: "" }));
const overflowRecord = { ...extra[0], vendor: "Capacity Beyond Window", date: day(180), summary: "z".repeat(96_000) };
const records = [...stored.changes, ...extra, ...boundary, ...textCases, overflowRecord];
const scratch = mkdtempSync(path.join(tmpdir(), "upcoming-capacity-"));
const pages = new Map<string, string>();

before(async () => {
  const filename = path.join(scratch, "changes.json");
  writeFileSync(filename, JSON.stringify({ ...stored, changes: records }, null, 2) + "\n");
  const child = spawn("node", [path.join(ROOT, "dist/serve.js")], {
    cwd: ROOT, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, TZ: "UTC", PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_REFERRAL_HEALTH: "off", AGENTDEALS_CHANGES_PATH: filename },
  });
  try {
    const port = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30_000);
      child.stderr!.on("data", chunk => {
        const match = String(chunk).match(/running on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("exit", code => { clearTimeout(timer); reject(new Error(`Server exited with code ${code}`)); });
    });
    for (const route of ["/pricing-changes", "/changes"]) {
      const response = await fetch(`http://localhost:${port}${route}`, { redirect: "error" });
      assert.equal(response.status, 200);
      pages.set(route, await response.text());
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  }
});
after(() => rmSync(scratch, { recursive: true, force: true }));

function cardFor(vendor: string, scope = ".upcoming-section") {
  const document = createDocument(pages.get("/pricing-changes")!);
  const card = Array.from(document.querySelectorAll(`${scope} .pc-entry`)).find(node => node.querySelector(".pc-vendor")!.textContent === vendor);
  assert.ok(card, vendor);
  return card;
}

describe("upcoming pricing timeline capacity", () => {
  it("keeps forty additional near-term changes and every existing ninety-day entry inside the reading window", () => {
    const html = pages.get("/pricing-changes")!;
    const result = changeTimelineMarkdown(html);
    assert.ok(result.ends.upcoming <= 95_000, JSON.stringify(result.ends));
    const expected = changesTheVendorMade(trackedChanges(partitionByDateProvenance(records).dated)).map(c => atUpcomingDate(c, today)).filter(c => c.date > today && c.date <= day(90));
    assert.ok(expected.length >= extra.length + boundary.length - 1 + textCases.length);
    const converter = new TurndownService();
    const document = createDocument(html);
    const cards = Array.from(document.querySelectorAll(".upcoming-section .pc-entry"));
    for (const record of expected) {
      const card = cards.find(node => node.querySelector(".pc-vendor")!.textContent === record.vendor && node.querySelector(".pc-date")!.textContent!.includes(record.date));
      assert.ok(card, `${record.vendor} ${record.date}`);
      const markdown = converter.turndown(card);
      const start = result.markdown.indexOf(markdown);
      assert.ok(start >= 0 && start + markdown.length <= 95_000, `${record.vendor} ${record.date}`);
    }
    for (const [i, record] of extra.entries()) assert.ok(cardFor(record.vendor).querySelector(".pc-summary")!.textContent!.startsWith(opening(i)));
  });

  it("keeps complete first sentences, source links and unsourced notices in upcoming cards", () => {
    for (const record of boundary) {
      const text = cardFor(record.vendor).querySelector(".pc-summary")!.textContent!;
      assert.ok(text.startsWith("Version 2.0 costs $12.50."));
      assert.equal(text.includes("More terms <after> & details! Another sentence?"), false);
      assert.equal(cardFor(record.vendor).querySelector(".change-source")!.getAttribute("href"), record.source_url);
    }
    for (const [vendor, first] of [["Capacity Single", textCases[0].summary], ["Capacity Question", "Does the plan change?"], ["Capacity Quote", 'The plan says "Pay $12.50."']]) {
      const text = cardFor(vendor).querySelector(".pc-summary")!.textContent!;
      assert.ok(text.startsWith(first));
      assert.ok(!text.includes("later sentence") && !text.includes("More terms follow"));
      assert.ok(cardFor(vendor).querySelector(".unsourced-note"));
    }
  });

  it("keeps complete added records in the change log", () => {
    const document = createDocument(pages.get("/changes")!);
    for (const record of [...extra, ...boundary, ...textCases, overflowRecord]) {
      const card = Array.from(document.querySelectorAll(".chg-entry")).find(node => node.querySelector(".chg-vendor")!.textContent === record.vendor);
      assert.ok(card, record.vendor);
      assert.ok(card.querySelector(".chg-summary")!.textContent!.startsWith(record.summary));
    }
  });

  it("counts every omitted scheduled record in the existing deadlines overflow link", () => {
    const document = createDocument(pages.get("/pricing-changes")!);
    const upcoming = document.querySelector(".upcoming-section")!;
    const expected = changesTheVendorMade(trackedChanges(partitionByDateProvenance(records).dated)).map(c => atUpcomingDate(c, today)).filter(c => c.date > today).sort((a, b) => a.date.localeCompare(b.date));
    const kept = upcoming.querySelectorAll(".pc-entry").length;
    assert.ok(kept > 0 && kept < expected.length);
    const overflow = upcoming.querySelector(".upcoming-overflow")!;
    assert.ok(overflow);
    const date = new Date(expected[kept].date + "T00:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
    assert.equal(overflow.textContent, `${expected.length - kept} more scheduled changes from ${date} are listed on /deadlines.`);
    assert.equal(overflow.querySelector("a")!.getAttribute("href"), "/deadlines");
  });
});

import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDocument } from "@mixmark-io/domino";
import { changesTheVendorMade } from "../dist/data.js";
import { trackedChanges } from "../dist/change-census.js";
import { partitionByDateProvenance } from "../dist/change-dates.js";
import { atUpcomingDate } from "../dist/upcoming-changes.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const today = new Date().toISOString().slice(0, 10);
const day = (offset: number) => new Date(Date.parse(today) + offset * 86_400_000).toISOString().slice(0, 10);
const stored = JSON.parse(readFileSync(path.join(ROOT, "data/deal_changes.json"), "utf8"));
const extra = [
  { vendor: "Continuing API", summary: "The API keeps running. Version 2.0 ends at $12.50 on the stated date. Later migration details stay in the full record." },
  { vendor: "Continuing Escapes", summary: 'The API keeps running. Its "Preview <2> & Beta" ends on the stated date! Later migration details stay in the full record.' },
  { vendor: "Continuing Single", summary: "The API keeps running." },
  { vendor: "Continuing Ordinary", summary: "The API ends Version 2.0 on the stated date. Later migration details stay in the full record." },
].map((record, i) => ({
  ...record, date: day(1 + i), date_source: "vendor_page", recorded_date: today,
  change_type: "product_deprecated", impact: "high", category: "APIs",
  what_ends: "The earlier API version", discontinued_date: day(1 + i),
  previous_state: "Earlier API version", current_state: "Current API version",
  source_url: `https://example.com/retirement/${i}`, alternatives: [],
}));
const dateCases = [
  (date: string) => `The service keeps serving requests. The endpoint retires on ${date}. More migration details follow.`,
  (date: string) => `The service keeps running. Version 2.0 costs $12.50. The endpoint retires on ${date}. More migration details follow.`,
  (date: string) => `The service changes on ${date}. More migration details follow.`,
  (date: string) => `The service keeps running. The endpoint retires on ${date}. More migration details follow.`,
  (date: string) => `The service keeps serving requests. The endpoint retires on ${new Date(date + "T00:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}. More migration details follow.`,
  (date: string) => `The service keeps serving requests. The endpoint retires on ${date}. The endpoint is deleted on ${date}.`,
  (date: string) => `The service keeps serving requests. Earlier version 2.0 changes on ${day(1)}. The endpoint retires on ${date}. More migration details follow.`,
  (date: string) => `The service keeps serving requests. Its "Preview <2> & Beta" retires on ${date}! More migration details follow.`,
  (_date: string) => "The service keeps serving requests. It retires by the end of 2026.",
  (_date: string) => "The service keeps serving requests. Migration details give no retirement date.",
].map((summary, i) => ({ ...extra[0], vendor: `Dated Summary ${i}`, date: day(20 + i), discontinued_date: day(20 + i),
  summary: summary(day(20 + i)), source_url: `https://example.com/dated/${i}` }));

function namesDate(sentence: string, date: string): boolean {
  const [year, month, dateDay] = date.split("-");
  const monthName = new Date(`${year}-${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  return new RegExp(`\\b${date}\\b|\\b${monthName}\\s+${Number(dateDay)}(?:st|nd|rd|th)?,?\\s+${year}\\b`, "i").test(sentence);
}

function expectedSummary(record: { summary: string; date: string }): string {
  const sentences = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(record.summary)].map(part => part.segment);
  const count = /\bkeeps running\.\s*$/.test(sentences[0]) ? 2 : 1;
  const opening = sentences.slice(0, count).join("").trimEnd();
  const dated = namesDate(opening, record.date) ? undefined : sentences.slice(count).find(sentence => namesDate(sentence, record.date));
  return dated ? `${opening} ${dated.trim()}` : opening;
}

const past = { ...extra[0], vendor: "Continuing Past", date: today, discontinued_date: today };
const records = [past, ...stored.changes, ...extra, ...dateCases];
const scratch = mkdtempSync(path.join(tmpdir(), "upcoming-continuing-"));
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

function summaryFor(record: { vendor: string; date: string; source_url?: string }, route = "/pricing-changes") {
  const document = createDocument(pages.get(route)!);
  const prefix = route === "/pricing-changes" ? "pc" : "chg";
  const card = [...document.querySelectorAll(`.upcoming-section .${prefix}-entry`)].find(node =>
    node.querySelector(`.${prefix}-vendor`)!.textContent === record.vendor &&
    node.querySelector(`.${prefix}-date`)!.textContent!.includes(record.date) &&
    node.querySelector(".change-source")?.getAttribute("href") === record.source_url);
  assert.ok(card, `${record.vendor} ${record.date}`);
  return card.querySelector(`.${prefix}-summary`)!.textContent!;
}

const upcoming = changesTheVendorMade(trackedChanges(partitionByDateProvenance(stored.changes).dated))
  .map(record => atUpcomingDate(record, today)).filter(record => record.date > today);

describe("upcoming continuing-service summaries", () => {
  it("keeps the actual change after every continuing-service opening in the current records", () => {
    for (const record of upcoming) {
      const sentences = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(record.summary)].map(part => part.segment);
      if (/\bkeeps running\.\s*$/.test(sentences[0])) {
        assert.ok(sentences.length >= 2, `${record.vendor} ${record.date}`);
        const expected = sentences.slice(0, 2).join("").trimEnd();
        assert.ok(summaryFor(record).startsWith(expected), `${record.vendor} ${record.date}: ${expected}`);
        if (sentences.length > 2 && !namesDate(sentences[2], record.date)) assert.ok(!summaryFor(record).includes(sentences[2].trim()));
      }
    }
  });

  for (const record of extra.slice(0, 2)) it(`keeps the opening and complete change sentence for ${record.vendor}`, () => {
    const expected = record.summary.slice(0, record.summary.indexOf(" Later migration"));
    assert.ok(summaryFor(record).startsWith(expected));
    assert.ok(!summaryFor(record).includes("Later migration details"));
  });

  it("retains a single sentence when the record has no following sentence", () => {
    assert.ok(summaryFor(extra[2]).startsWith(extra[2].summary));
  });

  it("keeps ordinary first-sentence summaries unchanged", () => {
    for (const record of [...upcoming, extra[3]]) {
      const first = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(record.summary)][0].segment.trimEnd();
      if (/\bkeeps running\.$/.test(first) || expectedSummary(record) !== first) continue;
      const text = summaryFor(record);
      assert.ok(text.startsWith(first), `${record.vendor} ${record.date}`);
      const remainder = record.summary.slice(first.length).trim();
      if (remainder) assert.ok(!text.includes(remainder), `${record.vendor} ${record.date}`);
    }
  });

  it("includes the first later date sentence for every current Upcoming record", () => {
    for (const record of upcoming) {
      const expected = expectedSummary(record);
      const card = createDocument(pages.get("/pricing-changes")!).querySelectorAll(".upcoming-section .pc-entry");
      const node = [...card].find(node => node.querySelector(".pc-vendor")!.textContent === record.vendor
        && node.querySelector(".pc-date")!.textContent!.includes(record.date)
        && node.querySelector(".change-source")?.getAttribute("href") === record.source_url)!;
      assert.ok(node, `${record.vendor} ${record.date}`);
      const summary = node.querySelector(".pc-summary")!.cloneNode(true) as Element;
      for (const citation of summary.querySelectorAll(".change-source, .unsourced-note")) citation.remove();
      assert.equal(summary.textContent!.trimEnd(), expected, `${record.vendor} ${record.date}`);
    }
  });

  for (const record of dateCases) it(`retains the complete dated sentence for ${record.vendor}`, () => {
    const actual = summaryFor(record);
    assert.ok(actual.startsWith(expectedSummary(record)), record.summary);
    assert.ok(!actual.includes("More migration details"));
    if (record.vendor === "Dated Summary 5") assert.ok(!actual.includes("is deleted"));
    if (record.vendor === "Dated Summary 6") assert.ok(!actual.includes("Earlier version"));
  });

  it("keeps full summaries in historical pricing cards and Latest", () => {
    const document = createDocument(pages.get("/pricing-changes")!);
    for (const selector of [".pc-entry:not(.pc-upcoming)", ".latest-section .pc-preview"]) {
      const card = [...document.querySelectorAll(selector)].find(node => node.querySelector(".pc-vendor")!.textContent === past.vendor);
      assert.ok(card, selector);
      assert.ok(card.querySelector(".pc-summary")!.textContent!.startsWith(past.summary), selector);
    }
  });

  it("keeps complete records on the change log", () => {
    for (const record of extra) assert.ok(summaryFor(record, "/changes").startsWith(record.summary));
  });
});

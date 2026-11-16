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
const records = [...stored.changes, ...extra];
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
        if (sentences.length > 2) assert.ok(!summaryFor(record).includes(sentences[2].trim()));
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
      if (/\bkeeps running\.$/.test(first)) continue;
      const text = summaryFor(record);
      assert.ok(text.startsWith(first), `${record.vendor} ${record.date}`);
      const remainder = record.summary.slice(first.length).trim();
      if (remainder) assert.ok(!text.includes(remainder), `${record.vendor} ${record.date}`);
    }
  });

  it("keeps complete records on the change log", () => {
    for (const record of extra) assert.ok(summaryFor(record, "/changes").startsWith(record.summary));
  });
});

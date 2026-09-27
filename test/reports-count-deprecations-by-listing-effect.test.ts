import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const now = new Date();
const LAST_MONTH = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 7);
const dayOfLastMonth = (day: number): string => `${LAST_MONTH}-${String(day).padStart(2, "0")}`;

const A_RECORD = {
  previous_state: "The product is available.",
  current_state: "The product is retired.",
  impact: "high",
  category: "AI/ML",
  alternatives: [],
  recorded_date: dayOfLastMonth(20),
  date_source: "hand_written",
};

const REMOVAL = { ...A_RECORD, vendor: "OpenAI", change_type: "free_tier_removed", date: dayOfLastMonth(10), source_url: "https://openai.com/api/pricing/", summary: "The free API tier ended." };
const DEPRECATION_ON_THE_LISTING = { ...A_RECORD, vendor: "Groq", change_type: "product_deprecated", listing_effect: "ends", date: dayOfLastMonth(12), source_url: "https://groq.com/pricing", summary: "The listed inference API shut down." };
const DEPRECATION_ELSEWHERE = { ...A_RECORD, vendor: "Cohere", change_type: "product_deprecated", listing_effect: "none", date: dayOfLastMonth(14), source_url: "https://cohere.com/pricing", summary: "Legacy Embed v2 was retired; the listed API is unaffected." };

describe("#1302 the monthly report and /state-of-free-tiers count a deprecation as negative only when it touches the listing", () => {
  let dir = "";
  let proc: ChildProcess | null = null;
  let report = "";
  let state = "";

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "reports-deprecations-"));
    const changesPath = path.join(dir, "changes.json");
    writeFileSync(changesPath, JSON.stringify({ changes: [REMOVAL, DEPRECATION_ON_THE_LISTING, DEPRECATION_ELSEWHERE] }));
    proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_CHANGES_PATH: changesPath },
    });
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 60000);
      proc!.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timeout); resolve(parseInt(m[1], 10)); }
      });
      proc!.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
    const reportResponse = await fetch(`http://localhost:${port}/reports/${LAST_MONTH}`);
    assert.strictEqual(reportResponse.status, 200, `/reports/${LAST_MONTH} answered ${reportResponse.status}`);
    report = await reportResponse.text();
    state = await fetch(`http://localhost:${port}/state-of-free-tiers`).then((r) => r.text());
  });

  after(() => {
    proc?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("names among the Biggest Losers the vendors whose listing ended, and not a vendor that retired another product", () => {
    const start = report.indexOf("<h2>Biggest Losers</h2>");
    assert.ok(start >= 0, "the report has no Biggest Losers");
    const losers = report.slice(start, report.indexOf("</ul></li></ul>", start) + 15);
    assert.ok(losers.includes(`<strong>${REMOVAL.vendor}</strong>`), losers);
    assert.ok(losers.includes(`<strong>${DEPRECATION_ON_THE_LISTING.vendor}</strong>`), losers);
    assert.ok(!losers.includes(DEPRECATION_ELSEWHERE.vendor), losers);
  });

  it("counts two negative changes on /state-of-free-tiers, and lists the other product's retirement nowhere among them", () => {
    const counted = /Of [^,]*tracked[^,]*, (\d+) \(/.exec(state);
    assert.ok(counted, "/state-of-free-tiers states no count of negative changes");
    assert.strictEqual(Number(counted![1]), 2, counted![0]);
    assert.ok(state.includes(DEPRECATION_ON_THE_LISTING.summary), "the squeeze list leaves out the deprecation that ended the listing");
    assert.ok(!state.includes(DEPRECATION_ELSEWHERE.summary), "the squeeze list counts another product's retirement against the listing");
  });
});

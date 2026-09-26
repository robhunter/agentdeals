import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { isIndexHousekeeping } = await import("../dist/change-census.js");

type DealChange = import("../src/types.ts").DealChange;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const PAGES_LISTING_CHANGES_IN_A_WIDGET_OF_THEIR_OWN = [
  "/gcp-free-tier-2026",
  "/events/google-io-2026",
  "/events/google-cloud-next-2026",
  "/llm-api-pricing",
];

const EVENT_PAGES = PAGES_LISTING_CHANGES_IN_A_WIDGET_OF_THEIR_OWN.filter((p) => p.startsWith("/events/"));

const A_VENDOR_EVERY_ONE_OF_THEM_LISTS = "Google Gemini";

const escaped = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const changeLog = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")) as { changes: DealChange[] };
const ourIndexRecord = changeLog.changes.find(isIndexHousekeeping);

function ourIndexRecordNewerThanAnyOther(): DealChange {
  assert.ok(ourIndexRecord, "the change log holds no record of our own index, so there is none to copy");
  const runDate = new Date().toISOString().slice(0, 10);
  return { ...ourIndexRecord, vendor: A_VENDOR_EVERY_ONE_OF_THEM_LISTS, date: runDate, recorded_date: runDate };
}

const served: DealChange[] = [ourIndexRecordNewerThanAnyOther(), ...changeLog.changes];
const ourIndexSummaries = [...new Set(served.filter(isIndexHousekeeping).map((c) => escaped(c.summary)))];
const vendorEventOpenings = [...new Set(served.filter((c) => !isIndexHousekeeping(c)).map((c) => escaped(c.summary.slice(0, 40))))];

function updateItems(html: string): { badge: string; body: string }[] {
  return [...html.matchAll(/<div class="update-item">([\s\S]*?)<div class="update-summary">([\s\S]*?)<\/div>/g)].map((m) => ({
    badge: m[1].match(/<span class="badge"[^>]*>([^<]*)<\/span>/)?.[1] ?? "",
    body: m[2],
  }));
}

describe("a page listing change records in a widget of its own leaves out records of our own index", () => {
  let proc: ChildProcess;
  let port = 0;
  const pages = new Map<string, string>();

  before(async () => {
    const fixture = path.join(mkdtempSync(path.join(tmpdir(), "our-index-newest-")), "deal_changes.json");
    writeFileSync(fixture, JSON.stringify({ ...changeLog, changes: served }));
    proc = await new Promise<ChildProcess>((resolve, reject) => {
      const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_CHANGES_PATH: fixture },
      });
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { port = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
      });
      child.on("error", (e) => { clearTimeout(timeout); reject(e); });
    });
    for (const page of PAGES_LISTING_CHANGES_IN_A_WIDGET_OF_THEIR_OWN) {
      const res = await fetch(`http://localhost:${port}${page}`);
      assert.strictEqual(res.status, 200, `${page} answered ${res.status}`);
      pages.set(page, await res.text());
    }
  });

  after(() => { proc?.kill(); });

  for (const page of PAGES_LISTING_CHANGES_IN_A_WIDGET_OF_THEIR_OWN) {
    it(`${page} renders no record of our own index, not even the newest`, () => {
      const shown = ourIndexSummaries.filter((summary) => pages.get(page)!.includes(summary));
      assert.deepStrictEqual(shown, [], `${page} renders a record of our own index as a vendor event`);
    });

    it(`${page} still renders the vendor events it lists`, () => {
      assert.ok(
        vendorEventOpenings.some((opening) => pages.get(page)!.includes(opening)),
        `${page} renders no vendor event at all, so leaving ours out proves nothing`,
      );
    });
  }

  for (const page of EVENT_PAGES) {
    it(`${page} badges no record of our own index`, () => {
      const ours = updateItems(pages.get(page)!).filter((item) => ourIndexSummaries.some((summary) => item.body.includes(summary)));
      assert.deepStrictEqual(ours.map((item) => item.badge), [], `${page} badges a record of our own index`);
    });

    it(`${page} still badges a vendor's own deprecation`, () => {
      const badged = updateItems(pages.get(page)!).filter(
        (item) => item.badge === "deprecated" && !ourIndexSummaries.some((summary) => item.body.includes(summary)),
      );
      assert.ok(badged.length > 0, `${page} badges no deprecation at all, so the badge check reads nothing`);
    });
  }
});

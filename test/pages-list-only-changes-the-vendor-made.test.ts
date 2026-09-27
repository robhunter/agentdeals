import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.parse(`${TODAY}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const MARKER = "Data correction - fixture row that no page listing pricing changes may print";

const liveLog = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8"));
const vendorsWithAChange: string[] = [...new Set<string>(
  liveLog.changes
    .filter((c: { change_type: string; resolution?: unknown }) => c.change_type !== "record_corrected" && !c.resolution)
    .map((c: { vendor: string }) => c.vendor),
)];

const ourCorrections = vendorsWithAChange.map(vendor => ({
  vendor,
  change_type: "record_corrected",
  date: TODAY,
  summary: `${MARKER} (${vendor})`,
  previous_state: "Our earlier entry",
  current_state: "Our corrected entry",
  impact: "high",
  source_url: "https://example.com/pricing",
  category: "APIs",
  alternatives: [],
  recorded_date: YESTERDAY,
  date_source: "hand_written",
}));

const LOGS_THAT_LIST_EVERY_RECORD = new Set(["/changes", "/pricing-changes"]);
const listsAVendorsOwnHistory = (route: string) => route.startsWith("/vendor/");

const scratch = mkdtempSync(path.join(tmpdir(), "vendor-made-pages-"));
const changesPath = path.join(scratch, "deal_changes.json");
writeFileSync(changesPath, JSON.stringify({ ...liveLog, changes: [...liveLog.changes, ...ourCorrections] }));

let server: ChildProcess;
let port = 0;

before(async () => {
  ({ child: server, port } = await new Promise<{ child: ChildProcess; port: number }>((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_CHANGES_PATH: changesPath },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  }));
});

after(() => {
  server?.kill();
  rmSync(scratch, { recursive: true, force: true });
});

async function routesInTheSitemap(): Promise<string[]> {
  const xml = await (await fetch(`http://localhost:${port}/sitemap-pages.xml`)).text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => new URL(loc).pathname);
}

describe("a page that lists pricing changes lists only the changes the vendor made", () => {
  it("prints none of our own corrections outside the logs and the vendor's own history", async () => {
    assert.ok(vendorsWithAChange.length > 0, "the log holds no vendor change, so no correction can be placed beside one");
    const routes = (await routesInTheSitemap()).filter(r => !LOGS_THAT_LIST_EVERY_RECORD.has(r) && !listsAVendorsOwnHistory(r));
    const printing: string[] = [];
    let read = 0;
    for (const route of routes) {
      const res = await fetch(`http://localhost:${port}${route}`);
      if (res.status !== 200) continue;
      read++;
      if ((await res.text()).includes(MARKER)) printing.push(route);
    }
    assert.ok(read > routes.length / 2, `only ${read} of ${routes.length} routes answered, so the sweep did not read the site`);
    assert.deepStrictEqual(printing, []);
  });

  it("keeps listing our corrections in the logs", async () => {
    for (const route of LOGS_THAT_LIST_EVERY_RECORD) {
      const html = await (await fetch(`http://localhost:${port}${route}`)).text();
      assert.ok(html.includes(MARKER), `${route} no longer lists our corrections`);
    }
  });
});

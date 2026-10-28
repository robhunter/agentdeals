import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = "Report Metrics";
const URL = "https://report-metrics.example/pricing";
const TERMS = "Free analytics includes 3,000 sessions per month for a single project.";
const OLD_TERMS = "Historical analytics included 1,500 sessions per month.";
const ROUTES = ["/q1-2026-developer-pricing-report", "/q2-pricing-preview-2026"];
const NOW = Date.parse("2026-11-06T00:00:00Z");
const dayAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString().slice(0, 10);

for (const scenario of [
  { name: "at the grace boundary", outcome: "unreachable", last: dayAgo(14), terminal: false, notice: true },
  { name: "within the grace period", outcome: "unreachable", last: dayAgo(13), terminal: false, notice: false },
  { name: "after recovery", outcome: "reachable", last: dayAgo(14), terminal: false, notice: false },
  { name: "without a stored check", outcome: null, last: null, terminal: false, notice: false },
  { name: "after a terminal response with no earlier success", outcome: "unreachable", last: null, terminal: true, notice: true },
]) {
  describe(`repeated listing terms ${scenario.name}`, () => {
    let directory: string;
    let server: ChildProcess;
    let base: string;
    const reports = new Map<string, string>();

    before(async () => {
      directory = mkdtempSync(path.join(tmpdir(), "report-link-notice-"));
      const write = (name: string, data: unknown) => {
        const filename = path.join(directory, name);
        writeFileSync(filename, JSON.stringify(data));
        return filename;
      };
      const offer = (vendor: string, url: string) => ({
        vendor, url, description: TERMS, category: "Analytics", tier: "Free Tier",
        verifiedDate: dayAgo(0), conditions: [], tags: [],
      });
      const change = (vendor: string, current_state: string) => ({
        vendor, current_state, date: "2026-03-28", recorded_date: "2026-03-28",
        change_type: "limits_increased", date_source: "vendor_page", impact: "low",
        previous_state: "No sessions included.", summary: "Analytics sessions increased.",
        source_url: URL, category: "Analytics", alternatives: [],
      });
      const clock = path.join(directory, "clock.mjs");
      writeFileSync(clock, `
        const NativeDate = Date;
        globalThis.Date = class extends NativeDate {
          constructor(...args) { super(...(args.length ? args : [${NOW}])); }
          static now() { return ${NOW}; }
        };
      `);
      server = spawn(process.execPath, ["--import", clock, path.join(REPO, "dist/serve.js")], {
        cwd: REPO,
        env: {
          ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC",
          AGENTDEALS_INDEX_PATH: write("index.json", { offers: [offer(VENDOR, URL), offer("Reachable Metrics", "https://reachable-metrics.example/pricing")] }),
          AGENTDEALS_CHANGES_PATH: write("changes.json", { changes: [change(VENDOR, TERMS), change(VENDOR, OLD_TERMS), change("Reachable Metrics", TERMS)] }),
          AGENTDEALS_LINK_HEALTH_PATH: write("links.json", { links: scenario.outcome === null ? [] : [{
            url: URL, checked: dayAgo(0), outcome: scenario.outcome, terminal: scenario.terminal,
            last_reachable: scenario.last, detail: "GET 410", consecutive_unreachable: 3,
          }] }),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const port = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => { server.kill(); reject(new Error("Server startup timeout")); }, 30000);
        server.stderr!.on("data", (data: Buffer) => {
          const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
          if (match) { clearTimeout(timer); resolve(match[1]); }
        });
        server.on("error", error => { clearTimeout(timer); reject(error); });
        server.on("exit", code => { clearTimeout(timer); reject(new Error(`Server exited with ${code}`)); });
      });
      base = `http://localhost:${port}`;
      for (const route of ROUTES) {
        const response = await fetch(base + route);
        assert.equal(response.status, 200);
        reports.set(route, await response.text());
      }
    });

    after(() => {
      server?.kill();
      if (directory) rmSync(directory, { recursive: true, force: true });
    });

    for (const route of ROUTES) {
      it(`carries the vendor notice beside the exact repeated terms on ${route}`, async () => {
        const vendorResponse = await fetch(base + "/vendor/report-metrics");
        assert.equal(vendorResponse.status, 200);
        const vendorPage = await vendorResponse.text();
        assert.equal(vendorPage.includes('class="link-unreachable-line"'), scenario.notice);
        const categoryResponse = await fetch(base + "/category/analytics");
        assert.equal(categoryResponse.status, 200);
        const categoryPage = await categoryResponse.text();
        const vendorNotice = categoryPage.match(/<span class="listing-link-unreachable"[^>]*>[\s\S]*?<\/span>/)?.[0];
        assert.equal(Boolean(vendorNotice), scenario.notice);
        const blocks = [...reports.get(route)!.matchAll(/<div class="change-after"><strong>After:<\/strong> ([\s\S]*?)<\/div>/g)].map(match => match[1]);
        assert.equal(blocks.length, 3);
        const repeated = blocks[0];
        assert.ok(repeated.startsWith(TERMS));
        assert.equal((repeated.match(/class="listing-link-unreachable"/g) ?? []).length, scenario.notice ? 1 : 0);
        if (vendorNotice) {
          assert.equal(repeated, TERMS + vendorNotice);
          assert.ok(vendorNotice.includes(scenario.last ? `since ${scenario.last}` : "pricing page has not resolved"));
        }
        assert.ok(blocks.includes(OLD_TERMS), "different historical terms must remain unchanged");
        assert.ok(blocks.includes(TERMS), "a different vendor with the same terms must remain unchanged");
      });
    }

    it("keeps one unreachable notice on an ordinary category listing", async () => {
      const response = await fetch(base + "/category/analytics");
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.equal((html.match(/class="listing-link-unreachable"/g) ?? []).length, scenario.notice ? 1 : 0);
    });
  });
}

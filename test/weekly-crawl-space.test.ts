import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const weeks = [
  { ago: 0, key: "2026-w53", date: "2026-12-29" },
  { ago: 1, key: "2026-w52", date: "2026-12-22" },
  { ago: 3, key: "2026-w50", date: "2026-12-08" },
];
let scratch = "";
let proc: ChildProcess | undefined;
let base = "";

before(async () => {
  scratch = mkdtempSync(path.join(tmpdir(), "weekly-crawl-"));
  writeFileSync(path.join(scratch, "index.json"), JSON.stringify({ offers: [] }));
  writeFileSync(path.join(scratch, "changes.json"), JSON.stringify({ changes: weeks.map(week => ({
    vendor: `Week ${week.key}`, date: week.date, date_source: "vendor_page", recorded_date: "2026-11-01",
    change_type: "limits_reduced", category: "Cloud Hosting", impact: "medium", listing_effect: "none",
    summary: "The vendor reduced its free allowance.", previous_state: "Earlier allowance", current_state: "Lower allowance",
    source_url: "https://example.com/pricing", alternatives: [],
  })) }));
  proc = spawn("node", ["--import", path.join(REPO, "scripts/shifted-clock.mjs"), path.join(REPO, "dist/serve.js")], {
    cwd: REPO, stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "America/Los_Angeles",
      AGENTDEALS_CLOCK_SHIFT_MS: String(Date.parse("2027-01-01T00:30:00Z") - Date.now()),
      AGENTDEALS_INDEX_PATH: path.join(scratch, "index.json"), AGENTDEALS_CHANGES_PATH: path.join(scratch, "changes.json"),
    },
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { proc!.kill("SIGKILL"); reject(new Error("Server startup timeout")); }, 30000);
    let stderr = "";
    proc!.stderr!.on("data", chunk => {
      stderr += String(chunk);
      const port = stderr.match(/running on http:\/\/localhost:(\d+)/)?.[1];
      if (port) { base = `http://localhost:${port}`; clearTimeout(timeout); resolve(); }
    });
    proc!.once("error", error => { clearTimeout(timeout); reject(error); });
    proc!.once("exit", code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${stderr}`)); });
  });
});

after(async () => {
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = once(proc, "exit");
    proc.kill("SIGKILL");
    await exited;
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const read = (route: string, method = "GET") => fetch(base + route, { method, redirect: "manual" });

async function body(route: string) {
  const response = await read(route);
  assert.equal(response.status, 200, route);
  return response.text();
}

describe("finite weekly crawl paths", () => {
  for (const week of weeks) for (const method of ["GET", "HEAD"]) {
    it(`${method} offset ${week.ago} redirects to ${week.key} across the ISO year boundary`, async () => {
      const response = await read(`/this-week?week=${week.ago}`, method);
      assert.equal(response.status, 301);
      assert.equal(response.headers.get("location"), `/digest/${week.key}`);
      assert.equal(await response.text(), "");
      assert.equal((await read(response.headers.get("location")!, method)).status, 200);
    });
  }

  for (const value of ["", "-1", "abc", "1abc", "1.5", "1e2", "Infinity", "NaN", "2", "4", "150", "500", "9007199254740991", "9007199254740992", "1&week=0"]) {
    it(`rejects the unavailable or malformed offset ${JSON.stringify(value)}`, async () => {
      for (const method of ["GET", "HEAD"]) {
        const response = await read(`/this-week?week=${value}`, method);
        assert.equal(response.status, 404, `${method} ${value}`);
        assert.equal(response.headers.get("location"), null);
        if (method === "HEAD") assert.equal(await response.text(), "");
      }
    });
  }

  it("keeps the unparameterized current page and links its previous week to the archive", async () => {
    const html = await body("/this-week");
    assert.ok(html.includes("This Week in Developer Pricing"));
    assert.match(html, /rel="canonical" href="[^\"]*\/this-week"/);
    assert.ok(html.includes('href="/digest/2026-w52">&larr; Previous week'));
    assert.ok(!html.includes("/this-week?week="));
    assert.equal((await read("/this-week", "HEAD")).status, 200);
  });

  it("links past Atom entries to their dated archive pages", async () => {
    const xml = await body("/feed.xml");
    for (const week of weeks) {
      const entry = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(match => match[1]!).find(entry => entry.includes(`Week ${week.key}`));
      assert.ok(entry, week.key);
      const target = week.ago === 0 ? "/this-week" : `/digest/${week.key}`;
      assert.ok(entry.includes(`href="http://localhost${target}" rel="alternate"`));
    }
    assert.ok(!xml.includes("/this-week?week="));
    assert.equal(await body("/api/feed"), xml);
  });

  it("declares every child sitemap after the sitemap index and preserves search exclusion", async () => {
    const robots = await body("/robots.txt");
    const declarations = [...robots.matchAll(/^Sitemap: (\S+)$/gm)].map(match => match[1]!);
    const index = await body("/sitemap.xml");
    const children = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]!);
    assert.equal(children.length, 5);
    assert.deepEqual(declarations, ["http://localhost/sitemap.xml", ...children]);
    assert.match(robots, /^Disallow: \/search\?$/m);
    assert.match(robots, /^Allow: \/$/m);
  });

  it("keeps the finite dated sitemap population and archive navigation", async () => {
    const sitemap = await body("/sitemap-reports.xml");
    const keys = [...sitemap.matchAll(/<loc>[^<]*\/digest\/(\d{4}-w\d{2})<\/loc>/g)].map(match => match[1]!).sort();
    assert.deepEqual(keys, weeks.map(week => week.key).sort());
    for (const route of ["/digest/archive", ...weeks.map(week => `/digest/${week.key}`)]) {
      assert.ok(!(await body(route)).includes("/this-week?week="), route);
    }
    const oldest = await body("/digest/2026-w50");
    assert.ok(!oldest.includes('href="/digest/2026-w49"'));
  });
});

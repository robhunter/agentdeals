// Locks the wiring between the HTTP server and the outcome split (#1029).
//
// not-found-accounting.test.ts proves the counters are right once `recordTraffic` and
// `recordPageView` are told the status. It cannot prove the server tells them: a handler
// that returns before the hook is registered, or a hook registered before the status is
// known, keeps producing the bug this issue is about — a 404 counted as a page view.
// That is exactly how the page-view hook came to miss every redirect (found in #1019), so
// this drives the real server over real HTTP.

import { describe, it, after, before } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "..", "dist", "serve.js");
const telemetryPath = path.join(__dirname, "..", "data", "telemetry.json");
const telemetryBackup = `${telemetryPath}.not-found-wiring-backup`;

let port = 0;
let proc: ChildProcess;
let movedAside = false;

before(async () => {
  // Same isolation as the search wiring test: data/telemetry.json is gitignored local
  // detritus that any spawned server hydrates.
  if (existsSync(telemetryPath)) {
    renameSync(telemetryPath, telemetryBackup);
    movedAside = true;
  }

  proc = spawn("node", [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    // BASE_URL decides the canonical hostname, and a request to localhost that does not
    // match it 301s before reaching any handler — which would make every case below
    // assert on the canonical redirect instead of on what it means to.
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("server start timeout")); }, 20000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) { port = parseInt(match[1], 10); clearTimeout(timeout); resolve(); }
    });
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
});

after(() => {
  proc?.kill("SIGKILL");
  if (movedAside) renameSync(telemetryBackup, telemetryPath);
  else if (existsSync(telemetryPath)) rmSync(telemetryPath);
});

const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function request(pathname: string, redirect: RequestRedirect = "manual"): Promise<number> {
  const res = await fetch(`http://localhost:${port}${pathname}`, {
    headers: { "user-agent": BROWSER },
    redirect,
  });
  await res.arrayBuffer();
  return res.status;
}

/** Read through the internal marker so the observability call is not itself measured. */
async function observe(pathname: string): Promise<any> {
  const res = await fetch(`http://localhost:${port}${pathname}`, {
    headers: { "user-agent": "agentdeals-internal/1.0 (wiring test)" },
  });
  assert.strictEqual(res.status, 200, `${pathname} -> ${res.status}`);
  return res.json();
}

describe("404 accounting wiring (#1029)", () => {
  it("counts a real 404 as not-found and not as traffic", async () => {
    const before = await observe("/api/traffic");
    const status = await request(`/zzz-wiring-probe-${process.pid}`);
    assert.strictEqual(status, 404, "precondition: the probe path must actually 404");
    const after = await observe("/api/traffic");

    assert.strictEqual(
      after.since_boot_not_found - before.since_boot_not_found,
      1,
      "the 404 must be counted, under its own name",
    );
    assert.strictEqual(
      after.since_boot_by_class.browser - before.since_boot_by_class.browser,
      0,
      "and it must not appear as a page this client read",
    );
  });

  it("counts a real 200 as traffic", async () => {
    const before = await observe("/api/traffic");
    assert.strictEqual(await request("/"), 200);
    const after = await observe("/api/traffic");

    assert.strictEqual(after.since_boot_by_class.browser - before.since_boot_by_class.browser, 1);
    assert.strictEqual(after.since_boot_not_found - before.since_boot_not_found, 0);
  });

  it("counts a real 301 apart from both", async () => {
    const before = await observe("/api/traffic");
    // /vendors/<slug> 301s to /vendor/<slug>. This branch returns *above* the page-view
    // hook, which is why the traffic hook is registered first — a redirect that nothing
    // records at all is the failure mode here.
    assert.strictEqual(await request("/vendors/neon"), 301);
    const after = await observe("/api/traffic");

    assert.strictEqual(after.since_boot_redirects - before.since_boot_redirects, 1);
    assert.strictEqual(after.since_boot_not_found - before.since_boot_not_found, 0);
    assert.strictEqual(after.since_boot_by_class.browser - before.since_boot_by_class.browser, 0);
  });

  it("keeps a real 404 out of page_views_today on /api/metrics", async () => {
    const before = (await observe("/api/metrics")).page_views_today;
    await request(`/zzz-wiring-probe-b-${process.pid}`);
    const mid = (await observe("/api/metrics")).page_views_today;
    assert.strictEqual(mid - before, 0, "a 404 is not a page view on any surface");

    assert.strictEqual(await request("/estimate"), 200);
    const after = (await observe("/api/metrics")).page_views_today;
    assert.strictEqual(after - mid, 1, "and a served page still is");
  });

  it("samples the real 404 with its path, class and status", async () => {
    const probe = `/zzz-wiring-sample-${process.pid}`;
    await request(probe);
    const sample = (await observe("/api/traffic")).not_found_sample;

    const entry = sample.find((s: any) => s.path === probe);
    assert.ok(entry, `probe not in the sample: ${JSON.stringify(sample.slice(0, 3))}`);
    assert.strictEqual(entry.status, 404);
    assert.strictEqual(entry.client_class, "browser");
    assert.ok(Date.parse(entry.ts) > 0);
  });

  it("states the denominator on both reporting endpoints", async () => {
    const traffic = await observe("/api/traffic");
    const pageviews = await observe("/api/pageviews");

    for (const w of [traffic.today, traffic.last_7d, traffic.last_30d]) {
      assert.strictEqual(typeof w.coverage, "string");
      assert.strictEqual(typeof w.data_days_available, "number");
      assert.strictEqual(typeof w.not_found_total, "number");
    }
    assert.ok(pageviews.notes.length > 0, "/api/pageviews must state what it counts");
    assert.ok(Array.isArray(traffic.not_found_sample));
    // Present even with no storage configured — the field must not be conditional on it.
    assert.ok("all_time_trustworthy_from" in pageviews);
  });
});

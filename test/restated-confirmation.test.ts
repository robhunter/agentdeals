import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
const READING = day(120);
const RESTATED = day(100);
const CONFIRMED = day(10);
const CHANGED = day(2);

const cases = [
  { vendor: "Latercorp", success: CONFIRMED, outcome: "confirmed", attempt: CONFIRMED },
  { vendor: "Changedcorp", success: CONFIRMED, outcome: "changed", attempt: CHANGED },
  { vendor: "Earliercorp", success: day(110), outcome: "changed", attempt: CHANGED },
  { vendor: "Samecorp", success: RESTATED, outcome: "changed", attempt: CHANGED },
  { vendor: "Nevercorp", success: null, outcome: "changed", attempt: CHANGED },
  { vendor: "Oldcorp", success: day(95), outcome: "confirmed", attempt: day(95) },
];

const offers = cases.map(({ vendor }) => ({
  vendor,
  url: `https://${vendor.toLowerCase()}.example/pricing`,
  category: "Databases",
  tier: "Free",
  description: "Free plan includes 500 MB of storage and 10 projects.",
  verifiedDate: READING,
  tags: ["databases"],
  restated_from: {
    reading_date: READING,
    restated_on: RESTATED,
    source_url: `https://${vendor.toLowerCase()}.example/pricing`,
    record_date: READING,
    change_type: "limits_reduced",
  },
}));

let scratch = "";
let proc: ChildProcess | undefined;
let origin = "";
const pages = new Map<string, string>();

async function response(route: string): Promise<Response> {
  const result = await fetch(`${origin}${route}`, { redirect: "error" });
  assert.equal(result.status, 200, route);
  assert.equal(new URL(result.url).origin, origin);
  return result;
}

describe("confirmations of restated terms reach published pages and data", () => {
  before(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "restated-confirmation-"));
    const indexPath = path.join(scratch, "index.json");
    const statePath = path.join(scratch, "state.json");
    writeFileSync(indexPath, JSON.stringify({ offers, categories: ["Databases"] }));
    writeFileSync(statePath, JSON.stringify({ records: cases.map((entry, i) => ({
      vendor: entry.vendor,
      url: offers[i]!.url,
      last_attempt_at: entry.attempt,
      last_outcome: entry.outcome,
      last_success: entry.success,
      consecutive_failures: 0,
      quarantined_since: null,
    })) }));
    proc = spawn(process.execPath, [path.join(REPO, "dist", "serve.js")], {
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC",
        AGENTDEALS_INDEX_PATH: indexPath, AGENTDEALS_VERIFICATION_STATE_PATH: statePath },
      stdio: ["ignore", "ignore", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { proc?.kill(); reject(new Error("server did not start")); }, 30_000);
      proc!.once("error", error => { clearTimeout(timeout); reject(error); });
      proc!.stderr!.on("data", chunk => {
        const port = chunk.toString().match(/running on http:\/\/localhost:(\d+)/)?.[1];
        if (port) { origin = `http://localhost:${port}`; clearTimeout(timeout); resolve(); }
      });
    });
    for (const { vendor } of cases) pages.set(vendor, await (await response(`/vendor/${vendor.toLowerCase()}`)).text());
  });

  after(() => {
    proc?.kill();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("states a later confirmation on the vendor page and its labelled date", () => {
    const html = pages.get("Latercorp")!;
    assert.match(html, /day we last confirmed the terms we publish/);
    assert.match(html, new RegExp(`>Verified</div>\\s*<div class="detail-value"[^>]*>${CONFIRMED}<`));
    assert.doesNotMatch(html, /without confirming them|We hold no confirmation of the terms we publish/);
  });

  it("keeps the confirmation beside a later read that found different terms", () => {
    const html = pages.get("Changedcorp")!;
    assert.match(html, new RegExp(CONFIRMED));
    assert.match(html, new RegExp(CHANGED));
    assert.match(html, /last confirmed on/);
    assert.doesNotMatch(html, /We hold no confirmation of the terms we publish/);
  });

  it("keeps the restatement disclaimer when no later read confirmed the replacement", () => {
    for (const vendor of ["Earliercorp", "Samecorp", "Nevercorp"]) {
      const html = pages.get(vendor)!;
      assert.match(html, /without confirming them/, vendor);
      assert.match(html, /We hold no confirmation of the terms we publish/, vendor);
      assert.match(html, />Catalogue date<\/div>/, vendor);
    }
  });

  it("publishes confirmed_on in freshness data and retains the details API reading", async () => {
    const metrics = await (await response("/api/freshness")).json();
    for (const vendor of ["Latercorp", "Changedcorp"]) {
      assert.equal(metrics.freshest_entries.find((entry: { vendor: string }) => entry.vendor === vendor)?.confirmed_on, CONFIRMED, vendor);
      const body = await (await response(`/api/details/${vendor.toLowerCase()}`)).json();
      assert.equal(body.offer.last_read_outcome, cases.find(entry => entry.vendor === vendor)!.outcome, vendor);
    }
    assert.equal(metrics.freshest_entries.find((entry: { vendor: string }) => entry.vendor === "Earliercorp")?.confirmed_on, null);
  });

  it("counts recent confirmations without counting older or pre-restatement successes", async () => {
    const body = await (await response("/api/freshness")).json();
    assert.equal(body.total_offers, cases.length);
    assert.equal(body.confirmed_within_90_days, 2);
    assert.equal(body.offers_holding_a_confirmation, 3);
    const html = await (await response("/freshness")).text();
    assert.match(html, /source 2 of 6 entries to a read that confirmed/);
  });
});

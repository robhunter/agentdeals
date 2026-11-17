import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertChangeVendorIndex } from "./change-vendor-index-observer.ts";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(path.join(tmpdir(), "change-vendor-index-"));
const children: ChildProcess[] = [];
const pages = new Map<string, string>();
const routes = ["/pricing-changes", "/changes"];
const today = new Date().toISOString().slice(0, 10);
const day = (offset: number) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

const change = (vendor: string, change_type: string, date: string, extra = {}) => ({
  vendor, change_type, date, date_source: "vendor_page", recorded_date: date,
  summary: `${vendor} changed its plan`, previous_state: "Before", current_state: "After",
  impact: "medium", source_url: "https://example.com/pricing", category: "APIs", alternatives: [], ...extra,
});

const fixtures = [
  change("Cerebras", "limits_reduced", day(-200)),
  change("Cerebras", "free_tier_removed", day(-10)),
  change("Cerebras", "restriction", day(10)),
  change("Cerebras", "new_free_tier", day(-5), { date_source: "discovered" }),
  change("Cerebras", "limits_increased", day(-400)),
  change("A & B <Cloud>", "pricing_restructured", day(-3), { date_source: "discovered" }),
  change("A & B <Cloud>", "new_tier", day(-4), { date_source: "discovered" }),
  change("Unlisted Vendor", "pricing_restructured", day(-30)),
  change("Housekeeping Only", "product_deprecated", day(-1), { current_state: "Removed from index" }),
  change("Cerebras", "limits_reduced", day(-30), { resolution: { state: "retracted", date: today, detail: "An incorrect record" } }),
  change("Cerebras", "restriction", day(20), { resolution: { state: "cancelled", date: day(-1), detail: "Cerebras called off its announcement.", source_url: "https://example.com/changelog" } }),
  change("A & B <Cloud>", "product_deprecated", day(30), { resolution: { state: "cancelled", date: day(-2), detail: 'A & B <Cloud> called off "its" migration.', source_url: "https://example.com/changelog" } }),
  change("Correction Only", "record_corrected", day(-2)),
  change("Unlisted Vendor", "record_corrected", day(-2)),
];

async function readPages(name: string, changesPath?: string) {
  const child = spawn("node", [path.join(REPO, "dist/serve.js")], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...(changesPath ? { AGENTDEALS_CHANGES_PATH: changesPath } : {}) },
  });
  children.push(child);
  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30_000);
    child.stderr!.on("data", chunk => {
      const match = String(chunk).match(/running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", code => { clearTimeout(timer); reject(new Error(`Server exited with code ${code}`)); });
  });
  for (const route of routes) {
    const response = await fetch(`http://localhost:${port}${route}`, { redirect: "error" });
    assert.equal(response.status, 200);
    pages.set(`${name} ${route}`, await response.text());
  }
}

before(async () => {
  await readPages("catalogue");
  const file = path.join(scratch, "changes.json");
  writeFileSync(file, JSON.stringify({ changes: fixtures }));
  await readPages("fixtures", file);
});

after(() => {
  for (const child of children) child.kill();
  rmSync(scratch, { recursive: true, force: true });
});

describe("the change log's vendor index", () => {
  for (const name of ["catalogue", "fixtures"]) for (const route of routes) {
    it(`lists every vendor change on ${name} ${route}, before the timeline and within the reading budget`, () => {
      const census = assertChangeVendorIndex(pages.get(`${name} ${route}`)!, route);
      assert.ok(census.vendors > 0);
      if (name === "fixtures") {
        assert.equal(census.vendors, 4);
        assert.equal(census.entries, 11);
        assert.equal(census.linked, 1);
      }
    });
  }
});

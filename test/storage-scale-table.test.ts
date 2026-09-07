import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { STORAGE_SCALE_WORKLOADS, cheapestProviderAt, costliestProviderAt, monthlyStorageCost, rateCardFor, scaleCostFor } from "../dist/storage-cost-model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const COLUMNS = ["Cloudflare R2", "AWS S3", "Backblaze B2", "Google Cloud Storage"];

function startServer(): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      cwd: REPO,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost:3000" },
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Server startup timeout"));
    }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timeout);
        resolve({ proc: child, port: parseInt(m[1], 10) });
      }
    });
    child.on("error", err => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function growthTableCells(html: string): string[][] {
  const table = html.match(/<table class="growth-table">([\s\S]*?)<\/table>/);
  assert.ok(table, "the scaling table is not on the page");
  const rows = [...table[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(r => r[1]);
  return rows
    .filter(r => r.includes("<td"))
    .map(r => [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => c[1].replace(/<[^>]*>/g, "").trim()));
}

describe("the storage scaling table publishes its rate card", () => {
  let proc: ChildProcess;
  let port: number;
  let html = "";

  before(async () => {
    ({ proc, port } = await startServer());
    const response = await fetch(`http://localhost:${port}/storage-comparison-2026`);
    assert.strictEqual(response.status, 200);
    html = await response.text();
  });

  after(() => {
    proc?.kill();
  });

  it("has one row per scenario and one column per provider", () => {
    const cells = growthTableCells(html);
    assert.strictEqual(cells.length, STORAGE_SCALE_WORKLOADS.length);
    for (const row of cells) {
      assert.strictEqual(row.length, COLUMNS.length + 2, `row has ${row.length} cells: ${row.join(" | ")}`);
    }
  });

  it("prints each provider's computed cost in every scenario", () => {
    const cells = growthTableCells(html);
    STORAGE_SCALE_WORKLOADS.forEach((workload, rowIndex) => {
      const row = cells[rowIndex];
      assert.strictEqual(row[0], workload.label, `row ${rowIndex} is not ${workload.label}`);
      COLUMNS.forEach((provider, columnIndex) => {
        assert.strictEqual(
          row[columnIndex + 1],
          scaleCostFor(provider, workload),
          `${provider} at ${workload.label}`,
        );
      });
      assert.strictEqual(row[COLUMNS.length + 1], workload.selfHostedEstimate);
    });
  });

  it("no longer bills Backblaze B2 for egress inside its allowance", () => {
    const cells = growthTableCells(html);
    const b2Column = cells.map(row => row[COLUMNS.indexOf("Backblaze B2") + 1]);
    assert.deepStrictEqual(b2Column, ["$0.70", "$6.95", "$69.50", "$695"]);
    for (const overstated of ["$1.50", "$16", "$160", "$1,600"]) {
      assert.ok(
        !b2Column.includes(overstated),
        `the Backblaze column still prints ${overstated}`,
      );
    }
  });

  it("states the allowance rule and the grants it does not net out", () => {
    assert.match(html, /every column is that provider&rsquo;s published pay-as-you-go rate/);
    assert.match(html, /Backblaze B2 egress is free up to 3x average monthly storage, then \$0\.01\/GB/);
    assert.match(html, /AWS S3 gives every account the first 100 GB of internet egress free each month/);
    assert.match(html, /Fixed monthly grants are not netted out of any column/);
  });

  it("says what happens once egress passes the allowance", () => {
    assert.match(html, /3 TB free, 7 TB billed at \$0\.01\/GB, \$76\.95\/month all in/);
  });

  it("does not repeat the retired daily cap or the rounded storage rate", () => {
    const b2Rate = rateCardFor("Backblaze B2");
    assert.ok(html.includes(b2Rate.publishedStorageRate), `page omits ${b2Rate.publishedStorageRate}`);
    assert.ok(!html.includes("$0.006/GB"), "page still quotes Backblaze storage at $0.006/GB");
    assert.ok(!/B2&rsquo;s 1 GB\/day free direct egress/.test(html), "page still describes a 1 GB/day Backblaze egress cap");
    assert.ok(!html.includes("matches R2 pricing because egress goes through the Bandwidth Alliance"), "page still calls B2 R2's equal");
  });

  it("ranks B2 against R2 on the corrected numbers", () => {
    const hundredTb = STORAGE_SCALE_WORKLOADS[STORAGE_SCALE_WORKLOADS.length - 1];
    const b2 = scaleCostFor("Backblaze B2", hundredTb);
    const r2 = scaleCostFor("Cloudflare R2", hundredTb);
    assert.ok(html.includes(`<strong>Backblaze B2 at ${b2}/month</strong>`), "the verdict does not name B2 as cheapest");
    assert.ok(html.includes(`${b2}/month against R2&rsquo;s ${r2} at 100 TB`), "the drop-in verdict does not compare B2 to R2");
  });

  it("headlines the spread between the two columns it names first", () => {
    const hundredTb = STORAGE_SCALE_WORKLOADS[STORAGE_SCALE_WORKLOADS.length - 1];
    const cheapest = monthlyStorageCost(rateCardFor(cheapestProviderAt(hundredTb)), hundredTb);
    const dearest = monthlyStorageCost(rateCardFor(costliestProviderAt(hundredTb)), hundredTb);
    const spread = Math.round(dearest / cheapest);
    assert.strictEqual(spread, 20);
    assert.ok(html.includes(`The ${spread}x gap at scale`), `page does not headline a ${spread}x gap`);
    assert.ok(!html.includes("The 60x gap at scale"), "page still headlines the pre-correction 60x gap");
  });
});

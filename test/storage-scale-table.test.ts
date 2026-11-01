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

  it("states Oracle's storage and outbound grants in their own columns", () => {
    const table = html.match(/<table class="comp-table">([\s\S]*?)<\/table>/);
    assert.ok(table);
    const headers = [...table[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)]
      .map(m => m[1].replace(/<[^>]*>/g, "").trim());
    const rows = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
      .map(m => [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)]
        .map(c => c[1].replace(/<[^>]*>/g, "").trim()))
      .filter(cells => cells[0]?.startsWith("Oracle Cloud Obj. Storage"));
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0][headers.indexOf("Free Storage")], "20 GB");
    assert.strictEqual(rows[0][headers.indexOf("Free Egress")], "10 TB/mo");
  });

  it("distinguishes Oracle account types and prices only outbound above its grant", () => {
    const card = html.match(/<h3>Oracle Cloud Object Storage<\/h3>\s*<div class="diff-desc">([\s\S]*?)<\/div>/);
    assert.ok(card);
    const text = card[1].replace(/<[^>]*>/g, "").replace(/&mdash;/g, "—").replace(/\s+/g, " ").trim();
    assert.strictEqual(text, "Free tier: 20 GB object storage. 10 GB per tier on paid and trial accounts. 50,000 API requests per month. 10 TB of outbound data a month. Always Free — does not expire. S3-compatible API. Outbound data beyond 10 TB is $0.0085/GB.");
  });

  it("qualifies Wasabi's free egress and uses its current price and minimums", () => {
    const card = html.match(/<h3>Wasabi<\/h3>\s*<div class="diff-desc">([\s\S]*?)<\/div>/);
    assert.ok(card);
    const text = card[1].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    assert.strictEqual(text, 'Pricing: No free tier. $7.99 per TB per month. No egress or API fees. 90-day minimum storage duration. 1 TB minimum monthly charge. S3-compatible. "If your monthly egress data transfer is greater than your active storage volume, then your storage use case is not a good fit for Wasabi\'s free egress policy." 10 TB stored with up to 10 TB of downloads a month costs $79.90 a month.');
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
    assert.strictEqual(spread, 19);
    assert.ok(html.includes(`The ${spread}x gap at scale`), `page does not headline a ${spread}x gap`);
    assert.ok(!html.includes("The 60x gap at scale"), "page still headlines the pre-correction 60x gap");
  });
  it("prints the tiered 100 TB totals without changing the three smaller rows", () => {
    const rows = growthTableCells(html);
    assert.deepStrictEqual(rows.map(row => row.slice(1, 5)), [
      ["$1.50", "$11.30", "$0.70", "$14"],
      ["$15", "$113", "$6.95", "$140"],
      ["$150", "$1,130", "$69.50", "$1,400"],
      ["$1,500", "$10,050", "$695", "$13,100"],
    ]);
    assert.ok(html.includes("AWS S3 and Google Cloud Storage bill egress in published tiers that get cheaper per GB past 10 TB a month, which only the 100 TB row reaches."));
    assert.doesNotMatch(html, /Volume discounts and committed-use pricing are excluded throughout/);
  });

  it("gives the NAT gateway its processing charge without charging same-region S3 transfer", () => {
    const trap = html.match(/<strong>The NAT Gateway trap in detail:<\/strong>\s*([\s\S]*?)<\/div>/)?.[1].trim();
    assert.strictEqual(trap, "EC2 instances in a private subnet reading S3 through a NAT Gateway pay $0.045/GB for NAT data processing. S3 charges nothing for transfers to another AWS service in the same Region, so that is the whole charge. This appears under EC2, not S3. An S3 gateway VPC endpoint carries the same traffic at no charge.");
    const card = html.match(/<h3>AWS S3: NAT Gateway charges appear on your EC2 bill<\/h3>\s*<div class="diff-desc">([\s\S]*?)<\/div>/)?.[1];
    assert.strictEqual(card, "EC2 instances in private subnets reading S3 through a NAT Gateway pay $0.045/GB data processing, billed under EC2, so it is missing from S3 cost breakdowns. An S3 gateway VPC endpoint has no charge. At 1 TB a month that is $45, with no S3 transfer charge when the bucket is in the same Region.");
  });

  it("keeps free storage, egress and S3 support in their named provider columns", () => {
    const table = html.match(/<table class="comp-table">([\s\S]*?)<\/table>/)?.[1];
    assert.ok(table);
    const headers = [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map(m => m[1].replace(/<[^>]*>/g, "").trim());
    const row = (name: string) => {
      const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(r => [...r[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/g)].map(c => ({ text: c[2].replace(/<[^>]*>/g, "").trim(), attributes: c[1] }))).filter(r => r[0]?.text === name || r[0]?.text.startsWith(name + " "));
      assert.strictEqual(rows.length, 1, name);
      assert.strictEqual(rows[0].length, headers.length, name);
      return (column: string) => { const index = headers.indexOf(column); assert.ok(index >= 0, column); return rows[0][index]; };
    };
    const supabase = row("Supabase Storage");
    assert.strictEqual(supabase("Free Storage").text, "1 GB");
    assert.strictEqual(supabase("Free Egress").text, "5 GB/mo");
    assert.strictEqual(supabase("S3 Compatible").text, "&#10003;");
    assert.match(supabase("S3 Compatible").attributes, /class="check"/);
    assert.strictEqual(row("Vercel Blob")("Free Storage").text, "1 GB");
    assert.strictEqual(row("Vercel Blob")("Free Egress").text, "10 GB/mo");
    assert.strictEqual(row("Pinata IPFS")("Free Storage").text, "1 GB");
    assert.strictEqual(row("Google Cloud Storage")("Free Egress").text, "100 GB/mo from North America");
  });

  it("carries the corrected service terms and excludes the withdrawn hand-written claims", () => {
    const plain = html.replace(/<[^>]*>/g, "").replace(/&rsquo;/g, "'").replace(/\s+/g, " ");
    for (const sentence of [
      "1 GB file storage, 5 GB egress and 5 GB cached egress a month.",
      "S3-compatible, alongside its own Storage API.",
      "Its object lifecycle rules can delete objects, or move them to Infrequent Access, after a set number of days.",
      "Tigris also charges nothing for egress, and B2 gives free egress up to 3x what you store.",
      "waived during the trial; accounts paying with USDC are exempt.",
      "Hobby includes 1 GB of Blob storage and 10 GB of Blob data transfer a month.",
      "1 GB storage and 500 files.",
      "119 global PoPs.",
      "Bunny Storage for origin storage from $0.01/GB per region.",
      "R2 saves $81 over S3. At 50 TB/month, R2 saves about $4,300.",
      "At 50 TB/month egress, either saves about $4,300 vs S3.",
    ]) assert.ok(plain.includes(sentence), sentence);
    assert.strictEqual((html.match(/\$4,415/g) ?? []).length, 3);
    assert.strictEqual((html.match(/119 PoPs/g) ?? []).length, 2);
    assert.doesNotMatch(html, /\$0\.135\/GB|\$4,625|\$11,300|\$14,000|R2 saves \$92|\$4,500\+|on top of \$81 in egress|not S3-compatible|no built-in lifecycle rules|free cross-region replication|Hobby incl\.|114 (?:global )?PoPs/);
    const storj = html.match(/<h3>Storj <span class="caution-badge">30-DAY TRIAL<\/span>(?:(?!<\/h3>)[\s\S])*<\/h3>\s*<div class="diff-desc">([\s\S]*?)<\/div>/)?.[1];
    assert.ok(storj);
    assert.doesNotMatch(storj, /STORJ token/);
  });

});

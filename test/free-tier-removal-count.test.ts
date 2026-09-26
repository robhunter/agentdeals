import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { endsAFreeTier, deprecationEndsTheListedProduct } from "../dist/product-deprecation.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const YEAR = new Date().toISOString().slice(0, 4);
const EARLY_IN_THE_YEAR = `${YEAR}-01-01`;
const RECORDED = `${YEAR}-01-01`;

const XATA_LITE_RETIRED = {
  vendor: "Xata Lite",
  change_type: "product_deprecated",
  summary:
    "Xata retired Xata Lite, its original serverless platform with a 15 GB free plan, on 2026-02-28. It announced the retirement and closed Lite sign-ups by 2025-12-08.",
};

const AWS_THIN_CLIENT_ENDED = {
  vendor: "AWS",
  change_type: "product_deprecated",
  summary:
    "AWS WorkSpaces Thin Client end of availability. AWS stopping sales of Thin Client devices. Existing devices continue working but no new hardware can be purchased.",
};

function record(over: Record<string, unknown>) {
  return {
    vendor: "Fixture Vendor",
    change_type: "free_tier_removed",
    date: EARLY_IN_THE_YEAR,
    date_source: "vendor_page",
    recorded_date: RECORDED,
    summary: "Free plan removed.",
    previous_state: "Free plan",
    current_state: "No free plan",
    impact: "high",
    source_url: "https://example.com/pricing",
    category: "Databases",
    alternatives: [],
    ...over,
  };
}

describe("what counts as a free tier removed", () => {
  it("counts a removal, an open-source licence ending, and a deprecation of the product we list", () => {
    assert.strictEqual(endsAFreeTier(record({}) as never), true);
    assert.strictEqual(endsAFreeTier(record({ change_type: "open_source_killed" }) as never), true);
    assert.strictEqual(endsAFreeTier(XATA_LITE_RETIRED as never), true);
  });

  it("does not count a deprecation of another product the vendor sells", () => {
    assert.strictEqual(endsAFreeTier(AWS_THIN_CLIENT_ENDED as never), false);
  });

  it("does not count a narrowing that leaves the free tier standing", () => {
    for (const change_type of ["limits_reduced", "restriction", "pricing_restructured"]) {
      assert.strictEqual(endsAFreeTier(record({ change_type }) as never), false, change_type);
    }
  });

  it("drops from the count exactly the published deprecations of other products", () => {
    const published = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes;
    const removalClass = new Set(["free_tier_removed", "open_source_killed", "product_deprecated"]);
    const dropped = published.filter((c: any) => removalClass.has(c.change_type) && !endsAFreeTier(c));
    assert.ok(dropped.length > 0, "no published deprecation of another product, so the rule moves nothing");
    for (const c of dropped) {
      assert.strictEqual(c.change_type, "product_deprecated", `${c.vendor} ${c.date}`);
      assert.strictEqual(deprecationEndsTheListedProduct(c), false, `${c.vendor} ${c.date}`);
    }
  });
});

describe("the pages that count free tiers removed", () => {
  let tmp = "";
  let proc: ChildProcess | undefined;
  let port = 0;

  before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "removal-count-"));
    const changesPath = path.join(tmp, "deal_changes.json");
    writeFileSync(
      changesPath,
      JSON.stringify({
        changes: [
          record({ vendor: "Removal Fixture" }),
          record({ vendor: "Licence Fixture", change_type: "open_source_killed" }),
          record({ ...XATA_LITE_RETIRED }),
          record({ ...AWS_THIN_CLIENT_ENDED }),
          record({ vendor: "Narrowing Fixture", change_type: "limits_reduced" }),
        ],
      }),
    );
    proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost:3000", AGENTDEALS_CHANGES_PATH: changesPath },
    });
    port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      proc!.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) {
          clearTimeout(timeout);
          resolve(parseInt(m[1], 10));
        }
      });
    });
  });

  after(() => {
    proc?.kill();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  const removalsTile = (body: string) => {
    const m = body.match(/<div class="stat-value">(\d+)<\/div>\s*<div class="stat-label">Removals<\/div>/);
    assert.ok(m, "no Removals tile");
    return Number(m![1]);
  };

  it("counts three of the four removal-class records on /pricing-changes, in the tile and in the year's row", async () => {
    const body = await (await fetch(`http://localhost:${port}/pricing-changes`)).text();
    assert.strictEqual(removalsTile(body), 3);
    const m = body.match(/<span class="trend-num">(\d+)<\/span> <span class="trend-label">free tiers removed<\/span>/);
    assert.ok(m, "no free tiers removed figure for the year");
    assert.strictEqual(Number(m![1]), 3);
  });

  it("counts the same three on /changes", async () => {
    const body = await (await fetch(`http://localhost:${port}/changes`)).text();
    assert.strictEqual(removalsTile(body), 3);
  });
});

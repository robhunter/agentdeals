import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { narrowingSentence } from "../dist/vendor-verdict.js";
import { CHANGE_DIRECTION, isOurOwnBookkeeping, loadDealChanges } from "../dist/data.js";
import { changeIsUncited } from "../dist/change-citation.js";
import { vendorSlugMap } from "../dist/vendor-slug.js";
import { toSlug } from "../dist/slug.js";
import type { DealChange } from "../dist/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const ONE_CHANGE_VERDICT = "The one change we have recorded";
const DID_NOT_NARROW = `${ONE_CHANGE_VERDICT} did not narrow the terms.`;

function change(over: Partial<DealChange> = {}): DealChange {
  return {
    vendor: "Vendor A",
    date: "2026-05-03",
    date_source: "vendor_page",
    change_type: "free_tier_removed",
    summary: "The free plan was replaced by a 14-day trial.",
    impact: "high",
    source_url: "https://example.test/pricing",
    category: "Monitoring",
    ...over,
  } as DealChange;
}

const reversed = { state: "reversed" as const, date: "2026-09-08" };

describe("a vendor whose one recorded change was a narrowing later reversed", () => {
  it("names the change, its date and the day it was reversed", () => {
    assert.strictEqual(
      narrowingSentence([change({ resolution: reversed })]),
      "The one change we have recorded, a free tier removal on 2026-05-03, was reversed on 2026-09-08.",
    );
    assert.strictEqual(
      narrowingSentence([change({ change_type: "limits_reduced", resolution: reversed })]),
      "The one change we have recorded, a limit reduction on 2026-05-03, was reversed on 2026-09-08.",
    );
  });

  it("reads past our own correction of the record", () => {
    const correction = change({ change_type: "record_corrected", date: "2026-09-26", date_source: "hand_written" });
    assert.strictEqual(
      narrowingSentence([change({ resolution: reversed }), correction]),
      "The one change we have recorded, a free tier removal on 2026-05-03, was reversed on 2026-09-08.",
    );
  });

  it("keeps the withdrawn sentence for a retracted record, and the old sentence for a change that did not narrow", () => {
    assert.strictEqual(
      narrowingSentence([change({ resolution: { state: "retracted", date: "2026-09-08" } })]),
      "The one record we hold was our own error and has been withdrawn.",
    );
    assert.strictEqual(narrowingSentence([change({ change_type: "limits_increased", resolution: reversed })]), DID_NOT_NARROW);
    assert.strictEqual(narrowingSentence([change({ change_type: "limits_increased" })]), DID_NOT_NARROW);
  });

  it("leaves a vendor with more than one recorded change as it was", () => {
    assert.strictEqual(
      narrowingSentence([change({ resolution: reversed }), change({ change_type: "limits_increased", date: "2026-09-10" })]),
      "None of the 2 recorded changes narrowed the terms.",
    );
  });
});

const subjects = [...Map.groupBy(loadDealChanges() as DealChange[], (c: DealChange) => c.vendor)]
  .map(([vendor, records]) => ({ vendor, byTheVendor: records.filter((c) => !changeIsUncited(c) && !isOurOwnBookkeeping(c)) }))
  .filter(({ vendor, byTheVendor }) =>
    vendorSlugMap.has(toSlug(vendor)) &&
    byTheVendor.length === 1 &&
    CHANGE_DIRECTION[byTheVendor[0]!.change_type] === "negative" &&
    byTheVendor[0]!.resolution?.state === "reversed");

describe("the vendor pages whose one recorded change was a narrowing later reversed", () => {
  let proc: ChildProcess | null = null;
  const served = new Map<string, string>();

  before(async () => {
    if (subjects.length === 0) return;
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    proc = child;
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timeout); resolve(parseInt(m[1], 10)); }
      });
    });
    for (const { vendor } of subjects) {
      served.set(vendor, await (await fetch(`http://localhost:${port}/vendor/${toSlug(vendor)}`)).text());
    }
  });

  after(() => { proc?.kill(); });

  it("say when the narrowing was reversed, in the verdict and in the FAQ answer", (t) => {
    const stating = subjects.filter(({ vendor }) => served.get(vendor)!.includes(ONE_CHANGE_VERDICT));
    if (stating.length === 0) return t.skip("no vendor page states a one-change verdict for a reversed narrowing");
    for (const { vendor, byTheVendor } of stating) {
      const html = served.get(vendor)!;
      const record = byTheVendor[0]!;
      assert.ok(!html.includes(DID_NOT_NARROW), `/vendor/${toSlug(vendor)} still says its one change did not narrow the terms`);
      assert.ok(html.includes(`was reversed on ${record.resolution!.date}.`), `/vendor/${toSlug(vendor)} names the reversal`);
      const faq = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
        .map((m) => m[1]!)
        .filter((json) => json.includes('"FAQPage"'))
        .join(" ");
      assert.ok(faq.includes(`was reversed on ${record.resolution!.date}.`), `/vendor/${toSlug(vendor)}'s FAQ answer names the reversal`);
    }
  });
});

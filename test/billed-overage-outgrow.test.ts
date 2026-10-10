import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { statesUsageBeyondTheFreeTierIsBilled, listingStatements } = await import("../dist/overage-billing.js");
const { toSlug } = await import("../dist/vendor-slug.js");

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const offers: Array<{ vendor: string; description: string; conditions?: Array<{ text: string }> }> =
  JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;

const UPGRADE = /you(?:'|&#39;|\\u0027)ll need to upgrade/g;

const LISTINGS_THAT_BILL_USAGE_PAST_THE_FREE_TIER = [
  "Google Cloud Run", "Google Compute Engine", "Google Cloud Build", "Google Cloud BigQuery", "Google Cloud Storage",
  "Google Cloud Pub/Sub", "Google Artifact Registry", "Google Cloud Logging", "Google Secret Manager", "Google Cloud Monitoring",
  "Cloudflare R2", "Grafana Cloud", "Modal", "Parallel",
];

const LISTINGS_THAT_STOP_AT_A_HARD_LIMIT = ["Formspree", "Vercel"];

describe("reading whether a listing bills usage past its free tier", () => {
  it("reads each way a listing says the usage past its free tier is billed", () => {
    for (const sentence of [
      "Usage beyond the Free Tier's monthly limits is billed at standard rates.",
      "It includes 10k active series, with usage above that billed.",
      "Usage beyond the free tier is charged monthly to the payment method on file.",
      "Beyond the free allowance you pay $0.02 per GB.",
      "Pay-as-you-go beyond the included credit.",
      "Requests are charged at $1 per 1,000 beyond the free 5,000.",
    ]) {
      assert.ok(statesUsageBeyondTheFreeTierIsBilled([sentence]), sentence);
    }
  });

  it("does not read a billed overage into a listing that stops, pauses or blocks at its limit", () => {
    const billed = "Usage beyond the free tier is billed at standard rates.";
    for (const stops of [
      "Processing stops at the limit.",
      "When monthly free credits are used up, requests stop until credits reset.",
      "Reaching a usage limit pauses the service until the limit is changed.",
      "Once the quota is exhausted, requests are blocked.",
    ]) {
      assert.ok(!statesUsageBeyondTheFreeTierIsBilled([billed, stops]), stops);
    }
  });

  it("reads nothing billed into a listing that only states its limits", () => {
    assert.ok(!statesUsageBeyondTheFreeTierIsBilled(["Free plan: 50 submissions a month, unlimited forms."]));
  });

  it("finds every listing named in the census among the catalogue's, and neither listing that stops at a hard limit", () => {
    const billed = new Set(offers.filter((o) => statesUsageBeyondTheFreeTierIsBilled(listingStatements(o))).map((o) => o.vendor));
    for (const vendor of LISTINGS_THAT_BILL_USAGE_PAST_THE_FREE_TIER) assert.ok(billed.has(vendor), `${vendor} is not read as billing usage past its free tier`);
    for (const vendor of LISTINGS_THAT_STOP_AT_A_HARD_LIMIT) assert.ok(!billed.has(vendor), `${vendor} is read as billing usage past its free tier`);
  });
});

describe("a vendor page whose listing bills usage past the free tier", () => {
  let proc: ChildProcess | null = null;
  const pages = new Map<string, string>();
  const billedVendors = offers.filter((o) => statesUsageBeyondTheFreeTierIsBilled(listingStatements(o))).map((o) => o.vendor);

  before(async () => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    proc = child;
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timeout); resolve(parseInt(m[1], 10)); }
      });
      child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
    for (const vendor of [...new Set([...billedVendors, ...LISTINGS_THAT_STOP_AT_A_HARD_LIMIT])]) {
      const response = await fetch(`http://localhost:${port}/vendor/${toSlug(vendor)}`);
      assert.strictEqual(response.status, 200, `/vendor/${toSlug(vendor)} answered ${response.status}`);
      pages.set(vendor, await response.text());
    }
  });

  after(() => { if (proc) proc.kill(); });

  it("tells no reader they will need to upgrade, in the outgrow section, the FAQ or its structured data", () => {
    const telling = billedVendors.filter((vendor) => (pages.get(vendor)!.match(UPGRADE) ?? []).length > 0);
    assert.ok(billedVendors.length >= LISTINGS_THAT_BILL_USAGE_PAST_THE_FREE_TIER.length);
    assert.deepStrictEqual(telling, []);
  });

  it("still answers when the reader will outgrow the free tier, without opening on the list of alternatives", () => {
    for (const vendor of LISTINGS_THAT_BILL_USAGE_PAST_THE_FREE_TIER) {
      const answer = pages.get(vendor)!.match(/When will I outgrow [^<]*<\/summary>\s*<div class="faq-a">([\s\S]*?)<\/div>/)?.[1];
      assert.ok(answer, `${vendor}'s page has no outgrow question`);
      assert.ok(answer.includes("When you outgrow the free tier, evaluate paid plans against alternatives"), `${vendor}'s outgrow answer: ${answer}`);
      assert.ok(!answer.startsWith("At that point"), `${vendor}'s outgrow answer opens on the list of alternatives: ${answer}`);
    }
  });

  it("keeps the upgrade sentence on a page whose listing stops at a hard limit", () => {
    for (const vendor of LISTINGS_THAT_STOP_AT_A_HARD_LIMIT) {
      assert.ok((pages.get(vendor)!.match(UPGRADE) ?? []).length >= 2, `${vendor} no longer says the reader will need to upgrade`);
    }
  });
});

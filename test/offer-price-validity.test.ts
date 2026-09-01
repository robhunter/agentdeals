import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const TODAY = new Date().toISOString().slice(0, 10);
const dayOffset = (days: number) =>
  new Date(Date.parse(TODAY) + days * 86400000).toISOString().slice(0, 10);

interface ChangeSpec {
  vendor: string;
  date: string;
  type: string;
  source: string;
  summary?: string;
}

const FIXTURE_VENDORS = [
  "Aurorabase",
  "Beaconstack",
  "Cirruslane",
  "Datumforge",
  "Everglow",
  "Foldergrid",
  "Gustline",
  "Halcyonio",
];

const FIXTURE_CHANGES: ChangeSpec[] = [
  { vendor: "Aurorabase", date: dayOffset(21), type: "limits_reduced", source: "vendor_page" },
  { vendor: "Beaconstack", date: dayOffset(45), type: "free_tier_removed", source: "hand_written" },
  { vendor: "Beaconstack", date: dayOffset(12), type: "limits_reduced", source: "vendor_page" },
  { vendor: "Beaconstack", date: dayOffset(-30), type: "pricing_restructured", source: "vendor_page" },
  { vendor: "Cirruslane", date: dayOffset(-3), type: "limits_reduced", source: "vendor_page" },
  { vendor: "Cirruslane", date: dayOffset(-400), type: "free_tier_removed", source: "hand_written" },
  {
    vendor: "Everglow",
    date: dayOffset(18),
    type: "product_deprecated",
    source: "hand_written",
    summary: "Everglow Meshpipe end of support. The mesh routing add-on is being retired.",
  },
  {
    vendor: "Foldergrid",
    date: dayOffset(26),
    type: "product_deprecated",
    source: "hand_written",
    summary: "Foldergrid is shutting down. The whole service closes to all accounts.",
  },
  { vendor: "Gustline", date: dayOffset(9), type: "limits_reduced", source: "discovered" },
  { vendor: "Halcyonio", date: TODAY, type: "limits_reduced", source: "vendor_page" },
];

const EXPECTED_EXPIRY: Record<string, string | null> = {
  Aurorabase: dayOffset(21),
  Beaconstack: dayOffset(12),
  Cirruslane: null,
  Datumforge: null,
  Everglow: null,
  Foldergrid: dayOffset(26),
  Gustline: null,
  Halcyonio: null,
};

function offer(vendor: string) {
  return {
    vendor,
    category: "Databases",
    description: `${vendor} publishes a free allowance of 10 GB storage and 1M reads per month.`,
    tier: "Free",
    url: `https://example.com/${vendor.toLowerCase()}/pricing`,
    tags: ["database"],
    verifiedDate: dayOffset(-11),
  };
}

function change(spec: ChangeSpec) {
  return {
    vendor: spec.vendor,
    change_type: spec.type,
    date: spec.date,
    date_source: spec.source,
    summary: spec.summary ?? `${spec.vendor} changed the terms of its free allowance.`,
    previous_state: "10 GB storage",
    current_state: "2 GB storage",
    impact: "medium",
    source_url: `https://example.com/${spec.vendor.toLowerCase()}/pricing`,
    category: "Databases",
    alternatives: [],
    recorded_date: TODAY,
  };
}

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function offerJsonLd(html: string): Record<string, any> | null {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  for (const block of blocks) {
    let parsed: any;
    try {
      parsed = JSON.parse(block[1]);
    } catch {
      continue;
    }
    const offers = parsed?.mainEntity?.offers;
    if (offers && offers["@type"] === "Offer") return offers;
  }
  return null;
}

function startServer(env: Record<string, string>): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost:3000", ...env },
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
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe("a vendor page states a free tier's price expiry only when a dated change ends it", () => {
  let tmp: string;
  let proc: ChildProcess;
  const pages = new Map<string, string>();

  before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "offer-expiry-"));
    const indexPath = path.join(tmp, "index.json");
    const changesPath = path.join(tmp, "deal_changes.json");
    writeFileSync(indexPath, JSON.stringify({ offers: FIXTURE_VENDORS.map(offer) }));
    writeFileSync(changesPath, JSON.stringify({ changes: FIXTURE_CHANGES.map(change) }));
    const started = await startServer({
      AGENTDEALS_INDEX_PATH: indexPath,
      AGENTDEALS_CHANGES_PATH: changesPath,
    });
    proc = started.proc;
    for (const vendor of FIXTURE_VENDORS) {
      const res = await fetch(`http://localhost:${started.port}/vendor/${toSlug(vendor)}`);
      assert.strictEqual(res.status, 200, `/vendor/${toSlug(vendor)} did not render`);
      pages.set(vendor, await res.text());
    }
  });

  after(() => {
    if (proc) proc.kill();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("emits an Offer for every vendor, so the assertions below are about a rendered field", () => {
    for (const vendor of FIXTURE_VENDORS) {
      const offers = offerJsonLd(pages.get(vendor)!);
      assert.ok(offers, `/vendor/${toSlug(vendor)} emitted no Offer in its JSON-LD`);
      assert.strictEqual(offers!.price, "0");
    }
  });

  it("carries the date of the soonest change that ends the offer", () => {
    const dated = Object.entries(EXPECTED_EXPIRY).filter(([, date]) => date !== null);
    assert.ok(dated.length >= 2, "fewer than two vendors expect a date, so a missing field could pass this suite");
    for (const [vendor, expected] of dated) {
      const offers = offerJsonLd(pages.get(vendor)!)!;
      assert.strictEqual(
        offers.priceValidUntil,
        expected,
        `/vendor/${toSlug(vendor)} published priceValidUntil ${offers.priceValidUntil ?? "(absent)"}`
      );
    }
  });

  it("omits the field when no future change ends the offer", () => {
    for (const [vendor, expected] of Object.entries(EXPECTED_EXPIRY)) {
      if (expected !== null) continue;
      const offers = offerJsonLd(pages.get(vendor)!)!;
      assert.ok(
        !("priceValidUntil" in offers),
        `/vendor/${toSlug(vendor)} published priceValidUntil ${offers.priceValidUntil}`
      );
    }
  });

  it("prefers the first of several future changes over the last", () => {
    const beaconstack = offerJsonLd(pages.get("Beaconstack")!)!;
    assert.strictEqual(
      beaconstack.priceValidUntil,
      dayOffset(12),
      `Beaconstack has changes at ${dayOffset(12)} and ${dayOffset(45)} and published ${beaconstack.priceValidUntil}`
    );
  });

  it("does not date the offer from a deprecation of a separately named product", () => {
    const everglow = offerJsonLd(pages.get("Everglow")!)!;
    assert.ok(
      !("priceValidUntil" in everglow),
      `Everglow's free tier was dated ${everglow.priceValidUntil} by the retirement of Everglow Meshpipe`
    );
    const foldergrid = offerJsonLd(pages.get("Foldergrid")!)!;
    assert.strictEqual(
      foldergrid.priceValidUntil,
      dayOffset(26),
      "a deprecation naming the vendor itself did not date the offer"
    );
  });

  it("treats a change taking effect today as one that has already happened", () => {
    const halcyonio = offerJsonLd(pages.get("Halcyonio")!)!;
    assert.ok(
      !("priceValidUntil" in halcyonio),
      `Halcyonio's change takes effect on ${TODAY} and the offer was dated ${halcyonio.priceValidUntil}`
    );
  });

  it("does not date the offer from a change carrying a discovery date", () => {
    const gustline = offerJsonLd(pages.get("Gustline")!)!;
    assert.ok(
      !("priceValidUntil" in gustline),
      `Gustline's offer was dated ${gustline.priceValidUntil} from a change whose date records when we read the page`
    );
  });
});

describe("no vendor page publishes a price expiry that has already passed", () => {
  let proc: ChildProcess;
  let port = 0;
  let slugs: string[] = [];

  before(async () => {
    const offers = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8")).offers;
    slugs = [...new Set<string>(offers.map((o: { vendor: string }) => toSlug(o.vendor)))];
    const started = await startServer({});
    proc = started.proc;
    port = started.port;
  });

  after(() => {
    if (proc) proc.kill();
  });

  it("serves an expiry no earlier than the day the page was built, on every vendor page", async () => {
    assert.ok(slugs.length > 1000, `only ${slugs.length} vendor pages were checked`);
    const expired: string[] = [];
    let present = 0;
    let emitting = 0;
    for (const slug of slugs) {
      const html = await (await fetch(`http://localhost:${port}/vendor/${slug}`)).text();
      const offers = offerJsonLd(html);
      if (!offers) continue;
      emitting++;
      const until = offers.priceValidUntil;
      if (until === undefined) continue;
      present++;
      if (until < TODAY) expired.push(`${slug} ${until}`);
    }
    assert.ok(emitting > 1000, `only ${emitting} of ${slugs.length} vendor pages emit an Offer at all`);
    assert.deepStrictEqual(
      expired.slice(0, 10),
      [],
      `${expired.length} of ${emitting} vendor pages publish an expiry earlier than ${TODAY}, and ${present} carry the field at all`
    );
  });
});

describe("the vendor page is the only surface that dates an Offer", () => {
  it("finds priceValidUntil at one emission point in the render source", () => {
    const source = readFileSync(path.join(REPO, "src", "serve.ts"), "utf8");
    const emissions = source.match(/priceValidUntil/g) ?? [];
    assert.strictEqual(
      emissions.length,
      1,
      `priceValidUntil is written at ${emissions.length} places in serve.ts; each one needs the same bound`
    );
  });
});

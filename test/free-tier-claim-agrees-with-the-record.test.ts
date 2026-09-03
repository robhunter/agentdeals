import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { classifyTier, gateFor, notAFreeOfferGateFor, descriptionDeniesFreeTier } = await import("../dist/ranking.js");
const { toSlug } = await import("../dist/slug.js");

type Offer = import("../src/types.ts").Offer;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
const pinnedTiers: string[] = JSON.parse(readFileSync(path.join(REPO, "test", "tier-vocabulary.json"), "utf-8"));
const today = new Date().toISOString().slice(0, 10);

const denyingRecords = offers.filter(o => descriptionDeniesFreeTier(o.description));
const notFreeRecords = offers.filter(o => classifyTier(o.tier).class === "not_free");

const recordsByVendor = new Map<string, Offer[]>();
for (const offer of offers) {
  const held = recordsByVendor.get(offer.vendor);
  if (held) held.push(offer);
  else recordsByVendor.set(offer.vendor, [offer]);
}
const vendorsWithNoFreeRecord = [...recordsByVendor.entries()]
  .filter(([, records]) => records.every(r => classifyTier(r.tier).class === "not_free"))
  .map(([vendor]) => vendor)
  .sort();

const vendorsWhosePrimaryIsNotFree = [...recordsByVendor.entries()]
  .filter(([, records]) => classifyTier(records[0].tier).class === "not_free")
  .map(([vendor]) => vendor)
  .sort();

describe("a free-tier classification agrees with the record it rests on", () => {
  it("ranks no record as an ongoing free tier while its own description states there is none", () => {
    assert.ok(
      denyingRecords.length > 0,
      "no record in the catalogue states it has no free tier, so this check read an empty population",
    );
    const contradictory = denyingRecords
      .filter(o => classifyTier(o.tier).class === "free")
      .map(o => `${o.vendor} (tier "${o.tier}")`);
    assert.deepStrictEqual(
      contradictory,
      [],
      `these records rank as an ongoing free tier while their own description states there is none: ${contradictory.join(", ")}. ` +
        `Give the record a tier the vocabulary already classifies as not a free offer, or correct the description.`,
    );
  });

  it("reads a denial only where a record states it of the offer as a whole", () => {
    assert.strictEqual(descriptionDeniesFreeTier("Budget cloud VMs, no free tier."), true);
    assert.strictEqual(descriptionDeniesFreeTier("Budget line, 1 GB of storage at no cost."), false);
  });

  it("leaves a denial that a plan or a product qualifies alone", () => {
    assert.strictEqual(
      descriptionDeniesFreeTier("Free forever for open source. Private projects are trial only, no permanent free tier."),
      false,
    );
    assert.strictEqual(
      descriptionDeniesFreeTier("Self-hosted free under the BSL. Cloud free tier discontinued in November 2025."),
      false,
    );
  });

  it("still reads every tier string the vocabulary fixture pins as an ongoing free tier", () => {
    assert.ok(pinnedTiers.length > 0, "the vocabulary fixture is empty, so this check read nothing");
    const moved = pinnedTiers.filter(t => classifyTier(t).class !== "free");
    assert.deepStrictEqual(moved, [], `the fixture pins these as ongoing free tiers and they no longer classify as one: ${moved.join(", ")}`);
  });

  it("gates every record that is not a free offer out of the ranked set", () => {
    assert.ok(notFreeRecords.length > 0, "no record classifies as not a free offer, so this check read an empty population");
    const ungated = notFreeRecords.filter(o => gateFor(o, today) === null).map(o => o.vendor);
    assert.deepStrictEqual(ungated, [], `these records are not a free offer and reach the ranked set anyway: ${ungated.join(", ")}`);
  });
});

let port = 0;
let proc: ChildProcess | null = null;
const pages = new Map<string, string>();

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { port = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

async function page(pathname: string): Promise<string> {
  const cached = pages.get(pathname);
  if (cached !== undefined) return cached;
  const res = await fetch(`http://localhost:${port}${pathname}`);
  const body = await res.text();
  pages.set(pathname, body);
  return body;
}

describe("the pages of a vendor holding no free-tier record", () => {
  before(async () => {
    proc = await startServer();
    for (const vendor of vendorsWithNoFreeRecord) await page(`/vendor/${toSlug(vendor)}`);
  });

  after(() => { proc?.kill(); proc = null; });

  it("reads a population of vendors whose every record is not a free offer", () => {
    assert.ok(
      vendorsWithNoFreeRecord.length > 0,
      "no vendor holds only records that are not a free offer, so the page checks below read nothing",
    );
  });

  it("does not answer that the vendor offers a free tier", () => {
    const answering: string[] = [];
    for (const vendor of vendorsWithNoFreeRecord) {
      const html = pages.get(`/vendor/${toSlug(vendor)}`) ?? "";
      if (html.includes(`Yes, ${vendor} offers a free tier`)) answering.push(vendor);
      if (html.includes(`Our stored record says ${vendor} offers a free tier`)) answering.push(vendor);
    }
    assert.deepStrictEqual(answering, [], `these vendor pages answer that a free tier exists over records that state none: ${answering.join(", ")}`);
  });

  it("does not headline the page as a free tier", () => {
    const year = new Date().getFullYear();
    const headlined: string[] = [];
    for (const vendor of vendorsWithNoFreeRecord) {
      const html = pages.get(`/vendor/${toSlug(vendor)}`) ?? "";
      const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? "";
      if (heading.includes(`${vendor} Free Tier ${year}`)) headlined.push(vendor);
    }
    assert.deepStrictEqual(headlined, [], `these vendor pages headline a free tier over records that state none: ${headlined.join(", ")}`);
  });
});

function availabilityAnswers(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let parsed: { "@type"?: string; mainEntity?: { name?: string; acceptedAnswer?: { text?: string } }[] };
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      continue;
    }
    if (parsed["@type"] !== "FAQPage") continue;
    for (const q of parsed.mainEntity ?? []) {
      if (/free tier still available\?$/.test(q.name ?? "")) out.push(q.acceptedAnswer?.text ?? "");
    }
  }
  return out;
}

describe("the alternatives page of a vendor whose primary record is not a free offer", () => {
  before(async () => {
    if (!proc) proc = await startServer();
    for (const vendor of vendorsWhosePrimaryIsNotFree) await page(`/alternative-to/${toSlug(vendor)}`);
  });

  after(() => { proc?.kill(); proc = null; });

  it("reads a population of vendors whose primary record is not a free offer", () => {
    assert.ok(
      vendorsWhosePrimaryIsNotFree.length > 0,
      "no vendor leads with a record that is not a free offer, so the checks below read nothing",
    );
  });

  it("publishes the availability answer over that population", () => {
    const answering = vendorsWhosePrimaryIsNotFree.filter(
      v => availabilityAnswers(pages.get(`/alternative-to/${toSlug(v)}`) ?? "").length > 0,
    );
    assert.ok(answering.length > 0, "no page in the population publishes an availability answer, so the check below reads nothing");
  });

  it("does not state that a free tier exists", () => {
    const asserting: string[] = [];
    for (const vendor of vendorsWhosePrimaryIsNotFree) {
      const html = pages.get(`/alternative-to/${toSlug(vendor)}`) ?? "";
      for (const answer of availabilityAnswers(html)) {
        if (/offers a free tier|has a free tier|free tier \(/i.test(answer)) asserting.push(vendor);
      }
    }
    assert.deepStrictEqual(
      asserting,
      [],
      `these alternatives pages state a free tier exists over a primary record that is not a free offer: ${asserting.join(", ")}`,
    );
  });

  it("opens with the classification the ranking engine applies to that tier", () => {
    const disagreeing: string[] = [];
    for (const vendor of vendorsWhosePrimaryIsNotFree) {
      const reason = notAFreeOfferGateFor(recordsByVendor.get(vendor)![0])?.reason;
      if (reason === undefined) continue;
      for (const answer of availabilityAnswers(pages.get(`/alternative-to/${toSlug(vendor)}`) ?? "")) {
        if (!answer.startsWith(reason)) disagreeing.push(vendor);
      }
    }
    assert.deepStrictEqual(
      disagreeing,
      [],
      `these alternatives pages open the availability answer with something other than the gate the ranking engine applies: ${disagreeing.join(", ")}`,
    );
  });
});

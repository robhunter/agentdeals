import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

const { offerEnded, endedHeadline, recordedTierSentence } = await import("../dist/retirement.js");
const { toSlug } = await import("../dist/slug.js");

type Offer = import("../src/types.ts").Offer;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const YEAR = new Date().getFullYear();

const A_LISTING = {
  category: "Databases",
  tags: ["databases"],
  verifiedDate: "2026-09-20",
  source_check: { checked: "2026-09-20", outcome: "ok", detail: "text" },
};

const AN_ENDED_LISTING: Offer = {
  ...A_LISTING,
  vendor: "Endedcorp",
  tier: "Retired",
  description: "Hosted cache, formerly with a free plan. No free tier: plans start at $20/month.",
  url: "https://endedcorp.example/pricing",
} as Offer;

const A_PAID_LISTING: Offer = {
  ...A_LISTING,
  vendor: "Pricedcorp",
  tier: "Paid",
  description: "Hosted cache billed from the first request, from $20/month.",
  url: "https://pricedcorp.example/pricing",
} as Offer;

const A_FREE_LISTING: Offer = {
  ...A_LISTING,
  vendor: "Freecorp",
  tier: "Free",
  description: "Hosted cache with 1 GB storage and 10K requests/day.",
  url: "https://freecorp.example/pricing",
} as Offer;

const catalogue: { offers: Offer[] } = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
const offers = [...catalogue.offers, AN_ENDED_LISTING, A_PAID_LISTING, A_FREE_LISTING];
const scratch = mkdtempSync(path.join(tmpdir(), "ended-vendor-page-head-"));
const scratchIndex = path.join(scratch, "index.json");
writeFileSync(scratchIndex, JSON.stringify({ ...catalogue, offers }));

const primaries = new Map<string, Offer>();
for (const offer of offers) if (!primaries.has(offer.vendor)) primaries.set(offer.vendor, offer);
const ended = [...primaries.values()].filter(o => offerEnded(o));

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

interface Head {
  title: string;
  ogTitle: string;
  description: string;
  ogDescription: string;
  pageName: string;
  pageDescription: string;
  isItFree: string;
}

function headOf(html: string, vendor: string): Head {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(m => { try { return JSON.parse(m[1]); } catch { return null; } })
    .filter(Boolean);
  const webPage = blocks.find(b => b["@type"] === "WebPage") ?? {};
  const faq = blocks.find(b => b["@type"] === "FAQPage");
  const isItFree = faq?.mainEntity?.find((q: { name: string }) => q.name === `Is ${vendor} free?`)?.acceptedAnswer?.text ?? "";
  return {
    title: decode(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? ""),
    ogTitle: decode(html.match(/<meta property="og:title" content="([^"]*)">/)?.[1] ?? ""),
    description: decode(html.match(/<meta name="description" content="([^"]*)">/)?.[1] ?? ""),
    ogDescription: decode(html.match(/<meta property="og:description" content="([^"]*)">/)?.[1] ?? ""),
    pageName: webPage.name ?? "",
    pageDescription: webPage.description ?? "",
    isItFree,
  };
}

let proc: ChildProcess | null = null;
let port = 0;
const heads = new Map<string, Head>();

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_INDEX_PATH: scratchIndex },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { port = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", e => { clearTimeout(timeout); reject(e); });
  });
}

describe("a vendor page whose listed offer has ended says so in its title and meta description", () => {
  before(async () => {
    proc = await startServer();
    for (const offer of [...ended, A_PAID_LISTING, A_FREE_LISTING]) {
      const res = await fetch(`http://localhost:${port}/vendor/${toSlug(offer.vendor)}`);
      assert.strictEqual(res.status, 200, `/vendor/${toSlug(offer.vendor)}`);
      heads.set(offer.vendor, headOf(await res.text(), offer.vendor));
    }
  });

  after(() => {
    proc?.kill();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("reads every vendor page whose listed offer has ended", () => {
    assertPopulationFloor(ended.length, 15, "vendor pages whose listed offer has ended");
    assert.ok(ended.some(o => o.vendor === AN_ENDED_LISTING.vendor), "the ended fixture is a page's listed offer");
  });

  it("titles the page with its heading, in the title, og:title and the WebPage name", () => {
    const wrong: string[] = [];
    for (const offer of ended) {
      const head = heads.get(offer.vendor)!;
      const expected = `${endedHeadline(offer.vendor)} | AgentDeals`;
      for (const [surface, text] of [["title", head.title], ["og:title", head.ogTitle], ["WebPage name", head.pageName]]) {
        if (text !== expected) wrong.push(`/vendor/${toSlug(offer.vendor)} ${surface}: ${text}`);
      }
    }
    assert.deepStrictEqual(wrong, []);
  });

  it("opens the meta description with the opening of the page's own answer to whether it is free, and dates no verification", () => {
    const wrong: string[] = [];
    for (const offer of ended) {
      const head = heads.get(offer.vendor)!;
      const recorded = recordedTierSentence(offer.vendor, offer.tier);
      const at = head.isItFree.indexOf(recorded);
      const opening = at < 0 ? "" : head.isItFree.slice(0, at + recorded.length);
      for (const [surface, text] of [["meta", head.description], ["og:description", head.ogDescription], ["WebPage description", head.pageDescription]]) {
        if (!opening || !text.startsWith(opening) || /Verified/.test(text)) wrong.push(`/vendor/${toSlug(offer.vendor)} ${surface}: ${text}`);
      }
    }
    assert.deepStrictEqual(wrong, []);
  });

  it("leaves the title of a page whose offer is paid, or free, as it was", () => {
    assert.strictEqual(heads.get(A_PAID_LISTING.vendor)!.title, `Pricedcorp Pricing ${YEAR}: Plans, Costs & Free Alternatives | AgentDeals`);
    assert.strictEqual(heads.get(A_FREE_LISTING.vendor)!.title, `Freecorp Free Tier ${YEAR}: Limits, Pricing & What Changed | AgentDeals`);
    assert.match(heads.get(A_PAID_LISTING.vendor)!.description, /^Pricedcorp pricing details/);
  });
});

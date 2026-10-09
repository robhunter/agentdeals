import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDealChanges, loadOffers } from "../dist/data.js";
import { classifyTier, NOT_FREE_TIER_RULES } from "../dist/ranking.js";
import { endedVendorSlugs, removedListings, servedVendorSlug, toSlug, vendorSlugMap } from "../dist/vendor-slug.js";
import { parseRemovedListings, removedListingAnswer, removedListingsBySlug } from "../dist/removed-listings.js";
import { assertPopulationFloor } from "./population-floor.ts";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = "http://localhost";
const STARTUP_PERKS_SERVED_AS_FREE = ["Chargebee Launch Programme", "Sentry"];

type Offer = { vendor: string; category: string; tier: string; url: string; description?: string };

const offers = loadOffers() as Offer[];
const removed = [...removedListings.entries()].map(([slug, listing]) => ({ slug, ...listing }));
const removedSlugs = new Set(removed.map(listing => listing.slug));
const successorSlug = (listing: { successor?: string }) => listing.successor === undefined ? null : toSlug(listing.successor);

function citesAnAggregator(url: string): boolean {
  const { host, pathname } = new URL(url);
  const site = host.replace(/^www\./, "");
  return (site === "joinsecret.com" && pathname.startsWith("/offers")) || (site === "brex.com" && pathname.startsWith("/rewards"));
}

function pathNamingARemovedListing(pathname: string): boolean {
  const own = pathname.match(/^\/(?:vendor|alternative-to|go|embed\/vendor)\/([^/?#]+)/);
  if (own) return removedSlugs.has(decodeURIComponent(own[1]));
  const pair = pathname.match(/^\/(?:compare\/)?([a-z0-9-]+-vs-[a-z0-9-]+)$/);
  return pair !== null && pair[1].split("-vs-").some(part => removedSlugs.has(part));
}

let proc: ChildProcess | null = null;
let base = "";

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL, TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { base = `http://localhost:${m[1]}`; clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const get = (p: string) => fetch(`${base}${p}`, { redirect: "manual" });
const text = async (p: string) => (await get(p)).text();

async function locs(sitemap: string): Promise<string[]> {
  return [...(await text(sitemap)).matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => new URL(m[1]).pathname);
}

async function everySitemapPage(): Promise<string[]> {
  const pages: string[] = [];
  for (const sitemap of await locs("/sitemap.xml")) pages.push(...await locs(sitemap));
  return pages;
}

function internalPathsLinked(body: string): string[] {
  const paths: string[] = [];
  for (const [, href] of body.matchAll(/href=["']([^"']+)["']/g)) {
    const target = new URL(href, BASE_URL);
    if (target.origin === BASE_URL) paths.push(target.pathname);
  }
  return paths;
}

before(async () => { proc = await startServer(); });
after(() => { if (proc) proc.kill(); });

describe("#1118 the catalogue holds no reseller perk", () => {
  it("holds no record citing the joinsecret.com or brex.com/rewards pages", () => {
    assert.deepStrictEqual(offers.filter(o => citesAnAggregator(o.url)).map(o => o.vendor), []);
  });

  it("lists none of the vendors whose listings it removed, so a vendor listed again leaves the removed-listings table", () => {
    assertPopulationFloor(removed.length, 70, "removed listings");
    assert.deepStrictEqual(removed.filter(listing => vendorSlugMap.has(listing.slug)).map(listing => listing.vendor), []);
  });

  it("names a live listing that has not ended as every successor", () => {
    const withSuccessor = removed.filter(listing => listing.successor !== undefined);
    assert.ok(withSuccessor.length > 0);
    const dead = withSuccessor.filter(listing => {
      const slug = successorSlug(listing)!;
      return !vendorSlugMap.has(slug) || endedVendorSlugs.has(slug);
    });
    assert.deepStrictEqual(dead.map(listing => `${listing.vendor} -> ${listing.successor}`), []);
  });

  it("resolves a removed listing's name to its successor or to nothing, never to another listing that shares its words", () => {
    const resolved = removed
      .map(listing => ({ listing, served: servedVendorSlug(listing.slug) }))
      .filter(({ listing, served }) => served !== successorSlug(listing))
      .map(({ listing, served }) => `${listing.slug} -> ${served}`);
    assert.deepStrictEqual(resolved, []);
  });
});

describe("#1118 how the removed-listings table answers a slug", () => {
  const table = removedListingsBySlug(parseRemovedListings(JSON.stringify({ removed: [{ vendor: "Gone Co" }, { vendor: "Moved Co", successor: "Moved Co Cloud" }] }), "fixture"));
  const answer = (slug: string, live: string[], ended: string[] = []) => removedListingAnswer(slug, table, new Set(live), new Set(ended));

  it("leaves a slug it does not hold to the vendor routes", () => {
    assert.strictEqual(answer("other-co", []), null);
  });

  it("answers a removed listing with no successor with a 410 naming it", () => {
    assert.deepStrictEqual(answer("gone-co", []), { status: 410, vendor: "Gone Co" });
  });

  it("moves a removed listing to a successor that is listed and has not ended", () => {
    assert.deepStrictEqual(answer("moved-co", ["moved-co-cloud"]), { status: 301, slug: "moved-co-cloud" });
  });

  it("answers 410 where the successor is not listed or has ended", () => {
    assert.deepStrictEqual(answer("moved-co", []), { status: 410, vendor: "Moved Co" });
    assert.deepStrictEqual(answer("moved-co", ["moved-co-cloud"], ["moved-co-cloud"]), { status: 410, vendor: "Moved Co" });
  });

  it("serves a vendor listed again from its listing, whatever the table still holds", () => {
    assert.strictEqual(answer("gone-co", ["gone-co"]), null);
  });

  it("refuses an entry that names no vendor or a successor that is not a name", () => {
    assert.throws(() => parseRemovedListings(JSON.stringify({ removed: [{ successor: "X" }] }), "fixture"), /names no vendor/);
    assert.throws(() => parseRemovedListings(JSON.stringify({ removed: [{ vendor: "Y", successor: 3 }] }), "fixture"), /successor/);
  });
});

describe("#1118 a removed listing's pages answer 410, or 301 to its successor", () => {
  it("answers every removed /vendor and /alternative-to page with a 410, or a 301 to the successor's page", async () => {
    const wrong: string[] = [];
    for (const listing of removed) {
      const successor = successorSlug(listing);
      for (const route of ["/vendor", "/alternative-to"]) {
        const res = await get(`${route}/${listing.slug}`);
        const body = await res.text();
        const expected = successor === null ? 410 : 301;
        if (res.status !== expected) wrong.push(`${route}/${listing.slug} answered ${res.status}, not ${expected}`);
        else if (successor !== null && res.headers.get("location") !== `${route}/${successor}`) wrong.push(`${route}/${listing.slug} moved to ${res.headers.get("location")}`);
        else if (successor === null && !body.includes(`We no longer list <strong>${listing.vendor.replace(/&/g, "&amp;")}</strong>.`)) wrong.push(`${route}/${listing.slug} does not name the listing it removed`);
      }
    }
    assert.deepStrictEqual(wrong, []);
  });

  it("answers the slugs the rulings name: 410 for the company names programmes left and for Twilio and SendGrid, 301 for MongoDB, Intercom and Amazon AWS", async () => {
    const answers: string[] = [];
    for (const slug of ["atlassian", "google-cloud", "brex", "mercury", "ramp", "svb-silicon-valley-bank", "segment", "twilio", "sendgrid", "ibm-cloud", "mongodb", "intercom", "amazon-aws"]) {
      const res = await get(`/vendor/${slug}`);
      answers.push(`${slug} ${res.status}${res.status === 301 ? ` ${res.headers.get("location")}` : ""}`);
      await res.arrayBuffer();
    }
    assert.deepStrictEqual(answers, [
      "atlassian 410", "google-cloud 410", "brex 410", "mercury 410", "ramp 410", "svb-silicon-valley-bank 410", "segment 410", "twilio 410", "sendgrid 410", "ibm-cloud 410",
      "mongodb 301 /vendor/mongodb-atlas", "intercom 301 /vendor/the-intercom-early-stage-program", "amazon-aws 301 /vendor/aws",
    ]);
  });

  it("answers a comparison built on a removed listing with a 410", async () => {
    assert.strictEqual((await get("/cockroachdb-vs-mongodb")).status, 410);
    assert.strictEqual((await get("/mongodb-vs-cockroachdb")).status, 410);
    assert.strictEqual((await get("/compare/mongodb-vs-supabase")).status, 410);
    assert.strictEqual((await get("/compare/twilio-vs-vonage")).status, 410);
  });

  it("no longer moves a name that once matched a removed listing's words onto it", async () => {
    for (const unlisted of ["/vendor/atlassian-forge", "/vendor/google-cloud-functions"]) {
      assert.strictEqual((await get(unlisted)).status, 404, unlisted);
    }
  });

  it("moves Microsoft Founders Hub to the Microsoft for Startups listing it merged into", async () => {
    const res = await get("/vendor/microsoft-founders-hub");
    assert.strictEqual(res.status, 301);
    assert.strictEqual(res.headers.get("location"), "/vendor/microsoft-for-startups");
  });
});

describe("#1118 no surface names a removed listing", () => {
  it("lists no removed listing's page in the sitemaps and links none from any page they list", async () => {
    const pages = await everySitemapPage();
    assertPopulationFloor(pages.length, 1800, "pages the sitemaps list");
    const found: string[] = pages.filter(pathNamingARemovedListing).map(p => `sitemap: ${p}`);
    for (let i = 0; i < pages.length; i += 16) {
      await Promise.all(pages.slice(i, i + 16).map(async page => {
        const res = await get(page);
        if (res.status !== 200) { found.push(`${page} answered ${res.status}`); await res.arrayBuffer(); return; }
        for (const linked of internalPathsLinked(await res.text())) {
          if (pathNamingARemovedListing(linked)) found.push(`${page} links ${linked}`);
        }
      }));
    }
    assert.deepStrictEqual(found.sort(), []);
  });

  it("links no removed listing from llms.txt or the feeds", async () => {
    const found: string[] = [];
    for (const surface of ["/llms.txt", "/llms-full.txt", "/feed.xml", "/pricing-changes/feed.xml"]) {
      const body = await text(surface);
      for (const [url] of body.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
        const target = new URL(url);
        if (target.origin === BASE_URL && pathNamingARemovedListing(target.pathname)) found.push(`${surface}: ${target.pathname}`);
      }
    }
    assert.deepStrictEqual(found, []);
  });

  it("serves no removed listing from /api/offers or /api/startup-credits", async () => {
    const removedNames = new Set(removed.map(listing => listing.vendor));
    const served = (await (await get("/api/offers?limit=5000")).json()) as { total: number; offers: { vendor: string }[] };
    assert.strictEqual(served.offers.length, served.total);
    const programs = ((await (await get("/api/startup-credits")).json()) as { programs: { vendor: string }[] }).programs;
    assert.ok(programs.length > 0);
    assert.deepStrictEqual([...served.offers, ...programs].filter(o => removedNames.has(o.vendor)).map(o => o.vendor), []);
  });
});

describe("#1118 renamed programmes keep what their old names carried", () => {
  it("files each renamed programme in /api/startup-credits under the category its old name had", async () => {
    const programs = ((await (await get("/api/startup-credits")).json()) as { programs: { vendor: string; category: string }[] }).programs;
    const categoryOf = (vendor: string) => programs.find(p => p.vendor === vendor)?.category ?? null;
    assert.deepStrictEqual(
      ["Google for Startups Cloud Program", "Microsoft for Startups", "Brex Partner Perks", "Mercury Perks", "Ramp Partner Rewards", "SVB Startup Banking Offers", "Segment Startup Program"].map(v => `${v}: ${categoryOf(v)}`),
      ["Google for Startups Cloud Program: cloud-infrastructure", "Microsoft for Startups: cloud-infrastructure", "Brex Partner Perks: fintech-banking", "Mercury Perks: fintech-banking", "Ramp Partner Rewards: fintech-banking", "SVB Startup Banking Offers: fintech-banking", "Segment Startup Program: developer-tools"],
    );
  });

  it("marks the startup credits guide's Mercury and Ramp cards with the changes recorded under their programme names", async () => {
    const html = await text("/startup-credits");
    for (const programme of ["Mercury Perks", "Ramp Partner Rewards"]) {
      const card = html.slice(html.indexOf(`<h3>${programme} `), html.indexOf("</h3>", html.indexOf(`<h3>${programme} `)));
      assert.match(card, />CHANGED [A-Z]{3} \d{1,2}<\/a>/, programme);
    }
  });
});

describe("#1118 relabelled and renamed programmes keep the change records filed under them", () => {
  const changes = loadDealChanges() as { vendor: string; tier?: string | null; date: string; change_type: string }[];
  const FORMER_TIER_LABELS: Record<string, string[]> = {
    "Startup Program": [
      "Google for Startups Cloud Program", "Atlassian for Startups", "Microsoft for Startups", "Cloudflare for Startups", "Amazon Kiro (AWS Startups)",
      "Clever Bootstrap Program", "Scaleway Startup Program", "ScaleGrid Startup Program", "Knowlarity for Startups", "The Intercom Early Stage Program",
      "Zendesk for Startups", "Help Scout for Startups", "Autodesk Fusion 360 for Startups", "HubSpot for Startups", "Shotstack Startup Program",
      "MATLAB and Simulink for Startups", "Remote for Startups", "Bench", "Vast.ai", "Segment Startup Program", "PostHog",
    ],
    "Hatch": ["DigitalOcean"],
    "YC Deal": ["PostHog"],
    "Portfolio": ["AWS Activate"],
    "Partner Perks": ["Brex Partner Perks"],
    "Banking Perks": ["Mercury Perks"],
    "Partner Rewards": ["Ramp Partner Rewards"],
    "Banking Offers": ["SVB Startup Banking Offers"],
    "Founder Perks": ["Stripe Atlas"],
  };

  it("names a Startup Perks listing that no longer carries its former tier label for every relabelled programme", () => {
    const relabelled = Object.entries(FORMER_TIER_LABELS).flatMap(([label, vendors]) => vendors.map(vendor => ({ label, vendor })));
    assert.strictEqual(relabelled.length, 29);
    assert.deepStrictEqual(
      relabelled.filter(({ label, vendor }) => !offers.some(o => o.vendor === vendor && o.category === "Startup Perks") || offers.some(o => o.vendor === vendor && o.tier === label)).map(({ vendor, label }) => `${vendor}/${label}`),
      [],
    );
  });

  it("files no change record under a tier label its programme listing carried before it was relabelled", () => {
    assert.deepStrictEqual(
      changes.filter(c => (FORMER_TIER_LABELS[c.tier ?? ""] ?? []).includes(c.vendor)).map(c => `${c.vendor} ${c.date} ${c.change_type} (${c.tier})`),
      [],
    );
  });

  it("keeps no change record under a company name a renamed programme left, apart from Atlassian's record about its own Data Center pricing", () => {
    const left = ["Brex", "Mercury", "Ramp", "SVB (Silicon Valley Bank)", "Google Cloud", "Segment", "Microsoft Founders Hub"];
    assert.deepStrictEqual(changes.filter(c => left.includes(c.vendor)).map(c => `${c.vendor} ${c.date} ${c.change_type}`), []);
    assert.deepStrictEqual(changes.filter(c => c.vendor === "Atlassian").map(c => `${c.date} ${c.change_type}`), ["2026-02-17 pricing_restructured"]);
  });
});

describe("#1118 a startup programme is served as an ongoing free tier only where the guard names it", () => {
  const perks = offers.filter(o => o.category === "Startup Perks");

  it("classes as free only the Startup Perks listings this guard names", () => {
    assert.ok(perks.length > 0);
    assert.deepStrictEqual([...new Set(perks.filter(o => classifyTier(o.tier).class === "free").map(o => o.vendor))].sort(), STARTUP_PERKS_SERVED_AS_FREE);
  });

  it("classes a startup discount as not free, in the words the criteria page prints", () => {
    assert.deepStrictEqual(classifyTier("Startup Discount"), { class: "not_free", note: "a discount on a paid plan for qualifying startups, not a free tier" });
    assert.ok(NOT_FREE_TIER_RULES.some(rule => rule.pattern.test("Startup Discount")));
  });

  it("classes no listing whose description names an access gate as an ongoing free tier", () => {
    const gated = offers.filter(o => /Access via:/.test(o.description ?? ""));
    assert.ok(gated.length > 0);
    assert.deepStrictEqual(gated.filter(o => classifyTier(o.tier).class === "free").map(o => o.vendor), []);
  });

  it("answers 'Is X free?' with something other than yes for every vendor whose only listings are startup programmes it does not class as free", async () => {
    const yes: string[] = [];
    const hasAFreeListing = new Set(offers.filter(o => classifyTier(o.tier).class === "free").map(o => o.vendor));
    const listings = perks.filter(o => !hasAFreeListing.has(o.vendor));
    assert.ok(listings.length > 0);
    for (const o of listings) {
      const html = await text(`/vendor/${toSlug(o.vendor)}`);
      for (const [, json] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
        const data = JSON.parse(json) as { "@type"?: string; mainEntity?: { name: string; acceptedAnswer: { text: string } }[] };
        if (data["@type"] !== "FAQPage") continue;
        for (const q of data.mainEntity ?? []) {
          if (/^Is .+ free\?$/.test(q.name) && /^Yes\b/.test(q.acceptedAnswer.text)) yes.push(`${o.vendor}: ${q.acceptedAnswer.text.slice(0, 80)}`);
        }
      }
    }
    assert.deepStrictEqual(yes, []);
  });
});

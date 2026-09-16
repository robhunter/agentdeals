import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

const { toSlug } = await import("../dist/slug.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

interface PublishedOffer {
  vendor: string;
  tier: string;
  category: string;
  gate: unknown;
  terms_superseded: unknown;
  risk_level: string | null;
  risk_cause: unknown;
}

interface Node {
  route: string;
  vendor: string;
  description: string;
  pricedAtZero: boolean;
  tier: string | null;
}

function startServer(): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ proc: child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

function softwareNodes(route: string, html: string): Node[] {
  const found: Node[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const record = node as Record<string, any>;
    if (record["@type"] === "SoftwareApplication" && typeof record.name === "string") {
      found.push({
        route,
        vendor: record.name,
        description: typeof record.description === "string" ? record.description : "",
        pricedAtZero: record.offers?.price === "0",
        tier: typeof record.offers?.description === "string" ? record.offers.description : null,
      });
    }
    Object.values(record).forEach(visit);
  };
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { visit(JSON.parse(match[1])); } catch { continue; }
  }
  return found;
}

const WITHHOLDS_OUR_TERMS = /We are not publishing our stored .+ terms beside it/;

const LISTING_PAGES = [
  "/best/free-testing", "/best/free-monitoring", "/best/free-ai-ml", "/best/free-search",
  "/best/free-logging", "/best/free-databases", "/best/free-cloud-hosting",
  "/free-saas-stack", "/free-ai-stack", "/agent-payments", "/x402-services",
  "/ai-free-tiers", "/redis-alternatives", "/auth0-alternatives", "/vercel-alternatives",
];

describe("#1724 structured data prices a tier at zero only where we state that tier is free", () => {
  let server: { proc: ChildProcess; port: number } | null = null;
  let base = "";
  let published: PublishedOffer[] = [];
  const nodes: Node[] = [];
  let sampledVendors: string[] = [];

  const tiersWeHold = new Map<string, Set<string>>();
  const routesOf = (kind: string) => nodes.filter(n => n.route.startsWith(kind));
  const offersWhere = (holds: (o: PublishedOffer) => boolean) =>
    new Set(published.filter(holds).map(o => `${o.vendor}|${o.tier}`));
  const nodesNaming = (chosen: Set<string>) =>
    nodes.filter(n => [...(tiersWeHold.get(n.vendor) ?? [])].some(tier => chosen.has(`${n.vendor}|${tier}`)));
  const pricedAmong = (chosen: Set<string>) =>
    nodes.filter(n => n.pricedAtZero && chosen.has(`${n.vendor}|${n.tier}`))
      .map(n => `${n.route} ${n.vendor} ${n.tier}`);
  const soleOffer = () => new Set(
    [...tiersWeHold].filter(([vendor, tiers]) =>
      tiers.size === 1 && published.filter(o => o.vendor === vendor).length === 1).map(([vendor]) => vendor));

  before(async () => {
    server = await startServer();
    base = `http://localhost:${server.port}`;
    published = (await (await fetch(`${base}/api/offers?limit=2000`)).json()).offers;
    for (const row of published) {
      const held = tiersWeHold.get(row.vendor);
      if (held) held.add(row.tier);
      else tiersWeHold.set(row.vendor, new Set([row.tier]));
    }

    const categories = [...new Set(published.map(o => `/category/${toSlug(o.category)}`))];
    const withheldOrEnded = published
      .filter(o => o.terms_superseded || o.gate || (o.risk_level === "risky" && o.risk_cause))
      .map(o => o.vendor);
    const everyTwelfth = published.map(o => o.vendor).filter((_, i) => i % 12 === 0);
    sampledVendors = [...new Set([...withheldOrEnded, ...everyTwelfth])].sort();

    const comparisons = [...(await (await fetch(`${base}/sitemap-comparisons.xml`)).text())
      .matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map(m => new URL(m[1]).pathname)
      .filter(p => p.startsWith("/compare/"));

    const queue = [
      ...categories,
      ...LISTING_PAGES,
      ...comparisons,
      ...[...new Set(withheldOrEnded)].slice(0, 120).map(v => `/alternative-to/${toSlug(v)}`),
      ...sampledVendors.map(v => `/vendor/${toSlug(v)}`),
    ];
    let next = 0;
    await Promise.all(Array.from({ length: 12 }, async () => {
      while (next < queue.length) {
        const route = queue[next++];
        const response = await fetch(base + route);
        if (response.ok) nodes.push(...softwareNodes(route, await response.text()));
      }
    }));
  });

  after(() => { server?.proc.kill(); });

  it("reads enough nodes on each surface for the sweeps below to mean something", () => {
    assertPopulationFloor(nodes.length, 1700, "structured-data nodes read across the surfaces");
    assertPopulationFloor(routesOf("/category/").length, 900, "nodes read on category pages");
    assertPopulationFloor(routesOf("/vendor/").length, 300, "nodes read on vendor pages");
    assertPopulationFloor(routesOf("/alternative-to/").length, 250, "nodes read on alternatives pages");
    assertPopulationFloor(nodes.filter(n => n.pricedAtZero).length, 550, "nodes priced at zero");
  });

  it("publishes no price of zero beside a description withholding the terms it prices", () => {
    const withholding = nodes.filter(n => WITHHOLDS_OUR_TERMS.test(n.description));
    assertPopulationFloor(withholding.length, 300, "nodes withhold our stored terms");
    assertPopulationFloor(
      new Set(withholding.map(n => n.route.replace(/\/[^/]*$/, "/"))).size,
      3,
      "surfaces carry a withholding node",
    );
    assert.deepStrictEqual(
      withholding.filter(n => n.pricedAtZero).map(n => `${n.route} ${n.vendor}`).slice(0, 25),
      [],
    );
  });

  it("publishes no price of zero for an offer we rate risky over a change that ended it", () => {
    const ended = offersWhere(o => o.risk_level === "risky" && Boolean(o.risk_cause));
    assertPopulationFloor(ended.size, 15, "offers are rated risky over a change that ended them");
    assertPopulationFloor(nodesNaming(ended).length, 20, "nodes name one of those offers");
    assert.deepStrictEqual(pricedAmong(ended).slice(0, 25), []);
  });

  it("publishes no price of zero for an offer the ranking gate holds back", () => {
    const gated = offersWhere(o => Boolean(o.gate));
    assertPopulationFloor(gated.size, 100, "offers are held back by a ranking gate");
    assertPopulationFloor(nodesNaming(gated).length, 100, "nodes name a gated offer");
    assert.deepStrictEqual(pricedAmong(gated).slice(0, 25), []);
  });

  it("gives a listing and a vendor page the same answer about the same offer", () => {
    const single = soleOffer();
    const onVendorPage = new Map(routesOf("/vendor/").filter(n => single.has(n.vendor)).map(n => [n.vendor, n.pricedAtZero]));
    const disagreeing: string[] = [];
    let compared = 0;
    for (const node of nodes) {
      if (node.route.startsWith("/vendor/") || node.route.startsWith("/compare/") || !single.has(node.vendor)) continue;
      const vendorPage = onVendorPage.get(node.vendor);
      if (vendorPage === undefined) continue;
      compared++;
      if (vendorPage !== node.pricedAtZero) disagreeing.push(`${node.route} ${node.vendor}`);
    }
    assertPopulationFloor(compared, 350, "listing nodes have a vendor page to be read against");
    assert.deepStrictEqual(disagreeing.slice(0, 25), []);
  });

  it("names a tier we hold a record for wherever it prices one at zero", () => {
    const priced = nodes.filter(n => n.pricedAtZero);
    const misnamed = priced.filter(n => {
      const held = tiersWeHold.get(n.vendor);
      return held !== undefined && (n.tier === null || !held.has(n.tier));
    });
    assertPopulationFloor(priced.length, 550, "nodes carry a priced tier to check");
    assert.deepStrictEqual(misnamed.map(n => `${n.route} ${n.vendor} ${n.tier}`).slice(0, 25), []);
  });

  it("prices on a comparison page only what a vendor page prices, and less of it", () => {
    const single = soleOffer();
    const onVendorPage = new Map(routesOf("/vendor/").filter(n => single.has(n.vendor)).map(n => [n.vendor, n.pricedAtZero]));
    const compared = routesOf("/compare/").filter(n => onVendorPage.has(n.vendor));
    assertPopulationFloor(compared.length, 150, "comparison nodes have a vendor page to be read against");
    const pricedOnlyHere = compared.filter(n => n.pricedAtZero && !onVendorPage.get(n.vendor));
    assert.deepStrictEqual(pricedOnlyHere.map(n => `${n.route} ${n.vendor}`).slice(0, 25), []);
    const heldBackHere = compared.filter(n => !n.pricedAtZero && onVendorPage.get(n.vendor)).length;
    assertPopulationFloor(heldBackHere, 18, "comparison nodes withhold a price the vendor page publishes");
  });

  it("still prices the tiers we do state are free", () => {
    const vercel = nodes.filter(n => n.vendor === "Vercel" && n.pricedAtZero);
    assertPopulationFloor(vercel.length, 2, "surfaces price Vercel's tier at zero");
    assert.ok(vercel.some(n => n.route.startsWith("/vendor/")), "the vendor page prices it");
    assert.ok(vercel.some(n => n.route.startsWith("/category/")), "a category page prices it");
    assert.deepStrictEqual([...new Set(vercel.map(n => n.tier))], ["Hobby"]);
  });
});

describe("a reading held for the day it was served is not served on another day", () => {
  it("holds every day-scoped cache in the render source to the day it stored", () => {
    const source = readFileSync(path.join(REPO, "src", "serve.ts"), "utf8");
    const caches = source.match(/new Map<string, \{ on: string;[^\n]*\}>\(\)/g) ?? [];
    const guards = source.match(/if \(cached && cached\.on === \w+\)/g) ?? [];
    assertPopulationFloor(caches.length, 2, "caches in the render source key a reading to a day");
    assert.strictEqual(
      guards.length,
      caches.length,
      `${caches.length} caches hold a reading against a day and ${guards.length} check it before serving one`,
    );
  });
});

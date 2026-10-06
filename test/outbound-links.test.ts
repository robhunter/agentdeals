import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { everyRouteTheSitemapPublishes } from "./sitemap-routes.ts";
import { assertPopulationFloor } from "./population-floor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { vendorSlugMap } = await import("../dist/vendor-slug.js");
const { loadOffers } = await import("../dist/data.js");

const WORD_LABELS = ["Pricing &nearr;", "Pricing page &nearr;", "Pricing →", "Visit &rarr;"];
const A_LINK = /<a\s([^>]*)>([\s\S]*?)<\/a>/g;

function attribute(attributes: string, name: string): string | null {
  const found = attributes.match(new RegExp(`\\b${name}="([^"]*)"`));
  return found ? found[1]!.replace(/&amp;/g, "&") : null;
}

function hostAndPath(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname === "/" ? parsed.host : `${parsed.host}${parsed.pathname}`;
}

function escaped(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function firstListingUrl(slug: string): string {
  const name = vendorSlugMap.get(slug);
  return loadOffers().find((o: { vendor: string }) => o.vendor === name).url;
}

function startAgentDeals(): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(__dirname, "..", "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: "0",
        BASE_URL: "http://localhost",
        TZ: "UTC",
        UPSTASH_REDIS_REST_URL: "",
        UPSTASH_REDIS_REST_TOKEN: "",
        AGENTDEALS_ROLLUP_DIR: path.join(os.tmpdir(), `outbound-links-rollups-${process.pid}`),
      },
    });
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("Server startup timeout")); }, 30000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timeout); resolve({ proc, base: `http://localhost:${match[1]}` }); }
    });
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

interface FoundLink {
  route: string;
  href: string;
  text: string;
  className: string | null;
  rel: string | null;
}

describe("links through /go/ on every published page", () => {
  let server: { proc: ChildProcess; base: string };
  const links: FoundLink[] = [];
  const pages = new Map<string, string>();

  before(async () => {
    server = await startAgentDeals();
    const routes = await everyRouteTheSitemapPublishes(server.base);
    for (let i = 0; i < routes.length; i += 8) {
      await Promise.all(routes.slice(i, i + 8).map(async (route) => {
        const html = await (await fetch(`${server.base}${route}`)).text();
        pages.set(route, html);
        for (const [, attributes, text] of html.matchAll(A_LINK)) {
          const href = attribute(attributes!, "href");
          if (href !== null) links.push({ route, href, text: text!.trim(), className: attribute(attributes!, "class"), rel: attribute(attributes!, "rel") });
        }
      }));
    }
  });

  after(async () => {
    if (server && server.proc.exitCode === null) {
      const exited = once(server.proc, "exit");
      server.proc.kill("SIGTERM");
      await exited;
    }
  });

  it("reads enough pages for the sweep to mean something", () => {
    assertPopulationFloor(pages.size, 1000, "pages read");
    assertPopulationFloor(links.filter(l => l.href.startsWith("/go/")).length, 1000, "links through /go/");
  });

  it("shows the address a /go/ link leads to as its visible text", async () => {
    const destinations = new Map<string, string>();
    const wrong: string[] = [];
    for (const link of links.filter(l => l.href.startsWith("/go/"))) {
      let destination = destinations.get(link.href);
      if (destination === undefined) {
        const res = await fetch(`${server.base}${link.href}`, { method: "HEAD", redirect: "manual" });
        destination = res.status === 302 ? res.headers.get("location") ?? "" : "";
        destinations.set(link.href, destination);
      }
      const shown = [escaped(destination), `${escaped(hostAndPath(destination))} &nearr;`];
      if (!destination || !shown.includes(link.text)) wrong.push(`${link.route}: ${link.href} shows "${link.text}"`);
    }
    assert.deepStrictEqual(wrong.slice(0, 20), []);
  });

  it("marks every /go/ link nofollow noopener", () => {
    const wrong = links
      .filter(l => l.href.startsWith("/go/") && l.rel !== "nofollow noopener")
      .map(l => `${l.route}: ${l.href} rel="${l.rel}"`);
    assert.deepStrictEqual(wrong.slice(0, 20), []);
  });

  it("links the vendor page's Pricing Page card through /go/ with the vendor's URL as its text", () => {
    const wrong: string[] = [];
    let cards = 0;
    for (const slug of vendorSlugMap.keys()) {
      const html = pages.get(`/vendor/${slug}`);
      if (html === undefined) continue;
      const card = html.match(/<div class="detail-label">Pricing Page<\/div>\s*<div class="detail-value"><a ([^>]*)>([^<]*)<\/a>/);
      if (!card) continue;
      cards++;
      const href = attribute(card[1]!, "href");
      if (href !== `/go/${slug}` || card[2] !== escaped(firstListingUrl(slug))) wrong.push(`${slug}: ${href} "${card[2]}"`);
    }
    assertPopulationFloor(cards, 1000, "vendor pages with a Pricing Page card");
    assert.deepStrictEqual(wrong.slice(0, 20), []);
  });

  it("keeps no word-labelled pricing link pointing at an address /go/ serves", () => {
    const served = new Set([...vendorSlugMap.keys()].map(firstListingUrl));
    const wrong = links
      .filter(l => WORD_LABELS.includes(l.text) && served.has(l.href))
      .map(l => `${l.route}: ${l.href}`);
    assert.deepStrictEqual(wrong.slice(0, 20), []);
  });

  it("keeps a direct word-labelled link for a vendor's listing other than its first", () => {
    const secondListing = loadOffers().filter((o: { vendor: string }) => o.vendor === "Sentry")[1];
    assert.ok(secondListing, "Sentry holds a second listing");
    const direct = links.filter(l => l.href === secondListing.url && WORD_LABELS.includes(l.text));
    const throughGo = links.filter(l => l.href.startsWith("/go/") && l.text.includes(escaped(hostAndPath(secondListing.url))));
    assert.ok(direct.length > 0, `a direct link to ${secondListing.url}`);
    assert.deepStrictEqual(throughGo.map(l => l.route), []);
  });

  it("leaves no /go/ address in an API or MCP answer", async () => {
    for (const route of ["/api/offers?q=supabase", "/api/offers?category=Databases&limit=100", "/api/vendor/supabase", "/api/details/railway", "/api/compare?a=neon&b=supabase", "/api/stack?use_case=Next.js+SaaS+app"]) {
      const body = await (await fetch(`${server.base}${route}`)).text();
      assert.doesNotMatch(body, /\/go\//, route);
    }
    const init = await fetch(`${server.base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "outbound-links-test", version: "1.0.0" } } }),
    });
    const session = init.headers.get("mcp-session-id");
    assert.ok(session);
    await init.text();
    for (const [name, args] of [["search_deals", { query: "supabase", limit: 5 }], ["compare_vendors", { vendors: ["Neon", "Supabase"] }]] as const) {
      const call = await fetch(`${server.base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": session! },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
      });
      const text = await call.text();
      assert.match(text, /supabase\.com/, name);
      assert.doesNotMatch(text, /\/go\//, name);
    }
  });
});

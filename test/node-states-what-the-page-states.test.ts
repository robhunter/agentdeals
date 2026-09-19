import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

const { UNVERIFIED_TERMS_CAVEAT } = await import("../dist/vendor-verdict.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const EVERY_NTH_VENDOR_PAGE = 3;
const COMPARISON_PAGES_READ = 120;

function startServer(): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 120000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ proc: child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

function unescapeServed(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&mdash;/g, "—").replace(/&darr;/g, "↓").replace(/&rarr;/g, "→")
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function textOf(html: string): string {
  return unescapeServed(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

interface ServedNode {
  vendor: string;
  description: string;
  offerTier: string | null;
  offerDescription: string | null;
  pricedAtZero: boolean;
}

function softwareNodes(html: string): ServedNode[] {
  const found: ServedNode[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const record = node as Record<string, any>;
    if (record["@type"] === "SoftwareApplication" && typeof record.description === "string") {
      found.push({
        vendor: String(record.name ?? ""),
        description: record.description,
        offerTier: typeof record.offers?.name === "string" ? record.offers.name : null,
        offerDescription: typeof record.offers?.description === "string" ? record.offers.description : null,
        pricedAtZero: record.offers?.price === "0",
      });
    }
    Object.values(record).forEach(visit);
  };
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { visit(JSON.parse(match[1])); } catch { continue; }
  }
  return found;
}

interface TermsBlock {
  withheld: boolean;
  text: string;
}

function vendorTermsBlock(html: string): TermsBlock | null {
  const match = html.match(/<h2>Free Tier Details<\/h2>\s*<p class="(desc-text|terms-superseded-text)"[^>]*>([\s\S]*?)<\/p>/);
  if (!match) return null;
  return { withheld: match[1] === "terms-superseded-text", text: textOf(match[2]) };
}

function comparisonTermsBlocks(html: string): TermsBlock[] {
  return [...html.matchAll(/<div class="desc-block( terms-superseded-text)?">([\s\S]*?)<\/div>/g)]
    .map(([, withheld, body]) => ({ withheld: Boolean(withheld), text: textOf(body) }));
}

function faqAnswer(html: string, vendor: string): string | null {
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let parsed: any;
    try { parsed = JSON.parse(match[1]); } catch { continue; }
    const questions = parsed?.mainEntity;
    if (!Array.isArray(questions)) continue;
    const asked = questions.find((q: any) => q?.name === `Is ${vendor} free?`);
    if (asked) return String(asked.acceptedAnswer?.text ?? "");
  }
  return null;
}

function squashed(terms: string): string {
  return terms.replace(/[\s.]+/g, "").toLowerCase();
}

function closed(terms: string): string {
  return /[.!?…]$/.test(terms.trim()) ? terms.trim() : `${terms.trim()}.`;
}

function reasonTheNodeAdds(node: ServedNode, stored: string): string | null {
  const opening = closed(stored);
  const description = node.description.trim();
  if (description === opening || description === stored.trim()) return "";
  return description.startsWith(`${opening} `) ? description.slice(opening.length + 1) : null;
}

interface VendorPage {
  route: string;
  node: ServedNode;
  terms: TermsBlock;
  answer: string;
  reason: string | null;
}

describe("a vendor page's structured data states the reason its own prose states", () => {
  let server: { proc: ChildProcess; port: number } | null = null;
  let pages: VendorPage[] = [];
  let withheldPages: { route: string; node: ServedNode }[] = [];
  let unreadable: string[] = [];

  before(async () => {
    server = await startServer();
    const base = `http://localhost:${server.port}`;
    const sitemap = await (await fetch(`${base}/sitemap-vendors.xml`)).text();
    const routes = [...sitemap.matchAll(/<loc>([^<]*\/vendor\/[^<]*)<\/loc>/g)]
      .map(([, url]) => new URL(url).pathname)
      .filter((_, i) => i % EVERY_NTH_VENDOR_PAGE === 0);

    let next = 0;
    await Promise.all(Array.from({ length: 12 }, async () => {
      while (next < routes.length) {
        const route = routes[next++];
        const response = await fetch(base + route);
        if (!response.ok) continue;
        const html = await response.text();
        const node = softwareNodes(html)[0];
        const terms = vendorTermsBlock(html);
        if (!node || !terms) { unreadable.push(route); continue; }
        if (terms.withheld) { withheldPages.push({ route, node }); continue; }
        const answer = faqAnswer(html, node.vendor);
        if (answer === null) { unreadable.push(route); continue; }
        pages.push({ route, node, terms, answer, reason: reasonTheNodeAdds(node, terms.text) });
      }
    }));
  });

  after(() => { server?.proc.kill(); });

  it("reads enough pages for the sweeps below to mean something", () => {
    assertPopulationFloor(pages.length, 300, "vendor pages read with a node, a terms block and an answer");
    assertPopulationFloor(withheldPages.length, 15, "vendor pages withhold our stored terms entirely");
    assert.deepStrictEqual(unreadable.slice(0, 15), [], "vendor pages served no node, no terms block or no free-tier answer");
  });

  it("builds every node description out of the terms the page displays", () => {
    assert.deepStrictEqual(
      pages.filter(p => p.reason === null).map(p => `${p.route}: ${p.node.description.slice(0, 90)}`).slice(0, 15),
      [],
    );
  });

  it("states a reason in the node wherever the page's own answer states one", () => {
    const answered = pages.filter(p => p.answer.includes(UNVERIFIED_TERMS_CAVEAT));
    assertPopulationFloor(answered.length, 190, "pages answer the free-tier question with the unverified caveat");
    assert.deepStrictEqual(
      answered.filter(p => p.reason === "").map(p => p.route).slice(0, 15),
      [],
    );
  });

  it("states no reason in the node the page's own answer does not state", () => {
    const hedged = pages.filter(p => p.reason !== null && p.reason !== "");
    assertPopulationFloor(hedged.length, 200, "node descriptions state a reason we cannot confirm the terms");
    assert.deepStrictEqual(
      hedged.filter(p => !p.answer.includes(UNVERIFIED_TERMS_CAVEAT) && !p.answer.includes(p.reason!))
        .map(p => `${p.route}: ${p.reason!.slice(0, 80)}`).slice(0, 15),
      [],
    );
  });

  it("prices nothing on a page that withholds our stored terms", () => {
    assert.deepStrictEqual(
      withheldPages.filter(p => p.pricedAtZero || p.node.offerDescription !== null)
        .map(p => p.route).slice(0, 15),
      [],
    );
  });

  it("gives the Offer the tier it names and the reason the node states, and nothing else", () => {
    const priced = pages.filter(p => p.node.pricedAtZero && p.node.offerTier !== null);
    assertPopulationFloor(priced.length, 200, "vendor pages price a tier at zero");
    assertPopulationFloor(priced.filter(p => p.reason !== "").length, 150, "priced vendor pages state a reason");
    assert.deepStrictEqual(
      priced.filter(p => p.node.offerDescription !== (p.reason === "" ? p.node.offerTier : `${p.node.offerTier} — ${p.reason}`))
        .map(p => `${p.route}: ${p.node.offerDescription}`).slice(0, 15),
      [],
    );
  });
});

describe("a comparison page's structured data states the reason its own prose states", () => {
  let server: { proc: ChildProcess; port: number } | null = null;
  const columns: { route: string; node: ServedNode; terms: TermsBlock }[] = [];
  const mismatched: string[] = [];

  before(async () => {
    server = await startServer();
    const base = `http://localhost:${server.port}`;
    const sitemap = await (await fetch(`${base}/sitemap-comparisons.xml`)).text();
    const routes = [...sitemap.matchAll(/<loc>([^<]*\/compare\/[^<]+)<\/loc>/g)]
      .map(([, url]) => new URL(url).pathname)
      .filter(route => route !== "/compare")
      .slice(0, COMPARISON_PAGES_READ);

    let next = 0;
    await Promise.all(Array.from({ length: 12 }, async () => {
      while (next < routes.length) {
        const route = routes[next++];
        const response = await fetch(base + route);
        if (!response.ok) continue;
        const html = await response.text();
        const nodes = softwareNodes(html);
        const blocks = comparisonTermsBlocks(html);
        if (nodes.length !== blocks.length) { mismatched.push(route); continue; }
        for (let i = 0; i < nodes.length; i++) columns.push({ route, node: nodes[i], terms: blocks[i] });
      }
    }));
  });

  after(() => { server?.proc.kill(); });

  it("reads both columns of enough comparisons for the sweeps below to mean something", () => {
    assertPopulationFloor(columns.length, 150, "comparison columns read with a node and a terms block");
    assert.deepStrictEqual(mismatched.slice(0, 10), [], "comparison pages served a different number of nodes and terms blocks");
  });

  it("displays beside each column exactly what that column's node states", () => {
    const standing = columns.filter(c => !c.terms.withheld);
    assertPopulationFloor(standing.length, 120, "comparison columns publish our stored terms");
    assertPopulationFloor(
      standing.filter(c => c.terms.text.includes("so we cannot confirm these terms today")).length,
      20,
      "comparison columns display a reason we cannot confirm the terms",
    );
    assert.deepStrictEqual(
      standing.filter(c => squashed(c.node.description) !== squashed(c.terms.text))
        .map(c => `${c.route} ${c.node.vendor}`).slice(0, 15),
      [],
    );
  });
});

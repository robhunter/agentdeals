import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(__dirname, "..", "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1" },
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("startup timeout")); }, 180000);
    child.stderr.on("data", (b) => {
      const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timer); resolve({ proc: child, base: `http://127.0.0.1:${m[1]}` }); }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

function jsonLdBlocks(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(([, body]) => { try { return JSON.parse(body); } catch { return null; } })
    .filter(v => v !== null);
}

function softwareNodes(node, found = []) {
  if (Array.isArray(node)) { for (const item of node) softwareNodes(item, found); return found; }
  if (!node || typeof node !== "object") return found;
  if (node["@type"] === "SoftwareApplication") found.push(node);
  for (const value of Object.values(node)) softwareNodes(value, found);
  return found;
}

const WITHHOLDS = /We are not publishing our stored .* terms beside it/;

const { proc, base } = await startServer();

async function routesFromSitemaps() {
  const index = await (await fetch(`${base}/sitemap.xml`)).text();
  const children = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  const urls = new Set();
  for (const child of children) {
    if (!child.endsWith(".xml")) { urls.add(child); continue; }
    const body = await (await fetch(child.replace(/^https?:\/\/[^/]+/, base))).text();
    for (const m of body.matchAll(/<loc>([^<]+)<\/loc>/g)) urls.add(m[1]);
  }
  return [...urls].map(u => u.replace(/^https?:\/\/[^/]+/, ""));
}

function pageKind(route) {
  if (route.startsWith("/vendor/")) return "/vendor/*";
  if (route.startsWith("/compare/")) return "/compare/*";
  if (route.startsWith("/category/")) return "/category/*";
  if (route.startsWith("/alternative-to/")) return "/alternative-to/*";
  if (route === "/") return "/";
  return route;
}

try {
  const routes = await routesFromSitemaps();
  console.error(`fetching ${routes.length} routes`);

  const byKind = new Map();
  let nodesTotal = 0, offersTotal = 0, offerBesideWithholding = 0;
  let hedgedOffers = 0, offerSayingMoreThanItsNode = 0;
  const witnesses = [];

  for (const route of routes) {
    let html;
    try { html = await (await fetch(base + route)).text(); } catch { continue; }
    const nodes = softwareNodes(jsonLdBlocks(html));
    if (nodes.length === 0) continue;
    const kind = pageKind(route);
    const held = byKind.get(kind) ?? { pages: 0, pagesWithOffers: 0, nodes: 0, offers: 0, withholdingNodes: 0, offerBesideWithholding: 0 };
    held.pages++;
    held.nodes += nodes.length;
    let pageOffers = 0;
    for (const node of nodes) {
      nodesTotal++;
      const withholds = WITHHOLDS.test(node.description ?? "");
      if (withholds) held.withholdingNodes++;
      const priced = node.offers?.price === "0";
      if (priced) { held.offers++; offersTotal++; pageOffers++; }
      if (priced && node.offers.description !== node.offers.name) {
        hedgedOffers++;
        const reason = node.offers.description.slice(`${node.offers.name} — `.length);
        if (!(node.description ?? "").includes(reason)) offerSayingMoreThanItsNode++;
      }
      if (priced && withholds) {
        held.offerBesideWithholding++;
        offerBesideWithholding++;
        if (witnesses.length < 12) witnesses.push({ route, name: node.name, tier: node.offers.name });
      }
    }
    if (pageOffers > 0) held.pagesWithOffers++;
    byKind.set(kind, held);
  }

  console.log(`\n## AC-3 census, from the running server`);
  console.log(`page kind             pages  with $0  SoftwareApplication  $0 Offers  withholding nodes  $0 beside a withholding description`);
  for (const [kind, h] of [...byKind].sort((a, b) => b[1].nodes - a[1].nodes)) {
    console.log(`${kind.padEnd(22)}${String(h.pages).padStart(5)}${String(h.pagesWithOffers).padStart(9)}${String(h.nodes).padStart(21)}${String(h.offers).padStart(11)}${String(h.withholdingNodes).padStart(19)}${String(h.offerBesideWithholding).padStart(38)}`);
  }
  console.log(`\ntotal nodes ${nodesTotal} · $0 Offers ${offersTotal} · $0 beside a withholding description ${offerBesideWithholding}`);
  console.log(`$0 Offers carrying the reason we cannot confirm the terms ${hedgedOffers}`
    + ` · of those, saying more than the node's own description ${offerSayingMoreThanItsNode}`);
  for (const w of witnesses) console.log(`  witness: ${w.route} | ${w.name} | ${w.tier}`);
} finally {
  proc.kill("SIGTERM");
}

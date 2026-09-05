import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  figuresInTables,
  figuresInSentences,
  disagreements,
} from "../dist/prose-record-crosscheck.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const base = process.env.CROSSCHECK_BASE ?? "http://127.0.0.1:3000";
const asJson = process.argv.includes("--json");
const routeArg = process.argv.indexOf("--routes");
const onlyRoutes = routeArg >= 0 ? process.argv[routeArg + 1].split(",") : null;

const offers = JSON.parse(readFileSync(path.join(root, "data", "index.json"), "utf-8")).offers;
const recordsByVendor = new Map();
for (const offer of offers) {
  if (!offer.vendor || !offer.description) continue;
  const key = offer.vendor.toLowerCase();
  if (!recordsByVendor.has(key)) {
    recordsByVendor.set(key, { tier: offer.tier ?? "", description: offer.description });
  }
}
const vendors = [...new Set(offers.map((o) => o.vendor).filter(Boolean))].sort(
  (a, b) => b.length - a.length,
);

async function sitemapRoutes() {
  const seen = new Set();
  const walk = async (sitemap) => {
    const body = await (await fetch(`${base}${sitemap}`)).text();
    for (const m of body.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const route = m[1].replace(/^https?:\/\/[^/]+/, "");
      if (route.endsWith(".xml")) {
        if (!seen.has(route)) {
          seen.add(route);
          await walk(route);
        }
      } else seen.add(route);
    }
  };
  await walk("/sitemap.xml");
  return [...seen].filter((r) => !r.endsWith(".xml"));
}

function standalone(route) {
  return /^\/[^/]+$/.test(route) && route !== "/";
}

function readableText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&mdash;/g, "—")
    .replace(/\s+/g, " ");
}

const routes = onlyRoutes ?? (await sitemapRoutes()).filter(standalone);
const findings = [];
let scanned = 0;

let cursor = 0;
async function worker() {
  while (cursor < routes.length) {
    const route = routes[cursor++];
    let html;
    try {
      const res = await fetch(`${base}${route}`);
      if (res.status !== 200) continue;
      html = await res.text();
    } catch {
      continue;
    }
    scanned++;
    const figures = [
      ...figuresInTables(html, vendors),
      ...figuresInSentences(readableText(html), vendors),
    ];
    findings.push(...disagreements(route, figures, recordsByVendor));
  }
}
await Promise.all(Array.from({ length: 16 }, worker));

const unique = [];
const seen = new Set();
for (const f of findings.sort((a, b) => a.route.localeCompare(b.route))) {
  const key = `${f.route}|${f.vendor}|${f.dimension}|${f.publishedFigure}|${f.recordFigure}`;
  if (seen.has(key)) continue;
  seen.add(key);
  unique.push(f);
}

if (asJson) {
  console.log(JSON.stringify({ scanned, candidates: unique.length, findings: unique }, null, 2));
} else {
  console.log(`# Prose vs record cross-check\n`);
  console.log(`Scanned ${scanned} standalone routes against ${recordsByVendor.size} catalogue records.`);
  console.log(`${unique.length} candidate disagreements across ${new Set(unique.map((f) => f.route)).size} routes.\n`);
  console.log(`A candidate means the page and the record disagree. Either one may be the stale side.\n`);
  for (const f of unique) {
    console.log(`- **${f.route}** — ${f.vendor}${f.plan ? ` (${f.plan})` : ""} / ${f.dimension} [${f.source}]`);
    console.log(`  - page publishes ${f.publishedFigure} — "${f.published}"`);
    console.log(`  - record holds ${f.recordFigure} — "${f.recordClause}"`);
  }
}

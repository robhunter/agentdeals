import { readFileSync, writeFileSync } from "node:fs";

const base = process.env.CENSUS_BASE ?? "http://127.0.0.1:8791";
const out = process.argv[3] ?? "artifacts/census-1734-oracle-figure.json";
const urls = readFileSync(process.argv[2] ?? "/tmp/1734/all-urls.txt", "utf8").split("\n").filter(Boolean);

const QUANTITY = /(\b4\s+(?:Arm\s+VMs|OCPUs?|Ampere\s+OCPUs?)\b|\b24\s?GB\b|\b2\s+OCPUs?\b|\b12\s?GB\b|\b1,500\s+OCPU\b)/gi;
const LIGHTSAIL = /(\$3\.50|\$5(?:\.00)?\s*\/\s*mo|512\s?MB|1\s+vCPU|2\s+vCPUs)/gi;

function text(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ");
}

function windowAround(body, index, span) {
  return body.slice(Math.max(0, index - span), Math.min(body.length, index + span)).trim();
}

const pages = [];
let fetched = 0;
for (const url of urls) {
  const res = await fetch(`${base}${url}`, { headers: { Host: "agentdeals.dev" }, redirect: "manual" });
  fetched += 1;
  if (res.status !== 200) continue;
  const html = await res.text();
  if (!/Oracle/i.test(html)) continue;
  const body = text(html);
  const hits = [];
  for (const m of body.matchAll(QUANTITY)) {
    const context = windowAround(body, m.index, 130);
    if (!/Oracle|Ampere|Always Free/i.test(context)) continue;
    hits.push({ figure: m[0], context });
  }
  const lightsail = [];
  for (const m of body.matchAll(LIGHTSAIL)) {
    const context = windowAround(body, m.index, 110);
    if (!/Lightsail/i.test(context)) continue;
    lightsail.push({ figure: m[0], context });
  }
  if (hits.length || lightsail.length) pages.push({ url, hits, lightsail });
}

const byFigure = new Map();
for (const page of pages) {
  for (const hit of page.hits) {
    const key = hit.figure.replace(/\s+/g, " ").toLowerCase();
    if (!byFigure.has(key)) byFigure.set(key, new Set());
    byFigure.get(key).add(page.url);
  }
}

const summary = {
  fetched,
  pagesWithAnOracleFigure: pages.filter(p => p.hits.length).length,
  pagesWithALightsailFigure: pages.filter(p => p.lightsail.length).length,
  byFigure: Object.fromEntries([...byFigure].map(([k, v]) => [k, { pages: v.size, urls: [...v].sort() }])),
};

writeFileSync(out, JSON.stringify({ summary, pages }, null, 2));
console.log(JSON.stringify(summary, null, 2));

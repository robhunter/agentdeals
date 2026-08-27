#!/usr/bin/env node
import { argv, exit } from "node:process";

const base = argv[2] || "http://localhost:3000";
const UA = "agentdeals-internal/1.0 (search crawl-space check)";

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  return res.text();
}

async function sitemapRoutes() {
  const seen = new Set();
  const routes = new Set();
  const todo = [`${base}/sitemap.xml`];
  while (todo.length) {
    const sm = todo.pop();
    if (seen.has(sm)) continue;
    seen.add(sm);
    let body;
    try {
      body = await get(sm);
    } catch (err) {
      console.error(`sitemap unreachable: ${sm} (${err.message})`);
      continue;
    }
    for (const m of body.matchAll(/<loc>(.*?)<\/loc>/g)) {
      const loc = m[1].replace(/^https?:\/\/[^/]+/, "");
      if (loc.endsWith(".xml")) todo.push(base + loc);
      else routes.add(loc);
    }
  }
  return [...routes].sort();
}

function searchAnchors(html) {
  return [...html.matchAll(/<a\s[^>]*>/g)]
    .map(m => m[0])
    .filter(tag => /href="(?:https?:\/\/[^/"]+)?\/search\?[^"]*"/.test(tag));
}

function anchorHref(tag) {
  const m = tag.match(/href="([^"]*)"/);
  return m ? m[1].replace(/&amp;/g, "&") : "";
}

const routes = await sitemapRoutes();
console.log(`routes from sitemap index: ${routes.length}`);

const violations = [];
const linked = new Set();
const queue = [...routes];
const workers = Array.from({ length: 12 }, async () => {
  while (queue.length) {
    const route = queue.shift();
    let html;
    try {
      html = await get(base + route);
    } catch (err) {
      console.error(`fetch failed: ${route} (${err.message})`);
      continue;
    }
    for (const tag of searchAnchors(html)) {
      linked.add(anchorHref(tag));
      if (!/\brel="[^"]*nofollow[^"]*"/.test(tag)) violations.push({ route, tag });
    }
  }
});
await Promise.all(workers);

console.log(`distinct query-bearing /search URLs linked: ${linked.size}`);
for (const href of [...linked].sort()) console.log(`  ${href}`);

if (violations.length) {
  console.log(`\nanchors missing rel="nofollow": ${violations.length}`);
  for (const v of violations) console.log(`  ${v.route}\n    ${v.tag}`);
  exit(1);
}
console.log(`\nall query-bearing /search anchors carry rel="nofollow"`);

import { readFileSync, writeFileSync } from "node:fs";
import { endedOffersStatedAsAvailable, ENDED_TERMS_POPULATION } from "../dist/retired-terms.js";

const base = process.env.CENSUS_BASE ?? "http://127.0.0.1:8791";
const out = process.argv[2] ?? "artifacts/census-1672-retired-terms.json";

const population = ENDED_TERMS_POPULATION();

async function routes() {
  const index = await (await fetch(`${base}/sitemap.xml`)).text();
  const subs = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  const wanted = subs.filter(u => !/sitemap-(?:vendors|comparisons)\.xml$/.test(u));
  const all = [];
  for (const sub of wanted) {
    const xml = await (await fetch(sub)).text();
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) all.push(new URL(m[1]).pathname);
  }
  return [...new Set(all)].sort();
}

const TEMPLATED = /^\/(?:alternative-to|best|category)\//;

const paths = await routes();
const findings = [];
const unserved = [];
let served = 0;

for (const path of paths) {
  let res;
  try {
    res = await fetch(base + path, { redirect: "manual" });
  } catch (err) {
    unserved.push({ path, error: String(err) });
    continue;
  }
  if (res.status !== 200) { unserved.push({ path, status: res.status }); continue; }
  served++;
  const html = await res.text();
  for (const f of endedOffersStatedAsAvailable(html, path, population)) {
    findings.push({ path, templated: TEMPLATED.test(path), ...f });
  }
}

const byPath = {};
for (const f of findings) byPath[f.path] = (byPath[f.path] ?? 0) + 1;

const report = {
  base,
  ended_offers: population.length,
  ended_vendors: population.map(o => o.vendor),
  routes: paths.length,
  served,
  unserved,
  findings_total: findings.length,
  findings_on_non_templated: findings.filter(f => !f.templated).length,
  by_path: Object.fromEntries(Object.entries(byPath).sort((a, b) => b[1] - a[1])),
  findings,
};

writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  ended_offers: report.ended_offers,
  routes: report.routes,
  served: report.served,
  unserved: unserved.length,
  findings_total: report.findings_total,
  findings_on_non_templated: report.findings_on_non_templated,
  by_path: report.by_path,
}, null, 2));

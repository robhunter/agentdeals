import { writeFileSync } from "node:fs";

const before = process.env.BEFORE_BASE ?? "http://localhost:8821";
const after = process.env.AFTER_BASE ?? "http://localhost:8822";
const out = process.argv[2] ?? "artifacts/census-1676-negative-control.json";

const SITEMAPS_OF_TEMPLATED_PAGES = ["sitemap-vendors", "sitemap-comparisons"];

async function routesTheSitemapLists(base) {
  const index = await (await fetch(`${base}/sitemap.xml`)).text();
  const children = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map(m => m[1])
    .filter(u => !SITEMAPS_OF_TEMPLATED_PAGES.some(s => u.includes(s)));
  const paths = new Set();
  for (const child of children) {
    const xml = await (await fetch(child.replace(/^https?:\/\/[^/]+/, base))).text();
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      paths.add(new URL(m[1]).pathname);
    }
  }
  return [...paths].sort();
}

function normalise(html, base) {
  const host = new URL(base).host;
  return html
    .split(base).join("HOST")
    .split(encodeURIComponent(base)).join("HOST")
    .split(host).join("HOST")
    .split(encodeURIComponent(host)).join("HOST");
}

async function render(base, path) {
  const res = await fetch(`${base}${path}`, { redirect: "manual" });
  const body = res.status === 200 ? normalise(await res.text(), base) : "";
  return { status: res.status, location: res.headers.get("location"), bytes: body.length, body };
}

const listed = await routesTheSitemapLists(before);
const differ = [];
let identical = 0;
let unserved = 0;
let bytesCompared = 0;

for (const path of listed) {
  const [a, b] = await Promise.all([render(before, path), render(after, path)]);
  if (a.status !== 200) unserved++;
  if (b.status !== 200) unserved++;
  bytesCompared += a.bytes + b.bytes;
  if (a.status === b.status && a.body === b.body) identical++;
  else differ.push({ path, before: { status: a.status, bytes: a.bytes }, after: { status: b.status, bytes: b.bytes } });
}

const summary = { listed: listed.length, identical, differ: differ.length, unserved, bytesCompared };
console.log(JSON.stringify(summary, null, 2));
for (const d of differ) console.log(`${d.path.padEnd(48)} ${d.before.status}/${d.before.bytes} -> ${d.after.status}/${d.after.bytes}`);

writeFileSync(out, JSON.stringify({ summary, differ }, null, 2));
console.log(`\nwrote ${out}`);

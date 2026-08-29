import fs from "node:fs";

const base = process.env.BASE ?? "http://127.0.0.1:8791";
const out = process.argv[2];
if (!out) {
  console.error("usage: BASE=http://127.0.0.1:PORT node scripts/census-1147.mjs <out.json>");
  process.exit(2);
}

const offers = JSON.parse(fs.readFileSync(new URL("../data/index.json", import.meta.url), "utf8")).offers;
const slug = (v) => v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const slugs = [...new Set(offers.map((o) => slug(o.vendor)))].sort();

const capture = (html) => {
  const h1 = html.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? "";
  const badge = h1.match(/class="risk-badge"[^>]*>([^<]*)</)?.[1] ?? "";
  const verdict = html.match(/<div class="quick-verdict">\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? "";
  const pageMeta = html.match(/<p class="page-meta">([\s\S]*?)<\/p>/)?.[1] ?? "";
  const metaDesc = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";
  const cards = [...html.matchAll(/<div class="detail-label">([\s\S]*?)<\/div>\s*<div class="detail-value"[^>]*>([\s\S]*?)<\/div>/g)]
    .map((m) => `${m[1].trim()}=${m[2].replace(/<[^>]+>/g, "").trim()}`);
  const growth = /class="section growth-section"/.test(html);
  const cause = html.match(/<p class="risk-cause-line"[\s\S]*?<\/p>/)?.[0]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? "";
  const compareCell = html.match(/<tr class="current-vendor-row">[\s\S]*?<\/tr>/)?.[0]?.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|").trim() ?? "";
  return {
    badge,
    verdict: verdict.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
    pageMeta: pageMeta.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
    metaDesc,
    cards,
    growth,
    cause,
    compareCell,
    bytes: html.length,
  };
};

const result = {};
let done = 0;
for (const s of slugs) {
  const res = await fetch(`${base}/vendor/${s}`, { redirect: "manual" });
  if (res.status !== 200) {
    result[s] = { status: res.status };
    continue;
  }
  result[s] = capture(await res.text());
  if (++done % 200 === 0) console.error(`  ${done}/${slugs.length}`);
}
fs.writeFileSync(out, JSON.stringify(result, null, 1));
console.error(`captured ${Object.keys(result).length} routes -> ${out}`);

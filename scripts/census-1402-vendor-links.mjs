import { argv } from "node:process";

const base = process.env.CENSUS_BASE ?? "http://127.0.0.1:3199";

const PAGES = [
  "/changes",
  "/pricing-changes",
  "/q2-pricing-preview-2026",
  "/free-tier-tracker",
  "/q1-2026-developer-pricing-report",
  "/free-tier-risk",
  "/",
  "/expiring",
  "/deadlines",
  "/this-week",
  "/free-saas-stack",
  "/free-startup-stack",
  "/free-devops-stack",
];

async function sitemapPaths() {
  const index = await (await fetch(`${base}/sitemap.xml`)).text();
  const paths = [];
  for (const sitemap of index.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const child = await (await fetch(sitemap[1])).text();
    for (const loc of child.matchAll(/<loc>([^<]+)<\/loc>/g)) paths.push(new URL(loc[1]).pathname);
  }
  return [...new Set(paths)].filter(p => !p.startsWith("/vendor/"));
}

const statusCache = new Map();

async function slugStatus(slug) {
  if (statusCache.has(slug)) return statusCache.get(slug);
  const res = await fetch(`${base}/vendor/${slug}`, { redirect: "manual" });
  statusCache.set(slug, res.status);
  return res.status;
}

function vendorHrefs(html) {
  const rendered = html.replace(/<script[\s\S]*?<\/script>/g, "");
  const out = [];
  const re = /href="\/vendor\/([^"#?]*)/g;
  let m;
  while ((m = re.exec(rendered)) !== null) out.push(m[1].replace(/\/$/, ""));
  return out;
}

const report = [];
const pagesToRead = argv.includes("--sitemap") ? await sitemapPaths() : PAGES;
for (const page of pagesToRead) {
  const res = await fetch(base + page, { redirect: "manual" });
  if (res.status !== 200) {
    report.push({ page, pageStatus: res.status, distinct: 0, dead: [] });
    continue;
  }
  const html = await res.text();
  const slugs = [...new Set(vendorHrefs(html))];
  const dead = [];
  for (const slug of slugs) {
    const status = await slugStatus(slug);
    if (status === 404) dead.push(slug);
  }
  report.push({ page, pageStatus: 200, distinct: slugs.length, dead: dead.sort() });
}

const allDead = new Set(report.flatMap(r => r.dead));
const lines = [];
lines.push("page\tdistinct\tdead");
for (const r of report) {
  if (argv.includes("--sitemap") && r.dead.length === 0) continue;
  lines.push(`${r.page}\t${r.distinct}\t${r.dead.length}`);
}
lines.push("");
lines.push(`pages read: ${report.length}`);
lines.push(`distinct dead slugs across all pages: ${allDead.size}`);
if (argv.includes("--list")) lines.push([...allDead].sort().join("\n"));
if (argv.includes("--per-page")) {
  for (const r of report) {
    if (r.dead.length === 0) continue;
    lines.push(`\n${r.page} (${r.dead.length}): ${r.dead.join(", ")}`);
  }
}
process.stdout.write(lines.join("\n") + "\n");

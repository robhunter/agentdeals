import { readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const base = args[args.indexOf("--base") + 1] ?? "http://localhost:8791";
const repo = path.resolve(args[args.indexOf("--repo") + 1] ?? ".");

const { offers } = JSON.parse(readFileSync(path.join(repo, "data", "index.json"), "utf8"));
const { classifyTier } = await import(path.join(repo, "dist", "ranking.js"));
const { toSlug } = await import(path.join(repo, "dist", "slug.js"));

async function get(pathname) {
  const res = await fetch(base + pathname, { redirect: "follow" });
  if (!res.ok) throw new Error(`${pathname} returned ${res.status}`);
  return await res.text();
}

function faqAnswers(html) {
  const out = new Map();
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let parsed;
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      continue;
    }
    for (const graph of Array.isArray(parsed) ? parsed : [parsed]) {
      if (graph["@type"] !== "FAQPage") continue;
      for (const q of graph.mainEntity ?? []) out.set(q.name, q.acceptedAnswer?.text ?? "");
    }
  }
  return out;
}

const bestSlugs = [...new Set([...(await get("/best")).matchAll(/href="\/best\/([a-z0-9-]+)"/g)].map(m => m[1]))].sort();

const best = {};
for (const slug of bestSlugs) {
  const html = await get(`/best/${slug}`);
  const m = html.match(/([0-9]+) offers meet our criteria/);
  best[slug] = m ? Number(m[1]) : null;
}

const byVendor = new Map();
for (const offer of offers) {
  if (!byVendor.has(offer.vendor)) byVendor.set(offer.vendor, []);
  byVendor.get(offer.vendor).push(offer);
}

const noFreeTierVendors = [...byVendor.entries()]
  .filter(([, records]) => records.every(r => classifyTier(r.tier).class === "not_free"))
  .map(([vendor]) => vendor)
  .sort();

const vendors = {};
for (const vendor of noFreeTierVendors) {
  const slug = toSlug(vendor);
  let html;
  try {
    html = await get(`/vendor/${slug}`);
  } catch (err) {
    vendors[slug] = { vendor, error: String(err.message) };
    continue;
  }
  const answers = faqAnswers(html);
  const isFree = [...answers.entries()].find(([q]) => /^Is .* free\?$/.test(q));
  vendors[slug] = {
    vendor,
    h1: (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "").replace(/<[^>]*>/g, "").trim(),
    free_question: isFree?.[0] ?? null,
    free_answer: isFree?.[1] ?? null,
  };
}

const classes = {};
for (const offer of offers) {
  const c = classifyTier(offer.tier).class;
  classes[c] = (classes[c] ?? 0) + 1;
}

console.log(JSON.stringify({ base, repo, classes, best, vendor_count: noFreeTierVendors.length, vendors }, null, 2));

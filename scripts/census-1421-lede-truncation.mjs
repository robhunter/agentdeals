import { readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const base = args[args.indexOf("--base") + 1] ?? "http://127.0.0.1:8791";
const repo = path.resolve(args[args.indexOf("--repo") + 1] ?? ".");

const { offers } = JSON.parse(readFileSync(path.join(repo, "data", "index.json"), "utf8"));
const { toSlug } = await import(path.join(repo, "dist", "slug.js"));

const recordsBySlug = new Map();
for (const offer of offers) {
  const slug = toSlug(offer.vendor);
  if (!recordsBySlug.has(slug)) recordsBySlug.set(slug, []);
  recordsBySlug.get(slug).push(offer.description.trim());
}

const CLIP_MARKER = "…";
const WITHHELD = "terms are superseded and withheld";
const INCLUDES = " free tier includes ";

async function get(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "agentdeals-census" } });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      await new Promise(r => setTimeout(r, 400));
    }
  }
  return null;
}

function decodeEntities(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function metaDescription(html) {
  const m = html.match(/<meta name="description" content="([^"]*)"/);
  return m ? decodeEntities(m[1]) : null;
}

function sharedPrefixLength(published, stored) {
  let i = 0;
  while (i < published.length && i < stored.length && published[i] === stored[i]) i++;
  return i;
}

function quotationAgainst(published, candidates) {
  let best = null;
  for (const stored of candidates) {
    const shared = sharedPrefixLength(published, stored);
    const quotation = {
      stored,
      opening: published.slice(0, shared),
      marked: published.slice(shared).startsWith(CLIP_MARKER),
      continues: stored.slice(shared),
    };
    if (best === null || quotation.opening.length > best.opening.length) best = quotation;
  }
  return best;
}

function unclosedBrackets(text) {
  let open = 0;
  for (const character of text) {
    if (character === "(") open++;
    else if (character === ")" && open > 0) open--;
  }
  return open;
}

const sitemap = await get(`${base}/sitemap-vendors.xml`);
if (!sitemap) throw new Error("sitemap-vendors.xml unreachable");
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].replace(/^https?:\/\/[^/]+/, base));

const report = {
  base,
  vendor_urls: urls.length,
  unreachable: [],
  no_description: [],
  branch: { superseded: 0, has_free: 0, other: 0 },
  free_tier_branch: {
    pages: 0,
    resolved_to_a_record: 0,
    shorter_than_the_record: 0,
    marked_as_clipped: 0,
    clipped_without_saying_so: 0,
    cut_inside_a_word: 0,
    severs_a_number_from_its_unit: 0,
  },
  ledes_with_an_unclosed_bracket: 0,
  ledes_containing_a_repeated_full_stop: 0,
  lede_length: { median: 0, max: 0 },
  samples: { cut_inside_a_word: [], clipped_without_saying_so: [] },
};

const lengths = [];
const CONCURRENCY = 8;
let cursor = 0;
async function worker() {
  while (cursor < urls.length) {
    const url = urls[cursor++];
    const route = url.slice(base.length);
    const html = await get(url);
    if (html === null) { report.unreachable.push(route); continue; }
    const desc = metaDescription(html);
    if (desc === null) { report.no_description.push(route); continue; }

    lengths.push(desc.length);
    if (unclosedBrackets(desc) > 0) report.ledes_with_an_unclosed_bracket++;
    if (desc.includes("..")) report.ledes_containing_a_repeated_full_stop++;

    if (desc.includes(WITHHELD)) { report.branch.superseded++; continue; }
    const includesAt = desc.indexOf(INCLUDES);
    if (includesAt === -1) { report.branch.other++; continue; }
    report.branch.has_free++;
    report.free_tier_branch.pages++;

    const slug = route.replace("/vendor/", "");
    const records = recordsBySlug.get(slug);
    if (!records) continue;
    report.free_tier_branch.resolved_to_a_record++;

    const quotation = quotationAgainst(desc.slice(includesAt + INCLUDES.length), records);
    if (quotation.continues === "") continue;
    report.free_tier_branch.shorter_than_the_record++;
    if (quotation.marked) report.free_tier_branch.marked_as_clipped++;
    else {
      report.free_tier_branch.clipped_without_saying_so++;
      if (report.samples.clipped_without_saying_so.length < 6) {
        report.samples.clipped_without_saying_so.push({ route, opening: quotation.opening.slice(-60) });
      }
    }
    if (/[A-Za-z0-9]$/.test(quotation.opening) && /^[A-Za-z0-9]/.test(quotation.continues)) {
      report.free_tier_branch.cut_inside_a_word++;
      if (report.samples.cut_inside_a_word.length < 6) {
        report.samples.cut_inside_a_word.push({ route, opening: quotation.opening.slice(-50), continues: quotation.continues.slice(0, 20) });
      }
    }
    if (/\d$/.test(quotation.opening) && /^\s*[A-Za-z]/.test(quotation.continues)) {
      report.free_tier_branch.severs_a_number_from_its_unit++;
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

lengths.sort((a, b) => a - b);
report.lede_length.median = lengths[Math.floor(lengths.length / 2)] ?? 0;
report.lede_length.max = lengths[lengths.length - 1] ?? 0;
report.unreachable = report.unreachable.slice(0, 20);
console.log(JSON.stringify(report, null, 2));

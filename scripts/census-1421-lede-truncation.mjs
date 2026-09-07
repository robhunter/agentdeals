import { readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const base = args[args.indexOf("--base") + 1] ?? "http://127.0.0.1:8791";
const repo = path.resolve(args[args.indexOf("--repo") + 1] ?? ".");
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;

const { offers } = JSON.parse(readFileSync(path.join(repo, "data", "index.json"), "utf8"));

const storedTerms = new Set(offers.map(o => o.description.trim()));

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

const WITHHELD = "terms are superseded and withheld";
const INCLUDES = " free tier includes ";

function termsClause(desc) {
  const at = desc.indexOf(INCLUDES);
  if (at === -1) return null;
  const rest = desc.slice(at + INCLUDES.length);
  const stop = rest.search(/\.(\s|$)/);
  return stop === -1 ? rest : rest.slice(0, stop);
}

function matchesAStoredRecord(clause) {
  for (const terms of storedTerms) if (terms.startsWith(clause)) return terms;
  return null;
}

function cutInsideAWord(clause, full) {
  if (!full || full.length <= clause.length) return false;
  const next = full[clause.length];
  const last = clause[clause.length - 1];
  return /[A-Za-z0-9]/.test(next) && /[A-Za-z0-9]/.test(last);
}

function seversANumberFromItsUnit(clause, full) {
  if (!full || full.length <= clause.length) return false;
  if (/\d[\d,.]*\s*$/.test(clause)) return true;
  const tail = clause.match(/(\d[\d,.]*)\s*([A-Za-z-]*)$/);
  if (!tail) return false;
  return cutInsideAWord(clause, full) && tail[2] !== "";
}

function opensABracketItDoesNotClose(text) {
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
  }
  return depth !== 0;
}

const sitemap = await get(`${base}/sitemap-vendors.xml`);
if (!sitemap) throw new Error("sitemap-vendors.xml unreachable");
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
  .map(m => m[1].replace(/^https?:\/\/[^/]+/, base))
  .slice(0, limit);

const report = {
  base,
  vendor_urls: urls.length,
  unreachable: [],
  no_description: [],
  branch: { superseded: 0, has_free: 0, other: 0 },
  has_free: {
    pages: 0,
    matched_to_a_record: 0,
    clause_shorter_than_the_record: 0,
    cut_at_exactly_100: 0,
    cut_inside_a_word: 0,
    severs_a_number_from_its_unit: 0,
    unclosed_bracket: 0,
    marked_as_clipped: 0,
    unmarked_clip: 0,
  },
  superseded: { pages: 0, ending_mid_word: 0, unclosed_bracket: 0 },
  double_period: 0,
  samples: { cut_inside_a_word: [], unmarked_clip: [], double_period: [] },
  by_url: {},
};

const CONCURRENCY = 8;
let cursor = 0;
async function worker() {
  while (cursor < urls.length) {
    const url = urls[cursor++];
    const html = await get(url);
    const route = url.slice(base.length);
    if (html === null) {
      report.unreachable.push(route);
      continue;
    }
    const desc = metaDescription(html);
    if (desc === null) {
      report.no_description.push(route);
      continue;
    }
    if (desc.includes("..")) {
      report.double_period++;
      if (report.samples.double_period.length < 6) report.samples.double_period.push({ route, desc });
    }
    if (desc.includes(WITHHELD)) {
      report.branch.superseded++;
      report.superseded.pages++;
      report.by_url[route] = { branch: "superseded", desc };
      continue;
    }
    const clause = termsClause(desc);
    if (clause === null) {
      report.branch.other++;
      continue;
    }
    report.branch.has_free++;
    report.has_free.pages++;
    const bare = clause.replace(/…$/, "").trim();
    const full = matchesAStoredRecord(bare);
    if (full) report.has_free.matched_to_a_record++;
    const clipped = Boolean(full) && full.length > bare.length;
    if (clipped) report.has_free.clause_shorter_than_the_record++;
    if (bare.length === 100) report.has_free.cut_at_exactly_100++;
    if (cutInsideAWord(bare, full)) {
      report.has_free.cut_inside_a_word++;
      if (report.samples.cut_inside_a_word.length < 8) report.samples.cut_inside_a_word.push({ route, clause });
    }
    if (seversANumberFromItsUnit(bare, full)) report.has_free.severs_a_number_from_its_unit++;
    if (opensABracketItDoesNotClose(clause)) report.has_free.unclosed_bracket++;
    if (clipped && clause.endsWith("…")) report.has_free.marked_as_clipped++;
    if (clipped && !clause.endsWith("…")) {
      report.has_free.unmarked_clip++;
      if (report.samples.unmarked_clip.length < 8) report.samples.unmarked_clip.push({ route, clause, full });
    }
    report.by_url[route] = { branch: "has_free", desc, clause };
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

for (const [route, row] of Object.entries(report.by_url)) {
  if (row.branch !== "superseded") continue;
  const sentence = row.desc.split(/(?<=[.…])\s/)[0] ?? "";
  if (/[A-Za-z0-9]$/.test(sentence.replace(/[.…]$/, "")) && sentence.endsWith(".") && !sentence.endsWith("….")) continue;
  if (opensABracketItDoesNotClose(sentence)) report.superseded.unclosed_bracket++;
}

report.unreachable = report.unreachable.slice(0, 20);
delete report.by_url;
console.log(JSON.stringify(report, null, 2));

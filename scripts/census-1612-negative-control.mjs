import { readFileSync, writeFileSync } from "node:fs";

const before = process.env.BEFORE_BASE ?? "http://127.0.0.1:8793";
const after = process.env.AFTER_BASE ?? "http://127.0.0.1:8792";
const out = process.argv[2] ?? "artifacts/census-1612-negative-control.json";

const register = JSON.parse(readFileSync("data/page-reviews.json", "utf8")).pages;

const CITED_LINK = /<a href="(https?:\/\/[^"]+)" rel="nofollow noopener" class="record-source"[^>]*title="([^"]*)"/g;
const LIST_ENTRY = /<li id="(source-[a-z0-9-]+)">([\s\S]*?)<\/li>/g;

function shape(html) {
  return {
    cited: [...html.matchAll(new RegExp(CITED_LINK.source, "g"))].map(m => `${m[1]}|${m[2]}`).sort(),
    entries: [...html.matchAll(new RegExp(LIST_ENTRY.source, "g"))]
      .map(m => `${m[1]}|${m[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()}`)
      .sort(),
    bytes: html.length,
  };
}

async function render(base, path) {
  const res = await fetch(`${base}${path}`, { redirect: "manual" });
  return res.status === 200 ? shape(await res.text()) : null;
}

const moved = [];
let citedLinks = 0;
let listEntries = 0;
let pagesCompared = 0;

for (const page of register) {
  const [was, is] = await Promise.all([render(before, page.path), render(after, page.path)]);
  if (was === null || is === null) {
    moved.push({ path: page.path, problem: "not served by both builds" });
    continue;
  }
  pagesCompared += 1;
  citedLinks += was.cited.length;
  listEntries += was.entries.length;
  const lostLinks = was.cited.filter(link => !is.cited.includes(link));
  const gainedLinks = is.cited.filter(link => !was.cited.includes(link));
  const lostEntries = was.entries.filter(entry => !is.entries.includes(entry));
  const gainedEntries = is.entries.filter(entry => !was.entries.includes(entry));
  if (lostLinks.length || gainedLinks.length || lostEntries.length || gainedEntries.length) {
    moved.push({ path: page.path, lostLinks, gainedLinks, lostEntries, gainedEntries });
  }
}

const report = {
  before,
  after,
  pages_compared: pagesCompared,
  cited_source_links_before: citedLinks,
  cited_source_list_entries_before: listEntries,
  pages_whose_citations_moved: moved,
};

writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

import { readFileSync, writeFileSync } from "node:fs";

const base = process.env.CENSUS_BASE ?? "http://127.0.0.1:8791";
const out = process.argv[2] ?? "artifacts/census-1612-unsourced-labels.json";

const register = JSON.parse(readFileSync("data/page-reviews.json", "utf8")).pages;

const TAG = /<(a|span)\b[^>]*class="[^"]*\bunsourced-tag\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/g;
const TITLE = /title="([^"]*)"/;
const HREF = /href="#([^"]*)"/;
const TABLE_ROW = /<tr\b[\s\S]*?<\/tr>/g;
const ROW_CELL = /<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/g;
const MARKER = /class="[^"]*\b(?:record-source|unsourced-tag)\b[^"]*"/;
const VENDOR_LINK = /href="\/vendor\/([a-z0-9][a-z0-9-]*)"/;
const TIMELINE_HEADING = /<h2\b[^>]*\bid="changes"/;

function decode(text) {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function staticHalf(html) {
  const timeline = TIMELINE_HEADING.exec(html);
  return timeline ? html.slice(0, timeline.index) : html;
}

const clauses = new Map();
const pages = [];
let tags = 0;
let linked = 0;
let unlinked = 0;
const rowsWithoutAMarker = [];
let rowsWithASlug = 0;

for (const page of register) {
  const res = await fetch(`${base}${page.path}`, { redirect: "manual" });
  if (res.status !== 200) {
    pages.push({ path: page.path, status: res.status });
    continue;
  }
  const html = await res.text();
  const onPage = [];
  for (const tag of html.matchAll(new RegExp(TAG.source, "g"))) {
    const attrs = tag[0].slice(0, tag[0].indexOf(">"));
    const clause = attrs.match(TITLE)?.[1] ?? null;
    const anchor = attrs.match(HREF)?.[1] ?? null;
    onPage.push({ label: decode(tag[2]), clause, anchor });
    tags += 1;
    if (clause !== null) clauses.set(clause, (clauses.get(clause) ?? 0) + 1);
    if (anchor === null) unlinked += 1;
    else linked += 1;
  }

  const unmarked = [];
  for (const row of staticHalf(html).matchAll(new RegExp(TABLE_ROW.source, "g"))) {
    const cells = row[0].match(ROW_CELL) ?? [];
    const first = cells[0];
    if (first === undefined) continue;
    const slug = first.match(VENDOR_LINK)?.[1] ?? null;
    if (slug === null) continue;
    rowsWithASlug += 1;
    if (row[0].match(MARKER)) continue;
    unmarked.push({ slug, subject: decode(first), hasDigit: cells.slice(1).some(c => /\d/.test(decode(c))) });
  }
  if (unmarked.length > 0) rowsWithoutAMarker.push({ path: page.path, rows: unmarked });

  pages.push({ path: page.path, status: 200, tags: onPage, unmarked_rows: unmarked.length });
}

const report = {
  base,
  register_pages: register.length,
  served: pages.filter(p => p.status === 200).length,
  tags,
  tags_linking_to_visible_text: linked,
  tags_with_the_clause_only_in_title: unlinked,
  labels: [...new Set(pages.flatMap(p => (p.tags ?? []).map(t => t.label)))].sort(),
  clauses: [...clauses.entries()].sort((a, b) => b[1] - a[1]).map(([clause, count]) => ({ clause, count })),
  tabulated_rows_with_a_slug: rowsWithASlug,
  tabulated_rows_with_a_slug_and_no_marker: rowsWithoutAMarker.reduce((n, p) => n + p.rows.length, 0),
  unmarked_rows_with_no_digit: rowsWithoutAMarker.reduce(
    (n, p) => n + p.rows.filter(r => !r.hasDigit).length,
    0,
  ),
  unmarked_by_page: rowsWithoutAMarker,
  pages,
};

writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      served: report.served,
      tags: report.tags,
      linked: report.tags_linking_to_visible_text,
      title_only: report.tags_with_the_clause_only_in_title,
      labels: report.labels,
      clauses: report.clauses,
      rows_with_a_slug: report.tabulated_rows_with_a_slug,
      rows_with_a_slug_and_no_marker: report.tabulated_rows_with_a_slug_and_no_marker,
      of_those_with_no_digit: report.unmarked_rows_with_no_digit,
    },
    null,
    2,
  ),
);

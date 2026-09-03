import { readFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const REPO = new URL("..", import.meta.url).pathname;

const stored = JSON.parse(readFileSync(`${REPO}/data/deal_changes.json`, "utf-8")).changes;
const resolved = stored.filter((c) => c.resolution);

const escServer = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escClient = (s) => escServer(s).replace(/'/g, "&#39;");

const KEY_LEN = 40;
const keys = resolved.map((c) => {
  const raw = c.summary.slice(0, KEY_LEN);
  return { record: `${c.vendor} ${c.date}`, needles: [...new Set([raw, escServer(raw), escClient(raw)])] };
});

const STRUCTURAL = ["change-resolved", "pc-resolved", "superseded-row", "EventCancelled", "endDate", '"resolved":true'];
const tags = resolved.map((c) =>
  c.resolution.state === "reversed"
    ? `No longer in force (${c.resolution.date}).`
    : `Retracted — this record was our error (${c.resolution.date}).`
);
const details = resolved.map((c) => c.resolution.detail).filter(Boolean);

async function get(p) {
  const res = await fetch(`${BASE}${p}`);
  return { status: res.status, body: await res.text() };
}

async function sitemapPaths() {
  const out = new Set();
  for (const map of ["pages", "vendors", "comparisons", "reports", "misc"]) {
    const { body } = await get(`/sitemap-${map}.xml`);
    for (const [, loc] of body.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      try {
        out.add(new URL(loc).pathname);
      } catch {
        out.add(loc);
      }
    }
  }
  return [...out].sort();
}

const paths = await sitemapPaths();
process.stderr.write(`${paths.length} paths from five sitemaps\n`);

const occurrences = [];
let nonOk = 0;

for (const p of paths) {
  let page;
  try {
    page = await get(p);
  } catch (err) {
    process.stderr.write(`FETCH FAIL ${p} ${err.message}\n`);
    nonOk++;
    continue;
  }
  if (page.status !== 200) {
    nonOk++;
    continue;
  }
  const body = page.body;
  for (const { record, needles } of keys) {
    for (const needle of needles) {
      let at = body.indexOf(needle);
      while (at !== -1) {
        const before = body.slice(Math.max(0, at - 2500), at);
        const after = body.slice(at, at + 900);
        const window = before + after;
        const tight = body.slice(Math.max(0, at - 120), at);
        occurrences.push({
          path: p,
          record,
          structural: STRUCTURAL.some((m) => window.includes(m)),
          detail: details.some((d) => window.includes(d)),
          tag: tags.some((t) => tight.includes(t)),
        });
        at = body.indexOf(needle, at + needle.length);
      }
    }
  }
}

const total = occurrences.length;
const tally = (f) => occurrences.filter(f).length;
const unmarked = occurrences.filter((o) => !o.structural && !o.detail && !o.tag);

console.log(`paths fetched: ${paths.length}, non-200 or failed: ${nonOk}`);
console.log(`occurrences of a resolved record: ${total}`);
console.log(`  carrying the derived tag:      ${tally((o) => o.tag)}`);
console.log(`  carrying a structural marker:  ${tally((o) => o.structural)}`);
console.log(`  carrying the detail sentence:  ${tally((o) => o.detail)}`);
console.log(`  carrying nothing:              ${unmarked.length}`);

const byRecord = {};
for (const o of occurrences) {
  byRecord[o.record] ??= { n: 0, tag: 0, structural: 0, detail: 0, none: 0 };
  const r = byRecord[o.record];
  r.n++;
  if (o.tag) r.tag++;
  if (o.structural) r.structural++;
  if (o.detail) r.detail++;
  if (!o.tag && !o.structural && !o.detail) r.none++;
}
console.log("\nrecord | occurrences | tag | structural | detail | none");
for (const [record, r] of Object.entries(byRecord).sort()) {
  console.log(`${record} | ${r.n} | ${r.tag} | ${r.structural} | ${r.detail} | ${r.none}`);
}

if (unmarked.length) {
  console.log("\nunmarked:");
  for (const p of [...new Set(unmarked.map((o) => `${o.path}  (${o.record})`))].sort()) console.log(`  ${p}`);
}

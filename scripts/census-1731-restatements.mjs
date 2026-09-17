import { writeFileSync } from "node:fs";
import { loadOffers, changesByVendor, refusalsForVendor } from "../dist/data.js";
import { vendorSlugMap } from "../dist/vendor-slug.js";
import { vendorVerdictContextFrom, reasonWeCannotConfirmTheTerms } from "../dist/vendor-verdict-input.js";
import { whyWeCannotConfirmTheseTerms, refusalWithholdsStability } from "../dist/vendor-verdict.js";

const base = process.env.CENSUS_BASE ?? "http://127.0.0.1:8791";

const offers = loadOffers();
const changes = changesByVendor();
const servedOn = new Date().toISOString().slice(0, 10);

const byVendor = new Map();
for (const offer of offers) {
  const held = byVendor.get(offer.vendor);
  if (held) held.push(offer);
  else byVendor.set(offer.vendor, [offer]);
}

function unescapeHtml(s) {
  return s
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&ldquo;/g, '"').replace(/&rdquo;/g, '"')
    .replace(/&rsquo;/g, "'").replace(/&mdash;/g, "—").replace(/&ndash;/g, "–")
    .replace(/&rarr;/g, "→").replace(/&darr;/g, "↓").replace(/&hellip;/g, "…")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

function visibleTextOf(html) {
  const body = html
    .replace(/<head[\s\S]*?<\/head>/g, " ")
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ");
  return unescapeHtml(body.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function occurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) { n++; at = haystack.indexOf(needle, at + needle.length); }
  return n;
}

function statementsOfTheReason(text, unconfirmed) {
  const clause = unconfirmed.clause;
  const uncapped = clause.charAt(0).toLowerCase() + clause.slice(1);
  const capped = clause.charAt(0).toUpperCase() + clause.slice(1);
  return occurrences(text, uncapped) + occurrences(text, capped) + occurrences(text, unconfirmed.sentence);
}

async function fetchText(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.text();
    } catch { /* retry */ }
  }
  return null;
}

const sitemap = await fetchText(`${base}/sitemap-vendors.xml`);
const paths = [...sitemap.matchAll(/<loc>([^<]*\/vendor\/[^<]*)<\/loc>/g)].map(([, u]) => new URL(u).pathname);

const rows = [];
const batch = 24;
for (let i = 0; i < paths.length; i += batch) {
  const slice = paths.slice(i, i + batch);
  const pages = await Promise.all(slice.map(p => fetchText(`${base}${p}`)));
  for (let j = 0; j < slice.length; j++) {
    const path = slice[j];
    const html = pages[j];
    if (!html) { rows.push({ path, fetched: false }); continue; }
    const vendor = vendorSlugMap.get(path.replace("/vendor/", "")) ?? null;
    const vendorOffers = vendor ? byVendor.get(vendor) : null;
    const context = vendorOffers
      ? vendorVerdictContextFrom({
          vendor,
          vendorOffers,
          vendorChanges: changes.get(vendor.toLowerCase()) ?? [],
          refusedReads: refusalsForVendor(vendor),
          servedOn,
        })
      : null;
    const unconfirmed = context
      ? reasonWeCannotConfirmTheTerms(context.primary, whyWeCannotConfirmTheseTerms(context.input))
      : null;
    const text = visibleTextOf(html);
    const verdict = (html.match(/<div class="quick-verdict">\s*<p>([\s\S]*?)<\/p>/) ?? [])[1] ?? "";
    rows.push({
      path,
      fetched: true,
      vendor,
      unconfirmed: unconfirmed !== null,
      reason: unconfirmed?.because.reason ?? null,
      refusedRead: context ? refusalWithholdsStability(context.input) !== null : false,
      statements: unconfirmed ? statementsOfTheReason(text, unconfirmed) : 0,
      verdictStatesTheReason: unconfirmed
        ? statementsOfTheReason(unescapeHtml(verdict.replace(/<[^>]+>/g, " ")), unconfirmed) > 0
        : null,
      sourceLine: /class="free-tier-source-line"/.test(html),
      visibleChars: text.length,
    });
  }
}

const fetched = rows.filter(r => r.fetched);
const population = fetched.filter(r => r.unconfirmed);
const rest = fetched.filter(r => !r.unconfirmed);

const median = xs => {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

console.log(`base ${base}`);
console.log(`fetched ${fetched.length} of ${rows.length}`);
console.log(`\npages holding terms we cannot confirm: ${population.length}`);
console.log(`  statements of the reason: median ${median(population.map(r => r.statements))}` +
  ` max ${Math.max(0, ...population.map(r => r.statements))}` +
  ` mean ${(population.reduce((n, r) => n + r.statements, 0) / population.length).toFixed(1)}`);
console.log(`the other pages: ${rest.length}`);
console.log(`  statements of the reason: median ${median(rest.map(r => r.statements))} max ${Math.max(0, ...rest.map(r => r.statements))}`);

const refused = population.filter(r => r.refusedRead);
console.log(`\npages a refused read withholds: ${refused.length}`);
console.log(`  Quick Verdict states the reason: ${refused.filter(r => r.verdictStatesTheReason).length}`);
console.log(`  a source line sits under the terms: ${refused.filter(r => r.sourceLine).length}`);
console.log(`  statements of the reason: median ${median(refused.map(r => r.statements))} max ${Math.max(0, ...refused.map(r => r.statements))}`);

console.log(`\nwhole population, Quick Verdict states the reason: ${population.filter(r => r.verdictStatesTheReason).length} of ${population.length}`);
const silent = population.filter(r => !r.verdictStatesTheReason);
console.log(`Quick Verdict states no reason: ${silent.length}`);
const silentReasons = new Map();
for (const r of silent) silentReasons.set(r.reason, (silentReasons.get(r.reason) ?? 0) + 1);
console.log(`  by reason: ${[...silentReasons].map(([k, n]) => `${k}=${n}`).join(" ")}`);

console.log(`\nsource lines on vendor pages: ${fetched.filter(r => r.sourceLine).length}`);
console.log(`  of those, terms we cannot confirm: ${fetched.filter(r => r.sourceLine && r.unconfirmed).length}`);

const distribution = new Map();
for (const r of population) distribution.set(r.statements, (distribution.get(r.statements) ?? 0) + 1);
console.log(`\nstatements per page across the population:`);
for (const [n, pages] of [...distribution].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${String(n).padStart(3)}  ${String(pages).padStart(4)} pages`);
}

const worst = population.slice().sort((a, b) => b.statements - a.statements).slice(0, 8);
console.log(`\nmost repetitive:`);
for (const r of worst) console.log(`  ${String(r.statements).padStart(3)}  ${r.path} [${r.reason}]`);

if (process.env.CENSUS_JSON) {
  writeFileSync(process.env.CENSUS_JSON, JSON.stringify(rows, null, 1));
  console.log(`\nwrote ${rows.length} rows to ${process.env.CENSUS_JSON}`);
}

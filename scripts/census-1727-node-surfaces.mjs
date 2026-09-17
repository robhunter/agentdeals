import { loadOffers } from "../dist/data.js";
import { vendorSlugMap } from "../dist/vendor-slug.js";
import { unconfirmedTermsForOffer } from "../dist/vendor-verdict-input.js";
import { supersedingChange } from "../dist/superseded-description.js";
import { changesByVendor } from "../dist/data.js";
import { unconfirmedTermsSentence, UNVERIFIED_TERMS_CAVEAT } from "../dist/vendor-verdict.js";

const base = process.env.CENSUS_BASE ?? "http://127.0.0.1:8791";

const offers = loadOffers();
const changes = changesByVendor();
const vendorOfSlug = vendorSlugMap;

const primaryOf = new Map();
for (const offer of offers) if (!primaryOf.has(offer.vendor)) primaryOf.set(offer.vendor, offer);

function jsonLdBlocks(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(([, body]) => { try { return JSON.parse(body); } catch { return null; } })
    .filter(v => v !== null);
}

function nodesOfType(root, type) {
  const found = [];
  (function walk(n) {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    if (n["@type"] === type) found.push(n);
    Object.values(n).forEach(walk);
  })(root);
  return found;
}

function unescapeHtml(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&mdash;/g, "—").replace(/&rarr;/g, "→");
}

function metaDescriptionOf(html) {
  const m = html.match(/<meta name="description" content="([^"]*)"/);
  return m ? unescapeHtml(m[1]) : null;
}

function visibleTermsOf(html) {
  const m = html.match(/<h2>Free Tier Details<\/h2>\s*<p class="(?:desc-text|terms-superseded-text)"[^>]*>([\s\S]*?)<\/p>/)
    ?? html.match(/<h2>Free Tier Details<\/h2>\s*<p[^>]*>([\s\S]*?)<\/p>/);
  return m ? unescapeHtml(m[1].replace(/<[^>]+>/g, "")) : null;
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
const urls = [...sitemap.matchAll(/<loc>([^<]*\/vendor\/[^<]*)<\/loc>/g)].map(([, u]) => u);
const paths = urls.map(u => new URL(u).pathname);
console.log(`vendor pages in sitemap: ${paths.length}`);

const rows = [];
const batch = 24;
for (let i = 0; i < paths.length; i += batch) {
  const slice = paths.slice(i, i + batch);
  const pages = await Promise.all(slice.map(p => fetchText(`${base}${p}`)));
  for (let j = 0; j < slice.length; j++) {
    const path = slice[j];
    const html = pages[j];
    if (!html) { rows.push({ path, fetched: false }); continue; }
    const slug = path.replace("/vendor/", "");
    const vendor = vendorOfSlug.get(slug);
    const primary = vendor ? primaryOf.get(vendor) : undefined;
    const blocks = jsonLdBlocks(html);
    const app = nodesOfType(blocks, "SoftwareApplication")[0] ?? null;
    const questions = nodesOfType(blocks, "Question");
    const freeQuestion = questions.find(q => /^Is .* free\?$/.test(q.name ?? "")) ?? null;
    const faqAnswer = freeQuestion?.acceptedAnswer?.text ?? null;
    const superseded = primary
      ? supersedingChange(primary, changes.get(primary.vendor.toLowerCase()) ?? []) !== null
      : null;
    const unconfirmed = primary && !superseded ? unconfirmedTermsForOffer(primary) : null;
    const reason = unconfirmed ? unconfirmed.sentence : null;
    const short = unconfirmed ? unconfirmedTermsSentence(unconfirmed) : null;
    const says = text => text !== null && reason !== null
      && (text.includes(reason) || text.includes(short) || text.includes(UNVERIFIED_TERMS_CAVEAT));
    rows.push({
      path,
      fetched: true,
      vendor: vendor ?? null,
      superseded,
      unconfirmed: unconfirmed !== null,
      reason: unconfirmed?.because.reason ?? null,
      meta: metaDescriptionOf(html),
      metaHedges: (metaDescriptionOf(html) ?? "").includes("Not verified — "),
      faqAnswer,
      faqHedges: says(faqAnswer),
      nodeDescription: app?.description ?? null,
      nodeHedges: says(app?.description ?? null),
      priced: app?.offers?.price === "0",
      offerDescription: app?.offers?.description ?? null,
      offerHedges: says(app?.offers?.description ?? null),
      visibleTerms: visibleTermsOf(html),
      visibleHedges: says(visibleTermsOf(html)),
      anywhereInProse: says(html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, "")),
      retired: /class="risk-badge"[^>]*>(?:Retired|Ended)/.test(html),
    });
  }
}

const fetched = rows.filter(r => r.fetched);
console.log(`fetched ${fetched.length} of ${rows.length}`);

const cannotConfirm = fetched.filter(r => r.unconfirmed);
console.log(`\npages holding terms we cannot confirm and not superseded: ${cannotConfirm.length}`);
console.log(`  of those, the node prices the tier at zero: ${cannotConfirm.filter(r => r.priced).length}`);

const table = [
  ["<meta name=\"description\">", r => r.metaHedges],
  ["FAQPage -> Is X free? answer", r => r.faqHedges],
  ["visible Free Tier Details", r => r.visibleHedges],
  ["SoftwareApplication.description", r => r.nodeHedges],
  ["Offer.description", r => r.offerHedges],
];
console.log(`\nsurface | says we cannot confirm | of ${fetched.length}`);
for (const [name, predicate] of table) {
  const n = fetched.filter(predicate).length;
  console.log(`  ${name.padEnd(34)} ${String(n).padStart(5)}  ${(100 * n / fetched.length).toFixed(0)}%`);
}

console.log(`\npages where we withhold the terms entirely (superseded): ${fetched.filter(r => r.superseded).length}`);
console.log(`  of those, the node prices the tier at zero: ${fetched.filter(r => r.superseded && r.priced).length}`);

const metaWithoutFaq = fetched.filter(r => r.metaHedges && !r.faqHedges);
console.log(`\npages whose meta hedges and whose FAQ answer does not: ${metaWithoutFaq.length}`);
for (const r of metaWithoutFaq.slice(0, 8)) console.log(`  ${r.path} [${r.reason ?? "no withholding"}]`);

const faqWithoutMeta = fetched.filter(r => r.faqHedges && !r.metaHedges);
console.log(`\npages whose FAQ answer hedges and whose meta does not: ${faqWithoutMeta.length}`);
const byReason = new Map();
for (const r of faqWithoutMeta) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`  ${String(reason).padEnd(30)} ${n}`);

const nodeDisagrees = fetched.filter(r => r.faqHedges && !r.nodeHedges);
console.log(`\npages whose FAQ answer hedges and whose SoftwareApplication node does not: ${nodeDisagrees.length}`);
console.log(`  of those, the node prices the tier at zero: ${nodeDisagrees.filter(r => r.priced).length}`);

const reasons = new Map();
for (const r of cannotConfirm) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
console.log(`\nreasons across the ${cannotConfirm.length} pages:`);
for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${String(reason).padEnd(30)} ${n}`);

const silentFaq = cannotConfirm.filter(r => !r.faqHedges);
console.log(`\npages holding terms we cannot confirm whose Is-X-free answer stays silent: ${silentFaq.length}`);
for (const r of silentFaq) {
  console.log(`  ${r.path.padEnd(42)} [${r.reason}] retired=${r.retired} saysItSomewhereInProse=${r.anywhereInProse} priced=${r.priced}`);
}

const silentPage = cannotConfirm.filter(r => !r.anywhereInProse);
console.log(`\npages holding terms we cannot confirm whose visible prose never says so: ${silentPage.length}`);
for (const r of silentPage.slice(0, 20)) console.log(`  ${r.path} [${r.reason}] priced=${r.priced}`);

if (process.env.CENSUS_JSON) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.CENSUS_JSON, JSON.stringify(rows, null, 1));
  console.log(`\nwrote ${rows.length} rows to ${process.env.CENSUS_JSON}`);
}

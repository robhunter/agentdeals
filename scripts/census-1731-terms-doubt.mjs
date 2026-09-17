import { writeFileSync } from "node:fs";
import { loadOffers, changesByVendor } from "../dist/data.js";
import { vendorSlugMap } from "../dist/vendor-slug.js";
import { unconfirmedTermsForOffer } from "../dist/vendor-verdict-input.js";
import { supersedingChange } from "../dist/superseded-description.js";
import { unconfirmedTermsSentence, UNVERIFIED_TERMS_CAVEAT } from "../dist/vendor-verdict.js";
import { refusalsForVendor } from "../dist/data.js";

const base = process.env.CENSUS_BASE ?? "http://127.0.0.1:8791";

const offers = loadOffers();
const changes = changesByVendor();

const primaryOf = new Map();
for (const offer of offers) if (!primaryOf.has(offer.vendor)) primaryOf.set(offer.vendor, offer);

function unescapeHtml(s) {
  return s
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&ldquo;/g, '"').replace(/&rdquo;/g, '"')
    .replace(/&rsquo;/g, "'").replace(/&mdash;/g, "—").replace(/&ndash;/g, "–")
    .replace(/&rarr;/g, "→").replace(/&darr;/g, "↓").replace(/&hellip;/g, "…")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

function visibleTextOf(html) {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<head[\s\S]*?<\/head>/g, " ");
  return unescapeHtml(body.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function metaDescriptionOf(html) {
  const m = html.match(/<meta name="description" content="([^"]*)"/);
  return m ? unescapeHtml(m[1]) : null;
}

function sectionText(html, re) {
  const m = html.match(re);
  return m ? unescapeHtml(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() : null;
}

const quickVerdictOf = html => sectionText(html, /<div class="quick-verdict">\s*<p>([\s\S]*?)<\/p>/);
const freeTierBlockOf = html =>
  sectionText(html, /<h2>Free Tier Details<\/h2>\s*<p class="(?:desc-text|terms-superseded-text)"[^>]*>([\s\S]*?)<\/p>/);
const sourceLineOf = html => sectionText(html, /<p class="free-tier-source-line"[^>]*>([\s\S]*?)<\/p>/);

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

const DOUBT_PATTERNS = [
  /cannot confirm/i,
  /have not confirmed/i,
  /no confirmation of the terms/i,
  /not verified/i,
  /unverified/i,
  /not rating this offer/i,
  /could not reconcile/i,
  /we refused the change/i,
  /nothing we have read describes/i,
  /cannot tell you that nothing changed/i,
  /different from the terms we hold/i,
  /\bunrated\b/i,
  /not re-?confirmed/i,
  /treat the empty history as a statement about our records/i,
  /states no amount, tier or rate/i,
  /we could not read/i,
  /did not resolve on our check/i,
];

function sentencesOf(text) {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"“(])/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function doubtSentences(text) {
  return sentencesOf(text).filter(s => DOUBT_PATTERNS.some(p => p.test(s)));
}

function normaliseWording(sentence, vendor) {
  let s = sentence;
  if (vendor) s = s.split(vendor).join("<vendor>");
  return s
    .replace(/\d{4}-\d{2}-\d{2}/g, "<date>")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/"[^"]*"/g, "<quote>")
    .replace(/\b\d[\d,.]*\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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
    const vendor = vendorSlugMap.get(slug) ?? null;
    const primary = vendor ? primaryOf.get(vendor) : undefined;
    const superseded = primary
      ? supersedingChange(primary, changes.get(primary.vendor.toLowerCase()) ?? []) !== null
      : null;
    const unconfirmed = primary && !superseded ? unconfirmedTermsForOffer(primary) : null;
    const reason = unconfirmed ? unconfirmed.sentence : null;
    const short = unconfirmed ? unconfirmedTermsSentence(unconfirmed) : null;
    const says = text => text !== null && reason !== null
      && (text.includes(reason) || text.includes(short) || text.includes(UNVERIFIED_TERMS_CAVEAT));

    const blocks = jsonLdBlocks(html);
    const app = nodesOfType(blocks, "SoftwareApplication")[0] ?? null;
    const freeQuestion = nodesOfType(blocks, "Question").find(q => /^Is .* free\?$/.test(q.name ?? "")) ?? null;
    const faqAnswer = freeQuestion?.acceptedAnswer?.text ?? null;

    const visible = visibleTextOf(html);
    const doubts = doubtSentences(visible);
    const verdict = quickVerdictOf(html);
    const sourceLine = sourceLineOf(html);
    const refusals = vendor ? refusalsForVendor(vendor) : [];
    const refusal = refusals.length > 0
      ? refusals.slice().sort((a, b) => String(b.refused_date).localeCompare(String(a.refused_date)))[0]
      : null;

    rows.push({
      path,
      fetched: true,
      vendor,
      superseded,
      unconfirmed: unconfirmed !== null,
      reason: unconfirmed?.because.reason ?? null,
      faqStatesTheReason: says(faqAnswer),
      nodeStatesTheReason: says(app?.description ?? null),
      metaHedges: (metaDescriptionOf(html) ?? "").includes("Not verified — "),
      verdict,
      verdictStatesTheReason: says(verdict),
      verdictNotRating: verdict !== null && verdict.includes("so we are not rating this offer today"),
      blockStatesTheReason: says(freeTierBlockOf(html)),
      hasSourceLine: sourceLine !== null,
      sourceLine,
      sourceCheckedOn: primary?.source_check?.checked ?? null,
      sourceOutcome: primary?.source_check?.outcome ?? null,
      refusedOn: refusal?.refused_date ?? null,
      doubtCount: doubts.length,
      doubtWordings: new Set(doubts.map(s => normaliseWording(s, vendor))).size,
      doubtChars: doubts.reduce((n, s) => n + s.length, 0),
      visibleChars: visible.length,
      doubts,
    });
  }
}

const fetched = rows.filter(r => r.fetched);
console.log(`fetched ${fetched.length} of ${rows.length}`);

const median = xs => {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const population = fetched.filter(r => r.faqStatesTheReason);
const rest = fetched.filter(r => !r.faqStatesTheReason);
console.log(`\npages whose "Is X free?" answer states the reason: ${population.length}`);
console.log(`the other vendor pages: ${rest.length}`);

const table = (label, set) => {
  console.log(`  ${label.padEnd(22)} n=${String(set.length).padStart(4)}` +
    `  doubt sentences median=${median(set.map(r => r.doubtCount))} max=${Math.max(0, ...set.map(r => r.doubtCount))}` +
    `  distinct wordings median=${median(set.map(r => r.doubtWordings))}`);
};
console.log(`\nvisible sentences telling a reader not to trust the terms:`);
table("the population", population);
table("the rest", rest);

const verdictStates = population.filter(r => r.verdictStatesTheReason);
const verdictRefuses = population.filter(r => !r.verdictStatesTheReason && r.verdictNotRating);
const verdictSilent = population.filter(r => !r.verdictStatesTheReason && !r.verdictNotRating);
console.log(`\npartition of the ${population.length}:`);
console.log(`  Quick Verdict states the reason                         ${verdictStates.length}`);
console.log(`  Quick Verdict says "we are not rating this offer today" ${verdictRefuses.length}`);
console.log(`    of those, a source line sits under the terms          ${verdictRefuses.filter(r => r.hasSourceLine).length}`);
console.log(`    of those, nothing sits under the terms                ${verdictRefuses.filter(r => !r.hasSourceLine).length}`);
console.log(`  Quick Verdict neither                                   ${verdictSilent.length}`);
for (const r of verdictSilent.slice(0, 10)) console.log(`      ${r.path} [${r.reason}]`);

console.log(`\nthe ${verdictRefuses.length}: source check date against the refusal date`);
const sameDay = verdictRefuses.filter(r => r.sourceCheckedOn && r.refusedOn && r.sourceCheckedOn === r.refusedOn);
const checkOlder = verdictRefuses.filter(r => r.sourceCheckedOn && r.refusedOn && r.sourceCheckedOn < r.refusedOn);
const checkNewer = verdictRefuses.filter(r => r.sourceCheckedOn && r.refusedOn && r.sourceCheckedOn > r.refusedOn);
console.log(`  same date        ${sameDay.length}`);
console.log(`  check is older   ${checkOlder.length}`);
console.log(`  check is newer   ${checkNewer.length}`);
const outcomes = new Map();
for (const r of verdictRefuses) outcomes.set(r.sourceOutcome, (outcomes.get(r.sourceOutcome) ?? 0) + 1);
console.log(`  source check outcomes: ${[...outcomes].map(([o, n]) => `${o}=${n}`).join(" ")}`);

console.log(`\nthe ${verdictRefuses.filter(r => !r.hasSourceLine).length} with no source line:`);
for (const r of verdictRefuses.filter(r => !r.hasSourceLine)) {
  console.log(`  ${r.path.padEnd(38)} [${r.reason}] outcome=${r.sourceOutcome} doubts=${r.doubtCount}`);
}

console.log(`\ncharacter budget on the population (median):`);
console.log(`  doubt sentences ${median(population.map(r => r.doubtChars))}`);
console.log(`  whole visible page ${median(population.map(r => r.visibleChars))}`);

const worst = fetched.slice().sort((a, b) => b.doubtCount - a.doubtCount).slice(0, 10);
console.log(`\nmost repetitive pages:`);
for (const r of worst) console.log(`  ${String(r.doubtCount).padStart(3)}  ${r.path} [${r.reason ?? "-"}]`);

const wordings = new Map();
for (const r of population) {
  for (const s of new Set(r.doubts.map(d => normaliseWording(d, r.vendor)))) {
    wordings.set(s, (wordings.get(s) ?? 0) + 1);
  }
}
console.log(`\ndistinct wordings across the population: ${wordings.size}`);
for (const [s, n] of [...wordings].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${String(n).padStart(4)}  ${s.slice(0, 150)}`);
}

if (process.env.CENSUS_JSON) {
  writeFileSync(process.env.CENSUS_JSON, JSON.stringify(rows.map(r => ({ ...r, doubts: undefined })), null, 1));
  console.log(`\nwrote ${rows.length} rows to ${process.env.CENSUS_JSON}`);
}

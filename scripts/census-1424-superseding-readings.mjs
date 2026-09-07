import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { quotesTheStoredTermsAsPrevious, readingBehindTheChange } = await import(`${root}/dist/superseded-description.js`);
const { narrowsTheStoredTerms } = await import(`${root}/dist/change-direction.js`);
const { isNoLongerInForce } = await import(`${root}/dist/change-resolution.js`);
const { tierRecordsAFreeTier } = await import(`${root}/dist/free-tier-record.js`);
const { openingOfTerms, punctuated } = await import(`${root}/dist/terms-opening.js`);
const { describesOnlyATrial, mentionsSomethingFree, namesAFreePlan, openingOfAReading, sentencesOf } =
  await import(`${root}/dist/superseding-reading.js`);

const LEDE_CAP = 90;
const CONCURRENCY = 6;
const TIMEOUT_MS = 25000;

const offers = JSON.parse(readFileSync(`${root}/data/index.json`, "utf8")).offers;
const changes = JSON.parse(readFileSync(`${root}/data/deal_changes.json`, "utf8")).changes;

const byVendor = new Map();
for (const change of changes) {
  const key = change.vendor.toLowerCase();
  if (!byVendor.has(key)) byVendor.set(key, []);
  byVendor.get(key).push(change);
}

function everySupersedingChange(offer) {
  let newest = null;
  for (const change of byVendor.get(offer.vendor.toLowerCase()) ?? []) {
    if (isNoLongerInForce(change)) continue;
    if (!narrowsTheStoredTerms(change.change_type)) continue;
    if (!quotesTheStoredTermsAsPrevious(change, offer.description)) continue;
    if (!newest || change.date > newest.date) newest = change;
  }
  return newest;
}

const population = [];
for (const offer of offers) {
  const change = everySupersedingChange(offer);
  if (!change) continue;
  const reading = readingBehindTheChange(change);
  if (!reading) continue;
  population.push({ offer, change, reading });
}

function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#36;/g, "$")
    .replace(/\s+/g, " ")
    .trim();
}

async function readThePage(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { "user-agent": "Mozilla/5.0 (compatible; AgentDeals-census/1.0)" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return { status: res.status, text: null };
      return { status: res.status, text: visibleText(await res.text()) };
    } catch (error) {
      if (attempt === 1) return { status: 0, text: null, error: String(error).slice(0, 120) };
    }
  }
  return { status: 0, text: null };
}

function whereThePageNamesAFreePlan(text) {
  for (const sentence of sentencesOf(text)) {
    if (sentence.text.length > 400) continue;
    if (namesAFreePlan(sentence.text)) return sentence.text.trim().slice(0, 180);
  }
  return null;
}

const rows = [];
let done = 0;
async function work(queue) {
  while (queue.length > 0) {
    const item = queue.shift();
    const page = await readThePage(item.change.source_url);
    const before = punctuated(openingOfTerms(item.reading.terms, LEDE_CAP));
    const after = punctuated(openingOfAReading(item.reading.terms, LEDE_CAP));
    const freeRecord = tierRecordsAFreeTier(item.offer.tier ?? "");
    const withdrawn = freeRecord && describesOnlyATrial(item.reading.terms);
    rows.push({
      vendor: item.offer.vendor,
      tier: item.offer.tier,
      free_tier_record: freeRecord,
      url: item.change.source_url,
      has_a_path: new URL(item.change.source_url).pathname.replace(/\/+$/, "") !== "",
      change_type: item.change.change_type,
      status: page.status,
      page_names_a_free_plan: page.text ? whereThePageNamesAFreePlan(page.text) : null,
      reading: item.reading.terms,
      lede_before: before,
      lede_after: withdrawn ? null : after,
      stops_superseding: withdrawn,
      stored: item.offer.description,
    });
    done++;
    if (done % 20 === 0) process.stderr.write(`  read ${done} of ${population.length}\n`);
  }
}

const queue = [...population];
await Promise.all(Array.from({ length: CONCURRENCY }, () => work(queue)));
rows.sort((a, b) => a.vendor.localeCompare(b.vendor));

const reachable = rows.filter((r) => r.status >= 200 && r.status < 400 && r.page_names_a_free_plan !== null || r.status >= 200 && r.status < 400);
const statesOne = rows.filter((r) => r.page_names_a_free_plan !== null);
const silentBefore = statesOne.filter((r) => !mentionsSomethingFree(r.lede_before));
const silentAfter = statesOne.filter((r) => r.lede_after !== null && !mentionsSomethingFree(r.lede_after));

const summary = {
  superseded_records: rows.length,
  cited_page_read: reachable.length,
  cited_page_names_a_free_plan: statesOne.length,
  published_lede_says_nothing_free_before: silentBefore.length,
  published_lede_says_nothing_free_after: silentAfter.length,
  records_that_stop_superseding: rows.filter((r) => r.stops_superseding).length,
  ledes_re_anchored: rows.filter((r) => !r.stops_superseding && r.lede_after !== r.lede_before).length,
};

writeFileSync(`${root}/../census-1424.json`, JSON.stringify({ summary, rows }, null, 1));
console.log(JSON.stringify(summary, null, 1));
console.log("\nstops superseding:");
for (const r of rows.filter((x) => x.stops_superseding)) {
  console.log(`  ${r.vendor} [${r.tier}] ${r.url} (${r.status}) page names a free plan: ${r.page_names_a_free_plan ? "yes" : "no"}`);
}
console.log("\nlede re-anchored:");
for (const r of rows.filter((x) => !x.stops_superseding && x.lede_after !== x.lede_before)) {
  console.log(`  ${r.vendor} ${r.url} (${r.status})\n    before: ${r.lede_before}\n    after:  ${r.lede_after}`);
}
console.log("\nlede still says nothing free while the cited page names a free plan:");
for (const r of silentAfter) {
  console.log(`  ${r.vendor} ${r.url}\n    page:  ${r.page_names_a_free_plan}\n    lede:  ${r.lede_after}`);
}

import { readFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const REPO = new URL("..", import.meta.url).pathname;

const stored = JSON.parse(readFileSync(`${REPO}/data/deal_changes.json`, "utf-8")).changes;
const { vendorSlugMap } = await import(`${REPO}/dist/vendor-slug.js`);
const { CHANGE_DIRECTION } = await import(`${REPO}/dist/data.js`);
const { CHANGE_KIND_NOUN } = await import(`${REPO}/dist/vendor-verdict.js`);

const NAMED_BY_THE_OLD_SENTENCE = new Set(["free_tier_removed", "limits_reduced", "pricing_restructured"]);
const DENIAL = /none of them a free tier removal, limit reduction or pricing restructure/;

const held = new Map();
for (const c of stored) {
  const key = c.vendor.toLowerCase();
  if (!held.has(key)) held.set(key, []);
  held.get(key).push(c);
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { "user-agent": "curl/8.0" } });
  return { status: res.status, body: await res.text() };
}

function availabilityAnswer(body) {
  for (const [, json] of body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch {
      continue;
    }
    if (parsed["@type"] !== "FAQPage") continue;
    for (const entry of parsed.mainEntity ?? []) {
      if (/free tier still available\?$/.test(entry.name)) return entry.acceptedAnswer?.text ?? "";
    }
  }
  return null;
}

const slugs = [...vendorSlugMap.entries()];
const rows = [];
let queue = 0;
const worker = async () => {
  while (queue < slugs.length) {
    const [slug, vendor] = slugs[queue++];
    const { status, body } = await get(`/alternative-to/${slug}`);
    if (status !== 200) {
      rows.push({ slug, vendor, status, answer: null });
      continue;
    }
    const records = held.get(vendor.toLowerCase()) ?? [];
    rows.push({
      slug,
      vendor,
      status,
      answer: availabilityAnswer(body),
      records: records.length,
      negative: [...new Set(records.filter(c => CHANGE_DIRECTION[c.change_type] === "negative").map(c => c.change_type))],
    });
  }
};
await Promise.all(Array.from({ length: 12 }, worker));

const published = rows.filter(r => r.answer !== null);
const affirms = published.filter(r => /^Yes, /.test(r.answer));
const withRecords = affirms.filter(r => r.records > 0);
const withNegative = affirms.filter(r => r.negative.length > 0);

const deniesNamed = withNegative.filter(r => DENIAL.test(r.answer) && r.negative.some(t => NAMED_BY_THE_OLD_SENTENCE.has(t)));
const deniesAny = withNegative.filter(r => DENIAL.test(r.answer));
const claimsNone = affirms.filter(r => /No pricing changes have been recorded\./.test(r.answer) && r.records > 0);
const namesNarrowing = withNegative.filter(r => / narrowed the terms/.test(r.answer) && !/did not narrow|None of the/.test(r.answer));

const NEGATION = /\b(?:none|no|not|zero|never|neither|nor)\b/i;
const kindsCalledAbsent = (answer, kinds) => {
  const called = [];
  for (const sentence of answer.split(/(?<=[.!?])\s+/)) {
    if (!NEGATION.test(sentence)) continue;
    for (const kind of kinds) {
      if (sentence.toLowerCase().includes(CHANGE_KIND_NOUN[kind])) called.push(kind);
    }
  }
  return [...new Set(called)].sort();
};
const denialsForAHeldKind = published.filter(r => kindsCalledAbsent(r.answer, r.negative ?? []).length > 0);

console.log(`vendor slugs:                                    ${rows.length}`);
console.log(`  /alternative-to publishes the answer:          ${published.length}`);
console.log(`  answer opens "Yes, ":                          ${affirms.length}`);
console.log(`    of those, vendor holds >=1 record:           ${withRecords.length}`);
console.log(`    of those, vendor holds >=1 negative record:  ${withNegative.length}`);
console.log("");
console.log(`DENIES one of the three named types it holds:     ${deniesNamed.length}`);
console.log(`DENIES while holding any negative record:         ${deniesAny.length}`);
console.log(`denies a kind it holds (derived from the nouns):  ${denialsForAHeldKind.length}`);
console.log(`claims zero changes while holding some:           ${claimsNone.length}`);
console.log(`names the narrowing record it holds:              ${namesNarrowing.length}`);
console.log("");
for (const r of deniesAny) console.log(`  DENIES  ${r.slug} — holds ${r.negative.join(", ")} (${r.records} records)`);
for (const r of namesNarrowing) console.log(`  NAMES   ${r.slug} — holds ${r.negative.join(", ")} (${r.records} records)`);

if (process.env.DUMP_ANSWERS) {
  console.log("\n--- every answer over a vendor holding a record ---");
  for (const r of withRecords) console.log(`${r.slug}\t${r.answer}`);
}

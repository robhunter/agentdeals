import { loadOffers, loadDealChanges, changesRatingTheListedTier, vendorRiskAssessment } from "../dist/data.js";
import { toSlug } from "../dist/vendor-slug.js";

const DAY = 24 * 60 * 60 * 1000;
const offers = loadOffers();
const changes = loadDealChanges();

const byVendor = new Map();
for (const c of changes) {
  if (!byVendor.has(c.vendor)) byVendor.set(c.vendor, []);
  byVendor.get(c.vendor).push(c);
}

const primaryFor = new Map();
for (const o of offers) {
  if (!primaryFor.has(o.vendor)) primaryFor.set(o.vendor, o);
}

function verdictAt(vendor, nowMs) {
  const primary = primaryFor.get(vendor);
  const vendorChanges = byVendor.get(vendor) ?? [];
  const grading = primary ? changesRatingTheListedTier(primary, vendorChanges) : vendorChanges;
  const a = vendorRiskAssessment(grading, nowMs);
  return {
    level: a.level,
    cause: a.cause ? `${a.cause.change_type}@${a.cause.date}` : null,
    withheld: a.rating_withheld ? `${a.rating_withheld.reason}:${a.rating_withheld.records}` : null,
  };
}

const base = Date.now();
const days = Number(process.argv[2] ?? 30);
const shifted = base + days * DAY;

const lifts = [];
const lapses = [];
const other = [];

for (const vendor of byVendor.keys()) {
  if (!primaryFor.has(vendor)) continue;
  const before = verdictAt(vendor, base);
  const after = verdictAt(vendor, shifted);
  if (JSON.stringify(before) === JSON.stringify(after)) continue;
  const row = { vendor, slug: toSlug(vendor), before, after };
  if (before.withheld && !after.withheld) lifts.push(row);
  else if (before.cause && before.level !== after.level) lapses.push(row);
  else other.push(row);
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
console.log(`base ${dayOf(base)} -> +${days} ${dayOf(shifted)}`);
console.log(`vendors with records: ${byVendor.size}; with a listed offer: ${[...byVendor.keys()].filter(v => primaryFor.has(v)).length}`);
console.log(`\na withholding lifts: ${lifts.length}`);
for (const r of lifts) console.log(`  ${r.slug.padEnd(28)} ${r.before.withheld} -> level=${r.after.level} cause=${r.after.cause}`);
console.log(`\na demotion lapses: ${lapses.length}`);
for (const r of lapses) console.log(`  ${r.slug.padEnd(28)} ${r.before.level} (${r.before.cause}) -> ${r.after.level} (${r.after.cause})`);
console.log(`\nother movement: ${other.length}`);
for (const r of other) console.log(`  ${r.slug.padEnd(28)} ${JSON.stringify(r.before)} -> ${JSON.stringify(r.after)}`);

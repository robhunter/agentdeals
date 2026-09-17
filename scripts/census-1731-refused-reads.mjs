import { loadOffers, changesByVendor, refusalsForVendor } from "../dist/data.js";
import { vendorVerdictContextFrom } from "../dist/vendor-verdict-input.js";
import {
  refusalWithholdsStability,
  whyWeCannotConfirmTheseTerms,
  vendorVerdictSentence,
} from "../dist/vendor-verdict.js";
import { refusedReadClause } from "../dist/change-refusal.js";
import { freeTierSourceOf } from "../dist/source-citation.js";
import { vendorSlugMap } from "../dist/vendor-slug.js";

const offers = loadOffers();
const changes = changesByVendor();
const slugOf = new Map([...vendorSlugMap].map(([slug, vendor]) => [vendor, slug]));
const servedOn = new Date().toISOString().slice(0, 10);

const byVendor = new Map();
for (const offer of offers) {
  const held = byVendor.get(offer.vendor);
  if (held) held.push(offer);
  else byVendor.set(offer.vendor, [offer]);
}

const rows = [];
for (const [vendor, vendorOffers] of byVendor) {
  const context = vendorVerdictContextFrom({
    vendor,
    vendorOffers,
    vendorChanges: changes.get(vendor.toLowerCase()) ?? [],
    refusedReads: refusalsForVendor(vendor),
    servedOn,
  });
  if (!context) continue;
  const input = context.input;
  const refused = refusalWithholdsStability(input);
  if (!refused) continue;
  const unconfirmed = whyWeCannotConfirmTheseTerms(input);
  const primary = context.primary;
  const source = freeTierSourceOf(primary);
  rows.push({
    vendor,
    slug: slugOf.get(vendor) ?? null,
    refusedOn: refused.refused_date,
    reason: unconfirmed?.because.reason ?? null,
    clauseMatchesRefusal: unconfirmed ? unconfirmed.clause === refusedReadClause(refused) : null,
    sourceCited: source.cited,
    sourceReadOn: source.cited ? source.readOn : null,
    sourceOutcome: primary.source_check?.outcome ?? null,
    sourceFinding: source.cited ? source.finding : null,
    verdict: vendorVerdictSentence(input),
  });
}

console.log(`vendors whose stability a refused read withholds: ${rows.length}`);
console.log(`  of those, we can state no reason we cannot confirm the terms: ${rows.filter(r => r.reason === null).length}`);
console.log(`  of those, the reason's clause differs from the refusal's: ${rows.filter(r => r.clauseMatchesRefusal === false).length}`);
for (const r of rows.filter(r => r.clauseMatchesRefusal === false).slice(0, 10)) {
  console.log(`    ${r.vendor} [${r.reason}]`);
}

const reasons = new Map();
for (const r of rows) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
console.log(`  reasons: ${[...reasons].map(([k, n]) => `${k}=${n}`).join(" ")}`);

const cited = rows.filter(r => r.sourceCited);
console.log(`\nof the ${rows.length}, a source line is rendered on: ${cited.length}`);
const same = cited.filter(r => r.sourceReadOn === r.refusedOn);
const older = cited.filter(r => r.sourceReadOn < r.refusedOn);
const newer = cited.filter(r => r.sourceReadOn > r.refusedOn);
console.log(`  source read on the same day as the refusal: ${same.length}`);
console.log(`  source read before the refusal:             ${older.length}`);
console.log(`  source read after the refusal:              ${newer.length}`);
for (const r of older) console.log(`    before: ${r.slug} read=${r.sourceReadOn} refused=${r.refusedOn}`);
for (const r of newer.slice(0, 30)) console.log(`    after:  ${r.slug} read=${r.sourceReadOn} refused=${r.refusedOn} outcome=${r.sourceOutcome}`);

const outcomes = new Map();
for (const r of rows) outcomes.set(r.sourceOutcome, (outcomes.get(r.sourceOutcome) ?? 0) + 1);
console.log(`\n  source check outcomes: ${[...outcomes].map(([k, n]) => `${k}=${n}`).join(" ")}`);

console.log(`\nsample source findings on the cited set:`);
for (const r of cited.slice(0, 5)) console.log(`  ${r.slug}: ${r.sourceFinding}`);

console.log(`\nsample verdict sentences:`);
for (const r of rows.slice(0, 3)) console.log(`  ${r.slug}: ${r.verdict}`);

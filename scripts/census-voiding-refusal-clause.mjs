import { loadOffers, changesByVendor, loadChangeRefusals } from "../dist/data.js";
import { refusalsByVendor, refusalVoidsTheReadsStanding, refusalMeasuredNoDifference, refusedReadClause, refusedReadSentence, UNRECONCILED_READ_BADGE_LABEL } from "../dist/change-refusal.js";
import { offerVerdictInput } from "../dist/vendor-verdict-input.js";
import { refusedReadWeHold, refusedReadWithholding, refusedReadWithholdingMetaClause, withheldBadgeLabel } from "../dist/vendor-verdict.js";

const servedOn = process.env.CENSUS_DAY ?? new Date().toISOString().slice(0, 10);

const offers = loadOffers();
const changeLog = changesByVendor();
const refusalLog = refusalsByVendor(loadChangeRefusals());

const changesFor = v => changeLog.get(v.toLowerCase()) ?? [];
const refusalsFor = v => refusalLog.get(v.toLowerCase()) ?? [];

const UNRECONCILED_CLAUSE = "we found a change we could not reconcile with the terms we publish";
const UNRECONCILED_META = "found a change we could not reconcile";

const byReason = new Map();
const buckets = new Map();
const rows = [];

const bucketOf = name => {
  const held = buckets.get(name);
  if (held) return held;
  const fresh = { records: 0, unreconciledClause: 0, unreconciledMeta: 0, unreconciledBadge: 0 };
  buckets.set(name, fresh);
  return fresh;
};

for (const offer of offers) {
  const input = offerVerdictInput({
    vendor: offer.vendor,
    offer,
    vendorChanges: changesFor(offer.vendor),
    refusedReads: refusalsFor(offer.vendor),
    servedOn,
  });
  if (!input) continue;
  const held = refusedReadWeHold(input);
  if (!held) continue;
  const bucket = refusalMeasuredNoDifference(held)
    ? "measured_no_difference"
    : refusalVoidsTheReadsStanding(held)
      ? "voids_the_reads_standing"
      : "leaves_the_read_standing";
  byReason.set(`${bucket} / ${held.reason}`, (byReason.get(`${bucket} / ${held.reason}`) ?? 0) + 1);
  const withholding = refusedReadWithholding(held);
  const clause = refusedReadClause(held);
  const sentence = refusedReadSentence(offer.vendor, held);
  const meta = refusedReadWithholdingMetaClause(withholding);
  const badge = withheldBadgeLabel(withholding);
  const counts = bucketOf(bucket);
  counts.records++;
  if (clause.includes(UNRECONCILED_CLAUSE) || sentence.includes(UNRECONCILED_CLAUSE)) counts.unreconciledClause++;
  if (meta.includes(UNRECONCILED_META)) counts.unreconciledMeta++;
  if (badge === UNRECONCILED_READ_BADGE_LABEL) counts.unreconciledBadge++;
  if (bucket === "voids_the_reads_standing") {
    rows.push({ vendor: offer.vendor, tier: offer.tier, reason: held.reason, refused: held.refused_date, readAgain: held.read_again_on, clause, meta, badge });
  }
}

console.log("offers:", offers.length);
console.log("records holding a withholding refused read:", [...byReason.values()].reduce((a, b) => a + b, 0));
for (const [k, v] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(5), k);

console.log("\nrecords carrying the unreconciled wording, by bucket");
for (const [name, counts] of [...buckets.entries()].sort()) {
  console.log(`  ${name}: ${counts.records} records, clause ${counts.unreconciledClause}, meta ${counts.unreconciledMeta}, badge ${counts.unreconciledBadge}`);
}

const badges = new Map();
for (const r of rows) badges.set(r.badge, (badges.get(r.badge) ?? 0) + 1);
console.log("\nvoiding records, distinct vendors:", new Set(rows.map(r => r.vendor)).size, "records:", rows.length);
for (const [label, count] of [...badges.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(4)} ${label}`);
for (const r of rows.slice(0, 12)) console.log(`  ${r.vendor} [${r.tier}] ${r.reason} refused ${r.refused} readAgain ${r.readAgain}\n     ${r.clause}\n     meta: ${r.meta}`);

import { loadOffers, changesByVendor, loadChangeRefusals } from "../dist/data.js";
import { refusalsByVendor, refusalVoidsTheReadsStanding, refusalMeasuredNoDifference, refusedReadClause } from "../dist/change-refusal.js";
import { offerVerdictInput } from "../dist/vendor-verdict-input.js";
import { refusedReadWeHold } from "../dist/vendor-verdict.js";

const servedOn = process.env.CENSUS_DAY ?? new Date().toISOString().slice(0, 10);

const offers = loadOffers();
const changeLog = changesByVendor();
const refusalLog = refusalsByVendor(loadChangeRefusals());

const changesFor = v => changeLog.get(v.toLowerCase()) ?? [];
const refusalsFor = v => refusalLog.get(v.toLowerCase()) ?? [];

const byReason = new Map();
const rows = [];

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
  if (bucket === "voids_the_reads_standing") {
    rows.push({ vendor: offer.vendor, tier: offer.tier, reason: held.reason, refused: held.refused_date, readAgain: held.read_again_on, clause: refusedReadClause(held) });
  }
}

console.log("offers:", offers.length);
console.log("records holding a withholding refused read:", [...byReason.values()].reduce((a, b) => a + b, 0));
for (const [k, v] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(5), k);
console.log("\nvoiding records, distinct vendors:", new Set(rows.map(r => r.vendor)).size, "records:", rows.length);
for (const r of rows.slice(0, 12)) console.log(`  ${r.vendor} [${r.tier}] ${r.reason} refused ${r.refused} readAgain ${r.readAgain}\n     ${r.clause}`);

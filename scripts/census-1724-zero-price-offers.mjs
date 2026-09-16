import { changesByVendor, loadOffers, refusalsForVendor } from "../dist/data.js";
import { vendorVerdictContextFrom } from "../dist/vendor-verdict-input.js";
import { freeTierClaim } from "../dist/vendor-verdict.js";
import { supersedingChange } from "../dist/superseded-description.js";
import { tierRecordsAFreeTier } from "../dist/free-tier-record.js";
import { utcDate } from "../dist/ranking.js";

const servedOn = utcDate();
const offers = loadOffers();
const byVendor = changesByVendor();

function contextFor(offer) {
  return vendorVerdictContextFrom({
    vendor: offer.vendor,
    vendorOffers: [offer],
    vendorChanges: byVendor.get(offer.vendor.toLowerCase()) ?? [],
    refusedReads: refusalsForVendor(offer.vendor),
    servedOn,
  });
}

const rows = offers.map(offer => {
  const changes = byVendor.get(offer.vendor.toLowerCase()) ?? [];
  const context = contextFor(offer);
  const claim = context ? freeTierClaim(context.input) : null;
  return {
    vendor: offer.vendor,
    tier: offer.tier,
    description: offer.description,
    superseded: supersedingChange(offer, changes) !== null,
    gate: context?.gate?.code ?? null,
    states: claim?.states ?? "no-context",
    how: claim?.how ?? null,
    tierReadsFree: tierRecordsAFreeTier(offer.tier),
  };
});

function tally(name, fn) {
  const counts = new Map();
  for (const row of rows) {
    const key = String(fn(row));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  console.log(`\n## ${name}`);
  for (const [key, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${key.padEnd(30)} ${n}`);
}

console.log(`catalogue: ${rows.length} offers, served ${servedOn}`);
tally("supersedingChange fires", r => r.superseded);
tally("gate", r => r.gate);
tally("freeTierClaim.states", r => r.states + (r.how ? `/${r.how}` : ""));
tally("tierRecordsAFreeTier", r => r.tierReadsFree);

const publishesToday = rows;
const underClaimOffered = rows.filter(r => r.states === "offered");
const underProposed = rows.filter(r => r.states === "offered" && !r.superseded && r.tierReadsFree);

console.log(`\n## what each predicate would publish a price "0" Offer for`);
console.log(`  today, the 21 unguarded call sites          ${publishesToday.length}`);
console.log(`  not superseded (AC-1 as written)            ${rows.filter(r => !r.superseded).length}`);
console.log(`  not superseded and not gated (vendor rule)  ${rows.filter(r => !r.superseded && !r.gate).length}`);
console.log(`  freeTierClaim offered                       ${underClaimOffered.length}`);
console.log(`  offered + terms published                   ${rows.filter(r => r.states === "offered" && !r.superseded).length}`);
console.log(`  offered + terms published + tier reads free ${underProposed.length}`);

const candidate = rows.filter(r => r.states === "offered" && !r.superseded);

console.log(`\n## the rule this ships — /compare's, chosen by #1394 for this exact field`);
console.log(`  we publish an affirmative free-tier claim   ${underClaimOffered.length}`);
console.log(`  ... and we publish our stored terms         ${candidate.length}`);
console.log(`  rejected extra condition, tier reads free   ${candidate.filter(r => !r.tierReadsFree).length} it would additionally drop`);
for (const r of candidate.filter(r => !r.tierReadsFree)) {
  console.log(`    - ${r.vendor} | ${r.tier}`);
}

console.log(`\n## AC-4: the gate half, on the 21 unguarded call sites`);
const gated = rows.filter(r => r.gate);
console.log(`  gated offers publishing price "0" on a listing today  ${gated.length}`);
console.log(`  ... of which also superseded (AC-1 would catch)       ${gated.filter(r => r.superseded).length}`);
console.log(`  ... of which AC-1 as written would still price at 0   ${gated.filter(r => !r.superseded).length}`);

console.log(`\n## the hole that survives on /vendor/* too — we say the tier ended and nothing withholds`);
const endedSet = rows.filter(r => r.states === "ended");
const endedUnguarded = endedSet.filter(r => !r.superseded && !r.gate);
console.log(`  we publish "the free tier ended"                      ${endedSet.length}`);
console.log(`  ... withheld by the superseded rule                   ${endedSet.filter(r => r.superseded).length}`);
console.log(`  ... withheld by a gate                                ${endedSet.filter(r => !r.superseded && r.gate).length}`);
console.log(`  ... neither, so /vendor/* prices them at zero today   ${endedUnguarded.length}`);
for (const r of endedUnguarded) {
  console.log(`  - ${r.vendor} | ${r.tier} | ${r.how} | ${(r.description ?? "").slice(0, 130).replace(/\s+/g, " ")}`);
}

const ENDED_READING = /\b(no longer (available|listed|offered|free)|discontinued|being discontinued|sunset|has (been )?retired|has ended|was (removed|retired)|is no longer|now a [\d]+-day (free )?trial|free trial only|shut down|read-only snapshot)\b/i;
const stillPriced = candidate.filter(r => ENDED_READING.test(r.description ?? ""));
console.log(`\n## AC-5 residual: nodes the candidate rule still prices at zero whose own stored terms say the tier ended`);
console.log(`  ${stillPriced.length} of ${candidate.length}`);
for (const r of stillPriced) {
  console.log(`  - ${r.vendor} | ${r.tier} | ${(r.description ?? "").slice(0, 190).replace(/\s+/g, " ")}`);
}

console.log(`\n## what the candidate rule still prices at zero while withholding the rating`);
console.log(`  unconfirmed rating, Offer still published   ${candidate.filter(r => r.states === "unconfirmed").length}`);
console.log(`  affirmative claim, Offer published          ${candidate.filter(r => r.states === "offered").length}`);

const named = ["Brave Search API", "odrive", "Applitools Eyes", "logflare.app", "bonsai.io", "Turbopuffer", "Pagure.io", "Segment", "MiniMax", "Webvizio", "AWS App Runner", "Firebase Studio", "Mintlify", "Semgrep"];
console.log(`\n## the records named on the issue`);
for (const name of named) {
  const found = rows.filter(r => r.vendor.toLowerCase().includes(name.toLowerCase()));
  for (const r of found) {
    console.log(`  ${r.vendor} | tier=${r.tier} | superseded=${r.superseded} | gate=${r.gate} | states=${r.states}${r.how ? "/" + r.how : ""} | tierReadsFree=${r.tierReadsFree}`);
  }
  if (found.length === 0) console.log(`  ${name} | NOT IN CATALOGUE`);
}

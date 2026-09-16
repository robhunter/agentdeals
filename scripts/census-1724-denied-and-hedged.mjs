import { changesByVendor, loadOffers, refusalsForVendor } from "../dist/data.js";
import { vendorVerdictContextFrom } from "../dist/vendor-verdict-input.js";
import { freeTierClaim, unconfirmedTermsSentence, whyWeCannotConfirmTheseTerms } from "../dist/vendor-verdict.js";
import { supersedingChange } from "../dist/superseded-description.js";
import { DENIES_A_FREE_TIER, descriptionDeniesAFreeTier, sentenceOffersSomethingFree } from "../dist/free-tier-record.js";
import { sentencesOf } from "../dist/superseding-reading.js";
import { utcDate } from "../dist/ranking.js";

const servedOn = utcDate();
const offers = loadOffers();
const byVendor = changesByVendor();

const rows = offers.map(offer => {
  const changes = byVendor.get(offer.vendor.toLowerCase()) ?? [];
  const context = vendorVerdictContextFrom({
    vendor: offer.vendor,
    vendorOffers: [offer],
    vendorChanges: changes,
    refusedReads: refusalsForVendor(offer.vendor),
    servedOn,
  });
  const claim = context ? freeTierClaim(context.input) : null;
  const superseded = supersedingChange(offer, changes) !== null;
  const denied = descriptionDeniesAFreeTier(offer.description ?? "");
  return {
    vendor: offer.vendor,
    tier: offer.tier,
    description: offer.description ?? "",
    denied,
    superseded,
    gate: context?.gate?.code ?? null,
    states: claim?.states ?? "no-context",
    unconfirmed: context && !superseded ? whyWeCannotConfirmTheseTerms(context.input) : null,
    heldBack: context === null || claim.states === "ended" || context.gate !== null || superseded,
  };
});

const priced = rows.filter(r => !r.heldBack && !r.denied);
console.log(`offers ${rows.length}`);
console.log(`priced at zero under the shipped rule: ${rows.filter(r => !r.heldBack).length}`);
console.log(`priced at zero once a denied description is read: ${priced.length}`);

const denied = rows.filter(r => r.denied);
console.log(`\nstored descriptions that deny a free tier: ${denied.length}`);
for (const r of denied) {
  const why = r.heldBack ? `already held back [${r.gate ?? r.states}${r.superseded ? " superseded" : ""}]` : "PRICED TODAY";
  console.log(`  ${r.vendor} | ${JSON.stringify(r.tier)} | ${why} | "${DENIES_A_FREE_TIER.exec(r.description)[0]}"`);
}

const rescued = rows.filter(r => !r.denied && sentencesOf(r.description).some(s => DENIES_A_FREE_TIER.test(s.text)));
console.log(`\ndescriptions holding a denial that another sentence answers: ${rescued.length}`);
for (const r of rescued) {
  const denying = new Set(sentencesOf(r.description).filter(s => DENIES_A_FREE_TIER.test(s.text)).map(s => s.at));
  const offering = sentencesOf(r.description).find(s => !denying.has(s.at) && sentenceOffersSomethingFree(s.text));
  console.log(`  ${r.vendor} | ${JSON.stringify(r.tier)} | ${r.heldBack ? "held back" : "priced"} | "${offering.text.trim().slice(0, 90)}"`);
}

const hedged = priced.filter(r => r.unconfirmed !== null);
console.log(`\npriced offers whose description carries the reason we cannot confirm: ${hedged.length} of ${priced.length}`);
const byReason = new Map();
for (const r of hedged) byReason.set(r.unconfirmed.because.reason, (byReason.get(r.unconfirmed.because.reason) ?? 0) + 1);
for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`  ${reason.padEnd(30)} ${n}`);
for (const r of hedged.slice(0, 3)) console.log(`  e.g. ${r.vendor} [${r.tier}] — ${unconfirmedTermsSentence(r.unconfirmed)}`);

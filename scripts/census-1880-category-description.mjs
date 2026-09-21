import { writeFileSync } from "node:fs";
import { loadOffers, getCategories, changesByVendor, loadChangeRefusals, NOTHING_CONTRADICTS_OUR_TERMS_FOR } from "../dist/data.js";
import { refusalsByVendor } from "../dist/change-refusal.js";
import { vendorVerdictContextFrom, offerVerdictInput } from "../dist/vendor-verdict-input.js";
import { freeTierClaim, whyWeCannotConfirmTheseTerms, theReadConfirmedThePrice, termsWithheldLabel } from "../dist/vendor-verdict.js";
import { readThatContradictsOurTerms } from "../dist/read-date.js";
import { supersedingChange } from "../dist/superseded-description.js";
import { offerEnded } from "../dist/retirement.js";
import { toSlug } from "../dist/slug.js";

const servedOn = process.env.CENSUS_DAY ?? new Date().toISOString().slice(0, 10);

const offers = loadOffers();
const categories = getCategories();
const changeLog = changesByVendor();
const refusalLog = refusalsByVendor(loadChangeRefusals());

const changesFor = v => changeLog.get(v.toLowerCase()) ?? [];
const refusalsFor = v => refusalLog.get(v.toLowerCase()) ?? [];

const contextCache = new Map();
function contextFor(vendor) {
  if (!contextCache.has(vendor)) {
    contextCache.set(vendor, vendorVerdictContextFrom({
      vendor,
      vendorOffers: offers.filter(o => o.vendor === vendor),
      vendorChanges: changesFor(vendor),
      refusedReads: refusalsFor(vendor),
      servedOn,
    }));
  }
  return contextCache.get(vendor);
}

const claimEnded = vendor => freeTierClaim(contextFor(vendor)?.input ?? null)?.states === "ended";

function unconfirmedFor(offer) {
  const input = offerVerdictInput({
    vendor: offer.vendor,
    offer,
    vendorChanges: changesFor(offer.vendor),
    refusedReads: refusalsFor(offer.vendor),
    servedOn,
  });
  return input ? whyWeCannotConfirmTheseTerms(input) : null;
}

const supersededFor = offer => supersedingChange(offer, changesFor(offer.vendor));

function classify(offer) {
  const superseded = supersededFor(offer);
  if (superseded) return { bucket: "superseded", tag: "superseded" };
  const unconfirmed = unconfirmedFor(offer);
  if (unconfirmed) {
    const confirms = theReadConfirmedThePrice(unconfirmed);
    return {
      bucket: confirms ? "read_confirms_price" : "unconfirmed",
      tag: unconfirmed.because.reason,
      label: termsWithheldLabel(unconfirmed),
      alsoContradicted: confirms && !offerEnded(offer) && readThatContradictsOurTerms(offer) !== null,
    };
  }
  const speaksForItself = offerEnded(offer) || Boolean(superseded);
  const contradicting = speaksForItself ? null : readThatContradictsOurTerms(offer);
  if (contradicting) return { bucket: "read_contradicts", tag: "read_contradicts" };
  return { bucket: "verified", tag: "verified" };
}

const rows = [];
const perCategory = [];

for (const category of categories) {
  const name = category.name;
  const catOffers = offers.filter(o => o.category === name);
  const standing = catOffers.filter(o => !claimEnded(o.vendor));
  const classified = standing.map(o => ({ offer: o, ...classify(o) }));

  const cannotConfirm = classified.filter(c => c.bucket !== "superseded" && c.bucket !== "verified");
  const uncontradicted = classified.filter(c => c.bucket === "verified");
  const confirmsPrice = classified.filter(c => c.bucket === "read_confirms_price");

  const vendorList = uncontradicted.length === 0
    ? ""
    : ` ${NOTHING_CONTRADICTS_OUR_TERMS_FOR} ${uncontradicted.slice(0, 5).map(c => c.offer.vendor).join(", ")}${uncontradicted.length > 5 ? " and more" : ""}.`;

  for (const c of classified) {
    rows.push({ category: name, vendor: c.offer.vendor, tier: c.offer.tier, bucket: c.bucket, tag: c.tag, alsoContradicted: Boolean(c.alsoContradicted) });
  }

  perCategory.push({
    slug: toSlug(name),
    name,
    offers: catOffers.length,
    standing: standing.length,
    cannotConfirm: cannotConfirm.length,
    uncontradicted: uncontradicted.length,
    confirmsPrice: confirmsPrice.length,
    confirmsPriceAlsoContradicted: confirmsPrice.filter(c => c.alsoContradicted).length,
    vendorListChars: vendorList.length,
  });
}

const byTag = new Map();
for (const r of rows) {
  if (r.bucket === "superseded" || r.bucket === "verified") continue;
  byTag.set(r.tag, (byTag.get(r.tag) ?? 0) + 1);
}

const totalCannotConfirm = perCategory.reduce((n, c) => n + c.cannotConfirm, 0);
const totalStanding = perCategory.reduce((n, c) => n + c.standing, 0);
const totalConfirmsPrice = perCategory.reduce((n, c) => n + c.confirmsPrice, 0);

console.log(`served on ${servedOn}`);
console.log(`categories ${perCategory.length}  standing ${totalStanding}  cannot-confirm ${totalCannotConfirm}`);
console.log(`read confirms the price: ${totalConfirmsPrice} rows across ${new Set(rows.filter(r => r.bucket === "read_confirms_price").map(r => r.category)).size} categories`);
console.log("");
console.log("reason tally over the counted rows:");
for (const [tag, n] of [...byTag].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${tag}`);
console.log("");
console.log(`categories publishing an unconfirmed majority: ${perCategory.filter(c => c.cannotConfirm * 2 > c.standing).length}`);
console.log(`categories with a vendor list: ${perCategory.filter(c => c.uncontradicted > 0).length}`);
console.log("");
console.log("largest by count:");
for (const c of [...perCategory].sort((a, b) => b.cannotConfirm - a.cannotConfirm).slice(0, 6)) {
  console.log(`  ${c.slug}: ${c.cannotConfirm} of ${c.standing} (confirms-price ${c.confirmsPrice})`);
}

writeFileSync(
  process.env.CENSUS_OUT ?? "/tmp/census-1880.json",
  JSON.stringify({ servedOn, perCategory, rows, byTag: Object.fromEntries(byTag) }, null, 2),
);

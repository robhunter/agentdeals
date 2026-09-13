import { writeSync } from "node:fs";
import { refusedReadTheConfirmationSupersedes, REFUSAL_REASONS_THAT_CONFIRM_THE_STORED_TERMS, REFUSAL_REASONS_THAT_MEASURED_NO_DIFFERENCE } from "../dist/change-refusal.js";
import { enrichOffers, loadChangeRefusals, loadDealChanges, loadOffers } from "../dist/data.js";
import { LEVEL_WITHHOLDING_OUTCOMES } from "../dist/source-check.js";
import { offerEnded } from "../dist/retirement.js";
import { vendorSlugMap } from "../dist/vendor-slug.js";
import { readingDescribesNoNarrowing, narrowsTheStoredTerms } from "../dist/change-direction.js";
import { storedTermsAreSuperseded } from "../dist/superseded-description.js";

const say = (line) => writeSync(2, `${line}\n`);

const CONFIRMING = new Set(REFUSAL_REASONS_THAT_CONFIRM_THE_STORED_TERMS);
const MEASURED_NO_DIFFERENCE = new Set(REFUSAL_REASONS_THAT_MEASURED_NO_DIFFERENCE);

const refusals = loadChangeRefusals();
const changes = loadDealChanges();
const offers = loadOffers();

const published = new Map();
for (const change of changes) {
  const key = change.vendor.toLowerCase();
  published.set(key, (published.get(key) ?? 0) + 1);
}
const held = new Map();
for (const refusal of refusals) {
  const key = refusal.vendor.toLowerCase();
  held.set(key, [...(held.get(key) ?? []), refusal.reason]);
}

const rowFor = new Map();
for (const row of enrichOffers(offers)) if (!rowFor.has(row.vendor)) rowFor.set(row.vendor, row);

const subjects = [...vendorSlugMap.entries()].map(([slug, vendor]) => {
  const reasons = held.get(vendor.toLowerCase()) ?? [];
  const count = published.get(vendor.toLowerCase()) ?? 0;
  const row = rowFor.get(vendor);
  const refusedRead = row?.refused_read ?? null;
  const unreconciled = refusedRead !== null;
  const otherwiseWithheld = Boolean(
    row?.gate || row?.rating_withheld || row?.link_unreachable
    || (row?.source_check && row.source_check.outcome !== "ok"),
  );
  return {
    slug,
    vendor,
    reasons,
    published: count,
    refusedRead,
    gated: Boolean(row?.gate),
    supersededRefusal: refusedRead === null && count === 0
      ? refusedReadTheConfirmationSupersedes(
        refusals.filter(r => r.vendor.toLowerCase() === vendor.toLowerCase()),
        row?.verifiedDate ?? "",
      )
      : null,
    unreconciled,
    measuredNoDifference: refusedRead !== null && MEASURED_NO_DIFFERENCE.has(refusedRead.reason),
    onlyTheRefusal: unreconciled && !otherwiseWithheld,
    otherwiseWithheld,
    confirmingOnly: count === 0 && reasons.length > 0 && reasons.every(r => CONFIRMING.has(r)),
    rated: row?.risk_level ?? null,
    ended: offerEnded(row),
    withheldBySourceCheck: Boolean(
      row?.link_unreachable
      || (row?.source_check && LEVEL_WITHHOLDING_OUTCOMES.includes(row.source_check.outcome)),
    ),
  };
});

const show = (label, list, named) => {
  const slugs = list.map(s => s.slug ?? s);
  say(`${label}: ${slugs.length}`);
  say(`  ${slugs.slice(0, 24).join(", ")}${slugs.length > 24 ? ", …" : ""}`);
  if (named) {
    const missing = named.filter(n => !slugs.includes(n));
    say(`  named controls absent: ${missing.length === 0 ? "none" : missing.join(", ")}`);
  }
};

show("confirmingOnly", subjects.filter(s => s.confirmingOnly), ["activepieces", "assemblyai"]);
show("confirmingOnly && !otherwiseWithheld", subjects.filter(s => s.confirmingOnly && !s.otherwiseWithheld), ["activepieces", "assemblyai"]);
show("published>0 && no refusal", subjects.filter(s => s.reasons.length === 0 && s.published > 0), ["dub-co"]);
show("published>0 && no refusal && !otherwiseWithheld", subjects.filter(s => s.reasons.length === 0 && s.published > 0 && !s.otherwiseWithheld), ["dub-co"]);
show("measuredNoDifference", subjects.filter(s => s.measuredNoDifference), ["pagertree-com", "cloudflare-workers", "aiven", "uptimerobot"]);
show("onlyTheRefusal && measuredNoDifference", subjects.filter(s => s.onlyTheRefusal && s.measuredNoDifference), ["pagertree-com", "cloudflare-workers", "aiven", "uptimerobot"]);
show("onlyTheRefusal && !measuredNoDifference", subjects.filter(s => s.onlyTheRefusal && !s.measuredNoDifference), ["pubnub-com", "typeform-com", "lokalise"]);
show("unreconciled && !measuredNoDifference", subjects.filter(s => s.unreconciled && !s.measuredNoDifference), ["pubnub-com", "typeform-com", "lokalise"]);
show("supersededRefusal && !gated", subjects.filter(s => s.supersededRefusal && !s.gated), ["doczilla", "tavily-ai"]);
show("rated stable && published 0", subjects.filter(s => s.rated === "stable" && s.published === 0), ["ahasend", "appsmith", "browserless"]);

say("");
say(`refusals with reason removal_read_from_root: ${refusals.filter(r => r.reason === "removal_read_from_root").length} — ${[...new Set(refusals.filter(r => r.reason === "removal_read_from_root").map(r => r.vendor))].join(", ")}`);
const removalRefused = refusals.filter(r => r.change_type === "free_tier_removed");
say(`refusals whose refused record was free_tier_removed: ${removalRefused.length} — ${[...new Set(removalRefused.map(r => r.vendor))].slice(0, 30).join(", ")}`);
const stillOffered = refusals.filter(r => r.reason === "free_tier_still_offered");
say(`refusals with reason free_tier_still_offered: ${stillOffered.length} — ${[...new Set(stillOffered.map(r => r.vendor))].slice(0, 30).join(", ")}`);

say("");
const byVendor = new Map();
for (const c of changes) {
  const key = c.vendor.toLowerCase();
  byVendor.set(key, [...(byVendor.get(key) ?? []), c]);
}
const changesFor = (vendor) => byVendor.get(vendor.toLowerCase()) ?? [];
const offerFor = (vendor) => offers.find(o => o.vendor.toLowerCase() === vendor.toLowerCase());

const readsAsNoNarrowing = [...new Set(changes.filter(readingDescribesNoNarrowing).map(c => c.vendor))];
say(`vendors holding a record whose reading describes no narrowing: ${readsAsNoNarrowing.length}`);
const clean = readsAsNoNarrowing.filter(v => {
  const own = changesFor(v);
  return !own.some(c => narrowsTheStoredTerms(c.change_type) && !readingDescribesNoNarrowing(c));
});
say(`  …and holding no other narrowing record: ${clean.length}`);
say(`  ${clean.join(", ")}`);
const named1528 = ["Buildkite", "PromoProxy", "Vercel", "Railway", "Figma", "Grafana Cloud", "geocodify.com", "LastPass", "veriphone", "paperspace", "readthedocs.org", "Oracle Cloud"];
say(`  named controls absent from that set: ${named1528.filter(v => !clean.some(c => c.toLowerCase() === v.toLowerCase())).join(", ") || "none"}`);
const inCatalogue = clean.filter(v => offerFor(v));
say(`  …and in the catalogue: ${inCatalogue.length}`);
const superseded = inCatalogue.filter(v => storedTermsAreSuperseded(offerFor(v), changesFor(v)));
say(`  …whose stored terms are nonetheless superseded: ${superseded.length} — ${superseded.join(", ") || "none"}`);

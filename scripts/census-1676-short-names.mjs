import { readFileSync, writeFileSync } from "node:fs";
import { findVendor, loadOffers } from "../dist/data.js";
import { resolveVendorSlug, vendorSlugMap } from "../dist/vendor-slug.js";
import { toSlug } from "../dist/slug.js";
import { offerRetired } from "../dist/retirement.js";

const offers = loadOffers();
const byName = new Map(offers.map(o => [o.vendor.toLowerCase(), o]));
const liveNames = new Set(offers.map(o => o.vendor.toLowerCase()));

function properPrefixes(name) {
  const tokens = name.split(/\s+/).filter(Boolean);
  const out = [];
  for (let n = 1; n < tokens.length; n++) out.push(tokens.slice(0, n).join(" "));
  return out;
}

const shortNames = new Set();
for (const o of offers) {
  for (const prefix of properPrefixes(o.vendor)) {
    if (liveNames.has(prefix.toLowerCase())) continue;
    shortNames.add(prefix);
  }
}

const rows = [];
for (const name of [...shortNames].sort()) {
  const slug = toSlug(name);
  const slugResolution = resolveVendorSlug(slug);
  const slugTarget =
    slugResolution.type === "exact" || slugResolution.type === "redirect"
      ? vendorSlugMap.get(slugResolution.slug) ?? null
      : null;

  const match = findVendor(offers, name);
  const matchTarget = match.type === "none" ? null : match.offer.vendor;

  const slugRecord = slugTarget ? byName.get(slugTarget.toLowerCase()) : undefined;
  const matchRecord = matchTarget ? byName.get(matchTarget.toLowerCase()) : undefined;

  rows.push({
    name,
    slug,
    slug_door: { type: slugResolution.type, target: slugTarget, tier: slugRecord?.tier ?? null, ended: slugRecord ? offerRetired(slugRecord) : null },
    match_door: { type: match.type, target: matchTarget, tier: matchRecord?.tier ?? null, ended: matchRecord ? offerRetired(matchRecord) : null },
    agrees: slugTarget === matchTarget,
  });
}

const slugResolves = rows.filter(r => r.slug_door.target);
const matchResolves = rows.filter(r => r.match_door.target);
const disagree = rows.filter(r => !r.agrees);
const bothAnswerDifferently = disagree.filter(r => r.slug_door.target && r.match_door.target);
const slugLandsEnded = slugResolves.filter(r => r.slug_door.ended);
const matchLandsEnded = matchResolves.filter(r => r.match_door.ended);

const summary = {
  offers: offers.length,
  short_names: rows.length,
  slug_door_resolves: slugResolves.length,
  slug_door_redirects: rows.filter(r => r.slug_door.type === "redirect").length,
  slug_door_disambiguates: rows.filter(r => r.slug_door.type === "disambiguate").length,
  slug_door_none: rows.filter(r => r.slug_door.type === "none").length,
  match_door_resolves: matchResolves.length,
  match_door_none: rows.filter(r => r.match_door.type === "none").length,
  disagree: disagree.length,
  both_answer_different_vendors: bothAnswerDifferently.length,
  slug_door_lands_on_ended: slugLandsEnded.length,
  match_door_lands_on_ended: matchLandsEnded.length,
};

console.log(JSON.stringify(summary, null, 2));
console.log("\n--- slug door lands on an ended record ---");
for (const r of slugLandsEnded) {
  console.log(`${r.name.padEnd(34)} -> ${String(r.slug_door.target).padEnd(38)} [${r.slug_door.tier}]  match_door=${r.match_door.target ?? "REFUSED"}`);
}
console.log("\n--- both doors answer, different vendors ---");
for (const r of bothAnswerDifferently) {
  console.log(`${r.name.padEnd(34)} slug=${String(r.slug_door.target).padEnd(30)} match=${r.match_door.target}`);
}
console.log("\n--- match door lands on an ended record ---");
for (const r of matchLandsEnded) {
  console.log(`${r.name.padEnd(34)} -> ${r.match_door.target} [${r.match_door.tier}] (${r.match_door.type})`);
}

const out = process.argv[2];
if (out) {
  writeFileSync(out, JSON.stringify({ summary, rows }, null, 2));
  console.log(`\nwrote ${out}`);
}

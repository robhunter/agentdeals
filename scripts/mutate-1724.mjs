import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/zero-price-offer.test.ts",
  "test/offer-price-validity.test.ts",
  "test/superseded-terms-listings.test.ts",
  "test/gated-vendor-answers.test.ts",
  "test/retired-records.test.ts",
];

const PREDICATE = `  const standing = standingOf(offer);
  return standing !== null
    && standing.claim.states !== "ended"
    && standing.gate === null
    && supersedingChangeFor(offer) === null;`;

const MUTANTS = [
  ["every-node-is-priced-at-zero", "src/serve.ts", PREDICATE,
    "  return true;"],

  ["the-superseded-half-is-dropped", "src/serve.ts", PREDICATE,
    '  const standing = standingOf(offer);\n  return standing !== null && standing.claim.states !== "ended" && standing.gate === null;'],

  ["the-gate-half-is-dropped", "src/serve.ts", PREDICATE,
    '  const standing = standingOf(offer);\n  return standing !== null && standing.claim.states !== "ended" && supersedingChangeFor(offer) === null;'],

  ["an-offer-we-say-has-ended-is-priced-at-zero", "src/serve.ts", PREDICATE,
    "  const standing = standingOf(offer);\n  return standing !== null && standing.gate === null && supersedingChangeFor(offer) === null;"],

  ["a-vendor-we-hold-no-record-for-is-priced-at-zero", "src/serve.ts", PREDICATE,
    '  const standing = standingOf(offer);\n  return (standing === null || (standing.claim.states !== "ended" && standing.gate === null)) && supersedingChangeFor(offer) === null;'],

  ["the-standing-is-read-for-the-vendor-rather-than-the-offer", "src/serve.ts",
    "    vendorOffers: [offer],\n    vendorChanges: changesFor(offer.vendor),\n    refusedReads: refusalsFor(offer.vendor),\n    servedOn,\n  });\n  const standing = context",
    "    vendorOffers: offers.filter(o => o.vendor === offer.vendor),\n    vendorChanges: changesFor(offer.vendor),\n    refusedReads: refusalsFor(offer.vendor),\n    servedOn,\n  });\n  const standing = context"],

  ["the-standing-is-cached-across-days", "src/serve.ts",
    "  const cached = standingsByOffer.get(key);\n  if (cached && cached.on === servedOn) return cached.standing;",
    "  const cached = standingsByOffer.get(key);\n  if (cached) return cached.standing;"],

  ["the-cache-key-forgets-the-tier", "src/serve.ts",
    "  const key = `${offer.vendor}|${offer.url}|${offer.tier}`;\n  const cached = standingsByOffer.get(key);",
    "  const key = offer.vendor;\n  const cached = standingsByOffer.get(key);"],

  ["the-node-prices-a-tier-it-does-not-list", "src/serve.ts",
    '      description: offer.tier,\n      ...(heldUntil ? { priceValidUntil: heldUntil } : {}),',
    '      description: "Free",\n      ...(heldUntil ? { priceValidUntil: heldUntil } : {}),'],

  ["the-price-is-dated-from-a-change-that-has-passed", "src/change-dates.ts",
    "    if (!c.date || c.date <= onDate) continue;",
    "    if (!c.date) continue;"],

  ["a-deprecation-of-a-separate-product-dates-the-offer", "src/change-dates.ts",
    "  if (change.change_type !== PRODUCT_DEPRECATED) return true;\n  return deprecationEndsTheListedProduct(change);",
    "  return true;"],

  ["a-comparison-page-takes-the-looser-rule", "src/serve.ts",
    '          ...(free.states === "offered" ? freeTierOfferJsonLd(v) : {}),',
    "          ...freeTierOfferJsonLd(v),"],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8", env: { ...process.env, TZ: "UTC" } });
    return true;
  } catch {
    return false;
  }
}

const survivors = [];
const uncompiled = [];
const skipped = [];
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  if (!original.includes(from)) {
    console.log(`SKIP  ${name} — the line it mutates is not in ${file}`);
    skipped.push(name);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const built = run("npm", ["run", "build"]);
  const green = built && run("node", ["--test", "--test-concurrency", "1", ...SUITE]);
  writeFileSync(file, original);
  if (!built) uncompiled.push(name);
  console.log(`${green ? "SURVIVED" : built ? "killed  " : "DID NOT COMPILE"}  ${name}`);
  if (green) survivors.push(name);
}
run("npm", ["run", "build"]);
const killed = MUTANTS.length - survivors.length - uncompiled.length - skipped.length;
console.log(`\n${killed}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (uncompiled.length > 0) console.log("did not compile:", uncompiled.join(", "));
if (skipped.length > 0) console.log("skipped — target string moved, so these scored nothing:", skipped.join(", "));

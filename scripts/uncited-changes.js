import { loadDealChanges, loadOffers, demotionWithheldInForce } from "../dist/data.js";
import { uncitedChangesAgainstBudget } from "../dist/change-reporting.js";

const HELP = `List the change records that cite no source, so they can be cited or retracted.

A record with an empty source_url sets no risk level, no stability class and no schema.org
Event — the rating it would have set is withheld instead. This lists what is waiting on a
citation, and for each one whether our own offer record was verified after the record's date,
which is the cheapest way to see that a removal is contradicted by newer data of our own.

A record that reports our own index is not waiting on anything — it is required to carry no
source_url, because no vendor page evidences a change the vendor did not make. Those are left
out of this list and out of the budget it is triage for.

Usage: node scripts/uncited-changes.js [options]

  --withheld      Only the records whose rating is being withheld
  --vendor <name> Only this vendor
  --json          Emit as JSON
  --help          This text
`;

function parseArgs(argv) {
  const opts = { withheld: false, vendor: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    else if (arg === "--withheld") opts.withheld = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--vendor") opts.vendor = argv[++i];
    else {
      console.error(`Unknown argument: ${arg}`);
      return { help: true, invalid: true };
    }
  }
  return opts;
}

export function uncitedReport(changes, offers, nowMs = Date.now()) {
  const offerByVendor = new Map();
  for (const offer of offers) {
    const key = offer.vendor.toLowerCase();
    if (!offerByVendor.has(key)) offerByVendor.set(key, offer);
  }
  return uncitedChangesAgainstBudget(changes).map((change) => {
    const offer = offerByVendor.get(change.vendor.toLowerCase()) ?? null;
    const withheld = demotionWithheldInForce(change, nowMs);
    return {
      vendor: change.vendor,
      date: change.date,
      change_type: change.change_type,
      summary: change.summary,
      rating_withheld: withheld,
      verified_after: offer ? offer.verifiedDate > change.date : false,
      offer_verified: offer ? offer.verifiedDate : null,
      offer_tier: offer ? offer.tier : null,
      offer_description: offer ? offer.description : null,
    };
  }).sort((a, b) => (a.vendor.toLowerCase() < b.vendor.toLowerCase() ? -1 : 1));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    process.exit(opts.invalid ? 1 : 0);
  }

  let rows = uncitedReport(loadDealChanges(), loadOffers());
  if (opts.withheld) rows = rows.filter((r) => r.rating_withheld !== null);
  if (opts.vendor) {
    const wanted = opts.vendor.toLowerCase();
    rows = rows.filter((r) => r.vendor.toLowerCase() === wanted);
  }

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const contradicted = rows.filter((r) => r.rating_withheld && r.verified_after);
  console.log(`── Change records citing no source: ${rows.length} ──\n`);
  console.log(`${rows.filter((r) => r.rating_withheld).length} would set a risk level, withheld until cited.`);
  console.log(`${contradicted.length} of those name a vendor whose offer we verified after the record's own date.\n`);
  console.log("| vendor | date | type | withheld | offer verified | summary |");
  console.log("|---|---|---|---|---|---|");
  for (const r of rows) {
    const cells = [
      r.vendor,
      r.date,
      r.change_type,
      r.rating_withheld ?? "—",
      r.verified_after ? `${r.offer_verified} (after)` : r.offer_verified ?? "no offer",
      r.summary.replace(/\|/g, "\\|"),
    ];
    console.log(`| ${cells.join(" | ")} |`);
  }
  if (contradicted.length > 0) {
    console.log(`\n── Withheld, and our own offer record is newer ──\n`);
    for (const r of contradicted) {
      console.log(`${r.vendor} — record ${r.date}: ${r.summary}`);
      console.log(`  offer verified ${r.offer_verified}, tier "${r.offer_tier}": ${r.offer_description}\n`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();

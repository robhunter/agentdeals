import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = ["test/llm-api-readme.test.ts"];
const FILE = "src/llm-api-readme.ts";

const MUTANTS = [
  ["the-free-price-test-never-runs", FILE,
    "  if (namesAPriceOfNothing(terms.text)) return null;",
    "  if (terms.text) return null;"],

  ["the-free-price-test-runs-only-on-a-superseding-reading", FILE,
    "  if (namesAPriceOfNothing(terms.text)) return null;",
    "  if (!terms.quoted || namesAPriceOfNothing(terms.text)) return null;"],

  ["a-row-naming-no-free-price-is-left-out-rather-than-published", FILE,
    "    .map(offer => readmeRow(offer, changes, context));",
    "    .map(offer => readmeRow(offer, changes, context))\n    .filter(row => namesAPriceOfNothing(row.terms.text));"],

  ["a-recorded-removal-is-ignored", FILE,
    "  return changes.find(c => c.change_type === REMOVAL_CHANGE_TYPE) ?? null;",
    "  return null;"],

  ["any-recorded-change-counts-as-a-removal", FILE,
    "  return changes.find(c => c.change_type === REMOVAL_CHANGE_TYPE) ?? null;",
    "  return changes[0] ?? null;"],

  ["the-free-price-test-overrides-a-reason-already-published", FILE,
    "      : badge.kind === \"ended\"\n        ? { kind: \"ended\", sentence: endedVerdictSentence() }\n        : {\n            kind: \"withheld\",\n            reason: withheldReasonCode(badge.because),\n            sentence: withheldSentence(offer.vendor, badge.because, risk.gate, since),\n          };",
    "      : ratingOnTermsThatPriceNothingAtNothing(offer.vendor, terms, vendorChanges) ?? (badge.kind === \"ended\"\n        ? { kind: \"ended\", sentence: endedVerdictSentence() }\n        : {\n            kind: \"withheld\",\n            reason: withheldReasonCode(badge.because),\n            sentence: withheldSentence(offer.vendor, badge.because, risk.gate, since),\n          });"],

  ["the-file-states-a-count-it-did-not-take-from-the-rows", FILE,
    "  const unrated = census.withheldByReason[NO_FREE_PRICE_REASON] ?? 0;",
    "  const unrated: number = 3;"],

  ["a-withheld-record-publishes-its-history-level", FILE,
    "  return row.verdict.kind === \"ended\" ? RATING_LABELS.ended : RATING_LABELS.unrated;",
    "  return row.verdict.kind === \"ended\" ? RATING_LABELS.ended : \"stable\";"],

  ["a-gate-and-an-unread-page-report-the-same-reason", FILE,
    "  return because.reason === \"gated\" ? `gate:${because.gate}` : because.reason;",
    "  return because.reason;"],

  ["the-superseded-terms-are-published-as-current", FILE,
    "  const superseding = supersedingChange(offer, vendorChanges);",
    "  const superseding = null as ReturnType<typeof supersedingChange>;"],

  ["the-terms-a-record-replaced-are-not-shown", FILE,
    "      ? { text: superseding.previous_state!.trim(), until: superseding.date }\n      : null;",
    "      ? null\n      : null;"],

  ["our-own-record-is-published-as-a-quotation", FILE,
    "        quoted: false,",
    "        quoted: true,"],

  ["a-dead-link-keeps-its-verification-date", FILE,
    "      verifiedDate: risk.link_unreachable ? null : offer.verifiedDate,",
    "      verifiedDate: offer.verifiedDate,"],

  ["a-dead-link-dates-the-terms-anyway", FILE,
    "        as_of: risk.link_unreachable ? null : offer.verifiedDate,",
    "        as_of: offer.verifiedDate,"],

  ["a-record-we-have-not-re-read-says-nothing-about-it", FILE,
    "  if (!risk.link_unreachable && readingIsBehindTheLoop(offer.verifiedDate, context.staleAfterDays, context.nowMs)) {",
    "  if (false && !risk.link_unreachable && readingIsBehindTheLoop(offer.verifiedDate, context.staleAfterDays, context.nowMs)) {"],

  ["the-order-carries-a-pick", FILE,
    "    .sort((a, b) => a.vendor.localeCompare(b.vendor, \"en\") || a.tier.localeCompare(b.tier, \"en\"))",
    "    .sort((a, b) => b.verifiedDate.localeCompare(a.verifiedDate))"],

  ["the-tier-rules-are-summarised-rather-than-published", FILE,
    "  const notFree = NOT_FREE_TIER_RULES.map(r => `- \\`${r.pattern.source}\\` — ${r.note}`).join(\"\\n\");",
    "  const notFree = NOT_FREE_TIER_RULES.slice(0, 2).map(r => `- \\`${r.pattern.source}\\` — ${r.note}`).join(\"\\n\");"],

  ["a-change-type-goes-unpublished", FILE,
    "      .filter(type => CHANGE_DIRECTION[type] === direction)",
    "      .filter(type => CHANGE_DIRECTION[type] === direction && type !== \"rebranded\")"],

  ["the-counts-are-taken-from-the-rows-that-are-easy-to-count", FILE,
    "    withheld: rows.filter(r => r.verdict.kind === \"withheld\").length,",
    "    withheld: rows.filter(r => r.verdict.kind === \"withheld\" && r.caveats.length === 0).length,"],

  ["a-row-stops-linking-to-the-record-behind-it", FILE,
    "  return `${link(row.vendor, `${BASE_URL}/vendor/${row.slug}`)}<br>${cell(row.tier)}`;",
    "  return `${cell(row.vendor)}<br>${cell(row.tier)}`;"],

  ["the-file-stamps-itself-with-one-date", FILE,
    "    README_ORDER_RULE,",
    "    `${README_ORDER_RULE} Last updated ${new Date().toISOString().slice(0, 10)}.`,"],

  ["a-cell-stops-escaping-what-the-catalogue-wrote", FILE,
    "  return text.replace(/\\s*\\n\\s*/g, \" \").replace(/\\|/g, \"\\\\|\").trim();",
    "  return text.replace(/\\s*\\n\\s*/g, \" \").trim();"],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8" });
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

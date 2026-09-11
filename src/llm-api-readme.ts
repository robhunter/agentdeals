import { BASE_URL } from "./base-url.js";
import { readingIsBehindTheLoop } from "./badge-staleness.js";
import { citationLabel, ratingWithheldForNoSourceSentence } from "./change-citation.js";

import { CHANGE_DIRECTION } from "./change-direction.js";
import { gateRiskSummary, publishedRisk } from "./data.js";
import { LINK_GRACE_DAYS } from "./link-health.js";
import {
  NOT_FREE_TIER_RULES,
  TIME_LIMITED_TIER_RULES,
  classifyTier,
  type Gate,
} from "./ranking.js";
import { endedVerdictSentence, offerEnded } from "./retirement.js";
import {
  levelWithheldReason,
  levelWithheldSince,
  withheldLevelSentence,
  type LevelWithheldReason,
} from "./source-check.js";
import { toSlug } from "./slug.js";
import { namesAPriceOfNothing } from "./superseding-reading.js";
import { subtypeDefinition } from "./product-role.js";
import { readingBehindTheChange, supersedingChange } from "./superseded-description.js";
import type { DealChange, LinkUnreachable, Offer } from "./types.js";
import {
  CHANGE_KIND_NOUN,
  refusedReadWithholdingSentence,
  withheldForARefusedRead,
  vendorBadge,
  vendorVerdictSentence,
  type BadgeWithholding,
  type PublishedRiskLevel,
  type VendorVerdictInput,
} from "./vendor-verdict.js";

export const README_CATEGORIES = ["AI / ML", "AI Coding"] as const;

export const README_TAXONOMY = "AI / ML";

export const README_SUBTYPES = ["llm_api", "model_gateway", "model_hosting", "embeddings_api"] as const;

export const CATALOGUE_REPO_URL = "https://github.com/robhunter/agentdeals";

export const CATALOGUE_ISSUES_URL = `${CATALOGUE_REPO_URL}/issues`;

export const README_GENERATOR_URL = `${CATALOGUE_REPO_URL}/blob/main/src/llm-api-readme.ts`;

export const README_TITLE = "Free tiers for AI and LLM APIs, with the date we read each one";

export const README_INCLUSION_RULE =
  "A record is published here when it carries one of four subtype labels, and by nothing else. A label is a "
  + "reading of the vendor's own page, stored on the record with the sentence it was read from, so what this file "
  + "holds is decided by the catalogue and not by a list kept here.";

export type ExclusionReason =
  | "not_read_against_subtypes"
  | "no_subtype_applies"
  | "another_function";

export const EXCLUSION_RULES: Record<ExclusionReason, string> = {
  not_read_against_subtypes:
    "We have not read this record against any subtype taxonomy, so we hold no basis for saying it serves models. "
    + "That states what we have not done rather than a finding about the product, and it stops applying the day the "
    + "record is classified.",
  no_subtype_applies:
    "We have read this record against the taxonomy and none of its subtypes applies, so it is not one of the kinds "
    + "of product those labels describe.",
  another_function:
    "The record is labelled, and every label it carries names a different function — observability, evaluation, "
    + "labelling, generation and the rest are not the serving of a model behind an API.",
};

export const NO_FREE_PRICE_REASON = "reading_names_no_price_of_nothing";

export const REMOVAL_CHANGE_TYPE = "free_tier_removed";

export const README_ORDER_RULE =
  "Rows are ordered alphabetically by vendor. That is not a ranking: we publish no best free LLM API, "
  + "and no position in this file is a recommendation.";

export const README_EDIT_WARNING =
  "It is regenerated whenever those records move, so editing it by hand is pointless — the next run overwrites it.";

export const README_GENERATOR_SENTENCE =
  `The code that writes it is ${README_GENERATOR_URL}, so every rule this file states can be read against the rule `
  + "it applies.";

export interface PublishedTerms {
  text: string;
  as_of: string | null;
  source_url: string;
  source_label: string;
  quoted: boolean;
}

export interface PriorTerms {
  text: string;
  until: string;
}

export type RowVerdict =
  | { kind: "rating"; word: PublishedRiskLevel; sentence: string }
  | { kind: "ended"; sentence: string }
  | { kind: "withheld"; reason: string; sentence: string };

export interface RowCaveat {
  kind: "link_unreachable" | "not_re_read";
  text: string;
}

export interface RowVerification {
  verifiedDate: string | null;
  lastReachable: string | null;
  url: string;
  url_label: string;
}

export interface ReadmeRow {
  vendor: string;
  slug: string;
  category: string;
  tier: string;
  terms: PublishedTerms;
  prior: PriorTerms | null;
  verdict: RowVerdict;
  caveats: RowCaveat[];
  verification: RowVerification;
}

export interface RowContext {
  servedOn: string;
  nowMs: number;
  staleAfterDays: number;
}

function withheldReasonCode(because: BadgeWithholding): string {
  return because.reason === "gated" ? `gate:${because.gate}` : because.reason;
}

function withheldSentence(
  vendor: string,
  because: BadgeWithholding,
  gate: Gate | null,
  since: string,
): string {
  if (because.reason === "gated") return gate ? gateRiskSummary(gate) : `We do not rate an offer we do not list.`;
  if (because.reason === "no_source") return ratingWithheldForNoSourceSentence(vendor);
  if (withheldForARefusedRead(because)) return refusedReadWithholdingSentence(vendor, because);
  return withheldLevelSentence(because.reason, vendor, since);
}

function linkCaveat(vendor: string, linkUnreachable: LinkUnreachable): string {
  return linkUnreachable.last_reachable
    ? `${vendor}'s own link last resolved for us on ${linkUnreachable.last_reachable}, and has not since.`
    : `${vendor}'s own link has never resolved for us.`;
}

function staleCaveat(verifiedDate: string, staleAfterDays: number): string {
  return `We have not re-read this page since ${verifiedDate}, which is longer than our ${staleAfterDays}-day re-read interval. `
    + `That is a statement about us, not about the vendor.`;
}

function changesFor(vendor: string, changes: DealChange[]): DealChange[] {
  const key = vendor.toLowerCase();
  return changes.filter(c => c.vendor.toLowerCase() === key).sort((a, b) => b.date.localeCompare(a.date));
}

export function recordedRemoval(changes: DealChange[]): DealChange | null {
  return changes.find(c => c.change_type === REMOVAL_CHANGE_TYPE) ?? null;
}

export function endedByRemovalSentence(vendor: string, removal: DealChange): string {
  return `We recorded ${vendor}'s ${CHANGE_KIND_NOUN[removal.change_type]} on ${removal.date}, and the terms this row `
    + "publishes name no price of nothing either. A removal we recorded and terms that name nothing free are the same "
    + "finding twice, so this row says the offer ended rather than that we cannot say.";
}

export function noFreePriceSentence(vendor: string): string {
  return "The terms this row publishes name no price of nothing — no free plan, no zero price, nothing stated as "
    + `costing nothing. A tier field saying otherwise is older than the terms beside it. We hold no record of ${vendor} `
    + "removing a free tier, so we do not say one ended — we publish no rating and leave the terms to be read.";
}

function ratingOnTermsThatPriceNothingAtNothing(
  vendor: string,
  terms: PublishedTerms,
  vendorChanges: DealChange[],
): RowVerdict | null {
  if (namesAPriceOfNothing(terms.text)) return null;
  const removal = recordedRemoval(vendorChanges);
  return removal
    ? { kind: "ended", sentence: endedByRemovalSentence(vendor, removal) }
    : { kind: "withheld", reason: NO_FREE_PRICE_REASON, sentence: noFreePriceSentence(vendor) };
}

export function readmeRow(offer: Offer, allChanges: DealChange[], context: RowContext): ReadmeRow {
  const vendorChanges = changesFor(offer.vendor, allChanges);
  const risk = publishedRisk(offer, vendorChanges, context.servedOn, context.nowMs);
  const withheld = levelWithheldReason(offer, risk.link_unreachable);
  const since = levelWithheldSince(offer, risk.link_unreachable);
  const input: VendorVerdictInput = {
    vendor: offer.vendor,
    level: risk.risk_level,
    historyLevel: risk.history_level,
    cause: risk.risk_cause,
    changes: vendorChanges,
    levelWithheld: withheld,
    unconfirmableSince: since,
    ratingWithheld: risk.rating_withheld,
    offerEnded: offerEnded(offer),
    gate: risk.gate?.code ?? null,
    linkUnreachable: Boolean(risk.link_unreachable),
    sourceCheck: offer.source_check?.outcome ?? null,
  };

  const superseding = supersedingChange(offer, vendorChanges);
  const reading = superseding ? readingBehindTheChange(superseding) : null;
  const terms: PublishedTerms = reading
    ? { text: reading.terms, as_of: reading.date, source_url: reading.url, source_label: reading.label, quoted: true }
    : {
        text: offer.description,
        as_of: risk.link_unreachable ? null : offer.verifiedDate,
        source_url: offer.url,
        source_label: citationLabel(offer.url),
        quoted: false,
      };
  const prior: PriorTerms | null =
    superseding && reading && (superseding.previous_state ?? "").trim() !== ""
      ? { text: superseding.previous_state!.trim(), until: superseding.date }
      : null;

  const badge = vendorBadge(input);
  const verdict: RowVerdict =
    badge.kind === "rating"
      ? ratingOnTermsThatPriceNothingAtNothing(offer.vendor, terms, vendorChanges)
        ?? { kind: "rating", word: badge.word, sentence: vendorVerdictSentence(input) }
      : badge.kind === "ended"
        ? { kind: "ended", sentence: endedVerdictSentence() }
        : {
            kind: "withheld",
            reason: withheldReasonCode(badge.because),
            sentence: withheldSentence(offer.vendor, badge.because, risk.gate, since),
          };

  const caveats: RowCaveat[] = [];
  const linkStatedInVerdict = verdict.kind === "withheld" && verdict.reason === "link_unreachable";
  if (risk.link_unreachable && !linkStatedInVerdict) {
    caveats.push({ kind: "link_unreachable", text: linkCaveat(offer.vendor, risk.link_unreachable) });
  }
  if (!risk.link_unreachable && readingIsBehindTheLoop(offer.verifiedDate, context.staleAfterDays, context.nowMs)) {
    caveats.push({ kind: "not_re_read", text: staleCaveat(offer.verifiedDate, context.staleAfterDays) });
  }

  return {
    vendor: offer.vendor,
    slug: toSlug(offer.vendor),
    category: offer.category,
    tier: offer.tier,
    terms,
    prior,
    verdict,
    caveats,
    verification: {
      verifiedDate: risk.link_unreachable ? null : offer.verifiedDate,
      lastReachable: risk.link_unreachable?.last_reachable ?? null,
      url: offer.url,
      url_label: citationLabel(offer.url),
    },
  };
}

export interface ExcludedRecord {
  vendor: string;
  tier: string;
  reason: ExclusionReason;
}

export interface ReadmeSelection {
  rows: ReadmeRow[];
  excluded: ExcludedRecord[];
}

function labelsOf(offer: Offer): string[] | null {
  return offer.product_subtypes ? offer.product_subtypes.labels.map(l => l.subtype) : null;
}

function whyNotServing(labels: string[] | null): ExclusionReason {
  if (labels === null) return "not_read_against_subtypes";
  return labels.length === 0 ? "no_subtype_applies" : "another_function";
}

export function readmeSelection(offers: Offer[], changes: DealChange[], context: RowContext): ReadmeSelection {
  const drawnFrom = new Set<string>(README_CATEGORIES);
  const serving = new Set<string>(README_SUBTYPES);
  const excluded: ExcludedRecord[] = [];
  const selected: Offer[] = [];

  for (const offer of offers) {
    const labels = labelsOf(offer);
    if (labels?.some(l => serving.has(l))) {
      selected.push(offer);
      continue;
    }
    if (!drawnFrom.has(offer.category)) continue;
    excluded.push({ vendor: offer.vendor, tier: offer.tier, reason: whyNotServing(labels) });
  }

  const rows = selected
    .sort((a, b) => a.vendor.localeCompare(b.vendor, "en") || a.tier.localeCompare(b.tier, "en"))
    .map(offer => readmeRow(offer, changes, context));

  return { rows, excluded };
}

export function readmeRows(offers: Offer[], changes: DealChange[], context: RowContext): ReadmeRow[] {
  return readmeSelection(offers, changes, context).rows;
}

export function excludedByReason(excluded: ExcludedRecord[]): Record<ExclusionReason, number> {
  const counts = {} as Record<ExclusionReason, number>;
  for (const reason of Object.keys(EXCLUSION_RULES) as ExclusionReason[]) counts[reason] = 0;
  for (const record of excluded) counts[record.reason] += 1;
  return counts;
}

export interface ReadmeCensus {
  rows: number;
  rated: number;
  ended: number;
  withheld: number;
  withheldByReason: Record<string, number>;
  withPriorTerms: number;
  linkUnreachable: number;
  stale: number;
  caveated: number;
}

export function readmeCensus(rows: ReadmeRow[]): ReadmeCensus {
  const withheldByReason: Record<string, number> = {};
  for (const row of rows) {
    if (row.verdict.kind !== "withheld") continue;
    withheldByReason[row.verdict.reason] = (withheldByReason[row.verdict.reason] ?? 0) + 1;
  }
  return {
    rows: rows.length,
    rated: rows.filter(r => r.verdict.kind === "rating").length,
    ended: rows.filter(r => r.verdict.kind === "ended").length,
    withheld: rows.filter(r => r.verdict.kind === "withheld").length,
    withheldByReason,
    withPriorTerms: rows.filter(r => r.prior !== null).length,
    linkUnreachable: rows.filter(r => r.verification.lastReachable !== null || r.verification.verifiedDate === null).length,
    stale: rows.filter(r => r.caveats.some(c => c.kind === "not_re_read")).length,
    caveated: rows.filter(r => r.caveats.length > 0).length,
  };
}

function cell(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
}

function link(label: string, url: string): string {
  return `[${cell(label)}](${url})`;
}

function vendorCell(row: ReadmeRow): string {
  return `${link(row.vendor, `${BASE_URL}/vendor/${row.slug}`)}<br>${cell(row.tier)}`;
}

function termsCell(row: ReadmeRow): string {
  const source = link(row.terms.source_label, row.terms.source_url);
  const head = row.terms.quoted
    ? `As of ${row.terms.as_of}, ${source} reads: ${cell(row.terms.text)}`
    : row.terms.as_of === null
      ? `Our record, read from ${source} while that link still resolved: ${cell(row.terms.text)}`
      : `Our record, read from ${source} on ${row.terms.as_of}: ${cell(row.terms.text)}`;
  if (!row.prior) return head;
  return `${head}<br><br>**Until ${row.prior.until}, our record read:** ${cell(row.prior.text)}`;
}

export const RATING_LABELS = { ended: "ended", unrated: "unrated" } as const;

export function ratingWord(row: ReadmeRow): string {
  if (row.verdict.kind === "rating") return row.verdict.word;
  return row.verdict.kind === "ended" ? RATING_LABELS.ended : RATING_LABELS.unrated;
}

function verdictCell(row: ReadmeRow): string {
  return [cell(row.verdict.sentence), ...row.caveats.map(c => cell(c.text))].join("<br><br>");
}

function verifiedCell(row: ReadmeRow): string {
  if (row.verification.verifiedDate) return row.verification.verifiedDate;
  return row.verification.lastReachable
    ? `link last resolved ${row.verification.lastReachable}`
    : "link has never resolved";
}

export function renderRow(row: ReadmeRow): string {
  return `| ${vendorCell(row)} | ${termsCell(row)} | \`${ratingWord(row)}\` | ${verdictCell(row)} | ${verifiedCell(row)} |`;
}

const TABLE_HEAD = [
  "| Vendor | The terms, and where they came from | Rating | What we can say | Record verified |",
  "| --- | --- | --- | --- | --- |",
].join("\n");

function recordTable(rows: ReadmeRow[]): string {
  return [
    `## The records — ${rows.length}`,
    "",
    TABLE_HEAD,
    ...rows.map(renderRow),
  ].join("\n");
}

function inclusionSection(rows: ReadmeRow[], excluded: ExcludedRecord[]): string {
  const counts = excludedByReason(excluded);
  const definitions = README_SUBTYPES.map(
    subtype => `- \`${subtype}\` — ${subtypeDefinition(README_TAXONOMY, subtype)}`,
  ).join("\n");
  const reasons = (Object.keys(EXCLUSION_RULES) as ExclusionReason[])
    .map(reason => `| \`${reason}\` | ${counts[reason]} | ${EXCLUSION_RULES[reason]} |`)
    .join("\n");
  return [
    "## What is in this file, and what is left out",
    "",
    README_INCLUSION_RULE,
    "",
    definitions,
    "",
    `${rows.length} records carry one of those. The catalogue holds them under `
    + `${README_CATEGORIES.map(c => `**${c}**`).join(" and ")}, and ${excluded.length} records there are left out. `
    + "Each is left out for a stated reason, counted here so the size of each reason is visible:",
    "",
    "| | Records | Why |",
    "| --- | --- | --- |",
    reasons,
    "",
    "A record left out is not a record we are hiding: every one of them is published in full at "
    + `${BASE_URL}, and \`not_read_against_subtypes\` in particular measures our own reading rather than the `
    + "product.",
    "",
    "Nothing else keeps a record out. A record whose terms name no free price is still published here, with the "
    + "terms we read and no rating — leaving it out would hide the one reading a reader most needs to see.",
  ].join("\n");
}

function endedClause(ended: number): string {
  if (ended === 0) return "No record here is recorded as ended today.";
  const noun = ended === 1 ? "One record is" : `${ended} records are`;
  return `${noun} recorded as ended (\`${classifyTier("Retired").note}\`); they stay in the file because a free tier `
    + "that has gone is the thing hardest to find out elsewhere.";
}

function termsOverTierRule(census: ReadmeCensus): string {
  const unrated = census.withheldByReason[NO_FREE_PRICE_REASON] ?? 0;
  const count = unrated === 1 ? "One row is" : `${unrated} rows are`;
  return "A tier name is not the last word, because a tier field is older than the terms printed beside it. Where "
    + "the terms a row publishes name no price of nothing — no free plan, no zero price, nothing stated as costing "
    + `nothing — that row carries no rating, whatever its tier says. ${count} unrated for that reason today, and where we also hold `
    + "a dated record of the free tier being removed the row reads `ended` instead, because then we have the removal "
    + "and not only its shadow.\n\n"
    + "That test runs on the terms **every** row publishes. It is not restricted to the rows carrying a newer "
    + "reading, because a row we have never re-read is the one whose tier field is oldest.";
}

function freeTierRule(census: ReadmeCensus): string {
  const notFree = NOT_FREE_TIER_RULES.map(r => `- \`${r.pattern.source}\` — ${r.note}`).join("\n");
  const timeLimited = TIME_LIMITED_TIER_RULES.map(r => `- \`${r.pattern.source}\` — ${r.note}`).join("\n");
  return [
    "## What counts as a free tier here",
    "",
    "A record's tier is free text written by whoever read the page. It is classified by rule, not by a list of "
    + "approved names, so a tier nobody has seen before is never silently dropped.",
    "",
    "These tier names are **not** a free offer. A record carrying one is still published here, with the reason, "
    + "but it is never rated:",
    "",
    notFree,
    "",
    "These are free but **time-limited** — the free part runs out:",
    "",
    timeLimited,
    "",
    `Anything else is an ongoing free tier. ${endedClause(census.ended)}`,
    "",
    termsOverTierRule(census),
  ].join("\n");
}

function changeRule(): string {
  const byDirection = (direction: string) =>
    (Object.keys(CHANGE_KIND_NOUN) as Array<keyof typeof CHANGE_KIND_NOUN>)
      .filter(type => CHANGE_DIRECTION[type] === direction)
      .map(type => `\`${type}\``)
      .join(", ");
  return [
    "## What counts as a change",
    "",
    "A change is one dated record about one vendor, carrying the terms before, the terms after, and the URL we read "
    + "them on. Re-reading a page and finding it unchanged is not a change and produces no record.",
    "",
    `**Narrows the terms:** ${byDirection("negative")}. Only these can move a rating.`,
    "",
    `**Widens them:** ${byDirection("positive")}. A vendor cannot be rated caution for any of these.`,
    "",
    `**Neither:** ${byDirection("neutral")}. \`record_corrected\` is us correcting our own entry, not the vendor `
    + "changing anything.",
    "",
    "A rating is decided by the *type* of the most recent narrowing record, never by how many records we hold. "
    + "A vendor we have never had cause to examine reads the same as one with a long clean history — `stable` is a "
    + "statement about our records, not a clean bill of health.",
  ].join("\n");
}

function howToReadARow(census: ReadmeCensus, staleAfterDays: number): string {
  return [
    "## How to read a row",
    "",
    "**The terms** are either a sentence quoted from the vendor's own page on the day we read it, or our own record "
    + "of that page, and the row says which. Where a change record supersedes what we stored, the row shows the "
    + "quoted reading first and the terms it replaced underneath, with the date they stopped being current. "
    + `${census.withPriorTerms} rows carry that second line, and it is the whole point of this file.`,
    "",
    "**Rating** is one of four values:",
    "",
    "- `stable`, `caution` or `risky` — always printed beside the single dated record that produced it;",
    "- `ended` — a free tier we recorded going away. The row stays for the record;",
    `- \`unrated\` — we are publishing no rating, and the next column says why. ${census.withheld} of ${census.rows} `
    + "rows are unrated. A record whose page we could not read, that names no terms we can read, that is not a free "
    + "offer, whose terms name no free price, or whose link has stopped resolving gets the reason instead of a "
    + "verdict. We would rather print why we cannot say than guess.",
    "",
    `**Record verified** is the day we last confirmed that record against the page. Where the link has not resolved `
    + `for ${LINK_GRACE_DAYS} days, we withhold that date and print the day the link last worked instead: a recent `
    + "date over a destination that no longer answers is the most confident-looking thing on a page and the least true.",
    "",
    `We re-read records on a rolling schedule. ${census.stale} rows say in the row that we have not re-read them `
    + `within our ${staleAfterDays}-day interval. That is a statement about us, not about the vendor. Where a link `
    + "has stopped resolving, the row says that instead, because we cannot re-read a page that does not answer.",
  ].join("\n");
}

function countsSection(census: ReadmeCensus): string {
  const reasons = Object.entries(census.withheldByReason)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => `\`${reason}\` ${count}`)
    .join(", ");
  return [
    "## What the rows publish",
    "",
    `| | |`,
    `| --- | --- |`,
    `| Records | ${census.rows} |`,
    `| Carrying a rating | ${census.rated} |`,
    `| Recorded as ended | ${census.ended} |`,
    `| Publishing a reason instead of a rating | ${census.withheld} — ${reasons} |`,
    `| Showing the terms they replaced | ${census.withPriorTerms} |`,
    `| Carrying a caveat about our own reading | ${census.caveated} |`,
    "",
    "Those counts are generated with the rows. If most of a column carries a caveat, that is a fact about this "
    + "catalogue and it belongs in the open.",
  ].join("\n");
}

export interface ReadmeMeta {
  staleAfterDays: number;
  excluded: ExcludedRecord[];
}

export function renderReadme(rows: ReadmeRow[], meta: ReadmeMeta): string {
  const census = readmeCensus(rows);
  const sections = [
    `# ${README_TITLE}`,
    "",
    `${census.rows} records for vendors that serve models behind an API, each one carrying the date we last read the `
    + "vendor's own page and the URL we read it on. There is no single freshness stamp for this file, because a "
    + "single stamp for a list nobody re-read is worth nothing.",
    "",
    `Generated from the free-tier catalogue at ${BASE_URL}, which is where each row's record lives. `
    + `${README_EDIT_WARNING} ${README_GENERATOR_SENTENCE}`,
    "",
    "What this file has that a hand-kept list does not: **the terms a vendor replaced, next to the terms it replaced "
    + `them with, with the date.** ${census.withPriorTerms} rows carry that today.`,
    "",
    README_ORDER_RULE,
    "",
    inclusionSection(rows, meta.excluded),
    "",
    countsSection(census),
    "",
    howToReadARow(census, meta.staleAfterDays),
    "",
    freeTierRule(census),
    "",
    changeRule(),
    "",
    `${recordTable(rows)}\n`,
    "## Corrections",
    "",
    `Every row links to the vendor's page on ${BASE_URL}, which carries the full record, every change we have `
    + "recorded for that vendor, and the source URL for each one. If a row here is wrong, the record behind it is "
    + `wrong: file it at ${CATALOGUE_ISSUES_URL} and it is fixed at the source, in this file and on the site `
    + "together.",
    "",
    `Ratings are never for sale, and no vendor can ask to be added, removed or re-rated. ${BASE_URL}/criteria is the `
    + "whole method.",
  ];
  return `${sections.join("\n")}\n`;
}

export function generateReadme(offers: Offer[], changes: DealChange[], context: RowContext): string {
  const { rows, excluded } = readmeSelection(offers, changes, context);
  return renderReadme(rows, { staleAfterDays: context.staleAfterDays, excluded });
}

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createArchiveClient, dayOurTextEntered, pairedReaderFor, PAIRED_READER_MAX_TOKENS, settleAgainstCaptures, wordsOfTierName } from "./archive-captures.js";
import { createVerifierClient, fetchPageText } from "./verify-freshness.js";

export const DEMOTION_WINDOW_DAYS = 180;

export const SPLIT = {
  recentVendorChange: "vendor change inside 180 days",
  olderVendorChange: "vendor change before that",
  ours: "our correction",
  noCaptureBadgeToReview: "no usable capture, set a badge: to review",
  noCapture: "no usable capture, set no badge",
  textDayUnknown: "text day unknown",
  pageUnreadable: "page unreadable today",
  readerFailed: "reader failed",
};

const BADGE_LEVELS = ["caution", "risky"];

export function recordKey(record) {
  return JSON.stringify([record.date, record.change_type, record.recorded_date ?? null, record.summary]);
}

export function badgesByRecord(listingRisks) {
  const badges = new Map();
  for (const { risk_level, cause } of listingRisks) {
    if (!cause || !BADGE_LEVELS.includes(risk_level)) continue;
    const key = recordKey(cause);
    if (badges.get(key) !== "risky") badges.set(key, risk_level);
  }
  return badges;
}

export function firstReadingsInForce(changes, { includeResolved = false } = {}) {
  const readingsSoFar = new Map();
  const byDay = [...changes].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.recorded_date).localeCompare(String(b.recorded_date)));
  const backlog = [];
  for (const change of byDay) {
    const earlierReadings = readingsSoFar.get(change.vendor) ?? new Set();
    if (change.date_source === "discovered" && (includeResolved || !change.resolution) && !earlierReadings.has(change.previous_state)) backlog.push(change);
    if (change.date_source === "discovered") {
      earlierReadings.add(change.current_state);
      readingsSoFar.set(change.vendor, earlierReadings);
    }
  }
  return backlog;
}

function daysBefore(day, days) {
  return new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

export function splitOf(settled, today, badge = null) {
  if (settled.outcome === "ours") return SPLIT.ours;
  if (settled.outcome === "text_day_unknown") return SPLIT.textDayUnknown;
  if (settled.outcome === "page_unreadable_today") return SPLIT.pageUnreadable;
  if (settled.outcome === "reader_failed") return SPLIT.readerFailed;
  if (settled.outcome !== "vendor_changed") return BADGE_LEVELS.includes(badge) ? SPLIT.noCaptureBadgeToReview : SPLIT.noCapture;
  const latest = settled.brackets[settled.brackets.length - 1];
  const movedOnOrAfter = latest.first_new ?? latest.last_old;
  return movedOnOrAfter >= daysBefore(today, DEMOTION_WINDOW_DAYS) ? SPLIT.recentVendorChange : SPLIT.olderVendorChange;
}

export function listingFor(record, offers) {
  const sameVendor = offers.filter((offer) => offer.vendor === record.vendor);
  return (
    sameVendor.find((offer) => record.tier && offer.tier === record.tier) ??
    sameVendor[0] ?? { vendor: record.vendor, category: record.category, tier: record.tier ?? "" }
  );
}

export function matchesSharingOnlyTheTierName(readings, tier) {
  const tierWords = wordsOfTierName(tier);
  return readings.flatMap(({ older, newer, verdict }) =>
    (verdict?.matched ?? [])
      .filter(({ shared }) => shared.length > 0 && shared.every((word) => tierWords.includes(word)))
      .map(({ old, new: newLine, shared }) => ({ older, newer, old, new: newLine, shared })),
  );
}

function worthAskingAgain(result) {
  return result.outcome === "reader_failed" || String(result.why ?? "").startsWith("the Archive did not answer");
}

async function settleOrSayTheReaderFailed(settle, readings) {
  try {
    return await settle();
  } catch (err) {
    return { outcome: "reader_failed", why: `the reader failed: ${err?.message ?? err}`, reads: readings.length };
  }
}

export function inShard(records, shard) {
  return shard ? records.filter((record, at) => at % shard.count === shard.index) : records;
}

export function parseShard(text) {
  const found = /^(\d+)\/(\d+)$/.exec(String(text ?? ""));
  if (!found) return null;
  const [index, count] = [Number(found[1]), Number(found[2])];
  return count > 0 && index < count ? { index, count } : null;
}

export async function settleFirstReadings({ changes, offers, today, archive, pairReaderForListing, fetchToday, textDayOf, badgeSetBy = () => null, limit = Infinity, vendors, shard = null, includeResolved = false, logReads = false, onSettled = () => {} }) {
  const backlog = inShard(firstReadingsInForce(changes, { includeResolved }).filter((record) => !vendors || vendors.includes(record.vendor)), shard).slice(0, limit);
  const settleOne = async (record) => {
    const badge = badgeSetBy(record);
    const subject = { vendor: record.vendor, date: record.date, change_type: record.change_type, source_url: record.source_url, resolution: record.resolution?.state ?? null, badge };
    const listing = listingFor(record, offers);
    const page = await fetchToday(record.source_url);
    const readings = [];
    const settled = page.ok
      ? await settleOrSayTheReaderFailed(() => settleAgainstCaptures({
          url: record.source_url,
          finalUrl: page.finalUrl,
          textDay: textDayOf(record.previous_state),
          recordDay: record.date,
          todayText: page.text,
          today,
          archive,
          readPair: pairReaderForListing(listing),
          onRead: (reading) => readings.push(reading),
        }), readings)
      : { outcome: "page_unreadable_today", why: page.error, reads: 0 };
    const onTheTierName = matchesSharingOnlyTheTierName(readings, listing.tier);
    const { date: dateFromCaptures, ...settledWithoutItsDate } = settled;
    const result = {
      ...subject,
      ...settledWithoutItsDate,
      ...(dateFromCaptures !== undefined ? { date_from_captures: dateFromCaptures } : {}),
      split: splitOf(settled, today, badge),
      ...(onTheTierName.length > 0 ? { tier: listing.tier, matches_sharing_only_the_tier_name: onTheTierName } : {}),
      ...(logReads ? { readings } : {}),
    };
    onSettled(result);
    return result;
  };
  const results = [];
  for (const record of backlog) results.push(await settleOne(record));
  for (const [at, record] of backlog.entries()) {
    if (worthAskingAgain(results[at])) results[at] = await settleOne(record);
  }
  const split = Object.fromEntries(Object.values(SPLIT).map((name) => [name, results.filter((result) => result.split === name).length]));
  return { today, records: backlog.length, split, review: reviewList(results), matches_sharing_only_the_tier_name: tierNameMatchList(results), results };
}

export function reviewList(results) {
  return results
    .filter((result) => result.review?.length > 0 || result.split === SPLIT.noCaptureBadgeToReview)
    .map((result) => ({
      vendor: result.vendor,
      date: result.date,
      change_type: result.change_type,
      badge: result.badge ?? null,
      ...(result.compared_with ? { compared_with: result.compared_with } : {}),
      why: result.why ?? null,
      ...(result.tried ? { tried: result.tried } : {}),
      lines: result.review ?? [],
    }));
}

export function tierNameMatchList(results) {
  return results
    .filter((result) => result.matches_sharing_only_the_tier_name?.length > 0)
    .map((result) => ({
      vendor: result.vendor,
      date: result.date,
      change_type: result.change_type,
      tier: result.tier,
      split: result.split,
      matches: result.matches_sharing_only_the_tier_name,
    }));
}

async function badgesPublishedToday() {
  const { changesByVendor, loadOffers, publishedRisk } = await import("../dist/data.js");
  const changesOf = changesByVendor();
  return badgesByRecord(loadOffers().map((offer) => publishedRisk(offer, changesOf.get(offer.vendor.toLowerCase()) ?? [])));
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const shardAsked = option("--shard") === undefined ? null : parseShard(option("--shard"));
  if (option("--shard") !== undefined && !shardAsked) throw new Error(`--shard takes k/n with k below n, as 0/8; got ${option("--shard")}`);
  const changes = JSON.parse(readFileSync("data/deal_changes.json", "utf-8")).changes;
  const offers = JSON.parse(readFileSync("data/index.json", "utf-8")).offers;
  const client = createVerifierClient({ maxTokens: PAIRED_READER_MAX_TOKENS });
  const out = option("--out") ?? "settled-first-readings.json";
  const progress = out.replace(/\.json$/, "") + ".jsonl";
  writeFileSync(progress, "");
  const badges = await badgesPublishedToday();
  const report = await settleFirstReadings({
    changes,
    offers,
    today: new Date().toISOString().slice(0, 10),
    archive: createArchiveClient(),
    pairReaderForListing: (listing) => pairedReaderFor(client, listing),
    fetchToday: (url) => fetchPageText(url),
    textDayOf: (text) => dayOurTextEntered(text),
    badgeSetBy: (record) => badges.get(recordKey(record)) ?? null,
    limit: option("--limit") ? Number(option("--limit")) : Infinity,
    vendors: option("--vendors")?.split(",").map((name) => name.trim()),
    shard: shardAsked,
    includeResolved: args.includes("--include-resolved"),
    logReads: args.includes("--log-reads"),
    onSettled: (result) => appendFileSync(progress, `${JSON.stringify(result)}\n`),
  });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Settled ${report.results.length} of ${report.records} first readings in force; report in ${out}`);
  for (const [name, count] of Object.entries(report.split)) console.log(`  ${name}: ${count}`);
  console.log(`  for review: ${report.review.length}`);
  console.log(`  same-answer matches sharing only a word of the tier name: ${report.matches_sharing_only_the_tier_name.length} records`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}

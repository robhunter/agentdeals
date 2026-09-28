import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createArchiveClient, dayOurTextEntered, readerFor, settleAgainstCaptures } from "./archive-captures.js";
import { createVerifierClient, fetchPageText } from "./verify-freshness.js";

export const DEMOTION_WINDOW_DAYS = 180;

export const SPLIT = {
  recentVendorChange: "vendor change inside 180 days",
  olderVendorChange: "vendor change before that",
  ours: "our correction",
  notReproduced: "difference not reproduced",
  noCapture: "no usable capture",
  textDayUnknown: "text day unknown",
  pageUnreadable: "page unreadable today",
};

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

export function splitOf(settled, today) {
  if (settled.outcome === "ours") return SPLIT.ours;
  if (settled.outcome === "not_reproduced") return SPLIT.notReproduced;
  if (settled.outcome === "text_day_unknown") return SPLIT.textDayUnknown;
  if (settled.outcome === "page_unreadable_today") return SPLIT.pageUnreadable;
  if (settled.outcome !== "vendor_changed") return SPLIT.noCapture;
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

export async function settleFirstReadings({ changes, offers, today, archive, readerForListing, fetchToday, textDayOf, limit = Infinity, vendors, includeResolved = false, onSettled = () => {} }) {
  const backlog = firstReadingsInForce(changes, { includeResolved }).filter((record) => !vendors || vendors.includes(record.vendor)).slice(0, limit);
  const results = [];
  for (const record of backlog) {
    const subject = { vendor: record.vendor, date: record.date, change_type: record.change_type, source_url: record.source_url, resolution: record.resolution?.state ?? null };
    const page = await fetchToday(record.source_url);
    const settled = page.ok
      ? await settleAgainstCaptures({
          url: record.source_url,
          ourText: record.previous_state,
          textDay: textDayOf(record.previous_state),
          todayText: page.text,
          today,
          archive,
          read: readerForListing(listingFor(record, offers)),
        })
      : { outcome: "page_unreadable_today", why: page.error, reads: 0 };
    const result = { ...subject, ...settled, split: splitOf(settled, today) };
    results.push(result);
    onSettled(result);
  }
  const split = Object.fromEntries(Object.values(SPLIT).map((name) => [name, results.filter((result) => result.split === name).length]));
  return { today, records: backlog.length, split, results };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const changes = JSON.parse(readFileSync("data/deal_changes.json", "utf-8")).changes;
  const offers = JSON.parse(readFileSync("data/index.json", "utf-8")).offers;
  const client = createVerifierClient();
  const out = option("--out") ?? "settled-first-readings.json";
  const progress = out.replace(/\.json$/, "") + ".jsonl";
  writeFileSync(progress, "");
  const report = await settleFirstReadings({
    changes,
    offers,
    today: new Date().toISOString().slice(0, 10),
    archive: createArchiveClient(),
    readerForListing: (listing) => readerFor(client, listing),
    fetchToday: (url) => fetchPageText(url),
    textDayOf: (text) => dayOurTextEntered(text),
    limit: option("--limit") ? Number(option("--limit")) : Infinity,
    vendors: option("--vendors")?.split(",").map((name) => name.trim()),
    includeResolved: args.includes("--include-resolved"),
    onSettled: (result) => appendFileSync(progress, `${JSON.stringify(result)}\n`),
  });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Settled ${report.results.length} of ${report.records} first readings in force; report in ${out}`);
  for (const [name, count] of Object.entries(report.split)) console.log(`  ${name}: ${count}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}

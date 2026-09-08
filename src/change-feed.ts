import type { DealChange } from "./types.js";
import { changeCitesASource, type CitableChange } from "./change-citation.js";
import {
  DISCOVERED_DATE_PREFIX,
  EFFECTIVE_DATE_PREFIX,
  UNKNOWN_EFFECTIVE_DATE_MARKER,
  feedEntryUpdated,
  isEventDated,
  partitionByDateProvenance,
} from "./change-dates.js";

export interface FeedDescriptor {
  title: string;
  path: string;
}

export const PER_CHANGE_FEED: FeedDescriptor = {
  title: "AgentDeals — Developer Tool Pricing Changes",
  path: "/pricing-changes/feed.xml",
};

export const WEEKLY_DIGEST_FEED: FeedDescriptor = {
  title: "AgentDeals — Weekly Pricing Digest",
  path: "/feed.xml",
};

export const PUBLISHED_FEEDS: FeedDescriptor[] = [PER_CHANGE_FEED, WEEKLY_DIGEST_FEED];

export function feedLinkTag(feed: FeedDescriptor, baseUrl = ""): string {
  return `<link rel="alternate" type="application/atom+xml" title="${feed.title}" href="${baseUrl}${feed.path}">`;
}

export const CHANGE_FEED_ENTRY_LIMIT = 50;

export const CHANGE_FEED_DESCRIPTION =
  "Track pricing changes, free tier removals, and deal updates across developer infrastructure tools.";

export const CHANGE_FEED_NAMESPACE = "https://agentdeals.dev/ns/change";

export const CHANGE_FEED_NAMESPACE_PREFIX = "ad";

export const CHANGE_TYPE_FEED_LABEL: Record<DealChange["change_type"], string> = {
  free_tier_removed: "Free Tier Removed",
  limits_reduced: "Limits Reduced",
  restriction: "New Restriction",
  limits_increased: "Limits Increased",
  new_free_tier: "New Free Tier",
  new_tier: "New Tier",
  pricing_restructured: "Pricing Restructured",
  open_source_killed: "Open Source Killed",
  pricing_model_change: "Pricing Model Change",
  startup_program_expanded: "Startup Program Expanded",
  pricing_postponed: "Pricing Postponed",
  product_deprecated: "Product Deprecated",
  rebranded: "Rebranded",
  record_corrected: "Record Corrected",
};

export function changeTypeFeedLabel(changeType: string): string {
  return (
    CHANGE_TYPE_FEED_LABEL[changeType as DealChange["change_type"]] ??
    changeType.replace(/_/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase())
  );
}

type FeedChange = Pick<DealChange, "date" | "date_source" | "recorded_date">;

export function recordedOn(change: FeedChange): string {
  return change.recorded_date ?? change.date;
}

export function feedEntryOrder(a: FeedChange, b: FeedChange): number {
  return recordedOn(b).localeCompare(recordedOn(a)) || b.date.localeCompare(a.date);
}

export function changeFeedEntries<T extends FeedChange>(changes: T[], limit: number): T[] {
  return [...changes].sort(feedEntryOrder).slice(0, limit);
}

export function effectiveDateOf(change: FeedChange): string | null {
  return isEventDated(change) ? change.date : null;
}

export function feedEntryDateSentence(change: FeedChange): string {
  const recorded = recordedOn(change);
  return isEventDated(change)
    ? `${EFFECTIVE_DATE_PREFIX} ${change.date} · recorded ${recorded}.`
    : `${DISCOVERED_DATE_PREFIX} ${change.date} · ${UNKNOWN_EFFECTIVE_DATE_MARKER} — this date is when we read the vendor's pricing page and found terms that differ from what we had stored. The page does not say when they changed, so it is not the date this took effect.`;
}

export function feedEntrySummary(change: DealChange): string {
  const states =
    change.previous_state && change.current_state
      ? ` Before: ${change.previous_state}. After: ${change.current_state}.`
      : "";
  return `${feedEntryDateSentence(change)} ${change.summary}${states}`;
}

export function feedEntryUpdatedTimestamp(change: FeedChange, now: Date = new Date()): string {
  return feedEntryUpdated(recordedOn(change), now);
}

export function channelUpdatedTimestamp(entryStamps: string[], now: Date = new Date()): string {
  const nowIso = now.toISOString();
  const newest = entryStamps.reduce((a, b) => (b > a ? b : a), "");
  if (newest === "") return nowIso;
  return newest > nowIso ? nowIso : newest;
}

export function feedUpdatedTimestamp(entries: FeedChange[], now: Date = new Date()): string {
  return channelUpdatedTimestamp(entries.map((c) => feedEntryUpdatedTimestamp(c, now)), now);
}

export const WEEKLY_FEED_POPULATION_NOTE =
  "Each issue counts only changes with a known effective date. Pricing pages read for the first time in a week are reported inside the issue under their own heading and are not counted as changes that took effect that week — the per-change feed carries them individually and labels each one.";

export function changeFeedProvenanceNote(entries: FeedChange[], weeklyFeedUrl: string): string {
  const { dated, discovered } = partitionByDateProvenance(entries);
  const total = entries.length;
  const carried = `The ${total} most recently recorded ${total === 1 ? "change" : "changes"}, newest first.`;
  const split = `${discovered.length} of ${total} ${discovered.length === 1 ? "is" : "are"} dated by discovery: the date is when we read the vendor's pricing page, which does not say when the terms changed. ${dated.length} ${dated.length === 1 ? "carries" : "carry"} a known effective date.`;
  const reconcile = `Every entry states which of the two it is. The Weekly Pricing Digest at ${weeklyFeedUrl} counts only changes with a known effective date and reports pages read for the first time under their own heading, so a week's totals there will differ from a count of the entries here.`;
  return `${carried} ${split} ${reconcile}`;
}

interface FeedEntryFields {
  updated: string;
  dateSource: string;
  effectiveDate: string | null;
  recordedDate: string;
  label: string;
  summary: string;
}

export const VIA_LINK_REL = "via";

export const NO_SOURCE_HELD_ELEMENT = "source_held";

export const NO_SOURCE_HELD_VALUE = "none";

export function feedEntrySourceXml(
  change: CitableChange,
  esc: (text: string) => string,
  ns: string,
  indent = "    ",
): string {
  return changeCitesASource(change)
    ? `${indent}<link href="${esc(change.source_url!.trim())}" rel="${VIA_LINK_REL}"/>`
    : `${indent}<${ns}:${NO_SOURCE_HELD_ELEMENT}>${NO_SOURCE_HELD_VALUE}</${ns}:${NO_SOURCE_HELD_ELEMENT}>`;
}

export function digestSourceXml(
  changes: readonly CitableChange[],
  esc: (text: string) => string,
  ns = CHANGE_FEED_NAMESPACE_PREFIX,
  indent = "    ",
): string {
  const sources = [...new Set(changes.filter(changeCitesASource).map((c) => c.source_url!.trim()))];
  if (sources.length === 0) {
    return `${indent}<${ns}:${NO_SOURCE_HELD_ELEMENT}>${NO_SOURCE_HELD_VALUE}</${ns}:${NO_SOURCE_HELD_ELEMENT}>`;
  }
  return sources.map((url) => `${indent}<link href="${esc(url)}" rel="${VIA_LINK_REL}"/>`).join("\n");
}

export function feedEntryFields(change: DealChange, now: Date = new Date()): FeedEntryFields {
  return {
    updated: feedEntryUpdatedTimestamp(change, now),
    dateSource: change.date_source ?? "discovered",
    effectiveDate: effectiveDateOf(change),
    recordedDate: recordedOn(change),
    label: changeTypeFeedLabel(change.change_type),
    summary: feedEntrySummary(change),
  };
}

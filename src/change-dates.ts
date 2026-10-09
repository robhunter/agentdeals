import type { ArchiveCheck, DealChange, ChangeDateSource, DateMeaning } from "./types.js";
import { PRODUCT_DEPRECATED, deprecationEndsTheListedProduct } from "./product-deprecation.js";
import { NEGATIVE_CHANGE_TYPES } from "./change-direction.js";
import { sliceById } from "./change-census.js";
import { isACorrectionToOurOwnRecord } from "./change-resolution.js";
import { reportsOurIndex } from "./change-reporting.js";
import { OURS_ARCHIVE_OUTCOME } from "./change-confirmation.js";

export interface DatedChange {
  date: string;
  date_source?: ChangeDateSource;
  recorded_date?: string | null;
  change_type?: string;
  reports?: string | null;
  archive_check?: Pick<ArchiveCheck, "checked" | "outcome" | "brackets"> | null;
}

type ExpiringChange = DatedChange & Pick<DealChange, "change_type" | "vendor" | "summary">;

export const DISCOVERED_DATE_PREFIX = "discovered";

export const EFFECTIVE_DATE_PREFIX = "effective";

export const UNKNOWN_EFFECTIVE_DATE_MARKER = "effective date unknown";

export const EFFECTIVE_BY_DATE_MEANING = "effective_by";

export const BRACKETED_DATE_PREFIX = "effective between";

export const RECORDED_DATE_PREFIX = "recorded";

export const CORRECTED_DATE_PREFIX = "corrected";

export const DATE_SOURCES: ChangeDateSource[] = ["vendor_page", "hand_written", "discovered"];

export const EVENT_DATED_SOURCES: ChangeDateSource[] = ["vendor_page", "hand_written"];

function recordsSomethingWeDid(change: DatedChange): boolean {
  return isACorrectionToOurOwnRecord(change) || reportsOurIndex(change);
}

export function carriesTheDayItWasTyped(change: DatedChange): boolean {
  if (change.date_source !== "hand_written" || recordsSomethingWeDid(change)) return false;
  return !change.recorded_date || change.date === change.recorded_date;
}

export function isEventDated(change: DatedChange): boolean {
  return EVENT_DATED_SOURCES.includes(change.date_source as ChangeDateSource) && !carriesTheDayItWasTyped(change);
}

export interface DateBracket {
  from: string;
  to: string;
  from_capture: string | null;
  to_capture: string | null;
}

export function archiveBracketOf(change: DatedChange): DateBracket | null {
  if (isEventDated(change)) return null;
  const check = change.archive_check;
  if (check?.outcome !== "vendor_changed" || check.brackets?.length !== 1) return null;
  const [bracket] = check.brackets;
  const firstNew = bracket.first_new ?? null;
  const endsOnTheFirstNewCopy = firstNew !== null && firstNew <= change.date;
  return {
    from: bracket.last_old,
    to: endsOnTheFirstNewCopy ? firstNew : change.date,
    from_capture: bracket.last_old_capture ?? null,
    to_capture: endsOnTheFirstNewCopy ? bracket.first_new_capture ?? null : null,
  };
}

export function bracketedDateLabel(bracket: DateBracket, render: (date: string) => string = (date) => date): string {
  return `${BRACKETED_DATE_PREFIX} ${render(bracket.from)} and ${render(bracket.to)}`;
}

export function dayWeCorrectedIt(change: DatedChange): string | null {
  if (isEventDated(change) || !isACorrectionToOurOwnRecord(change)) return null;
  const check = change.archive_check;
  return check?.outcome === OURS_ARCHIVE_OUTCOME ? check.checked : null;
}

export function correctedDateLabel(recorded: string, corrected: string, render: (date: string) => string = (date) => date): string {
  return `${RECORDED_DATE_PREFIX} ${render(recorded)} · ${CORRECTED_DATE_PREFIX} ${render(corrected)}`;
}

export const BRACKETED_CHANGE_DATING =
  "Where archived copies of the vendor's page bracket a change, it is dated by the first copy that shows the new terms.";

export function coveringBracketedChanges(note: string, changes: readonly DatedChange[]): string {
  return changes.some((change) => archiveBracketOf(change) !== null) ? `${note} ${BRACKETED_CHANGE_DATING}` : note;
}

export function dateMeaningOf(change: DatedChange): DateMeaning {
  if (isEventDated(change)) return EFFECTIVE_DATE_PREFIX;
  return archiveBracketOf(change) ? EFFECTIVE_BY_DATE_MEANING : DISCOVERED_DATE_PREFIX;
}

export function withDateMeaningDeclared<T extends DatedChange>(change: T): T & { date_meaning: DateMeaning } {
  return { ...change, date_meaning: dateMeaningOf(change) };
}

export function partitionByDateProvenance<T extends DatedChange>(
  changes: T[]
): { dated: T[]; discovered: T[] } {
  const dated: T[] = [];
  const discovered: T[] = [];
  for (const change of changes) (isEventDated(change) ? dated : discovered).push(change);
  return { dated, discovered };
}

export function groupByMonth<T extends Pick<DealChange, "date">>(changes: T[]): Map<string, T[]> {
  const byMonth = new Map<string, T[]>();
  for (const change of changes) {
    const month = change.date.slice(0, 7);
    const bucket = byMonth.get(month);
    if (bucket) bucket.push(change);
    else byMonth.set(month, [change]);
  }
  return new Map([...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

export function monthlyChangeSeries<T extends DatedChange>(
  changes: T[]
): { effective: Map<string, T[]>; discovered: Map<string, T[]> } {
  const { dated, discovered } = partitionByDateProvenance(changes);
  return { effective: groupByMonth(dated), discovered: groupByMonth(discovered) };
}

export const EFFECTIVE_MONTH_SERIES_NOTE =
  "Each change is counted in the month its terms took effect. A change we hold no effective date for is not counted here; those are below, by the month we recorded it.";

export function discoveryMonthSeriesHeading(count: number): string {
  return `Changes With No Known Effective Date (${count})`;
}

export const DISCOVERY_MONTH_SERIES_NOTE =
  "We hold no effective date for these changes. Each is counted in the month we recorded it, so this series measures when we looked, not when the market moved. None of them are in the monthly figures above.";

export function periodComparisonSentence(
  earlier: { label: string; count: number },
  later: { label: string; count: number }
): string {
  return `${later.label} holds ${later.count} ${later.count === 1 ? "change" : "changes"} whose terms took effect in it, against ${earlier.count} in ${earlier.label}.`;
}

export interface DateWindow {
  start: string;
  end?: string;
}

export function isoWeekWindow(date: Date): DateWindow {
  const dayOfWeek = date.getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const start = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + mondayOffset)
  );
  const end = new Date(start.getTime() + 6 * 86400000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function weekRangeLabel(weekOf: string, weekEnding: string): string {
  const start = new Date(weekOf + "T00:00:00Z");
  const end = new Date(weekEnding + "T00:00:00Z");
  const startMonth = MONTH_NAMES[start.getUTCMonth()];
  const endMonth = MONTH_NAMES[end.getUTCMonth()];
  const startYear = start.getUTCFullYear();
  const endYear = end.getUTCFullYear();
  if (startYear !== endYear) {
    return `${startMonth} ${start.getUTCDate()}, ${startYear}–${endMonth} ${end.getUTCDate()}, ${endYear}`;
  }
  const tail = startMonth === endMonth ? `${end.getUTCDate()}` : `${endMonth} ${end.getUTCDate()}`;
  return `${startMonth} ${start.getUTCDate()}–${tail}, ${startYear}`;
}

export function isoWeekOf(date: Date): { year: number; week: number } {
  const monday = new Date(isoWeekWindow(date).start + "T00:00:00Z");
  const thursday = new Date(monday.getTime() + 3 * 86400000);
  const year = thursday.getUTCFullYear();
  const daysIntoYear = (thursday.getTime() - Date.UTC(year, 0, 1)) / 86400000;
  return { year, week: Math.floor(daysIntoYear / 7) + 1 };
}

export function withinWindow(date: string, window: DateWindow): boolean {
  return date >= window.start && (window.end === undefined || date <= window.end);
}

export function changesInWindow<T extends DatedChange>(
  changes: T[],
  window: DateWindow
): { dated: T[]; discovered: T[] } {
  return partitionByDateProvenance(changes.filter((c) => withinWindow(c.date, window)));
}

export function firstReadHeading(count: number): string {
  return `Effective date unknown (${count})`;
}

export function discoveryBatchNote(count: number, when: string): string {
  return count === 1
    ? `1 change recorded ${when} has no known effective date. It is dated the day we recorded it, not the day its terms took effect, so it is not counted as a change that took effect ${when}.`
    : `${count} changes recorded ${when} have no known effective date. Each is dated the day we recorded it, not the day its terms took effect, so none is counted as a change that took effect ${when}.`;
}

export const UNDATED_GROUP_NOTE =
  "We hold no effective date for these changes, so each is dated the day we recorded it; the change may have taken effect long before. They are listed by that date and are excluded from the monthly groups and the Last 30 Days count above, both of which count changes by the date they took effect.";

export const UNDATED_TILE_LABEL = "Effective Date Unknown";

export function undatedGroupHeading(count: number, heldTotal: number): string {
  const noun = sliceById("held").noun;
  return `Effective date unknown (${count} ${count === 1 ? "change" : "changes"}, of ${heldTotal.toLocaleString("en-US")} ${noun})`;
}

export function changeDateLabel(c: DatedChange): string {
  if (isEventDated(c)) return c.date;
  const bracket = archiveBracketOf(c);
  return bracket ? bracketedDateLabel(bracket) : `${DISCOVERED_DATE_PREFIX} ${c.date}`;
}

export function changeEntryDateLabelFor(c: DatedChange, render: (date: string) => string): string {
  if (isEventDated(c)) return `${EFFECTIVE_DATE_PREFIX} ${render(c.date)}`;
  const corrected = dayWeCorrectedIt(c);
  if (corrected) return correctedDateLabel(c.recorded_date ?? c.date, corrected, render);
  const bracket = archiveBracketOf(c);
  if (bracket) return bracketedDateLabel(bracket, render);
  return `${DISCOVERED_DATE_PREFIX} ${render(c.date)} · ${UNKNOWN_EFFECTIVE_DATE_MARKER}`;
}

export function changeEntryDateLabel(c: DatedChange): string {
  return changeEntryDateLabelFor(c, (date) => date);
}

export const ARCHIVE_CAPTURE_CLASS = "archive-capture";

export function changeEntryDateLabelHtml(c: DatedChange, esc: (text: string) => string): string {
  const bracket = archiveBracketOf(c);
  if (!bracket) return esc(changeEntryDateLabel(c));
  const linked = (date: string, capture: string | null) =>
    capture
      ? `<a href="${esc(capture)}" target="_blank" rel="noopener" class="${ARCHIVE_CAPTURE_CLASS}">${esc(date)}</a>`
      : esc(date);
  return `${BRACKETED_DATE_PREFIX} ${linked(bracket.from, bracket.from_capture)} and ${linked(bracket.to, bracket.to_capture)}`;
}

export function longDate(date: string): string {
  return new Date(date)
    .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    .replace(/ /g, "\u00a0");
}

export function changeEntryLongDateLabel(c: DatedChange): string {
  return changeEntryDateLabelFor(c, longDate);
}

export function changeDateClause(c: DatedChange): string {
  if (isEventDated(c)) return `on ${c.date}`;
  const bracket = archiveBracketOf(c);
  return bracket ? bracketedDateLabel(bracket) : `${DISCOVERED_DATE_PREFIX} ${c.date}`;
}

export function changeDatePublished(c: DatedChange): { datePublished: string } | Record<string, never> {
  return isEventDated(c) ? { datePublished: c.date } : {};
}

export function changeEventStartDate(c: DatedChange): { startDate: string } | Record<string, never> {
  return isEventDated(c) ? { startDate: c.date } : {};
}

export function capListSections<T>(sections: T[][], cap: number): T[] {
  const allotted = sections.map(() => 0);
  let budget = cap;
  for (let i = 0; i < sections.length && budget > 0; i++) {
    if (sections[i].length === 0) continue;
    allotted[i] = 1;
    budget -= 1;
  }
  for (let i = 0; i < sections.length && budget > 0; i++) {
    const take = Math.min(budget, sections[i].length - allotted[i]);
    allotted[i] += take;
    budget -= take;
  }
  return sections.flatMap((section, i) => section.slice(0, allotted[i]));
}

export function feedEntryUpdated(day: string, now: Date = new Date()): string {
  const served = now.toISOString().slice(0, 10);
  const stamped = /^\d{4}-\d{2}-\d{2}$/.test(day) && day < served ? day : served;
  const noon = Date.parse(`${stamped}T12:00:00Z`);
  return new Date(noon <= now.getTime() ? noon : Date.parse(`${stamped}T00:00:00Z`)).toISOString();
}

export function endsTheListedOffer(change: ExpiringChange): boolean {
  if (change.change_type === PRODUCT_DEPRECATED) return deprecationEndsTheListedProduct(change);
  return NEGATIVE_CHANGE_TYPES.has(change.change_type);
}

export function offerExpiryAfter(changes: ExpiringChange[], onDate: string): string | null {
  let earliest: string | null = null;
  for (const c of changes) {
    if (!c.date || c.date <= onDate) continue;
    if (!isEventDated(c)) continue;
    if (!endsTheListedOffer(c)) continue;
    if (earliest === null || c.date < earliest) earliest = c.date;
  }
  return earliest;
}

export function latestEventDate(changes: DatedChange[], notAfter: string = new Date().toISOString().slice(0, 10)): string | null {
  let latest: string | null = null;
  for (const c of changes) {
    if (!c.date || !isEventDated(c)) continue;
    if (c.date > notAfter) continue;
    if (latest === null || c.date > latest) latest = c.date;
  }
  return latest;
}

export function vendorPageLastUpdated(changes: DatedChange[], lastRead: string, servedOn: string): string {
  const lastChange = latestEventDate(changes, servedOn);
  return lastChange && lastChange > lastRead ? lastChange : lastRead;
}

export const ANNOUNCED_HEADING = "Announced, not yet in effect";

export const ANNOUNCED_BADGE = "Announced";

export function hasNotTakenEffect(change: Pick<DealChange, "date">, asOf: string): boolean {
  return change.date > asOf;
}

export function newestChangeInEffect<T extends Pick<DealChange, "date">>(changes: readonly T[], asOf: string): T | null {
  let newest: T | null = null;
  for (const c of changes) {
    if (hasNotTakenEffect(c, asOf)) continue;
    if (newest === null || c.date > newest.date) newest = c;
  }
  return newest;
}

export function announcedIntro(count: number, asOf: string): string {
  const subject = count === 1 ? "One record here carries" : `${count} records here carry`;
  const verb = count === 1 ? "it has" : "they have";
  return `${subject} a date after ${asOf}. The vendor has announced ${count === 1 ? "it" : "them"} and ${verb} not taken effect, so ${count === 1 ? "it is" : "they are"} not part of the history below.`;
}

export const A_DATED_SECTION_MARKER =
  "What this section prints is decided by the calendar, not by anything the vendor did.";

export const A_DATED_HEADING_MARKER =
  "A date in a heading below cites a record we hold, not a property of the vendor it names.";

export interface DatedSectionDestination {
  when: string;
  text: string;
  href: string;
}

export function datedSectionNoticeHtml(
  rule: string,
  destinations: readonly DatedSectionDestination[],
  esc: (text: string) => string,
  attributes = ' class="dated-rule"',
): string {
  const whereToLook = destinations
    .map((d) => `${esc(d.when)} <a href="${d.href}">${esc(d.text)}</a>.`)
    .join(" ");
  return `<p${attributes}>${esc(A_DATED_SECTION_MARKER)} ${esc(rule)} ${whereToLook}</p>`;
}

export function datedHeadingNoticeHtml(
  rule: string,
  destinations: readonly DatedSectionDestination[],
  esc: (text: string) => string,
  attributes = ' class="dated-rule"',
): string {
  const whereToLook = destinations
    .map((d) => `${esc(d.when)} <a href="${d.href}">${esc(d.text)}</a>.`)
    .join(" ");
  return `<p${attributes}>${esc(A_DATED_HEADING_MARKER)} ${esc(rule)} ${whereToLook}</p>`;
}

export const WHICH_DATE_WE_HOLD =
  "That date is the effective date where the vendor states one, and the day we discovered the change where the vendor does not.";

export function namedWhileAheadOf(subject: string, asOf: string): string {
  return `${subject} is named here only while the date we hold for it is later than ${asOf}. ${WHICH_DATE_WE_HOLD}`;
}

export const ONLY_EFFECTIVE_DATES_LISTED =
  "Only changes with a known effective date are listed. Changes we found by reading a vendor's page, with no effective date, are in the full change log.";

export function namedFromItsDate(subject: string, asOf: string): string {
  return `${subject} is named here only once the date we hold for it has arrived, on or before ${asOf}.`;
}

export function namedOnceItsDateArrived(subject: string, asOf: string): string {
  return `${namedFromItsDate(subject, asOf)} ${ONLY_EFFECTIVE_DATES_LISTED}`;
}

export function namedWhileNotBefore(subject: string, asOf: string): string {
  return `${subject} is named here only while its effective date is ${asOf} or later.`;
}

import { compiledClause, getPageReview, utcToday, type PageReviewRecord } from "./page-reviews.js";

export const FRESHNESS_TOKEN = "[[freshness]]";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function monthOf(isoDate: string): string {
  const parts = ISO_DATE.exec(isoDate);
  if (!parts) return "";
  const name = MONTH_NAMES[Number(parts[2]) - 1];
  return name === undefined ? "" : `${name} ${parts[1]}`;
}

function yearOf(monthAndYear: string): string {
  return monthAndYear.slice(monthAndYear.lastIndexOf(" ") + 1);
}

export const FRESHNESS_VERB = "Verified";

export function verifiedSpanClaim(verifiedDates: readonly string[]): string {
  const dated = verifiedDates.filter(date => monthOf(date) !== "").sort();
  if (dated.length === 0) return "";
  const earliest = monthOf(dated[0]!);
  const latest = monthOf(dated[dated.length - 1]!);
  if (earliest === latest) return `${FRESHNESS_VERB} ${earliest}.`;
  const opening = yearOf(earliest) === yearOf(latest)
    ? earliest.slice(0, earliest.lastIndexOf(" "))
    : earliest;
  return `${FRESHNESS_VERB} ${opening} to ${latest}.`;
}

const VENDOR_HREF = /href="\/vendor\/([a-z0-9][a-z0-9-]*)"/g;

export function vendorSlugsLinkedFrom(html: string): string[] {
  return [...new Set(Array.from(html.matchAll(VENDOR_HREF), match => match[1]!))].sort();
}

export type VerifiedDatesForSlug = (vendorSlug: string) => readonly string[];

export function compiledClaimFor(review: PageReviewRecord, today: string): string {
  const clause = compiledClause(review, today);
  return clause === "" ? "" : `${clause}.`;
}

export function freshnessClaimFor(
  pagePath: string,
  html: string,
  verifiedDatesForSlug: VerifiedDatesForSlug,
  today: string = utcToday(),
  reviewFor: (pagePath: string) => PageReviewRecord | null = getPageReview,
): string {
  const review = reviewFor(pagePath);
  if (review && !review.reads_index) return compiledClaimFor(review, today);
  return verifiedSpanClaim(vendorSlugsLinkedFrom(html).flatMap(slug => [...verifiedDatesForSlug(slug)]));
}

export function claimsFreshness(html: string): boolean {
  return html.includes(FRESHNESS_TOKEN);
}

export function withFreshnessClaim(html: string, claimFor: () => string): string {
  if (!claimsFreshness(html)) return html;
  const claim = claimFor();
  if (claim === "") return html.split(` ${FRESHNESS_TOKEN}`).join("").split(FRESHNESS_TOKEN).join("");
  return html.split(FRESHNESS_TOKEN).join(claim);
}

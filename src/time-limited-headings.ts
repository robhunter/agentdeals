import type { TimeLimitedKind } from "./ranking.js";

const OFFER_NAME: Record<TimeLimitedKind, string> = {
  credit: "Free Credits",
  trial: "Free Trial",
  scholarship: "Scholarship",
  preview: "Free Preview",
};

const HOW_IT_ENDS: Record<TimeLimitedKind, string> = {
  credit: "Run Out",
  trial: "Ends",
  scholarship: "Ends",
  preview: "Ends",
};

const WHAT_FOLLOWS_THE_OFFER: Record<TimeLimitedKind, string | null> = {
  credit: "When credits run out or expire, you must pay for further use.",
  trial: "When the trial ends, you must pay for further use.",
  scholarship: "When the award period ends, you must pay for further use.",
  preview: null,
};

export function timeLimitedHeadline(vendorName: string, kind: TimeLimitedKind, year: number): string {
  return `${vendorName} ${OFFER_NAME[kind]} ${year}`;
}

export function timeLimitedSectionHeading(vendorName: string, kind: TimeLimitedKind): string {
  return `When ${vendorName}'s ${OFFER_NAME[kind]} ${HOW_IT_ENDS[kind]}`;
}

export function whatFollowsTheOffer(kind: TimeLimitedKind): string | null {
  return WHAT_FOLLOWS_THE_OFFER[kind];
}

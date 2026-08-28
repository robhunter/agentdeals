import type { Offer, SourceCheck, SourceCheckOutcome } from "./types.js";

export const SOURCE_CHECK_OUTCOMES: SourceCheckOutcome[] = [
  "ok",
  "does_not_name_vendor",
  "states_no_terms",
  "unreadable",
];

export function sourceDoesNotNameVendor(offer: Pick<Offer, "source_check">): boolean {
  return offer.source_check?.outcome === "does_not_name_vendor";
}

export function sourceCheckNotice(offer: Pick<Offer, "source_check">): SourceCheck | null {
  const check = offer.source_check;
  if (!check || check.outcome === "ok") return null;
  return check;
}

export function cannotVouchForLevel(
  offer: Pick<Offer, "source_check">,
  linkUnreachable: unknown,
): boolean {
  return Boolean(linkUnreachable) || sourceDoesNotNameVendor(offer);
}

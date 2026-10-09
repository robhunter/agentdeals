import type { DealChange, Offer } from "./types.js";

export interface ProgrammeListing {
  vendor: string;
  tier: string;
}

export const STARTUP_PROGRAMME_LISTINGS: readonly ProgrammeListing[] = [
  { vendor: "AWS Activate", tier: "Startup Credits" },
  { vendor: "Google for Startups Cloud Program", tier: "Startup Credits" },
  { vendor: "Microsoft for Startups", tier: "Startup Credits" },
  { vendor: "DigitalOcean", tier: "Startup Credits" },
  { vendor: "Cloudflare for Startups", tier: "Startup Credits" },
  { vendor: "Stripe Atlas", tier: "Paid" },
  { vendor: "Brex Partner Perks", tier: "Startup Credits" },
  { vendor: "Mercury Perks", tier: "Startup Credits" },
  { vendor: "Ramp Partner Rewards", tier: "Startup Credits" },
  { vendor: "SVB Startup Banking Offers", tier: "Startup Credits" },
  { vendor: "PostHog", tier: "Startup Credits" },
  { vendor: "Amazon Kiro (AWS Startups)", tier: "Startup Credits" },
  { vendor: "Amplitude", tier: "Startup Scholarship" },
  { vendor: "Segment Startup Program", tier: "Startup Credits" },
];

export function listingCountsByVendor(offers: readonly Pick<Offer, "vendor">[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const offer of offers) counts.set(offer.vendor, (counts.get(offer.vendor) ?? 0) + 1);
  return counts;
}

export function isAboutListing(change: Pick<DealChange, "vendor" | "tier">, listing: ProgrammeListing, listingsOfVendor: number): boolean {
  if (change.vendor !== listing.vendor) return false;
  return listingsOfVendor <= 1 || change.tier === listing.tier;
}

export function changesToStartupProgrammes<T extends Pick<DealChange, "vendor" | "tier">>(
  changes: readonly T[],
  offers: readonly Pick<Offer, "vendor">[],
  listings: readonly ProgrammeListing[] = STARTUP_PROGRAMME_LISTINGS,
): T[] {
  const counts = listingCountsByVendor(offers);
  return changes.filter(change => listings.some(listing => isAboutListing(change, listing, counts.get(listing.vendor) ?? 0)));
}

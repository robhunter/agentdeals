import type { DealChange, Offer } from "./types.js";

export interface ProgrammeListing {
  vendor: string;
  tier: string;
}

export const STARTUP_PROGRAMME_LISTINGS: readonly ProgrammeListing[] = [
  { vendor: "AWS Activate", tier: "Portfolio" },
  { vendor: "Google Cloud", tier: "Startup Program" },
  { vendor: "Microsoft for Startups", tier: "Startup Program" },
  { vendor: "Microsoft Founders Hub", tier: "Startup Program" },
  { vendor: "DigitalOcean", tier: "Hatch" },
  { vendor: "Cloudflare for Startups", tier: "Startup Program" },
  { vendor: "Stripe Atlas", tier: "Founder Perks" },
  { vendor: "Brex", tier: "Partner Perks" },
  { vendor: "Mercury", tier: "Banking Perks" },
  { vendor: "Ramp", tier: "Partner Rewards" },
  { vendor: "SVB (Silicon Valley Bank)", tier: "Banking Offers" },
  { vendor: "PostHog", tier: "YC Deal" },
  { vendor: "Amazon Kiro (AWS Startups)", tier: "Startup Program" },
  { vendor: "Amplitude", tier: "Startup Scholarship" },
  { vendor: "Segment", tier: "Startup Program" },
  { vendor: "IBM Cloud", tier: "Startup Program" },
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

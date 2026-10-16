export function vendorsWhoseEveryListingHolds<T extends { vendor: string }>(
  listings: readonly T[],
  holds: (listing: T) => boolean,
): string[] {
  const vendors = [...new Set(listings.map((listing) => listing.vendor))];
  return vendors.filter((vendor) => listings.filter((listing) => listing.vendor === vendor).every(holds));
}

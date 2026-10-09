import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toSlug } from "./slug.js";

export interface RemovedListing {
  vendor: string;
  successor?: string;
}

export type RemovedListingAnswer =
  | { status: 301; slug: string }
  | { status: 410; vendor: string };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function removedListingsPath(): string {
  return process.env.AGENTDEALS_REMOVED_LISTINGS_PATH || path.join(__dirname, "..", "data", "removed_listings.json");
}

export function parseRemovedListings(text: string, source: string): RemovedListing[] {
  const data = JSON.parse(text) as { removed?: unknown };
  if (!Array.isArray(data.removed)) throw new Error(`${source} carries no removed array`);
  return data.removed.map((entry, i) => {
    const { vendor, successor } = (entry ?? {}) as { vendor?: unknown; successor?: unknown };
    if (typeof vendor !== "string" || !toSlug(vendor)) throw new Error(`${source} entry ${i} names no vendor`);
    if (successor !== undefined && (typeof successor !== "string" || !toSlug(successor))) {
      throw new Error(`${source} entry ${i} (${vendor}) gives a successor that is not a vendor name`);
    }
    return successor === undefined ? { vendor } : { vendor, successor };
  });
}

export function loadRemovedListings(file: string = removedListingsPath()): RemovedListing[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    console.error(`Removed listings not readable at ${file}: ${err}`);
    return [];
  }
  return parseRemovedListings(text, file);
}

export function removedListingsBySlug(listings: readonly RemovedListing[]): Map<string, RemovedListing> {
  return new Map(listings.map(listing => [toSlug(listing.vendor), listing]));
}

export function removedListingAnswer(
  slug: string,
  removed: ReadonlyMap<string, RemovedListing>,
  liveSlugs: { has(slug: string): boolean },
  endedSlugs: { has(slug: string): boolean },
): RemovedListingAnswer | null {
  if (liveSlugs.has(slug)) return null;
  const listing = removed.get(slug);
  if (!listing) return null;
  const successor = listing.successor === undefined ? null : toSlug(listing.successor);
  if (successor && liveSlugs.has(successor) && !endedSlugs.has(successor)) return { status: 301, slug: successor };
  return { status: 410, vendor: listing.vendor };
}

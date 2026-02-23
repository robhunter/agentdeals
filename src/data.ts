import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Offer, OfferIndex } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, "..", "data", "index.json");

let cachedOffers: Offer[] | null = null;

export function loadOffers(): Offer[] {
  if (cachedOffers) return cachedOffers;

  if (!fs.existsSync(INDEX_PATH)) {
    console.error(`Data index not found at ${INDEX_PATH}, using empty offer list`);
    cachedOffers = [];
    return cachedOffers;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(INDEX_PATH, "utf-8");
  } catch (err) {
    console.error(`Failed to read data index: ${err}`);
    cachedOffers = [];
    return cachedOffers;
  }

  let data: OfferIndex;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`Data index contains malformed JSON: ${err}`);
    cachedOffers = [];
    return cachedOffers;
  }

  if (!data || !Array.isArray(data.offers)) {
    console.error("Data index is missing 'offers' array, using empty offer list");
    cachedOffers = [];
    return cachedOffers;
  }

  cachedOffers = data.offers;
  return cachedOffers;
}

export function resetCache(): void {
  cachedOffers = null;
}

export function getCategories(): { name: string; count: number }[] {
  const offers = loadOffers();
  const categoryMap = new Map<string, number>();

  for (const offer of offers) {
    categoryMap.set(offer.category, (categoryMap.get(offer.category) ?? 0) + 1);
  }

  return Array.from(categoryMap.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function searchOffers(
  query?: string,
  category?: string
): Offer[] {
  let results = loadOffers();

  if (category) {
    const lowerCategory = category.toLowerCase();
    results = results.filter(
      (o) => o.category.toLowerCase() === lowerCategory
    );
  }

  if (query) {
    const terms = query.toLowerCase().split(/\s+/);
    results = results.filter((offer) => {
      const searchable = [
        offer.vendor,
        offer.description,
        offer.category,
        ...offer.tags,
      ]
        .join(" ")
        .toLowerCase();
      return terms.every((term) => searchable.includes(term));
    });
  }

  return results;
}

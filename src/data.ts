import fs from "node:fs";
import path from "node:path";
import type { Offer, OfferIndex } from "./types.js";

const INDEX_PATH = path.join(__dirname, "..", "data", "index.json");

let cachedOffers: Offer[] | null = null;

export function loadOffers(): Offer[] {
  if (cachedOffers) return cachedOffers;

  if (!fs.existsSync(INDEX_PATH)) {
    cachedOffers = [];
    return cachedOffers;
  }

  const raw = fs.readFileSync(INDEX_PATH, "utf-8");
  const data: OfferIndex = JSON.parse(raw);
  cachedOffers = data.offers ?? [];
  return cachedOffers;
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

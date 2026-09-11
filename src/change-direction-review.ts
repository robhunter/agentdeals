import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DealChange, TierDirection } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DIRECTIONS_PATH =
  process.env.AGENTDEALS_CHANGE_DIRECTIONS_PATH ||
  path.join(__dirname, "..", "data", "change_directions.json");

export interface ReviewedDirection {
  vendor: string;
  change_type: string;
  date: string;
  source_url: string;
  tier_direction: TierDirection;
  finding: string;
}

export interface DirectionReview {
  reviewed: string;
  review: string;
  directions: ReviewedDirection[];
}

export interface ReviewedRecord {
  vendor: string;
  change_type: string;
  date: string;
  source_url: string;
}

const TIER_DIRECTIONS: readonly string[] = ["narrowed", "unchanged", "widened"];

export function isTierDirection(value: unknown): value is TierDirection {
  return typeof value === "string" && TIER_DIRECTIONS.includes(value);
}

export function reviewKey(record: ReviewedRecord): string {
  return [
    record.vendor.trim().toLowerCase(),
    record.change_type,
    record.date,
    (record.source_url ?? "").trim(),
  ].join("|");
}

let cachedReview: DirectionReview | null = null;

export function loadDirectionReview(): DirectionReview {
  if (cachedReview) return cachedReview;
  cachedReview = readDirectionReview(DIRECTIONS_PATH);
  return cachedReview;
}

export function readDirectionReview(filePath: string): DirectionReview {
  const empty: DirectionReview = { reviewed: "", review: "", directions: [] };
  if (!fs.existsSync(filePath)) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    console.error(`Change-direction review contains malformed JSON: ${err}`);
    return empty;
  }
  const review = parsed as Partial<DirectionReview>;
  if (!review || !Array.isArray(review.directions)) {
    console.error("Change-direction review is missing 'directions' array, using empty list");
    return empty;
  }
  return {
    reviewed: typeof review.reviewed === "string" ? review.reviewed : "",
    review: typeof review.review === "string" ? review.review : "",
    directions: review.directions.filter((entry) => isTierDirection(entry?.tier_direction)),
  };
}

export function directionsByRecord(
  directions: readonly ReviewedDirection[],
): Map<string, ReviewedDirection> {
  const byRecord = new Map<string, ReviewedDirection>();
  for (const entry of directions) byRecord.set(reviewKey(entry), entry);
  return byRecord;
}

export function applyReviewedDirections<T extends DealChange>(
  changes: readonly T[],
  directions: readonly ReviewedDirection[] = loadDirectionReview().directions,
): T[] {
  const byRecord = directionsByRecord(directions);
  return changes.map((change) => {
    if (isTierDirection(change.tier_direction)) return change;
    const reviewed = byRecord.get(reviewKey(change));
    return reviewed ? { ...change, tier_direction: reviewed.tier_direction } : change;
  });
}

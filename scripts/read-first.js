import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { offerKey } from "./change-refusals.js";
import { FREE_PLAN_EXCERPT, anExcerptMayBeWritten } from "./free-plan-excerpt.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_READ_FIRST_PATH = resolve(__dirname, "..", "data", "read_first.json");

export const MATCHES_NO_LISTING = "matches no listing";
export const TAKES_NO_QUOTE = "its listing takes no quote";
export const IN_QUARANTINE = "in quarantine";

export function readFirstPath() {
  return process.env.AGENTDEALS_READ_FIRST_PATH || DEFAULT_READ_FIRST_PATH;
}

export function readReadFirstList(path = readFirstPath()) {
  let text;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    return { listings: [], problem: err?.code === "ENOENT" ? null : err.message };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { listings: [], problem: `${path} is not JSON: ${err.message}` };
  }
  if (!Array.isArray(parsed?.listings)) return { listings: [], problem: `${path} holds no "listings" array` };
  return { listings: parsed.listings, problem: null };
}

export function placesOnTheReadFirstList(listings, offers) {
  const places = new Map();
  const unmatched = [];
  const since = new Map();
  listings.forEach((listing, place) => {
    const matches = offers.filter((offer) => offer?.vendor === listing?.vendor && offer?.tier === listing?.tier);
    if (matches.length === 0) unmatched.push({ vendor: listing?.vendor, tier: listing?.tier, why: MATCHES_NO_LISTING, ...(listing && Object.hasOwn(listing, "since") ? { since: listing.since } : {}) });
    for (const offer of matches) {
      const key = offerKey(offer.vendor, offer.url);
      if (!places.has(key)) {
        places.set(key, place);
        if (Object.hasOwn(listing, "since")) since.set(key, listing.since);
      }
    }
  });
  return { places, since, unmatched };
}

export function holdsAQuote(offer) {
  return offer != null && FREE_PLAN_EXCERPT in offer;
}

export function drawnFirstForAQuote(offer, place) {
  return place !== undefined && !holdsAQuote(offer) && anExcerptMayBeWritten(offer);
}

export function readFirstLines(picked, queued, notDrawnFirst = []) {
  if (queued === undefined) return [];
  const lines = [`Drawn first from the read-first list: ${picked} of ${queued}`];
  if (notDrawnFirst.length > 0) {
    lines.push(`On the read-first list and not drawn first for a quote: ${notDrawnFirst.length}`);
    for (const { vendor, tier, why } of notDrawnFirst) lines.push(`  ${vendor} (${tier}): ${why}`);
  }
  return lines;
}

export function whyNotReadSince(since, attempted, today) {
  if (typeof since !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(since)
      || !Number.isFinite(Date.parse(since)) || new Date(since).toISOString().slice(0, 10) !== since) {
    return "since must be a valid YYYY-MM-DD date";
  }
  if (since > today) return `since ${since} is in the future`;
  if (attempted && attempted.slice(0, 10) >= since) return `last attempt ${attempted} is on or after ${since}`;
  return null;
}

export function markedReadFirstLines(entries) {
  return entries.map(({ vendor, tier, since, drawn, why }) =>
    `Read-first mark: ${vendor} (${tier}), since ${JSON.stringify(since)}: ${drawn ? `drawn${why ? ` in age queue — ${why}` : ""}` : `not drawn — ${why}`}`);
}

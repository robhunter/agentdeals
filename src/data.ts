import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Offer, EnrichedOffer, OfferIndex, DealChange, DealChangesIndex, StabilityClass, Referral, RiskCause, LinkUnreachable } from "./types.js";
import { isUrlSuspended } from "./referral-health.js";
import { rankForListing } from "./ranking.js";
import { unreachableNoticeForUrl, resetLinkHealthCache } from "./link-health.js";
import { filterAlternatives } from "./product-role.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, "..", "data", "index.json");
const CHANGES_PATH = path.join(__dirname, "..", "data", "deal_changes.json");

let cachedOffers: Offer[] | null = null;
let cachedChanges: DealChange[] | null = null;

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
  cachedChanges = null;
  resetLinkHealthCache();
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

export function getOfferDetails(
  vendorName: string,
  includeAlternatives: boolean = false
): { offer: Offer & { relatedVendors: string[]; alternatives?: Offer[] } } | { error: string; suggestions: string[] } {
  const offers = loadOffers();
  const lowerName = vendorName.toLowerCase();
  const match = offers.find((o) => o.vendor.toLowerCase() === lowerName);

  if (match) {
    // Related vendors and alternatives are a recommendation, so they resolve
    // through the shared selection module (#1025) rather than `.slice(0, 5)`
    // over data/index.json order.
    const sameCategoryOffers = rankForListing(
      filterAlternatives(offers.filter((o) => o.category === match.category && o.vendor !== match.vendor), match),
      { queryKey: `related:${match.category}:${match.vendor}`, changes: loadDealChanges() },
    ).entries.slice(0, 5).map((e) => e.offer);
    const relatedVendors = sameCategoryOffers.map((o) => o.vendor);
    const result: Offer & { relatedVendors: string[]; alternatives?: Offer[] } = { ...match, relatedVendors };
    if (includeAlternatives) {
      result.alternatives = sameCategoryOffers.map(o => stripReferrerValue(o));
    }
    return { offer: stripReferrerValue(result) };
  }

  // No exact match — suggest similar vendors
  const suggestions = offers
    .filter((o) => o.vendor.toLowerCase().includes(lowerName) || lowerName.includes(o.vendor.toLowerCase()))
    .slice(0, 5)
    .map((o) => o.vendor);

  return {
    error: `Vendor "${vendorName}" not found.`,
    suggestions: suggestions.length > 0 ? suggestions : [],
  };
}

function scoreOffer(offer: Offer, terms: string[]): number {
  let score = 0;
  const vendorLower = offer.vendor.toLowerCase();
  const categoryLower = offer.category.toLowerCase();
  const tagsLower = offer.tags.map((t) => t.toLowerCase());
  const descLower = offer.description.toLowerCase();

  for (const term of terms) {
    // Vendor name match (highest weight)
    if (vendorLower === term) {
      score += 100; // exact vendor name match
    } else if (vendorLower.includes(term)) {
      score += 50; // partial vendor name match
    }

    // Category name match (high weight)
    if (categoryLower === term) {
      score += 80;
    } else if (categoryLower.includes(term)) {
      score += 40;
    }

    // Tag match (medium weight)
    if (tagsLower.some((tag) => tag === term)) {
      score += 30; // exact tag match
    } else if (tagsLower.some((tag) => tag.includes(term))) {
      score += 15; // partial tag match
    }

    // Description match (lowest weight)
    if (descLower.includes(term)) {
      score += 5;
    }
  }

  return score;
}

/**
 * Strip special characters from search queries that break matching.
 * Keeps alphanumeric, hyphens, spaces, dots, and plus signs.
 */
export function sanitizeQuery(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9\s.\-+]/g, "").replace(/\s+/g, " ").trim();
}

export function searchOffers(
  query?: string,
  category?: string,
  eligibilityType?: string,
  sort?: string,
  stability?: StabilityClass,
  paymentProtocol?: string
): Offer[] {
  let results = loadOffers();

  if (category) {
    const lowerCategory = category.toLowerCase();
    results = results.filter(
      (o) => o.category.toLowerCase() === lowerCategory
    );
  }

  if (eligibilityType) {
    const lowerType = eligibilityType.toLowerCase();
    results = results.filter(
      (o) => o.eligibility?.type.toLowerCase() === lowerType
    );
  }

  if (stability) {
    const stabilityMap = getStabilityMap();
    results = results.filter(
      (o) => (stabilityMap.get(o.vendor.toLowerCase()) ?? "stable") === stability
    );
  }

  if (paymentProtocol) {
    const lowerProto = paymentProtocol.toLowerCase();
    results = results.filter(
      (o) => o.payment_protocols?.some(p => p.protocol.toLowerCase() === lowerProto) ?? false
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

    // Rank by relevance when no explicit sort requested
    if (!sort) {
      const scores = new Map<Offer, number>();
      for (const offer of results) {
        scores.set(offer, scoreOffer(offer, terms));
      }
      results = [...results].sort((a, b) => scores.get(b)! - scores.get(a)!);
    }
  }

  if (sort === "vendor") {
    results = [...results].sort((a, b) => a.vendor.localeCompare(b.vendor));
  } else if (sort === "category") {
    results = [...results].sort((a, b) =>
      a.category.localeCompare(b.category) || a.vendor.localeCompare(b.vendor)
    );
  } else if (sort === "newest") {
    results = [...results].sort((a, b) =>
      b.verifiedDate.localeCompare(a.verifiedDate)
    );
  }

  return results;
}

/**
 * Which way a change points for the user. One table, because before #1038
 * five copies of this idea existed in the codebase and they had drifted:
 * `classifyStability` counted `pricing_model_change` as neither negative nor
 * positive (so Xata retiring its SaaS free tier read as `stable`) and left
 * `new_tier` out of the positive set, while the weekly digest had its own two
 * lists that disagreed with both.
 *
 * Direction is not the same question as risk. RISK_DEMOTION below is stricter:
 * it decides what we are willing to publish a warning label for. This table
 * decides what we are willing to *call* negative. The invariant between them —
 * nothing RISK_DEMOTION demotes may be positive or neutral here — is asserted
 * in risk-badge.test.ts.
 */
export const CHANGE_DIRECTION: Record<DealChange["change_type"], "negative" | "positive" | "neutral"> = {
  free_tier_removed: "negative",
  open_source_killed: "negative",
  product_deprecated: "negative",
  limits_reduced: "negative",
  restriction: "negative",
  pricing_restructured: "negative",
  pricing_model_change: "negative",
  limits_increased: "positive",
  new_free_tier: "positive",
  new_tier: "positive",
  startup_program_expanded: "positive",
  pricing_postponed: "positive",
  rebranded: "neutral",
};

const directionSet = (d: "negative" | "positive" | "neutral") =>
  new Set(Object.entries(CHANGE_DIRECTION).filter(([, v]) => v === d).map(([k]) => k));

export const NEGATIVE_CHANGE_TYPES = directionSet("negative");
export const POSITIVE_CHANGE_TYPES = directionSet("positive");

/** Severity, not direction: the negatives that end a free tier outright. */
const VOLATILE_TYPES = new Set([
  "free_tier_removed",
  "open_source_killed",
  "product_deprecated",
]);

/** The two the risk scale treats as severe. Exported so no caller inlines them. */
export const SEVERE_CHANGE_TYPES = new Set(["free_tier_removed", "open_source_killed"]);

const NEGATIVE_STABILITY_TYPES = NEGATIVE_CHANGE_TYPES;
const POSITIVE_STABILITY_TYPES = POSITIVE_CHANGE_TYPES;

export function classifyStability(vendorChanges: DealChange[]): StabilityClass {
  if (vendorChanges.length === 0) return "stable";

  const hasVolatile = vendorChanges.some(c => VOLATILE_TYPES.has(c.change_type));
  const negativeCount = vendorChanges.filter(c => NEGATIVE_STABILITY_TYPES.has(c.change_type)).length;
  const positiveCount = vendorChanges.filter(c => POSITIVE_STABILITY_TYPES.has(c.change_type)).length;

  // Volatile: free tier removed, OSS killed, product deprecated, or multiple negative changes
  if (hasVolatile || negativeCount >= 2) return "volatile";

  // Improving: only positive changes (no negative)
  if (positiveCount > 0 && negativeCount === 0) return "improving";

  // Watch: one negative change
  if (negativeCount === 1) return "watch";

  // No negative or positive (e.g. only pricing_model_change) = stable
  return "stable";
}

// Build a map of vendor name (lowercase) → stability class from deal_changes
export function getStabilityMap(): Map<string, StabilityClass> {
  const changes = loadDealChanges();
  const vendorChangesMap = new Map<string, DealChange[]>();
  for (const c of changes) {
    const key = c.vendor.toLowerCase();
    if (!vendorChangesMap.has(key)) vendorChangesMap.set(key, []);
    vendorChangesMap.get(key)!.push(c);
  }

  const result = new Map<string, StabilityClass>();
  for (const [vendor, vendorChanges] of vendorChangesMap) {
    result.set(vendor, classifyStability(vendorChanges));
  }
  return result;
}

export function enrichOffers(offers: Offer[]): EnrichedOffer[] {
  const changes = loadDealChanges();
  const now = new Date();
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(now.getTime() - ninetyDaysMs).toISOString().slice(0, 10);

  // Build vendor → changes map (only recent changes within 90 days)
  const vendorChanges = new Map<string, DealChange[]>();
  for (const c of changes) {
    if (c.date >= cutoffDate) {
      const key = c.vendor.toLowerCase();
      if (!vendorChanges.has(key)) vendorChanges.set(key, []);
      vendorChanges.get(key)!.push(c);
    }
  }

  // Build vendor → all changes for risk assessment and stability classification
  const vendorAllChangesList = new Map<string, DealChange[]>();
  for (const c of changes) {
    const key = c.vendor.toLowerCase();
    if (!vendorAllChangesList.has(key)) vendorAllChangesList.set(key, []);
    vendorAllChangesList.get(key)!.push(c);
  }

  return offers.map((offer) => {
    const key = offer.vendor.toLowerCase();

    // recent_change: most recent change within 90 days
    const recentChanges = vendorChanges.get(key);
    let recent_change: string | null = null;
    if (recentChanges && recentChanges.length > 0) {
      const mostRecent = recentChanges.sort((a, b) => b.date.localeCompare(a.date))[0];
      recent_change = `${mostRecent.date}: ${mostRecent.summary}`;
    }

    // expires_soon: flag if expires within 90 days
    let expires_soon: string | null = null;
    if (offer.expires_date) {
      const expiresMs = new Date(offer.expires_date).getTime() - now.getTime();
      if (expiresMs > 0 && expiresMs <= ninetyDaysMs) {
        expires_soon = `Expires: ${offer.expires_date}`;
      }
    }

    // risk_level: the single definition in vendorRiskAssessment (#1038). It
    // used to be a count of every change record of every type, which measured
    // how closely we had watched the vendor rather than anything about the
    // vendor. The cause travels with the level so no surface can render the
    // warning without the dated fact behind it.
    const assessment = vendorRiskAssessment(vendorAllChangesList.get(key) ?? []);
    const link_unreachable = unreachableNoticeForUrl(offer.url, now.getTime());
    const risk_level = link_unreachable && assessment.level === "stable" ? null : assessment.level;
    const risk_cause = assessment.cause
      ? { date: assessment.cause.date, change_type: assessment.cause.change_type, summary: assessment.cause.summary }
      : null;

    // stability: derived from change types, not just count
    const stability = classifyStability(vendorAllChangesList.get(key) ?? []);

    const days_since_verified = Math.floor(
      (now.getTime() - new Date(offer.verifiedDate).getTime()) / (24 * 60 * 60 * 1000)
    );

    const enriched = { ...offer, recent_change, expires_soon, risk_level, risk_cause, stability, days_since_verified, link_unreachable };
    return stripReferrerValue(enriched);
  });
}

export function getNewOffers(days: number = 7): { offers: Offer[]; total: number } {
  const clampedDays = Math.min(Math.max(days, 1), 30);
  const cutoff = new Date(Date.now() - clampedDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const offers = loadOffers();
  const results = offers
    .filter((o) => o.verifiedDate >= cutoff)
    .sort((a, b) => b.verifiedDate.localeCompare(a.verifiedDate))
    .map(o => stripReferrerValue(o));
  return { offers: results, total: results.length };
}

export function loadDealChanges(): DealChange[] {
  if (cachedChanges) return cachedChanges;

  if (!fs.existsSync(CHANGES_PATH)) {
    console.error(`Deal changes file not found at ${CHANGES_PATH}, using empty list`);
    cachedChanges = [];
    return cachedChanges;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(CHANGES_PATH, "utf-8");
  } catch (err) {
    console.error(`Failed to read deal changes: ${err}`);
    cachedChanges = [];
    return cachedChanges;
  }

  let data: DealChangesIndex;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`Deal changes contains malformed JSON: ${err}`);
    cachedChanges = [];
    return cachedChanges;
  }

  if (!data || !Array.isArray(data.changes)) {
    console.error("Deal changes is missing 'changes' array, using empty list");
    cachedChanges = [];
    return cachedChanges;
  }

  cachedChanges = data.changes;
  return cachedChanges;
}

export interface ChangeLogFreshness {
  total: number;
  last_recorded_date: string | null;
  days_since_last_recorded: number | null;
  last_detected_date: string | null;
  days_since_last_detected: number | null;
  recorded_last_30_days: number;
  machine_detected_total: number;
  entries_without_recorded_date: number;
}

export function changeLogFreshness(changes: DealChange[], now: Date = new Date()): ChangeLogFreshness {
  const today = now.toISOString().slice(0, 10);
  const daysBetween = (from: string, to: string) =>
    Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
  const recorded = changes.map((c) => c.recorded_date).filter((d): d is string => !!d).sort();
  const detected = changes
    .filter((c) => c.detected_by)
    .map((c) => c.recorded_date)
    .filter((d): d is string => !!d)
    .sort();
  const last = recorded.length > 0 ? recorded[recorded.length - 1] : null;
  const lastDetected = detected.length > 0 ? detected[detected.length - 1] : null;
  const thirtyDaysAgo = new Date(Date.parse(today) - 30 * 86400000).toISOString().slice(0, 10);
  return {
    total: changes.length,
    last_recorded_date: last,
    days_since_last_recorded: last === null ? null : Math.max(0, daysBetween(last, today)),
    last_detected_date: lastDetected,
    days_since_last_detected:
      lastDetected === null ? null : Math.max(0, daysBetween(lastDetected, today)),
    recorded_last_30_days: recorded.filter((d) => d >= thirtyDaysAgo).length,
    machine_detected_total: changes.filter((c) => c.detected_by).length,
    entries_without_recorded_date: changes.length - recorded.length,
  };
}

export function getChangeLogFreshness(now: Date = new Date()): ChangeLogFreshness {
  return changeLogFreshness(loadDealChanges(), now);
}

export function getDealChanges(
  since?: string,
  changeType?: string,
  vendor?: string,
  vendors?: string,
  categories?: string
): { changes: DealChange[]; total: number } {
  let results = loadDealChanges();

  if (since) {
    results = results.filter((c) => c.date >= since);
  } else {
    // Default: last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    results = results.filter((c) => c.date >= thirtyDaysAgo);
  }

  if (changeType) {
    const lowerType = changeType.toLowerCase();
    results = results.filter((c) => c.change_type === lowerType);
  }

  // vendors (comma-separated) takes precedence over vendor (single)
  if (vendors) {
    const vendorList = vendors.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
    results = results.filter((c) => {
      const lowerVendor = c.vendor.toLowerCase();
      return vendorList.some((v) => lowerVendor.includes(v));
    });
  } else if (vendor) {
    const lowerVendor = vendor.toLowerCase();
    results = results.filter((c) => c.vendor.toLowerCase().includes(lowerVendor));
  }

  // Category filtering (comma-separated, case-insensitive partial match)
  if (categories) {
    const catList = categories.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
    results = results.filter((c) => {
      const lowerCat = (c.category || "").toLowerCase();
      return catList.some((cat) => lowerCat.includes(cat));
    });
  }

  // Sort by date, newest first
  results = [...results].sort((a, b) => b.date.localeCompare(a.date));

  return { changes: results, total: results.length };
}

export interface PersonalizedChanges {
  your_stack_changes: DealChange[];
  advisory: DealChange[];
  summary: {
    stack_changes_count: number;
    ecosystem_high_impact_count: number;
    period_days: number;
  };
}

const HIGH_IMPACT_CHANGE_TYPES = new Set([
  "free_tier_removed", "open_source_killed", "product_deprecated",
  "limits_reduced", "new_free_tier",
]);

export function getPersonalizedChanges(
  since?: string,
  changeType?: string,
  vendor?: string,
  vendors?: string,
  categories?: string
): PersonalizedChanges {
  // Get the user's stack changes
  const stackResult = getDealChanges(since, changeType, vendor, vendors, categories);

  // Get ALL changes in the same time window (no vendor/category filter)
  const allResult = getDealChanges(since, changeType);

  // Build a set of vendor names already in the stack results for dedup
  const stackVendorDates = new Set(
    stackResult.changes.map((c) => `${c.vendor}|${c.date}|${c.change_type}`)
  );

  // Advisory: high-impact changes outside the user's filter, top 3
  const advisory = allResult.changes
    .filter((c) => c.impact === "high" && HIGH_IMPACT_CHANGE_TYPES.has(c.change_type))
    .filter((c) => !stackVendorDates.has(`${c.vendor}|${c.date}|${c.change_type}`))
    .slice(0, 3);

  // Count high-impact ecosystem-wide
  const ecosystemHighImpact = allResult.changes.filter(
    (c) => c.impact === "high"
  ).length;

  // Calculate period in days
  const sinceDate = since ? new Date(since) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const periodDays = Math.max(1, Math.ceil((Date.now() - sinceDate.getTime()) / (24 * 60 * 60 * 1000)));

  return {
    your_stack_changes: stackResult.changes,
    advisory,
    summary: {
      stack_changes_count: stackResult.changes.length,
      ecosystem_high_impact_count: ecosystemHighImpact,
      period_days: periodDays,
    },
  };
}

function findVendor(offers: Offer[], name: string): { offer: Offer | null; suggestions: string[] } {
  const lower = name.toLowerCase();
  const exact = offers.find((o) => o.vendor.toLowerCase() === lower);
  if (exact) return { offer: exact, suggestions: [] };

  // Fuzzy: substring match
  const fuzzy = offers.filter(
    (o) => o.vendor.toLowerCase().includes(lower) || lower.includes(o.vendor.toLowerCase())
  );
  if (fuzzy.length === 1) return { offer: fuzzy[0], suggestions: [] };

  return { offer: null, suggestions: fuzzy.slice(0, 5).map((o) => o.vendor) };
}

export interface ComparisonResult {
  vendor_a: Offer & { deal_changes: DealChange[] };
  vendor_b: Offer & { deal_changes: DealChange[] };
  shared_categories: boolean;
  category_overlap: string[];
}

export interface VendorRiskResult {
  vendor: string;
  category: string;
  risk_level: "stable" | "caution" | "risky" | null;
  /** Never null when risk_level is caution or risky (#1038). */
  risk_cause: RiskCause | null;
  link_unreachable: LinkUnreachable | null;
  free_tier_longevity_days: number;
  changes: DealChange[];
  alternatives: Array<{ vendor: string; category: string; tier: string; risk_level: "stable" | "caution" | "risky" | null; risk_cause: RiskCause | null; link_unreachable: LinkUnreachable | null; demerits: Array<{ code: string; points: number; reason: string }> }>;
  summary: string;
}

/**
 * Every change type that appears in data/deal_changes.json, and how far it
 * demotes the vendor. `null` demotes nothing.
 *
 * #1038: the definition the public surfaces used counted change records of
 * *any* type, all-time. `limits_increased` — a vendor expanding its free tier
 * — pushed that vendor toward `caution`, and a vendor we had never examined
 * rendered `stable` because we had written nothing about it. The badge was a
 * map of our own coverage, so it flagged the companies we watch most closely
 * and rewarded obscurity.
 *
 * The table is exhaustive on purpose. A type left out of it is a silent
 * decision either way, so `risk-badge.test.ts` asserts it covers every type
 * present in the data.
 */
export const RISK_DEMOTION: Record<DealChange["change_type"], "risky" | "caution" | null> = {
  // The free tier we list stopped existing.
  free_tier_removed: "risky",
  open_source_killed: "risky",
  // The free tier still exists and is worth less than it was.
  limits_reduced: "caution",
  pricing_restructured: "caution",
  // Neutral or favourable to the user. These can never raise a risk level.
  limits_increased: null,
  new_free_tier: null,
  new_tier: null,
  startup_program_expanded: null,
  pricing_postponed: null,
  rebranded: null, // a naming event, not a pricing one
  // Negative, but not risk inputs today — see the #1038 PR description. In
  // short: `product_deprecated` is dominated by unrelated products of large
  // vendors (an AWS Lambda runtime deprecation says nothing about AWS's free
  // tier) and `restriction` currently holds at least one correction to our own
  // data. Both would reintroduce the coverage proxy this issue removed.
  product_deprecated: null,
  restriction: null,
  pricing_model_change: null,
};

const RISK_RANK: Record<"stable" | "caution" | "risky", number> = { stable: 0, caution: 1, risky: 2 };

export interface VendorRiskAssessment {
  level: "stable" | "caution" | "risky";
  /** The record that produced the level. Never null when level !== "stable". */
  cause: DealChange | null;
}

/**
 * The only definition of vendor risk in the codebase.
 *
 * Returns the level *and* the dated record that earned it, because no surface
 * may publish a warning it cannot show the reason for (#1038).
 */
export function vendorRiskAssessment(vendorChanges: DealChange[], nowMs: number = Date.now()): VendorRiskAssessment {
  const twelveMonthsAgo = new Date(nowMs - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let best: { level: "caution" | "risky"; cause: DealChange } | null = null;
  for (const c of vendorChanges) {
    const demotion = RISK_DEMOTION[c.change_type];
    if (!demotion) continue;
    // A severe change ages into `caution`, never into `stable`. We still hold
    // the record, and `stable` is itself a published claim — SendGrid's free
    // tier removal is 15 months old and calling that vendor stable would be a
    // false statement we made ourselves.
    const level = demotion === "risky" && c.date < twelveMonthsAgo ? "caution" : demotion;
    if (!best || RISK_RANK[level] > RISK_RANK[best.level] || (level === best.level && c.date > best.cause.date)) {
      best = { level, cause: c };
    }
  }

  return best ? { level: best.level, cause: best.cause } : { level: "stable", cause: null };
}

export function vendorRiskLevel(vendorChanges: DealChange[]): "stable" | "caution" | "risky" {
  return vendorRiskAssessment(vendorChanges).level;
}

export function checkVendorRisk(
  vendorName: string
): { result: VendorRiskResult } | { error: string; suggestions?: string[] } {
  const offers = loadOffers();
  const match = findVendor(offers, vendorName);

  if (!match.offer) {
    return {
      error: `Vendor "${vendorName}" not found.${match.suggestions.length > 0 ? ` Did you mean: ${match.suggestions.join(", ")}?` : ""}`,
      ...(match.suggestions.length > 0 ? { suggestions: match.suggestions } : {}),
    };
  }

  const offer = match.offer;
  const allChanges = loadDealChanges();
  const vendorChanges = allChanges
    .filter((c) => c.vendor.toLowerCase() === offer.vendor.toLowerCase())
    .sort((a, b) => b.date.localeCompare(a.date));

  const assessment = vendorRiskAssessment(vendorChanges);
  const linkUnreachable = unreachableNoticeForUrl(offer.url);
  const riskLevel = assessment.level;

  // Free tier longevity: days since verifiedDate with no negative changes after it
  const verifiedDate = new Date(offer.verifiedDate);
  const lastNegativeChange = vendorChanges.find((c) => NEGATIVE_CHANGE_TYPES.has(c.change_type));
  const longevityStart = lastNegativeChange
    ? new Date(Math.max(new Date(lastNegativeChange.date).getTime(), verifiedDate.getTime()))
    : verifiedDate;
  const longevityDays = Math.max(
    0,
    Math.floor((Date.now() - longevityStart.getTime()) / (24 * 60 * 60 * 1000))
  );

  // Up to 3 alternatives in the same category. This is a recommendation, so it
  // resolves through the shared selection module (#1025) rather than the old
  // "risk bucket, then alphabetical" sort — which ranked on the count of
  // changes we happen to have recorded and broke ties with the alphabet.
  const alternatives = rankForListing(
    filterAlternatives(offers.filter((o) => o.category === offer.category && o.vendor !== offer.vendor), offer),
    { queryKey: `vendor-risk-alternatives:${offer.vendor}`, changes: allChanges },
  ).entries.slice(0, 3).map((e) => ({
    vendor: e.offer.vendor,
    category: e.offer.category,
    tier: e.offer.tier,
    ...(() => {
      const a = vendorRiskAssessment(allChanges.filter((c) => c.vendor.toLowerCase() === e.offer.vendor.toLowerCase()));
      const unreachable = unreachableNoticeForUrl(e.offer.url);
      return {
        risk_level: unreachable && a.level === "stable" ? null : a.level,
        risk_cause: a.cause ? { date: a.cause.date, change_type: a.cause.change_type, summary: a.cause.summary } : null,
        link_unreachable: unreachable,
      };
    })(),
    demerits: e.demerits.map((d) => ({ code: d.code, points: d.points, reason: d.reason })),
  }));

  // Build summary. Every non-stable summary names the dated record that
  // produced the level (#1038) — the tool result is a surface like any other,
  // and a warning without its reason is an assertion.
  let summary: string;
  const cause = assessment.cause;
  const unreachableClause = linkUnreachable
    ? ` Its pricing page has not resolved for us${linkUnreachable.last_reachable ? ` since ${linkUnreachable.last_reachable}` : ""}, so we cannot confirm its current terms.`
    : "";
  if (riskLevel === "risky" && cause) {
    summary = `${offer.vendor} is high risk — ${cause.date}: ${cause.summary} Consider alternatives.${unreachableClause}`;
  } else if (riskLevel === "caution" && cause) {
    summary = `${offer.vendor} warrants caution — ${cause.date}: ${cause.summary} Monitor for further changes.${unreachableClause}`;
  } else if (linkUnreachable) {
    summary = `We hold no free tier removal, limit reduction or pricing restructure on record for ${offer.vendor}.${unreachableClause} Treat that as a statement about our records, not as a stable pricing history.`;
  } else {
    summary = `${offer.vendor} has a stable pricing history with no free tier removal, limit reduction or pricing restructure on record. Free tier verified for ${longevityDays} days.`;
  }

  return {
    result: {
      vendor: offer.vendor,
      category: offer.category,
      risk_level: linkUnreachable && riskLevel === "stable" ? null : riskLevel,
      risk_cause: cause ? { date: cause.date, change_type: cause.change_type, summary: cause.summary } : null,
      link_unreachable: linkUnreachable,
      free_tier_longevity_days: longevityDays,
      changes: vendorChanges,
      alternatives,
      summary,
    },
  };
}

// Common infrastructure categories for gap detection
const CORE_CATEGORIES = [
  "Databases", "Cloud Hosting", "Monitoring", "Logging", "CI/CD",
  "Auth", "Email", "Search", "Feature Flags",
];

export interface AuditServiceResult {
  vendor: string;
  status: "found" | "not_found";
  category?: string;
  tier?: string;
  risk_level?: "stable" | "caution" | "risky";
  recent_changes?: DealChange[];
  cheaper_alternative?: { vendor: string; tier: string; category: string };
  suggestions?: string[];
}

export interface AuditGap {
  category: string;
  recommendation: { vendor: string; tier: string; description: string };
}

export interface AuditResult {
  services_analyzed: number;
  risks_found: number;
  savings_opportunities: number;
  gaps: AuditGap[];
  services: AuditServiceResult[];
  recommendations: string[];
}

export function auditStack(serviceNames: string[]): AuditResult {
  const offers = loadOffers();
  const allChanges = loadDealChanges();
  const services: AuditServiceResult[] = [];
  const coveredCategories = new Set<string>();
  let risksFound = 0;
  let savingsOpportunities = 0;
  const recommendations: string[] = [];

  for (const name of serviceNames) {
    const match = findVendor(offers, name);

    if (!match.offer) {
      services.push({
        vendor: name,
        status: "not_found",
        ...(match.suggestions.length > 0 ? { suggestions: match.suggestions } : {}),
      });
      continue;
    }

    const offer = match.offer;
    coveredCategories.add(offer.category);

    const vendorChanges = allChanges
      .filter((c) => c.vendor.toLowerCase() === offer.vendor.toLowerCase())
      .sort((a, b) => b.date.localeCompare(a.date));

    const riskLevel = vendorRiskLevel(vendorChanges);
    if (riskLevel !== "stable") risksFound++;

    // Find a cheaper/free alternative in same category
    let cheaperAlternative: AuditServiceResult["cheaper_alternative"];
    const sameCat = offers.filter(
      (o) => o.category === offer.category && o.vendor !== offer.vendor && o.tier.toLowerCase().includes("free")
    );
    if (sameCat.length > 0) {
      // Pick one with stable risk
      const stableAlt = sameCat.find((o) => {
        const oChanges = allChanges.filter((c) => c.vendor.toLowerCase() === o.vendor.toLowerCase());
        return vendorRiskLevel(oChanges) === "stable";
      });
      const alt = stableAlt || sameCat[0];
      cheaperAlternative = { vendor: alt.vendor, tier: alt.tier, category: alt.category };
      savingsOpportunities++;
    }

    const svc: AuditServiceResult = {
      vendor: offer.vendor,
      status: "found",
      category: offer.category,
      tier: offer.tier,
      risk_level: riskLevel,
      ...(vendorChanges.length > 0 ? { recent_changes: vendorChanges } : {}),
      ...(cheaperAlternative ? { cheaper_alternative: cheaperAlternative } : {}),
    };

    if (riskLevel === "risky") {
      recommendations.push(`⚠️ ${offer.vendor} is high risk — consider switching to ${cheaperAlternative?.vendor || "an alternative"}.`);
    } else if (riskLevel === "caution") {
      recommendations.push(`Monitor ${offer.vendor} — recent pricing changes detected.`);
    }

    services.push(svc);
  }

  // Gap detection
  const gaps: AuditGap[] = [];
  for (const cat of CORE_CATEGORIES) {
    if (!coveredCategories.has(cat)) {
      const topFree = offers
        .filter((o) => o.category === cat && o.tier.toLowerCase().includes("free"))
        .slice(0, 1);
      if (topFree.length > 0) {
        gaps.push({
          category: cat,
          recommendation: {
            vendor: topFree[0].vendor,
            tier: topFree[0].tier,
            description: topFree[0].description,
          },
        });
      }
    }
  }

  if (gaps.length > 0) {
    recommendations.push(`Missing coverage in ${gaps.length} common categories: ${gaps.map((g) => g.category).join(", ")}.`);
  }

  return {
    services_analyzed: serviceNames.length,
    risks_found: risksFound,
    savings_opportunities: savingsOpportunities,
    gaps,
    services,
    recommendations,
  };
}

export function compareServices(
  vendorA: string,
  vendorB: string
): { comparison: ComparisonResult } | { error: string; suggestions_a?: string[]; suggestions_b?: string[] } {
  const offers = loadOffers();

  const matchA = findVendor(offers, vendorA);
  const matchB = findVendor(offers, vendorB);

  if (!matchA.offer || !matchB.offer) {
    return {
      error: [
        !matchA.offer ? `Vendor "${vendorA}" not found.${matchA.suggestions.length > 0 ? ` Did you mean: ${matchA.suggestions.join(", ")}?` : ""}` : null,
        !matchB.offer ? `Vendor "${vendorB}" not found.${matchB.suggestions.length > 0 ? ` Did you mean: ${matchB.suggestions.join(", ")}?` : ""}` : null,
      ].filter(Boolean).join(" "),
      ...(matchA.suggestions.length > 0 ? { suggestions_a: matchA.suggestions } : {}),
      ...(matchB.suggestions.length > 0 ? { suggestions_b: matchB.suggestions } : {}),
    };
  }

  const changes = loadDealChanges();
  const changesA = changes.filter((c) => c.vendor.toLowerCase() === matchA.offer!.vendor.toLowerCase());
  const changesB = changes.filter((c) => c.vendor.toLowerCase() === matchB.offer!.vendor.toLowerCase());

  const sharedCategories = matchA.offer.category === matchB.offer.category;
  const categoryOverlap = sharedCategories ? [matchA.offer.category] : [];

  return {
    comparison: {
      vendor_a: stripReferrerValue({ ...matchA.offer, deal_changes: changesA }),
      vendor_b: stripReferrerValue({ ...matchB.offer, deal_changes: changesB }),
      shared_categories: sharedCategories,
      category_overlap: categoryOverlap,
    },
  };
}

export function getNewestDeals(params: {
  since?: string;
  limit?: number;
  category?: string;
}): { deals: Array<Offer & { days_since_update: number }>; total: number } {
  const now = new Date();
  const defaultSince = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const sinceDate = params.since || defaultSince;
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);

  let results = loadOffers().filter((o) => o.verifiedDate >= sinceDate);

  if (params.category) {
    const lowerCat = params.category.toLowerCase();
    results = results.filter((o) => o.category.toLowerCase() === lowerCat);
  }

  results.sort((a, b) => b.verifiedDate.localeCompare(a.verifiedDate));

  const deals = results.slice(0, limit).map((o) => stripReferrerValue({
    ...o,
    days_since_update: Math.floor(
      (now.getTime() - new Date(o.verifiedDate).getTime()) / (24 * 60 * 60 * 1000)
    ),
  }));

  return { deals, total: deals.length };
}

export function getExpiringDeals(withinDays: number = 30): { deals: Array<Offer & { days_until_expiry: number }>, total: number } {
  const offers = loadOffers();
  const now = new Date();
  const cutoff = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);

  const expiring = offers
    .filter((o) => {
      if (!o.expires_date) return false;
      const expires = new Date(o.expires_date);
      return expires >= now && expires <= cutoff;
    })
    .map((o) => ({
      ...o,
      days_until_expiry: Math.ceil((new Date(o.expires_date!).getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
    }))
    .sort((a, b) => a.days_until_expiry - b.days_until_expiry);

  return { deals: expiring, total: expiring.length };
}

export interface FreshnessMetrics {
  total_offers: number;
  verified_within_7_days: number;
  verified_within_30_days: number;
  verified_within_90_days: number;
  verified_within_180_days: number;
  freshness_score: number;
  stalest_entries: Array<{ vendor: string; category: string; verifiedDate: string; url: string; days_since_verified: number }>;
  freshest_entries: Array<{ vendor: string; category: string; verifiedDate: string; url: string; days_since_verified: number }>;
  by_category: Array<{ category: string; count: number; avg_days_since_verified: number; freshness_score: number }>;
}

export function getFreshnessMetrics(): FreshnessMetrics {
  const offers = loadOffers();
  const now = new Date();
  const nowMs = now.getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  const withAge = offers.map((o) => ({
    ...o,
    days_since_verified: Math.floor((nowMs - new Date(o.verifiedDate).getTime()) / dayMs),
  }));

  const total = withAge.length;
  const within7 = withAge.filter((o) => o.days_since_verified <= 7).length;
  const within30 = withAge.filter((o) => o.days_since_verified <= 30).length;
  const within90 = withAge.filter((o) => o.days_since_verified <= 90).length;
  const within180 = withAge.filter((o) => o.days_since_verified <= 180).length;

  const freshnessScore = total > 0 ? Math.round((within90 / total) * 100) : 0;

  const sorted = [...withAge].sort((a, b) => b.days_since_verified - a.days_since_verified);
  const stalest = sorted.slice(0, 20).map((o) => ({
    vendor: o.vendor, category: o.category, verifiedDate: o.verifiedDate, url: o.url, days_since_verified: o.days_since_verified,
  }));
  const freshest = sorted.slice(-20).reverse().map((o) => ({
    vendor: o.vendor, category: o.category, verifiedDate: o.verifiedDate, url: o.url, days_since_verified: o.days_since_verified,
  }));

  // Category breakdown
  const catMap = new Map<string, { count: number; totalDays: number; within90: number }>();
  for (const o of withAge) {
    const entry = catMap.get(o.category) ?? { count: 0, totalDays: 0, within90: 0 };
    entry.count++;
    entry.totalDays += o.days_since_verified;
    if (o.days_since_verified <= 90) entry.within90++;
    catMap.set(o.category, entry);
  }
  const byCategory = Array.from(catMap.entries())
    .map(([category, stats]) => ({
      category,
      count: stats.count,
      avg_days_since_verified: Math.round(stats.totalDays / stats.count),
      freshness_score: Math.round((stats.within90 / stats.count) * 100),
    }))
    .sort((a, b) => b.freshness_score - a.freshness_score);

  return {
    total_offers: total,
    verified_within_7_days: within7,
    verified_within_30_days: within30,
    verified_within_90_days: within90,
    verified_within_180_days: within180,
    freshness_score: freshnessScore,
    stalest_entries: stalest,
    freshest_entries: freshest,
    by_category: byCategory,
  };
}

export function getWeeklyDigest(): {
  week: string;
  date_range: string;
  deal_changes: DealChange[];
  new_offers: { vendor: string; category: string; description: string }[];
  upcoming_deadlines: { vendor: string; date: string; change_type: string; summary: string }[];
  summary: string;
} {
  const now = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const today = fmt(now);
  const thirtyDaysFromNow = fmt(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000));

  // Get deal changes — 7-day window, fallback to 30 if <3 changes
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let changes = getDealChanges(sevenDaysAgo).changes;
  const usedFallback = changes.length < 3;
  if (usedFallback) {
    changes = getDealChanges(thirtyDaysAgo).changes;
  }

  // New offers added in last 7 days
  const newOffers = getNewOffers(7).offers.slice(0, 10).map((o) => ({
    vendor: o.vendor,
    category: o.category,
    description: o.description,
  }));

  // Upcoming deadlines (next 30 days) — from expiring offers
  const expiringDeadlines = getExpiringDeals(30).deals.map((d) => ({
    vendor: d.vendor,
    date: d.expires_date!,
    change_type: "deal_expiring",
    summary: `${d.vendor} deal expires`,
  }));

  // Upcoming deadlines from deal changes with future dates (next 30 days)
  const allChanges = loadDealChanges();
  const changeDeadlines = allChanges
    .filter((c) => c.date >= today && c.date <= thirtyDaysFromNow)
    .map((c) => ({
      vendor: c.vendor,
      date: c.date,
      change_type: c.change_type,
      summary: c.summary,
    }));

  // Merge, deduplicate by vendor+date, sort by date ascending
  const seen = new Set<string>();
  const deadlines = [...expiringDeadlines, ...changeDeadlines]
    .sort((a, b) => a.date.localeCompare(b.date))
    .filter((d) => {
      const key = `${d.vendor}|${d.date}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 25);

  // Week label
  const weekStart = new Date(now.getTime() - now.getUTCDay() * 86400000 + 86400000); // Monday
  const weekEnd = new Date(weekStart.getTime() + 6 * 86400000);
  const week = `${fmt(weekStart)} to ${fmt(weekEnd)}`;

  // Build summary
  const parts: string[] = [];
  if (changes.length > 0) {
    const negative = changes.filter((c) => CHANGE_DIRECTION[c.change_type] === "negative");
    const positive = changes.filter((c) => CHANGE_DIRECTION[c.change_type] === "positive");
    parts.push(`${changes.length} pricing change${changes.length !== 1 ? "s" : ""} tracked${usedFallback ? " in the past 30 days" : " this week"}`);
    if (negative.length > 0) parts.push(`${negative.length} negative (${negative.map((c) => c.vendor).join(", ")})`);
    if (positive.length > 0) parts.push(`${positive.length} positive (${positive.map((c) => c.vendor).join(", ")})`);
  } else {
    parts.push("No pricing changes this week");
  }
  if (newOffers.length > 0) parts.push(`${newOffers.length} new offer${newOffers.length !== 1 ? "s" : ""} added`);
  if (deadlines.length > 0) parts.push(`${deadlines.length} upcoming deadline${deadlines.length !== 1 ? "s" : ""} in the next 30 days`);
  const summary = parts.join(". ") + ".";

  return {
    week,
    date_range: `${fmt(weekStart)} to ${fmt(weekEnd)}`,
    deal_changes: changes,
    new_offers: newOffers,
    upcoming_deadlines: deadlines,
    summary,
  };
}

const IMPACT_SCORE: Record<string, number> = {
  free_tier_removed: 100,
  open_source_killed: 90,
  new_free_tier: 80,
  product_deprecated: 70,
  limits_reduced: 60,
  pricing_restructured: 50,
  limits_increased: 40,
  restriction: 35,
  pricing_model_change: 30,
  startup_program_expanded: 25,
  new_tier: 20,
  pricing_postponed: 10,
};

function scoreChange(c: DealChange): number {
  const typeScore = IMPACT_SCORE[c.change_type] ?? 10;
  const impactMultiplier = c.impact === "high" ? 3 : c.impact === "medium" ? 2 : 1;
  return typeScore * impactMultiplier;
}

export interface FormattedWeeklyDigest {
  week_of: string;
  week_ending: string;
  total_changes: number;
  summary: {
    free_tiers_removed: number;
    new_free_tiers: number;
    limits_reduced: number;
    limits_increased: number;
    products_deprecated: number;
    pricing_restructured: number;
  };
  headline: string;
  top_changes: DealChange[];
  digest_markdown: string;
  digest_html: string;
}

export function getFormattedWeeklyDigest(weeksAgo: number = 0, limit: number = 20): FormattedWeeklyDigest {
  const allChanges = loadDealChanges();
  const now = new Date();
  const targetDate = new Date(now.getTime() - weeksAgo * 7 * 86400000);

  const dayOfWeek = targetDate.getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const weekStart = new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate() + mondayOffset));
  const weekEnd = new Date(weekStart.getTime() + 6 * 86400000);

  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const weekStartStr = fmt(weekStart);
  const weekEndStr = fmt(weekEnd);

  const weekChanges = allChanges.filter(c => c.date >= weekStartStr && c.date <= weekEndStr);
  const sorted = [...weekChanges].sort((a, b) => scoreChange(b) - scoreChange(a));
  const topChanges = sorted.slice(0, limit);

  const summary = {
    free_tiers_removed: weekChanges.filter(c => c.change_type === "free_tier_removed").length,
    new_free_tiers: weekChanges.filter(c => c.change_type === "new_free_tier").length,
    limits_reduced: weekChanges.filter(c => c.change_type === "limits_reduced").length,
    limits_increased: weekChanges.filter(c => c.change_type === "limits_increased").length,
    products_deprecated: weekChanges.filter(c => c.change_type === "product_deprecated").length,
    pricing_restructured: weekChanges.filter(c => c.change_type === "pricing_restructured").length,
  };

  const headlineParts: string[] = [];
  if (summary.free_tiers_removed > 0) headlineParts.push(`${summary.free_tiers_removed} free tier${summary.free_tiers_removed !== 1 ? "s" : ""} removed`);
  if (summary.new_free_tiers > 0) headlineParts.push(`${summary.new_free_tiers} new one${summary.new_free_tiers !== 1 ? "s" : ""} added`);
  if (summary.products_deprecated > 0) headlineParts.push(`${summary.products_deprecated} product${summary.products_deprecated !== 1 ? "s" : ""} deprecated`);
  if (summary.limits_reduced > 0) headlineParts.push(`${summary.limits_reduced} limit${summary.limits_reduced !== 1 ? "s" : ""} reduced`);
  if (summary.limits_increased > 0) headlineParts.push(`${summary.limits_increased} limit${summary.limits_increased !== 1 ? "s" : ""} increased`);
  if (summary.pricing_restructured > 0) headlineParts.push(`${summary.pricing_restructured} pricing restructure${summary.pricing_restructured !== 1 ? "s" : ""}`);
  const headline = headlineParts.length > 0
    ? `${headlineParts.join(", ")} across ${weekChanges.length} developer tool pricing changes`
    : `${weekChanges.length} developer tool pricing change${weekChanges.length !== 1 ? "s" : ""} tracked this week`;

  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const dateLabel = `${months[weekStart.getUTCMonth()]} ${weekStart.getUTCDate()}\u2013${weekEnd.getUTCDate()}, ${weekStart.getUTCFullYear()}`;

  const negativeTypes = NEGATIVE_STABILITY_TYPES;
  const positiveTypes = POSITIVE_STABILITY_TYPES;

  const losses = topChanges.filter(c => negativeTypes.has(c.change_type));
  const brightSpots = topChanges.filter(c => positiveTypes.has(c.change_type));
  const other = topChanges.filter(c => !negativeTypes.has(c.change_type) && !positiveTypes.has(c.change_type));

  function changeToMd(c: DealChange): string {
    return `- **${c.vendor}** (${c.category}): ${c.summary}`;
  }

  const mdSections: string[] = [];
  mdSections.push(`# This Week in Developer Pricing`);
  mdSections.push(`*${dateLabel}*`);
  mdSections.push(`> ${headline}`);

  if (losses.length > 0) {
    mdSections.push(`## Biggest Losses`);
    mdSections.push(losses.map(changeToMd).join("\n"));
  }
  if (brightSpots.length > 0) {
    mdSections.push(`## Bright Spots`);
    mdSections.push(brightSpots.map(changeToMd).join("\n"));
  }
  if (other.length > 0) {
    mdSections.push(`## Other Notable Changes`);
    mdSections.push(other.map(changeToMd).join("\n"));
  }
  if (topChanges.length === 0) {
    mdSections.push(`No pricing changes tracked this week.`);
  }

  mdSections.push(`---`);
  mdSections.push(`[View all ${allChanges.length} changes](https://agentdeals.dev/changes) | Powered by [AgentDeals](https://agentdeals.dev)`);

  const digestMarkdown = mdSections.join("\n\n");

  function escHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function changeToHtml(c: DealChange): string {
    return `<li><strong>${escHtml(c.vendor)}</strong> (${escHtml(c.category)}): ${escHtml(c.summary)}</li>`;
  }

  const htmlSections: string[] = [];
  htmlSections.push(`<h1>This Week in Developer Pricing</h1>`);
  htmlSections.push(`<p><em>${escHtml(dateLabel)}</em></p>`);
  htmlSections.push(`<blockquote><p>${escHtml(headline)}</p></blockquote>`);

  if (losses.length > 0) {
    htmlSections.push(`<h2>Biggest Losses</h2>`);
    htmlSections.push(`<ul>${losses.map(changeToHtml).join("")}</ul>`);
  }
  if (brightSpots.length > 0) {
    htmlSections.push(`<h2>Bright Spots</h2>`);
    htmlSections.push(`<ul>${brightSpots.map(changeToHtml).join("")}</ul>`);
  }
  if (other.length > 0) {
    htmlSections.push(`<h2>Other Notable Changes</h2>`);
    htmlSections.push(`<ul>${other.map(changeToHtml).join("")}</ul>`);
  }
  if (topChanges.length === 0) {
    htmlSections.push(`<p>No pricing changes tracked this week.</p>`);
  }

  htmlSections.push(`<hr>`);
  htmlSections.push(`<p><a href="https://agentdeals.dev/changes">View all ${allChanges.length} changes</a> | Powered by <a href="https://agentdeals.dev">AgentDeals</a></p>`);

  const digestHtml = htmlSections.join("\n");

  return {
    week_of: weekStartStr,
    week_ending: weekEndStr,
    total_changes: allChanges.length,
    summary,
    headline,
    top_changes: topChanges,
    digest_markdown: digestMarkdown,
    digest_html: digestHtml,
  };
}

const VALID_REFERRAL_TYPES = new Set(["dual-sided", "referrer-only", "referee-only"]);
const VALID_REFERRAL_SOURCES = new Set(["curated", "sovrn", "agent-submitted"]);

export function validateReferral(referral: Referral, vendor: string): string[] {
  const errors: string[] = [];
  if (!referral.url || !/^https?:\/\/.+/.test(referral.url)) {
    errors.push(`${vendor}: referral.url must be a valid URL`);
  }
  if (!VALID_REFERRAL_TYPES.has(referral.type)) {
    errors.push(`${vendor}: referral.type must be one of: dual-sided, referrer-only, referee-only`);
  }
  if (!VALID_REFERRAL_SOURCES.has(referral.source)) {
    errors.push(`${vendor}: referral.source must be one of: curated, sovrn, agent-submitted`);
  }
  if ((referral.type === "dual-sided" || referral.type === "referee-only") && !referral.referee_value) {
    errors.push(`${vendor}: referral.referee_value is required for ${referral.type} type`);
  }
  if (!referral.verified_date || !/^\d{4}-\d{2}-\d{2}$/.test(referral.verified_date)) {
    errors.push(`${vendor}: referral.verified_date must be a valid ISO date (YYYY-MM-DD)`);
  } else {
    const verifiedMs = new Date(referral.verified_date).getTime();
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    if (Date.now() - verifiedMs > ninetyDaysMs) {
      errors.push(`${vendor}: referral.verified_date is older than 90 days`);
    }
  }
  return errors;
}

export function stripReferrerValue<T extends { referral?: Referral }>(offer: T): T {
  if (!offer.referral) return offer;
  const { referrer_value, ...publicReferral } = offer.referral;
  return { ...offer, referral: publicReferral as Referral };
}

/**
 * Get the referral data for a specific vendor (with referrer_value stripped).
 * Returns null if the vendor has no referral or vendor not found.
 */
export function getVendorReferral(vendorName: string): { vendor: string; referral: Omit<Referral, "referrer_value"> } | null {
  const offers = loadOffers();
  const lowerName = vendorName.toLowerCase();
  const match = offers.find(o => o.vendor.toLowerCase() === lowerName);
  if (!match || !match.referral) return null;
  if (isUrlSuspended(match.referral.url)) return null;
  const { referrer_value, ...publicReferral } = match.referral;
  return { vendor: match.vendor, referral: publicReferral };
}

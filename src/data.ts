import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Offer, EnrichedOffer, OfferIndex, DealChange, DealChangesIndex, StabilityClass, Referral } from "./types.js";
import { isUrlSuspended } from "./referral-health.js";

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
    const sameCategoryOffers = offers
      .filter((o) => o.category === match.category && o.vendor !== match.vendor)
      .slice(0, 5);
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

const NEGATIVE_STABILITY_TYPES = new Set([
  "free_tier_removed",
  "open_source_killed",
  "limits_reduced",
  "pricing_restructured",
  "product_deprecated",
  "restriction",
]);

const VOLATILE_TYPES = new Set([
  "free_tier_removed",
  "open_source_killed",
  "product_deprecated",
]);

const POSITIVE_STABILITY_TYPES = new Set([
  "limits_increased",
  "new_free_tier",
  "startup_program_expanded",
  "pricing_postponed",
]);

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

  // Build vendor → all-time change count for risk_level
  const vendorAllChanges = new Map<string, number>();
  for (const c of changes) {
    const key = c.vendor.toLowerCase();
    vendorAllChanges.set(key, (vendorAllChanges.get(key) ?? 0) + 1);
  }

  // Build vendor → all changes for stability classification
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

    // risk_level: 0 changes = stable, 1 = caution, 2+ = risky
    const changeCount = vendorAllChanges.get(key) ?? 0;
    let risk_level: "stable" | "caution" | "risky" | null = null;
    if (changeCount >= 2) {
      risk_level = "risky";
    } else if (changeCount === 1) {
      risk_level = "caution";
    } else {
      risk_level = "stable";
    }

    // stability: derived from change types, not just count
    const stability = classifyStability(vendorAllChangesList.get(key) ?? []);

    const days_since_verified = Math.floor(
      (now.getTime() - new Date(offer.verifiedDate).getTime()) / (24 * 60 * 60 * 1000)
    );

    const enriched = { ...offer, recent_change, expires_soon, risk_level, stability, days_since_verified };
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
  risk_level: "stable" | "caution" | "risky";
  free_tier_longevity_days: number;
  changes: DealChange[];
  alternatives: Array<{ vendor: string; category: string; tier: string; risk_level: "stable" | "caution" | "risky" }>;
  summary: string;
}

const NEGATIVE_CHANGE_TYPES = new Set([
  "free_tier_removed",
  "open_source_killed",
  "limits_reduced",
  "pricing_restructured",
  "product_deprecated",
]);

const RISKY_CHANGE_TYPES = new Set(["free_tier_removed", "open_source_killed"]);

function vendorRiskLevel(vendorChanges: DealChange[]): "stable" | "caution" | "risky" {
  const twelveMonthsAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  for (const c of vendorChanges) {
    if (RISKY_CHANGE_TYPES.has(c.change_type) && c.date >= twelveMonthsAgo) {
      return "risky";
    }
  }

  for (const c of vendorChanges) {
    if (c.change_type === "limits_reduced" || c.change_type === "pricing_restructured") {
      return "caution";
    }
  }

  return "stable";
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

  const riskLevel = vendorRiskLevel(vendorChanges);

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

  // Find up to 3 more-stable alternatives in same category
  const sameCategoryOffers = offers.filter(
    (o) => o.category === offer.category && o.vendor !== offer.vendor
  );
  const alternativesWithRisk = sameCategoryOffers.map((o) => {
    const oChanges = allChanges.filter((c) => c.vendor.toLowerCase() === o.vendor.toLowerCase());
    return {
      vendor: o.vendor,
      category: o.category,
      tier: o.tier,
      risk_level: vendorRiskLevel(oChanges),
    };
  });
  // Prefer stable > caution > risky, then alphabetical
  const riskOrder = { stable: 0, caution: 1, risky: 2 };
  const alternatives = alternativesWithRisk
    .sort((a, b) => riskOrder[a.risk_level] - riskOrder[b.risk_level] || a.vendor.localeCompare(b.vendor))
    .slice(0, 3);

  // Build summary
  let summary: string;
  if (riskLevel === "risky") {
    summary = `${offer.vendor} is high risk — has had a free tier removal or open source license change in the last 12 months. Consider alternatives.`;
  } else if (riskLevel === "caution") {
    summary = `${offer.vendor} has had pricing changes (limit reductions or restructuring). Monitor for further changes.`;
  } else {
    summary = `${offer.vendor} has a stable pricing history with no negative changes recorded. Free tier verified for ${longevityDays} days.`;
  }

  return {
    result: {
      vendor: offer.vendor,
      category: offer.category,
      risk_level: riskLevel,
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
    const negative = changes.filter((c) => ["free_tier_removed", "limits_reduced", "restriction", "open_source_killed", "product_deprecated"].includes(c.change_type));
    const positive = changes.filter((c) => ["new_free_tier", "limits_increased", "startup_program_expanded"].includes(c.change_type));
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

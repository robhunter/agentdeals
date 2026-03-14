import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Offer, EnrichedOffer, OfferIndex, DealChange, DealChangesIndex } from "./types.js";

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
      result.alternatives = sameCategoryOffers;
    }
    return { offer: result };
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
  sort?: string
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

    return { ...offer, recent_change, expires_soon, risk_level };
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
    .sort((a, b) => b.verifiedDate.localeCompare(a.verifiedDate));
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
  vendor?: string
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

  if (vendor) {
    const lowerVendor = vendor.toLowerCase();
    results = results.filter((c) => c.vendor.toLowerCase().includes(lowerVendor));
  }

  // Sort by date, newest first
  results = [...results].sort((a, b) => b.date.localeCompare(a.date));

  return { changes: results, total: results.length };
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
      vendor_a: { ...matchA.offer, deal_changes: changesA },
      vendor_b: { ...matchB.offer, deal_changes: changesB },
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

  const deals = results.slice(0, limit).map((o) => ({
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

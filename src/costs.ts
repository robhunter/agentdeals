import { changeSummaryText } from "./change-citation.js";
import { loadOffers, loadDealChanges, enrichOffers } from "./data.js";
import type { Offer, DealChange, ListingCondition } from "./types.js";
import { conditionsField } from "./conditions-field.js";
import { classifyTier, rankForListing } from "./ranking.js";
import { supersededTermsRecordFor, type SupersededTermsRecord } from "./superseded-description.js";
import { substitutesListedFor } from "./vendor-substitutes.js";

export interface ServiceCostEstimate {
  vendor: string;
  current_tier: string;
  free_tier_limits: string;
  conditions?: ListingCondition[];
  estimated_monthly_cost: string;
  free_alternative?: { vendor: string; tier: string; description: string; conditions?: ListingCondition[] };
  recent_changes?: string[];
}

export interface CostEstimateResult {
  services: ServiceCostEstimate[];
  total_estimated_cost: string;
  savings_available: string;
  warnings: string[];
  scale: string;
}

type Scale = "hobby" | "startup" | "growth";

const SCALE_DESCRIPTIONS: Record<Scale, string> = {
  hobby: "Within free tier limits — side projects and prototyping",
  startup: "Likely exceeding some free tiers — early-stage product with real users",
  growth: "Exceeding most free tiers — established product with significant usage",
};

const WITHIN_FREE_TIER = "$0 (within free tier)";
const ALL_WITHIN_FREE_TIERS = "$0/mo (all within free tiers)";
const ALREADY_ON_FREE_TIERS = "$0 — already on free tiers";
const STORED_TERMS_WITHHELD_NOTE = "stored terms withheld";
const NOT_IN_OUR_INDEX_NOTE = "not in our index";
const SAVINGS_NOT_ESTIMATED_BESIDE_ALTERNATIVES =
  "Not estimated. free_alternative names a substitute with an ongoing free tier where we list one.";
const SAVINGS_NOT_ESTIMATED = "Not estimated.";

function notEstimatedForTier(tier: string, note: string): string {
  return `Not estimated: tier "${tier}" is ${note}.`;
}

function notEstimatedForWithheldTerms(vendor: string): string {
  return `Not estimated: we are not publishing our stored ${vendor} terms.`;
}

function notEstimatedAboveTheFreeTier(listingUrl: string): string {
  return `Not estimated: we do not price usage above the free tier. Prices: ${listingUrl}`;
}

function totalNotEstimatedAtScale(scale: Scale): string {
  return `Not estimated at ${scale} scale: we do not price usage above free tiers.`;
}

export interface PricedService {
  vendor: string;
  notEstimatedBecause: string | null;
}

function extractFreeTierLimits(offer: Offer): string {
  const desc = offer.description;
  if (desc.length <= 200) return desc;
  return desc.slice(0, 197) + "...";
}

function changesNaming(vendor: string, allChanges: DealChange[]): DealChange[] {
  const key = vendor.toLowerCase();
  return allChanges.filter((c) => c.vendor.toLowerCase() === key);
}

function withheldTermsOf(offer: Offer, allChanges: DealChange[]): SupersededTermsRecord | null {
  return supersededTermsRecordFor(offer, changesNaming(offer.vendor, allChanges));
}

export function reasonNotPricedAtZero(offer: Pick<Offer, "tier">, withheld: SupersededTermsRecord | null): string | null {
  const tierClass = classifyTier(offer.tier);
  if (tierClass.class !== "free") return tierClass.note;
  if (withheld) return STORED_TERMS_WITHHELD_NOTE;
  return null;
}

function monthlyCostEstimate(offer: Offer, withheld: SupersededTermsRecord | null, scale: Scale): string {
  const tierClass = classifyTier(offer.tier);
  if (tierClass.class !== "free") return notEstimatedForTier(offer.tier, tierClass.note);
  if (withheld) return notEstimatedForWithheldTerms(offer.vendor);
  if (scale === "hobby") return WITHIN_FREE_TIER;
  return notEstimatedAboveTheFreeTier(offer.url);
}

function untiedBestFreeSubstitute(offer: Offer, allChanges: DealChange[], catalogue: Offer[]): Offer | undefined {
  const listed = substitutesListedFor(offer.vendor, allChanges, catalogue);
  const freeWithPublishedTerms = rankForListing(enrichOffers(listed), { queryKey: `alternative-to:${offer.vendor}`, changes: allChanges })
    .entries.filter((entry) => !entry.gate && classifyTier(entry.offer.tier).class === "free" && withheldTermsOf(entry.offer, allChanges) === null);
  if (freeWithPublishedTerms.length === 0) return undefined;
  const fewestDemerits = Math.min(...freeWithPublishedTerms.map((entry) => entry.demerit_total));
  const best = freeWithPublishedTerms.filter((entry) => entry.demerit_total === fewestDemerits);
  return best.length === 1 ? best[0].offer : undefined;
}

function findFreeAlternative(
  offer: Offer,
  allChanges: DealChange[],
  catalogue: Offer[],
): { vendor: string; tier: string; description: string; conditions?: ListingCondition[] } | undefined {
  const alternative = untiedBestFreeSubstitute(offer, allChanges, catalogue);
  if (!alternative) return undefined;
  return {
    vendor: alternative.vendor,
    tier: alternative.tier,
    description: alternative.description.length > 150
      ? alternative.description.slice(0, 147) + "..."
      : alternative.description,
    ...conditionsField(alternative),
  };
}

function getRecentChanges(vendorName: string): string[] {
  const changes = loadDealChanges();
  const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return changes
    .filter(
      (c) =>
        c.vendor.toLowerCase() === vendorName.toLowerCase() &&
        c.date >= sixMonthsAgo
    )
    .map((c) => `${c.date}: ${changeSummaryText(c)}`);
}

function generateWarnings(
  services: ServiceCostEstimate[],
  scale: Scale,
  offersWithPublishedFreeTerms: Map<string, Offer>
): string[] {
  const warnings: string[] = [];

  for (const svc of services) {
    const offer = offersWithPublishedFreeTerms.get(svc.vendor.toLowerCase());

    if (offer && scale !== "hobby") {
      const desc = offer.description.toLowerCase();
      if (desc.includes("1,000") || desc.includes("1000 ")) {
        warnings.push(
          `${svc.vendor} free tier has low request/usage limits — likely exceeded at ${scale} scale`
        );
      }
      if (desc.includes("10k mau") || desc.includes("10,000 mau") || desc.includes("10000 mau")) {
        warnings.push(
          `${svc.vendor} free tier limited to 10K MAU — you'll hit this at ${scale} scale`
        );
      }
      if (desc.includes("500 mb") || desc.includes("512 mb") || desc.includes("0.5 gi")) {
        warnings.push(
          `${svc.vendor} storage is under 1 GB on free tier — plan for upgrades at ${scale} scale`
        );
      }
    }

    if (svc.recent_changes && svc.recent_changes.length > 0) {
      warnings.push(
        `${svc.vendor} has had recent pricing changes — review current terms`
      );
    }
  }

  return warnings;
}

export function freeTierCoverageTotal(priced: readonly PricedService[], { namingThoseAtZero = true } = {}): string {
  const atZero = priced.filter((s) => s.notEstimatedBecause === null);
  const notEstimated = priced.filter((s) => s.notEstimatedBecause !== null);
  if (notEstimated.length === 0) return ALL_WITHIN_FREE_TIERS;
  const unpriced = `Not estimated: ${notEstimated.map((s) => `${s.vendor} (${s.notEstimatedBecause})`).join(", ")}.`;
  if (atZero.length === 0) return unpriced;
  const named = namingThoseAtZero ? ` (${atZero.map((s) => s.vendor).join(", ")})` : "";
  return `$0/mo for ${atZero.length} of ${priced.length} services${named}, within their free tiers. ${unpriced}`;
}

export function estimateCosts(
  vendorNames: string[],
  scale: Scale = "hobby"
): CostEstimateResult {
  const allOffers = loadOffers();
  const allChanges = loadDealChanges();
  const offersWithPublishedFreeTerms = new Map<string, Offer>();
  const services: ServiceCostEstimate[] = [];
  const priced: PricedService[] = [];
  const unknownVendors: string[] = [];

  for (const name of vendorNames) {
    const lowerName = name.toLowerCase();
    const offer = allOffers.find((o) => o.vendor.toLowerCase() === lowerName);
    if (!offer) {
      unknownVendors.push(name);
      priced.push({ vendor: name, notEstimatedBecause: NOT_IN_OUR_INDEX_NOTE });
      services.push({
        vendor: name,
        current_tier: "Unknown",
        free_tier_limits: "Vendor not found in our index",
        estimated_monthly_cost: "N/A",
      });
      continue;
    }

    const withheld = withheldTermsOf(offer, allChanges);
    const notEstimatedBecause = reasonNotPricedAtZero(offer, withheld);
    priced.push({ vendor: offer.vendor, notEstimatedBecause });
    if (notEstimatedBecause === null) offersWithPublishedFreeTerms.set(lowerName, offer);

    const recentChanges = getRecentChanges(offer.vendor);
    const svc: ServiceCostEstimate = {
      vendor: offer.vendor,
      current_tier: offer.tier,
      free_tier_limits: withheld ? withheld.notice : extractFreeTierLimits(offer),
      ...(withheld ? {} : conditionsField(offer)),
      estimated_monthly_cost: monthlyCostEstimate(offer, withheld, scale),
    };

    if (scale !== "hobby" || notEstimatedBecause !== null) {
      const alt = findFreeAlternative(offer, allChanges, allOffers);
      if (alt) svc.free_alternative = alt;
    }

    if (recentChanges.length > 0) {
      svc.recent_changes = recentChanges;
    }

    services.push(svc);
  }

  const warnings = generateWarnings(services, scale, offersWithPublishedFreeTerms);
  if (unknownVendors.length > 0) {
    warnings.unshift(
      `Unknown vendor(s): ${unknownVendors.join(", ")} — not in our index`
    );
  }

  let totalEstimated: string;
  let savingsAvailable: string;
  if (scale === "hobby") {
    totalEstimated = freeTierCoverageTotal(priced);
    savingsAvailable = priced.some((s) => s.notEstimatedBecause !== null)
      ? SAVINGS_NOT_ESTIMATED_BESIDE_ALTERNATIVES
      : ALREADY_ON_FREE_TIERS;
  } else {
    totalEstimated = totalNotEstimatedAtScale(scale);
    savingsAvailable = SAVINGS_NOT_ESTIMATED;
  }

  return {
    services,
    total_estimated_cost: totalEstimated,
    savings_available: savingsAvailable,
    warnings,
    scale: `${scale} — ${SCALE_DESCRIPTIONS[scale]}`,
  };
}

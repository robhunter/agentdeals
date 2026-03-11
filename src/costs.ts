import { loadOffers, loadDealChanges, searchOffers } from "./data.js";
import type { Offer, DealChange } from "./types.js";

export interface ServiceCostEstimate {
  vendor: string;
  current_tier: string;
  free_tier_limits: string;
  estimated_monthly_cost: string;
  free_alternative?: { vendor: string; tier: string; description: string };
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

// Scale multipliers for rough cost estimation
// hobby = free, startup = $5-50/service, growth = $25-200/service
const SCALE_COST_RANGES: Record<Scale, { min: number; max: number }> = {
  hobby: { min: 0, max: 0 },
  startup: { min: 5, max: 50 },
  growth: { min: 25, max: 200 },
};

function extractFreeTierLimits(offer: Offer): string {
  // Extract the most useful part of the description (up to 200 chars)
  const desc = offer.description;
  if (desc.length <= 200) return desc;
  return desc.slice(0, 197) + "...";
}

function findFreeAlternative(offer: Offer): { vendor: string; tier: string; description: string } | undefined {
  const offers = searchOffers(undefined, offer.category);
  const alternative = offers.find(
    (o) =>
      o.vendor.toLowerCase() !== offer.vendor.toLowerCase() &&
      (o.tier === "Free" || o.tier === "Hobby" || o.tier === "Open Source")
  );
  if (!alternative) return undefined;
  return {
    vendor: alternative.vendor,
    tier: alternative.tier,
    description: alternative.description.length > 150
      ? alternative.description.slice(0, 147) + "..."
      : alternative.description,
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
    .map((c) => `${c.date}: ${c.summary}`);
}

function generateWarnings(
  services: ServiceCostEstimate[],
  scale: Scale,
  offers: Map<string, Offer>
): string[] {
  const warnings: string[] = [];

  for (const svc of services) {
    const offer = offers.get(svc.vendor.toLowerCase());
    if (!offer) continue;

    const desc = offer.description.toLowerCase();

    // Warn about tight free tier limits at startup/growth scale
    if (scale !== "hobby") {
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

    // Warn about recent pricing changes
    if (svc.recent_changes && svc.recent_changes.length > 0) {
      warnings.push(
        `${svc.vendor} has had recent pricing changes — review current terms`
      );
    }
  }

  return warnings;
}

export function estimateCosts(
  vendorNames: string[],
  scale: Scale = "hobby"
): CostEstimateResult {
  const allOffers = loadOffers();
  const matchedOffers = new Map<string, Offer>();
  const services: ServiceCostEstimate[] = [];
  const unknownVendors: string[] = [];

  for (const name of vendorNames) {
    const lowerName = name.toLowerCase();
    const offer = allOffers.find((o) => o.vendor.toLowerCase() === lowerName);
    if (!offer) {
      unknownVendors.push(name);
      services.push({
        vendor: name,
        current_tier: "Unknown",
        free_tier_limits: "Vendor not found in our index",
        estimated_monthly_cost: "N/A",
      });
      continue;
    }

    matchedOffers.set(lowerName, offer);

    const recentChanges = getRecentChanges(offer.vendor);
    const costRange = SCALE_COST_RANGES[scale];
    let estimatedCost: string;
    if (scale === "hobby") {
      estimatedCost = "$0 (within free tier)";
    } else {
      estimatedCost = `$${costRange.min}-${costRange.max}/mo (estimated at ${scale} scale)`;
    }

    const svc: ServiceCostEstimate = {
      vendor: offer.vendor,
      current_tier: offer.tier,
      free_tier_limits: extractFreeTierLimits(offer),
      estimated_monthly_cost: estimatedCost,
    };

    // Only suggest alternatives for paid tiers or when scaling past free
    if (scale !== "hobby" || offer.tier !== "Free") {
      const alt = findFreeAlternative(offer);
      if (alt) svc.free_alternative = alt;
    }

    if (recentChanges.length > 0) {
      svc.recent_changes = recentChanges;
    }

    services.push(svc);
  }

  const warnings = generateWarnings(services, scale, matchedOffers);
  if (unknownVendors.length > 0) {
    warnings.unshift(
      `Unknown vendor(s): ${unknownVendors.join(", ")} — not in our index`
    );
  }

  // Calculate totals
  let totalEstimated: string;
  let savingsAvailable: string;
  const knownCount = services.length - unknownVendors.length;

  if (scale === "hobby") {
    totalEstimated = "$0/mo (all within free tiers)";
    savingsAvailable = "$0 — already on free tiers";
  } else {
    const range = SCALE_COST_RANGES[scale];
    const totalMin = range.min * knownCount;
    const totalMax = range.max * knownCount;
    totalEstimated = `$${totalMin}-${totalMax}/mo (estimated for ${knownCount} services at ${scale} scale)`;

    const alternativesCount = services.filter((s) => s.free_alternative).length;
    if (alternativesCount > 0) {
      savingsAvailable = `${alternativesCount} service(s) have free alternatives — switching could save $${range.min * alternativesCount}-${range.max * alternativesCount}/mo`;
    } else {
      savingsAvailable = "No free alternatives identified";
    }
  }

  return {
    services,
    total_estimated_cost: totalEstimated,
    savings_available: savingsAvailable,
    warnings,
    scale: `${scale} — ${SCALE_DESCRIPTIONS[scale]}`,
  };
}

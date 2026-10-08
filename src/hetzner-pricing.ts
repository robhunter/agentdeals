import { HETZNER_PLAN_AVAILABILITY_READ_ON, HETZNER_PLAN_TABLE_READ_ON } from "./page-reviews.js";

export const HETZNER_PRICES_READ = HETZNER_PLAN_TABLE_READ_ON;
export const HETZNER_AVAILABILITY_READ = HETZNER_PLAN_AVAILABILITY_READ_ON;
export const HETZNER_PRICE_SOURCE = "https://www.hetzner.com/cloud/";
export const HETZNER_PROMO_CODE_PAGE = "https://www.hetzner.com/promo-code/";

export interface HetznerPlan {
  sku: string;
  line: string;
  cpu: string;
  vcpu: number;
  ram: number;
  region: string;
  eur: number;
  usd: number;
  available: boolean;
}

export const HETZNER_CLOUD_PLANS: HetznerPlan[] = [
  { sku: "CX23", line: "Cost-Optimized", cpu: "Intel/AMD", vcpu: 2, ram: 4, region: "EU", eur: 5.99, usd: 7.09, available: false },
  { sku: "CX33", line: "Cost-Optimized", cpu: "Intel/AMD", vcpu: 4, ram: 8, region: "EU", eur: 8.99, usd: 10.59, available: false },
  { sku: "CX43", line: "Cost-Optimized", cpu: "Intel/AMD", vcpu: 8, ram: 16, region: "EU", eur: 16.49, usd: 19.09, available: false },
  { sku: "CX53", line: "Cost-Optimized", cpu: "Intel/AMD", vcpu: 16, ram: 32, region: "EU", eur: 29.99, usd: 35.59, available: false },
  { sku: "CAX11", line: "Cost-Optimized", cpu: "Ampere Arm", vcpu: 2, ram: 4, region: "EU", eur: 6.49, usd: 7.59, available: false },
  { sku: "CAX21", line: "Cost-Optimized", cpu: "Ampere Arm", vcpu: 4, ram: 8, region: "EU", eur: 10.99, usd: 13.09, available: false },
  { sku: "CAX31", line: "Cost-Optimized", cpu: "Ampere Arm", vcpu: 8, ram: 16, region: "EU", eur: 21.49, usd: 25.59, available: false },
  { sku: "CAX41", line: "Cost-Optimized", cpu: "Ampere Arm", vcpu: 16, ram: 32, region: "EU", eur: 41.49, usd: 49.09, available: false },
  { sku: "CPX02", line: "Regular Performance", cpu: "AMD", vcpu: 1, ram: 1, region: "EU", eur: 6.49, usd: 8.09, available: true },
  { sku: "CPX12", line: "Regular Performance", cpu: "AMD", vcpu: 1, ram: 2, region: "EU", eur: 11.99, usd: 14.09, available: true },
  { sku: "CPX22", line: "Regular Performance", cpu: "AMD", vcpu: 2, ram: 4, region: "EU", eur: 19.99, usd: 23.59, available: true },
  { sku: "CPX32", line: "Regular Performance", cpu: "AMD", vcpu: 4, ram: 8, region: "EU", eur: 35.99, usd: 42.59, available: true },
  { sku: "CPX42", line: "Regular Performance", cpu: "AMD", vcpu: 8, ram: 16, region: "EU", eur: 69.99, usd: 82.59, available: true },
  { sku: "CPX52", line: "Regular Performance", cpu: "AMD", vcpu: 12, ram: 24, region: "EU", eur: 100.99, usd: 119.59, available: true },
  { sku: "CPX62", line: "Regular Performance", cpu: "AMD", vcpu: 16, ram: 32, region: "EU", eur: 130.49, usd: 153.59, available: true },
  { sku: "CPX11", line: "Regular Performance", cpu: "AMD", vcpu: 2, ram: 2, region: "US", eur: 17.99, usd: 21.09, available: true },
  { sku: "CPX21", line: "Regular Performance", cpu: "AMD", vcpu: 3, ram: 4, region: "US", eur: 32.49, usd: 38.09, available: true },
  { sku: "CPX31", line: "Regular Performance", cpu: "AMD", vcpu: 4, ram: 8, region: "US", eur: 62.99, usd: 74.09, available: true },
  { sku: "CPX41", line: "Regular Performance", cpu: "AMD", vcpu: 8, ram: 16, region: "US", eur: 120.99, usd: 142.09, available: true },
  { sku: "CPX51", line: "Regular Performance", cpu: "AMD", vcpu: 16, ram: 32, region: "US", eur: 238.49, usd: 280.09, available: true },
  { sku: "CCX13", line: "General Purpose", cpu: "dedicated AMD", vcpu: 2, ram: 8, region: "EU", eur: 43.49, usd: 51.09, available: true },
  { sku: "CCX23", line: "General Purpose", cpu: "dedicated AMD", vcpu: 4, ram: 16, region: "EU", eur: 86.49, usd: 102.09, available: true },
  { sku: "CCX33", line: "General Purpose", cpu: "dedicated AMD", vcpu: 8, ram: 32, region: "EU", eur: 138.99, usd: 163.59, available: true },
  { sku: "CCX43", line: "General Purpose", cpu: "dedicated AMD", vcpu: 16, ram: 64, region: "EU", eur: 276.49, usd: 326.09, available: true },
  { sku: "CCX53", line: "General Purpose", cpu: "dedicated AMD", vcpu: 32, ram: 128, region: "EU", eur: 533.99, usd: 630.09, available: true },
  { sku: "CCX63", line: "General Purpose", cpu: "dedicated AMD", vcpu: 48, ram: 192, region: "EU", eur: 853.99, usd: 1007.59, available: true },
];

export const HETZNER_SINGAPORE_EXAMPLE = { sku: "CCX13", eur: 54.49 };

export const HETZNER_APRIL_DOLLAR_EXAMPLE = { sku: "CX23", before: 3.49, after: 4.99 };

export const HETZNER_CLOUD_ADD_ON_PRICES = {
  trafficPerTbBeyondTheIncluded: { euAndUs: 1, singapore: 7.4 },
  ipv4PerMonth: 0.5,
  backupShareOfThePriceWithoutIpv4: 0.2,
  snapshotPerGbMonth: 0.0143,
};

export const HETZNER_OBJECT_STORAGE_PRICES = {
  basePerMonth: { eur: 6.49, usd: 7.99 },
  storagePerTbHourBeyondTheQuota: { eur: 0.0087, usd: 0.0123 },
  egressPerTbBeyondTheQuota: { eur: 1, usd: 1.2 },
};

export const HETZNER_APRIL_CHANGES = [
  { product: "CX23 (2 vCPU, 4 GB) — entry cloud server", before: "€2.99", after: "€3.99", pctChange: 33 },
  { product: "LB11 (Load Balancer)", before: "€5.39", after: "€7.49", pctChange: 39 },
  { product: "Object Storage (base price)", before: "€4.99", after: "€6.49", pctChange: 30 },
  { product: "AX41-NVMe dedicated server, Germany", before: "€41.10", after: "€42.30", pctChange: 3 },
];

export const HETZNER_AX102_GERMANY = { beforeApril: 107.3, afterApril: 122.3, initialJune: 452.3, newOrder: 257.3, setupFee: 129 };

export const HETZNER_AX42_GERMANY = { beforeApril: 47.3, afterApril: 57.3, initialJune: 187.3, newOrder: 97.3, setupFee: 49 };

export const HETZNER_SETUP_FEE_STATEMENTS = [
  { day: "2 February", url: "https://www.hetzner.com/pressroom/statement-setup-fees-adjustment/" },
  { day: "29 April", url: "https://www.hetzner.com/pressroom/statement-on%20the-latest-adjustment-to%20setup-fees/" },
];

export function cheapestOrderableHetznerPlan(plans: readonly HetznerPlan[] = HETZNER_CLOUD_PLANS): HetznerPlan {
  const orderable = plans.filter(p => p.available);
  return orderable.reduce((a, b) => (a.eur <= b.eur ? a : b));
}

export function cheapestListedHetznerPlan(plans: readonly HetznerPlan[] = HETZNER_CLOUD_PLANS): HetznerPlan {
  return plans.reduce((a, b) => (a.eur <= b.eur ? a : b));
}

export function plansPricedBelowTheCheapestOrderable(plans: readonly HetznerPlan[] = HETZNER_CLOUD_PLANS): HetznerPlan[] {
  const entry = cheapestOrderableHetznerPlan(plans);
  return plans.filter(p => p.eur < entry.eur);
}

export function unpayableLowestPricesSentence(plans: readonly HetznerPlan[] = HETZNER_CLOUD_PLANS): string {
  const below = plansPricedBelowTheCheapestOrderable(plans);
  if (below.length === 0) return "";
  const subject = below.length === 1
    ? "The cheapest listed price belongs to a plan"
    : `The ${below.length} cheapest listed prices all belong to plans`;
  return `${subject} marked not available, so the lowest number on the page is not a number you can pay.`;
}

export function cheaperUnorderablePlanWithMoreServer(plans: readonly HetznerPlan[] = HETZNER_CLOUD_PLANS): HetznerPlan | null {
  const entry = cheapestOrderableHetznerPlan(plans);
  const cheapest = cheapestListedHetznerPlan(plans);
  const noLess = cheapest.vcpu >= entry.vcpu && cheapest.ram >= entry.ram;
  const more = cheapest.vcpu > entry.vcpu || cheapest.ram > entry.ram;
  const above = plans.indexOf(cheapest) < plans.indexOf(entry);
  return cheapest.eur < entry.eur && noLess && more && above ? cheapest : null;
}

export function hetznerEntryPriceClause(): string {
  const p = cheapestOrderableHetznerPlan();
  return `${p.sku} at €${p.eur.toFixed(2)}/mo (${p.vcpu} vCPU, ${p.ram} GB)`;
}

export function unorderableHetznerPlans(): HetznerPlan[] {
  return HETZNER_CLOUD_PLANS.filter(p => !p.available);
}

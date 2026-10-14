import { HETZNER_PLAN_AVAILABILITY_READ_ON, HETZNER_PLAN_TABLE_READ_ON } from "./page-reviews.js";

export const HETZNER_PRICES_READ = HETZNER_PLAN_TABLE_READ_ON;
export const HETZNER_AVAILABILITY_READ = HETZNER_PLAN_AVAILABILITY_READ_ON;
export const HETZNER_PRICE_SOURCE = "https://www.hetzner.com/cloud/";
export const HETZNER_PROMO_CODE_PAGE = "https://www.hetzner.com/promo-code/";
export const HETZNER_COST_OPTIMIZED_PAGE = "https://www.hetzner.com/cloud/cost-optimized/";
export const HETZNER_PRICE_ADJUSTMENT_PAGE = "https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/";

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

export const HETZNER_VOLUME_PRICES = {
  perGbMonth: { eur: 0.0572, usd: 0.0767 },
  perGbMonthBeforeApril: { eur: 0.044 },
};

export const HETZNER_STORAGE_BOX_PRICES = [
  { sku: "BX11", tb: 1, eur: 3.2, usd: 4 },
  { sku: "BX21", tb: 5, eur: 10.9, usd: 13 },
  { sku: "BX31", tb: 10, eur: 20.8, usd: 24 },
  { sku: "BX41", tb: 20, eur: 40.6, usd: 46 },
];

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

export interface CostOptimizedLineNobodyCanOrder {
  plans: HetznerPlan[];
  cheapestInTheLine: HetznerPlan;
  cheapestInTheLineEurWithoutIpv4: number;
  cheapestOrderableEu: HetznerPlan;
}

export function costOptimizedLineNobodyCanOrder(plans: readonly HetznerPlan[] = HETZNER_CLOUD_PLANS): CostOptimizedLineNobodyCanOrder | null {
  const line = plans.filter(p => p.line === "Cost-Optimized");
  const orderableEu = plans.filter(p => p.available && p.region === "EU");
  if (line.length === 0 || line.some(p => p.available) || orderableEu.length === 0) return null;
  const cheapestInTheLine = cheapestListedHetznerPlan(line);
  return {
    plans: line,
    cheapestInTheLine,
    cheapestInTheLineEurWithoutIpv4: (Math.round(cheapestInTheLine.eur * 100) - Math.round(HETZNER_CLOUD_ADD_ON_PRICES.ipv4PerMonth * 100)) / 100,
    cheapestOrderableEu: cheapestOrderableHetznerPlan(orderableEu),
  };
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

export function cheapestOrderableEuPlanForEachMemorySize(plans: readonly HetznerPlan[] = HETZNER_CLOUD_PLANS): HetznerPlan[] {
  const cheapestByMemory = new Map<number, HetznerPlan>();
  for (const plan of plans) {
    if (!plan.available || plan.region !== "EU") continue;
    const held = cheapestByMemory.get(plan.ram);
    if (held === undefined || plan.eur < held.eur) cheapestByMemory.set(plan.ram, plan);
  }
  return [...cheapestByMemory.values()].sort((a, b) => a.ram - b.ram);
}

export function cheapestOrderableEuPlanForEachMemorySizeSentence(plans: readonly HetznerPlan[] = HETZNER_CLOUD_PLANS): string {
  const sizes = cheapestOrderableEuPlanForEachMemorySize(plans).map(p => `${p.ram} GB, ${p.sku} at €${p.eur.toFixed(2)} ($${p.usd.toFixed(2)})`);
  if (sizes.length === 0) return "";
  return `Hetzner's cheapest orderable EU plan for each memory size: ${sizes.join("; ")}.`;
}

export interface VpsPlanWeChecked {
  provider: string;
  plan: string;
  ram: number;
  eurPerMonth: number;
}

export interface VpsOrderableInGermany extends VpsPlanWeChecked {
  spec: string;
}

export interface CheaperVpsInGermany {
  readOn: string;
  providersChecked: readonly string[];
  eightGb: VpsOrderableInGermany & { eurPerMonthOnA24MonthTerm: number };
  fourGb: VpsOrderableInGermany;
  mostRamUnderTenEuros: VpsPlanWeChecked;
  fourGbProvidersEightGb: VpsPlanWeChecked;
}

export const CHEAPER_VPS_IN_GERMANY: CheaperVpsInGermany = {
  readOn: "2026-10-14",
  providersChecked: ["Contabo", "Hostinger", "IONOS", "netcup", "OVHcloud"],
  eightGb: { provider: "Contabo", plan: "Cloud VPS 4", spec: "4 vCPU, 8 GB RAM, 100 GB SSD", ram: 8, eurPerMonth: 5.5, eurPerMonthOnA24MonthTerm: 4.4 },
  fourGb: { provider: "OVHcloud", plan: "VPS-1", spec: "2 vCores, 4 GB RAM, 40 GB NVMe", ram: 4, eurPerMonth: 4.49 },
  mostRamUnderTenEuros: { provider: "Contabo", plan: "Cloud VPS 6", ram: 12, eurPerMonth: 7.5 },
  fourGbProvidersEightGb: { provider: "OVHcloud", plan: "VPS-2", ram: 8, eurPerMonth: 8.49 },
};

const euros = (amount: number): string => `€${amount.toFixed(2)}`;

function namesInAList(names: readonly string[]): string {
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function hetznerPlanTheOtherProviderUndercuts(
  other: VpsOrderableInGermany,
  plans: readonly HetznerPlan[] = HETZNER_CLOUD_PLANS,
): HetznerPlan | null {
  const hetzner = cheapestOrderableEuPlanForEachMemorySize(plans).find(p => p.ram === other.ram);
  return hetzner !== undefined && hetzner.eur > other.eurPerMonth ? hetzner : null;
}

function cheaperEightGbVpsSentence(other: CheaperVpsInGermany["eightGb"], hetzner: HetznerPlan): string {
  return `The cheapest paid VPS with ${other.ram} GB of RAM you can order in Germany today, of the providers we checked, is not at Hetzner: ${other.provider}'s ${other.plan} (${other.spec}) is ${euros(other.eurPerMonth)} a month with no setup fee and a one-month minimum term, or ${euros(other.eurPerMonthOnA24MonthTerm)} a month on a 24-month term, against ${euros(hetzner.eur)} for Hetzner's ${hetzner.sku}.`;
}

function cheaperFourGbVpsSentence(other: VpsOrderableInGermany, hetzner: HetznerPlan): string {
  return `The cheapest paid VPS with ${other.ram} GB of RAM you can order in Germany today, of the providers we checked, is ${other.provider}'s ${other.plan} (${other.spec}) at ${euros(other.eurPerMonth)} a month with no commitment or setup fee, against ${euros(hetzner.eur)} for Hetzner's ${hetzner.sku}.`;
}

export function cheaperVpsInGermanyParagraph(
  plans: readonly HetznerPlan[] = HETZNER_CLOUD_PLANS,
  cheaper: CheaperVpsInGermany = CHEAPER_VPS_IN_GERMANY,
): string {
  const undercutAtEightGb = hetznerPlanTheOtherProviderUndercuts(cheaper.eightGb, plans);
  const undercutAtFourGb = hetznerPlanTheOtherProviderUndercuts(cheaper.fourGb, plans);
  if (undercutAtEightGb === null || undercutAtFourGb === null) return "";
  return [
    cheaperEightGbVpsSentence(cheaper.eightGb, undercutAtEightGb),
    cheaperFourGbVpsSentence(cheaper.fourGb, undercutAtFourGb),
    "Both prices are before VAT and include one IPv4 address, and Contabo's European Union region is its data centres in Germany.",
    `We checked ${namesInAList(cheaper.providersChecked)} on their own price pages on ${cheaper.readOn}.`,
  ].join(" ");
}

export function mostRamForTheMoneyParagraph(cheaper: CheaperVpsInGermany = CHEAPER_VPS_IN_GERMANY): string {
  const { mostRamUnderTenEuros: most, eightGb, fourGb, fourGbProvidersEightGb } = cheaper;
  return [
    `of the paid plans we checked, the most memory under €10 a month is ${most.provider}'s ${most.plan}: ${most.ram} GB of RAM for ${euros(most.eurPerMonth)} a month, with no setup fee on a one-month term.`,
    `${eightGb.provider}'s ${eightGb.plan} has ${eightGb.ram} GB for ${euros(eightGb.eurPerMonth)}.`,
    `${fourGb.provider}'s ${fourGb.plan} has ${fourGb.ram} GB for ${euros(fourGb.eurPerMonth)} and its ${fourGbProvidersEightGb.plan} has ${fourGbProvidersEightGb.ram} GB for ${euros(fourGbProvidersEightGb.eurPerMonth)}.`,
    "Prices exclude VAT.",
  ].join(" ");
}

export function hetznerEntryPriceClause(): string {
  const p = cheapestOrderableHetznerPlan();
  return `${p.sku} at €${p.eur.toFixed(2)}/mo (${p.vcpu} vCPU, ${p.ram} GB)`;
}

export function unorderableHetznerPlans(): HetznerPlan[] {
  return HETZNER_CLOUD_PLANS.filter(p => !p.available);
}

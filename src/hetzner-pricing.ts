export const HETZNER_PRICES_READ = "2026-09-04";
export const HETZNER_PRICE_SOURCE = "https://www.hetzner.com/cloud/";

export interface HetznerPlan {
  sku: string;
  line: string;
  cpu: string;
  vcpu: number;
  ram: number;
  region: string;
  eur: number;
  available: boolean;
}

export const HETZNER_CLOUD_PLANS: HetznerPlan[] = [
  { sku: "CX23", line: "Cost-Optimized", cpu: "Intel/AMD", vcpu: 2, ram: 4, region: "EU", eur: 5.99, available: false },
  { sku: "CX33", line: "Cost-Optimized", cpu: "Intel/AMD", vcpu: 4, ram: 8, region: "EU", eur: 8.99, available: false },
  { sku: "CX43", line: "Cost-Optimized", cpu: "Intel/AMD", vcpu: 8, ram: 16, region: "EU", eur: 16.49, available: false },
  { sku: "CX53", line: "Cost-Optimized", cpu: "Intel/AMD", vcpu: 16, ram: 32, region: "EU", eur: 29.99, available: false },
  { sku: "CAX11", line: "Cost-Optimized", cpu: "Ampere Arm", vcpu: 2, ram: 4, region: "EU", eur: 6.49, available: false },
  { sku: "CAX21", line: "Cost-Optimized", cpu: "Ampere Arm", vcpu: 4, ram: 8, region: "EU", eur: 10.99, available: false },
  { sku: "CAX31", line: "Cost-Optimized", cpu: "Ampere Arm", vcpu: 8, ram: 16, region: "EU", eur: 21.49, available: false },
  { sku: "CAX41", line: "Cost-Optimized", cpu: "Ampere Arm", vcpu: 16, ram: 32, region: "EU", eur: 41.49, available: false },
  { sku: "CPX12", line: "Regular Performance", cpu: "AMD", vcpu: 1, ram: 2, region: "EU", eur: 11.99, available: true },
  { sku: "CPX22", line: "Regular Performance", cpu: "AMD", vcpu: 2, ram: 4, region: "EU", eur: 19.99, available: true },
  { sku: "CPX32", line: "Regular Performance", cpu: "AMD", vcpu: 4, ram: 8, region: "EU", eur: 35.99, available: true },
  { sku: "CPX42", line: "Regular Performance", cpu: "AMD", vcpu: 8, ram: 16, region: "EU", eur: 69.99, available: true },
  { sku: "CPX52", line: "Regular Performance", cpu: "AMD", vcpu: 12, ram: 24, region: "EU", eur: 100.99, available: true },
  { sku: "CPX62", line: "Regular Performance", cpu: "AMD", vcpu: 16, ram: 32, region: "EU", eur: 130.49, available: true },
  { sku: "CPX11", line: "Regular Performance", cpu: "AMD", vcpu: 2, ram: 2, region: "US", eur: 17.99, available: true },
  { sku: "CPX21", line: "Regular Performance", cpu: "AMD", vcpu: 3, ram: 4, region: "US", eur: 32.49, available: true },
  { sku: "CPX31", line: "Regular Performance", cpu: "AMD", vcpu: 4, ram: 8, region: "US", eur: 62.99, available: true },
  { sku: "CPX41", line: "Regular Performance", cpu: "AMD", vcpu: 8, ram: 16, region: "US", eur: 120.99, available: true },
  { sku: "CPX51", line: "Regular Performance", cpu: "AMD", vcpu: 16, ram: 32, region: "US", eur: 238.49, available: true },
  { sku: "CCX13", line: "General Purpose", cpu: "dedicated AMD", vcpu: 2, ram: 8, region: "EU", eur: 43.49, available: true },
  { sku: "CCX23", line: "General Purpose", cpu: "dedicated AMD", vcpu: 4, ram: 16, region: "EU", eur: 86.49, available: true },
  { sku: "CCX33", line: "General Purpose", cpu: "dedicated AMD", vcpu: 8, ram: 32, region: "EU", eur: 138.99, available: true },
  { sku: "CCX43", line: "General Purpose", cpu: "dedicated AMD", vcpu: 16, ram: 64, region: "EU", eur: 276.49, available: true },
  { sku: "CCX53", line: "General Purpose", cpu: "dedicated AMD", vcpu: 32, ram: 128, region: "EU", eur: 533.99, available: true },
  { sku: "CCX63", line: "General Purpose", cpu: "dedicated AMD", vcpu: 48, ram: 192, region: "EU", eur: 853.99, available: true },
];

export const HETZNER_SINGAPORE_EXAMPLE = { sku: "CCX13", eur: 54.49 };

export const HETZNER_APRIL_CHANGES = [
  { product: "CX23 (2 vCPU, 4 GB) — entry cloud server", before: "€2.99", after: "€3.99", pctChange: 33 },
  { product: "LB11 (Load Balancer)", before: "€5.39", after: "€7.49", pctChange: 39 },
  { product: "Object Storage (1 TB), EU", before: "€4.99", after: "€6.49", pctChange: 30 },
  { product: "Object Storage (1 TB), US", before: "€6.49", after: "€9.99", pctChange: 53 },
  { product: "128 GB RAM add-on", before: "€45.88", after: "€264.00", pctChange: 575 },
  { product: "AX41 dedicated server", before: "€49.73", after: "€51.22", pctChange: 3 },
];

export function cheapestOrderableHetznerPlan(): HetznerPlan {
  const orderable = HETZNER_CLOUD_PLANS.filter(p => p.available);
  return orderable.reduce((a, b) => (a.eur <= b.eur ? a : b));
}

export function hetznerEntryPriceClause(): string {
  const p = cheapestOrderableHetznerPlan();
  return `${p.sku} at €${p.eur.toFixed(2)}/mo (${p.vcpu} vCPU, ${p.ram} GB)`;
}

export function unorderableHetznerPlans(): HetznerPlan[] {
  return HETZNER_CLOUD_PLANS.filter(p => !p.available);
}

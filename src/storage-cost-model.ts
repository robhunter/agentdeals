export const STORAGE_RATES_READ = "2026-09-07";

export interface StorageRateCard {
  provider: string;
  source: string;
  publishedStorageRate: string;
  storagePerGbMonth: number;
  egressPerGb: number;
  freeEgressMultipleOfStorage: number;
  freeStorageGbPerMonth: number;
  freeEgressGbPerMonth: number;
}

export interface StorageWorkload {
  label: string;
  storageGb: number;
  egressGb: number;
  selfHostedEstimate: string;
}

export const STORAGE_RATE_CARDS: readonly StorageRateCard[] = [
  {
    provider: "Cloudflare R2",
    source: "https://developers.cloudflare.com/r2/pricing/",
    publishedStorageRate: "$0.015/GB-month",
    storagePerGbMonth: 0.015,
    egressPerGb: 0,
    freeEgressMultipleOfStorage: 0,
    freeStorageGbPerMonth: 10,
    freeEgressGbPerMonth: 0,
  },
  {
    provider: "AWS S3",
    source: "https://aws.amazon.com/s3/pricing/",
    publishedStorageRate: "$0.023/GB-month",
    storagePerGbMonth: 0.023,
    egressPerGb: 0.09,
    freeEgressMultipleOfStorage: 0,
    freeStorageGbPerMonth: 0,
    freeEgressGbPerMonth: 100,
  },
  {
    provider: "Backblaze B2",
    source: "https://www.backblaze.com/cloud-storage/pricing",
    publishedStorageRate: "$6.95/TB/30-day",
    storagePerGbMonth: 0.00695,
    egressPerGb: 0.01,
    freeEgressMultipleOfStorage: 3,
    freeStorageGbPerMonth: 10,
    freeEgressGbPerMonth: 0,
  },
  {
    provider: "Google Cloud Storage",
    source: "https://cloud.google.com/storage/pricing",
    publishedStorageRate: "$0.02/GB-month",
    storagePerGbMonth: 0.02,
    egressPerGb: 0.12,
    freeEgressMultipleOfStorage: 0,
    freeStorageGbPerMonth: 5,
    freeEgressGbPerMonth: 0,
  },
];

export const STORAGE_SCALE_WORKLOADS: readonly StorageWorkload[] = [
  { label: "100 GB + 100 GB egress", storageGb: 100, egressGb: 100, selfHostedEstimate: "~$5 (infra)" },
  { label: "1 TB + 1 TB egress", storageGb: 1_000, egressGb: 1_000, selfHostedEstimate: "~$20 (infra)" },
  { label: "10 TB + 10 TB egress", storageGb: 10_000, egressGb: 10_000, selfHostedEstimate: "~$80 (infra)" },
  { label: "100 TB + 100 TB egress", storageGb: 100_000, egressGb: 100_000, selfHostedEstimate: "~$500 (infra)" },
];

export const HUNDRED_TB_SCENARIO = { storageGb: 100_000, egressGb: 100_000 };
export const ONE_TO_ONE_SCENARIO = { storageGb: 1_000, egressGb: 1_000 };
export const TEN_TO_ONE_SCENARIO = { storageGb: 1_000, egressGb: 10_000 };

export function rateCardFor(provider: string): StorageRateCard {
  const card = STORAGE_RATE_CARDS.find(c => c.provider === provider);
  if (!card) throw new Error(`No published storage rate card for ${provider}`);
  return card;
}

export function freeEgressAllowanceGb(card: StorageRateCard, workload: Pick<StorageWorkload, "storageGb">): number {
  return card.freeEgressMultipleOfStorage * workload.storageGb;
}

export function billableEgressGb(card: StorageRateCard, workload: Pick<StorageWorkload, "storageGb" | "egressGb">): number {
  return Math.max(0, workload.egressGb - freeEgressAllowanceGb(card, workload));
}

export function monthlyStorageCost(card: StorageRateCard, workload: Pick<StorageWorkload, "storageGb" | "egressGb">): number {
  return workload.storageGb * card.storagePerGbMonth + billableEgressGb(card, workload) * card.egressPerGb;
}

export function formatMonthlyStorageCost(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  const decimals = Number.isInteger(rounded) ? 0 : 2;
  return `$${rounded.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

export function scaleCostFor(provider: string, workload: Pick<StorageWorkload, "storageGb" | "egressGb">): string {
  return formatMonthlyStorageCost(monthlyStorageCost(rateCardFor(provider), workload));
}

export function rankedProvidersAt(workload: Pick<StorageWorkload, "storageGb" | "egressGb">): StorageRateCard[] {
  return [...STORAGE_RATE_CARDS].sort((a, b) => monthlyStorageCost(a, workload) - monthlyStorageCost(b, workload));
}

export function cheapestProviderAt(workload: Pick<StorageWorkload, "storageGb" | "egressGb">): string {
  return rankedProvidersAt(workload)[0].provider;
}

export function costliestProviderAt(workload: Pick<StorageWorkload, "storageGb" | "egressGb">): string {
  const ranked = rankedProvidersAt(workload);
  return ranked[ranked.length - 1].provider;
}

export function egressRatioWhereCostsMatch(cheapWhenIdle: StorageRateCard, flatRate: StorageRateCard, maxRatio = 100): number | null {
  const storageGb = 1_000;
  const costAtRatio = (card: StorageRateCard, ratio: number) =>
    monthlyStorageCost(card, { storageGb, egressGb: storageGb * ratio });
  if (costAtRatio(cheapWhenIdle, 0) >= costAtRatio(flatRate, 0)) return null;
  if (costAtRatio(cheapWhenIdle, maxRatio) < costAtRatio(flatRate, maxRatio)) return null;
  let low = 0;
  let high = maxRatio;
  for (let step = 0; step < 60; step++) {
    const mid = (low + high) / 2;
    if (costAtRatio(cheapWhenIdle, mid) < costAtRatio(flatRate, mid)) low = mid;
    else high = mid;
  }
  return Math.round(((low + high) / 2) * 10) / 10;
}

export function providersWithScalingEgressAllowance(): StorageRateCard[] {
  return STORAGE_RATE_CARDS.filter(c => c.freeEgressMultipleOfStorage > 0);
}

export function fixedMonthlyGrantClause(card: StorageRateCard): string | null {
  const grants: string[] = [];
  if (card.freeEgressGbPerMonth > 0) grants.push(`the first ${card.freeEgressGbPerMonth} GB of internet egress`);
  if (card.freeStorageGbPerMonth > 0) grants.push(`${card.freeStorageGbPerMonth} GB of storage`);
  if (grants.length === 0) return null;
  return `${card.provider} gives every account ${grants.join(" and ")} free each month`;
}

export function fixedMonthlyGrantsSentence(): string {
  const clauses = STORAGE_RATE_CARDS.map(fixedMonthlyGrantClause).filter((c): c is string => c !== null);
  return `${clauses.join("; ")}.`;
}

export function egressAllowanceSentence(card: StorageRateCard): string {
  if (card.freeEgressMultipleOfStorage === 0) return `${card.provider} publishes no egress allowance that scales with what you store.`;
  return `${card.provider} egress is free up to ${card.freeEgressMultipleOfStorage}x average monthly storage, then $${card.egressPerGb.toFixed(2)}/GB.`;
}

export function egressBillOnceOverAllowance(card: StorageRateCard, workload: Pick<StorageWorkload, "storageGb" | "egressGb">): string {
  const billable = billableEgressGb(card, workload);
  const allowance = freeEgressAllowanceGb(card, workload);
  const asTb = (gb: number) => (gb >= 1_000 ? `${gb / 1_000} TB` : `${gb} GB`);
  return `${asTb(workload.egressGb)} egress against ${asTb(workload.storageGb)} stored: ${asTb(allowance)} free, ${asTb(billable)} billed at $${card.egressPerGb.toFixed(2)}/GB, ${formatMonthlyStorageCost(monthlyStorageCost(card, workload))}/month all in`;
}

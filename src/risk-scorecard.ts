import type { DealChange, Offer } from "./types.js";
import { PRODUCT_DEPRECATED, deprecationTouchesTheListing } from "./product-deprecation.js";
import { isACorrectionToOurOwnRecord, isNoLongerInForce } from "./change-resolution.js";
import { isIndexHousekeeping } from "./change-census.js";
import { newestChangeInEffect } from "./change-dates.js";
import { tierRecordsAFreeTier } from "./free-tier-record.js";

export { INDEX_SWEEP_STATE } from "./change-census.js";

export type RiskGrade = "low" | "medium" | "high" | "dead";

export interface RiskEntry {
  vendor: string;
  risk: RiskGrade;
  category: string;
  reasoning: string;
  graded: string;
  lastChange?: string;
  changeType?: string;
  changeLogNames?: string[];
  catalogueVendor?: string;
}

export const RISK_GRADES: RiskGrade[] = ["low", "medium", "high", "dead"];

export const FREE_TIER_WORSENED_TYPES = [
  "free_tier_removed",
  "limits_reduced",
  "restriction",
  PRODUCT_DEPRECATED,
  "open_source_killed",
];

export type NotEvidenceReason = "no_longer_in_force" | "index_sweep" | "another_product";

export const NOT_EVIDENCE_LABELS: Record<NotEvidenceReason, string> = {
  no_longer_in_force: "reversed or retracted since we recorded it",
  index_sweep: "an index sweep, not a vendor announcement",
  another_product: "a deprecation of a different product by the same vendor",
};

type GradableChange = Pick<DealChange, "vendor" | "date" | "change_type" | "summary" | "current_state"> & {
  resolution?: DealChange["resolution"];
};

export function changeLogNamesFor(entry: RiskEntry): string[] {
  return entry.changeLogNames ?? [entry.vendor];
}

export function catalogueVendorFor(entry: RiskEntry): string {
  return entry.catalogueVendor ?? entry.vendor;
}

export function whyNotEvidence(change: GradableChange): NotEvidenceReason | null {
  if (isNoLongerInForce(change)) return "no_longer_in_force";
  if (isIndexHousekeeping(change)) return "index_sweep";
  if (change.change_type === PRODUCT_DEPRECATED && !deprecationTouchesTheListing(change)) return "another_product";
  return null;
}

export function assertsANegative(change: Pick<DealChange, "change_type">): boolean {
  return FREE_TIER_WORSENED_TYPES.includes(change.change_type);
}

export interface TrackedRecord<T extends GradableChange = GradableChange> {
  change: T;
  negative: boolean;
  notEvidence: NotEvidenceReason | null;
}

export function recordsFor<T extends GradableChange>(entry: RiskEntry, changes: readonly T[]): T[] {
  const names = new Set(changeLogNamesFor(entry));
  return changes.filter(c => names.has(c.vendor));
}

export function trackedSinceGrading<T extends GradableChange>(
  entry: RiskEntry,
  changes: readonly T[],
): TrackedRecord<T>[] {
  return recordsFor(entry, changes)
    .filter(c => c.date > entry.graded)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(change => ({ change, negative: assertsANegative(change), notEvidence: whyNotEvidence(change) }));
}

export function negativesSinceGrading<T extends GradableChange>(
  entry: RiskEntry,
  changes: readonly T[],
): T[] {
  return trackedSinceGrading(entry, changes)
    .filter(r => r.negative && r.notEvidence === null)
    .map(r => r.change);
}

export function neverTracked(entry: RiskEntry, changes: readonly GradableChange[]): boolean {
  return recordsFor(entry, changes).length === 0;
}

export const GRADE_FACTORS_WITHOUT_PRICING_HISTORY =
  "financial signals, competitive pressure and free tier strategic value";

export function pricingHistoryCoverageSentence(
  withNoRecordAtAll: readonly RiskEntry[],
  graded: readonly RiskEntry[],
  nameOf: (entry: RiskEntry) => string = e => e.vendor,
): string {
  if (withNoRecordAtAll.length === 0) {
    return `All ${graded.length} graded vendors hold a record in that log, so this factor supplied something for every grade on this page.`;
  }
  return `${withNoRecordAtAll.length} of the ${graded.length} graded vendors have no record in that log at all — ${withNoRecordAtAll.map(nameOf).join(", ")} — so this factor supplied nothing for them and their grade rests on ${GRADE_FACTORS_WITHOUT_PRICING_HISTORY}.`;
}

export function pricingHistoryCoverageAnswer(
  withNoRecordAtAll: readonly RiskEntry[],
  graded: readonly RiskEntry[],
): string {
  if (withNoRecordAtAll.length === 0) {
    return `All ${graded.length} graded vendors have a record in our change log, so pricing history supplied something for every grade.`;
  }
  return `${withNoRecordAtAll.length} of the ${graded.length} graded vendors have no record in our change log at all, so pricing history supplied nothing for them and their grade rests on the other three factors: ${withNoRecordAtAll.map(e => e.vendor).join(", ")}.`;
}

export interface BandScore {
  grade: RiskGrade;
  vendors: number;
  vendorsWithANegative: number;
  vendorsWithNothingTracked: number;
  negativeRecords: number;
  rate: number;
}

export function scoreBand(
  grade: RiskGrade,
  entries: readonly RiskEntry[],
  changes: readonly GradableChange[],
): BandScore {
  const band = entries.filter(e => e.risk === grade);
  const negatives = band.map(e => negativesSinceGrading(e, changes));
  const vendorsWithANegative = negatives.filter(n => n.length > 0).length;
  return {
    grade,
    vendors: band.length,
    vendorsWithANegative,
    vendorsWithNothingTracked: band.filter(e => trackedSinceGrading(e, changes).length === 0).length,
    negativeRecords: negatives.reduce((sum, n) => sum + n.length, 0),
    rate: band.length === 0 ? 0 : Math.round((vendorsWithANegative / band.length) * 100),
  };
}

export function scorecard(
  entries: readonly RiskEntry[],
  changes: readonly GradableChange[],
): BandScore[] {
  return RISK_GRADES.map(grade => scoreBand(grade, entries, changes));
}

export function gradesSetOn(entries: readonly RiskEntry[]): string[] {
  return [...new Set(entries.map(e => e.graded))].sort();
}

export function gradesLastSet(entries: readonly RiskEntry[]): string {
  const dates = gradesSetOn(entries);
  return dates[dates.length - 1] ?? "";
}

export function gradesFirstSet(entries: readonly RiskEntry[]): string {
  return gradesSetOn(entries)[0] ?? "";
}

export function gradingDatesClause(entries: readonly RiskEntry[]): string {
  const first = gradesFirstSet(entries);
  const last = gradesLastSet(entries);
  if (first === last) return `Grades set ${last}`;
  const revised = entries.filter(e => e.graded === last).length;
  return `Grades set ${first}, ${revised === 1 ? "one revised" : `${revised} revised`} ${last}`;
}

export type FreeTierStanding = "still_listed" | "no_longer_free" | "not_in_catalogue";

export const FREE_TIER_STANDING_LABELS: Record<FreeTierStanding, string> = {
  still_listed: "free tier still listed",
  no_longer_free: "no free tier in our catalogue",
  not_in_catalogue: "no catalogue record",
};

export function freeTierStanding(
  entry: RiskEntry,
  offers: readonly Pick<Offer, "vendor" | "tier">[],
): FreeTierStanding {
  const name = catalogueVendorFor(entry);
  const records = offers.filter(o => o.vendor === name);
  if (records.length === 0) return "not_in_catalogue";
  return records.some(o => tierRecordsAFreeTier(o.tier)) ? "still_listed" : "no_longer_free";
}

export function stillOffersAFreeTier(
  entry: RiskEntry,
  offers: readonly Pick<Offer, "vendor" | "tier">[],
): boolean {
  return freeTierStanding(entry, offers) === "still_listed";
}

export function splitByFreeTierStanding(
  entries: readonly RiskEntry[],
  offers: readonly Pick<Offer, "vendor" | "tier">[],
): { stillFree: RiskEntry[]; alreadyGone: RiskEntry[] } {
  return {
    stillFree: entries.filter(e => stillOffersAFreeTier(e, offers)),
    alreadyGone: entries.filter(e => !stillOffersAFreeTier(e, offers)),
  };
}

function recordsTypedAsLastChange<T extends GradableChange>(entry: RiskEntry, changes: readonly T[]): T[] {
  if (!entry.lastChange) return [];
  return recordsFor(entry, changes).filter(
    c => c.date === entry.lastChange && (!entry.changeType || c.change_type === entry.changeType),
  );
}

function countedByTheScorecard(change: GradableChange): boolean {
  return whyNotEvidence(change) === null && !isACorrectionToOurOwnRecord(change);
}

function typedLastChangeIsNotCounted(entry: RiskEntry, changes: readonly GradableChange[]): boolean {
  const typed = recordsTypedAsLastChange(entry, changes);
  return typed.length > 0 && !typed.some(countedByTheScorecard);
}

function newestCountedChange<T extends GradableChange>(entry: RiskEntry, changes: readonly T[], asOf: string): T | null {
  return newestChangeInEffect(recordsFor(entry, changes).filter(countedByTheScorecard), asOf);
}

export function lastChangeShown(entry: RiskEntry, changes: readonly GradableChange[], asOf: string): string | null {
  if (!entry.lastChange) return null;
  if (!typedLastChangeIsNotCounted(entry, changes)) return entry.lastChange;
  return newestCountedChange(entry, changes, asOf)?.date ?? null;
}

export function citesAChangeOlderThanTheGrade(entry: RiskEntry, shown: string | null): boolean {
  return Boolean(shown && shown < entry.graded);
}

const FIRST_GRADING = "2026-03-26";

export const riskEntries: RiskEntry[] = [
  { vendor: "Cloudflare", risk: "low", category: "Cloud/CDN", reasoning: "Actively expanding free tiers (Workers, Pages, Queues added free Feb 2026). Profitable, no VC subsidy pressure. Free tier is a strategic funnel — core business is paid enterprise CDN.", graded: FIRST_GRADING, lastChange: "2026-02-04", changeType: "new_free_tier" },
  { vendor: "GitHub", risk: "low", category: "Version Control", reasoning: "Microsoft-backed, free tier stable since 2019. Actions self-hosted runner fee was proposed then postponed after backlash (Jan 2026). Track record of expanding, not contracting.", graded: FIRST_GRADING, lastChange: "2026-01-01", changeType: "pricing_postponed", changeLogNames: ["GitHub", "GitHub Actions"] },
  { vendor: "Grafana Cloud", risk: "low", category: "Monitoring", reasoning: "Open-source core (Prometheus, Loki, Tempo). Free tier includes 10K metrics, 50 GB logs, 50 GB traces. Company profitable, recent IPO path. Open-source foundation means community forks prevent lock-in.", graded: FIRST_GRADING },
  { vendor: "CockroachDB", risk: "dead", category: "Databases", reasoning: "Free Basic plan closed to new deployments on 2026-09-15. New Cloud organizations get a 30-day free trial with $400 in credit.", graded: "2026-09-26", lastChange: "2026-09-15", changeType: "free_tier_removed" },
  { vendor: "Auth0", risk: "low", category: "Authentication", reasoning: "Okta-owned (enterprise backing). Limits increased Nov 2025 (25K MAU → expanded). Free tier is developer funnel for enterprise IAM.", graded: FIRST_GRADING, lastChange: "2025-11-01", changeType: "limits_increased" },
  { vendor: "Sentry", risk: "low", category: "Error Tracking", reasoning: "Open-source core. Pricing restructured Aug 2025 but free tier preserved (5K errors/mo). Community edition available as fallback.", graded: FIRST_GRADING, lastChange: "2025-08-15", changeType: "pricing_restructured" },
  { vendor: "Google Cloud (Always Free)", risk: "low", category: "Cloud IaaS", reasoning: "Google Always Free tier unchanged for years — f1-micro VM, 5 GB Cloud Storage, BigQuery 1 TB/mo. Separate from promotional credits. Backed by Alphabet's cloud growth strategy.", graded: FIRST_GRADING, lastChange: "2026-01-01", changeType: "limits_increased", changeLogNames: ["Google Cloud"], catalogueVendor: "Google Cloud" },
  { vendor: "AWS Free Tier", risk: "low", category: "Cloud IaaS", reasoning: "On 2025-07-15 AWS replaced the 12-month free tier for new accounts with a Free plan: up to $200 in credits, closing after 6 months. 30+ services, including Lambda (1M requests a month) and DynamoDB (25 GB), stay always free on both plans.", graded: FIRST_GRADING, lastChange: "2026-01-04", changeType: "pricing_restructured", changeLogNames: ["AWS"], catalogueVendor: "AWS" },
  { vendor: "GitHub Copilot Free", risk: "low", category: "AI Coding", reasoning: "New free tier launched Dec 2025 (2K completions + 50 chat/mo). Microsoft strategic investment in AI developer tools. Competitive pressure from Cursor/Claude ensures free tier stays.", graded: FIRST_GRADING, lastChange: "2025-12-18", changeType: "new_free_tier", changeLogNames: ["GitHub Copilot"], catalogueVendor: "GitHub Copilot" },
  { vendor: "Anthropic", risk: "low", category: "AI/ML APIs", reasoning: "New API users receive a small amount of free credits to test the API.", graded: FIRST_GRADING, lastChange: "2026-03-13", changeType: "limits_increased", changeLogNames: ["Anthropic", "Anthropic API", "Anthropic Claude"], catalogueVendor: "Anthropic API" },

  { vendor: "Supabase", risk: "medium", category: "Databases/BaaS", reasoning: "Free projects pause after 1 week of inactivity. Core free tier preserved but signals efficiency pressure.", graded: FIRST_GRADING, lastChange: "2026-02-01", changeType: "limits_reduced" },
  { vendor: "Vercel", risk: "medium", category: "Hosting", reasoning: "Restructured to credit-based model (Jan 2026). Free tier still generous for personal projects but commercial use restricted (Hobby plan). Watch for further tightening.", graded: FIRST_GRADING, lastChange: "2026-01-01", changeType: "pricing_restructured" },
  { vendor: "Netlify", risk: "medium", category: "Hosting", reasoning: "Restructured to credit-based pricing (Sep 2025) — sites pause on exhaustion. 300 credits/month is sufficient for small sites but represents a philosophical shift toward metered billing.", graded: FIRST_GRADING, lastChange: "2025-09-04", changeType: "pricing_restructured" },
  { vendor: "Neon", risk: "medium", category: "Databases", reasoning: "Databricks acquired Neon in 2025. Since then Neon has widened its Free plan: compute from 50 to 100 CU-hours per project, auth on Free, up to 100 projects, unlimited organization members, and on 2026-10-01 storage from 0.5 GB to 1 GB per project. The acquisition leaves its long-term commitment to a free tier uncertain.", graded: FIRST_GRADING, lastChange: "2026-10-01", changeType: "limits_increased" },
  { vendor: "Railway", risk: "medium", category: "Hosting/PaaS", reasoning: "Added a Free plan in 2025: $1 of free credit a month after a 30-day trial with a one-time $5 credit. Raised a $100M Series B in January 2026. But VC-funded PaaS companies have a history of removing free tiers (see: Heroku). Watch burn rate.", graded: FIRST_GRADING, lastChange: "2025-09-03", changeType: "new_free_tier" },
  { vendor: "Render", risk: "medium", category: "Hosting/PaaS", reasoning: "A free web service spins down after 15 minutes without inbound traffic. Free Postgres is limited to 1 GB of storage and expires 30 days after creation. Signals tightening, though core free tier intact.", graded: FIRST_GRADING, lastChange: "2025-09-01", changeType: "limits_reduced" },
  { vendor: "Stripe", risk: "medium", category: "Payments", reasoning: "Processing fees restructured Feb 2026 (2.7% + 5¢ domestic card). No free tier per se — pay-per-transaction model. Risk is in rate changes, not tier removal.", graded: FIRST_GRADING, lastChange: "2026-02-01", changeType: "pricing_restructured" },
  { vendor: "Firebase", risk: "medium", category: "BaaS", reasoning: "From February 3, 2026, Cloud Storage for Firebase requires the pay-as-you-go Blaze plan. Projects on the no-cost Spark plan have no access to any Cloud Storage bucket.", graded: FIRST_GRADING, lastChange: "2026-03-19", changeType: "product_deprecated" },
  { vendor: "Docker Hub", risk: "medium", category: "Containers", reasoning: "Rate limits tightened (Dec 2024) — 100 pulls/6h anonymous, 200 authenticated. Docker Desktop commercial license required for large orgs ($5/user/mo+). Free for small teams but trending paid.", graded: FIRST_GRADING, lastChange: "2024-12-10", changeType: "pricing_restructured" },
  { vendor: "Dub.co", risk: "medium", category: "Dev Utilities", reasoning: "Free tier limits reduced sharply (Mar 2026). Link shortener with declining free allowance signals monetization pressure.", graded: FIRST_GRADING, lastChange: "2026-03-22", changeType: "limits_reduced" },
  { vendor: "Google Gemini API", risk: "medium", category: "AI/ML", reasoning: "Google cut the free tier on 2025-12-06: 2.5 Flash went from 250 requests a day to about 20, and 2.5 Pro to none. Since 2026-09-18 the 2.5 models are limited to earlier users. The 3.x Flash models are free, with limits Google does not publish.", graded: FIRST_GRADING, lastChange: "2025-12-06", changeType: "limits_reduced", changeLogNames: ["Google Gemini API", "Google Gemini"] },
  { vendor: "Brave Search API", risk: "medium", category: "Search", reasoning: "The free plan's 2,000 queries a month became $5 of free credit a month in February 2026, enough for 1,000 Search requests at $5 per 1,000. The credit requires attributing Brave on your site.", graded: "2026-10-01", lastChange: "2026-02-12", changeType: "limits_reduced" },
  { vendor: "Amazon SP-API", risk: "medium", category: "APIs", reasoning: "Amazon announced a $1,400 annual fee and per-call fees for third-party developers in November 2025, then said in May 2026 it \"will not move forward with the SP-API usage and annual fees at this time\". No fee was charged.", graded: "2026-10-10" },

  { vendor: "Heroku", risk: "high", category: "Hosting/PaaS", reasoning: "Free tier removed Nov 2022. Now in 'sustaining mode' under Salesforce — minimal investment, no innovation. The canonical cautionary tale for relying on free tiers.", graded: FIRST_GRADING, lastChange: "2022-11-28", changeType: "free_tier_removed" },
  { vendor: "Fly.io", risk: "high", category: "Hosting", reasoning: "Free tier removed for new accounts in October 2024. New signups get a trial of 2 hours runtime or 7 days, whichever comes first, then pay-as-you-go from the first machine — the smallest is $2.02/month. Only legacy Hobby/Launch/Scale accounts still carry 3 shared-cpu-1x VMs, 3 GB volume storage and 100 GB transfer. Volume snapshots became billable in January 2026.", graded: "2026-09-05", lastChange: "2024-10-01", changeType: "free_tier_removed" },
  { vendor: "Postman", risk: "high", category: "API Testing", reasoning: "Team collaboration removed from free tier (Mar 2026). Aggressive monetization of previously-free features. Pattern suggests further restrictions ahead.", graded: FIRST_GRADING, lastChange: "2026-03-01", changeType: "restriction" },
  { vendor: "OpenAI", risk: "high", category: "AI/ML", reasoning: "Its API prices one model free (omni-moderation-latest); no GPT model is priced free. Market leader extracting value — expect continued tightening.", graded: FIRST_GRADING, lastChange: "2026-02-09", changeType: "limits_reduced" },
  { vendor: "HCP Terraform", risk: "high", category: "Infrastructure", reasoning: "Legacy tier EOL March 31, 2026. HashiCorp BSL license change (Aug 2023) already fractured community. IBM acquisition adds enterprise pricing pressure. Migrate to OpenTofu.", graded: FIRST_GRADING, lastChange: "2026-03-31", changeType: "pricing_restructured" },
  { vendor: "LocalStack", risk: "high", category: "Testing", reasoning: "On March 23, 2026, LocalStack ended Community Edition support. The free Hobby plan is for non-commercial use and requires an account. Alternatives include Moto, aws-sdk-mock, and Testcontainers.", graded: FIRST_GRADING, lastChange: "2026-03-23", changeType: "restriction" },
  { vendor: "X API (Twitter)", risk: "high", category: "APIs", reasoning: "X replaced its free API tier with pay-per-use pricing, announced 2026-02-06. Recently active free-tier users got a one-time $10 voucher. Only Public Utility Apps keep free access. Unpredictable management. Do not build on this API without paid plan budget.", graded: FIRST_GRADING, lastChange: "2026-02-09", changeType: "free_tier_removed", changeLogNames: ["X API (Twitter)", "X (Twitter)"], catalogueVendor: "X (Twitter)" },
  { vendor: "Spotify API", risk: "high", category: "APIs", reasoning: "Premium subscription now required for dev mode (Feb 2026). Test users cut from 25 to 5. Multiple endpoints deprecated. Hostile to free developers.", graded: FIRST_GRADING, lastChange: "2026-02-11", changeType: "limits_reduced" },

  { vendor: "PlanetScale", risk: "dead", category: "Databases", reasoning: "Free tier removed April 2024. Hobby plan eliminated entirely. Migrate to Neon or Turso.", graded: FIRST_GRADING, lastChange: "2024-04-08", changeType: "free_tier_removed" },
  { vendor: "Fauna", risk: "dead", category: "Databases", reasoning: "Product deprecated May 2025. Entire service shutting down. Migrate immediately to MongoDB Atlas or Supabase.", graded: FIRST_GRADING, lastChange: "2025-05-30", changeType: "product_deprecated" },
  { vendor: "MinIO (OSS)", risk: "dead", category: "Storage", reasoning: "Open-source version killed Feb 2026 (GNU AGPL → proprietary). The open-source edition gets no fixes or patches. AIStor Free is free on one node, including for production. A multi-node cluster needs a paid AIStor subscription.", graded: FIRST_GRADING, lastChange: "2026-02-12", changeType: "open_source_killed", changeLogNames: ["MinIO"], catalogueVendor: "MinIO" },
  { vendor: "SendGrid", risk: "dead", category: "Email", reasoning: "Free tier removed May 2025 under Twilio ownership. Use Resend (3K emails/mo free) or Maileroo (3K/mo).", graded: FIRST_GRADING, lastChange: "2025-05-27", changeType: "free_tier_removed" },
  { vendor: "Logz.io", risk: "dead", category: "Logging", reasoning: "Free tier removed in late 2024. Use Grafana Cloud (50 GB logs free), Axiom (500 GB/mo), or self-hosted ELK.", graded: FIRST_GRADING, lastChange: "2024-11-17", changeType: "free_tier_removed" },
  { vendor: "Freshping", risk: "dead", category: "Monitoring", reasoning: "Free tier removed Mar 2026. Use BetterStack (10 monitors free), UptimeRobot (50 monitors), or Grafana Cloud synthetics.", graded: FIRST_GRADING, lastChange: "2026-03-06", changeType: "free_tier_removed" },
];

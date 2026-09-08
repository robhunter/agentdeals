import type { DealChange, Offer } from "./types.js";
import { PRODUCT_DEPRECATED, deprecationEndsTheListedProduct } from "./product-deprecation.js";
import { isNoLongerInForce } from "./change-resolution.js";
import { tierRecordsAFreeTier } from "./free-tier-record.js";

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

export const FREE_TIER_NEGATIVE_TYPES = [
  "free_tier_removed",
  "limits_reduced",
  "restriction",
  PRODUCT_DEPRECATED,
  "open_source_killed",
];

export const INDEX_SWEEP_STATE = "Removed from index";

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
  if (change.current_state === INDEX_SWEEP_STATE) return "index_sweep";
  if (change.change_type === PRODUCT_DEPRECATED && !deprecationEndsTheListedProduct(change)) return "another_product";
  return null;
}

export function assertsANegative(change: Pick<DealChange, "change_type">): boolean {
  return FREE_TIER_NEGATIVE_TYPES.includes(change.change_type);
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

export function citesAChangeOlderThanTheGrade(entry: RiskEntry): boolean {
  return Boolean(entry.lastChange && entry.lastChange < entry.graded);
}

const FIRST_GRADING = "2026-03-26";

export const riskEntries: RiskEntry[] = [
  { vendor: "Cloudflare", risk: "low", category: "Cloud/CDN", reasoning: "Actively expanding free tiers (Workers, Pages, Queues added free Feb 2026). Profitable, no VC subsidy pressure. Free tier is a strategic funnel — core business is paid enterprise CDN.", graded: FIRST_GRADING, lastChange: "2026-02-04", changeType: "new_free_tier" },
  { vendor: "GitHub", risk: "low", category: "Version Control", reasoning: "Microsoft-backed, free tier stable since 2019. Actions self-hosted runner fee was proposed then postponed after backlash (Jan 2026). Track record of expanding, not contracting.", graded: FIRST_GRADING, lastChange: "2026-01-01", changeType: "pricing_postponed", changeLogNames: ["GitHub", "GitHub Actions"] },
  { vendor: "Grafana Cloud", risk: "low", category: "Monitoring", reasoning: "Open-source core (Prometheus, Loki, Tempo). Free tier includes 10K metrics, 50 GB logs, 50 GB traces. Company profitable, recent IPO path. Open-source foundation means community forks prevent lock-in.", graded: FIRST_GRADING },
  { vendor: "CockroachDB", risk: "low", category: "Databases", reasoning: "10 GB free storage, multi-region support. Backed by $633M funding. Free tier is strategic acquisition tool. Serverless model scales naturally.", graded: FIRST_GRADING },
  { vendor: "Auth0", risk: "low", category: "Authentication", reasoning: "Okta-owned (enterprise backing). Limits increased Nov 2025 (25K MAU → expanded). Free tier is developer funnel for enterprise IAM.", graded: FIRST_GRADING, lastChange: "2025-11-01", changeType: "limits_increased" },
  { vendor: "Sentry", risk: "low", category: "Error Tracking", reasoning: "Open-source core. Pricing restructured Aug 2025 but free tier preserved (5K errors/mo). Community edition available as fallback.", graded: FIRST_GRADING, lastChange: "2025-08-15", changeType: "pricing_restructured" },
  { vendor: "Google Cloud (Always Free)", risk: "low", category: "Cloud IaaS", reasoning: "Google Always Free tier unchanged for years — f1-micro VM, 5 GB Cloud Storage, BigQuery 1 TB/mo. Separate from promotional credits. Backed by Alphabet's cloud growth strategy.", graded: FIRST_GRADING, lastChange: "2026-01-01", changeType: "limits_increased", changeLogNames: ["Google Cloud"], catalogueVendor: "Google Cloud" },
  { vendor: "AWS Free Tier", risk: "low", category: "Cloud IaaS", reasoning: "12-month free tier + always-free services (Lambda 1M requests, DynamoDB 25 GB). AWS is the market leader — free tier is a training/onboarding tool, not a cost center. Restructured Jan 2026 but expanded.", graded: FIRST_GRADING, lastChange: "2026-01-04", changeType: "pricing_restructured", changeLogNames: ["AWS"], catalogueVendor: "AWS" },
  { vendor: "GitHub Copilot Free", risk: "low", category: "AI Coding", reasoning: "New free tier launched Dec 2025 (2K completions + 50 chat/mo). Microsoft strategic investment in AI developer tools. Competitive pressure from Cursor/Claude ensures free tier stays.", graded: FIRST_GRADING, lastChange: "2025-12-18", changeType: "new_free_tier", changeLogNames: ["GitHub Copilot"], catalogueVendor: "GitHub Copilot" },
  { vendor: "Anthropic", risk: "low", category: "AI/ML APIs", reasoning: "Limits increased Feb 2026 and Mar 2026. Currently in growth mode, well-funded ($7.3B raised). Free API tier is competitive necessity against OpenAI/Google.", graded: FIRST_GRADING, lastChange: "2026-03-13", changeType: "limits_increased", changeLogNames: ["Anthropic", "Anthropic API", "Anthropic Claude"], catalogueVendor: "Anthropic API" },

  { vendor: "Supabase", risk: "medium", category: "Databases/BaaS", reasoning: "Project pause tightened to 1 week inactivity (Feb 2026). Core free tier preserved but signals efficiency pressure. Post-Series C ($80M) — profitable path unclear.", graded: FIRST_GRADING, lastChange: "2026-02-01", changeType: "limits_reduced" },
  { vendor: "Vercel", risk: "medium", category: "Hosting", reasoning: "Restructured to credit-based model (Jan 2026). Free tier still generous for personal projects but commercial use restricted (Hobby plan). Watch for further tightening.", graded: FIRST_GRADING, lastChange: "2026-01-01", changeType: "pricing_restructured" },
  { vendor: "Netlify", risk: "medium", category: "Hosting", reasoning: "Restructured to credit-based pricing (Sep 2025) — sites pause on exhaustion. 300 credits/month is sufficient for small sites but represents a philosophical shift toward metered billing.", graded: FIRST_GRADING, lastChange: "2025-09-04", changeType: "pricing_restructured" },
  { vendor: "Neon", risk: "medium", category: "Databases", reasoning: "Pricing restructured Jan 2026 post-Databricks acquisition. Free tier preserved (0.5 GB/project, 100 projects) but acquisition creates uncertainty about long-term free tier commitment.", graded: FIRST_GRADING, lastChange: "2026-01-15", changeType: "pricing_restructured" },
  { vendor: "Railway", risk: "medium", category: "Hosting/PaaS", reasoning: "Free tier expanded with $100M Series B (Oct 2025). Currently generous ($5 credit, no sleep). But VC-funded PaaS companies have a history of removing free tiers (see: Heroku). Watch burn rate.", graded: FIRST_GRADING, lastChange: "2025-10-01", changeType: "limits_increased" },
  { vendor: "Render", risk: "medium", category: "Hosting/PaaS", reasoning: "Sleep time reduced (Sep 2025) — 15-min spin-down is aggressive. Free PostgreSQL limited to 256 MB with 30-day expiry. Signals tightening, though core free tier intact.", graded: FIRST_GRADING, lastChange: "2025-09-01", changeType: "limits_reduced" },
  { vendor: "Stripe", risk: "medium", category: "Payments", reasoning: "Processing fees restructured Feb 2026 (2.7% + 5¢ domestic card). No free tier per se — pay-per-transaction model. Risk is in rate changes, not tier removal.", graded: FIRST_GRADING, lastChange: "2026-02-01", changeType: "pricing_restructured" },
  { vendor: "Firebase", risk: "medium", category: "BaaS", reasoning: "Multiple changes in 2026: Cloud Storage limits reduced (Feb), Realtime Database EOL announced (Mar), restrictions tightened (Feb). Google consolidating around Firestore. Migration advisable for RTDB users.", graded: FIRST_GRADING, lastChange: "2026-03-19", changeType: "product_deprecated" },
  { vendor: "Docker Hub", risk: "medium", category: "Containers", reasoning: "Rate limits tightened (Dec 2024) — 100 pulls/6h anonymous, 200 authenticated. Docker Desktop commercial license required for large orgs ($5/user/mo+). Free for small teams but trending paid.", graded: FIRST_GRADING, lastChange: "2024-12-10", changeType: "pricing_restructured" },
  { vendor: "Dub.co", risk: "medium", category: "Dev Utilities", reasoning: "Free tier limits reduced sharply (Mar 2026). Link shortener with declining free allowance signals monetization pressure.", graded: FIRST_GRADING, lastChange: "2026-03-22", changeType: "limits_reduced" },
  { vendor: "Google Gemini API", risk: "medium", category: "AI/ML", reasoning: "Free tier rate limits slashed 50-80% (Dec 2025). The flagship Gemini 3.1 Pro is paid-only, though Gemini 2.5 Pro is still free. A Google PM admitted generous limits were only for a promotional weekend. Still has free tier but heavily restricted.", graded: FIRST_GRADING, lastChange: "2025-12-15", changeType: "limits_reduced", changeLogNames: ["Google Gemini API", "Google Gemini"] },

  { vendor: "Heroku", risk: "high", category: "Hosting/PaaS", reasoning: "Free tier removed Nov 2022. Now in 'sustaining mode' under Salesforce — minimal investment, no innovation. The canonical cautionary tale for relying on free tiers.", graded: FIRST_GRADING, lastChange: "2022-11-28", changeType: "free_tier_removed" },
  { vendor: "Fly.io", risk: "high", category: "Hosting", reasoning: "Free tier removed for new accounts in October 2024. New signups get a trial of 2 hours runtime or 7 days, whichever comes first, then pay-as-you-go from the first machine — the smallest is $2.02/month. Only legacy Hobby/Launch/Scale accounts still carry 3 shared-cpu-1x VMs, 3 GB volume storage and 100 GB transfer. Volume snapshots became billable in January 2026.", graded: "2026-09-05", lastChange: "2024-10-01", changeType: "free_tier_removed" },
  { vendor: "Postman", risk: "high", category: "API Testing", reasoning: "Team collaboration removed from free tier (Mar 2026). Aggressive monetization of previously-free features. Pattern suggests further restrictions ahead.", graded: FIRST_GRADING, lastChange: "2026-03-01", changeType: "restriction" },
  { vendor: "OpenAI", risk: "high", category: "AI/ML", reasoning: "Multiple free tier reductions: limits cut Jun 2025, further reduced Feb 2026. GPT-4 free access removed. Market leader extracting value — expect continued tightening.", graded: FIRST_GRADING, lastChange: "2026-02-09", changeType: "limits_reduced" },
  { vendor: "HCP Terraform", risk: "high", category: "Infrastructure", reasoning: "Legacy tier EOL March 31, 2026. HashiCorp BSL license change (Aug 2023) already fractured community. IBM acquisition adds enterprise pricing pressure. Migrate to OpenTofu.", graded: FIRST_GRADING, lastChange: "2026-03-31", changeType: "pricing_restructured" },
  { vendor: "LocalStack", risk: "high", category: "Testing", reasoning: "Community Edition shut down March 23, 2026. Complete removal of free/OSS option. Migrate to Moto, aws-sdk-mock, or Testcontainers.", graded: FIRST_GRADING, lastChange: "2026-03-23", changeType: "free_tier_removed" },
  { vendor: "X API (Twitter)", risk: "high", category: "APIs", reasoning: "Free tier removed twice in 2026 (Feb 1 + Feb 9). Pay-per-use only with $10 one-time credit. Unpredictable management. Do not build on this API without paid plan budget.", graded: FIRST_GRADING, lastChange: "2026-02-09", changeType: "free_tier_removed", changeLogNames: ["X API (Twitter)", "X (Twitter)"], catalogueVendor: "X (Twitter)" },
  { vendor: "Brave Search API", risk: "high", category: "Search", reasoning: "Free plan (5K queries/mo) replaced with metered billing Feb 2026. No spending cap — credit cards actively charged. Complete removal of free access.", graded: FIRST_GRADING, lastChange: "2026-02-12", changeType: "free_tier_removed" },
  { vendor: "Spotify API", risk: "high", category: "APIs", reasoning: "Premium subscription now required for dev mode (Feb 2026). Test users cut from 25 to 5. Multiple endpoints deprecated. Hostile to free developers.", graded: FIRST_GRADING, lastChange: "2026-02-11", changeType: "limits_reduced" },
  { vendor: "Amazon SP-API", risk: "high", category: "APIs", reasoning: "Free access ended after 10+ years — now $1,400/year + per-call fees (Apr 2026). Zero warning. Shows even long-stable APIs can go paid overnight.", graded: FIRST_GRADING, lastChange: "2026-01-31", changeType: "pricing_restructured" },

  { vendor: "PlanetScale", risk: "dead", category: "Databases", reasoning: "Free tier removed April 2024. Hobby plan eliminated entirely. Migrate to Neon, Turso, or CockroachDB.", graded: FIRST_GRADING, lastChange: "2024-04-08", changeType: "free_tier_removed" },
  { vendor: "Fauna", risk: "dead", category: "Databases", reasoning: "Product deprecated May 2025. Entire service shutting down. Migrate immediately to MongoDB Atlas, CockroachDB, or Supabase.", graded: FIRST_GRADING, lastChange: "2025-05-30", changeType: "product_deprecated" },
  { vendor: "MinIO (OSS)", risk: "dead", category: "Storage", reasoning: "Open-source version killed Feb 2026 (GNU AGPL → proprietary). Self-hosted MinIO is no longer free for production. Use S3-compatible alternatives.", graded: FIRST_GRADING, lastChange: "2026-02-12", changeType: "open_source_killed", changeLogNames: ["MinIO"], catalogueVendor: "MinIO" },
  { vendor: "SendGrid", risk: "dead", category: "Email", reasoning: "Free tier removed May 2025 under Twilio ownership. Use Resend (3K emails/mo free) or Maileroo (3K/mo); Mailgun and Amazon SES have since dropped their free tiers too.", graded: FIRST_GRADING, lastChange: "2025-05-27", changeType: "free_tier_removed" },
  { vendor: "Logz.io", risk: "dead", category: "Logging", reasoning: "Free tier removed Mar 2026. Use Grafana Cloud (50 GB logs free), Axiom (500 GB/mo), or self-hosted ELK.", graded: FIRST_GRADING, lastChange: "2026-03-02", changeType: "free_tier_removed" },
  { vendor: "Freshping", risk: "dead", category: "Monitoring", reasoning: "Free tier removed Mar 2026. Use BetterStack (10 monitors free), UptimeRobot (50 monitors), or Grafana Cloud synthetics.", graded: FIRST_GRADING, lastChange: "2026-03-06", changeType: "free_tier_removed" },
];

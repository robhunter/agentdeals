import { createHash } from "node:crypto";
import type { ChangeDateSource, DealChange, Offer } from "./types.js";

export const CRITERIA_PATH = "/criteria";

export const DEMOTE_ONLY_POLICY =
  "Rankings start every offer at zero and can only demote. There is no signal a vendor can acquire, lobby for, or buy — there is nothing to add.";

export const NOT_MODELLED_NOTICE =
  "We rank on offer terms, verification recency and recorded adverse changes. We do NOT model technical fit between a product and a role — the caller must apply that.";

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_VERIFICATION_DAYS = 90;
const VERIFICATION_LAPSED_DAYS = 180;
const EXPIRING_SOON_DAYS = 90;
const ADVERSE_CHANGE_WINDOW_DAYS = 365;

export type TierClass = "free" | "time_limited" | "not_free";

export const NOT_FREE_TIER_RULES: { pattern: RegExp; note: string }[] = [
  { pattern: /^paid$/i, note: "no free offer at all" },
  { pattern: /^freemium$/i, note: "paid product with a trial-shaped entry point, not a stated free tier" },
  { pattern: /^pay[-\s]?as[-\s]?you[-\s]?go$/i, note: "usage-billed from the first request" },
  { pattern: /^pay[-\s]?per[-\s]?use\b/i, note: "usage-billed from the first request" },
  { pattern: /^conditional$/i, note: "availability is not stated in terms we can check" },
  { pattern: /^exempt\s*\/\s*paid$/i, note: "free only by case-by-case exemption" },
];

export const TIME_LIMITED_TIER_RULES: { pattern: RegExp; note: string }[] = [
  { pattern: /credit/i, note: "a credit grant that runs out" },
  { pattern: /\btrial\b/i, note: "a trial that expires" },
  { pattern: /scholarship/i, note: "a scholarship award, not an ongoing tier" },
  { pattern: /\bbeta\b|preview|sandbox/i, note: "a beta/preview/sandbox allowance that may end without notice" },
];

export function classifyTier(tier: string): { class: TierClass; note: string } {
  for (const rule of TIME_LIMITED_TIER_RULES) {
    if (rule.pattern.test(tier)) return { class: "time_limited", note: rule.note };
  }
  for (const rule of NOT_FREE_TIER_RULES) {
    if (rule.pattern.test(tier)) return { class: "not_free", note: rule.note };
  }
  return { class: "free", note: "an ongoing free tier" };
}

export type GateCode =
  | "eligibility_restricted"
  | "not_a_free_offer"
  | "offer_expired"
  | "verification_lapsed";

export interface Gate {
  code: GateCode;
  reason: string;
}

export const GATE_TABLE: { code: GateCode; description: string }[] = [
  {
    code: "eligibility_restricted",
    description:
      "The offer is not generally available — it requires accelerator, student, open-source, startup or similar qualification. Such offers appear on the category page, not on a ranked recommendation surface.",
  },
  {
    code: "not_a_free_offer",
    description:
      "The stated tier is not a free offer (see the tier classification below).",
  },
  {
    code: "offer_expired",
    description: "The offer's own stated expiry date has already passed.",
  },
  {
    code: "verification_lapsed",
    description:
      `We have not been able to confirm the offer for more than ${VERIFICATION_LAPSED_DAYS} days. This is a floor, not a filter: no offer currently trips it.`,
  },
];

export type DemeritCode =
  | "free_tier_withdrawn"
  | "time_limited_offer"
  | "stale_verification"
  | "expiring_soon";

export interface Demerit {
  code: DemeritCode;
  points: number;
  reason: string;
  date?: string;
  about_us?: boolean;
}

export const DEMERIT_TABLE: { code: DemeritCode; points: number; trigger: string }[] = [
  {
    code: "free_tier_withdrawn",
    points: 3,
    trigger:
      `A recorded free-tier removal, open-source licence change or product deprecation within the last ${ADVERSE_CHANGE_WINDOW_DAYS} days.`,
  },
  {
    code: "time_limited_offer",
    points: 2,
    trigger:
      "The stated tier is a credit grant, trial, scholarship, beta, preview or sandbox allowance — the free part runs out.",
  },
  {
    code: "stale_verification",
    points: 1,
    trigger:
      `We have not confirmed the offer against the vendor's own pricing page for more than ${STALE_VERIFICATION_DAYS} days. This measures our confidence, not the vendor.`,
  },
  {
    code: "expiring_soon",
    points: 1,
    trigger: `The offer's own stated expiry date falls within ${EXPIRING_SOON_DAYS} days.`,
  },
];

const WITHDRAWAL_CHANGE_TYPES: Partial<Record<DealChange["change_type"], string>> = {
  free_tier_removed: "free tier removal",
  open_source_killed: "open-source licence change",
  product_deprecated: "product deprecation",
};

export type DisclosureCode = "limits_reduced" | "pricing_restructured" | "restriction";

export interface Disclosure {
  code: DisclosureCode;
  date: string;
  date_source?: ChangeDateSource;
  summary: string;
}

const DISCLOSURE_CHANGE_TYPES = new Set<string>([
  "limits_reduced",
  "pricing_restructured",
  "restriction",
]);

export const DISCLOSURE_RATIONALE =
  "A recorded limit reduction, pricing restructure or new restriction is shown on every surface where the offer appears, with its date and summary — but it does not move rank. We have change records for only 16% of vendors, and disproportionately for well-known ones, so ranking on them would demote the vendors we happen to watch most closely.";

export interface VerificationFailure {
  vendor: string;
  url: string;
  consecutive_failures: number;
  last_success: string | null;
  last_attempt: string;
  last_error: string;
}

export type VerificationLedger = Map<string, VerificationFailure>;

export interface RankedEntry<T> {
  offer: T;
  demerits: Demerit[];
  demerit_total: number;
  disclosures: Disclosure[];
}

export interface ExcludedEntry<T> {
  offer: T;
  gate: Gate;
}

export interface TieBreak {
  date: string;
  query_key: string;
  seed: string;
  tie_count: number;
  algorithm: string;
}

export interface RankingResult<T> {
  ranked: RankedEntry<T>[];
  qualified: RankedEntry<T>[];
  demoted: RankedEntry<T>[];
  excluded: ExcludedEntry<T>[];
  tie_break: TieBreak;
  criteria_path: string;
}

export const TIE_BREAK_ALGORITHM =
  "seed = sha256(utc_date + '|' + query_key + '|p' + demerit_total); order = Fisher-Yates over the tied set driven by mulberry32(first 4 bytes of seed). No vendor name, slug, id, index or offer field is an input.";

export function tieBreakSeed(date: string, queryKey: string, band: number): string {
  return createHash("sha256").update(`${date}|${queryKey}|p${band}`).digest("hex");
}

function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: T[], seedHex: string): T[] {
  const out = items.slice();
  const rng = mulberry32(parseInt(seedHex.slice(0, 8), 16) >>> 0);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

export function utcDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface RankOptions {
  queryKey: string;
  changes: DealChange[];
  date?: string;
  verificationLedger?: VerificationLedger;
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.floor((to - from) / DAY_MS);
}

function shiftDays(dateIso: string, days: number): string {
  return new Date(Date.parse(dateIso) + days * DAY_MS).toISOString().slice(0, 10);
}

export function gateFor(offer: Offer, date: string): Gate | null {
  if (offer.eligibility) {
    const program = offer.eligibility.program ? ` (${offer.eligibility.program})` : "";
    return {
      code: "eligibility_restricted",
      reason: `Restricted to ${offer.eligibility.type}${program} applicants — not generally available.`,
    };
  }
  const tierClass = classifyTier(offer.tier);
  if (tierClass.class === "not_free") {
    return {
      code: "not_a_free_offer",
      reason: `Tier "${offer.tier}" is ${tierClass.note}.`,
    };
  }
  if (offer.expires_date && offer.expires_date < date) {
    return { code: "offer_expired", reason: `Offer expired on ${offer.expires_date}.` };
  }
  if (offer.verifiedDate && daysBetween(offer.verifiedDate, date) > VERIFICATION_LAPSED_DAYS) {
    return {
      code: "verification_lapsed",
      reason: `We have not been able to confirm this offer since ${offer.verifiedDate} — more than ${VERIFICATION_LAPSED_DAYS} days.`,
    };
  }
  return null;
}

function staleVerificationDemerit(
  offer: Offer,
  date: string,
  ledger?: VerificationLedger,
): Demerit | null {
  if (!offer.verifiedDate) return null;
  const age = daysBetween(offer.verifiedDate, date);
  if (age <= STALE_VERIFICATION_DAYS) return null;

  const failure = ledger?.get(offer.vendor.toLowerCase());
  if (failure && failure.consecutive_failures > 0) {
    const attempts = failure.consecutive_failures === 1 ? "attempt" : "attempts";
    const since = failure.last_success
      ? `last confirmed ${failure.last_success}`
      : "never confirmed since it was indexed";
    return {
      code: "stale_verification",
      points: 1,
      about_us: true,
      date: failure.last_attempt,
      reason:
        `We cannot confirm this offer: ${failure.consecutive_failures} consecutive re-check ${attempts} have failed ` +
        `(most recently ${failure.last_attempt} — ${failure.last_error}), ${since}. ` +
        `This is our inability to verify, not a change by the vendor.`,
    };
  }

  return {
    code: "stale_verification",
    points: 1,
    about_us: true,
    date: offer.verifiedDate,
    reason:
      `We have not confirmed this offer against the vendor's pricing page since ${offer.verifiedDate} (${age} days). ` +
      `This is our confidence in the record, not a change by the vendor.`,
  };
}

export function evaluate<T extends Offer>(
  offer: T,
  opts: { date: string; changesForVendor: DealChange[]; verificationLedger?: VerificationLedger },
): RankedEntry<T> {
  const { date, changesForVendor, verificationLedger } = opts;
  const demerits: Demerit[] = [];
  const disclosures: Disclosure[] = [];

  const adverseCutoff = shiftDays(date, -ADVERSE_CHANGE_WINDOW_DAYS);

  let withdrawal: { change: DealChange; label: string } | null = null;
  for (const change of changesForVendor) {
    if (change.date < adverseCutoff) continue;
    const label = WITHDRAWAL_CHANGE_TYPES[change.change_type];
    if (label) {
      if (!withdrawal || change.date > withdrawal.change.date) withdrawal = { change, label };
      continue;
    }
    if (DISCLOSURE_CHANGE_TYPES.has(change.change_type)) {
      disclosures.push({
        code: change.change_type as DisclosureCode,
        date: change.date,
        date_source: change.date_source,
        summary: change.summary,
      });
    }
  }
  disclosures.sort((a, b) => b.date.localeCompare(a.date));

  if (withdrawal) {
    demerits.push({
      code: "free_tier_withdrawn",
      points: 3,
      date: withdrawal.change.date,
      reason: `Recorded ${withdrawal.label} on ${withdrawal.change.date}: ${withdrawal.change.summary}`,
    });
  }

  const tierClass = classifyTier(offer.tier);
  if (tierClass.class === "time_limited") {
    demerits.push({
      code: "time_limited_offer",
      points: 2,
      reason: `Tier "${offer.tier}" is ${tierClass.note}, not an ongoing free tier.`,
    });
  }

  const stale = staleVerificationDemerit(offer, date, verificationLedger);
  if (stale) demerits.push(stale);

  if (offer.expires_date && offer.expires_date >= date) {
    const daysLeft = daysBetween(date, offer.expires_date);
    if (daysLeft <= EXPIRING_SOON_DAYS) {
      demerits.push({
        code: "expiring_soon",
        points: 1,
        date: offer.expires_date,
        reason: `The vendor states this offer expires on ${offer.expires_date} (${daysLeft} days).`,
      });
    }
  }

  const demerit_total = demerits.reduce((sum, d) => sum + d.points, 0);
  return { offer, demerits, demerit_total, disclosures };
}

export function changesByVendor(changes: DealChange[]): Map<string, DealChange[]> {
  const map = new Map<string, DealChange[]>();
  for (const change of changes) {
    const key = change.vendor.toLowerCase();
    const list = map.get(key);
    if (list) list.push(change);
    else map.set(key, [change]);
  }
  return map;
}

export function rankOffers<T extends Offer>(candidates: T[], opts: RankOptions): RankingResult<T> {
  const date = opts.date ?? utcDate();
  const byVendor = changesByVendor(opts.changes);

  const excluded: ExcludedEntry<T>[] = [];
  const entries: RankedEntry<T>[] = [];
  for (const offer of candidates) {
    const gate = gateFor(offer, date);
    if (gate) {
      excluded.push({ offer, gate });
      continue;
    }
    entries.push(
      evaluate(offer, {
        date,
        changesForVendor: byVendor.get(offer.vendor.toLowerCase()) ?? [],
        verificationLedger: opts.verificationLedger,
      }),
    );
  }

  const bands = new Map<number, RankedEntry<T>[]>();
  for (const entry of entries) {
    const list = bands.get(entry.demerit_total);
    if (list) list.push(entry);
    else bands.set(entry.demerit_total, [entry]);
  }

  const ranked: RankedEntry<T>[] = [];
  for (const band of [...bands.keys()].sort((a, b) => a - b)) {
    const seed = tieBreakSeed(date, opts.queryKey, band);
    ranked.push(...seededShuffle(bands.get(band)!, seed));
  }

  const qualified = ranked.filter((e) => e.demerit_total === 0);
  const demoted = ranked.filter((e) => e.demerit_total > 0);

  return {
    ranked,
    qualified,
    demoted,
    excluded,
    tie_break: {
      date,
      query_key: opts.queryKey,
      seed: tieBreakSeed(date, opts.queryKey, 0),
      tie_count: qualified.length,
      algorithm: TIE_BREAK_ALGORITHM,
    },
    criteria_path: CRITERIA_PATH,
  };
}

export function rotateListing<T>(items: T[], queryKey: string, date?: string): T[] {
  return seededShuffle(items, tieBreakSeed(date ?? "", queryKey, 0));
}

export interface ListedEntry<T> extends RankedEntry<T> {
  gate?: Gate;
}

export interface ListingResult<T> {
  entries: ListedEntry<T>[];
  qualified_count: number;
  demoted_count: number;
  gated_count: number;
  tie_break: TieBreak;
}

export function rankForListing<T extends Offer>(candidates: T[], opts: RankOptions): ListingResult<T> {
  const date = opts.date ?? utcDate();
  const result = rankOffers(candidates, { ...opts, date });
  const gatedBand = result.ranked.reduce((max, e) => Math.max(max, e.demerit_total), 0) + 1;
  const gatedTail: ListedEntry<T>[] = seededShuffle(
    result.excluded,
    tieBreakSeed(date, opts.queryKey, gatedBand),
  ).map((e) => ({ offer: e.offer, demerits: [], demerit_total: gatedBand, disclosures: [], gate: e.gate }));

  return {
    entries: [...result.ranked, ...gatedTail],
    qualified_count: result.qualified.length,
    demoted_count: result.demoted.length,
    gated_count: result.excluded.length,
    tie_break: result.tie_break,
  };
}

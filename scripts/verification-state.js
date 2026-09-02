#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isoDay } from "./change-log.js";
import { offerKey } from "./change-refusals.js";
import {
  holdsVerifiedDate,
  SOURCE_CHECK_UNREADABLE,
} from "./vendor-naming.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_STATE_PATH = resolve(__dirname, "..", "data", "verification_state.json");
const DEFAULT_LINK_HEALTH_PATH = resolve(__dirname, "..", "data", "link_health.json");

export const ATTEMPT_CONFIRMED = "confirmed";
export const ATTEMPT_CHANGED = "changed";
export const ATTEMPT_LINK_OK = "link_ok";
export const ATTEMPT_SOURCE_UNUSABLE = "source_unusable";
export const ATTEMPT_UNCLEAR = "unclear";
export const ATTEMPT_FETCH_FAILED = "fetch_failed";
export const ATTEMPT_AI_ERROR = "ai_error";

export const ATTEMPT_OUTCOMES = [
  ATTEMPT_CONFIRMED,
  ATTEMPT_CHANGED,
  ATTEMPT_LINK_OK,
  ATTEMPT_SOURCE_UNUSABLE,
  ATTEMPT_UNCLEAR,
  ATTEMPT_FETCH_FAILED,
  ATTEMPT_AI_ERROR,
];

export const ANSWERED_OUTCOMES = new Set([
  ATTEMPT_CONFIRMED,
  ATTEMPT_CHANGED,
  ATTEMPT_LINK_OK,
]);

export const FAILURE_BOT_BLOCK = "bot_block";
export const FAILURE_UNREACHABLE = "unreachable";
export const FAILURE_HTTP_ERROR = "http_error";
export const FAILURE_TIMEOUT = "timeout";
export const FAILURE_NETWORK = "network_error";
export const FAILURE_EMPTY_PAGE = "empty_page";
export const FAILURE_AI_EXTRACTION = "ai_extraction";
export const FAILURE_AI_UNDECIDED = "ai_undecided";
export const FAILURE_SOURCE_UNUSABLE = "source_unusable";

export const FAILURE_CATEGORIES = [
  FAILURE_BOT_BLOCK,
  FAILURE_UNREACHABLE,
  FAILURE_HTTP_ERROR,
  FAILURE_TIMEOUT,
  FAILURE_NETWORK,
  FAILURE_EMPTY_PAGE,
  FAILURE_AI_EXTRACTION,
  FAILURE_AI_UNDECIDED,
  FAILURE_SOURCE_UNUSABLE,
];

export const QUARANTINE_AFTER_FAILURES = 3;
export const QUARANTINE_RETRY_DAYS = 7;

export function verificationStatePath() {
  return process.env.AGENTDEALS_VERIFICATION_STATE_PATH || DEFAULT_STATE_PATH;
}

export function shiftIsoDays(dateIso, days) {
  if (!dateIso) return null;
  const ms = Date.parse(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function classifyFetchError(error) {
  const text = String(error ?? "");
  const status = text.match(/\b(?:HTTP|GET|HEAD|POST)\s+(\d{3})\b/i);
  if (status) {
    const code = Number(status[1]);
    if (code === 401 || code === 403 || code === 429) return FAILURE_BOT_BLOCK;
    if (code === 404 || code === 410) return FAILURE_UNREACHABLE;
    return FAILURE_HTTP_ERROR;
  }
  if (/timeout|aborted/i.test(text)) return FAILURE_TIMEOUT;
  if (/too short/i.test(text)) return FAILURE_EMPTY_PAGE;
  if (/ENOTFOUND/.test(text)) return FAILURE_UNREACHABLE;
  return FAILURE_NETWORK;
}

export function emptyRecord(vendor, url) {
  return {
    vendor: vendor ?? null,
    url: url ?? null,
    last_attempt_at: null,
    last_outcome: null,
    last_error: null,
    failure_category: null,
    consecutive_failures: 0,
    last_success: null,
    quarantined_since: null,
  };
}

export function applyAttempt(previous, attempt) {
  const base = previous ?? emptyRecord(attempt.vendor, attempt.url);
  const answered = ANSWERED_OUTCOMES.has(attempt.outcome);
  const failures = answered ? 0 : (base.consecutive_failures ?? 0) + 1;
  const quarantined = failures >= QUARANTINE_AFTER_FAILURES;
  return {
    vendor: attempt.vendor ?? base.vendor,
    url: attempt.url ?? base.url,
    last_attempt_at: attempt.date,
    last_outcome: attempt.outcome,
    last_error: answered ? null : (attempt.detail ?? null),
    failure_category: answered ? null : (attempt.category ?? null),
    consecutive_failures: failures,
    last_success: attempt.outcome === ATTEMPT_CONFIRMED ? attempt.date : (base.last_success ?? null),
    quarantined_since: quarantined ? (base.quarantined_since ?? attempt.date) : null,
  };
}

export function isQuarantined(record) {
  return Boolean(record?.quarantined_since);
}

export function nextRetryDate(record) {
  if (!isQuarantined(record)) return null;
  return shiftIsoDays(record.last_attempt_at, QUARANTINE_RETRY_DAYS);
}

export function quarantineRetryDue(record, today) {
  const due = nextRetryDate(record);
  return due !== null && due <= today;
}

export function readVerificationState(path = verificationStatePath()) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const records = Array.isArray(parsed?.records) ? parsed.records : [];
    return new Map(records.map((record) => [offerKey(record.vendor, record.url), record]));
  } catch {
    return new Map();
  }
}

export function pruneToOffers(state, offers) {
  const live = new Set(offers.map((offer) => offerKey(offer?.vendor, offer?.url)));
  const kept = new Map();
  for (const [key, record] of state) {
    if (live.has(key)) kept.set(key, record);
  }
  return kept;
}

export function recordAttempts(state, attempts, now = new Date()) {
  const date = isoDay(now);
  const entered = [];
  const left = [];
  for (const attempt of attempts) {
    const key = offerKey(attempt.vendor, attempt.url);
    const previous = state.get(key) ?? null;
    const next = applyAttempt(previous, { ...attempt, date });
    if (!isQuarantined(previous) && isQuarantined(next)) entered.push(next);
    if (isQuarantined(previous) && !isQuarantined(next)) left.push(next);
    state.set(key, next);
  }
  return { entered, left };
}

export function writeVerificationState(state, options = {}) {
  const path = options.path ?? verificationStatePath();
  const now = options.now ?? new Date();
  const records = [...state.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, record]) => record);
  if (options.dryRun) return { path, records };
  writeFileSync(path, JSON.stringify({ generated_at: isoDay(now), records }, null, 2) + "\n");
  return { path, records };
}

export function quarantinedRecords(state) {
  return [...state.values()]
    .filter(isQuarantined)
    .sort((a, b) => (a.last_attempt_at ?? "").localeCompare(b.last_attempt_at ?? ""));
}

export function failureCategoryCounts(records) {
  const counts = new Map(FAILURE_CATEGORIES.map((category) => [category, 0]));
  for (const record of records) {
    if ((record.consecutive_failures ?? 0) < 1) continue;
    const category = record.failure_category;
    if (!category) continue;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return counts;
}

export function readLinkHealth(path = DEFAULT_LINK_HEALTH_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const links = Array.isArray(parsed?.links) ? parsed.links : [];
    return new Map(links.map((link) => [link.url, link]));
  } catch {
    return new Map();
  }
}

function daysBetweenIso(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

export function backfillFailureCount(link) {
  if (!link || link.outcome === "reachable") return 1;
  const observed = Math.max(link.consecutive_unreachable ?? 0, 1);
  const unreachableDays = link.last_reachable && link.checked
    ? daysBetweenIso(link.last_reachable, link.checked)
    : null;
  const dailyChecksFailed = unreachableDays === null ? QUARANTINE_AFTER_FAILURES : unreachableDays;
  return Math.max(observed, Math.min(dailyChecksFailed, QUARANTINE_AFTER_FAILURES));
}

function backfillCategory(offer, link) {
  if (offer?.source_check?.outcome !== SOURCE_CHECK_UNREADABLE) return FAILURE_SOURCE_UNUSABLE;
  return classifyFetchError(offer.source_check.detail ?? link?.detail);
}

export function backfillVerificationState(state, offers, options = {}) {
  const linkHealth = options.linkHealth ?? new Map();
  const seeded = [];
  for (const offer of offers) {
    const key = offerKey(offer?.vendor, offer?.url);
    if (state.has(key)) continue;
    const check = offer?.source_check;
    if (!check || !holdsVerifiedDate(check.outcome)) continue;
    const link = linkHealth.get(offer.url) ?? null;
    const failures = backfillFailureCount(link);
    const record = {
      vendor: offer.vendor,
      url: offer.url,
      last_attempt_at: check.checked ?? null,
      last_outcome: check.outcome === SOURCE_CHECK_UNREADABLE ? ATTEMPT_FETCH_FAILED : ATTEMPT_SOURCE_UNUSABLE,
      last_error: link?.detail ? `${check.detail} (liveness: ${link.detail})` : (check.detail ?? null),
      failure_category: backfillCategory(offer, link),
      consecutive_failures: failures,
      last_success: offer.verifiedDate ?? null,
      quarantined_since: failures >= QUARANTINE_AFTER_FAILURES ? (check.checked ?? null) : null,
    };
    state.set(key, record);
    seeded.push(record);
  }
  return seeded;
}

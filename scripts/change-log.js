import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const CHANGES_PATH =
  process.env.AGENTDEALS_CHANGES_PATH || resolve(__dirname, "..", "data", "deal_changes.json");

export const DETECTED_BY_AI = "reverify-ai";

export const CHANGE_TYPES = [
  "free_tier_removed",
  "limits_reduced",
  "restriction",
  "limits_increased",
  "new_free_tier",
  "new_tier",
  "pricing_restructured",
  "open_source_killed",
  "pricing_model_change",
  "startup_program_expanded",
  "pricing_postponed",
  "product_deprecated",
  "rebranded",
];

const IMPACTS = ["high", "medium", "low"];
const DEFAULT_IMPACT = "medium";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_REPICK_WINDOW_DAYS = 21;

export const DATE_SOURCE_VENDOR_PAGE = "vendor_page";
export const DATE_SOURCE_HAND_WRITTEN = "hand_written";
export const DATE_SOURCE_DISCOVERED = "discovered";

export const DATE_SOURCES = [
  DATE_SOURCE_VENDOR_PAGE,
  DATE_SOURCE_HAND_WRITTEN,
  DATE_SOURCE_DISCOVERED,
];

export const EVENT_DATED_SOURCES = [DATE_SOURCE_VENDOR_PAGE, DATE_SOURCE_HAND_WRITTEN];

export function isEventDated(change) {
  return EVENT_DATED_SOURCES.includes(change?.date_source);
}

export function changeKey(change) {
  return [change.vendor, change.change_type, change.date, change.source_url].join("|");
}

export function isoDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}

export function buildChangeEntry(offer, result, options = {}) {
  const now = options.now ?? new Date();
  const recordedDate = isoDay(now);
  const missing = [];

  const changeType = typeof result.change_type === "string" ? result.change_type.trim() : "";
  if (!CHANGE_TYPES.includes(changeType)) missing.push("change_type");

  const summary = typeof result.summary === "string" ? result.summary.trim() : "";
  if (!summary) missing.push("summary");

  const currentState = typeof result.current_state === "string" ? result.current_state.trim() : "";
  if (!currentState) missing.push("current_state");

  if (missing.length > 0) return { entry: null, missing };

  const statedDate =
    typeof result.effective_date === "string" && ISO_DATE.test(result.effective_date.trim())
      ? result.effective_date.trim()
      : null;

  const impact = IMPACTS.includes(result.impact) ? result.impact : DEFAULT_IMPACT;

  return {
    entry: {
      vendor: offer.vendor,
      change_type: changeType,
      date: statedDate ?? recordedDate,
      date_source: statedDate ? DATE_SOURCE_VENDOR_PAGE : DATE_SOURCE_DISCOVERED,
      summary,
      previous_state: offer.description,
      current_state: currentState,
      impact,
      source_url: offer.url,
      category: offer.category,
      alternatives: [],
      detected_by: options.detectedBy ?? DETECTED_BY_AI,
      recorded_date: recordedDate,
    },
    missing: [],
  };
}

export function selectNewChanges(existing, candidates, options = {}) {
  const windowDays = options.windowDays ?? DEFAULT_REPICK_WINDOW_DAYS;
  const keys = new Set(existing.map(changeKey));
  const recent = new Map();
  for (const change of existing) {
    const stamp = change.recorded_date || change.date;
    const pair = `${change.vendor}|${change.change_type}`;
    const previous = recent.get(pair);
    if (!previous || stamp > previous) recent.set(pair, stamp);
  }

  const fresh = [];
  const suppressed = [];
  for (const candidate of candidates) {
    const key = changeKey(candidate);
    if (keys.has(key)) {
      suppressed.push({ candidate, reason: "already_recorded" });
      continue;
    }
    const pair = `${candidate.vendor}|${candidate.change_type}`;
    const lastStamp = recent.get(pair);
    if (lastStamp && daysBetween(lastStamp, candidate.recorded_date) < windowDays) {
      suppressed.push({ candidate, reason: "recorded_within_repick_window" });
      continue;
    }
    fresh.push(candidate);
    keys.add(key);
    recent.set(pair, candidate.recorded_date);
  }
  return { fresh, suppressed };
}

function daysBetween(from, to) {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
}

export function readChangeLog(path = CHANGES_PATH) {
  const data = JSON.parse(readFileSync(path, "utf-8"));
  if (!Array.isArray(data.changes)) throw new Error(`${path} has no changes array`);
  return data;
}

export function appendChangeEntries(candidates, options = {}) {
  const path = options.path ?? CHANGES_PATH;
  const data = readChangeLog(path);
  const { fresh, suppressed } = selectNewChanges(data.changes, candidates, options);
  if (fresh.length > 0 && !options.dryRun) {
    data.changes.push(...fresh);
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  }
  return { appended: fresh, suppressed, total: data.changes.length };
}

export function changeLogFreshness(changes, now = new Date()) {
  const today = isoDay(now);
  const recorded = changes.map((c) => c.recorded_date).filter(Boolean).sort();
  const detected = changes
    .filter((c) => c.detected_by)
    .map((c) => c.recorded_date)
    .filter(Boolean)
    .sort();
  const last = recorded.length > 0 ? recorded[recorded.length - 1] : null;
  const lastDetected = detected.length > 0 ? detected[detected.length - 1] : null;
  const thirtyDaysAgo = isoDay(new Date(Date.parse(today) - 30 * 86400000));
  return {
    total: changes.length,
    last_recorded_date: last,
    days_since_last_recorded: last === null ? null : Math.max(0, daysBetween(last, today)),
    last_detected_date: lastDetected,
    days_since_last_detected:
      lastDetected === null ? null : Math.max(0, daysBetween(lastDetected, today)),
    recorded_last_30_days: recorded.filter((d) => d >= thirtyDaysAgo).length,
    machine_detected_total: changes.filter((c) => c.detected_by).length,
    entries_without_recorded_date: changes.length - recorded.length,
    discovered_date_total: changes.filter((c) => !isEventDated(c)).length,
    entries_without_date_source: changes.filter((c) => !DATE_SOURCES.includes(c.date_source)).length,
  };
}

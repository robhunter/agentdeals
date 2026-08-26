import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RollupDaySource, DurableRollupCoverage } from "./stats.js";

export const ROLLUP_SCHEMA_VERSION = 1;
export const ROLLUP_DIR = "data/analytics";
export const ROLLUP_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const ROLLUP_EXCLUSIONS: readonly string[] = [
  "per-vendor counts: a durable per-vendor series is a placement metric a vendor could acquire by firing an endpoint at itself, and this artifact is public",
  "caller-supplied vendor names and event strings: counted here, never transcribed, because a rolling window and a permanent public file are different publications",
  "reported free-text notes",
  "request paths that resolved to no page",
  "anything identifying an individual caller",
];

export interface RollupSignals {
  total: number;
  by_event: Record<string, number>;
  by_transport: Record<string, number>;
  by_client_class: Record<string, number>;
  by_source: Record<string, number>;
  by_reporting_agent: Record<string, number>;
  unresolved_vendor_name_count: number;
  unrecognized_event_count: number;
  vendor_key_count: number;
}

export interface RollupPageViews {
  served: number;
  not_found: number;
  redirects: number;
  unclassified_legacy: number;
  by_route: Record<string, number>;
}

export interface RollupTraffic {
  by_class: Record<string, number>;
  by_class_route: Record<string, number>;
  ai_agent_families: Record<string, number>;
  not_found_by_class: Record<string, number>;
  redirects_by_class: Record<string, number>;
}

export interface DailyRollup {
  schema: number;
  date: string;
  generated_at: string;
  complete: boolean;
  page_views: RollupPageViews;
  traffic: RollupTraffic;
  mcp_tool_calls: number;
  referrers: Record<string, number>;
  signals: RollupSignals;
  vendors: Record<string, number> | null;
  excluded: readonly string[];
}

function sortedNumericMap(entries: [string, number][]): Record<string, number> {
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function summarizeSignals(signals: RollupDaySource["signals"]): RollupSignals {
  return {
    total: signals.total,
    by_event: sortedNumericMap(Object.entries(signals.by_event)),
    by_transport: sortedNumericMap(Object.entries(signals.by_transport)),
    by_client_class: sortedNumericMap(Object.entries(signals.by_client_class)),
    by_source: sortedNumericMap(Object.entries(signals.by_source)),
    by_reporting_agent: sortedNumericMap(Object.entries(signals.by_reporting_agent)),
    unresolved_vendor_name_count: Object.keys(signals.unresolved_vendor_names).length,
    unrecognized_event_count: Object.keys(signals.unrecognized_events).length,
    vendor_key_count: Object.keys(signals.by_vendor).length,
  };
}

export function buildDailyRollup(source: RollupDaySource, generatedAt: string): DailyRollup {
  return {
    schema: ROLLUP_SCHEMA_VERSION,
    date: source.date,
    generated_at: generatedAt,
    complete: source.date < generatedAt.slice(0, 10),
    page_views: {
      served: source.page_views.served,
      not_found: source.page_views.not_found,
      redirects: source.page_views.redirects,
      unclassified_legacy: source.page_views.unclassified_legacy,
      by_route: sortedNumericMap(Object.entries(source.page_views.by_route)),
    },
    traffic: {
      by_class: sortedNumericMap(Object.entries(source.classes)),
      by_class_route: sortedNumericMap(Object.entries(source.class_routes)),
      ai_agent_families: sortedNumericMap(Object.entries(source.families)),
      not_found_by_class: sortedNumericMap(Object.entries(source.not_found)),
      redirects_by_class: sortedNumericMap(Object.entries(source.redirects)),
    },
    mcp_tool_calls: source.mcp_tool_calls,
    referrers: sortedNumericMap(Object.entries(source.referrers)),
    signals: summarizeSignals(source.signals),
    vendors: null,
    excluded: ROLLUP_EXCLUSIONS,
  };
}

function numericMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function numberAt(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseRollup(raw: unknown): DailyRollup | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const date = obj.date;
  if (typeof date !== "string" || !ROLLUP_DATE_PATTERN.test(date)) return null;
  const pageViews = (obj.page_views ?? {}) as Record<string, unknown>;
  const traffic = (obj.traffic ?? {}) as Record<string, unknown>;
  const signals = (obj.signals ?? {}) as Record<string, unknown>;
  return {
    schema: numberAt(obj, "schema") || ROLLUP_SCHEMA_VERSION,
    date,
    generated_at: typeof obj.generated_at === "string" ? obj.generated_at : "",
    complete: obj.complete === true,
    page_views: {
      served: numberAt(pageViews, "served"),
      not_found: numberAt(pageViews, "not_found"),
      redirects: numberAt(pageViews, "redirects"),
      unclassified_legacy: numberAt(pageViews, "unclassified_legacy"),
      by_route: numericMap(pageViews.by_route),
    },
    traffic: {
      by_class: numericMap(traffic.by_class),
      by_class_route: numericMap(traffic.by_class_route),
      ai_agent_families: numericMap(traffic.ai_agent_families),
      not_found_by_class: numericMap(traffic.not_found_by_class),
      redirects_by_class: numericMap(traffic.redirects_by_class),
    },
    mcp_tool_calls: numberAt(obj, "mcp_tool_calls"),
    referrers: numericMap(obj.referrers),
    signals: {
      total: numberAt(signals, "total"),
      by_event: numericMap(signals.by_event),
      by_transport: numericMap(signals.by_transport),
      by_client_class: numericMap(signals.by_client_class),
      by_source: numericMap(signals.by_source),
      by_reporting_agent: numericMap(signals.by_reporting_agent),
      unresolved_vendor_name_count: numberAt(signals, "unresolved_vendor_name_count"),
      unrecognized_event_count: numberAt(signals, "unrecognized_event_count"),
      vendor_key_count: numberAt(signals, "vendor_key_count"),
    },
    vendors: obj.vendors && typeof obj.vendors === "object" ? numericMap(obj.vendors) : null,
    excluded: Array.isArray(obj.excluded) ? obj.excluded.filter(e => typeof e === "string") : [],
  };
}

export function rollupFileName(date: string): string {
  return `${date}.json`;
}

export function readRollups(dir: string): DailyRollup[] {
  if (!existsSync(dir)) return [];
  const out: DailyRollup[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    if (!ROLLUP_DATE_PATTERN.test(name.slice(0, -5))) continue;
    try {
      const parsed = parseRollup(JSON.parse(readFileSync(join(dir, name), "utf-8")));
      if (parsed) out.push(parsed);
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function coverageOf(rollups: DailyRollup[], dir: string): DurableRollupCoverage {
  const dates = rollups.map(r => r.date).sort();
  const complete = rollups.filter(r => r.complete).map(r => r.date).sort();
  return {
    first_date: dates[0] ?? null,
    last_date: dates[dates.length - 1] ?? null,
    last_complete_date: complete[complete.length - 1] ?? null,
    days: dates.length,
    path: dir,
  };
}

export function readRollupCoverage(dir: string = ROLLUP_DIR): DurableRollupCoverage {
  return coverageOf(readRollups(dir), dir);
}

export function writeRollup(dir: string, rollup: DailyRollup): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, rollupFileName(rollup.date));
  writeFileSync(path, JSON.stringify(rollup, null, 2) + "\n", "utf-8");
  return path;
}

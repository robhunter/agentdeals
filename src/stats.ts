// In-memory telemetry counters with persistent storage.
// Cumulative stats survive deploys via Upstash Redis (preferred) or data/telemetry.json (fallback).
// Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN env vars to enable Redis persistence.
// No PII collected — only aggregate counts and tool-level metrics.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const startedAt = Date.now();
const serverStartedISO = new Date(startedAt).toISOString();

const toolCalls: Record<string, number> = {
  search_deals: 0,
  plan_stack: 0,
  compare_vendors: 0,
  track_changes: 0,
};

const apiHits: Record<string, number> = {
  "/api/offers": 0,
  "/api/categories": 0,
  "/api/stack": 0,
  "/api/metrics": 0,
};

let totalSessions = 0;
let totalDisconnects = 0;
let landingPageViews = 0;
let sessionsToday = 0;
let sessionsTodayDate = new Date().toISOString().slice(0, 10);

// Cumulative stats loaded from external storage
let cumulative = {
  sessions: 0,
  tool_calls: 0,
  api_hits: 0,
  landing_views: 0,
  first_session_at: "",
  last_deploy_at: "",
  clients: {} as Record<string, number>,
  referral_listing_calls: 0,
  referral_listing_by_source: { platform: 0, agent: 0, null: 0 } as Record<"platform" | "agent" | "null", number>,
  referral_vendor_lookups: 0,
  referral_vendor_counts: {} as Record<string, number>,
};

// Current-deployment referral marketplace counters
let referralListingCalls = 0;
const referralListingBySource: Record<"platform" | "agent" | "null", number> = {
  platform: 0,
  agent: 0,
  null: 0,
};
let referralVendorLookups = 0;
const referralVendorCounts: Record<string, number> = {};

let telemetryPath = "";

// Upstash Redis REST API support (zero dependencies)
const REDIS_KEY = "agentdeals:telemetry";

export function useRedis(): boolean {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

interface TelemetryData {
  cumulative_sessions: number;
  cumulative_tool_calls: number;
  cumulative_api_hits: number;
  cumulative_landing_views: number;
  first_session_at: string;
  last_deploy_at: string;
  cumulative_clients?: Record<string, number>;
  cumulative_referral_listing_calls?: number;
  cumulative_referral_listing_by_source?: Record<"platform" | "agent" | "null", number>;
  cumulative_referral_vendor_lookups?: number;
  cumulative_referral_vendor_counts?: Record<string, number>;
}

async function redisGet(): Promise<TelemetryData | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL!;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["GET", REDIS_KEY]),
    });
    const json = (await res.json()) as { result?: string | null };
    if (json.result) {
      return JSON.parse(json.result) as TelemetryData;
    }
    return null;
  } catch {
    return null;
  }
}

async function redisSet(data: TelemetryData): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL!;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["SET", REDIS_KEY, JSON.stringify(data)]),
    });
    const json = (await res.json()) as { result?: string };
    return json.result === "OK";
  } catch {
    return false;
  }
}

// Request-level logging to Upstash Redis
const REQUEST_LOG_KEY = "agentdeals:request_log";
const REQUEST_LOG_MAX = 1000;

export interface RequestLogEntry {
  ts: string;
  type: "mcp" | "api" | "session_connect";
  endpoint: string;
  params: Record<string, unknown>;
  user_agent?: string;
  result_count: number;
  session_id?: string;
  client_info?: { name: string; version: string };
}

async function redisLpush(key: string, value: string): Promise<boolean> {
  if (!useRedis()) return false;
  const url = process.env.UPSTASH_REDIS_REST_URL!;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(["LPUSH", key, value]),
    });
    const json = (await res.json()) as { result?: number };
    return typeof json.result === "number";
  } catch {
    return false;
  }
}

async function redisLtrim(key: string, start: number, stop: number): Promise<boolean> {
  if (!useRedis()) return false;
  const url = process.env.UPSTASH_REDIS_REST_URL!;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!;
  try {
    await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(["LTRIM", key, start, stop]),
    });
    return true;
  } catch {
    return false;
  }
}

async function redisLrange(key: string, start: number, stop: number): Promise<string[]> {
  if (!useRedis()) return [];
  const url = process.env.UPSTASH_REDIS_REST_URL!;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(["LRANGE", key, start, stop]),
    });
    const json = (await res.json()) as { result?: string[] };
    return json.result ?? [];
  } catch {
    return [];
  }
}

export async function logRequest(entry: RequestLogEntry): Promise<void> {
  const pushed = await redisLpush(REQUEST_LOG_KEY, JSON.stringify(entry));
  if (pushed) {
    // Cap list at REQUEST_LOG_MAX entries
    await redisLtrim(REQUEST_LOG_KEY, 0, REQUEST_LOG_MAX - 1);
  }
}

export async function getRequestLog(limit = 50): Promise<RequestLogEntry[]> {
  const raw = await redisLrange(REQUEST_LOG_KEY, 0, limit - 1);
  return raw.map((s) => {
    try { return JSON.parse(s) as RequestLogEntry; }
    catch { return null; }
  }).filter((e): e is RequestLogEntry => e !== null);
}

function parseTelemetryData(data: Record<string, unknown>): void {
  cumulative.sessions = (data.cumulative_sessions as number) ?? 0;
  cumulative.tool_calls = (data.cumulative_tool_calls as number) ?? 0;
  cumulative.api_hits = (data.cumulative_api_hits as number) ?? 0;
  cumulative.landing_views = (data.cumulative_landing_views as number) ?? 0;
  cumulative.first_session_at = (data.first_session_at as string) ?? "";
  cumulative.last_deploy_at = (data.last_deploy_at as string) ?? "";
  cumulative.clients = (data.cumulative_clients as Record<string, number>) ?? {};
  cumulative.referral_listing_calls = (data.cumulative_referral_listing_calls as number) ?? 0;
  const listingBySource = (data.cumulative_referral_listing_by_source as Record<string, number>) ?? {};
  cumulative.referral_listing_by_source = {
    platform: listingBySource.platform ?? 0,
    agent: listingBySource.agent ?? 0,
    null: listingBySource.null ?? 0,
  };
  cumulative.referral_vendor_lookups = (data.cumulative_referral_vendor_lookups as number) ?? 0;
  cumulative.referral_vendor_counts = (data.cumulative_referral_vendor_counts as Record<string, number>) ?? {};
}

// In-memory client counts for this deployment
const sessionClients: Record<string, number> = {};

function buildTelemetryData(): TelemetryData {
  const totalToolCalls = Object.values(toolCalls).reduce((a, b) => a + b, 0);
  const totalApiHits = Object.values(apiHits).reduce((a, b) => a + b, 0);
  // Merge cumulative + current deployment client counts
  const mergedClients: Record<string, number> = { ...cumulative.clients };
  for (const [name, count] of Object.entries(sessionClients)) {
    mergedClients[name] = (mergedClients[name] ?? 0) + count;
  }
  // Merge referral vendor counts (cumulative + current deployment)
  const mergedVendorCounts: Record<string, number> = { ...cumulative.referral_vendor_counts };
  for (const [vendor, count] of Object.entries(referralVendorCounts)) {
    mergedVendorCounts[vendor] = (mergedVendorCounts[vendor] ?? 0) + count;
  }
  return {
    cumulative_sessions: cumulative.sessions + totalSessions,
    cumulative_tool_calls: cumulative.tool_calls + totalToolCalls,
    cumulative_api_hits: cumulative.api_hits + totalApiHits,
    cumulative_landing_views: cumulative.landing_views + landingPageViews,
    first_session_at: cumulative.first_session_at || (totalSessions > 0 ? serverStartedISO : ""),
    last_deploy_at: cumulative.last_deploy_at,
    cumulative_clients: mergedClients,
    cumulative_referral_listing_calls: cumulative.referral_listing_calls + referralListingCalls,
    cumulative_referral_listing_by_source: {
      platform: cumulative.referral_listing_by_source.platform + referralListingBySource.platform,
      agent: cumulative.referral_listing_by_source.agent + referralListingBySource.agent,
      null: cumulative.referral_listing_by_source.null + referralListingBySource.null,
    },
    cumulative_referral_vendor_lookups: cumulative.referral_vendor_lookups + referralVendorLookups,
    cumulative_referral_vendor_counts: mergedVendorCounts,
  };
}

export async function loadTelemetry(filePath: string): Promise<void> {
  telemetryPath = filePath;

  // Try Redis first if configured
  if (useRedis()) {
    const data = await redisGet();
    if (data) {
      parseTelemetryData(data as unknown as Record<string, unknown>);
      cumulative.last_deploy_at = serverStartedISO;
      return;
    }
  }

  // Fall back to file
  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    parseTelemetryData(data);
  } catch {
    // No file yet or corrupt — start fresh
  }
  cumulative.last_deploy_at = serverStartedISO;
}

export async function flushTelemetry(): Promise<void> {
  if (!telemetryPath) return;
  const data = buildTelemetryData();

  // Write to Redis if configured
  if (useRedis()) {
    await redisSet(data);
  }

  // Always write to file as backup
  try {
    mkdirSync(dirname(telemetryPath), { recursive: true });
    writeFileSync(telemetryPath, JSON.stringify(data, null, 2) + "\n");
  } catch {
    // Best effort — don't crash the server
  }
}

export function resetCounters(): void {
  totalSessions = 0;
  totalDisconnects = 0;
  landingPageViews = 0;
  sessionsToday = 0;
  for (const key of Object.keys(toolCalls)) toolCalls[key] = 0;
  for (const key of Object.keys(apiHits)) apiHits[key] = 0;
  for (const key of Object.keys(sessionClients)) delete sessionClients[key];
  cumulative.sessions = 0;
  cumulative.tool_calls = 0;
  cumulative.api_hits = 0;
  cumulative.landing_views = 0;
  cumulative.first_session_at = "";
  cumulative.last_deploy_at = "";
  cumulative.clients = {};
  referralListingCalls = 0;
  referralListingBySource.platform = 0;
  referralListingBySource.agent = 0;
  referralListingBySource.null = 0;
  referralVendorLookups = 0;
  for (const key of Object.keys(referralVendorCounts)) delete referralVendorCounts[key];
  cumulative.referral_listing_calls = 0;
  cumulative.referral_listing_by_source = { platform: 0, agent: 0, null: 0 };
  cumulative.referral_vendor_lookups = 0;
  cumulative.referral_vendor_counts = {};
  searchQueryLog.length = 0;
}

export function recordToolCall(tool: string): void {
  if (tool in toolCalls) {
    toolCalls[tool]++;
  }
}

export function recordApiHit(endpoint: string): void {
  if (endpoint in apiHits) {
    apiHits[endpoint]++;
  }
}

export function recordSessionConnect(clientName?: string): void {
  totalSessions++;
  if (!cumulative.first_session_at) {
    cumulative.first_session_at = new Date().toISOString();
  }
  const today = new Date().toISOString().slice(0, 10);
  if (today !== sessionsTodayDate) {
    sessionsToday = 0;
    sessionsTodayDate = today;
  }
  sessionsToday++;
  const name = clientName || "unknown";
  sessionClients[name] = (sessionClients[name] ?? 0) + 1;
}

export function recordSessionDisconnect(): void {
  totalDisconnects++;
}

export function recordLandingPageView(): void {
  landingPageViews++;
}

export function recordReferralListingCall(source: "platform" | "agent" | null): void {
  referralListingCalls++;
  const key = source ?? "null";
  referralListingBySource[key]++;
}

export function recordReferralVendorLookup(vendor: string): void {
  if (!vendor) return;
  referralVendorLookups++;
  const key = vendor.trim().toLowerCase();
  referralVendorCounts[key] = (referralVendorCounts[key] ?? 0) + 1;
}

// Classify MCP client names as 'agent' (real user-facing agent) or 'crawler'
// (registry/scanner/health-probe). Case-insensitive substring match on the patterns below.
// Conservative: unknown or unmatched names default to 'agent' — we'd rather over-count
// agents than under-count them. Keep the rule list here so we can tune it in one place.
export const CRAWLER_CLIENT_PATTERNS = [
  "crawler",
  "probe",
  "scanner",
  "validator",
  "inspector",
  "scoring",
  "enricher",
  "registry",
  "health",
  "monitor",
  "survey",
  "corpus",
  "tester",
  "dataset",
  "sentinel",
  "pm-audit",
  "pm-check",
  "glama",
  "mcpdd",
  "yellowmcp",
  "mcpscoringengine",
  "fabrique-noauth-probe",
] as const;

export function classifyMcpClient(name: string): "agent" | "crawler" {
  const lower = (name || "").toLowerCase();
  for (const pattern of CRAWLER_CLIENT_PATTERNS) {
    if (lower.includes(pattern)) return "crawler";
  }
  return "agent";
}

export function getSessionClassification(): {
  sessions_by_type: { agent: number; crawler: number; total: number };
  clients_top: { name: string; sessions: number; type: "agent" | "crawler" }[];
} {
  const mergedClients: Record<string, number> = { ...cumulative.clients };
  for (const [name, count] of Object.entries(sessionClients)) {
    mergedClients[name] = (mergedClients[name] ?? 0) + count;
  }
  let agentSessions = 0;
  let crawlerSessions = 0;
  for (const [name, count] of Object.entries(mergedClients)) {
    if (classifyMcpClient(name) === "crawler") crawlerSessions += count;
    else agentSessions += count;
  }
  const clientsTop = Object.entries(mergedClients)
    .map(([name, sessions]) => ({ name, sessions, type: classifyMcpClient(name) }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 10);
  return {
    sessions_by_type: {
      agent: agentSessions,
      crawler: crawlerSessions,
      total: agentSessions + crawlerSessions,
    },
    clients_top: clientsTop,
  };
}

export function getReferralMarketplaceStats(): {
  total_listing_calls: number;
  total_vendor_lookups: number;
  listing_calls_by_source: { platform: number; agent: number; null: number };
  vendor_lookups_top: { vendor: string; count: number }[];
} {
  const mergedVendorCounts: Record<string, number> = { ...cumulative.referral_vendor_counts };
  for (const [vendor, count] of Object.entries(referralVendorCounts)) {
    mergedVendorCounts[vendor] = (mergedVendorCounts[vendor] ?? 0) + count;
  }
  const vendorLookupsTop = Object.entries(mergedVendorCounts)
    .map(([vendor, count]) => ({ vendor, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  return {
    total_listing_calls: cumulative.referral_listing_calls + referralListingCalls,
    total_vendor_lookups: cumulative.referral_vendor_lookups + referralVendorLookups,
    listing_calls_by_source: {
      platform: cumulative.referral_listing_by_source.platform + referralListingBySource.platform,
      agent: cumulative.referral_listing_by_source.agent + referralListingBySource.agent,
      null: cumulative.referral_listing_by_source.null + referralListingBySource.null,
    },
    vendor_lookups_top: vendorLookupsTop,
  };
}

export function getStats(): {
  uptime_seconds: number;
  total_tool_calls: number;
  tool_calls: Record<string, number>;
  total_api_hits: number;
  api_hits: Record<string, number>;
  total_sessions: number;
  total_disconnects: number;
  landing_page_views: number;
  cumulative_sessions: number;
  cumulative_tool_calls: number;
  cumulative_api_hits: number;
  cumulative_landing_views: number;
  page_views_today: number;
  first_session_at: string;
  last_deploy_at: string;
} {
  const totalToolCalls = Object.values(toolCalls).reduce((a, b) => a + b, 0);
  const totalApiHits = Object.values(apiHits).reduce((a, b) => a + b, 0);
  return {
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    total_tool_calls: totalToolCalls,
    tool_calls: { ...toolCalls },
    total_api_hits: totalApiHits,
    api_hits: { ...apiHits },
    total_sessions: totalSessions,
    total_disconnects: totalDisconnects,
    landing_page_views: landingPageViews,
    cumulative_sessions: cumulative.sessions + totalSessions,
    cumulative_tool_calls: cumulative.tool_calls + totalToolCalls,
    cumulative_api_hits: cumulative.api_hits + totalApiHits,
    cumulative_landing_views: cumulative.landing_views + landingPageViews,
    page_views_today: getPageViewsToday(),
    first_session_at: cumulative.first_session_at,
    last_deploy_at: cumulative.last_deploy_at,
  };
}

export function getConnectionStats(activeSessions: number): {
  activeSessions: number;
  totalSessionsAllTime: number;
  totalApiHitsAllTime: number;
  totalToolCallsAllTime: number;
  sessionsToday: number;
  serverStarted: string;
  clients: Record<string, number>;
} {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== sessionsTodayDate) {
    sessionsToday = 0;
    sessionsTodayDate = today;
  }
  const totalToolCalls = Object.values(toolCalls).reduce((a, b) => a + b, 0);
  const totalApiHits = Object.values(apiHits).reduce((a, b) => a + b, 0);
  // Merge cumulative + current deployment client counts
  const mergedClients: Record<string, number> = { ...cumulative.clients };
  for (const [name, count] of Object.entries(sessionClients)) {
    mergedClients[name] = (mergedClients[name] ?? 0) + count;
  }
  return {
    activeSessions,
    totalSessionsAllTime: cumulative.sessions + totalSessions,
    totalApiHitsAllTime: cumulative.api_hits + totalApiHits,
    totalToolCallsAllTime: cumulative.tool_calls + totalToolCalls,
    sessionsToday,
    serverStarted: serverStartedISO,
    clients: mergedClients,
  };
}

// --- Page view tracking ---

const BOT_PATTERNS = /bot|crawler|spider|googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|semrushbot|ahrefsbot|mj12bot|dotbot|petalbot|bytespider|gptbot|claudebot|facebookexternalhit|twitterbot|linkedinbot|applebot|ia_archiver|archive\.org/i;

function isBot(userAgent: string): boolean {
  return BOT_PATTERNS.test(userAgent);
}

// In-memory page view counters (flushed to Redis)
let pageViewsToday = 0;
let pageViewsTodayDate = new Date().toISOString().slice(0, 10);

async function redisIncr(key: string): Promise<boolean> {
  if (!useRedis()) return false;
  const url = process.env.UPSTASH_REDIS_REST_URL!;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(["INCR", key]),
    });
    const json = (await res.json()) as { result?: number };
    return typeof json.result === "number";
  } catch {
    return false;
  }
}

async function redisMget(...keys: string[]): Promise<(string | null)[]> {
  if (!useRedis()) return keys.map(() => null);
  const url = process.env.UPSTASH_REDIS_REST_URL!;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(["MGET", ...keys]),
    });
    const json = (await res.json()) as { result?: (string | null)[] };
    return json.result ?? keys.map(() => null);
  } catch {
    return keys.map(() => null);
  }
}

async function redisScan(pattern: string, count = 100): Promise<string[]> {
  if (!useRedis()) return [];
  const url = process.env.UPSTASH_REDIS_REST_URL!;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!;
  const keys: string[] = [];
  let cursor = "0";
  try {
    do {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(["SCAN", cursor, "MATCH", pattern, "COUNT", String(count)]),
      });
      const json = (await res.json()) as { result?: [string, string[]] };
      if (!json.result) break;
      cursor = json.result[0];
      keys.push(...json.result[1]);
    } while (cursor !== "0" && keys.length < 500);
    return keys;
  } catch {
    return [];
  }
}

async function redisGetMulti(keys: string[]): Promise<Map<string, number>> {
  if (keys.length === 0) return new Map();
  const values = await redisMget(...keys);
  const result = new Map<string, number>();
  for (let i = 0; i < keys.length; i++) {
    const v = values[i];
    if (v !== null) result.set(keys[i], parseInt(v, 10) || 0);
  }
  return result;
}

export function recordPageView(path: string, userAgent: string, referer?: string): void {
  if (isBot(userAgent)) return;

  const today = new Date().toISOString().slice(0, 10);
  if (today !== pageViewsTodayDate) {
    pageViewsToday = 0;
    pageViewsTodayDate = today;
  }
  pageViewsToday++;

  if (!useRedis()) return;

  // Fire-and-forget — don't await
  const dailyPath = `pv:${today}:${path}`;
  const dailyTotal = `pv:${today}:total`;
  const allTimePath = `pv:all:${path}`;
  redisIncr(dailyPath).catch(() => {});
  redisIncr(dailyTotal).catch(() => {});
  redisIncr(allTimePath).catch(() => {});

  // Track referrer domain
  if (referer) {
    try {
      const refUrl = new URL(referer);
      const domain = refUrl.hostname.replace(/^www\./, "");
      redisIncr(`ref:${today}:${domain}`).catch(() => {});
    } catch {
      // Invalid referrer URL — skip
    }
  }
}

export async function getPageViews(): Promise<{
  today: { total: number; top_pages: { path: string; views: number }[] };
  yesterday: { total: number; top_pages: { path: string; views: number }[] };
  all_time: { total: number; top_pages: { path: string; views: number }[] };
  referrers_today: Record<string, number>;
}> {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  if (!useRedis()) {
    return {
      today: { total: pageViewsToday, top_pages: [] },
      yesterday: { total: 0, top_pages: [] },
      all_time: { total: pageViewsToday, top_pages: [] },
      referrers_today: {},
    };
  }

  // Get today's pages
  const todayKeys = await redisScan(`pv:${today}:*`);
  const todayPathKeys = todayKeys.filter(k => k !== `pv:${today}:total`);
  const todayTotalKeys = todayKeys.filter(k => k === `pv:${today}:total`);
  const todayValues = await redisGetMulti(todayKeys);
  const todayTotal = todayValues.get(`pv:${today}:total`) ?? 0;
  const todayPages = todayPathKeys
    .map(k => ({ path: k.replace(`pv:${today}:`, ""), views: todayValues.get(k) ?? 0 }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 20);

  // Get yesterday's pages
  const yesterdayKeys = await redisScan(`pv:${yesterday}:*`);
  const yesterdayPathKeys = yesterdayKeys.filter(k => k !== `pv:${yesterday}:total`);
  const yesterdayValues = await redisGetMulti(yesterdayKeys);
  const yesterdayTotal = yesterdayValues.get(`pv:${yesterday}:total`) ?? 0;
  const yesterdayPages = yesterdayPathKeys
    .map(k => ({ path: k.replace(`pv:${yesterday}:`, ""), views: yesterdayValues.get(k) ?? 0 }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 20);

  // Get all-time pages
  const allTimeKeys = await redisScan("pv:all:*");
  const allTimeValues = await redisGetMulti(allTimeKeys);
  let allTimeTotal = 0;
  const allTimePages = allTimeKeys
    .map(k => {
      const views = allTimeValues.get(k) ?? 0;
      allTimeTotal += views;
      return { path: k.replace("pv:all:", ""), views };
    })
    .sort((a, b) => b.views - a.views)
    .slice(0, 20);

  // Get today's referrers
  const refKeys = await redisScan(`ref:${today}:*`);
  const refValues = await redisGetMulti(refKeys);
  const referrers: Record<string, number> = {};
  for (const k of refKeys) {
    const domain = k.replace(`ref:${today}:`, "");
    referrers[domain] = refValues.get(k) ?? 0;
  }

  return {
    today: { total: todayTotal, top_pages: todayPages },
    yesterday: { total: yesterdayTotal, top_pages: yesterdayPages },
    all_time: { total: allTimeTotal, top_pages: allTimePages },
    referrers_today: referrers,
  };
}

export function getPageViewsToday(): number {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== pageViewsTodayDate) {
    pageViewsToday = 0;
    pageViewsTodayDate = today;
  }
  return pageViewsToday;
}

// --- Search query analytics (in-memory, resets on deploy) ---

interface SearchQueryEntry {
  query: string;
  ts: number;
  resultCount: number;
  category?: string;
}

const searchQueryLog: SearchQueryEntry[] = [];

export function recordSearchQuery(query: string | undefined, resultCount: number, category?: string): void {
  if (!query) return;
  const normalized = query.trim().toLowerCase();
  if (!normalized) return;
  searchQueryLog.push({
    query: normalized,
    ts: Date.now(),
    resultCount,
    category,
  });
}

export function getSearchAnalytics(): {
  top_queries_7d: { query: string; count: number }[];
  zero_result_queries_7d: { query: string; count: number }[];
  queries_by_category_7d: Record<string, number>;
} {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = searchQueryLog.filter(e => e.ts >= sevenDaysAgo);

  // Top 20 queries by frequency
  const queryCounts = new Map<string, number>();
  for (const e of recent) {
    queryCounts.set(e.query, (queryCounts.get(e.query) ?? 0) + 1);
  }
  const topQueries = [...queryCounts.entries()]
    .map(([query, count]) => ({ query, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // Top 10 zero-result queries
  const zeroResultCounts = new Map<string, number>();
  for (const e of recent) {
    if (e.resultCount === 0) {
      zeroResultCounts.set(e.query, (zeroResultCounts.get(e.query) ?? 0) + 1);
    }
  }
  const zeroResultQueries = [...zeroResultCounts.entries()]
    .map(([query, count]) => ({ query, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Search volume by category (from results that matched a category)
  const categoryCounts: Record<string, number> = {};
  for (const e of recent) {
    if (e.category) {
      categoryCounts[e.category] = (categoryCounts[e.category] ?? 0) + 1;
    }
  }

  return {
    top_queries_7d: topQueries,
    zero_result_queries_7d: zeroResultQueries,
    queries_by_category_7d: categoryCounts,
  };
}

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const startedAt = Date.now();
const serverStartedISO = new Date(startedAt).toISOString();

const toolCalls: Record<string, number> = {
  search_deals: 0,
  plan_stack: 0,
  compare_vendors: 0,
  track_changes: 0,
  register_agent: 0,
  get_referral_code: 0,
  check_balance: 0,
  request_payout: 0,
};

const toolCallsByClient: Record<string, number> = {};

const toolCallsByName: Record<string, number> = {};

const apiHits: Record<string, number> = {};

let totalSessions = 0;
let totalDisconnects = 0;
let landingPageViews = 0;

let cumulative = {
  sessions: 0,
  tool_calls: 0,
  api_hits: 0,
  landing_views: 0,
  first_session_at: "",
  last_deploy_at: "",
  clients: {} as Record<string, number>,
  tool_calls_by_client: {} as Record<string, number>,
  tool_calls_by_name: {} as Record<string, number>,
  referral_listing_calls: 0,
  referral_listing_by_source: { platform: 0, agent: 0, null: 0 } as Record<"platform" | "agent" | "null", number>,
  referral_vendor_lookups: 0,
  referral_vendor_counts: {} as Record<string, number>,
  api_hits_by_endpoint: {} as Record<string, number>,
};

let referralListingCalls = 0;
const referralListingBySource: Record<"platform" | "agent" | "null", number> = {
  platform: 0,
  agent: 0,
  null: 0,
};
let referralVendorLookups = 0;
const referralVendorCounts: Record<string, number> = {};

let telemetryPath = "";

const REDIS_KEY = "agentdeals:telemetry";

export function useRedis(): boolean {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

export type SearchSource = "web" | "api" | "mcp";

export interface SearchQueryEntry {
  query: string;
  category?: string;
  results_count: number;
  unfiltered_count?: number;
  filtered?: boolean;
  source?: SearchSource;
  timestamp: string;
}

const SEARCH_QUERY_RING_MAX = 1000;
const searchQueryLog: SearchQueryEntry[] = [];

interface TelemetryData {
  cumulative_sessions: number;
  cumulative_tool_calls: number;
  cumulative_api_hits: number;
  cumulative_landing_views: number;
  first_session_at: string;
  last_deploy_at: string;
  cumulative_clients?: Record<string, number>;
  cumulative_tool_calls_by_client?: Record<string, number>;
  cumulative_tool_calls_by_name?: Record<string, number>;
  cumulative_referral_listing_calls?: number;
  cumulative_referral_listing_by_source?: Record<"platform" | "agent" | "null", number>;
  cumulative_referral_vendor_lookups?: number;
  cumulative_referral_vendor_counts?: Record<string, number>;
  cumulative_api_hits_by_endpoint?: Record<string, number>;
  cumulative_search_queries?: SearchQueryEntry[];
}

type RedisResult<T> = { ok: true; result: T } | { ok: false; error: string };

const WRITE_COMMANDS = new Set(["SET", "INCR", "LPUSH", "LTRIM", "EXPIRE", "DEL"]);

const redisHealth = {
  lastWriteAt: null as string | null,
  lastWriteError: null as string | null,
  lastWriteErrorAt: null as string | null,
  lastReadError: null as string | null,
  lastReadErrorAt: null as string | null,
  writeFailures: 0,
  readFailures: 0,
};

const DEFAULT_MONTHLY_COMMAND_BUDGET = 300_000;
const MONTHLY_COMMAND_BUDGET =
  Number(process.env.TELEMETRY_COMMAND_BUDGET) > 0
    ? Number(process.env.TELEMETRY_COMMAND_BUDGET)
    : DEFAULT_MONTHLY_COMMAND_BUDGET;

const RATE_ESTIMATE_FLOOR_SECONDS = 300;

let commandsIssued = 0;

const QUOTA_ERROR_PATTERN = /max (?:requests|daily request|commands?)\s+limit exceeded|quota/i;

function isQuotaError(error: string | null): boolean {
  return typeof error === "string" && QUOTA_ERROR_PATTERN.test(error);
}

const lastLoggedAt: Record<string, number> = {};
function logRedisFailure(command: string, error: string): void {
  const now = Date.now();
  if (now - (lastLoggedAt[command] ?? 0) < 60_000) return;
  lastLoggedAt[command] = now;
  console.error(`[telemetry] redis ${command} failed: ${error}`);
}

function recordRedisFailure(command: string, isWrite: boolean, error: string): void {
  const at = new Date().toISOString();
  if (isWrite) {
    redisHealth.writeFailures++;
    redisHealth.lastWriteError = error;
    redisHealth.lastWriteErrorAt = at;
  } else {
    redisHealth.readFailures++;
    redisHealth.lastReadError = error;
    redisHealth.lastReadErrorAt = at;
  }
  logRedisFailure(command, error);
}

async function redisCommand<T>(cmd: (string | number)[]): Promise<RedisResult<T>> {
  if (!useRedis()) return { ok: false, error: "redis-not-configured" };
  const command = String(cmd[0]).toUpperCase();
  const isWrite = WRITE_COMMANDS.has(command);
  commandsIssued++;
  const url = process.env.UPSTASH_REDIS_REST_URL!;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    });
    const json = (await res.json().catch(() => ({}))) as { result?: T; error?: string };
    if (!res.ok || typeof json.error === "string") {
      const error = json.error ?? `HTTP ${res.status}`;
      recordRedisFailure(command, isWrite, error);
      return { ok: false, error };
    }
    if (isWrite) redisHealth.lastWriteAt = new Date().toISOString();
    return { ok: true, result: json.result as T };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    recordRedisFailure(command, isWrite, error);
    return { ok: false, error };
  }
}

export interface TelemetryHealth {
  configured: boolean;
  last_write_at: string | null;
  last_write_error: string | null;
  last_write_error_at: string | null;
  last_read_error: string | null;
  last_read_error_at: string | null;
  write_failures: number;
  read_failures: number;
  quota_exhausted: boolean;
  commands_since_boot: number;
  uptime_seconds: number;
  estimated_commands_per_day: number;
  estimated_commands_per_month: number;
  monthly_command_budget: number;
  over_budget: boolean;
  pending_page_view_keys: number;
  pending_request_log_entries: number;
  request_log_dropped: number;
  last_flush_at: string | null;
  flush_interval_seconds: number;
}

export function getTelemetryHealth(): TelemetryHealth {
  const uptimeSeconds = Math.round((Date.now() - startedAt) / 1000);
  const perDay = Math.round(
    (commandsIssued / Math.max(uptimeSeconds, RATE_ESTIMATE_FLOOR_SECONDS)) * 86_400,
  );
  const perMonth = perDay * 30;
  return {
    configured: useRedis(),
    last_write_at: redisHealth.lastWriteAt,
    last_write_error: redisHealth.lastWriteError,
    last_write_error_at: redisHealth.lastWriteErrorAt,
    last_read_error: redisHealth.lastReadError,
    last_read_error_at: redisHealth.lastReadErrorAt,
    write_failures: redisHealth.writeFailures,
    read_failures: redisHealth.readFailures,
    quota_exhausted: isQuotaError(redisHealth.lastWriteError) || isQuotaError(redisHealth.lastReadError),
    commands_since_boot: commandsIssued,
    uptime_seconds: uptimeSeconds,
    estimated_commands_per_day: perDay,
    estimated_commands_per_month: perMonth,
    monthly_command_budget: MONTHLY_COMMAND_BUDGET,
    over_budget: perMonth > MONTHLY_COMMAND_BUDGET,
    pending_page_view_keys: countPendingPageViewKeys(),
    pending_request_log_entries: requestLogPending.length,
    request_log_dropped: requestLogDropped,
    last_flush_at: lastFlushAt,
    flush_interval_seconds: FLUSH_INTERVAL_SECONDS,
  };
}

export function resetTelemetryHealth(): void {
  redisHealth.lastWriteAt = null;
  redisHealth.lastWriteError = null;
  redisHealth.lastWriteErrorAt = null;
  redisHealth.lastReadError = null;
  redisHealth.lastReadErrorAt = null;
  redisHealth.writeFailures = 0;
  redisHealth.readFailures = 0;
  commandsIssued = 0;
  for (const k of Object.keys(lastLoggedAt)) delete lastLoggedAt[k];
}

async function redisSet(data: TelemetryData): Promise<boolean> {
  const res = await redisCommand<string>(["SET", REDIS_KEY, JSON.stringify(data)]);
  return res.ok && res.result === "OK";
}

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

const REQUEST_LOG_FLUSH_MAX = 250;

const REQUEST_LOG_TRIM_THRESHOLD = Math.floor(REQUEST_LOG_MAX * 1.2);

let requestLogMirror: RequestLogEntry[] = [];
let requestLogPending: RequestLogEntry[] = [];
let requestLogDropped = 0;
let requestLogHydrated = false;

async function redisLrange(key: string, start: number, stop: number): Promise<RedisResult<string[]>> {
  const res = await redisCommand<string[]>(["LRANGE", key, start, stop]);
  if (!res.ok) return res;
  if (res.result === null || res.result === undefined) return { ok: true, result: [] };
  if (!Array.isArray(res.result)) {
    const error = `LRANGE returned ${typeof res.result}, expected a list`;
    recordRedisFailure("LRANGE", false, error);
    return { ok: false, error };
  }
  return { ok: true, result: res.result };
}

export function logRequest(entry: RequestLogEntry): void {
  requestLogMirror.unshift(entry);
  if (requestLogMirror.length > REQUEST_LOG_MAX) requestLogMirror.length = REQUEST_LOG_MAX;

  if (!useRedis()) return;
  requestLogPending.push(entry);
  if (requestLogPending.length > REQUEST_LOG_FLUSH_MAX) {
    const overflow = requestLogPending.length - REQUEST_LOG_FLUSH_MAX;
    requestLogDropped += overflow;
    requestLogPending.splice(0, overflow);
  }
}

function parseLogEntry(raw: string): RequestLogEntry | null {
  try { return JSON.parse(raw) as RequestLogEntry; }
  catch { return null; }
}

async function loadRequestLog(): Promise<void> {
  if (!useRedis()) return;
  const res = await redisLrange(REQUEST_LOG_KEY, 0, REQUEST_LOG_MAX - 1);
  if (!res.ok) return;
  const stored = res.result
    .map(parseLogEntry)
    .filter((e): e is RequestLogEntry => e !== null);
  requestLogMirror = [...requestLogMirror, ...stored].slice(0, REQUEST_LOG_MAX);
  requestLogHydrated = true;
}

async function flushRequestLog(): Promise<void> {
  if (!useRedis() || requestLogPending.length === 0) return;
  const batch = requestLogPending;
  requestLogPending = [];

  const push = await redisCommand<number>([
    "LPUSH",
    REQUEST_LOG_KEY,
    ...batch.map((e) => JSON.stringify(e)),
  ]);
  if (!push.ok) {
    requestLogPending = [...batch, ...requestLogPending].slice(-REQUEST_LOG_FLUSH_MAX);
    return;
  }
  if (typeof push.result === "number" && push.result > REQUEST_LOG_TRIM_THRESHOLD) {
    await redisCommand<string>(["LTRIM", REQUEST_LOG_KEY, 0, REQUEST_LOG_MAX - 1]);
  }
}

export async function getRequestLogResult(limit = 50): Promise<{
  entries: RequestLogEntry[];
  available: boolean;
  error: string | null;
}> {
  if (!useRedis()) return { entries: [], available: false, error: "redis-not-configured" };
  if (!requestLogHydrated) {
    return {
      entries: [],
      available: false,
      error: redisHealth.lastReadError ?? "request log not loaded",
    };
  }
  return { entries: requestLogMirror.slice(0, limit), available: true, error: null };
}

export async function getRequestLog(limit = 50): Promise<RequestLogEntry[]> {
  return (await getRequestLogResult(limit)).entries;
}

export const PUBLISHED_TEXT_MAX = 200;

export interface PublicRequestLogEntry {
  ts: string;
  type: RequestLogEntry["type"];
  endpoint: string;
  param_lengths: Record<string, number>;
  user_agent?: string;
  result_count: number;
  session_index?: number;
  client_info?: { name: string; version: string };
}

function publishedLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function lengthsByParamName(params: Record<string, unknown> | undefined): Record<string, number> {
  const lengths: Record<string, number> = {};
  if (!params) return lengths;
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue;
    lengths[name] = publishedLength(value);
  }
  return lengths;
}

function boundedText(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let printable = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    printable += code < 0x20 || code === 0x7f ? " " : ch;
  }
  const bounded = printable.replace(/\s+/g, " ").trim().slice(0, PUBLISHED_TEXT_MAX);
  return bounded || undefined;
}

export function toPublicRequestLog(entries: RequestLogEntry[]): PublicRequestLogEntry[] {
  const indexBySession = new Map<string, number>();
  return entries.map(entry => {
    const published: PublicRequestLogEntry = {
      ts: entry.ts,
      type: entry.type,
      endpoint: entry.endpoint,
      param_lengths: lengthsByParamName(entry.params),
      result_count: entry.result_count,
    };
    const userAgent = boundedText(entry.user_agent);
    if (userAgent) published.user_agent = userAgent;
    if (entry.client_info) {
      published.client_info = {
        name: boundedText(entry.client_info.name) ?? "unknown",
        version: boundedText(entry.client_info.version) ?? "unknown",
      };
    }
    if (entry.session_id) {
      let index = indexBySession.get(entry.session_id);
      if (index === undefined) {
        index = indexBySession.size + 1;
        indexBySession.set(entry.session_id, index);
      }
      published.session_index = index;
    }
    return published;
  });
}

export async function getPublicRequestLogResult(limit = 50): Promise<{
  entries: PublicRequestLogEntry[];
  available: boolean;
  error: string | null;
}> {
  const stored = await getRequestLogResult(limit);
  return {
    entries: toPublicRequestLog(stored.entries),
    available: stored.available,
    error: stored.error,
  };
}

function parseTelemetryData(data: Record<string, unknown>): void {
  cumulative.sessions = (data.cumulative_sessions as number) ?? 0;
  cumulative.tool_calls = (data.cumulative_tool_calls as number) ?? 0;
  cumulative.api_hits = (data.cumulative_api_hits as number) ?? 0;
  cumulative.landing_views = (data.cumulative_landing_views as number) ?? 0;
  cumulative.first_session_at = (data.first_session_at as string) ?? "";
  cumulative.last_deploy_at = (data.last_deploy_at as string) ?? "";
  cumulative.clients = (data.cumulative_clients as Record<string, number>) ?? {};
  cumulative.tool_calls_by_client = (data.cumulative_tool_calls_by_client as Record<string, number>) ?? {};
  const byClientSum = Object.values(cumulative.tool_calls_by_client).reduce((a, b) => a + b, 0);
  if (cumulative.tool_calls > byClientSum) {
    const delta = cumulative.tool_calls - byClientSum;
    cumulative.tool_calls_by_client.unknown = (cumulative.tool_calls_by_client.unknown ?? 0) + delta;
  }
  cumulative.tool_calls_by_name = (data.cumulative_tool_calls_by_name as Record<string, number>) ?? {};
  const byNameSum = Object.values(cumulative.tool_calls_by_name).reduce((a, b) => a + b, 0);
  if (cumulative.tool_calls > byNameSum) {
    const delta = cumulative.tool_calls - byNameSum;
    cumulative.tool_calls_by_name.unknown = (cumulative.tool_calls_by_name.unknown ?? 0) + delta;
  }
  cumulative.referral_listing_calls = (data.cumulative_referral_listing_calls as number) ?? 0;
  const listingBySource = (data.cumulative_referral_listing_by_source as Record<string, number>) ?? {};
  cumulative.referral_listing_by_source = {
    platform: listingBySource.platform ?? 0,
    agent: listingBySource.agent ?? 0,
    null: listingBySource.null ?? 0,
  };
  cumulative.referral_vendor_lookups = (data.cumulative_referral_vendor_lookups as number) ?? 0;
  cumulative.referral_vendor_counts = (data.cumulative_referral_vendor_counts as Record<string, number>) ?? {};
  cumulative.api_hits_by_endpoint = (data.cumulative_api_hits_by_endpoint as Record<string, number>) ?? {};

  searchQueryLog.length = 0;
  const persistedQueries = (data.cumulative_search_queries as unknown[]) ?? [];
  if (Array.isArray(persistedQueries)) {
    for (const entry of persistedQueries) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as SearchQueryEntry).query === "string" &&
        typeof (entry as SearchQueryEntry).results_count === "number" &&
        typeof (entry as SearchQueryEntry).timestamp === "string"
      ) {
        const parsed = { ...(entry as SearchQueryEntry) };
        if (typeof parsed.unfiltered_count !== "number" || !Number.isFinite(parsed.unfiltered_count)) {
          delete parsed.unfiltered_count;
        }
        searchQueryLog.push(parsed);
      }
    }
    if (searchQueryLog.length > SEARCH_QUERY_RING_MAX) {
      searchQueryLog.splice(0, searchQueryLog.length - SEARCH_QUERY_RING_MAX);
    }
  }
}

const sessionClients: Record<string, number> = {};

function buildTelemetryData(): TelemetryData {
  const totalToolCalls = Object.values(toolCalls).reduce((a, b) => a + b, 0);
  const totalApiHits = Object.values(apiHits).reduce((a, b) => a + b, 0);
  const mergedClients: Record<string, number> = { ...cumulative.clients };
  for (const [name, count] of Object.entries(sessionClients)) {
    mergedClients[name] = (mergedClients[name] ?? 0) + count;
  }
  const mergedToolCallsByClient: Record<string, number> = { ...cumulative.tool_calls_by_client };
  for (const [name, count] of Object.entries(toolCallsByClient)) {
    mergedToolCallsByClient[name] = (mergedToolCallsByClient[name] ?? 0) + count;
  }
  const mergedToolCallsByName: Record<string, number> = { ...cumulative.tool_calls_by_name };
  for (const [tool, count] of Object.entries(toolCallsByName)) {
    mergedToolCallsByName[tool] = (mergedToolCallsByName[tool] ?? 0) + count;
  }
  const mergedVendorCounts: Record<string, number> = { ...cumulative.referral_vendor_counts };
  for (const [vendor, count] of Object.entries(referralVendorCounts)) {
    mergedVendorCounts[vendor] = (mergedVendorCounts[vendor] ?? 0) + count;
  }
  const mergedApiHitsByEndpoint: Record<string, number> = { ...cumulative.api_hits_by_endpoint };
  for (const [endpoint, count] of Object.entries(apiHits)) {
    mergedApiHitsByEndpoint[endpoint] = (mergedApiHitsByEndpoint[endpoint] ?? 0) + count;
  }
  return {
    cumulative_sessions: cumulative.sessions + totalSessions,
    cumulative_tool_calls: cumulative.tool_calls + totalToolCalls,
    cumulative_api_hits: cumulative.api_hits + totalApiHits,
    cumulative_landing_views: cumulative.landing_views + landingPageViews,
    first_session_at: cumulative.first_session_at || (totalSessions > 0 ? serverStartedISO : ""),
    last_deploy_at: cumulative.last_deploy_at,
    cumulative_clients: mergedClients,
    cumulative_tool_calls_by_client: mergedToolCallsByClient,
    cumulative_tool_calls_by_name: mergedToolCallsByName,
    cumulative_referral_listing_calls: cumulative.referral_listing_calls + referralListingCalls,
    cumulative_referral_listing_by_source: {
      platform: cumulative.referral_listing_by_source.platform + referralListingBySource.platform,
      agent: cumulative.referral_listing_by_source.agent + referralListingBySource.agent,
      null: cumulative.referral_listing_by_source.null + referralListingBySource.null,
    },
    cumulative_referral_vendor_lookups: cumulative.referral_vendor_lookups + referralVendorLookups,
    cumulative_referral_vendor_counts: mergedVendorCounts,
    cumulative_api_hits_by_endpoint: mergedApiHitsByEndpoint,
    cumulative_search_queries: searchQueryLog.slice(-SEARCH_QUERY_RING_MAX),
  };
}

let telemetryLoadFailed = false;

export function telemetryLoadDidFail(): boolean {
  return telemetryLoadFailed;
}

export async function loadTelemetry(filePath: string): Promise<void> {
  telemetryPath = filePath;

  await loadPageViews();
  await loadRequestLog();

  if (useRedis()) {
    const res = await redisCommand<string | null>(["GET", REDIS_KEY]);
    if (res.ok && res.result) {
      try {
        parseTelemetryData(JSON.parse(res.result) as unknown as Record<string, unknown>);
        cumulative.last_deploy_at = serverStartedISO;
        telemetryLoadFailed = false;
        return;
      } catch {
      }
    }
    if (!res.ok) telemetryLoadFailed = true;
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    parseTelemetryData(data);
  } catch {
  }
  cumulative.last_deploy_at = serverStartedISO;
}

export async function flushTelemetry(): Promise<void> {
  if (!telemetryPath) return;

  if (useRedis() && telemetryLoadFailed) {
    const res = await redisCommand<string | null>(["GET", REDIS_KEY]);
    if (res.ok) {
      if (res.result) {
        try {
          parseTelemetryData(JSON.parse(res.result) as unknown as Record<string, unknown>);
        } catch {
        }
      }
      telemetryLoadFailed = false;
      console.error("[telemetry] storage recovered — resuming persistence");
    } else {
      logRedisFailure("SET", `skipping persist: boot load failed (${res.error})`);
    }
  }

  const data = buildTelemetryData();

  if (useRedis() && !telemetryLoadFailed) {
    await redisSet(data);
  }

  try {
    mkdirSync(dirname(telemetryPath), { recursive: true });
    writeFileSync(telemetryPath, JSON.stringify(data, null, 2) + "\n");
  } catch {
  }
}

export function resetCounters(): void {
  telemetryLoadFailed = false;
  totalSessions = 0;
  totalDisconnects = 0;
  landingPageViews = 0;
  for (const key of Object.keys(toolCalls)) toolCalls[key] = 0;
  for (const key of Object.keys(apiHits)) delete apiHits[key];
  for (const key of Object.keys(sessionClients)) delete sessionClients[key];
  for (const key of Object.keys(toolCallsByClient)) delete toolCallsByClient[key];
  for (const key of Object.keys(toolCallsByName)) delete toolCallsByName[key];
  cumulative.sessions = 0;
  cumulative.tool_calls = 0;
  cumulative.api_hits = 0;
  cumulative.landing_views = 0;
  cumulative.first_session_at = "";
  cumulative.last_deploy_at = "";
  cumulative.clients = {};
  cumulative.tool_calls_by_client = {};
  cumulative.tool_calls_by_name = {};
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
  cumulative.api_hits_by_endpoint = {};
  searchQueryLog.length = 0;
  resetTelemetryBuffers();
}

export function resetTelemetryBuffers(): void {
  pageViewSnapshot = emptySnapshot();
  pendingPageViews = emptySnapshot();
  pageViewsLoaded = false;
  pageViewsRereadPending = false;
  legacyMigrationDone = false;
  requestLogMirror = [];
  requestLogPending = [];
  requestLogDropped = 0;
  requestLogHydrated = false;
  lastFlushAt = null;
  trafficSinceBoot = {};
  notFoundSinceBoot = 0;
  redirectsSinceBoot = 0;
  signalsSinceBoot = 0;
  pageViewsToday = 0;
  pageViewsTodayDate = new Date().toISOString().slice(0, 10);
}

export function recordToolCall(tool: string, clientName?: string): void {
  if (tool in toolCalls) {
    toolCalls[tool]++;
    const bucket = (clientName && clientName.trim()) || "unknown";
    toolCallsByClient[bucket] = (toolCallsByClient[bucket] ?? 0) + 1;
    toolCallsByName[tool] = (toolCallsByName[tool] ?? 0) + 1;
    if (useRedis()) {
      bump(pendingPageViews.mcp, new Date().toISOString().slice(0, 10), 1);
    }
  }
}

export function recordApiHit(endpoint: string): void {
  if (!endpoint) return;
  apiHits[endpoint] = (apiHits[endpoint] ?? 0) + 1;
}

export function recordSessionConnect(clientName?: string): void {
  totalSessions++;
  if (!cumulative.first_session_at) {
    cumulative.first_session_at = new Date().toISOString();
  }
  const name = (clientName && clientName.trim()) || UNNAMED_SESSION_CLIENT_KEY;
  sessionClients[name] = (sessionClients[name] ?? 0) + 1;

  const today = new Date().toISOString().slice(0, 10);
  bump(pendingPageViews.sessions, today, 1);
  bumpBounded(
    (pendingPageViews.session_clients[today] ??= {}),
    name,
    1,
    MAX_SESSION_CLIENT_KEYS_PER_DAY,
    OTHER_SESSION_CLIENT_KEY,
    pageViewSnapshot.session_clients[today],
  );
  pendingPageViews.sessions_from = today;
}

export function getSessionsForDate(date: string): number {
  return (pageViewSnapshot.sessions[date] ?? 0) + (pendingPageViews.sessions[date] ?? 0);
}

export function getSessionSeries(): SessionSeries {
  const dates = new Set([
    ...Object.keys(pageViewSnapshot.sessions),
    ...Object.keys(pendingPageViews.sessions),
  ]);
  return {
    daily: [...dates]
      .sort()
      .map(date => ({ date, sessions: getSessionsForDate(date) })),
    today: getSessionsForDate(new Date().toISOString().slice(0, 10)),
    recording_since: pageViewSnapshot.sessions_from || pendingPageViews.sessions_from || null,
    all_time: cumulative.sessions + totalSessions,
    retention_days: SESSION_DAY_RETENTION,
  };
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

export const CRAWLER_CLIENT_PATTERNS = [
  "crawler",
  "probe",
  "scanner",
  "validator",
  "inspector",
  "introspector",
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
  "index",
  "catalog",
  "audit",
  "watch",
  "uptime",
  "beat",
  "grade",
  "research",
  "census",
  "poll",
  "walker",
  "scraper",
  "miner",
  "extractor",
  "discovery",
  "liveness",
  "readiness",
  "reputation",
  "trust",
  "verifier",
  "observatory",
  "smithery",
  "censys",
  "spec-check",
  "tirekick",
  "sweep",
  "recon",
] as const;

export const AGENT_CLIENT_NAMES = [
  "claude-code",
  "claude-desktop",
  "cline",
  "codex-mcp-client",
  "continue",
  "cursor",
  "goose",
  "librechat",
  "lobehub-mcp-client",
  "metamcp-client",
  "mcporter",
  "opencode",
  "windsurf",
  "zed",
] as const;

export const INTERNAL_CLIENT_PREFIX = "agentdeals";

export type McpClientClass = "agent" | "crawler" | "internal" | "unattributed";

export function classifyMcpClient(name: string): McpClientClass {
  const lower = (name || "").trim().toLowerCase();
  if (!lower) return "unattributed";
  if (lower.startsWith(INTERNAL_CLIENT_PREFIX)) return "internal";
  if ((AGENT_CLIENT_NAMES as readonly string[]).includes(lower)) return "agent";
  for (const pattern of CRAWLER_CLIENT_PATTERNS) {
    if (lower.includes(pattern)) return "crawler";
  }
  return "unattributed";
}

export const SESSION_CLASSIFICATION_RULE =
  "agent counts only client names on an explicit allowlist of agent products. crawler counts names matching a registry/scanner/probe/monitor pattern. internal is our own traffic. unattributed is everything else, including the generic name 'mcp' — a name we do not recognise is not evidence of an agent, and no missing crawler pattern can add to the agent count.";

export function getSessionClassification(): {
  sessions_by_type: {
    agent: number;
    crawler: number;
    internal: number;
    unattributed: number;
    total: number;
  };
  clients_top: { name: string; sessions: number; type: McpClientClass }[];
  classification_rule: string;
} {
  const mergedClients: Record<string, number> = { ...cumulative.clients };
  for (const [name, count] of Object.entries(sessionClients)) {
    mergedClients[name] = (mergedClients[name] ?? 0) + count;
  }
  const byType: Record<McpClientClass, number> = {
    agent: 0,
    crawler: 0,
    internal: 0,
    unattributed: 0,
  };
  for (const [name, count] of Object.entries(mergedClients)) {
    byType[classifyMcpClient(name)] += count;
  }
  const clientsTop = Object.entries(mergedClients)
    .map(([name, sessions]) => ({ name, sessions, type: classifyMcpClient(name) }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 10);
  return {
    sessions_by_type: {
      ...byType,
      total: byType.agent + byType.crawler + byType.internal + byType.unattributed,
    },
    clients_top: clientsTop,
    classification_rule: SESSION_CLASSIFICATION_RULE,
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
  toolCallsByClient: Record<string, number>;
  toolCallsByName: Record<string, number>;
} {
  const today = new Date().toISOString().slice(0, 10);
  const totalToolCalls = Object.values(toolCalls).reduce((a, b) => a + b, 0);
  const totalApiHits = Object.values(apiHits).reduce((a, b) => a + b, 0);
  const mergedClients: Record<string, number> = { ...cumulative.clients };
  for (const [name, count] of Object.entries(sessionClients)) {
    mergedClients[name] = (mergedClients[name] ?? 0) + count;
  }
  const mergedToolCallsByClient: Record<string, number> = { ...cumulative.tool_calls_by_client };
  for (const [name, count] of Object.entries(toolCallsByClient)) {
    mergedToolCallsByClient[name] = (mergedToolCallsByClient[name] ?? 0) + count;
  }
  const mergedToolCallsByName: Record<string, number> = { ...cumulative.tool_calls_by_name };
  for (const [tool, count] of Object.entries(toolCallsByName)) {
    mergedToolCallsByName[tool] = (mergedToolCallsByName[tool] ?? 0) + count;
  }
  return {
    activeSessions,
    totalSessionsAllTime: cumulative.sessions + totalSessions,
    totalApiHitsAllTime: cumulative.api_hits + totalApiHits,
    totalToolCallsAllTime: cumulative.tool_calls + totalToolCalls,
    sessionsToday: getSessionsForDate(today),
    serverStarted: serverStartedISO,
    clients: mergedClients,
    toolCallsByClient: mergedToolCallsByClient,
    toolCallsByName: mergedToolCallsByName,
  };
}

const BOT_PATTERNS = /bot|crawler|spider|googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|semrushbot|ahrefsbot|mj12bot|dotbot|petalbot|bytespider|gptbot|claudebot|facebookexternalhit|twitterbot|linkedinbot|applebot|ia_archiver|archive\.org/i;

function isBot(userAgent: string): boolean {
  return BOT_PATTERNS.test(userAgent);
}

let pageViewsToday = 0;
let pageViewsTodayDate = new Date().toISOString().slice(0, 10);

const MGET_CHUNK_SIZE = 100;

const PAGE_VIEWS_KEY = "agentdeals:pageviews";
const PAGE_VIEW_DAY_RETENTION = 7;
const MAX_PAGE_KEYS_PER_DAY = 300;
const MAX_ALL_TIME_PAGE_KEYS = 300;

const MAX_REFERRER_DOMAINS_PER_DAY = 100;
export const OTHER_REFERRER_KEY = "__other__";

const DAY_TOTAL_KEY = "total";

export type RequestOutcome = "served" | "redirect" | "not_found";

export function requestOutcome(statusCode?: number): RequestOutcome {
  if (statusCode === undefined) return "served";
  if (statusCode >= 400) return "not_found";
  if (statusCode >= 300) return "redirect";
  return "served";
}

export const NOT_FOUND_KEY = "__not_found__";
export const REDIRECT_KEY = "__redirect__";

export const OVERFLOW_PAGE_KEY = "__other_pages__";

export const UNMATCHED_PAGE_KEY = "__unmatched__";

const PSEUDO_DAY_KEYS = new Set<string>([DAY_TOTAL_KEY, NOT_FOUND_KEY, REDIRECT_KEY, UNMATCHED_PAGE_KEY]);

function outcomeKey(outcome: Exclude<RequestOutcome, "served">): string {
  return outcome === "redirect" ? REDIRECT_KEY : NOT_FOUND_KEY;
}

export const TRAFFIC_CLASSES = [
  "internal",
  "ai_agent",
  "search_crawler",
  "seo_crawler",
  "other_bot",
  "sdk_client",
  "browser",
  "unknown",
] as const;
export type TrafficClass = (typeof TRAFFIC_CLASSES)[number];

export interface TrafficClassification {
  client_class: string;
  family: string;
}

const CLASS_DAY_RETENTION = 30;
const MAX_CLASS_ROUTE_KEYS_PER_DAY = 200;
const MAX_FAMILY_KEYS_PER_DAY = 40;
const CLASS_ROUTE_SEP = "|";
const UNKNOWN_FAMILY_KEY = "unknown";

const SESSION_DAY_RETENTION = 90;
export const MAX_SESSION_CLIENT_KEYS_PER_DAY = 120;
export const OTHER_SESSION_CLIENT_KEY = "__other_clients__";
export const UNNAMED_SESSION_CLIENT_KEY = "unknown";

export interface NotFoundSample {
  ts: string;
  client_class: string;
  status: number;
  path: string;
}

const NOT_FOUND_SAMPLE_MAX = 50;
const NOT_FOUND_SAMPLE_PATH_MAX = 80;

export function sanitizeSamplePath(raw: unknown): string {
  const clean = String(raw ?? "")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[<>"'`&\\]/g, "");
  return clean.length > NOT_FOUND_SAMPLE_PATH_MAX
    ? `${clean.slice(0, NOT_FOUND_SAMPLE_PATH_MAX)}...`
    : clean;
}

interface PageViewSnapshot {
  days: Record<string, Record<string, number>>;
  referrers: Record<string, Record<string, number>>;
  all_time: Record<string, number>;
  updated_at: string;
  classes: Record<string, Record<string, number>>;
  class_routes: Record<string, Record<string, number>>;
  families: Record<string, Record<string, number>>;
  mcp: Record<string, number>;
  sessions: Record<string, number>;
  session_clients: Record<string, Record<string, number>>;
  sessions_from: string;
  not_found: Record<string, Record<string, number>>;
  redirects: Record<string, Record<string, number>>;
  not_found_sample: NotFoundSample[];
  signals: Record<string, Record<string, number>>;
  signals_all_time: Record<string, number>;
  signal_notes: SignalNote[];
  signals_from: string;
  all_time_trustworthy_from: string;
  outcome_split_from: string;
}

function emptySnapshot(): PageViewSnapshot {
  return {
    days: {},
    referrers: {},
    all_time: {},
    updated_at: "",
    classes: {},
    class_routes: {},
    families: {},
    mcp: {},
    sessions: {},
    session_clients: {},
    not_found: {},
    redirects: {},
    not_found_sample: [],
    signals: {},
    signals_all_time: {},
    signal_notes: [],
    signals_from: "",
    sessions_from: "",
    all_time_trustworthy_from: "",
    outcome_split_from: "",
  };
}

let pageViewSnapshot = emptySnapshot();
let pendingPageViews = emptySnapshot();
let pageViewsLoaded = false;
let pageViewsRereadPending = false;

let trafficSinceBoot: Record<string, number> = {};
let notFoundSinceBoot = 0;
let redirectsSinceBoot = 0;

function recordNotFoundSample(client_class: string, path: string, status: number): void {
  pendingPageViews.not_found_sample.push({
    ts: new Date().toISOString(),
    client_class,
    status,
    path: sanitizeSamplePath(path),
  });
  if (pendingPageViews.not_found_sample.length > NOT_FOUND_SAMPLE_MAX) {
    pendingPageViews.not_found_sample.splice(
      0,
      pendingPageViews.not_found_sample.length - NOT_FOUND_SAMPLE_MAX,
    );
  }
}

function bump(map: Record<string, number>, key: string, delta: number): void {
  map[key] = (map[key] ?? 0) + delta;
}

function bumpBounded(
  map: Record<string, number>,
  key: string,
  delta: number,
  cap: number,
  overflowKey: string,
  known?: Record<string, number>,
): void {
  if (key !== overflowKey && !(key in map) && !(known && key in known)) {
    const size = known
      ? new Set([...Object.keys(map), ...Object.keys(known)]).size
      : Object.keys(map).length;
    if (size >= cap) key = overflowKey;
  }
  bump(map, key, delta);
}

function countPendingPageViewKeys(): number {
  let n = Object.keys(pendingPageViews.all_time).length + Object.keys(pendingPageViews.mcp).length;
  for (const day of Object.values(pendingPageViews.days)) n += Object.keys(day).length;
  for (const day of Object.values(pendingPageViews.referrers)) n += Object.keys(day).length;
  for (const day of Object.values(pendingPageViews.classes)) n += Object.keys(day).length;
  for (const day of Object.values(pendingPageViews.class_routes)) n += Object.keys(day).length;
  for (const day of Object.values(pendingPageViews.families)) n += Object.keys(day).length;
  for (const day of Object.values(pendingPageViews.not_found)) n += Object.keys(day).length;
  for (const day of Object.values(pendingPageViews.redirects)) n += Object.keys(day).length;
  for (const day of Object.values(pendingPageViews.signals)) n += Object.keys(day).length;
  n += pendingPageViews.signal_notes.length;
  n += pendingPageViews.not_found_sample.length;
  n += Object.keys(pendingPageViews.sessions).length;
  for (const day of Object.values(pendingPageViews.session_clients)) n += Object.keys(day).length;
  return n;
}

function hasPendingPageViews(): boolean {
  return countPendingPageViewKeys() > 0;
}

function mergeSnapshot(base: PageViewSnapshot, delta: PageViewSnapshot): PageViewSnapshot {
  const out: PageViewSnapshot = {
    days: {},
    referrers: {},
    all_time: { ...base.all_time },
    updated_at: base.updated_at,
    classes: {},
    class_routes: {},
    families: {},
    mcp: { ...base.mcp },
    sessions: { ...base.sessions },
    session_clients: {},
    not_found: {},
    redirects: {},
    not_found_sample: [...base.not_found_sample, ...delta.not_found_sample].slice(-NOT_FOUND_SAMPLE_MAX),
    signals: {},
    signals_all_time: { ...base.signals_all_time },
    signal_notes: [...base.signal_notes, ...delta.signal_notes].slice(-SIGNAL_NOTE_MAX),
    signals_from: base.signals_from || delta.signals_from,
    sessions_from: base.sessions_from || delta.sessions_from,
    all_time_trustworthy_from: base.all_time_trustworthy_from || delta.all_time_trustworthy_from,
    outcome_split_from: base.outcome_split_from || delta.outcome_split_from,
  };
  for (const [date, map] of Object.entries(base.days)) out.days[date] = { ...map };
  for (const [date, map] of Object.entries(base.referrers)) out.referrers[date] = { ...map };
  for (const [date, map] of Object.entries(base.classes)) out.classes[date] = { ...map };
  for (const [date, map] of Object.entries(base.class_routes)) out.class_routes[date] = { ...map };
  for (const [date, map] of Object.entries(base.families)) out.families[date] = { ...map };
  for (const [date, map] of Object.entries(base.session_clients)) out.session_clients[date] = { ...map };
  for (const [date, map] of Object.entries(base.not_found)) out.not_found[date] = { ...map };
  for (const [date, map] of Object.entries(base.redirects)) out.redirects[date] = { ...map };
  for (const [date, map] of Object.entries(base.signals)) out.signals[date] = { ...map };

  for (const [date, map] of Object.entries(delta.signals)) {
    const target = (out.signals[date] ??= {});
    for (const [key, count] of Object.entries(map)) {
      bumpSignalKey(target, key, count, MAX_SIGNAL_KEYS_PER_FACET_PER_DAY);
    }
  }
  for (const [key, count] of Object.entries(delta.signals_all_time)) {
    bumpSignalKey(out.signals_all_time, key, count, MAX_SIGNAL_ALL_TIME_KEYS_PER_FACET);
  }

  for (const [date, map] of Object.entries(delta.days)) {
    const target = (out.days[date] ??= {});
    for (const [key, count] of Object.entries(map)) {
      if (PSEUDO_DAY_KEYS.has(key)) bump(target, key, count);
      else bumpBounded(target, key, count, MAX_PAGE_KEYS_PER_DAY, OVERFLOW_PAGE_KEY);
    }
  }
  for (const [date, map] of Object.entries(delta.referrers)) {
    const target = (out.referrers[date] ??= {});
    for (const [key, count] of Object.entries(map)) {
      bumpBounded(target, key, count, MAX_REFERRER_DOMAINS_PER_DAY, OTHER_REFERRER_KEY);
    }
  }
  for (const [key, count] of Object.entries(delta.all_time)) {
    if (PSEUDO_DAY_KEYS.has(key)) bump(out.all_time, key, count);
    else bumpBounded(out.all_time, key, count, MAX_ALL_TIME_PAGE_KEYS, OVERFLOW_PAGE_KEY);
  }
  for (const field of ["not_found", "redirects"] as const) {
    for (const [date, map] of Object.entries(delta[field])) {
      const target = (out[field][date] ??= {});
      for (const [key, count] of Object.entries(map)) bump(target, key, count);
    }
  }
  for (const [date, map] of Object.entries(delta.classes)) {
    const target = (out.classes[date] ??= {});
    for (const [key, count] of Object.entries(map)) bump(target, key, count);
  }
  for (const [date, map] of Object.entries(delta.class_routes)) {
    const target = (out.class_routes[date] ??= {});
    for (const [key, count] of Object.entries(map)) {
      bumpBounded(target, key, count, MAX_CLASS_ROUTE_KEYS_PER_DAY, classRouteOverflowKey(key));
    }
  }
  for (const [date, map] of Object.entries(delta.families)) {
    const target = (out.families[date] ??= {});
    for (const [key, count] of Object.entries(map)) {
      bumpBounded(target, key, count, MAX_FAMILY_KEYS_PER_DAY, UNKNOWN_FAMILY_KEY);
    }
  }
  for (const [date, count] of Object.entries(delta.mcp)) bump(out.mcp, date, count);
  for (const [date, count] of Object.entries(delta.sessions)) bump(out.sessions, date, count);
  for (const [date, map] of Object.entries(delta.session_clients)) {
    const target = (out.session_clients[date] ??= {});
    for (const [key, count] of Object.entries(map)) {
      bumpBounded(target, key, count, MAX_SESSION_CLIENT_KEYS_PER_DAY, OTHER_SESSION_CLIENT_KEY);
    }
  }
  return out;
}

function classRouteOverflowKey(key: string): string {
  const cls = key.split(CLASS_ROUTE_SEP)[0];
  return `${cls}${CLASS_ROUTE_SEP}${OVERFLOW_PAGE_KEY}`;
}

function pruneSnapshot(snapshot: PageViewSnapshot): void {
  for (const field of ["days", "referrers", "class_routes", "families"] as const) {
    const dates = Object.keys(snapshot[field]).sort().reverse();
    for (const date of dates.slice(PAGE_VIEW_DAY_RETENTION)) delete snapshot[field][date];
  }
  for (const field of ["classes", "mcp", "not_found", "redirects", "signals"] as const) {
    for (const date of Object.keys(snapshot[field]).sort().reverse().slice(CLASS_DAY_RETENTION)) {
      delete snapshot[field][date];
    }
  }
  for (const field of ["sessions", "session_clients"] as const) {
    for (const date of Object.keys(snapshot[field]).sort().reverse().slice(SESSION_DAY_RETENTION)) {
      delete snapshot[field][date];
    }
  }
  const pseudo = Object.entries(snapshot.all_time).filter(([k]) => PSEUDO_DAY_KEYS.has(k));
  const entries = Object.entries(snapshot.all_time).filter(([k]) => !PSEUDO_DAY_KEYS.has(k));
  if (entries.length > MAX_ALL_TIME_PAGE_KEYS) {
    entries.sort((a, b) => b[1] - a[1]);
    const kept = Object.fromEntries([...entries.slice(0, MAX_ALL_TIME_PAGE_KEYS), ...pseudo]);
    const folded = entries.slice(MAX_ALL_TIME_PAGE_KEYS).reduce((sum, [, v]) => sum + v, 0);
    snapshot.all_time = kept;
    if (folded > 0) bump(snapshot.all_time, OVERFLOW_PAGE_KEY, folded);
  }
}

function repairAllTimeKeys(snapshot: PageViewSnapshot): { keys: number; hits: number } {
  let keys = 0;
  let hits = 0;
  for (const [key, count] of Object.entries(snapshot.all_time)) {
    if (PSEUDO_DAY_KEYS.has(key) || key === OVERFLOW_PAGE_KEY) continue;
    if (normalizePagePath(key) === key) continue;
    delete snapshot.all_time[key];
    bump(snapshot.all_time, NOT_FOUND_KEY, count);
    keys++;
    hits += count;
  }
  return { keys, hits };
}

function adoptSnapshot(snapshot: PageViewSnapshot): PageViewSnapshot {
  const repaired = repairAllTimeKeys(snapshot);
  if (repaired.keys > 0) {
    console.error(
      `[telemetry] #1029 all-time repair: moved ${repaired.keys} non-route keys ` +
        `(${repaired.hits} hits) into ${NOT_FOUND_KEY}`,
    );
  }
  pruneSnapshot(snapshot);
  const today = new Date().toISOString().slice(0, 10);
  if (!snapshot.all_time_trustworthy_from) snapshot.all_time_trustworthy_from = today;
  if (!snapshot.outcome_split_from) snapshot.outcome_split_from = today;
  return snapshot;
}

function numericMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function numericMapOfMaps(raw: unknown): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = numericMap(v);
  return out;
}

function normalizeSnapshot(raw: unknown): PageViewSnapshot {
  const snapshot = emptySnapshot();
  if (!raw || typeof raw !== "object") return snapshot;
  const obj = raw as Record<string, unknown>;
  snapshot.days = numericMapOfMaps(obj.days);
  snapshot.referrers = numericMapOfMaps(obj.referrers);
  snapshot.all_time = numericMap(obj.all_time);
  snapshot.updated_at = typeof obj.updated_at === "string" ? obj.updated_at : "";
  snapshot.classes = numericMapOfMaps(obj.classes);
  snapshot.class_routes = numericMapOfMaps(obj.class_routes);
  snapshot.families = numericMapOfMaps(obj.families);
  snapshot.mcp = numericMap(obj.mcp);
  snapshot.sessions = numericMap(obj.sessions);
  snapshot.session_clients = numericMapOfMaps(obj.session_clients);
  snapshot.not_found = numericMapOfMaps(obj.not_found);
  snapshot.redirects = numericMapOfMaps(obj.redirects);
  snapshot.not_found_sample = notFoundSamples(obj.not_found_sample);
  snapshot.signals = numericMapOfMaps(obj.signals);
  snapshot.signals_all_time = numericMap(obj.signals_all_time);
  snapshot.signal_notes = signalNotes(obj.signal_notes);
  snapshot.signals_from = typeof obj.signals_from === "string" ? obj.signals_from : "";
  snapshot.sessions_from = typeof obj.sessions_from === "string" ? obj.sessions_from : "";
  snapshot.all_time_trustworthy_from =
    typeof obj.all_time_trustworthy_from === "string" ? obj.all_time_trustworthy_from : "";
  snapshot.outcome_split_from =
    typeof obj.outcome_split_from === "string" ? obj.outcome_split_from : "";
  return snapshot;
}

function notFoundSamples(raw: unknown): NotFoundSample[] {
  if (!Array.isArray(raw)) return [];
  const out: NotFoundSample[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    out.push({
      ts: typeof e.ts === "string" ? e.ts : "",
      client_class: typeof e.client_class === "string" ? e.client_class : "unknown",
      status: typeof e.status === "number" && Number.isFinite(e.status) ? e.status : 0,
      path: sanitizeSamplePath(e.path),
    });
  }
  return out;
}

function signalNotes(raw: unknown): SignalNote[] {
  if (!Array.isArray(raw)) return [];
  const out: SignalNote[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const note = typeof e.note === "string" ? e.note.slice(0, SIGNAL_NOTE_TEXT_MAX) : "";
    if (!note) continue;
    out.push({
      ts: typeof e.ts === "string" ? e.ts : "",
      event: typeof e.event === "string" ? e.event.slice(0, 40) : "",
      vendor: typeof e.vendor === "string" ? e.vendor.slice(0, 80) : null,
      note,
      redacted: e.redacted === true,
    });
  }
  return out;
}

export interface JsonReadResult {
  ok: boolean;
  value: unknown;
  error?: string;
}

export interface JsonWriteResult {
  ok: boolean;
  error?: string;
}

function parseJsonValue(raw: string | null): unknown {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function redisJsonGet(key: string): Promise<JsonReadResult> {
  const res = await redisCommand<string | null>(["GET", key]);
  if (!res.ok) return { ok: false, value: null, error: res.error };
  return { ok: true, value: parseJsonValue(res.result ?? null) };
}

export async function redisJsonMget(keys: string[]): Promise<{ ok: boolean; values: unknown[]; error?: string }> {
  if (keys.length === 0) return { ok: true, values: [] };
  const res = await redisMget(keys);
  if (!res.ok) return { ok: false, values: [], error: res.error };
  return { ok: true, values: res.result.map(parseJsonValue) };
}

export async function redisJsonSet(key: string, value: unknown, ttlSeconds: number): Promise<JsonWriteResult> {
  const res = await redisCommand<string>(["SET", key, JSON.stringify(value), "EX", String(Math.max(1, Math.floor(ttlSeconds)))]);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

export async function redisJsonSetWithoutExpiry(key: string, value: unknown): Promise<JsonWriteResult> {
  const res = await redisCommand<string>(["SET", key, JSON.stringify(value)]);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

async function redisMget(keys: string[]): Promise<RedisResult<(string | null)[]>> {
  const res = await redisCommand<(string | null)[]>(["MGET", ...keys]);
  if (!res.ok) return res;
  const values = res.result;
  if (!Array.isArray(values) || values.length !== keys.length) {
    const error = `MGET returned ${Array.isArray(values) ? values.length : typeof values} values for ${keys.length} keys`;
    recordRedisFailure("MGET", false, error);
    return { ok: false, error };
  }
  return { ok: true, result: values };
}

async function redisScan(pattern: string, count = 100): Promise<RedisResult<string[]>> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const res = await redisCommand<[string, string[]]>(["SCAN", cursor, "MATCH", pattern, "COUNT", String(count)]);
    if (!res.ok) return res;
    if (!res.result) break;
    cursor = res.result[0];
    keys.push(...res.result[1]);
  } while (cursor !== "0" && keys.length < 500);
  return { ok: true, result: keys };
}

async function redisGetMulti(keys: string[]): Promise<{ values: Map<string, number>; missing: string[] }> {
  const values = new Map<string, number>();
  const missing: string[] = [];
  if (keys.length === 0) return { values, missing };
  for (let i = 0; i < keys.length; i += MGET_CHUNK_SIZE) {
    const chunk = keys.slice(i, i + MGET_CHUNK_SIZE);
    const res = await redisMget(chunk);
    if (!res.ok) {
      missing.push(...chunk);
      continue;
    }
    for (let j = 0; j < chunk.length; j++) {
      const v = res.result[j];
      if (v === null) continue;
      values.set(chunk[j], parseInt(v, 10) || 0);
    }
  }
  return { values, missing };
}

const DYNAMIC_PAGE_PREFIXES = [
  "/embed/vendor/",
  "/embed/category/",
  "/alternative-to/",
  "/category/",
  "/compare/",
  "/vendors/",
  "/vendor/",
  "/reports/",
  "/guides/",
  "/trends/",
  "/stacks/",
  "/events/",
  "/digest/",
  "/badge/",
  "/best/",
] as const;

export function normalizePagePath(path: string): string {
  if (typeof path !== "string" || path.length === 0) return UNMATCHED_PAGE_KEY;
  const clean = path.split("?")[0].split("#")[0];
  if (clean === "/") return "/";
  for (const prefix of DYNAMIC_PAGE_PREFIXES) {
    if (clean.startsWith(prefix)) return `${prefix}:slug`;
  }
  if (/^\/[a-z0-9][a-z0-9._-]{0,63}$/.test(clean)) return clean;
  return UNMATCHED_PAGE_KEY;
}

const DYNAMIC_API_PREFIXES = ["/api/vendor/", "/api/category/", "/api/compare/", "/api/badge/"] as const;

export function normalizeRoutePath(path: string): string {
  if (typeof path !== "string" || path.length === 0) return UNMATCHED_PAGE_KEY;
  const clean = path.split("?")[0].split("#")[0];
  for (const prefix of DYNAMIC_API_PREFIXES) {
    if (clean.startsWith(prefix)) return `${prefix}:slug`;
  }
  if (clean.startsWith("/api/") && /^\/api\/[a-z0-9][a-z0-9._-]{0,63}(\.[a-z]{2,5})?$/.test(clean)) {
    return clean;
  }
  if (clean === "/mcp" || clean === "/health") return clean;
  return normalizePagePath(clean);
}

export function recordTraffic(
  classification: TrafficClassification,
  path: string,
  statusCode?: number,
): void {
  const { client_class, family } = classification;
  const today = new Date().toISOString().slice(0, 10);
  const outcome = requestOutcome(statusCode);

  if (outcome !== "served") {
    if (outcome === "not_found") {
      notFoundSinceBoot++;
      recordNotFoundSample(client_class, path, statusCode ?? 0);
    } else {
      redirectsSinceBoot++;
    }
    if (!useRedis()) return;
    bump((pendingPageViews[outcome === "redirect" ? "redirects" : "not_found"][today] ??= {}), client_class, 1);
    return;
  }

  trafficSinceBoot[client_class] = (trafficSinceBoot[client_class] ?? 0) + 1;
  if (!useRedis()) return;

  const route = normalizeRoutePath(path);

  bump((pendingPageViews.classes[today] ??= {}), client_class, 1);
  bumpBounded(
    (pendingPageViews.class_routes[today] ??= {}),
    `${client_class}${CLASS_ROUTE_SEP}${route}`,
    1,
    MAX_CLASS_ROUTE_KEYS_PER_DAY,
    `${client_class}${CLASS_ROUTE_SEP}${OVERFLOW_PAGE_KEY}`,
    pageViewSnapshot.class_routes[today],
  );
  if (client_class === "ai_agent") {
    bumpBounded(
      (pendingPageViews.families[today] ??= {}),
      family,
      1,
      MAX_FAMILY_KEYS_PER_DAY,
      UNKNOWN_FAMILY_KEY,
      pageViewSnapshot.families[today],
    );
  }
}

export function recordPageView(path: string, userAgent: string, referer?: string, statusCode?: number): void {
  if (isBot(userAgent)) return;

  const today = new Date().toISOString().slice(0, 10);
  if (today !== pageViewsTodayDate) {
    pageViewsToday = 0;
    pageViewsTodayDate = today;
  }
  const outcome = requestOutcome(statusCode);
  if (outcome === "served") pageViewsToday++;

  if (!useRedis()) return;

  if (outcome !== "served") {
    const day = (pendingPageViews.days[today] ??= {});
    bump(day, outcomeKey(outcome), 1);
    bump(pendingPageViews.all_time, outcomeKey(outcome), 1);
    return;
  }

  const normalized = normalizePagePath(path);
  const key = normalized === UNMATCHED_PAGE_KEY ? OVERFLOW_PAGE_KEY : normalized;

  const day = (pendingPageViews.days[today] ??= {});
  bumpBounded(day, key, 1, MAX_PAGE_KEYS_PER_DAY, OVERFLOW_PAGE_KEY, pageViewSnapshot.days[today]);
  bump(day, DAY_TOTAL_KEY, 1);
  bumpBounded(pendingPageViews.all_time, key, 1, MAX_ALL_TIME_PAGE_KEYS, OVERFLOW_PAGE_KEY, pageViewSnapshot.all_time);

  if (referer) {
    try {
      const refUrl = new URL(referer);
      const domain = refUrl.hostname.replace(/^www\./, "");
      const refDay = (pendingPageViews.referrers[today] ??= {});
      bumpBounded(
        refDay,
        domain,
        1,
        MAX_REFERRER_DOMAINS_PER_DAY,
        OTHER_REFERRER_KEY,
        pageViewSnapshot.referrers[today],
      );
    } catch {
    }
  }
}

let legacyMigrationDone = false;

async function migrateLegacyPageViews(): Promise<PageViewSnapshot | null> {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const snapshot = emptySnapshot();

  const sources: { pattern: string; apply: (suffix: string, value: number) => void }[] = [
    {
      pattern: "pv:all:",
      apply: (suffix, value) => bump(snapshot.all_time, suffix, value),
    },
    {
      pattern: `pv:${today}:`,
      apply: (suffix, value) => bump((snapshot.days[today] ??= {}), suffix, value),
    },
    {
      pattern: `pv:${yesterday}:`,
      apply: (suffix, value) => bump((snapshot.days[yesterday] ??= {}), suffix, value),
    },
    {
      pattern: `ref:${today}:`,
      apply: (suffix, value) => bump((snapshot.referrers[today] ??= {}), suffix, value),
    },
  ];

  for (const { pattern, apply } of sources) {
    const scan = await redisScan(`${pattern}*`);
    if (!scan.ok) return null;
    if (scan.result.length === 0) continue;
    const { values, missing } = await redisGetMulti(scan.result);
    if (missing.length > 0) return null;
    for (const key of scan.result) apply(key.slice(pattern.length), values.get(key) ?? 0);
  }

  return snapshot;
}

async function loadPageViews(): Promise<void> {
  if (!useRedis()) return;
  const res = await redisCommand<string | null>(["GET", PAGE_VIEWS_KEY]);
  if (!res.ok) return;

  if (res.result) {
    try {
      pageViewSnapshot = adoptSnapshot(normalizeSnapshot(JSON.parse(res.result)));
      pageViewsLoaded = true;
      pageViewsRereadPending = true;
      legacyMigrationDone = true;
      return;
    } catch {
    }
  }

  if (!legacyMigrationDone) {
    const migrated = await migrateLegacyPageViews();
    if (!migrated) return;
    pageViewSnapshot = adoptSnapshot(migrated);
    legacyMigrationDone = true;
  }
  pageViewsLoaded = true;
  pageViewsRereadPending = true;
}

async function flushPageViews(): Promise<void> {
  if (!useRedis()) return;

  if (!pageViewsLoaded) {
    await loadPageViews();
    if (!pageViewsLoaded) {
      logRedisFailure("SET", "skipping page-view persist: snapshot not loaded");
      return;
    }
  }

  if (!hasPendingPageViews()) return;

  if (pageViewsRereadPending) {
    pageViewsRereadPending = false;
    const read = await redisCommand<string | null>(["GET", PAGE_VIEWS_KEY]);
    if (read.ok && read.result) {
      try { pageViewSnapshot = adoptSnapshot(normalizeSnapshot(JSON.parse(read.result))); }
      catch {}
    }
  }

  const batch = pendingPageViews;
  pendingPageViews = emptySnapshot();

  const merged = mergeSnapshot(pageViewSnapshot, batch);
  pruneSnapshot(merged);
  merged.updated_at = new Date().toISOString();

  const write = await redisCommand<string>(["SET", PAGE_VIEWS_KEY, JSON.stringify(merged)]);
  if (!write.ok) {
    pendingPageViews = mergeSnapshot(batch, pendingPageViews);
    return;
  }

  pageViewSnapshot = merged;
}

const DEFAULT_FLUSH_INTERVAL_SECONDS = 60;
const MIN_FLUSH_INTERVAL_SECONDS = 5;
export const FLUSH_INTERVAL_SECONDS = Number(process.env.TELEMETRY_FLUSH_INTERVAL_SECONDS) > 0
  ? Math.max(MIN_FLUSH_INTERVAL_SECONDS, Number(process.env.TELEMETRY_FLUSH_INTERVAL_SECONDS))
  : DEFAULT_FLUSH_INTERVAL_SECONDS;

let lastFlushAt: string | null = null;

async function runFlush(): Promise<void> {
  try {
    if (!requestLogHydrated) await loadRequestLog();
    await flushPageViews();
    await flushRequestLog();
    lastFlushAt = new Date().toISOString();
  } catch (err) {
    logRedisFailure("FLUSH", err instanceof Error ? err.message : String(err));
  }
}

let flushChain: Promise<void> = Promise.resolve();

export function flushPending(): Promise<void> {
  if (!useRedis()) return Promise.resolve();
  flushChain = flushChain.then(runFlush, runFlush);
  return flushChain;
}

export interface PageViewPeriod {
  total: number | null;
  top_pages: { path: string; views: number }[];
  partial: boolean;
  not_found: number;
  redirects: number;
  unclassified_legacy: number;
}

export interface PageViewsReport {
  today: PageViewPeriod;
  yesterday: PageViewPeriod;
  all_time: PageViewPeriod;
  referrers_today: Record<string, number>;
  all_time_trustworthy_from: string | null;
  notes: string[];
  available: boolean;
  error: string | null;
  storage: TelemetryHealth;
}

const UNAVAILABLE_PERIOD: PageViewPeriod = {
  total: null,
  top_pages: [],
  partial: true,
  not_found: 0,
  redirects: 0,
  unclassified_legacy: 0,
};

const PAGE_VIEW_NOTES = [
  "`total` counts requests we answered with a page (2xx), by a non-bot client, over the stated period. It excludes bots, redirects, non-resolving requests, API routes, /mcp and static assets.",
  "`not_found` counts requests that resolved to no page (4xx/5xx). Before #1029 these were inside `total` and were 84% of it on the day the defect was found.",
  "`redirects` counts 3xx answers to page requests. A redirect is followed, and the request that follows it is the page view — counting both would double it. Redirects issued before the page-view hook (non-canonical hostnames, /vendors/*) are counted on /api/traffic instead, so that figure is the larger of the two.",
  "`top_pages` lists normalized route patterns, not raw paths, and is truncated to the top 20 — the entries do not sum to `total`.",
  "`all_time` has no retention and spans the pre-#1029 counting rules; read `all_time_trustworthy_from` before quoting it. Daily figures are retained for 7 days.",
];

const TOP_PAGES_LIMIT = 20;

function topPages(map: Record<string, number>): { path: string; views: number }[] {
  return Object.entries(map)
    .filter(([path]) => !PSEUDO_DAY_KEYS.has(path))
    .map(([path, views]) => ({ path, views }))
    .sort((a, b) => b.views - a.views)
    .slice(0, TOP_PAGES_LIMIT);
}

function periodFrom(map: Record<string, number>): PageViewPeriod {
  const total = Object.entries(map).reduce((sum, [k, v]) => (PSEUDO_DAY_KEYS.has(k) ? sum : sum + v), 0);
  const stored = map[DAY_TOTAL_KEY] ?? 0;
  const unclassified = Math.max(map[UNMATCHED_PAGE_KEY] ?? 0, stored - total);
  return {
    total,
    top_pages: topPages(map),
    partial: false,
    not_found: map[NOT_FOUND_KEY] ?? 0,
    redirects: map[REDIRECT_KEY] ?? 0,
    unclassified_legacy: Math.max(0, unclassified),
  };
}

function dayPeriod(map: Record<string, number> | undefined): PageViewPeriod {
  return periodFrom(map ?? {});
}

function allTimePeriod(map: Record<string, number>): PageViewPeriod {
  return periodFrom(map);
}

export async function getPageViews(): Promise<PageViewsReport> {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const storage = getTelemetryHealth();

  if (!useRedis()) {
    return {
      today: { total: pageViewsToday, top_pages: [], partial: false, not_found: notFoundSinceBoot, redirects: redirectsSinceBoot, unclassified_legacy: 0 },
      yesterday: { ...UNAVAILABLE_PERIOD },
      all_time: { ...UNAVAILABLE_PERIOD },
      referrers_today: {},
      all_time_trustworthy_from: null,
      notes: PAGE_VIEW_NOTES,
      available: false,
      error: "redis-not-configured",
      storage,
    };
  }

  if (!pageViewsLoaded) {
    return {
      today: { ...UNAVAILABLE_PERIOD },
      yesterday: { ...UNAVAILABLE_PERIOD },
      all_time: { ...UNAVAILABLE_PERIOD },
      referrers_today: {},
      all_time_trustworthy_from: null,
      notes: PAGE_VIEW_NOTES,
      available: false,
      error: redisHealth.lastReadError ?? "page-view snapshot not loaded",
      storage,
    };
  }

  const view = mergeSnapshot(pageViewSnapshot, pendingPageViews);

  return {
    today: dayPeriod(view.days[today]),
    yesterday: dayPeriod(view.days[yesterday]),
    all_time: allTimePeriod(view.all_time),
    referrers_today: { ...(view.referrers[today] ?? {}) },
    all_time_trustworthy_from: view.all_time_trustworthy_from || null,
    notes: PAGE_VIEW_NOTES,
    available: true,
    error: null,
    storage,
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

export interface TrafficWindow {
  days: number;
  from: string;
  to: string;
  detail_days: number;
  data_days_available: number;
  coverage: string;
  hits_total: number;
  hits_excluding_internal: number;
  by_class: Record<string, number>;
  ai_agent_by_family: Record<string, number>;
  top_routes_by_class: Record<string, { route: string; hits: number }[]>;
  not_found_total: number;
  not_found_by_class: Record<string, number>;
  redirect_total: number;
  redirects_by_class: Record<string, number>;
  pre_split_dates: string[];
}

export interface WebVsMcp {
  window_days: number;
  web_hits: number;
  ai_agent_hits: number;
  mcp_tool_calls: number;
  web_to_mcp_ratio: number | null;
  ai_agent_to_mcp_ratio: number | null;
}

export interface TrafficReport {
  today: TrafficWindow;
  last_7d: TrafficWindow;
  last_30d: TrafficWindow;
  web_vs_mcp: { today: WebVsMcp; last_7d: WebVsMcp; last_30d: WebVsMcp };
  available: boolean;
  error: string | null;
  since_boot_by_class: Record<string, number>;
  since_boot_not_found: number;
  since_boot_redirects: number;
  not_found_sample: NotFoundSample[];
  sessions: SessionSeries;
  notes: string[];
  storage: TelemetryHealth;
}

export interface SessionSeriesDay {
  date: string;
  sessions: number;
}

export interface SessionSeries {
  daily: SessionSeriesDay[];
  today: number;
  recording_since: string | null;
  all_time: number;
  retention_days: number;
}

const TOP_ROUTES_PER_CLASS = 10;

function datesInWindow(days: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    out.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  }
  return out;
}

function emptyWindow(days: number): TrafficWindow {
  const dates = datesInWindow(days);
  return {
    days,
    from: dates[dates.length - 1],
    to: dates[0],
    detail_days: Math.min(days, PAGE_VIEW_DAY_RETENTION),
    data_days_available: 0,
    coverage: coverageNote(days, 0),
    hits_total: 0,
    hits_excluding_internal: 0,
    by_class: {},
    ai_agent_by_family: {},
    top_routes_by_class: {},
    not_found_total: 0,
    not_found_by_class: {},
    redirect_total: 0,
    redirects_by_class: {},
    pre_split_dates: [],
  };
}

function earliestRecordedDate(view: PageViewSnapshot): string | null {
  let earliest: string | null = null;
  const dated = [view.classes, view.days, view.not_found, view.redirects, view.referrers];
  for (const map of dated) {
    for (const date of Object.keys(map)) {
      if (Object.keys(map[date] ?? {}).length === 0) continue;
      if (earliest === null || date < earliest) earliest = date;
    }
  }
  for (const date of Object.keys(view.mcp)) {
    if (earliest === null || date < earliest) earliest = date;
  }
  return earliest;
}

function coverageNote(days: number, available: number, earliest?: string | null): string {
  if (available >= days) return "complete";
  const since = earliest ? ` (earliest record ${earliest})` : "";
  return `partial — ${available} of ${days} day${days === 1 ? "" : "s"} of data available${since}`;
}

function daysBetweenInclusive(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 86400000) + 1;
}

function buildWindow(view: PageViewSnapshot, days: number): TrafficWindow {
  const dates = datesInWindow(days);
  const window = emptyWindow(days);
  const routeTotals: Record<string, Record<string, number>> = {};

  const earliest = earliestRecordedDate(view);
  window.data_days_available = earliest
    ? daysBetweenInclusive(earliest > window.from ? earliest : window.from, window.to)
    : 0;
  window.coverage = coverageNote(days, window.data_days_available, earliest);

  const split = view.outcome_split_from;
  if (split) {
    window.pre_split_dates = dates.filter(d => d <= split && view.classes[d]).sort();
    if (window.pre_split_dates.length > 0) {
      window.coverage +=
        `; hits_total still includes non-resolving requests on ${window.pre_split_dates.join(", ")}, ` +
        `recorded before the outcome split on ${split}`;
    }
  }

  for (const date of dates) {
    for (const [cls, count] of Object.entries(view.classes[date] ?? {})) {
      window.by_class[cls] = (window.by_class[cls] ?? 0) + count;
      window.hits_total += count;
      if (cls !== "internal") window.hits_excluding_internal += count;
    }
    for (const [cls, count] of Object.entries(view.not_found[date] ?? {})) {
      window.not_found_by_class[cls] = (window.not_found_by_class[cls] ?? 0) + count;
      window.not_found_total += count;
    }
    for (const [cls, count] of Object.entries(view.redirects[date] ?? {})) {
      window.redirects_by_class[cls] = (window.redirects_by_class[cls] ?? 0) + count;
      window.redirect_total += count;
    }
    for (const [family, count] of Object.entries(view.families[date] ?? {})) {
      window.ai_agent_by_family[family] = (window.ai_agent_by_family[family] ?? 0) + count;
    }
    for (const [key, count] of Object.entries(view.class_routes[date] ?? {})) {
      const sep = key.indexOf(CLASS_ROUTE_SEP);
      if (sep < 0) continue;
      const cls = key.slice(0, sep);
      const route = key.slice(sep + 1);
      const bucket = (routeTotals[cls] ??= {});
      bucket[route] = (bucket[route] ?? 0) + count;
    }
  }

  for (const cls of TRAFFIC_CLASSES) {
    window.by_class[cls] ??= 0;
    window.not_found_by_class[cls] ??= 0;
    window.redirects_by_class[cls] ??= 0;
  }

  for (const [cls, routes] of Object.entries(routeTotals)) {
    window.top_routes_by_class[cls] = Object.entries(routes)
      .map(([route, hits]) => ({ route, hits }))
      .sort((a, b) => b.hits - a.hits)
      .slice(0, TOP_ROUTES_PER_CLASS);
  }
  return window;
}

function ratio(a: number, b: number): number | null {
  if (b <= 0) return null;
  return Math.round((a / b) * 10) / 10;
}

function buildWebVsMcp(view: PageViewSnapshot, window: TrafficWindow, days: number): WebVsMcp {
  let mcpCalls = 0;
  for (const date of datesInWindow(days)) mcpCalls += view.mcp[date] ?? 0;
  const web = window.hits_excluding_internal;
  const ai = window.by_class["ai_agent"] ?? 0;
  return {
    window_days: days,
    web_hits: web,
    ai_agent_hits: ai,
    mcp_tool_calls: mcpCalls,
    web_to_mcp_ratio: ratio(web, mcpCalls),
    ai_agent_to_mcp_ratio: ratio(ai, mcpCalls),
  };
}

const TRAFFIC_NOTES = [
  "`internal` covers requests to observability endpoints (/api/pageviews, /api/query-log, /api/traffic, /api/metrics, /health) plus anything carrying an agentdeals-internal user agent. Excluded from hits_excluding_internal and from web_vs_mcp.",
  "A maintainer running a bare `curl` against a normal page is indistinguishable from any other scripted client and is counted as `sdk_client`, not `internal`. It can therefore inflate web_hits but never ai_agent_hits.",
  "`sdk_client` is deliberately not folded into `ai_agent`: undici/python-httpx traffic may be an agent or a scraper, and overclaiming it would make the headline number unquotable.",
  "These counters store only the class and a bounded family label from a fixed table: the user agent and the address a request arrived with are read to derive them and are not persisted into these counters. That is a statement about this endpoint, not about the site — /api/query-log persists and publishes the user agent string itself, and /privacy is the document that describes the whole service.",
  "Attribution starts from the deploy that introduced it — windows longer than that are short by however much history predates it, not wrong.",
  "Class totals are retained for 30 days; the per-family and per-route breakdowns only for 7. Each window states its own detail_days rather than presenting 7 days of detail as 30.",
  "hits_total, hits_excluding_internal, by_class and top_routes_by_class count requests we answered with content (2xx). Requests that did not resolve are in not_found_*, and 3xx answers are in redirect_* — a client that only ever 404s is not a client that read our pages (#1029).",
  "not_found carries no route breakdown: an unmatched path has no route by definition. not_found_sample carries the actual paths, sanitized and truncated, for the last 50.",
  "Each window states data_days_available alongside days. Where they differ the window is arithmetically correct and shorter than its label — read coverage before quoting it.",
  "sessions.daily counts MCP sessions opened per UTC day and survives a deploy. It starts at sessions.recording_since; there is no measurement before that date, so a chart must start the line there rather than draw zero. sessions.all_time predates the series and cannot be split across dates.",
];

export function getTrafficReport(): TrafficReport {
  const storage = getTelemetryHealth();
  const since_boot_by_class: Record<string, number> = {};
  for (const cls of TRAFFIC_CLASSES) since_boot_by_class[cls] = trafficSinceBoot[cls] ?? 0;

  const unavailable = (error: string): TrafficReport => ({
    today: emptyWindow(1),
    last_7d: emptyWindow(7),
    last_30d: emptyWindow(30),
    web_vs_mcp: {
      today: buildWebVsMcp(emptySnapshot(), emptyWindow(1), 1),
      last_7d: buildWebVsMcp(emptySnapshot(), emptyWindow(7), 7),
      last_30d: buildWebVsMcp(emptySnapshot(), emptyWindow(30), 30),
    },
    available: false,
    error,
    since_boot_by_class,
    since_boot_not_found: notFoundSinceBoot,
    since_boot_redirects: redirectsSinceBoot,
    not_found_sample: [...pendingPageViews.not_found_sample].reverse(),
    sessions: getSessionSeries(),
    notes: TRAFFIC_NOTES,
    storage,
  });

  if (!useRedis()) return unavailable("redis-not-configured");
  if (!pageViewsLoaded) {
    return unavailable(redisHealth.lastReadError ?? "page-view snapshot not loaded");
  }

  const view = mergeSnapshot(pageViewSnapshot, pendingPageViews);
  const today = buildWindow(view, 1);
  const last7 = buildWindow(view, 7);
  const last30 = buildWindow(view, 30);
  return {
    today,
    last_7d: last7,
    last_30d: last30,
    web_vs_mcp: {
      today: buildWebVsMcp(view, today, 1),
      last_7d: buildWebVsMcp(view, last7, 7),
      last_30d: buildWebVsMcp(view, last30, 30),
    },
    available: true,
    error: null,
    since_boot_by_class,
    since_boot_not_found: notFoundSinceBoot,
    since_boot_redirects: redirectsSinceBoot,
    not_found_sample: [...view.not_found_sample].reverse(),
    sessions: getSessionSeries(),
    notes: TRAFFIC_NOTES,
    storage,
  };
}

export const SIGNAL_EVENTS = ["recommended", "converted"] as const;
export type SignalEvent = (typeof SIGNAL_EVENTS)[number];
export const SIGNAL_TRANSPORTS = ["post", "get"] as const;
export type SignalTransport = (typeof SIGNAL_TRANSPORTS)[number];

export const SIGNAL_UNRECOGNIZED_EVENT = "__unrecognized__";
const SIGNAL_TOTAL_KEY = "total";

const SIGNAL_SEP = ":";
const SIGNAL_FACETS = {
  vendor: "v",
  unresolved: "u",
  agent: "a",
  rawEvent: "x",
  source: "s",
  event: "e",
  transport: "t",
  clientClass: "c",
} as const;
const MAX_SIGNAL_KEYS_PER_FACET_PER_DAY = 100;
const MAX_SIGNAL_ALL_TIME_KEYS_PER_FACET = 300;
const SIGNAL_OVERFLOW = "__other__";

function buildFixedSignalKeys(): Set<string> {
  const keys = new Set<string>([SIGNAL_TOTAL_KEY]);
  for (const e of [...SIGNAL_EVENTS, SIGNAL_UNRECOGNIZED_EVENT]) keys.add(`${SIGNAL_FACETS.event}${SIGNAL_SEP}${e}`);
  for (const t of SIGNAL_TRANSPORTS) keys.add(`${SIGNAL_FACETS.transport}${SIGNAL_SEP}${t}`);
  for (const c of TRAFFIC_CLASSES) keys.add(`${SIGNAL_FACETS.clientClass}${SIGNAL_SEP}${c}`);
  return keys;
}
const FIXED_SIGNAL_KEYS = buildFixedSignalKeys();

function signalOverflowKey(key: string): string {
  const facet = key.slice(0, key.indexOf(SIGNAL_SEP));
  return `${facet}${SIGNAL_SEP}${SIGNAL_OVERFLOW}`;
}

function facetSize(map: Record<string, number>, prefix: string): number {
  let n = 0;
  for (const k of Object.keys(map)) if (k.startsWith(prefix)) n++;
  return n;
}

function bumpSignalKey(
  map: Record<string, number>,
  key: string,
  delta: number,
  cap: number,
  known?: Record<string, number>,
): void {
  if (FIXED_SIGNAL_KEYS.has(key)) {
    bump(map, key, delta);
    return;
  }
  const prefix = key.slice(0, key.indexOf(SIGNAL_SEP) + 1);
  const overflow = signalOverflowKey(key);
  if (key !== overflow && !(key in map) && !(known && key in known)) {
    const size = facetSize(map, prefix) + (known ? facetSize(known, prefix) : 0);
    if (size >= cap) key = overflow;
  }
  bump(map, key, delta);
}

export interface SignalRecord {
  event: string;
  vendor: string | null;
  unresolved: string | null;
  agent: string | null;
  source: string | null;
  note: string | null;
  note_redacted?: boolean;
  transport: SignalTransport;
  client_class: string;
}

export interface SignalNote {
  ts: string;
  event: string;
  vendor: string | null;
  note: string;
  redacted: boolean;
}
const SIGNAL_NOTE_MAX = 50;
const SIGNAL_NOTE_TEXT_MAX = 200;

let signalsSinceBoot = 0;

export function recordSignal(rec: SignalRecord): void {
  signalsSinceBoot++;
  if (!useRedis()) return;
  const today = new Date().toISOString().slice(0, 10);
  const day = (pendingPageViews.signals[today] ??= {});
  const knownDay = pageViewSnapshot.signals[today];
  const all = pendingPageViews.signals_all_time;
  const knownAll = pageViewSnapshot.signals_all_time;
  if (!pendingPageViews.signals_from && !pageViewSnapshot.signals_from) {
    pendingPageViews.signals_from = today;
  }

  const recognized = (SIGNAL_EVENTS as readonly string[]).includes(rec.event);
  const eventKey = recognized ? rec.event : SIGNAL_UNRECOGNIZED_EVENT;
  const cls = (TRAFFIC_CLASSES as readonly string[]).includes(rec.client_class)
    ? rec.client_class
    : "unknown";

  const fixed = [
    SIGNAL_TOTAL_KEY,
    `${SIGNAL_FACETS.event}${SIGNAL_SEP}${eventKey}`,
    `${SIGNAL_FACETS.transport}${SIGNAL_SEP}${rec.transport}`,
    `${SIGNAL_FACETS.clientClass}${SIGNAL_SEP}${cls}`,
  ];
  const bounded: string[] = [];
  if (rec.vendor) bounded.push(`${SIGNAL_FACETS.vendor}${SIGNAL_SEP}${eventKey}${SIGNAL_SEP}${rec.vendor}`);
  if (rec.unresolved) bounded.push(`${SIGNAL_FACETS.unresolved}${SIGNAL_SEP}${rec.unresolved}`);
  if (rec.agent) bounded.push(`${SIGNAL_FACETS.agent}${SIGNAL_SEP}${rec.agent}`);
  if (rec.source) bounded.push(`${SIGNAL_FACETS.source}${SIGNAL_SEP}${rec.source}`);
  if (!recognized) bounded.push(`${SIGNAL_FACETS.rawEvent}${SIGNAL_SEP}${rec.event}`);

  for (const key of fixed) {
    bump(day, key, 1);
    bump(all, key, 1);
  }
  for (const key of bounded) {
    bumpSignalKey(day, key, 1, MAX_SIGNAL_KEYS_PER_FACET_PER_DAY, knownDay);
    bumpSignalKey(all, key, 1, MAX_SIGNAL_ALL_TIME_KEYS_PER_FACET, knownAll);
  }

  if (rec.note) {
    pendingPageViews.signal_notes.push({
      ts: new Date().toISOString(),
      event: eventKey,
      vendor: rec.vendor,
      note: rec.note.slice(0, SIGNAL_NOTE_TEXT_MAX),
      redacted: rec.note_redacted === true,
    });
    if (pendingPageViews.signal_notes.length > SIGNAL_NOTE_MAX) {
      pendingPageViews.signal_notes.splice(0, pendingPageViews.signal_notes.length - SIGNAL_NOTE_MAX);
    }
  }
}

export const SIGNAL_DENOMINATOR_ROUTES = [
  "/vendor/:slug",
  "/alternative-to/:slug",
  "/compare/:slug",
  "/best/:slug",
  "/category/:slug",
] as const;

export const SIGNAL_MIN_SAMPLE = 1000;

export interface SignalWindow {
  days: number;
  from: string;
  to: string;
  total: number;
  by_event: Record<string, number>;
  by_transport: Record<string, number>;
  by_client_class: Record<string, number>;
  distinct_vendors: number;
  unresolved_vendor_names: { name: string; count: number }[];
  unrecognized_events: { event: string; count: number }[];
  by_reporting_agent: { agent: string; count: number }[];
  by_source: { source: string; count: number }[];
  qualifying_fetches: number;
  qualifying_fetches_sdk_client: number;
  denominator_days_available: number;
  report_rate: number | null;
  rate_note: string;
}

const SIGNAL_LIST_LIMIT = 20;

function emptySignalWindow(days: number): SignalWindow {
  const dates = datesInWindow(days);
  return {
    days,
    from: dates[dates.length - 1] ?? "",
    to: dates[0] ?? "",
    total: 0,
    by_event: {},
    by_transport: {},
    by_client_class: {},
    distinct_vendors: 0,
    unresolved_vendor_names: [],
    unrecognized_events: [],
    by_reporting_agent: [],
    by_source: [],
    qualifying_fetches: 0,
    qualifying_fetches_sdk_client: 0,
    denominator_days_available: 0,
    report_rate: null,
    rate_note: "",
  };
}

function rankFacet(map: Record<string, number>, prefix: string): { key: string; count: number }[] {
  return Object.entries(map)
    .filter(([k]) => k.startsWith(prefix))
    .map(([k, count]) => ({ key: k.slice(prefix.length), count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, SIGNAL_LIST_LIMIT);
}

function foldSignals(map: Record<string, number>, window: SignalWindow): void {
  const vendors = new Set<string>();
  for (const [key, count] of Object.entries(map)) {
    if (key === SIGNAL_TOTAL_KEY) {
      window.total += count;
      continue;
    }
    const sep = key.indexOf(SIGNAL_SEP);
    if (sep < 0) continue;
    const facet = key.slice(0, sep);
    const rest = key.slice(sep + 1);
    if (facet === SIGNAL_FACETS.event) window.by_event[rest] = (window.by_event[rest] ?? 0) + count;
    else if (facet === SIGNAL_FACETS.transport) window.by_transport[rest] = (window.by_transport[rest] ?? 0) + count;
    else if (facet === SIGNAL_FACETS.clientClass) window.by_client_class[rest] = (window.by_client_class[rest] ?? 0) + count;
    else if (facet === SIGNAL_FACETS.vendor && rest !== SIGNAL_OVERFLOW) {
      const slugAt = rest.indexOf(SIGNAL_SEP);
      if (slugAt >= 0) vendors.add(rest.slice(slugAt + 1));
    }
  }
  window.distinct_vendors = vendors.size;
  window.unresolved_vendor_names = rankFacet(map, `${SIGNAL_FACETS.unresolved}${SIGNAL_SEP}`)
    .map(e => ({ name: e.key, count: e.count }));
  window.unrecognized_events = rankFacet(map, `${SIGNAL_FACETS.rawEvent}${SIGNAL_SEP}`)
    .map(e => ({ event: e.key, count: e.count }));
  window.by_reporting_agent = rankFacet(map, `${SIGNAL_FACETS.agent}${SIGNAL_SEP}`)
    .map(e => ({ agent: e.key, count: e.count }));
  window.by_source = rankFacet(map, `${SIGNAL_FACETS.source}${SIGNAL_SEP}`)
    .map(e => ({ source: e.key, count: e.count }));
  for (const t of SIGNAL_TRANSPORTS) window.by_transport[t] ??= 0;
  for (const e of SIGNAL_EVENTS) window.by_event[e] ??= 0;
}

function qualifyingFetches(view: PageViewSnapshot, dates: string[], cls: string): number {
  let total = 0;
  for (const date of dates) {
    const map = view.class_routes[date] ?? {};
    for (const route of SIGNAL_DENOMINATOR_ROUTES) {
      total += map[`${cls}${CLASS_ROUTE_SEP}${route}`] ?? 0;
    }
  }
  return total;
}

function applyRate(window: SignalWindow): void {
  if (window.days > 0 && window.denominator_days_available < window.days) {
    window.report_rate = null;
    window.rate_note =
      `denominator covers ${window.denominator_days_available} of ${window.days} days: the ` +
      `class-by-route counters this divides by are retained for ${PAGE_VIEW_DAY_RETENTION} days ` +
      `while signals are kept for ${CLASS_DAY_RETENTION}, so a rate over this window would divide ` +
      `a longer numerator by a shorter denominator. Both counts above are exact for their own spans.`;
    return;
  }
  if (window.qualifying_fetches < SIGNAL_MIN_SAMPLE) {
    window.report_rate = null;
    window.rate_note =
      `below minimum sample: a rate is not computed under ${SIGNAL_MIN_SAMPLE} qualifying fetches ` +
      `(${window.qualifying_fetches} in this window). The counts above are exact.`;
    return;
  }
  window.report_rate = Math.round((window.total / window.qualifying_fetches) * 10000) / 10000;
  window.rate_note =
    `${window.total} signals from ${window.qualifying_fetches} ai_agent fetches of decision pages. ` +
    `Self-reported by the sender and unverified.`;
}

function buildSignalWindow(view: PageViewSnapshot, days: number): SignalWindow {
  const window = emptySignalWindow(days);
  const dates = datesInWindow(days);
  const merged: Record<string, number> = {};
  for (const date of dates) {
    for (const [key, count] of Object.entries(view.signals[date] ?? {})) bump(merged, key, count);
  }
  foldSignals(merged, window);
  window.qualifying_fetches = qualifyingFetches(view, dates, "ai_agent");
  window.qualifying_fetches_sdk_client = qualifyingFetches(view, dates, "sdk_client");
  window.denominator_days_available = dates.filter(d => view.class_routes[d]).length;
  applyRate(window);
  return window;
}

function buildSignalAllTime(view: PageViewSnapshot): SignalWindow {
  const window = emptySignalWindow(0);
  window.from = view.signals_from || "";
  window.to = new Date().toISOString().slice(0, 10);
  foldSignals(view.signals_all_time, window);
  window.qualifying_fetches = 0;
  window.qualifying_fetches_sdk_client = 0;
  window.denominator_days_available = 0;
  window.report_rate = null;
  window.rate_note =
    "no all-time denominator: the class-by-route counters are retained for 30 days, so a " +
    "qualifying-fetch count over all time does not exist. Read the 7d and 30d windows for rates.";
  return window;
}

export const SIGNAL_NOTES = [
  "Self-reported and unverified. Anyone can POST to /api/signal without authenticating, so every count here is a claim by its sender, not an observation of ours.",
  "Signal counts never feed ranking, sorting or ordering on any surface. That is asserted by a test, not just stated here — see /criteria.",
  "post and get are reported separately and are never summed into a headline. The GET form exists for agents that cannot POST, requires ?ack=1, and is never published as a fireable URL — so the two populations are not comparable.",
  "recommended and converted are two independent counters, never a funnel. Agents rarely observe whether their user signed up, so converted undercounts by an unknown factor and is not a conversion rate.",
  "Per-vendor counts are recorded and are not published. A visible per-vendor counter would be a placement metric a vendor could acquire by firing it themselves.",
  "The sender's client class, the self-identifier it chose, the surface it names as its source, the vendor names we do not index and the event strings we do not recognise are all recorded and none of them is published.",
  "Our own traffic to the pages where a recommendation gets made is recorded and is not published, so no report rate is published either. It is our measurement of who reads us, and it is not a fact about any vendor.",
  "This call records the vendor slug, the event, an optional name the caller chooses for itself, and the sender's client class. Nothing about the caller's user, no IP, no identity.",
];

export interface SignalReport {
  today: SignalWindow;
  last_7d: SignalWindow;
  last_30d: SignalWindow;
  all_time: SignalWindow;
  durable: boolean;
  durable_rollup: DurableRollupCoverage | null;
  recording_since: string | null;
  since_boot: number;
  notes: string[];
  storage: TelemetryHealth;
}

export function getSignalReport(): SignalReport {
  const view = mergeSnapshot(pageViewSnapshot, pendingPageViews);
  return {
    today: buildSignalWindow(view, 1),
    last_7d: buildSignalWindow(view, 7),
    last_30d: buildSignalWindow(view, 30),
    all_time: buildSignalAllTime(view),
    durable: useRedis() && pageViewsLoaded,
    durable_rollup: getDurableRollupCoverage(),
    recording_since: view.signals_from || null,
    since_boot: signalsSinceBoot,
    notes: SIGNAL_NOTES,
    storage: getTelemetryHealth(),
  };
}

export const SIGNAL_WITHHELD_WINDOW_FIELDS = [
  "qualifying_fetches",
  "qualifying_fetches_sdk_client",
  "report_rate",
  "rate_note",
  "denominator_days_available",
  "by_reporting_agent",
  "by_source",
  "by_client_class",
  "unresolved_vendor_names",
  "unrecognized_events",
] as const;

export type PublicSignalWindow = Omit<SignalWindow, (typeof SIGNAL_WITHHELD_WINDOW_FIELDS)[number]>;
export type PublicSignalReport = Omit<SignalReport, "today" | "last_7d" | "last_30d" | "all_time"> & {
  today: PublicSignalWindow;
  last_7d: PublicSignalWindow;
  last_30d: PublicSignalWindow;
  all_time: PublicSignalWindow;
};

function publicSignalWindow(window: SignalWindow): PublicSignalWindow {
  const out: Record<string, unknown> = { ...window };
  for (const field of SIGNAL_WITHHELD_WINDOW_FIELDS) delete out[field];
  return out as PublicSignalWindow;
}

export function publicSignalReport(report: SignalReport): PublicSignalReport {
  return {
    ...report,
    today: publicSignalWindow(report.today),
    last_7d: publicSignalWindow(report.last_7d),
    last_30d: publicSignalWindow(report.last_30d),
    all_time: publicSignalWindow(report.all_time),
  };
}

export function getSignalVendorBreakdown(): { event: string; vendor: string; count: number }[] {
  const view = mergeSnapshot(pageViewSnapshot, pendingPageViews);
  const out: { event: string; vendor: string; count: number }[] = [];
  const prefix = `${SIGNAL_FACETS.vendor}${SIGNAL_SEP}`;
  for (const [key, count] of Object.entries(view.signals_all_time)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const sep = rest.indexOf(SIGNAL_SEP);
    if (sep < 0) continue;
    out.push({ event: rest.slice(0, sep), vendor: rest.slice(sep + 1), count });
  }
  return out.sort((a, b) => b.count - a.count || a.vendor.localeCompare(b.vendor));
}

export function getSignalNotes(): SignalNote[] {
  const view = mergeSnapshot(pageViewSnapshot, pendingPageViews);
  return [...view.signal_notes].reverse();
}

export interface RollupSignalFacets {
  total: number;
  by_event: Record<string, number>;
  by_transport: Record<string, number>;
  by_client_class: Record<string, number>;
  by_source: Record<string, number>;
  by_reporting_agent: Record<string, number>;
  by_vendor: Record<string, number>;
  unresolved_vendor_names: Record<string, number>;
  unrecognized_events: Record<string, number>;
}

export interface RollupDayPageViews {
  served: number;
  not_found: number;
  redirects: number;
  unclassified_legacy: number;
  by_route: Record<string, number>;
}

export interface RollupDaySource {
  date: string;
  page_views: RollupDayPageViews;
  referrers: Record<string, number>;
  classes: Record<string, number>;
  class_routes: Record<string, number>;
  families: Record<string, number>;
  mcp_tool_calls: number;
  not_found: Record<string, number>;
  redirects: Record<string, number>;
  signals: RollupSignalFacets;
  available: boolean;
  reason: string | null;
}

function emptySignalFacets(): RollupSignalFacets {
  return {
    total: 0,
    by_event: {},
    by_transport: {},
    by_client_class: {},
    by_source: {},
    by_reporting_agent: {},
    by_vendor: {},
    unresolved_vendor_names: {},
    unrecognized_events: {},
  };
}

export function splitSignalKeys(map: Record<string, number>): RollupSignalFacets {
  const out = emptySignalFacets();
  const target: Record<string, Record<string, number>> = {
    [SIGNAL_FACETS.event]: out.by_event,
    [SIGNAL_FACETS.transport]: out.by_transport,
    [SIGNAL_FACETS.clientClass]: out.by_client_class,
    [SIGNAL_FACETS.source]: out.by_source,
    [SIGNAL_FACETS.agent]: out.by_reporting_agent,
    [SIGNAL_FACETS.vendor]: out.by_vendor,
    [SIGNAL_FACETS.unresolved]: out.unresolved_vendor_names,
    [SIGNAL_FACETS.rawEvent]: out.unrecognized_events,
  };
  for (const [key, count] of Object.entries(map)) {
    if (key === SIGNAL_TOTAL_KEY) {
      out.total += count;
      continue;
    }
    const sep = key.indexOf(SIGNAL_SEP);
    if (sep < 0) continue;
    const bucket = target[key.slice(0, sep)];
    if (!bucket) continue;
    const rest = key.slice(sep + 1);
    bucket[rest] = (bucket[rest] ?? 0) + count;
  }
  return out;
}

export function splitDayPageViews(map: Record<string, number>): RollupDayPageViews {
  const period = periodFrom(map);
  const by_route: Record<string, number> = {};
  for (const [key, count] of Object.entries(map)) {
    if (!PSEUDO_DAY_KEYS.has(key)) by_route[key] = count;
  }
  return {
    served: period.total ?? 0,
    not_found: period.not_found,
    redirects: period.redirects,
    unclassified_legacy: period.unclassified_legacy,
    by_route,
  };
}

export function getRollupDaySource(date: string): RollupDaySource {
  const empty = {
    date,
    page_views: splitDayPageViews({}),
    referrers: {},
    classes: {},
    class_routes: {},
    families: {},
    mcp_tool_calls: 0,
    not_found: {},
    redirects: {},
    signals: emptySignalFacets(),
  };
  if (!useRedis()) return { ...empty, available: false, reason: "redis-not-configured" };
  if (!pageViewsLoaded) {
    return {
      ...empty,
      available: false,
      reason: redisHealth.lastReadError ?? "page-view snapshot not loaded",
    };
  }
  const view = mergeSnapshot(pageViewSnapshot, pendingPageViews);
  return {
    date,
    page_views: splitDayPageViews(view.days[date] ?? {}),
    referrers: { ...(view.referrers[date] ?? {}) },
    classes: { ...(view.classes[date] ?? {}) },
    class_routes: { ...(view.class_routes[date] ?? {}) },
    families: { ...(view.families[date] ?? {}) },
    mcp_tool_calls: view.mcp[date] ?? 0,
    not_found: { ...(view.not_found[date] ?? {}) },
    redirects: { ...(view.redirects[date] ?? {}) },
    signals: splitSignalKeys(view.signals[date] ?? {}),
    available: true,
    reason: null,
  };
}

export function getRollupDatesAvailable(): string[] {
  if (!useRedis() || !pageViewsLoaded) return [];
  const view = mergeSnapshot(pageViewSnapshot, pendingPageViews);
  const dates = new Set<string>();
  for (const field of ["days", "referrers", "classes", "class_routes", "families", "not_found", "redirects", "signals"] as const) {
    for (const date of Object.keys(view[field])) dates.add(date);
  }
  for (const date of Object.keys(view.mcp)) dates.add(date);
  return [...dates].sort();
}

export interface DurableRollupCoverage {
  first_date: string | null;
  last_date: string | null;
  last_complete_date: string | null;
  days: number;
  path: string;
}

let durableRollupCoverage: DurableRollupCoverage | null = null;

export function setDurableRollupCoverage(coverage: DurableRollupCoverage | null): void {
  durableRollupCoverage = coverage;
}

export function getDurableRollupCoverage(): DurableRollupCoverage | null {
  return durableRollupCoverage;
}

export interface SearchQueryContext {
  category?: string;
  userAgent?: string;
  source?: SearchSource;
  unfilteredCount?: number;
  filtered?: boolean;
}

export function recordSearchQuery(
  query: string | undefined,
  resultCount: number,
  context: SearchQueryContext = {},
): void {
  if (!query) return;
  if (context.userAgent && isBot(context.userAgent)) return;
  const normalized = query.trim().toLowerCase();
  if (!normalized) return;
  const filtered = context.filtered ?? false;
  const entry: SearchQueryEntry = {
    query: normalized,
    timestamp: new Date().toISOString(),
    results_count: resultCount,
    unfiltered_count: filtered ? (context.unfilteredCount ?? resultCount) : resultCount,
  };
  if (filtered) entry.filtered = true;
  if (context.category) entry.category = context.category;
  if (context.source) entry.source = context.source;
  searchQueryLog.push(entry);
  if (searchQueryLog.length > SEARCH_QUERY_RING_MAX) {
    searchQueryLog.splice(0, searchQueryLog.length - SEARCH_QUERY_RING_MAX);
  }
}

function rank(counts: Map<string, number>, limit: number): { query: string; count: number }[] {
  return [...counts.entries()]
    .map(([query, count]) => ({ query, count }))
    .sort((a, b) => b.count - a.count || a.query.localeCompare(b.query))
    .slice(0, limit);
}

function catalogMatchCount(entry: SearchQueryEntry): number {
  return entry.unfiltered_count ?? entry.results_count;
}

export interface SearchWindowCoverage {
  days: number;
  data_days_available: number;
  coverage: string;
  entries: number;
  oldest_entry: string | null;
  ring_saturated: boolean;
}

export function getSearchAnalytics(): {
  top_queries_7d: { query: string; count: number }[];
  zero_result_queries_7d: { query: string; count: number }[];
  filtered_to_zero_queries_7d: { query: string; count: number }[];
  queries_by_source_7d: Record<string, number>;
  queries_by_category_7d: Record<string, number>;
  window_7d: SearchWindowCoverage;
} {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = searchQueryLog.filter(e => {
    const t = new Date(e.timestamp).getTime();
    return Number.isFinite(t) && t >= sevenDaysAgo;
  });

  const timestamps = recent
    .map(e => new Date(e.timestamp).getTime())
    .filter(t => Number.isFinite(t));
  const oldest = timestamps.length > 0 ? Math.min(...timestamps) : null;
  const spanDays = oldest === null ? 0 : Math.min(7, Math.ceil((Date.now() - oldest) / 86400000)) || 1;
  const window_7d: SearchWindowCoverage = {
    days: 7,
    data_days_available: spanDays,
    coverage: coverageNote(
      7,
      spanDays,
      oldest === null ? null : new Date(oldest).toISOString().slice(0, 10),
    ),
    entries: recent.length,
    oldest_entry: oldest === null ? null : new Date(oldest).toISOString(),
    ring_saturated: searchQueryLog.length >= SEARCH_QUERY_RING_MAX,
  };

  const queryCounts = new Map<string, number>();
  const zeroResultCounts = new Map<string, number>();
  const filteredToZeroCounts = new Map<string, number>();
  const sourceCounts: Record<string, number> = {};
  const categoryCounts: Record<string, number> = {};

  for (const e of recent) {
    queryCounts.set(e.query, (queryCounts.get(e.query) ?? 0) + 1);

    if (catalogMatchCount(e) === 0) {
      zeroResultCounts.set(e.query, (zeroResultCounts.get(e.query) ?? 0) + 1);
    } else if (e.results_count === 0) {
      filteredToZeroCounts.set(e.query, (filteredToZeroCounts.get(e.query) ?? 0) + 1);
    }

    const source = e.source ?? "unknown";
    sourceCounts[source] = (sourceCounts[source] ?? 0) + 1;

    if (e.category) categoryCounts[e.category] = (categoryCounts[e.category] ?? 0) + 1;
  }

  return {
    top_queries_7d: rank(queryCounts, 20),
    zero_result_queries_7d: rank(zeroResultCounts, 10),
    filtered_to_zero_queries_7d: rank(filteredToZeroCounts, 10),
    queries_by_source_7d: sourceCounts,
    queries_by_category_7d: categoryCounts,
    window_7d,
  };
}

export function getApiHitsByEndpoint(): Record<string, number> {
  const merged: Record<string, number> = { ...cumulative.api_hits_by_endpoint };
  for (const [endpoint, count] of Object.entries(apiHits)) {
    merged[endpoint] = (merged[endpoint] ?? 0) + count;
  }
  return merged;
}

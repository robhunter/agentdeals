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
  register_agent: 0,
  get_referral_code: 0,
  check_balance: 0,
  request_payout: 0,
};

// Per-client tool-call counts for the current deployment. Client IDs come from MCP initialize
// clientInfo.name; missing/empty names bucket to "unknown". Cardinality bounded by distinct MCP
// client populations seen in practice (<200 in production).
const toolCallsByClient: Record<string, number> = {};

// Per-tool tool-call counts for the current deployment. Keys are MCP tool names that appear in
// the `toolCalls` gate above. Cardinality bounded by the tool list itself.
const toolCallsByName: Record<string, number> = {};

// Per-endpoint hit counts for the current deployment. Accumulates dynamically — any endpoint passed
// to recordApiHit is counted. Cardinality is bounded by route definitions (~150 endpoints).
const apiHits: Record<string, number> = {};

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
  tool_calls_by_client: {} as Record<string, number>,
  tool_calls_by_name: {} as Record<string, number>,
  referral_listing_calls: 0,
  referral_listing_by_source: { platform: 0, agent: 0, null: 0 } as Record<"platform" | "agent" | "null", number>,
  referral_vendor_lookups: 0,
  referral_vendor_counts: {} as Record<string, number>,
  api_hits_by_endpoint: {} as Record<string, number>,
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

/** Where a recorded search came from. Automated MCP traffic and human web traffic are
 *  very different signals for catalog decisions, and only `source` can tell them apart. */
export type SearchSource = "web" | "api" | "mcp";

export interface SearchQueryEntry {
  query: string;
  category?: string;
  /** What the caller actually got back, after their own filters. */
  results_count: number;
  /**
   * What the query alone matches against the whole catalog, ignoring category,
   * eligibility, stability and payment-protocol filters. This — not `results_count` —
   * is the catalog-coverage signal: a search filtered down to nothing is not a gap in
   * what we cover (#1018 Defect C). Absent on entries recorded before this shipped.
   */
  unfiltered_count?: number;
  /** True when the caller supplied any filter beyond the query itself. */
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

// --- Upstash REST command layer ---
// Every Redis helper funnels through redisCommand() so that failures are (a) recorded
// and (b) distinguishable from legitimately-empty results.
//
// This is the defect that let a write outage run silently for 17 days (#1018): each
// helper had its own try/catch returning false/[]/null, and none of them ever looked at
// the `error` field Upstash returns in a 200 response body. An errored SCAN and an empty
// keyspace were indistinguishable; a rejected INCR was indistinguishable from a
// successful one. Root cause could not be read off the symptoms because the only
// component that ever saw the error message threw it away.

type RedisResult<T> = { ok: true; result: T } | { ok: false; error: string };

// Commands that mutate state. Used to attribute a failure to the read or the write path,
// which is the distinction that matters when diagnosing an outage.
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

// --- Command budget accounting (#1023) ---
// Upstash bills per command, not per HTTP request, and the plan ceiling is a hard stop:
// past it every command is rejected. The 2026-08-07 outage was this ceiling being reached,
// so the number of commands we spend is itself a thing that has to be measured.
const DEFAULT_MONTHLY_COMMAND_BUDGET = 300_000;
const MONTHLY_COMMAND_BUDGET =
  Number(process.env.TELEMETRY_COMMAND_BUDGET) > 0
    ? Number(process.env.TELEMETRY_COMMAND_BUDGET)
    : DEFAULT_MONTHLY_COMMAND_BUDGET;

// Projecting a daily rate from a few seconds of uptime produces nonsense. Divide by at
// least this much elapsed time so a freshly-booted process under-reports rather than
// reporting a wild extrapolation.
const RATE_ESTIMATE_FLOOR_SECONDS = 300;

let commandsIssued = 0;

// Upstash's phrasing for a spent quota has varied ("max requests limit exceeded",
// "max daily request limit exceeded"). Matching it lets the endpoint say *which* failure
// mode we are in, which is the difference between "upgrade the plan" and "fix the code".
const QUOTA_ERROR_PATTERN = /max (?:requests|daily request|commands?)\s+limit exceeded|quota/i;

function isQuotaError(error: string | null): boolean {
  return typeof error === "string" && QUOTA_ERROR_PATTERN.test(error);
}

// Throttle stderr so a hard outage can't turn into a log flood (one line per command
// class per minute is enough to see the actual Upstash error in the platform logs).
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
  // Counted on attempt, not on success: a command rejected for quota has already been
  // charged against the quota, so counting only successes would under-report the spend
  // exactly when it matters most.
  commandsIssued++;
  const url = process.env.UPSTASH_REDIS_REST_URL!;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    });
    // Upstash reports command-level errors in the body with HTTP 200 (quota exhaustion,
    // max-data-size, WRONGTYPE, ...), so the status code alone is not sufficient.
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

// Storage-layer health, surfaced on /api/pageviews and /api/query-log so a future stall
// is visible without forensics (#1018).
export interface TelemetryHealth {
  configured: boolean;
  last_write_at: string | null;
  last_write_error: string | null;
  last_write_error_at: string | null;
  last_read_error: string | null;
  last_read_error_at: string | null;
  write_failures: number;
  read_failures: number;
  /** True when the last write failure was the plan's command ceiling rather than a bug. */
  quota_exhausted: boolean;
  /** What this process has actually spent, and what that projects to (#1023). */
  commands_since_boot: number;
  uptime_seconds: number;
  estimated_commands_per_day: number;
  estimated_commands_per_month: number;
  monthly_command_budget: number;
  over_budget: boolean;
  /** Work sitting in memory waiting for the next flush. */
  pending_page_view_keys: number;
  pending_request_log_entries: number;
  /** Request-log entries dropped because a single interval overflowed the batch cap. */
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

// At most this many entries go out in one flush. A single variadic LPUSH is one command
// regardless of how many values it carries, so the cap exists to bound the request body,
// not the command count. Overflow is counted and surfaced rather than dropped silently.
const REQUEST_LOG_FLUSH_MAX = 250;

// Let the stored list run this far past its cap before spending a command to trim it.
const REQUEST_LOG_TRIM_THRESHOLD = Math.floor(REQUEST_LOG_MAX * 1.2);

// Newest-first mirror of the stored list: hydrated once at boot, then kept in step with
// everything this process pushes. Reads are served from here, so /api/query-log costs
// zero Redis commands no matter how often it is polled (#1023).
let requestLogMirror: RequestLogEntry[] = [];
let requestLogPending: RequestLogEntry[] = [];
let requestLogDropped = 0;
let requestLogHydrated = false;

async function redisLrange(key: string, start: number, stop: number): Promise<RedisResult<string[]>> {
  const res = await redisCommand<string[]>(["LRANGE", key, start, stop]);
  if (!res.ok) return res;
  if (res.result === null || res.result === undefined) return { ok: true, result: [] };
  // A non-array here means the key is not a list (or the response is not what we asked
  // for). Report it as a read failure rather than letting an unexpected shape throw its
  // way out of the boot path — same reasoning as the MGET length check.
  if (!Array.isArray(res.result)) {
    const error = `LRANGE returned ${typeof res.result}, expected a list`;
    recordRedisFailure("LRANGE", false, error);
    return { ok: false, error };
  }
  return { ok: true, result: res.result };
}

// Buffered: one LPUSH per flush interval instead of LPUSH+LTRIM per request. The old
// path cost 2 Redis commands for every logged HTTP request, which is what made command
// volume O(requests served) and put steady-state spend over the plan ceiling (#1023).
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
  if (!res.ok) return; // stays unhydrated — reads report unavailable rather than empty
  const stored = res.result
    .map(parseLogEntry)
    .filter((e): e is RequestLogEntry => e !== null);
  // Anything logged while the read was in flight is newer than everything stored.
  requestLogMirror = [...requestLogMirror, ...stored].slice(0, REQUEST_LOG_MAX);
  requestLogHydrated = true;
}

async function flushRequestLog(): Promise<void> {
  if (!useRedis() || requestLogPending.length === 0) return;
  const batch = requestLogPending;
  requestLogPending = [];

  // LPUSH is variadic: the whole batch is a single command. Values are pushed left-to-right,
  // so the chronologically-last entry ends up at index 0 — the newest-first ordering readers
  // already expect.
  const push = await redisCommand<number>([
    "LPUSH",
    REQUEST_LOG_KEY,
    ...batch.map((e) => JSON.stringify(e)),
  ]);
  if (!push.ok) {
    // Keep the batch for the next attempt rather than losing it, bounded the same way.
    requestLogPending = [...batch, ...requestLogPending].slice(-REQUEST_LOG_FLUSH_MAX);
    return;
  }
  // LPUSH returns the new length, so the trim can wait until the list has actually
  // outgrown its cap by a margin. Trimming on every flush would cost as many commands as
  // the push itself to remove a handful of entries nothing reads (readers ask for ≤200).
  if (typeof push.result === "number" && push.result > REQUEST_LOG_TRIM_THRESHOLD) {
    await redisCommand<string>(["LTRIM", REQUEST_LOG_KEY, 0, REQUEST_LOG_MAX - 1]);
  }
}

// Returns the log alongside an explicit `available` flag. An unreachable Redis
// previously produced an empty array indistinguishable from "no traffic yet" (#1018).
// Served from the in-memory mirror; `available` is false until the boot-time read of the
// stored list has succeeded, so an unread log is still never reported as an empty one.
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

function parseTelemetryData(data: Record<string, unknown>): void {
  cumulative.sessions = (data.cumulative_sessions as number) ?? 0;
  cumulative.tool_calls = (data.cumulative_tool_calls as number) ?? 0;
  cumulative.api_hits = (data.cumulative_api_hits as number) ?? 0;
  cumulative.landing_views = (data.cumulative_landing_views as number) ?? 0;
  cumulative.first_session_at = (data.first_session_at as string) ?? "";
  cumulative.last_deploy_at = (data.last_deploy_at as string) ?? "";
  cumulative.clients = (data.cumulative_clients as Record<string, number>) ?? {};
  cumulative.tool_calls_by_client = (data.cumulative_tool_calls_by_client as Record<string, number>) ?? {};
  // One-time backfill: if persisted cumulative_tool_calls is greater than the sum of per-client
  // buckets (e.g. first load after this feature ships — all prior calls were untracked by client),
  // attribute the delta to "unknown" so the sum(toolCallsByClient) == totalToolCallsAllTime
  // invariant holds from this deploy onward.
  const byClientSum = Object.values(cumulative.tool_calls_by_client).reduce((a, b) => a + b, 0);
  if (cumulative.tool_calls > byClientSum) {
    const delta = cumulative.tool_calls - byClientSum;
    cumulative.tool_calls_by_client.unknown = (cumulative.tool_calls_by_client.unknown ?? 0) + delta;
  }
  cumulative.tool_calls_by_name = (data.cumulative_tool_calls_by_name as Record<string, number>) ?? {};
  // Same backfill-to-unknown pattern for per-name — preserves the sum invariant
  // sum(toolCallsByName) == totalToolCallsAllTime from Day 1 of this feature.
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

  // Hydrate the search-query ring buffer from persisted entries. Skip malformed records
  // rather than rejecting the whole load — telemetry.json may have been hand-edited.
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
        // A malformed unfiltered_count must not silently drive the catalog-gap list.
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
  // Merge cumulative + current deployment per-client tool-call counts
  const mergedToolCallsByClient: Record<string, number> = { ...cumulative.tool_calls_by_client };
  for (const [name, count] of Object.entries(toolCallsByClient)) {
    mergedToolCallsByClient[name] = (mergedToolCallsByClient[name] ?? 0) + count;
  }
  // Merge cumulative + current deployment per-tool-name tool-call counts
  const mergedToolCallsByName: Record<string, number> = { ...cumulative.tool_calls_by_name };
  for (const [tool, count] of Object.entries(toolCallsByName)) {
    mergedToolCallsByName[tool] = (mergedToolCallsByName[tool] ?? 0) + count;
  }
  // Merge referral vendor counts (cumulative + current deployment)
  const mergedVendorCounts: Record<string, number> = { ...cumulative.referral_vendor_counts };
  for (const [vendor, count] of Object.entries(referralVendorCounts)) {
    mergedVendorCounts[vendor] = (mergedVendorCounts[vendor] ?? 0) + count;
  }
  // Merge per-endpoint api hits (cumulative + current deployment)
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

// True when Redis is configured but the boot-time load could not be read. In that state
// the in-memory `cumulative` totals are NOT the real historical totals — they are zeros —
// so flushing them to Redis would destroy the stored history. See flushTelemetry.
let telemetryLoadFailed = false;

export function telemetryLoadDidFail(): boolean {
  return telemetryLoadFailed;
}

export async function loadTelemetry(filePath: string): Promise<void> {
  telemetryPath = filePath;

  // Page views and the request log are stored separately and hydrate here so the whole
  // boot-time read is one place. Both fail closed: an unread store stays unloaded and is
  // retried on the next flush rather than being treated as empty (#1018/#1022).
  await loadPageViews();
  await loadRequestLog();

  // Try Redis first if configured
  if (useRedis()) {
    const res = await redisCommand<string | null>(["GET", REDIS_KEY]);
    if (res.ok && res.result) {
      try {
        parseTelemetryData(JSON.parse(res.result) as unknown as Record<string, unknown>);
        cumulative.last_deploy_at = serverStartedISO;
        telemetryLoadFailed = false;
        return;
      } catch {
        // Corrupt blob — fall through to the file backup rather than trusting it.
      }
    }
    // A failed read is not an empty database. Starting from zero here and then writing
    // those zeros back is how a transient outage turns into permanent data loss.
    if (!res.ok) telemetryLoadFailed = true;
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

  // If the boot-time load failed, our cumulative totals started at zero and writing them
  // back would clobber the stored history. Retry the read first: once storage recovers we
  // re-hydrate and resume persisting. Until then, file-only.
  if (useRedis() && telemetryLoadFailed) {
    const res = await redisCommand<string | null>(["GET", REDIS_KEY]);
    if (res.ok) {
      if (res.result) {
        try {
          parseTelemetryData(JSON.parse(res.result) as unknown as Record<string, unknown>);
        } catch {
          // Corrupt blob — treat as recovered-but-empty rather than blocking forever.
        }
      }
      telemetryLoadFailed = false;
      console.error("[telemetry] storage recovered — resuming persistence");
    } else {
      logRedisFailure("SET", `skipping persist: boot load failed (${res.error})`);
    }
  }

  const data = buildTelemetryData();

  // Write to Redis if configured
  if (useRedis() && !telemetryLoadFailed) {
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
  telemetryLoadFailed = false;
  totalSessions = 0;
  totalDisconnects = 0;
  landingPageViews = 0;
  sessionsToday = 0;
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

// Clears the buffered write paths and their loaded-from-storage state. Separate from
// resetCounters so a test can put the process back in its just-booted, nothing-loaded
// condition without touching the cumulative counters.
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
}

export function recordToolCall(tool: string, clientName?: string): void {
  if (tool in toolCalls) {
    toolCalls[tool]++;
    const bucket = (clientName && clientName.trim()) || "unknown";
    toolCallsByClient[bucket] = (toolCallsByClient[bucket] ?? 0) + 1;
    toolCallsByName[tool] = (toolCallsByName[tool] ?? 0) + 1;
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
  toolCallsByClient: Record<string, number>;
  toolCallsByName: Record<string, number>;
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
    sessionsToday,
    serverStarted: serverStartedISO,
    clients: mergedClients,
    toolCallsByClient: mergedToolCallsByClient,
    toolCallsByName: mergedToolCallsByName,
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

// Upstash rejects oversized requests, and a rejected MGET used to read back as a page of
// zeros. Chunking keeps each command small enough to succeed. Only the one-time migration
// off the legacy key space still reads this way.
const MGET_CHUNK_SIZE = 100;

// --- Page-view storage (#1023) ---
//
// Counters used to live one Redis key per (day, path): 3-4 INCRs per page view on write,
// and a SCAN + MGET fan-out per /api/pageviews call on read. That makes command volume
// O(requests served) on both sides, which is what exhausted the plan's command quota.
//
// They now live in a single JSON snapshot key. Writes accumulate in memory and the whole
// snapshot is rewritten once per flush interval, so:
//   * write cost is O(flush intervals), not O(page views) — 2 commands per flush, and
//     zero when nothing changed;
//   * read cost is zero — /api/pageviews serves the in-memory snapshot merged with the
//     un-flushed deltas, so there is no fan-out to cache and no SCAN at all;
//   * retention is enforced in code (no TTL command, no EXPIRE per key), and the key
//     space cannot grow without bound because the maps are capped.
const PAGE_VIEWS_KEY = "agentdeals:pageviews";
const PAGE_VIEW_DAY_RETENTION = 7;
const MAX_PAGE_KEYS_PER_DAY = 300;
const MAX_ALL_TIME_PAGE_KEYS = 300;

// A Referer header is attacker-controlled, so the referrer map is the one part of this
// key space a stranger can grow. Capping it is what keeps command *payload* — and, before
// this change, command *count* — from scaling with hostile traffic.
const MAX_REFERRER_DOMAINS_PER_DAY = 100;
export const OTHER_REFERRER_KEY = "__other__";

const DAY_TOTAL_KEY = "total";

interface PageViewSnapshot {
  /** date -> path -> count, including the DAY_TOTAL_KEY pseudo-path. */
  days: Record<string, Record<string, number>>;
  /** date -> referrer domain -> count. */
  referrers: Record<string, Record<string, number>>;
  /** path -> count, never pruned by date. */
  all_time: Record<string, number>;
  updated_at: string;
}

function emptySnapshot(): PageViewSnapshot {
  return { days: {}, referrers: {}, all_time: {}, updated_at: "" };
}

/** Last state known to be stored. */
let pageViewSnapshot = emptySnapshot();
/** Increments not yet persisted. Same shape so merging is a plain deep add. */
let pendingPageViews = emptySnapshot();
/** False until we have a trustworthy base to add deltas to — see flushPageViews. */
let pageViewsLoaded = false;
/** Set by a successful load; consumed by the first flush after it. */
let pageViewsRereadPending = false;

function bump(map: Record<string, number>, key: string, delta: number): void {
  map[key] = (map[key] ?? 0) + delta;
}

// Adds to `map`, folding into `overflowKey` once the key space is full. `known` is a
// second map (the persisted side) consulted so a key already in the snapshot is not
// treated as new. Counts are never dropped, only relabelled.
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
  let n = Object.keys(pendingPageViews.all_time).length;
  for (const day of Object.values(pendingPageViews.days)) n += Object.keys(day).length;
  for (const day of Object.values(pendingPageViews.referrers)) n += Object.keys(day).length;
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
  };
  for (const [date, map] of Object.entries(base.days)) out.days[date] = { ...map };
  for (const [date, map] of Object.entries(base.referrers)) out.referrers[date] = { ...map };

  for (const [date, map] of Object.entries(delta.days)) {
    const target = (out.days[date] ??= {});
    for (const [key, count] of Object.entries(map)) {
      if (key === DAY_TOTAL_KEY) bump(target, key, count);
      else bumpBounded(target, key, count, MAX_PAGE_KEYS_PER_DAY, UNMATCHED_PAGE_KEY);
    }
  }
  for (const [date, map] of Object.entries(delta.referrers)) {
    const target = (out.referrers[date] ??= {});
    for (const [key, count] of Object.entries(map)) {
      bumpBounded(target, key, count, MAX_REFERRER_DOMAINS_PER_DAY, OTHER_REFERRER_KEY);
    }
  }
  for (const [key, count] of Object.entries(delta.all_time)) {
    bumpBounded(out.all_time, key, count, MAX_ALL_TIME_PAGE_KEYS, UNMATCHED_PAGE_KEY);
  }
  return out;
}

// Retention is applied here rather than by Redis TTLs — one fewer command per key, and it
// works for a snapshot that has no per-key expiry to hang a TTL on. Overflowing all-time
// paths fold into __unmatched__ so the total stays exact.
function pruneSnapshot(snapshot: PageViewSnapshot): void {
  for (const field of ["days", "referrers"] as const) {
    const dates = Object.keys(snapshot[field]).sort().reverse();
    for (const date of dates.slice(PAGE_VIEW_DAY_RETENTION)) delete snapshot[field][date];
  }
  const entries = Object.entries(snapshot.all_time);
  if (entries.length > MAX_ALL_TIME_PAGE_KEYS) {
    entries.sort((a, b) => b[1] - a[1]);
    const kept = Object.fromEntries(entries.slice(0, MAX_ALL_TIME_PAGE_KEYS));
    const folded = entries.slice(MAX_ALL_TIME_PAGE_KEYS).reduce((sum, [, v]) => sum + v, 0);
    snapshot.all_time = kept;
    if (folded > 0) bump(snapshot.all_time, UNMATCHED_PAGE_KEY, folded);
  }
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

// The snapshot may have been written by an older build or hand-edited; take what parses
// and ignore the rest rather than rejecting the whole blob.
function normalizeSnapshot(raw: unknown): PageViewSnapshot {
  const snapshot = emptySnapshot();
  if (!raw || typeof raw !== "object") return snapshot;
  const obj = raw as Record<string, unknown>;
  snapshot.days = numericMapOfMaps(obj.days);
  snapshot.referrers = numericMapOfMaps(obj.referrers);
  snapshot.all_time = numericMap(obj.all_time);
  snapshot.updated_at = typeof obj.updated_at === "string" ? obj.updated_at : "";
  return snapshot;
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

// Reads a set of counter keys. `missing` lists keys whose value could not be read, so
// callers can tell "we could not read this" from "this is genuinely zero" (#1018 Defect B).
async function redisGetMulti(keys: string[]): Promise<{ values: Map<string, number>; missing: string[] }> {
  const values = new Map<string, number>();
  const missing: string[] = [];
  if (keys.length === 0) return { values, missing };
  for (let i = 0; i < keys.length; i += MGET_CHUNK_SIZE) {
    const chunk = keys.slice(i, i + MGET_CHUNK_SIZE);
    const res = await redisMget(chunk);
    if (!res.ok) {
      // The whole chunk is unreadable — report it rather than counting it as zeros.
      missing.push(...chunk);
      continue;
    }
    for (let j = 0; j < chunk.length; j++) {
      const v = res.result[j];
      if (v === null) continue; // key genuinely absent (expired/never created)
      values.set(chunk[j], parseInt(v, 10) || 0);
    }
  }
  return { values, missing };
}

// Page paths that carry a slug. Longest-prefix-first so /embed/vendor/ is not
// swallowed by a shorter prefix.
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

// Every page view that is not a route we actually serve collapses into this one key.
export const UNMATCHED_PAGE_KEY = "__unmatched__";

// Maps a raw request path onto a bounded key space. Before this, `recordPageView` used the
// raw pathname, so any string an attacker put in a request line became a permanent Redis
// key — the live keyspace contained entries like `/$(pwd)/.env` (#1018).
export function normalizePagePath(path: string): string {
  if (typeof path !== "string" || path.length === 0) return UNMATCHED_PAGE_KEY;
  const clean = path.split("?")[0].split("#")[0];
  if (clean === "/") return "/";
  for (const prefix of DYNAMIC_PAGE_PREFIXES) {
    if (clean.startsWith(prefix)) return `${prefix}:slug`;
  }
  // Static pages are a fixed, server-defined set of single-segment slugs. Anything with
  // another path segment, an unusual character, or an implausible length is not a page we
  // serve — it is scanner traffic.
  if (/^\/[a-z0-9][a-z0-9._-]{0,63}$/.test(clean)) return clean;
  return UNMATCHED_PAGE_KEY;
}

// `statusCode`, when supplied, is the status we actually served. A 404 means the path is
// not a route of ours regardless of how well-formed it looks, so it buckets to
// __unmatched__ — this is what bounds the keyspace for slug-shaped probes like /wp-login.
export function recordPageView(path: string, userAgent: string, referer?: string, statusCode?: number): void {
  if (isBot(userAgent)) return;

  const today = new Date().toISOString().slice(0, 10);
  if (today !== pageViewsTodayDate) {
    pageViewsToday = 0;
    pageViewsTodayDate = today;
  }
  pageViewsToday++;

  if (!useRedis()) return;

  const served = statusCode === undefined || statusCode < 400;
  const key = served ? normalizePagePath(path) : UNMATCHED_PAGE_KEY;

  // Pure in-memory accounting — no Redis command on the request path at all. The deltas
  // go out aggregated on the next flush (#1023).
  const day = (pendingPageViews.days[today] ??= {});
  bumpBounded(day, key, 1, MAX_PAGE_KEYS_PER_DAY, UNMATCHED_PAGE_KEY, pageViewSnapshot.days[today]);
  bump(day, DAY_TOTAL_KEY, 1);
  bumpBounded(pendingPageViews.all_time, key, 1, MAX_ALL_TIME_PAGE_KEYS, UNMATCHED_PAGE_KEY, pageViewSnapshot.all_time);

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
      // Invalid referrer URL — skip
    }
  }
}

// --- Page-view load / migration / flush ---

let legacyMigrationDone = false;

// One-time move off the per-key layout. The all-time counters are real history (the
// partnership conversation is about exactly these numbers), so they are read across and
// folded into the snapshot rather than abandoned. Legacy keys are left in place: the
// dailies carry TTLs and expire themselves, and pv:all:* becomes inert once we stop
// reading it. Returns false if any read failed — a partial migration would silently
// under-count history, so we retry on the next flush instead of persisting it.
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

  // pv:all:* never had a total key; the day maps did, and it is carried across as-is.
  pruneSnapshot(snapshot);
  return snapshot;
}

async function loadPageViews(): Promise<void> {
  if (!useRedis()) return;
  const res = await redisCommand<string | null>(["GET", PAGE_VIEWS_KEY]);
  if (!res.ok) return; // a failed read is not an empty database — stay unloaded (#1022)

  if (res.result) {
    try {
      pageViewSnapshot = normalizeSnapshot(JSON.parse(res.result));
      pageViewsLoaded = true;
      pageViewsRereadPending = true;
      legacyMigrationDone = true;
      return;
    } catch {
      // Corrupt blob — fall through and rebuild from the legacy key space.
    }
  }

  if (!legacyMigrationDone) {
    const migrated = await migrateLegacyPageViews();
    if (!migrated) return; // could not read the legacy keys — retry rather than zero them
    pageViewSnapshot = migrated;
    legacyMigrationDone = true;
  }
  pageViewsLoaded = true;
  pageViewsRereadPending = true;
}

async function flushPageViews(): Promise<void> {
  if (!useRedis()) return;

  if (!pageViewsLoaded) {
    // Same guard as flushTelemetry: until we have read the stored history, writing our
    // in-memory view over it would turn an outage into permanent loss (#1022). Deltas keep
    // accumulating in memory — the key space is capped, so that is bounded.
    await loadPageViews();
    if (!pageViewsLoaded) {
      logRedisFailure("SET", "skipping page-view persist: snapshot not loaded");
      return;
    }
  }

  if (!hasPendingPageViews()) return;

  // One best-effort re-read on the first flush after boot. During a deploy the outgoing
  // instance flushes on SIGTERM, which can land *after* our boot read; merging into that
  // stale base would drop its final batch. After this we are the only writer, so the
  // in-memory snapshot is exactly what we last stored and re-reading every flush would
  // just spend a command to learn what we already know.
  if (pageViewsRereadPending) {
    pageViewsRereadPending = false;
    const read = await redisCommand<string | null>(["GET", PAGE_VIEWS_KEY]);
    if (read.ok && read.result) {
      try { pageViewSnapshot = normalizeSnapshot(JSON.parse(read.result)); }
      catch { /* corrupt — keep the last known-good local copy */ }
    }
  }

  // Take the buffer before the round trip, not after. Requests keep arriving during the
  // SET, and clearing `pendingPageViews` on the far side of the await would discard every
  // view recorded in that window — they are not in `merged`, so nothing would ever store
  // them. Anything counted from here on lands in the next batch.
  const batch = pendingPageViews;
  pendingPageViews = emptySnapshot();

  const merged = mergeSnapshot(pageViewSnapshot, batch);
  pruneSnapshot(merged);
  merged.updated_at = new Date().toISOString();

  const write = await redisCommand<string>(["SET", PAGE_VIEWS_KEY, JSON.stringify(merged)]);
  if (!write.ok) {
    // Put the batch back, on top of whatever arrived while the write was failing.
    pendingPageViews = mergeSnapshot(batch, pendingPageViews);
    return;
  }

  pageViewSnapshot = merged;
}

// How often serve.ts calls flushPending(). Exposed on the health block so the reported
// command-rate projection can be reasoned about without reading the source.
//
// This value divides straight into Redis command spend — halving it doubles the bill —
// so the env override is floored rather than trusted. It also sets how much counter data
// an unclean restart can lose; 60s is the balance point between the two.
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
    // A flush must never reject: it runs unattended on a timer and on the shutdown path.
    logRedisFailure("FLUSH", err instanceof Error ? err.message : String(err));
  }
}

// Serialises flushes. If a write stalls past the interval the next timer tick would
// otherwise run concurrently, and the second run would clear `pendingPageViews` including
// anything recorded after the first run built its merge — deltas dropped without ever
// being stored. Chaining also means the shutdown flush queues behind an in-flight one
// rather than being skipped, which a plain re-entrancy flag would get wrong.
let flushChain: Promise<void> = Promise.resolve();

// Pushes everything buffered on the request path. Called on a timer and on SIGTERM.
export function flushPending(): Promise<void> {
  if (!useRedis()) return Promise.resolve();
  flushChain = flushChain.then(runFlush, runFlush);
  return flushChain;
}

export interface PageViewPeriod {
  total: number | null;
  top_pages: { path: string; views: number }[];
  /** True when at least one key in this period could not be read. */
  partial: boolean;
}

export interface PageViewsReport {
  today: PageViewPeriod;
  yesterday: PageViewPeriod;
  all_time: PageViewPeriod;
  referrers_today: Record<string, number>;
  /** False when the storage layer could not be read at all — the numbers are not measurements. */
  available: boolean;
  error: string | null;
  storage: TelemetryHealth;
}

const UNAVAILABLE_PERIOD: PageViewPeriod = { total: null, top_pages: [], partial: true };

const TOP_PAGES_LIMIT = 20;

function topPages(map: Record<string, number>): { path: string; views: number }[] {
  return Object.entries(map)
    .filter(([path]) => path !== DAY_TOTAL_KEY)
    .map(([path, views]) => ({ path, views }))
    .sort((a, b) => b.views - a.views)
    .slice(0, TOP_PAGES_LIMIT);
}

// A day map carries its own total. An absent day is a measured zero, not an unknown —
// we hold the whole snapshot, so "we have no record of that day" is a real answer.
function dayPeriod(map: Record<string, number> | undefined): PageViewPeriod {
  if (!map) return { total: 0, top_pages: [], partial: false };
  return { total: map[DAY_TOTAL_KEY] ?? 0, top_pages: topPages(map), partial: false };
}

function allTimePeriod(map: Record<string, number>): PageViewPeriod {
  const total = Object.entries(map).reduce((sum, [k, v]) => (k === DAY_TOTAL_KEY ? sum : sum + v), 0);
  return { total, top_pages: topPages(map), partial: false };
}

// Serves the in-memory snapshot plus everything not yet flushed. Costs zero Redis
// commands: the SCAN + MGET fan-out this used to run per caller is gone entirely, which
// is stronger than caching it (#1023). Numbers include un-flushed deltas, so a page view
// is visible here immediately rather than after the next flush.
export async function getPageViews(): Promise<PageViewsReport> {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const storage = getTelemetryHealth();

  if (!useRedis()) {
    // No storage configured: today's in-memory counter is a real measurement, the
    // historical periods are simply not available here.
    return {
      today: { total: pageViewsToday, top_pages: [], partial: false },
      yesterday: { ...UNAVAILABLE_PERIOD },
      all_time: { ...UNAVAILABLE_PERIOD },
      referrers_today: {},
      available: false,
      error: "redis-not-configured",
      storage,
    };
  }

  if (!pageViewsLoaded) {
    // We never got a trustworthy base. The deltas since boot are real but they are not
    // the totals, and reporting a partial count as the total is the Defect B mistake.
    return {
      today: { ...UNAVAILABLE_PERIOD },
      yesterday: { ...UNAVAILABLE_PERIOD },
      all_time: { ...UNAVAILABLE_PERIOD },
      referrers_today: {},
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

// --- Search query analytics ---
// Persisted as a ring buffer (last SEARCH_QUERY_RING_MAX entries) on telemetry.json,
// so /api/metrics analytics survive deploys.

export interface SearchQueryContext {
  category?: string;
  userAgent?: string;
  source?: SearchSource;
  /**
   * Results for the query alone against the whole catalog. Callers that applied a filter
   * must supply this; without it a search narrowed to nothing by the caller's own
   * category/eligibility/stability/payment filter is indistinguishable from a query we
   * genuinely have no offers for, which is what made `zero_result_queries_7d` unusable
   * for catalog decisions (#1018 Defect C).
   */
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
    // With no filters applied the two counts are the same measurement by definition, so
    // callers only have to do the extra work when they actually narrowed the search.
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

// An entry counts as a catalog gap only if the query alone matched nothing. Entries
// recorded before `unfiltered_count` existed fall back to `results_count`, which is the
// old (over-reporting) behaviour — correct for the unfiltered majority, and the only
// honest reading of a record that never captured the distinction.
function catalogMatchCount(entry: SearchQueryEntry): number {
  return entry.unfiltered_count ?? entry.results_count;
}

export function getSearchAnalytics(): {
  top_queries_7d: { query: string; count: number }[];
  zero_result_queries_7d: { query: string; count: number }[];
  filtered_to_zero_queries_7d: { query: string; count: number }[];
  queries_by_source_7d: Record<string, number>;
  queries_by_category_7d: Record<string, number>;
} {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = searchQueryLog.filter(e => {
    const t = new Date(e.timestamp).getTime();
    return Number.isFinite(t) && t >= sevenDaysAgo;
  });

  const queryCounts = new Map<string, number>();
  // Genuine gaps: the catalog has nothing for this query at all.
  const zeroResultCounts = new Map<string, number>();
  // The caller's own filters removed everything. Worth seeing — it says the filter
  // combination is too narrow — but it is not a signal to go add offers.
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
  };
}

// Cumulative per-endpoint API hits (deploy-surviving). Merges persisted counts with
// the current deployment's in-memory counters.
export function getApiHitsByEndpoint(): Record<string, number> {
  const merged: Record<string, number> = { ...cumulative.api_hits_by_endpoint };
  for (const [endpoint, count] of Object.entries(apiHits)) {
    merged[endpoint] = (merged[endpoint] ?? 0) + count;
  }
  return merged;
}

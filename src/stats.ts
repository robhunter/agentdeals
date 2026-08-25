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
  trafficSinceBoot = {};
  notFoundSinceBoot = 0;
  redirectsSinceBoot = 0;
  signalsSinceBoot = 0;
  // The process-local page-view tally is part of "just booted" too. Without this a test
  // that reads getStats().page_views_today inherits every view the previous one recorded.
  pageViewsToday = 0;
  pageViewsTodayDate = new Date().toISOString().slice(0, 10);
}

export function recordToolCall(tool: string, clientName?: string): void {
  if (tool in toolCalls) {
    toolCalls[tool]++;
    const bucket = (clientName && clientName.trim()) || "unknown";
    toolCallsByClient[bucket] = (toolCallsByClient[bucket] ?? 0) + 1;
    toolCallsByName[tool] = (toolCallsByName[tool] ?? 0) + 1;
    // Also bucketed by day (#1019). The all-time cumulative counter cannot answer
    // "web hits vs MCP tool calls over the same 7 days", which is the headline number.
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

// --- Request outcome (#1029) ---
//
// A request that does not resolve to a page is not a page view. Before this, a 404 was
// bucketed to __unmatched__ *inside* the day map and counted toward the day total, so 84%
// of a day's recorded page views were a scanner walking paths we do not serve — and the
// same requests inflated every client class's hit count on /api/traffic.
//
// Three outcomes, counted apart, because collapsing them loses a distinction we quote:
//   served    (2xx) — we returned content. This is the page view.
//   redirect  (3xx) — the URL resolves, to somewhere else. Counting it as a page view
//                     double-counts: the client then fetches the target and that is a
//                     second request. Visible, never in the total.
//   not_found (4xx/5xx) — did not resolve. Visible, never in the total.
export type RequestOutcome = "served" | "redirect" | "not_found";

/**
 * Classify a served status code. `undefined` means the caller did not record a status
 * (an internal call, or a test recording an intent rather than a response) and is treated
 * as served — the same reading the pre-#1029 code gave it.
 */
export function requestOutcome(statusCode?: number): RequestOutcome {
  if (statusCode === undefined) return "served";
  if (statusCode >= 400) return "not_found";
  if (statusCode >= 300) return "redirect";
  return "served";
}

/** Counts *about* a day, stored alongside the paths in the same map. Never a page path. */
export const NOT_FOUND_KEY = "__not_found__";
export const REDIRECT_KEY = "__redirect__";

/**
 * Where a *served* page view goes when we cannot name its path — either the day's key
 * space is full, or the path is one we answered but cannot normalize.
 *
 * It exists because `__unmatched__` used to mean both "we served this and cannot name it"
 * and "this is not a page at all", and the two have to be separated to exclude one from
 * the total without dropping the other. Everything under this key is a request we
 * answered with a page, so it counts.
 */
export const OVERFLOW_PAGE_KEY = "__other_pages__";

/**
 * What `normalizePagePath`/`normalizeRoutePath` return for a path that is not a route we
 * serve. Declared here rather than next to them because PSEUDO_DAY_KEYS below needs it at
 * module-evaluation time.
 */
export const UNMATCHED_PAGE_KEY = "__unmatched__";

/**
 * Keys inside a day/all-time map that are not page paths and are never in `total`.
 *
 * `__unmatched__` is in here as a *legacy* bucket: the pre-#1029 build wrote 404s there
 * and had no other use for it that mattered at scale, but it recorded no status code, so
 * its contents cannot be split now. It is reported as `unclassified_legacy` — excluded
 * from the total because it is overwhelmingly non-resolving traffic, and named for what
 * we actually know rather than asserted to be entirely 404s. Nothing writes it any more.
 */
const PSEUDO_DAY_KEYS = new Set<string>([DAY_TOTAL_KEY, NOT_FOUND_KEY, REDIRECT_KEY, UNMATCHED_PAGE_KEY]);

/** Where a non-served outcome is tallied inside a day/all-time path map. */
function outcomeKey(outcome: Exclude<RequestOutcome, "served">): string {
  return outcome === "redirect" ? REDIRECT_KEY : NOT_FOUND_KEY;
}

// --- Client-class traffic attribution (#1019) ---
//
// These counters ride inside the page-view snapshot rather than in keys of their own.
// That is deliberate: #1023 made the whole snapshot one SET per flush interval, so
// attribution costs *zero additional Redis commands* however much traffic it measures.
// A key space of its own would have re-introduced the O(requests served) write pattern
// that exhausted the quota in the first place.
//
// Retention differs by map because the shapes differ in width: the class totals are 8
// numbers a day and a month of them is worth keeping, while the route and
// family breakdowns are wide and only useful recently.
// The classifier lives in client-class.ts and is *not* imported here: this module is
// loaded directly from source by several tests, and Node's type stripping cannot resolve
// a relative import out of a .ts file. Callers classify and pass the result in, which is
// the better layering anyway — a storage module has no business parsing user agents.
//
// TRAFFIC_CLASSES therefore restates the taxonomy. traffic-attribution.test.ts asserts it
// is identical to CLIENT_CLASSES, so the two cannot drift apart unnoticed.
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

/** What a caller hands `recordTraffic` — produced by classifyRequest in client-class.ts. */
export interface TrafficClassification {
  client_class: string;
  family: string;
}

const CLASS_DAY_RETENTION = 30;
const MAX_CLASS_ROUTE_KEYS_PER_DAY = 200;
const MAX_FAMILY_KEYS_PER_DAY = 40;
/** Separator for the flattened `class|route` composite key — not valid in either half. */
const CLASS_ROUTE_SEP = "|";
/** Overflow bucket for the per-day family map. Matches UNKNOWN_FAMILY in client-class.ts. */
const UNKNOWN_FAMILY_KEY = "unknown";

/**
 * One remembered non-resolving request (#1029). The `__unmatched__` bucket answers "how
 * many" and nothing else, which is not enough to tell a vulnerability scanner from a
 * search engine walking our URLs wrong — two facts that lead to opposite decisions.
 *
 * The path is sanitized and truncated on the way in. It is never used to construct a key
 * (that is what bounded the key space in the first place) and carries no PII.
 */
export interface NotFoundSample {
  ts: string;
  client_class: string;
  status: number;
  path: string;
}

/** How many recent non-resolving requests to remember. Rides in the existing snapshot. */
const NOT_FOUND_SAMPLE_MAX = 50;
const NOT_FOUND_SAMPLE_PATH_MAX = 80;

/**
 * Reduce an attacker-controlled path to something safe to store and to render. Strips
 * everything outside printable ASCII plus the characters that could close out of a
 * markup or shell context, then truncates.
 */
export function sanitizeSamplePath(raw: unknown): string {
  const clean = String(raw ?? "")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[<>"'`&\\]/g, "");
  return clean.length > NOT_FOUND_SAMPLE_PATH_MAX
    ? `${clean.slice(0, NOT_FOUND_SAMPLE_PATH_MAX)}...`
    : clean;
}

interface PageViewSnapshot {
  /** date -> path -> count, including the pseudo-keys in PSEUDO_DAY_KEYS. Humans only. */
  days: Record<string, Record<string, number>>;
  /** date -> referrer domain -> count. */
  referrers: Record<string, Record<string, number>>;
  /** path -> count, never pruned by date. Carries the same pseudo-keys as a day map. */
  all_time: Record<string, number>;
  updated_at: string;
  /**
   * date -> client class -> hits we *served* (2xx). Bots included (#1019); requests that
   * redirected or did not resolve are in `redirects`/`not_found` and never here (#1029).
   */
  classes: Record<string, Record<string, number>>;
  /** date -> `${class}|${route}` -> hits. Flattened so the 2-level helpers still apply. */
  class_routes: Record<string, Record<string, number>>;
  /** date -> ai_agent family -> hits. */
  families: Record<string, Record<string, number>>;
  /** date -> MCP tool calls, so web_vs_mcp compares the same window on both sides. */
  mcp: Record<string, number>;
  /** date -> client class -> requests that did not resolve to a page (4xx/5xx) (#1029). */
  not_found: Record<string, Record<string, number>>;
  /** date -> client class -> 3xx. Apart, so a redirect and its target are not two hits. */
  redirects: Record<string, Record<string, number>>;
  /** Rolling sample of recent non-resolving requests, oldest first (#1029). */
  not_found_sample: NotFoundSample[];
  /**
   * date -> signal key -> count (#1024). Flat namespaced keys — see SIGNAL_FACETS below.
   * Rides inside this snapshot rather than in keys of its own for the same reason the
   * class counters do: #1023 made the whole snapshot one SET per flush interval, so a
   * reported signal costs zero additional Redis commands however many arrive.
   */
  signals: Record<string, Record<string, number>>;
  /** Same key space as `signals`, never pruned by date — the all-time window reads it. */
  signals_all_time: Record<string, number>;
  /** Bounded ring of recent scrubbed notes, oldest first. Internal only — see SignalNote. */
  signal_notes: SignalNote[];
  /** Date the beacon started recording. Below it there is no data, not zero signals. */
  signals_from: string;
  /**
   * Date the all-time counters were repaired onto the normalized key space (#1029).
   * Counts carried across from before it were collected by a build that treated a 404 as
   * a page view, so the series is only quotable from this date on.
   */
  all_time_trustworthy_from: string;
  /**
   * Date from which `classes` counts served requests only (#1029).
   *
   * The page-view maps repair themselves — the total is recomputed from the page keys —
   * but `classes` holds one number per class per day with the 404s already added in, and
   * the obvious way to back them out (subtract that class's `__unmatched__` route count)
   * is not safe: that bucket also absorbs route-key overflow and served-but-unnormalized
   * routes, neither of which I can bound to zero by inspection. So the day the split
   * landed is disclosed rather than guessed at, and any window reaching before it says so.
   */
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
    not_found: {},
    redirects: {},
    not_found_sample: [],
    signals: {},
    signals_all_time: {},
    signal_notes: [],
    signals_from: "",
    all_time_trustworthy_from: "",
    outcome_split_from: "",
  };
}

/** Last state known to be stored. */
let pageViewSnapshot = emptySnapshot();
/** Increments not yet persisted. Same shape so merging is a plain deep add. */
let pendingPageViews = emptySnapshot();
/** False until we have a trustworthy base to add deltas to — see flushPageViews. */
let pageViewsLoaded = false;
/** Set by a successful load; consumed by the first flush after it. */
let pageViewsRereadPending = false;

// Process-local tally, kept even with no storage configured so a dev run and the test
// suite can still see classification happening. Not a substitute for the snapshot.
let trafficSinceBoot: Record<string, number> = {};
/** Non-served outcomes since boot. Kept apart from trafficSinceBoot for the same reason
 * they are kept apart in the snapshot: `by_class` counts requests we served (#1029). */
let notFoundSinceBoot = 0;
let redirectsSinceBoot = 0;

// Newest last, matching the snapshot's ordering so a merge is a plain concatenation.
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
  let n = Object.keys(pendingPageViews.all_time).length + Object.keys(pendingPageViews.mcp).length;
  for (const day of Object.values(pendingPageViews.days)) n += Object.keys(day).length;
  for (const day of Object.values(pendingPageViews.referrers)) n += Object.keys(day).length;
  for (const day of Object.values(pendingPageViews.classes)) n += Object.keys(day).length;
  for (const day of Object.values(pendingPageViews.class_routes)) n += Object.keys(day).length;
  for (const day of Object.values(pendingPageViews.families)) n += Object.keys(day).length;
  for (const day of Object.values(pendingPageViews.not_found)) n += Object.keys(day).length;
  for (const day of Object.values(pendingPageViews.redirects)) n += Object.keys(day).length;
  // A reported signal must make the flush worth running on its own — it is the rarest
  // event on the site and the one we would most regret losing to an unclean restart.
  for (const day of Object.values(pendingPageViews.signals)) n += Object.keys(day).length;
  n += pendingPageViews.signal_notes.length;
  // Samples on their own must also make the flush worth running: a burst of 404s from a
  // class already counted today adds no new counter key, and without this the sample
  // would sit in memory until some other traffic happened to trigger a write.
  n += pendingPageViews.not_found_sample.length;
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
    not_found: {},
    redirects: {},
    // Oldest first, capped — the delta is newer than the base by construction.
    not_found_sample: [...base.not_found_sample, ...delta.not_found_sample].slice(-NOT_FOUND_SAMPLE_MAX),
    signals: {},
    signals_all_time: { ...base.signals_all_time },
    signal_notes: [...base.signal_notes, ...delta.signal_notes].slice(-SIGNAL_NOTE_MAX),
    signals_from: base.signals_from || delta.signals_from,
    all_time_trustworthy_from: base.all_time_trustworthy_from || delta.all_time_trustworthy_from,
    outcome_split_from: base.outcome_split_from || delta.outcome_split_from,
  };
  for (const [date, map] of Object.entries(base.days)) out.days[date] = { ...map };
  for (const [date, map] of Object.entries(base.referrers)) out.referrers[date] = { ...map };
  for (const [date, map] of Object.entries(base.classes)) out.classes[date] = { ...map };
  for (const [date, map] of Object.entries(base.class_routes)) out.class_routes[date] = { ...map };
  for (const [date, map] of Object.entries(base.families)) out.families[date] = { ...map };
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
      // Pseudo-keys are counts about the day, not paths: they must never be folded into
      // the overflow bucket, and they must never consume a slot in the path key space.
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
  // Both are keyed by the fixed class enum, so they need no cap for the same reason
  // `classes` needs none.
  for (const field of ["not_found", "redirects"] as const) {
    for (const [date, map] of Object.entries(delta[field])) {
      const target = (out[field][date] ??= {});
      for (const [key, count] of Object.entries(map)) bump(target, key, count);
    }
  }
  // The class map is keyed by a fixed 8-value enum, so it needs no cap — an unbounded
  // key here would mean the classifier returned something it cannot return.
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
  return out;
}

// Overflow within a class stays within that class: `ai_agent|/vendor/:slug` folds to
// `ai_agent|__unmatched__`, never into another class's bucket. Getting this wrong would
// move hits between classes on a busy day, which is the one number we quote.
function classRouteOverflowKey(key: string): string {
  const cls = key.split(CLASS_ROUTE_SEP)[0];
  return `${cls}${CLASS_ROUTE_SEP}${OVERFLOW_PAGE_KEY}`;
}

// Retention is applied here rather than by Redis TTLs — one fewer command per key, and it
// works for a snapshot that has no per-key expiry to hang a TTL on. Overflowing all-time
// paths fold into __unmatched__ so the total stays exact.
function pruneSnapshot(snapshot: PageViewSnapshot): void {
  for (const field of ["days", "referrers", "class_routes", "families"] as const) {
    const dates = Object.keys(snapshot[field]).sort().reverse();
    for (const date of dates.slice(PAGE_VIEW_DAY_RETENTION)) delete snapshot[field][date];
  }
  // Class totals and MCP call counts are narrow enough to keep for the 30-day window
  // the web_vs_mcp comparison reports over. The outcome counters are the same shape (a
  // fixed enum per date) and answer questions over the same window.
  for (const field of ["classes", "mcp", "not_found", "redirects", "signals"] as const) {
    for (const date of Object.keys(snapshot[field]).sort().reverse().slice(CLASS_DAY_RETENTION)) {
      delete snapshot[field][date];
    }
  }
  // signals_all_time is deliberately not pruned by date and needs no size prune: its key
  // space is bounded per facet on the way in, and the all-time window is the only place
  // the totals survive the 30-day day-map retention.
  // The sample is deliberately NOT capped here. Two places already bound it: the recorder
  // (in-memory growth between flushes) and the merge (base + delta, which is both what a
  // reader sees and what the next flush writes). A third copy of the same rule is a line
  // no test can bite, which makes it a line nobody can safely change later.
  //
  // Pseudo-keys are held out of the cap: they are counts about the whole series, they
  // cannot grow the key space, and folding one into __unmatched__ would move a
  // deliberately-excluded number back into the reported total.
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

/**
 * One-time repair of the pre-#1021 all-time key space (#1029).
 *
 * Before path normalization existed, `recordPageView` used the raw pathname, so every
 * string a scanner put in a request line became a permanent counter: `/$(pwd)/.env`,
 * `/%2f%2eenv`, `/%2egit/%63onfig`. #1023's migration carried those counts faithfully
 * into the snapshot, which is where they still are — `all_time.top_pages` serves them.
 *
 * They were never page views, they were scans, so their counts move to the not-found
 * bucket rather than being deleted: the arithmetic stays exact and the scan volume stays
 * visible, which is the whole shape of this issue.
 *
 * This much is provable: a key that fails normalization is one we cannot have answered
 * with a page, because the router has no route of that shape.
 *
 * What this deliberately does NOT touch:
 *   `__unmatched__` — already collapsed, and the build that wrote it recorded no status
 *     code, so it cannot be split into 404s and served-but-unnamed. It is reported as
 *     `unclassified_legacy`: outside the total, named for what we actually know.
 *   a 404 on a slug-shaped path — `/wp-login`, `/telescope` — normalizes to itself and is
 *     indistinguishable from a real page in a counter that never recorded a status.
 * That residue is why the payload carries `trustworthy_from` rather than a claim that the
 * all-time series is now clean.
 *
 * Idempotent: after the first pass there is nothing left that fails normalization.
 */
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

/** Repair + stamp, applied wherever a stored snapshot is adopted as the base. */
function adoptSnapshot(snapshot: PageViewSnapshot): PageViewSnapshot {
  const repaired = repairAllTimeKeys(snapshot);
  if (repaired.keys > 0) {
    console.error(
      `[telemetry] #1029 all-time repair: moved ${repaired.keys} non-route keys ` +
        `(${repaired.hits} hits) into ${NOT_FOUND_KEY}`,
    );
  }
  // Repair, then prune — never the other way round. The prune's overflow bucket means
  // "a page we served but cannot name", so anything folded into it before the repair has
  // run is permanently mislabelled as served.
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
  // Absent on a snapshot written before #1019 — an empty map is the correct reading of
  // "this build did not measure that", and the counters start accumulating from now.
  snapshot.classes = numericMapOfMaps(obj.classes);
  snapshot.class_routes = numericMapOfMaps(obj.class_routes);
  snapshot.families = numericMapOfMaps(obj.families);
  snapshot.mcp = numericMap(obj.mcp);
  // Absent on a snapshot written before #1029. An empty map reads as "that build did not
  // separate outcomes", which is true — the not-found hits it recorded are inside
  // `classes` and `days`, and `trustworthy_from` is what says so.
  snapshot.not_found = numericMapOfMaps(obj.not_found);
  snapshot.redirects = numericMapOfMaps(obj.redirects);
  snapshot.not_found_sample = notFoundSamples(obj.not_found_sample);
  // Absent on a snapshot written before #1024 — an empty map is the correct reading of
  // "the beacon did not exist yet", and `signals_from` is what says so on the report.
  snapshot.signals = numericMapOfMaps(obj.signals);
  snapshot.signals_all_time = numericMap(obj.signals_all_time);
  snapshot.signal_notes = signalNotes(obj.signal_notes);
  snapshot.signals_from = typeof obj.signals_from === "string" ? obj.signals_from : "";
  snapshot.all_time_trustworthy_from =
    typeof obj.all_time_trustworthy_from === "string" ? obj.all_time_trustworthy_from : "";
  snapshot.outcome_split_from =
    typeof obj.outcome_split_from === "string" ? obj.outcome_split_from : "";
  return snapshot;
}

// Re-validates on the way back in: the blob is stored data, and the path field is the one
// piece of it that originated in a request line.
function notFoundSamples(raw: unknown): NotFoundSample[] {
  if (!Array.isArray(raw)) return [];
  const out: NotFoundSample[] = [];
  // Not re-capped here: the merge bounds what any reader sees and what the next flush
  // writes back, so an oversized stored blob is reported at the cap and rewritten at the
  // cap. What this loop is for is the per-entry validation below — the path is the one
  // field in the snapshot that originated in a request line.
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

// Re-validated on the way back in for the same reason not_found_sample is: `note` is the
// only field in the snapshot that is caller-supplied prose, so a stored blob written by an
// older build — or hand-edited — must not be trusted to still be inside its caps.
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
// API routes carry a slug the same way pages do. Normalising them here keeps the
// class×route key space bounded for /api/* exactly as normalizePagePath does for pages.
const DYNAMIC_API_PREFIXES = ["/api/vendor/", "/api/category/", "/api/compare/", "/api/badge/"] as const;

/** Bounded route key for any request path, page or API. */
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

/**
 * Attribute one HTTP request to a client class and count it (#1019).
 *
 * Called for *every* request, not just HTML pages — the point of the issue is that the
 * commercially interesting traffic is agents fetching vendor pages and API routes, and
 * the old page-view path both skipped /api/* and dropped bots on the floor.
 *
 * Costs zero Redis commands: everything lands in the in-memory delta that #1023's flush
 * already writes as a single snapshot.
 *
 * NO PII: only the class and the bounded family label are persisted. The User-Agent is
 * read and discarded.
 */
export function recordTraffic(
  classification: TrafficClassification,
  path: string,
  statusCode?: number,
): void {
  const { client_class, family } = classification;
  const today = new Date().toISOString().slice(0, 10);
  const outcome = requestOutcome(statusCode);

  // A client that only ever 404s is not a client that read 3,000 pages, so the outcome
  // decides which counter moves — not just which route key it lands under (#1029).
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
  // Per-family detail is only kept for the class it is asked about. Every other class
  // has a family label too, but storing them all would widen the map for no question
  // anyone is asking.
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
  // Bots stay out of *this* counter so the human-visitor figure does not change meaning
  // (#1019 is additive). Bot traffic is counted — by recordTraffic, in its own class.
  if (isBot(userAgent)) return;

  const today = new Date().toISOString().slice(0, 10);
  if (today !== pageViewsTodayDate) {
    pageViewsToday = 0;
    pageViewsTodayDate = today;
  }
  const outcome = requestOutcome(statusCode);
  if (outcome === "served") pageViewsToday++;

  if (!useRedis()) return;

  // Requests that did not resolve to a page are counted, under their own name, and are
  // not part of the day total. They also earn no referrer credit and no path key — the
  // path is not one of ours (#1029).
  if (outcome !== "served") {
    const day = (pendingPageViews.days[today] ??= {});
    bump(day, outcomeKey(outcome), 1);
    bump(pendingPageViews.all_time, outcomeKey(outcome), 1);
    return;
  }

  // A path we answered but cannot name goes to the served-overflow bucket, never to
  // __unmatched__ — that key now means "recorded before we counted outcomes" and is
  // reported outside the total, so a served hit landing there would vanish from it.
  const normalized = normalizePagePath(path);
  const key = normalized === UNMATCHED_PAGE_KEY ? OVERFLOW_PAGE_KEY : normalized;

  // Pure in-memory accounting — no Redis command on the request path at all. The deltas
  // go out aggregated on the next flush (#1023).
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
      // Invalid referrer URL — skip
    }
  }
}

// --- Page-view load / migration / flush ---

let legacyMigrationDone = false;

// One-time move off the per-key layout. The all-time counters are real history (the
// counters are the ones we publish), so they are read across and
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
  // Deliberately NOT pruned here: pruning folds overflowing keys into the served-overflow
  // bucket, and doing that before the repair has classified them would relabel junk keys
  // as pages we served. adoptSnapshot repairs first, then prunes.
  return snapshot;
}

async function loadPageViews(): Promise<void> {
  if (!useRedis()) return;
  const res = await redisCommand<string | null>(["GET", PAGE_VIEWS_KEY]);
  if (!res.ok) return; // a failed read is not an empty database — stay unloaded (#1022)

  if (res.result) {
    try {
      pageViewSnapshot = adoptSnapshot(normalizeSnapshot(JSON.parse(res.result)));
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
    // Repaired on the way in: the legacy key space is precisely where the junk keys came
    // from, so a rebuild from it must not re-create what the repair removed.
    pageViewSnapshot = adoptSnapshot(migrated);
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
      try { pageViewSnapshot = adoptSnapshot(normalizeSnapshot(JSON.parse(read.result))); }
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
  /** Pages we served (2xx). Excludes redirects and non-resolving requests (#1029). */
  total: number | null;
  top_pages: { path: string; views: number }[];
  /** True when at least one key in this period could not be read. */
  partial: boolean;
  /** Requests that resolved to no page (4xx/5xx). Counted, never inside `total`. */
  not_found: number;
  /** 3xx. Counted apart so a redirect and the request that follows it are not two views. */
  redirects: number;
  /**
   * Hits the pre-#1029 build collapsed into `__unmatched__` before it recorded a status
   * code. Overwhelmingly 404s, but it did not record enough to prove that, so they are
   * excluded from `total` and reported under a name that claims only what we know.
   */
  unclassified_legacy: number;
}

export interface PageViewsReport {
  today: PageViewPeriod;
  yesterday: PageViewPeriod;
  all_time: PageViewPeriod;
  referrers_today: Record<string, number>;
  /**
   * Date from which `all_time` was collected under the current counting rules. Counts
   * before it came from a build that treated a 404 as a page view and minted a permanent
   * key per scanned path; they are retained, repaired where that was possible, and are
   * not quotable.
   */
  all_time_trustworthy_from: string | null;
  /** What each figure includes and excludes. Meant to be read next to the numbers. */
  notes: string[];
  /** False when the storage layer could not be read at all — the numbers are not measurements. */
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

/**
 * `total` is the sum of the page keys, not the stored `total` counter.
 *
 * They agree for anything recorded after #1029 — one served view bumps exactly one page
 * key and the counter — but they disagree for a day recorded before it, because that
 * build bumped the counter for 404s too. Summing the page keys counts only what we can
 * name as a page, which is the right answer for both eras and needs no retroactive
 * rewrite of stored history to get there.
 */
function periodFrom(map: Record<string, number>): PageViewPeriod {
  const total = Object.entries(map).reduce((sum, [k, v]) => (PSEUDO_DAY_KEYS.has(k) ? sum : sum + v), 0);
  // Whatever the old counter counted that we cannot name as a page: the collapsed
  // __unmatched__ bucket, plus any excess the stored total carries over the page keys
  // (a legacy day whose per-path keys expired out from under its total). Taking the
  // larger keeps the arithmetic closed instead of quietly dropping the difference.
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

// An absent day is a measured zero, not an unknown — we hold the whole snapshot, so
// "we have no record of that day" is a real answer.
function dayPeriod(map: Record<string, number> | undefined): PageViewPeriod {
  return periodFrom(map ?? {});
}

function allTimePeriod(map: Record<string, number>): PageViewPeriod {
  return periodFrom(map);
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
    // We never got a trustworthy base. The deltas since boot are real but they are not
    // the totals, and reporting a partial count as the total is the Defect B mistake.
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

// --- Traffic attribution report (#1019) ---

export interface TrafficWindow {
  days: number;
  from: string;
  to: string;
  /**
   * How many days actually back `ai_agent_by_family` and `top_routes_by_class`.
   * Class totals are retained for 30 days but the wide detail maps only for 7, so on the
   * 30-day window this is 7 — reading those breakdowns as month-long would understate
   * them, and silently.
   */
  detail_days: number;
  /**
   * How many days of the window we actually hold data for. A keyspace rebuilt this
   * morning makes `last_30d` arithmetically correct and presentationally a lie; this is
   * the field that says so, and `coverage` says it in words.
   */
  data_days_available: number;
  /** "complete", or a sentence naming how much of the window is backed by data. */
  coverage: string;
  /** Every request in the window we answered with content (2xx), `internal` included. */
  hits_total: number;
  /** `hits_total` minus `internal`. This is the number to quote. */
  hits_excluding_internal: number;
  by_class: Record<string, number>;
  ai_agent_by_family: Record<string, number>;
  top_routes_by_class: Record<string, { route: string; hits: number }[]>;
  /** Requests that resolved to no page. Never inside `hits_total` (#1029). */
  not_found_total: number;
  not_found_by_class: Record<string, number>;
  /** 3xx. Also outside `hits_total` — the request that follows the redirect is the hit. */
  redirect_total: number;
  redirects_by_class: Record<string, number>;
  /**
   * Empty once the whole window post-dates the outcome split (#1029). While it is not,
   * the listed dates were recorded by a build that counted non-resolving requests inside
   * `by_class`, so `hits_total` for this window is high by however many those were.
   */
  pre_split_dates: string[];
}

export interface WebVsMcp {
  window_days: number;
  /** Web + API requests, excluding our own observability traffic. */
  web_hits: number;
  /** Of those, the ones we can positively attribute to an AI agent. */
  ai_agent_hits: number;
  mcp_tool_calls: number;
  /** web_hits : mcp_tool_calls, or null when there were no tool calls to divide by. */
  web_to_mcp_ratio: number | null;
  /** ai_agent_hits : mcp_tool_calls — the honest, conservative version of the same claim. */
  ai_agent_to_mcp_ratio: number | null;
}

export interface TrafficReport {
  today: TrafficWindow;
  last_7d: TrafficWindow;
  last_30d: TrafficWindow;
  web_vs_mcp: { today: WebVsMcp; last_7d: WebVsMcp; last_30d: WebVsMcp };
  /** False when the storage layer could not be read — the numbers are not measurements. */
  available: boolean;
  error: string | null;
  /** Served requests only, matching `by_class`. */
  since_boot_by_class: Record<string, number>;
  since_boot_not_found: number;
  since_boot_redirects: number;
  /**
   * The last few non-resolving requests, newest first. Enough to tell a vulnerability
   * scanner from a broken integration, which the count alone cannot (#1029).
   */
  not_found_sample: NotFoundSample[];
  notes: string[];
  storage: TelemetryHealth;
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

/**
 * Earliest date we hold any record for, across every dated map. Derived rather than
 * stored so that a keyspace rebuild moves it forward on its own — the failure mode of a
 * stored "collecting since" date is that it survives the reset it was supposed to warn
 * about. A genuinely silent first day understates coverage by one, which errs the safe
 * way.
 */
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
  // Clamped by construction: the span runs from the later of (earliest record, window
  // start) to the window end, which cannot exceed the window.
  window.data_days_available = earliest
    ? daysBetweenInclusive(earliest > window.from ? earliest : window.from, window.to)
    : 0;
  window.coverage = coverageNote(days, window.data_days_available, earliest);

  // The split landed mid-day, so its own date is mixed and counts as pre-split.
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

  // Classes we never saw still appear, at zero — an absent key would read as "unknown"
  // when what we mean is "measured, and it was none".
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
  "No PII. Only the class and a bounded family label from a fixed table are stored; user agents and IPs are never persisted.",
  "Attribution starts from the deploy that introduced it — windows longer than that are short by however much history predates it, not wrong.",
  "Class totals are retained for 30 days; the per-family and per-route breakdowns only for 7. Each window states its own detail_days rather than presenting 7 days of detail as 30.",
  "hits_total, hits_excluding_internal, by_class and top_routes_by_class count requests we answered with content (2xx). Requests that did not resolve are in not_found_*, and 3xx answers are in redirect_* — a client that only ever 404s is not a client that read our pages (#1029).",
  "not_found carries no route breakdown: an unmatched path has no route by definition. not_found_sample carries the actual paths, sanitized and truncated, for the last 50.",
  "Each window states data_days_available alongside days. Where they differ the window is arithmetically correct and shorter than its label — read coverage before quoting it.",
];

/**
 * Traffic by client class over today / 7d / 30d, plus the web-vs-MCP comparison.
 * Serves the in-memory snapshot merged with un-flushed deltas, so it costs zero Redis
 * commands however often it is polled (#1023) and reflects the last request immediately.
 */
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
    // The buffered sample is a real observation of this process, exactly like the
    // since-boot tallies beside it. Returning [] here would report the count of a thing
    // while hiding the thing itself, on the code path — no storage, or storage we could
    // not read — where an operator most needs to see what is hitting the server.
    not_found_sample: [...pendingPageViews.not_found_sample].reverse(),
    notes: TRAFFIC_NOTES,
    storage,
  });

  if (!useRedis()) return unavailable("redis-not-configured");
  // Same discipline as getPageViews: a failed load is not a measured zero (#1018 Defect B).
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
    notes: TRAFFIC_NOTES,
    storage,
  };
}

// --- Agent attribution beacon storage (#1024) ---
//
// One flat key space, namespaced by facet, held in the page-view snapshot. Two rules
// decide the layout and both come from what the numbers are for:
//
//  1. Anything whose value comes from a *fixed enum we control* — the event, the
//     transport, the client class, the grand total — is unbounded and exact. Those are
//     the numbers that get published, and a published total that silently folded into an
//     overflow bucket would be worse than no total.
//  2. Anything whose value comes from the *caller* — a vendor slug, a self-identifier, an
//     unrecognized event string — is bounded, and its overflow stays inside its own facet.
//     A flood of junk self-identifiers must not be able to crowd out the vendor detail,
//     and neither may crowd out a headline counter.
//
// Per-vendor keys are stored and internally queryable and are NEVER rendered on a public
// surface (PM ruling on #1024): a visible per-vendor recommendation counter is a signal a
// vendor can acquire, which is the one thing every published order here is built to
// exclude. getSignalReport() is the public shape; getSignalVendorBreakdown() is not.
export const SIGNAL_EVENTS = ["recommended", "converted"] as const;
export type SignalEvent = (typeof SIGNAL_EVENTS)[number];
export const SIGNAL_TRANSPORTS = ["post", "get"] as const;
export type SignalTransport = (typeof SIGNAL_TRANSPORTS)[number];

/** Bucket for an event string we do not recognise. The string itself lands under `x:`. */
export const SIGNAL_UNRECOGNIZED_EVENT = "__unrecognized__";
/** Every accepted signal, whatever else about it we could or could not name. */
const SIGNAL_TOTAL_KEY = "total";

const SIGNAL_SEP = ":";
/** Caller-supplied facets. Bounded, each overflowing into its own bucket. */
const SIGNAL_FACETS = {
  vendor: "v",
  unresolved: "u",
  agent: "a",
  rawEvent: "x",
  /** Which surface produced the signal — the one thing that says which invitation works. */
  source: "s",
} as const;
const MAX_SIGNAL_KEYS_PER_FACET_PER_DAY = 100;
const MAX_SIGNAL_ALL_TIME_KEYS_PER_FACET = 300;
const SIGNAL_OVERFLOW = "__other__";

/**
 * Keys whose value space we define, so they can never grow the map. Held out of the cap
 * exactly as PSEUDO_DAY_KEYS are: folding one of these into an overflow bucket would move
 * a number we publish into a number we cannot name.
 */
function buildFixedSignalKeys(): Set<string> {
  const keys = new Set<string>([SIGNAL_TOTAL_KEY]);
  for (const e of [...SIGNAL_EVENTS, SIGNAL_UNRECOGNIZED_EVENT]) keys.add(`e${SIGNAL_SEP}${e}`);
  for (const t of SIGNAL_TRANSPORTS) keys.add(`t${SIGNAL_SEP}${t}`);
  for (const c of TRAFFIC_CLASSES) keys.add(`c${SIGNAL_SEP}${c}`);
  return keys;
}
const FIXED_SIGNAL_KEYS = buildFixedSignalKeys();

/** Overflow within a facet stays within that facet — same rule as classRouteOverflowKey. */
function signalOverflowKey(key: string): string {
  const facet = key.slice(0, key.indexOf(SIGNAL_SEP));
  return `${facet}${SIGNAL_SEP}${SIGNAL_OVERFLOW}`;
}

/** How many keys of `facet` are already present, for the per-facet cap. */
function facetSize(map: Record<string, number>, prefix: string): number {
  let n = 0;
  for (const k of Object.keys(map)) if (k.startsWith(prefix)) n++;
  return n;
}

// bumpBounded caps the whole map; signals cap per facet, so this is its own small helper
// rather than a fifth parameter on the shared one.
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

/** What the endpoint hands the recorder. Already validated, scrubbed and resolved. */
export interface SignalRecord {
  /** The raw event string as sent, for the `x:` bucket. */
  event: string;
  /** Canonical vendor slug when the resolver named one. */
  vendor: string | null;
  /** Sanitized caller-supplied vendor name when the resolver did not. Catalog-gap feed. */
  unresolved: string | null;
  /** Sanitized self-identifier, or null when the caller sent none. */
  agent: string | null;
  /** Normalized route the caller says informed it, or null. */
  source: string | null;
  /** Scrubbed free text. Kept in a bounded internal ring, never on a public surface. */
  note: string | null;
  /** True when the scrubber replaced something in `note`. Disclosed, not hidden. */
  note_redacted?: boolean;
  transport: SignalTransport;
  client_class: string;
}

/**
 * Recent scrubbed notes, oldest first. Bounded, and deliberately NOT public: it is
 * caller-supplied free text, so rendering it on a page we serve would make anyone who can
 * POST a publisher on this domain. Same shape and same reasoning as not_found_sample,
 * except that one carries no free text and this one does.
 */
export interface SignalNote {
  ts: string;
  event: string;
  vendor: string | null;
  note: string;
  redacted: boolean;
}
const SIGNAL_NOTE_MAX = 50;
/** Second cap, applied at the storage boundary: the scrubber's cap is not this module's. */
const SIGNAL_NOTE_TEXT_MAX = 200;

let signalsSinceBoot = 0;

/**
 * Record one reported signal. Pure in-memory accounting — no Redis command on the request
 * path at all, per the AC. Recorded whether or not storage is configured, so a dev run and
 * the test suite still see the beacon working; the report says which of the two it is.
 */
export function recordSignal(rec: SignalRecord): void {
  signalsSinceBoot++;
  // Gated exactly as recordTraffic is, and the report depends on it: the denominator
  // comes from `class_routes`, which recordTraffic only writes when storage is
  // configured. If the numerator accumulated without storage and the denominator did
  // not, every rate would divide two counts collected under different rules. Same
  // regime for both, or neither — the since-boot tally above is what a storage-less
  // dev run gets to see, exactly as trafficSinceBoot is.
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
    `e${SIGNAL_SEP}${eventKey}`,
    `t${SIGNAL_SEP}${rec.transport}`,
    `c${SIGNAL_SEP}${cls}`,
  ];
  const bounded: string[] = [];
  // The per-vendor key carries the event with it: "recommended neon" and "converted neon"
  // are different facts and collapsing them would make the internal breakdown useless.
  if (rec.vendor) bounded.push(`${SIGNAL_FACETS.vendor}${SIGNAL_SEP}${eventKey}${SIGNAL_SEP}${rec.vendor}`);
  if (rec.unresolved) bounded.push(`${SIGNAL_FACETS.unresolved}${SIGNAL_SEP}${rec.unresolved}`);
  if (rec.agent) bounded.push(`${SIGNAL_FACETS.agent}${SIGNAL_SEP}${rec.agent}`);
  if (rec.source) bounded.push(`${SIGNAL_FACETS.source}${SIGNAL_SEP}${rec.source}`);
  // An unrecognized event is the most interesting thing this endpoint collects — an agent
  // telling us for free what it wanted to report — so the string is preserved, not dropped.
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

/** Routes where a recommendation actually gets made — the report-rate denominator. */
export const SIGNAL_DENOMINATOR_ROUTES = [
  "/vendor/:slug",
  "/alternative-to/:slug",
  "/compare/:slug",
  "/best/:slug",
  "/category/:slug",
] as const;

/**
 * Below this many qualifying fetches we publish the counts and refuse to divide them.
 * At the ~29 ai_agent decision-page hits/day we see today that is over a month out, which
 * is the point: this instrument's first job is counting, not rate-estimation, and a rate
 * computed off 19 fetches would read as a measurement when it is a coin flip.
 */
export const SIGNAL_MIN_SAMPLE = 1000;

export interface SignalWindow {
  days: number;
  from: string;
  to: string;
  total: number;
  /** By recognized event, plus the unrecognized bucket. Never a ratio between them. */
  by_event: Record<string, number>;
  /** Never summed into a headline: a GET and a POST are different populations (#1024). */
  by_transport: Record<string, number>;
  /** The tell that separates a real agent from a crawler that found a way to fire. */
  by_client_class: Record<string, number>;
  /** Distinct vendors that received at least one signal. Never which vendors. */
  distinct_vendors: number;
  /** Names agents used that we do not index. A catalog-gap feed, not a signal count. */
  unresolved_vendor_names: { name: string; count: number }[];
  /** Event strings we do not recognise, preserved verbatim. */
  unrecognized_events: { event: string; count: number }[];
  /** Self-identifiers, as reported. Unverified — anyone may claim any name. */
  by_reporting_agent: { agent: string; count: number }[];
  /** Which surface the sender says informed it. The only read on which invitation works. */
  by_source: { source: string; count: number }[];
  /** ai_agent hits on the decision routes in the same window. The denominator. */
  qualifying_fetches: number;
  /** Reported beside it, never folded in: that class is mostly one scanner today. */
  qualifying_fetches_sdk_client: number;
  /**
   * How many days of the window the denominator actually covers.
   *
   * The numerator and the denominator are retained for different lengths — signals for
   * 30 days, the class-by-route counters they are divided by for 7. So a 30-day window
   * holds 30 days of signals over at most 7 days of fetches, and dividing the two would
   * overstate the rate by up to a factor of four. This field is what makes that visible,
   * and applyRate refuses the division whenever it is short of `days`.
   */
  denominator_days_available: number;
  /** null below SIGNAL_MIN_SAMPLE, or when the denominator is short — see `rate_note`. */
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

/** Reduce a signal key map into a window. `dates` is null for the all-time map. */
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
    if (facet === "e") window.by_event[rest] = (window.by_event[rest] ?? 0) + count;
    else if (facet === "t") window.by_transport[rest] = (window.by_transport[rest] ?? 0) + count;
    else if (facet === "c") window.by_client_class[rest] = (window.by_client_class[rest] ?? 0) + count;
    else if (facet === SIGNAL_FACETS.vendor && rest !== SIGNAL_OVERFLOW) {
      // `rest` is `${event}:${slug}` — count the vendor, once, across events.
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

/** ai_agent (and separately sdk_client) hits on the decision routes over `dates`. */
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
  // Checked before the sample size, because it is the failure that would produce a
  // plausible-looking number rather than a small one.
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
  // The class×route map is pruned at 30 days, so there is no all-time denominator to
  // report. Saying so beats reporting a 30-day denominator under an all-time label.
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
  "client_class is the sender's classification from the same table that attributes page traffic. A signal arriving as seo_crawler is not an agent telling us something.",
  "recommended and converted are two independent counters, never a funnel. Agents rarely observe whether their user signed up, so converted undercounts by an unknown factor and is not a conversion rate.",
  "The report rate is signals divided by ai_agent fetches of the pages where a recommendation gets made (/vendor, /alternative-to, /compare, /best, /category). sdk_client fetches are reported beside it and never folded in.",
  `No rate is computed below ${SIGNAL_MIN_SAMPLE} qualifying fetches, nor over any window whose denominator covers fewer days than the window itself. Signals are retained for ${CLASS_DAY_RETENTION} days and the counters they divide by for ${PAGE_VIEW_DAY_RETENTION}, so the 30-day window reports both counts and refuses the division — each window states its own denominator_days_available.`,
  "Per-vendor counts are recorded and are not published. A visible per-vendor counter would be a placement metric a vendor could acquire by firing it themselves.",
  "This call records the vendor slug, the event, an optional name the caller chooses for itself, and the sender's client class. Nothing about the caller's user, no IP, no identity.",
];

export interface SignalReport {
  today: SignalWindow;
  last_7d: SignalWindow;
  last_30d: SignalWindow;
  all_time: SignalWindow;
  /** False when storage is not configured: the numbers are this process's, not durable. */
  durable: boolean;
  recording_since: string | null;
  since_boot: number;
  notes: string[];
  storage: TelemetryHealth;
}

/**
 * The public shape. Aggregates only — no per-vendor counts anywhere in it, deliberately
 * (PM ruling on #1024). Serves the in-memory snapshot merged with un-flushed deltas, so
 * it costs zero Redis commands however often it is polled.
 */
export function getSignalReport(): SignalReport {
  const view = mergeSnapshot(pageViewSnapshot, pendingPageViews);
  return {
    today: buildSignalWindow(view, 1),
    last_7d: buildSignalWindow(view, 7),
    last_30d: buildSignalWindow(view, 30),
    all_time: buildSignalAllTime(view),
    durable: useRedis() && pageViewsLoaded,
    recording_since: view.signals_from || null,
    since_boot: signalsSinceBoot,
    notes: SIGNAL_NOTES,
    storage: getTelemetryHealth(),
  };
}

/**
 * Per-vendor detail. NOT a public surface — nothing in serve.ts may render this on a
 * response, and a test asserts that. It exists so the question "which vendors are agents
 * naming" can be answered by whoever runs the service, without publishing a leaderboard
 * that a vendor could climb by firing the endpoint at itself.
 */
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

/**
 * Recent scrubbed notes, newest first. NOT a public surface either: caller-supplied prose
 * rendered on a page we serve would make anyone who can POST a publisher on this domain.
 */
export function getSignalNotes(): SignalNote[] {
  const view = mergeSnapshot(pageViewSnapshot, pendingPageViews);
  return [...view.signal_notes].reverse();
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

/**
 * How much of the nominal 7-day window these lists are actually backed by (#1029).
 *
 * The log is a ring of the last SEARCH_QUERY_RING_MAX entries, so a `_7d` list can be
 * two hours of a busy morning wearing a week's label — which is exactly what happened
 * after the #1023 repair reset it, and is why the corrected zero-result list could not be
 * delivered on #1018. The window states its own denominator rather than relying on the
 * reader to remember.
 */
export interface SearchWindowCoverage {
  days: number;
  data_days_available: number;
  coverage: string;
  entries: number;
  oldest_entry: string | null;
  /** True when the ring is full, so the window is bounded by entry count, not by time. */
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
  // Round up: a partial day of data is a day the window is backed by, and rounding down
  // would report 0 for everything short of 24 hours.
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
    window_7d,
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

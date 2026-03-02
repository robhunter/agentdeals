// In-memory telemetry counters. Resets on server restart (v1).
// No PII collected — only aggregate counts and tool-level metrics.

const startedAt = Date.now();

const toolCalls: Record<string, number> = {
  search_offers: 0,
  list_categories: 0,
  get_offer_details: 0,
  get_deal_changes: 0,
};

const apiHits: Record<string, number> = {
  "/api/offers": 0,
  "/api/categories": 0,
};

let totalSessions = 0;
let totalDisconnects = 0;
let landingPageViews = 0;

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

export function recordSessionConnect(): void {
  totalSessions++;
}

export function recordSessionDisconnect(): void {
  totalDisconnects++;
}

export function recordLandingPageView(): void {
  landingPageViews++;
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
  };
}

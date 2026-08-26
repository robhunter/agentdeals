// Client-class attribution (#1019).
//
// AgentDeals has always been measured as an MCP server. The traffic says otherwise:
// 282,739 web/API hits against 409 MCP tool calls all-time, and a sampled request log
// showed 16.6% of API requests coming from AI assistants fetching vendor pages. Until
// now `recordPageView` opened with `if (isBot(userAgent)) return;` — so ChatGPT-User,
// OAI-SearchBot and Claude-User, the traffic that matters most commercially, were the
// traffic we deliberately threw away.
//
// This module answers "who made this request" as a pure function of the User-Agent
// string. It has no storage dependency and no side effects, so it is testable in
// isolation and cannot be the reason a request is slow or a counter is wrong.
//
// NO PII. The only thing a caller may persist is the returned `family` label, which
// always comes from the table below and never from the request. A UA we do not
// recognise yields the family `unknown` — never the raw string, never a fragment of it.

export type ClientClass =
  /** Our own tooling observing the service. Excluded from headline counts by default. */
  | "internal"
  /** LLM agents and AI-assistant fetchers — the commercially interesting bucket. */
  | "ai_agent"
  /** Search-engine indexers. */
  | "search_crawler"
  /** SEO / marketing-intelligence crawlers. */
  | "seo_crawler"
  /** Declared bots that are neither AI, search, nor SEO (link previews, monitors). */
  | "other_bot"
  /** HTTP libraries and CLIs. Ambiguous by nature — could be an agent, could be a scraper. */
  | "sdk_client"
  /** A real engine token, no bot marker. Human-shaped. */
  | "browser"
  /** Genuinely unattributable, including an absent User-Agent. */
  | "unknown";

export interface ClientClassification {
  client_class: ClientClass;
  /** Bounded label from the rule table. Never derived from the request itself. */
  family: string;
}

export const CLIENT_CLASSES: readonly ClientClass[] = [
  "internal",
  "ai_agent",
  "search_crawler",
  "seo_crawler",
  "other_bot",
  "sdk_client",
  "browser",
  "unknown",
] as const;

/** Family recorded when a class matched but the specific product did not. */
export const UNKNOWN_FAMILY = "unknown";

interface Rule {
  /** Matched against the User-Agent, case-insensitively. */
  pattern: RegExp;
  client_class: ClientClass;
  family: string;
}

// Ordered. First match wins, so the more specific rule must come first:
//   Applebot-Extended (AI training) before Applebot (search indexing)
//   Claude-User / claude-code (an agent mid-task) before ClaudeBot (training crawler)
//   OAI-SearchBot before the generic *bot fallbacks
//   HeadlessChrome (automation) before the browser engine tokens
// Reordering this array changes attribution; the tests assert the sharp cases.
const RULES: Rule[] = [
  // --- internal: our own tooling, self-declared -------------------------------------
  // An opt-in marker only. The reliable half of internal attribution is path-based and
  // lives in the caller (see isObservabilityPath) precisely because nobody remembers to
  // set a header during an incident.
  { pattern: /agentdeals-internal|agentdeals-monitor/i, client_class: "internal", family: "agentdeals-internal" },

  // --- ai_agent ----------------------------------------------------------------------
  { pattern: /ChatGPT-User/i, client_class: "ai_agent", family: "ChatGPT-User" },
  { pattern: /OAI-SearchBot/i, client_class: "ai_agent", family: "OAI-SearchBot" },
  { pattern: /GPTBot/i, client_class: "ai_agent", family: "GPTBot" },
  { pattern: /Claude-User/i, client_class: "ai_agent", family: "Claude-User" },
  { pattern: /claude-code/i, client_class: "ai_agent", family: "Claude-Code" },
  { pattern: /Claude-SearchBot/i, client_class: "ai_agent", family: "Claude-SearchBot" },
  { pattern: /ClaudeBot|anthropic-ai/i, client_class: "ai_agent", family: "ClaudeBot" },
  { pattern: /Perplexity-User/i, client_class: "ai_agent", family: "Perplexity-User" },
  { pattern: /PerplexityBot/i, client_class: "ai_agent", family: "PerplexityBot" },
  { pattern: /Google-Extended/i, client_class: "ai_agent", family: "Google-Extended" },
  { pattern: /Gemini|Google-CloudVertexBot/i, client_class: "ai_agent", family: "Gemini" },
  { pattern: /Applebot-Extended/i, client_class: "ai_agent", family: "Applebot-Extended" },
  { pattern: /meta-externalagent|meta-externalfetcher/i, client_class: "ai_agent", family: "meta-externalagent" },
  { pattern: /Bytespider/i, client_class: "ai_agent", family: "Bytespider" },
  { pattern: /Amazonbot/i, client_class: "ai_agent", family: "Amazonbot" },
  { pattern: /YouBot/i, client_class: "ai_agent", family: "YouBot" },
  { pattern: /cohere-ai|cohere-training-data-crawler/i, client_class: "ai_agent", family: "cohere-ai" },
  { pattern: /CCBot/i, client_class: "ai_agent", family: "CCBot" },
  { pattern: /MistralAI-User/i, client_class: "ai_agent", family: "MistralAI-User" },
  { pattern: /DuckAssistBot/i, client_class: "ai_agent", family: "DuckAssistBot" },
  { pattern: /AI2Bot|Diffbot|Timpibot|ImagesiftBot|Omgilibot|Webzio-Extended|PanguBot|Kangaroo Bot|img2dataset/i, client_class: "ai_agent", family: "other-ai-crawler" },
  { pattern: /Firecrawl|ScrapingBot|BrowserBase|Browserless/i, client_class: "ai_agent", family: "agent-scraper" },

  // --- search_crawler ------------------------------------------------------------------
  { pattern: /Googlebot|Storebot-Google|GoogleOther|AdsBot-Google|Mediapartners-Google/i, client_class: "search_crawler", family: "Googlebot" },
  { pattern: /bingbot|adidxbot|BingPreview|msnbot/i, client_class: "search_crawler", family: "bingbot" },
  { pattern: /Baiduspider/i, client_class: "search_crawler", family: "Baiduspider" },
  { pattern: /YandexBot|YandexImages|YandexAccessibilityBot/i, client_class: "search_crawler", family: "YandexBot" },
  { pattern: /DuckDuckBot|DuckDuckGo-Favicons-Bot/i, client_class: "search_crawler", family: "DuckDuckBot" },
  { pattern: /Slurp/i, client_class: "search_crawler", family: "Slurp" },
  { pattern: /Applebot/i, client_class: "search_crawler", family: "Applebot" },
  { pattern: /PetalBot|Sogou|Exabot|SeznamBot|Qwantify|Naver|Yeti/i, client_class: "search_crawler", family: "other-search" },

  // --- seo_crawler -----------------------------------------------------------------------
  { pattern: /AhrefsBot|AhrefsSiteAudit/i, client_class: "seo_crawler", family: "AhrefsBot" },
  { pattern: /SemrushBot|SiteAuditBot/i, client_class: "seo_crawler", family: "SemrushBot" },
  { pattern: /MJ12bot|Majestic/i, client_class: "seo_crawler", family: "MJ12bot" },
  { pattern: /DotBot|Moz\.com|rogerbot/i, client_class: "seo_crawler", family: "DotBot" },
  { pattern: /DataForSeo|BLEXBot|Barkrowler|SERanking|SEOkicks|Screaming Frog|ZoominfoBot|Linguee|serpstatbot|awario|Semantic/i, client_class: "seo_crawler", family: "other-seo" },

  // --- other_bot -------------------------------------------------------------------------
  // Declared bots that are neither AI, search, nor SEO. Kept out of `unknown` so that
  // `unknown` means "we genuinely cannot tell" rather than "a bot we forgot to list".
  { pattern: /facebookexternalhit|Twitterbot|LinkedInBot|Slackbot|Discordbot|TelegramBot|WhatsApp|Pinterest|redditbot|Embedly|SkypeUriPreview|vkShare/i, client_class: "other_bot", family: "link-preview" },
  { pattern: /UptimeRobot|Pingdom|StatusCake|Site24x7|NewRelicPinger|Better Uptime|betteruptime|Checkly|Datadog|hetrixtool/i, client_class: "other_bot", family: "uptime-monitor" },
  { pattern: /ia_archiver|archive\.org_bot|Wayback|heritrix/i, client_class: "other_bot", family: "archiver" },
  { pattern: /feedly|Feedspot|Feedbin|NewsBlur|Superfeedr|Tiny Tiny RSS|inoreader/i, client_class: "other_bot", family: "feed-reader" },
  { pattern: /Expanse|InternetMeasurement|CensysInspect|masscan|zgrab|Nuclei|l9(explore|tcpid)/i, client_class: "other_bot", family: "scanner" },

  // --- sdk_client -------------------------------------------------------------------------
  // HeadlessChrome carries a full browser UA, so it has to be caught before the engine
  // tokens below or every automated browser session reads as human.
  { pattern: /HeadlessChrome|Puppeteer|Playwright|Selenium|PhantomJS|Cypress/i, client_class: "sdk_client", family: "headless-browser" },
  { pattern: /^curl\/|\bcurl\/[\d.]/i, client_class: "sdk_client", family: "curl" },
  { pattern: /^Wget/i, client_class: "sdk_client", family: "wget" },
  { pattern: /undici/i, client_class: "sdk_client", family: "undici" },
  { pattern: /node-fetch/i, client_class: "sdk_client", family: "node-fetch" },
  { pattern: /axios/i, client_class: "sdk_client", family: "axios" },
  { pattern: /python-httpx|httpx\//i, client_class: "sdk_client", family: "python-httpx" },
  { pattern: /python-requests/i, client_class: "sdk_client", family: "python-requests" },
  { pattern: /aiohttp/i, client_class: "sdk_client", family: "aiohttp" },
  { pattern: /python-urllib|urllib3/i, client_class: "sdk_client", family: "python-urllib" },
  { pattern: /Go-http-client/i, client_class: "sdk_client", family: "go-http-client" },
  { pattern: /okhttp|Apache-HttpClient|^Java\//i, client_class: "sdk_client", family: "java-http" },
  { pattern: /PostmanRuntime|insomnia|HTTPie|RapidAPI/i, client_class: "sdk_client", family: "api-tool" },
  { pattern: /Guzzle|libwww-perl|LWP::|Ruby$|^Ruby\/|rest-client|Faraday/i, client_class: "sdk_client", family: "other-sdk" },
  { pattern: /^Deno\/|^Bun\/|Dart\/|^Elixir|Erlang|\.NET|RestSharp|WinHttp|PowerShell/i, client_class: "sdk_client", family: "other-sdk" },
  { pattern: /openai-python|openai-node|anthropic-sdk|langchain|llama_index|@modelcontextprotocol/i, client_class: "sdk_client", family: "llm-sdk" },

  // --- browser ------------------------------------------------------------------------------
  // Reached only when nothing above matched, so a bot that spoofs a Mozilla UA *and*
  // declares itself in the same string has already been caught by name.
  { pattern: /\bEdg(e|A|iOS)?\//i, client_class: "browser", family: "edge" },
  { pattern: /\bOPR\/|\bOpera\//i, client_class: "browser", family: "opera" },
  { pattern: /\bFirefox\/|\bFxiOS\//i, client_class: "browser", family: "firefox" },
  { pattern: /\bChrome\/|\bCriOS\//i, client_class: "browser", family: "chrome" },
  { pattern: /\bSafari\/|\bAppleWebKit\//i, client_class: "browser", family: "safari" },
];

// A UA that says "bot" without naming itself. Checked after the named rules so that a
// self-declared crawler still lands in its own class, and before the browser rules so a
// Mozilla-shaped generic bot is not counted as a human.
const GENERIC_BOT = /\b(bot|crawler|spider|scraper|crawl)\b|bot\/|\+https?:\/\/[^\s)]*bot/i;

/**
 * Classify a request by User-Agent. Pure: same input, same output, no side effects.
 *
 * The returned `family` is always one of the labels in the rule table (or `unknown`),
 * which is what makes it safe to persist — see the NO PII note at the top of the file.
 */
export function classifyClient(userAgent: string | undefined | null): ClientClassification {
  const ua = typeof userAgent === "string" ? userAgent.trim() : "";
  if (ua.length === 0) return { client_class: "unknown", family: UNKNOWN_FAMILY };

  for (const rule of RULES) {
    if (rule.pattern.test(ua)) {
      // A named browser rule matched, but the string also declares itself a bot. Trust
      // the declaration: a real Chrome does not put "bot" in its User-Agent.
      if (rule.client_class === "browser" && GENERIC_BOT.test(ua)) {
        return { client_class: "other_bot", family: UNKNOWN_FAMILY };
      }
      return { client_class: rule.client_class, family: rule.family };
    }
  }

  if (GENERIC_BOT.test(ua)) return { client_class: "other_bot", family: UNKNOWN_FAMILY };
  return { client_class: "unknown", family: UNKNOWN_FAMILY };
}

// Endpoints that exist to *observe* the service. Requests to them are attributed
// `internal` regardless of User-Agent, because observing the system is not using it —
// and because this is the half of internal attribution that works without anyone
// remembering to set a header during an incident.
const OBSERVABILITY_PATHS = new Set([
  "/api/pageviews",
  "/api/query-log",
  "/api/traffic",
  "/api/metrics",
  "/api/analytics/daily",
  "/api/analytics/history",
  "/api/page-reviews",
  "/health",
]);

export function isObservabilityPath(path: string): boolean {
  if (typeof path !== "string") return false;
  return OBSERVABILITY_PATHS.has(path.split("?")[0]);
}

/**
 * Full attribution for a request: the pure UA classification, overridden to `internal`
 * when the request is one of ours observing the service.
 *
 * Known limit, stated rather than papered over: a bare `curl https://agentdeals.dev/...`
 * from a maintainer is indistinguishable from any other scripted client and lands in
 * `sdk_client`. That is why `ai_agent` — the number we quote — is reported separately
 * from `sdk_client`, and why the headline excludes neither silently.
 */
export function classifyRequest(
  path: string,
  userAgent: string | undefined | null,
): ClientClassification {
  if (isObservabilityPath(path)) {
    return { client_class: "internal", family: "observability" };
  }
  return classifyClient(userAgent);
}

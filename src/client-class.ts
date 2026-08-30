export type ClientClass =
  | "internal"
  | "ai_agent"
  | "search_crawler"
  | "seo_crawler"
  | "other_bot"
  | "sdk_client"
  | "browser"
  | "unknown";

export interface ClientClassification {
  client_class: ClientClass;
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

export const UNKNOWN_FAMILY = "unknown";

interface Rule {
  pattern: RegExp;
  client_class: ClientClass;
  family: string;
}

const RULES: Rule[] = [
  { pattern: /agentdeals-internal|agentdeals-monitor/i, client_class: "internal", family: "agentdeals-internal" },

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

  { pattern: /Googlebot|Storebot-Google|GoogleOther|AdsBot-Google|Mediapartners-Google/i, client_class: "search_crawler", family: "Googlebot" },
  { pattern: /bingbot|adidxbot|BingPreview|msnbot/i, client_class: "search_crawler", family: "bingbot" },
  { pattern: /Baiduspider/i, client_class: "search_crawler", family: "Baiduspider" },
  { pattern: /YandexBot|YandexImages|YandexAccessibilityBot/i, client_class: "search_crawler", family: "YandexBot" },
  { pattern: /DuckDuckBot|DuckDuckGo-Favicons-Bot/i, client_class: "search_crawler", family: "DuckDuckBot" },
  { pattern: /Slurp/i, client_class: "search_crawler", family: "Slurp" },
  { pattern: /Applebot/i, client_class: "search_crawler", family: "Applebot" },
  { pattern: /PetalBot|Sogou|Exabot|SeznamBot|Qwantify|Naver|Yeti/i, client_class: "search_crawler", family: "other-search" },

  { pattern: /AhrefsBot|AhrefsSiteAudit/i, client_class: "seo_crawler", family: "AhrefsBot" },
  { pattern: /SemrushBot|SiteAuditBot/i, client_class: "seo_crawler", family: "SemrushBot" },
  { pattern: /MJ12bot|Majestic/i, client_class: "seo_crawler", family: "MJ12bot" },
  { pattern: /DotBot|Moz\.com|rogerbot/i, client_class: "seo_crawler", family: "DotBot" },
  { pattern: /DataForSeo|BLEXBot|Barkrowler|SERanking|SEOkicks|Screaming Frog|ZoominfoBot|Linguee|serpstatbot|awario|Semantic/i, client_class: "seo_crawler", family: "other-seo" },

  { pattern: /facebookexternalhit|Twitterbot|LinkedInBot|Slackbot|Discordbot|TelegramBot|WhatsApp|Pinterest|redditbot|Embedly|SkypeUriPreview|vkShare/i, client_class: "other_bot", family: "link-preview" },
  { pattern: /UptimeRobot|Pingdom|StatusCake|Site24x7|NewRelicPinger|Better Uptime|betteruptime|Checkly|Datadog|hetrixtool/i, client_class: "other_bot", family: "uptime-monitor" },
  { pattern: /ia_archiver|archive\.org_bot|Wayback|heritrix/i, client_class: "other_bot", family: "archiver" },
  { pattern: /feedly|Feedspot|Feedbin|NewsBlur|Superfeedr|Tiny Tiny RSS|inoreader/i, client_class: "other_bot", family: "feed-reader" },
  { pattern: /Expanse|InternetMeasurement|CensysInspect|masscan|zgrab|Nuclei|l9(explore|tcpid)/i, client_class: "other_bot", family: "scanner" },

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

  { pattern: /\bEdg(e|A|iOS)?\//i, client_class: "browser", family: "edge" },
  { pattern: /\bOPR\/|\bOpera\//i, client_class: "browser", family: "opera" },
  { pattern: /\bFirefox\/|\bFxiOS\//i, client_class: "browser", family: "firefox" },
  { pattern: /\bChrome\/|\bCriOS\//i, client_class: "browser", family: "chrome" },
  { pattern: /\bSafari\/|\bAppleWebKit\//i, client_class: "browser", family: "safari" },
];

const GENERIC_BOT = /\b(bot|crawler|spider|scraper|crawl)\b|bot\/|\+https?:\/\/[^\s)]*bot/i;

export function classifyClient(userAgent: string | undefined | null): ClientClassification {
  const ua = typeof userAgent === "string" ? userAgent.trim() : "";
  if (ua.length === 0) return { client_class: "unknown", family: UNKNOWN_FAMILY };

  for (const rule of RULES) {
    if (rule.pattern.test(ua)) {
      if (rule.client_class === "browser" && GENERIC_BOT.test(ua)) {
        return { client_class: "other_bot", family: UNKNOWN_FAMILY };
      }
      return { client_class: rule.client_class, family: rule.family };
    }
  }

  if (GENERIC_BOT.test(ua)) return { client_class: "other_bot", family: UNKNOWN_FAMILY };
  return { client_class: "unknown", family: UNKNOWN_FAMILY };
}

const OBSERVABILITY_PATHS = new Set([
  "/api/pageviews",
  "/api/query-log",
  "/api/traffic",
  "/api/metrics",
  "/api/analytics/daily",
  "/api/analytics/history",
  "/api/analytics/vendors",
  "/api/page-reviews",
  "/health",
]);

export function isObservabilityPath(path: string): boolean {
  if (typeof path !== "string") return false;
  return OBSERVABILITY_PATHS.has(path.split("?")[0]);
}

export function classifyRequest(
  path: string,
  userAgent: string | undefined | null,
): ClientClassification {
  if (isObservabilityPath(path)) {
    return { client_class: "internal", family: "observability" };
  }
  return classifyClient(userAgent);
}

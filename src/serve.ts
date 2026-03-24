import { createServer as createHttpServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, getServerCard } from "./server.js";
import { loadOffers, getCategories, getNewOffers, getNewestDeals, searchOffers, enrichOffers, loadDealChanges, getDealChanges, getOfferDetails, compareServices, checkVendorRisk, auditStack, getExpiringDeals, getWeeklyDigest, getFreshnessMetrics } from "./data.js";
import { getStackRecommendation } from "./stacks.js";
import { estimateCosts } from "./costs.js";
import { recordApiHit, recordSessionConnect, recordSessionDisconnect, recordLandingPageView, getStats, getConnectionStats, loadTelemetry, flushTelemetry, logRequest, getRequestLog, recordPageView, getPageViews } from "./stats.js";
import { openapiSpec } from "./openapi.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const BASE_URL = (process.env.BASE_URL ?? "https://agentdeals.dev").replace(/\/+$/, "");

const INDEXNOW_KEY = process.env.INDEXNOW_KEY ?? "";

const GOOGLE_VERIFICATION_META = process.env.GOOGLE_SITE_VERIFICATION
  ? `<meta name="google-site-verification" content="${process.env.GOOGLE_SITE_VERIFICATION}">\n` : "";

// Patch OpenAPI spec with BASE_URL
openapiSpec.info.contact.url = BASE_URL;
openapiSpec.servers[0].url = BASE_URL;

// Load favicon from logo PNG at startup
const faviconBuffer = readFileSync(join(__dirname, "..", "assets", "logo-400.png"));

// Load OG image at startup
const ogImageBuffer = readFileSync(join(__dirname, "..", "assets", "og-image.png"));

// OG image meta tags shared across all pages
const OG_IMAGE_META = `<meta property="og:image" content="${BASE_URL}/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${BASE_URL}/og-image.png">
`;

// Swagger UI dist path
const swaggerUiDistPath = join(__dirname, "..", "node_modules", "swagger-ui-dist");

const swaggerDocsHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>AgentDeals API Documentation</title>
  <link rel="stylesheet" href="/api/docs/swagger-ui.css">
  <style>
    html { box-sizing: border-box; }
    *, *:before, *:after { box-sizing: inherit; }
    body { margin: 0; background: #0f172a; color: #f1f5f9; }
    .topbar { display: none; }
    /* Dark theme overrides matching landing page */
    .swagger-ui { background: #0f172a; }
    .swagger-ui .opblock-tag { color: #f1f5f9; border-bottom-color: #334155; }
    .swagger-ui .opblock-tag:hover { background: rgba(59,130,246,0.05); }
    .swagger-ui .opblock-tag small { color: #94a3b8; }
    .swagger-ui .opblock .opblock-summary { border-color: #334155; }
    .swagger-ui .opblock.opblock-get { background: rgba(97,175,254,0.05); border-color: rgba(97,175,254,0.3); }
    .swagger-ui .opblock.opblock-get .opblock-summary { border-color: rgba(97,175,254,0.3); }
    .swagger-ui .opblock.opblock-post { background: rgba(73,204,144,0.05); border-color: rgba(73,204,144,0.3); }
    .swagger-ui .opblock.opblock-post .opblock-summary { border-color: rgba(73,204,144,0.3); }
    .swagger-ui .opblock .opblock-summary-description { color: #94a3b8; }
    .swagger-ui .opblock-body { background: #1e293b; }
    .swagger-ui .opblock-description-wrapper p,
    .swagger-ui .opblock-external-docs-wrapper p { color: #cbd5e1; }
    .swagger-ui table thead tr th { color: #3b82f6; border-bottom-color: #334155; }
    .swagger-ui table tbody tr td { color: #f1f5f9; border-bottom-color: #334155; }
    .swagger-ui .parameter__name { color: #f1f5f9; }
    .swagger-ui .parameter__type { color: #94a3b8; }
    .swagger-ui .parameter__in { color: #94a3b8; }
    .swagger-ui .response-col_status { color: #3b82f6; }
    .swagger-ui .response-col_description { color: #cbd5e1; }
    .swagger-ui .responses-inner { background: #0f172a; }
    .swagger-ui .model-box { background: #1e293b; }
    .swagger-ui .model { color: #f1f5f9; }
    .swagger-ui .model-title { color: #3b82f6; }
    .swagger-ui section.models { border-color: #334155; }
    .swagger-ui section.models h4 { color: #f1f5f9; border-bottom-color: #334155; }
    .swagger-ui .model-container { background: #1e293b; }
    .swagger-ui .prop-type { color: #3b82f6; }
    .swagger-ui .prop-format { color: #94a3b8; }
    .swagger-ui .info .title { color: #f1f5f9; }
    .swagger-ui .info .title small { background: #3b82f6; color: #fff; }
    .swagger-ui .info p, .swagger-ui .info li { color: #cbd5e1; }
    .swagger-ui .info a { color: #3b82f6; }
    .swagger-ui .scheme-container { background: #1e293b; border-bottom-color: #334155; box-shadow: none; }
    .swagger-ui .scheme-container .schemes > label { color: #94a3b8; }
    .swagger-ui select { background: #1e293b; color: #f1f5f9; border-color: #334155; }
    .swagger-ui input[type=text], .swagger-ui textarea { background: #1e293b; color: #f1f5f9; border-color: #334155; }
    .swagger-ui .btn { color: #f1f5f9; border-color: #334155; }
    .swagger-ui .btn.execute { background: #3b82f6; color: #fff; border-color: #3b82f6; }
    .swagger-ui .btn.authorize { color: #3b82f6; border-color: #3b82f6; }
    .swagger-ui .highlight-code { background: #1e293b; }
    .swagger-ui .highlight-code .microlight { color: #f1f5f9; background: #1e293b; }
    .swagger-ui .copy-to-clipboard { background: #1e293b; }
    .swagger-ui .download-contents { color: #3b82f6; }
    .swagger-ui .opblock-body pre.microlight { background: #1e293b !important; color: #f1f5f9; border: 1px solid #334155; }
    .swagger-ui .response-control-media-type__accept-message { color: #3b82f6; }
    .swagger-ui .loading-container .loading::after { color: #3b82f6; }
    /* Back link */
    .back-link { display: block; padding: 12px 20px; background: #1e293b; border-bottom: 1px solid #334155; font-family: 'Inter', sans-serif; font-size: 14px; }
    .back-link a { color: #3b82f6; text-decoration: none; }
    .back-link a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="back-link"><a href="/">&larr; Back to AgentDeals</a></div>
  <div id="swagger-ui"></div>
  <script src="/api/docs/swagger-ui-bundle.js"></script>
  <script src="/api/docs/swagger-ui-standalone-preset.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/api/openapi.json',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      layout: 'StandaloneLayout',
      deepLinking: true,
      defaultModelsExpandDepth: 1,
      syntaxHighlight: { theme: 'monokai' }
    });
  </script>
</body>
</html>`;

const SWAGGER_MIME_TYPES: Record<string, string> = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".png": "image/png",
  ".map": "application/json",
};
const SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // 60 seconds

interface ClientInfo {
  name: string;
  version: string;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
  createdAt: number;
  clientInfo?: ClientInfo;
}

// Map of session ID → transport + last activity for multi-session support
const sessions = new Map<string, SessionEntry>();

function getClientIp(req: import("node:http").IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return String(forwarded).split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

function touchSession(sessionId: string): void {
  const entry = sessions.get(sessionId);
  if (entry) {
    entry.lastActivity = Date.now();
  }
}

// Periodic cleanup of idle sessions
setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of sessions) {
    const idleMs = now - entry.lastActivity;
    if (idleMs > SESSION_IDLE_TIMEOUT_MS) {
      console.log(JSON.stringify({
        event: "session_close",
        ts: new Date(now).toISOString(),
        sessionId: sid,
        durationMs: now - entry.createdAt,
        reason: "idle_timeout",
      }));
      entry.transport.close?.();
      sessions.delete(sid);
      recordSessionDisconnect();
    }
  }
}, CLEANUP_INTERVAL_MS).unref();

// Load cumulative telemetry from Redis or disk (survives deploys)
const telemetryFile = join(__dirname, "..", "data", "telemetry.json");
await loadTelemetry(telemetryFile);

// Build landing page HTML at startup with real stats
const offers = loadOffers();
const categories = getCategories();
const dealChanges = loadDealChanges();
const stats = {
  offers: offers.length,
  categories: categories.length,
  tools: 4,
  dealChanges: dealChanges.length,
};

// Prepare recent deal changes for landing page (5 most recent, sorted newest first)
const recentChanges = [...dealChanges]
  .sort((a, b) => b.date.localeCompare(a.date))
  .slice(0, 5);

// Prepare upcoming deadlines (future dates, soonest first, max 5)
const today = new Date().toISOString().slice(0, 10);
const upcomingDeadlines = [...dealChanges]
  .filter((c) => c.date > today)
  .sort((a, b) => a.date.localeCompare(b.date))
  .slice(0, 5);

const changeTypeBadge: Record<string, { label: string; color: string }> = {
  free_tier_removed: { label: "removed", color: "#f85149" },
  limits_reduced: { label: "reduced", color: "#d29922" },
  limits_increased: { label: "increased", color: "#3fb950" },
  new_free_tier: { label: "new", color: "#58a6ff" },
  pricing_restructured: { label: "restructured", color: "#bc8cff" },
  open_source_killed: { label: "oss killed", color: "#f85149" },
  pricing_model_change: { label: "model change", color: "#d29922" },
  startup_program_expanded: { label: "expanded", color: "#3fb950" },
  pricing_postponed: { label: "postponed", color: "#58a6ff" },
  product_deprecated: { label: "deprecated", color: "#f85149" },
};

function buildChangesHtml(): string {
  return recentChanges.map((c) => {
    const badge = changeTypeBadge[c.change_type] ?? { label: c.change_type, color: "#8b949e" };
    return `      <div class="change-entry">
        <div class="change-header">
          <span class="change-badge" style="background:${badge.color}">${badge.label}</span>
          <span class="change-vendor">${c.vendor}</span>
          <span class="change-date">${c.date}</span>
        </div>
        <div class="change-summary">${c.summary}</div>
      </div>`;
  }).join("\n");
}

function buildDeadlinesHtml(): string {
  if (upcomingDeadlines.length === 0) return "";
  return upcomingDeadlines.map((c) => {
    const badge = changeTypeBadge[c.change_type] ?? { label: c.change_type, color: "#8b949e" };
    const deadlineDate = new Date(c.date + "T00:00:00Z");
    const todayDate = new Date(today + "T00:00:00Z");
    const daysLeft = Math.ceil((deadlineDate.getTime() - todayDate.getTime()) / 86400000);
    const urgentClass = daysLeft <= 14 ? " deadline-urgent" : "";
    const daysLabel = daysLeft === 1 ? "1 day" : `${daysLeft} days`;
    const impactColor = c.impact === "high" ? "#f85149" : c.impact === "medium" ? "#d29922" : "#8b949e";
    return `      <div class="deadline-item${urgentClass}">
        <div class="deadline-left">
          <div class="deadline-countdown" style="border-color:${impactColor}"><span class="deadline-days">${daysLeft}</span><span class="deadline-unit">${daysLeft === 1 ? "day" : "days"}</span></div>
        </div>
        <div class="deadline-right">
          <div class="deadline-header">
            <span class="change-badge" style="background:${badge.color}">${badge.label}</span>
            <span class="change-vendor">${c.vendor}</span>
            <span class="deadline-date">${c.date}</span>
          </div>
          <div class="change-summary">${c.summary}</div>
        </div>
      </div>`;
  }).join("\n");
}

function buildChangingSoonSection(): string {
  if (upcomingDeadlines.length === 0) return "";
  const entries = upcomingDeadlines.slice(0, 5).map((c) => {
    const badge = changeTypeBadge[c.change_type] ?? { label: c.change_type, color: "#8b949e" };
    const vendorSlug = toSlug(c.vendor);
    const deadlineDate = new Date(c.date + "T00:00:00Z");
    const todayDate = new Date(today + "T00:00:00Z");
    const daysLeft = Math.ceil((deadlineDate.getTime() - todayDate.getTime()) / 86400000);
    const relTime = daysLeft === 0 ? "today" : daysLeft === 1 ? "tomorrow" : `in ${daysLeft} days`;
    return `      <div class="cs-entry">
        <div class="cs-countdown${daysLeft <= 14 ? " cs-urgent" : ""}">${daysLeft}<span class="cs-unit">${daysLeft === 1 ? "day" : "days"}</span></div>
        <div class="cs-detail">
          <div class="cs-head">
            <span class="change-badge" style="background:${badge.color}">${badge.label}</span>
            <a href="/vendor/${vendorSlug}" class="cs-vendor">${c.vendor}</a>
            <span class="cs-rel">${relTime}</span>
          </div>
          <div class="cs-summary">${c.summary}</div>
        </div>
      </div>`;
  }).join("\n");
  return `
  <div class="section" id="changing-soon">
    <div class="section-label">Changing Soon</div>
    <h2>Upcoming deal changes</h2>
    <p>Free tiers disappearing, prices increasing. These changes are happening now.</p>
    <div class="cs-list">
${entries}
    </div>
    <a href="/changes" class="see-all-link">View all changes \u2192</a>
  </div>

  <div class="divider"></div>`;
}

function buildRecentChangesSection(): string {
  if (recentChanges.length === 0) return "";
  const entries = recentChanges.map((c) => {
    const badge = changeTypeBadge[c.change_type] ?? { label: c.change_type, color: "#8b949e" };
    const vendorSlug = c.vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return `      <div class="rc-entry">
        <div class="rc-head">
          <span class="change-badge" style="background:${badge.color}">${badge.label}</span>
          <a href="/vendor/${vendorSlug}" class="rc-vendor">${c.vendor}</a>
          <span class="rc-date">${c.date}</span>
        </div>
        <div class="rc-summary">${c.summary}</div>
      </div>`;
  }).join("\n");
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Recent Pricing Changes",
    description: "Latest developer tool pricing changes tracked by AgentDeals",
    numberOfItems: recentChanges.length,
    url: `${BASE_URL}/expiring`,
    itemListElement: recentChanges.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "Article",
        headline: `${c.vendor}: ${(changeTypeBadge[c.change_type] ?? { label: c.change_type }).label}`,
        description: c.summary,
        datePublished: c.date,
        url: `${BASE_URL}/vendor/${c.vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
      },
    })),
  });
  return `
  <div class="divider"></div>

  <div class="section" id="recent-changes">
    <script type="application/ld+json">${jsonLd}</script>
    <div class="section-label">Fresh Intel</div>
    <h2>Recent pricing changes</h2>
    <p>The latest shifts in developer tool pricing \u2014 tracked automatically.</p>
    <div class="rc-list">
${entries}
    </div>
    <a href="/expiring" class="see-all-link">View all changes \u2192</a>
  </div>`;
}

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Build category slug → name lookup
const categorySlugMap = new Map<string, string>();
for (const cat of categories) {
  categorySlugMap.set(toSlug(cat.name), cat.name);
}

// Build vendor slug → name lookup (deduped by slug, first occurrence wins)
const vendorSlugMap = new Map<string, string>();
for (const o of offers) {
  const slug = toSlug(o.vendor);
  if (slug && !vendorSlugMap.has(slug)) {
    vendorSlugMap.set(slug, o.vendor);
  }
}

function escHtmlServer(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type NavSection = "search" | "categories" | "best" | "trends" | "alternatives" | "compare" | "digest" | "changes" | "expiring" | "freshness" | "agent-stack" | "api" | "setup" | "home";

function globalNavCss(): string {
  return `.global-nav{display:flex;align-items:center;gap:.25rem;padding:.75rem 0;border-bottom:1px solid var(--border);margin-bottom:0;overflow-x:auto;white-space:nowrap;-webkit-overflow-scrolling:touch;scrollbar-width:none}
.global-nav::-webkit-scrollbar{display:none}
.global-nav-home{font-family:var(--serif);font-size:1rem;color:var(--text);font-weight:700;margin-right:.5rem;text-decoration:none;letter-spacing:-.01em;flex-shrink:0}
.global-nav-home:hover{color:var(--accent);text-decoration:none}
.nav-link{font-size:.8rem;color:var(--text-muted);padding:.3rem .6rem;border-radius:6px;text-decoration:none;transition:all .15s;flex-shrink:0}
.nav-link:hover{color:var(--text);background:var(--accent-glow);text-decoration:none}
.nav-link.active{color:var(--accent);background:var(--accent-glow);font-weight:600}
@media(max-width:768px){.global-nav{gap:.15rem;padding:.6rem 0}.nav-link{font-size:.75rem;padding:.25rem .45rem}}`;
}

function buildGlobalNav(active: NavSection): string {
  const links: { href: string; label: string; section: NavSection }[] = [
    { href: "/search", label: "Search", section: "search" },
    { href: "/category", label: "Categories", section: "categories" },
    { href: "/best", label: "Best Of", section: "best" },
    { href: "/agent-stack", label: "Agent Stacks", section: "agent-stack" },
    { href: "/trends", label: "Trends", section: "trends" },
    { href: "/alternatives", label: "Alternatives", section: "alternatives" },
    { href: "/compare", label: "Compare", section: "compare" },
    { href: "/digest", label: "Digest", section: "digest" },
    { href: "/changes", label: "Changes", section: "changes" },
    { href: "/expiring", label: "Expiring", section: "expiring" },
    { href: "/freshness", label: "Freshness", section: "freshness" },
    { href: "/api/docs", label: "API", section: "api" },
    { href: "/setup", label: "Setup", section: "setup" },
  ];
  const navLinks = links.map(l =>
    `<a href="${l.href}" class="nav-link${l.section === active ? " active" : ""}">${l.label}</a>`
  ).join("");
  return `<nav class="global-nav"><a href="/" class="global-nav-home">AgentDeals</a>${navLinks}</nav>`;
}

// --- Shared MCP install CTA banner ---

function mcpCtaCss(): string {
  return `.mcp-cta{margin:2rem 0;padding:1.5rem;border:1px solid var(--border);border-radius:12px;background:var(--bg-elevated)}
.mcp-cta h3{font-family:var(--serif);font-size:1.1rem;color:var(--text);margin:0 0 .5rem}
.mcp-cta .cta-value{color:var(--text-muted);font-size:.85rem;margin:0 0 1rem;line-height:1.5}
.mcp-cta .cta-install{position:relative;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:.75rem 1rem;margin-bottom:.75rem;font-family:var(--mono);font-size:.85rem;color:var(--accent);overflow-x:auto;white-space:nowrap}
.mcp-cta .cta-install .copy-btn{position:absolute;top:.5rem;right:.5rem;background:var(--bg-elevated);border:1px solid var(--border);color:var(--text-muted);padding:.2rem .5rem;border-radius:4px;cursor:pointer;font-size:.7rem;font-family:var(--sans);transition:all .15s}
.mcp-cta .cta-install .copy-btn:hover{color:var(--text);border-color:var(--text-dim)}
.mcp-cta .cta-install .copy-btn.copied{color:var(--accent);border-color:var(--accent)}
.mcp-cta .cta-links{font-size:.8rem;color:var(--text-muted)}
.mcp-cta .cta-links a{color:var(--accent);text-decoration:none}
.mcp-cta .cta-links a:hover{text-decoration:underline}
@media(max-width:768px){.mcp-cta{padding:1rem}.mcp-cta .cta-install{font-size:.75rem}}`;
}

function buildMcpCta(context: string): string {
  return `<div class="mcp-cta">
    <h3>Get this data in your AI editor</h3>
    <p class="cta-value">${context}</p>
    <div class="cta-install"><button class="copy-btn" onclick="copyCta(this)">Copy</button><code>claude mcp add agentdeals -- npx -y agentdeals</code></div>
    <p class="cta-links">Works with Claude Desktop, Cursor, Cline, Windsurf &rarr; <a href="/setup">Full setup guide</a></p>
  </div>`;
}

function mcpCtaScript(): string {
  return `function copyCta(btn){var code=btn.parentElement.querySelector('code');if(!code)return;navigator.clipboard.writeText(code.textContent).then(function(){btn.textContent='Copied!';btn.classList.add('copied');setTimeout(function(){btn.textContent='Copy';btn.classList.remove('copied')},2000)})}`;
}

function buildCategoryPage(slug: string): string | null {
  const categoryName = categorySlugMap.get(slug);
  if (!categoryName) return null;

  const catOffers = offers.filter((o) => o.category === categoryName);
  const catCount = catOffers.length;
  const title = `Free ${categoryName} Tools & Deals (${catCount} offers) — AgentDeals`;
  const metaDesc = `Compare ${catCount} free ${categoryName.toLowerCase()} tools, free tiers, and developer deals. Verified pricing for ${catOffers.slice(0, 5).map(o => o.vendor).join(", ")}${catCount > 5 ? " and more" : ""}.`;

  const offersHtml = catOffers.map((o) => `        <tr>
          <td style="font-weight:600;color:var(--text);white-space:nowrap"><a href="/vendor/${toSlug(o.vendor)}" style="color:var(--text)">${escHtmlServer(o.vendor)}</a></td>
          <td style="font-family:var(--mono);color:var(--accent);white-space:nowrap">${escHtmlServer(o.tier)}</td>
          <td style="color:var(--text-muted)">${escHtmlServer(o.description)}</td>
          <td style="font-family:var(--mono);color:var(--text-dim);white-space:nowrap">${escHtmlServer(o.verifiedDate)}</td>
        </tr>`).join("\n");

  // Adjacent categories for navigation
  const sortedCats = categories.map(c => c.name).sort();
  const catIdx = sortedCats.indexOf(categoryName);
  const prevCat = catIdx > 0 ? sortedCats[catIdx - 1] : null;
  const nextCat = catIdx < sortedCats.length - 1 ? sortedCats[catIdx + 1] : null;

  const navLinks = [
    prevCat ? `<a href="/category/${toSlug(prevCat)}" style="color:var(--accent)">&larr; ${escHtmlServer(prevCat)}</a>` : "<span></span>",
    `<a href="/" style="color:var(--accent)">Home</a>`,
    nextCat ? `<a href="/category/${toSlug(nextCat)}" style="color:var(--accent)">${escHtmlServer(nextCat)} &rarr;</a>` : "<span></span>",
  ].join("");

  // All categories list for internal linking
  const allCatLinks = categories.map((c) =>
    c.name === categoryName
      ? `<span style="display:inline-block;padding:.25rem .7rem;border-radius:20px;font-size:.75rem;font-weight:600;background:var(--accent);color:var(--bg)">${escHtmlServer(c.name)} (${c.count})</span>`
      : `<a href="/category/${toSlug(c.name)}" style="display:inline-block;padding:.25rem .7rem;border-radius:20px;font-size:.75rem;color:var(--text-muted);border:1px solid var(--border);text-decoration:none;transition:all .2s">${escHtmlServer(c.name)} (${c.count})</a>`
  ).join("\n        ");

  // JSON-LD structured data
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `Free ${categoryName} Tools`,
    description: metaDesc,
    numberOfItems: catCount,
    itemListElement: catOffers.slice(0, 50).map((o, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "SoftwareApplication",
        name: o.vendor,
        description: o.description,
        applicationCategory: categoryName,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: o.tier },
        url: o.url,
      },
    })),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)}</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/category/${slug}">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/category/${slug}">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
.cat-meta{color:var(--text-muted);margin-bottom:2rem;font-size:.95rem}
.offers-table{width:100%;border-collapse:collapse;margin-bottom:2rem}
.offers-table th{text-align:left;padding:.6rem .75rem;font-size:.7rem;font-weight:600;color:var(--accent);text-transform:uppercase;letter-spacing:.1em;border-bottom:2px solid var(--border);font-family:var(--mono)}
.offers-table td{padding:.6rem .75rem;border-bottom:1px solid rgba(42,39,32,0.6);font-size:.85rem;vertical-align:top}
.offers-table tr:hover{background:var(--accent-glow)}
.cat-nav{display:flex;justify-content:space-between;align-items:center;padding:1.5rem 0;border-top:1px solid var(--border);margin-top:1rem}
.all-cats{margin-top:2rem;padding-top:2rem;border-top:1px solid var(--border)}
.all-cats h2{font-family:var(--serif);font-size:1.25rem;color:var(--text);margin-bottom:1rem}
.all-cats-grid{display:flex;flex-wrap:wrap;gap:.4rem}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.offers-table{font-size:.75rem}.offers-table th,.offers-table td{padding:.4rem .5rem}}
${globalNavCss()}
${mcpCtaCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("categories")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; ${escHtmlServer(categoryName)}</div>
  <h1>Free ${escHtmlServer(categoryName)} Tools</h1>
  <p class="cat-meta">${catCount} verified free tiers and developer deals. Last updated ${new Date().toISOString().split("T")[0]}.</p>

  <table class="offers-table">
    <thead>
      <tr>
        <th>Vendor</th>
        <th>Tier</th>
        <th>Description</th>
        <th>Verified</th>
      </tr>
    </thead>
    <tbody>
${offersHtml}
    </tbody>
  </table>

  <div class="cat-nav">${navLinks}</div>

  <div class="all-cats">
    <h2>All Categories</h2>
    <div class="all-cats-grid">
        ${allCatLinks}
    </div>
  </div>

  ${buildMcpCta("Browse this category from your AI coding assistant. Search 1,500+ deals, compare free tiers, and track pricing changes — directly in your editor.")}
  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
<script>${mcpCtaScript()}</script>
</body>
</html>`;
}

function buildCategoryIndexPage(): string {
  const title = `All Categories (${stats.categories}) — AgentDeals`;
  const metaDesc = `Browse ${stats.categories} categories of free developer tools. ${stats.offers}+ verified free tiers across databases, hosting, monitoring, CI/CD, auth, and more.`;

  const sortedCats = [...categories].sort((a, b) => b.count - a.count);
  const catCardsHtml = sortedCats.map(c => `
      <a href="/category/${toSlug(c.name)}" class="cat-index-card">
        <span class="cat-index-name">${escHtmlServer(c.name)}</span>
        <span class="cat-index-count">${c.count} deals</span>
      </a>`).join("");

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "All Categories",
    description: metaDesc,
    numberOfItems: stats.categories,
    url: `${BASE_URL}/category`,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)}</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/category">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/category">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
.page-meta{color:var(--text-muted);margin-bottom:2rem;font-size:.95rem}
.cat-index-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:.75rem}
.cat-index-card{display:flex;flex-direction:column;padding:1rem 1.25rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);backdrop-filter:blur(10px);transition:all .2s;text-decoration:none}
.cat-index-card:hover{border-color:var(--accent);background:var(--accent-glow);text-decoration:none}
.cat-index-name{color:var(--text);font-weight:600;font-size:.95rem}
.cat-index-count{color:var(--text-dim);font-family:var(--mono);font-size:.8rem;margin-top:.25rem}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.cat-index-grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}}
${globalNavCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("categories")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; Categories</div>
  <h1>All Categories</h1>
  <p class="page-meta">${stats.categories} categories covering ${stats.offers.toLocaleString()}+ free developer tool deals.</p>

  <div class="cat-index-grid">${catCardsHtml}
  </div>

  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
</body>
</html>`;
}

// --- Best-of pages ---

// Minimum category size to generate a best-of page
const BEST_OF_MIN_VENDORS = 5;
const BEST_OF_PICK_COUNT = 8;

// Score vendors for curation: higher = better pick for a "best free" list
function scoreBestOfVendor(offer: ReturnType<typeof enrichOffers>[number]): number {
  let score = 0;
  // Stable pricing (no negative changes) is the strongest signal
  if (offer.risk_level === "stable") score += 2;
  else if (offer.risk_level === "caution") score += 1;
  // Richer description = more useful free tier info
  if (offer.description.length > 80) score += 1;
  else if (offer.description.length > 40) score += 0.5;
  // Recently verified = trustworthy data
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (offer.verifiedDate >= thirtyDaysAgo) score += 1;
  // Not expiring soon
  if (!offer.expires_soon) score += 0.5;
  return score;
}

// Build best-of slug map at startup
const bestOfSlugMap = new Map<string, { categoryName: string; picks: ReturnType<typeof enrichOffers> }>();
for (const cat of categories) {
  const catOffers = offers.filter((o) => o.category === cat.name && !o.eligibility);
  if (catOffers.length < BEST_OF_MIN_VENDORS) continue;
  const enriched = enrichOffers(catOffers);
  const scored = enriched
    .map((o) => ({ offer: o, score: scoreBestOfVendor(o) }))
    .sort((a, b) => b.score - a.score || a.offer.vendor.localeCompare(b.offer.vendor))
    .slice(0, BEST_OF_PICK_COUNT)
    .map((s) => s.offer);
  const slug = `free-${toSlug(cat.name)}`;
  bestOfSlugMap.set(slug, { categoryName: cat.name, picks: scored });
}

function buildBestOfMiniReview(offer: ReturnType<typeof enrichOffers>[number]): string {
  const bestFor: string[] = [];
  const desc = offer.description.toLowerCase();
  if (desc.includes("hobby") || desc.includes("personal")) bestFor.push("personal projects");
  if (desc.includes("startup") || desc.includes("small team")) bestFor.push("startups");
  if (desc.includes("open source") || desc.includes("oss")) bestFor.push("open source projects");
  if (desc.includes("student") || desc.includes("education")) bestFor.push("students");
  if (desc.includes("unlimited") || desc.includes("no limit")) bestFor.push("unlimited usage needs");
  const bestForText = bestFor.length > 0 ? ` Best for ${bestFor.join(" and ")}.` : "";
  const caveat = offer.risk_level === "caution" ? " Note: pricing has changed in the past." : offer.risk_level === "risky" ? " Caution: pricing has changed multiple times." : "";
  return `${escHtmlServer(offer.description)}${bestForText}${caveat}`;
}

function buildBestOfPage(slug: string): string | null {
  const entry = bestOfSlugMap.get(slug);
  if (!entry) return null;
  const { categoryName, picks } = entry;
  const year = new Date().getFullYear();
  const pickCount = picks.length;
  const title = `${pickCount} Best Free ${categoryName} Tools (${year}) — AgentDeals`;
  const metaDesc = `Curated list of the ${pickCount} best free ${categoryName.toLowerCase()} tools for developers in ${year}. Featuring ${picks.slice(0, 3).map(o => o.vendor).join(", ")}${pickCount > 3 ? " and more" : ""}. Verified pricing, stability ratings, and side-by-side comparison.`;

  const riskColors: Record<string, string> = { stable: "#3fb950", caution: "#d29922", risky: "#f85149" };

  // Mini-review cards
  const reviewsHtml = picks.map((o, i) => {
    const riskBadge = o.risk_level ? `<span style="display:inline-block;font-size:.7rem;padding:.15rem .5rem;border-radius:10px;background:${riskColors[o.risk_level]}22;color:${riskColors[o.risk_level]};font-weight:600;margin-left:.5rem">${o.risk_level}</span>` : "";
    const review = buildBestOfMiniReview(o);
    const relatedCompareLinks = Array.from(comparisonMap.entries())
      .filter(([, [a, b]]) => a === o.vendor || b === o.vendor)
      .slice(0, 2)
      .map(([cs]) => `<a href="/compare/${cs}" style="font-size:.75rem;color:var(--accent)">Compare</a>`)
      .join(" ");
    return `      <div class="best-pick">
        <div class="best-pick-rank">${i + 1}</div>
        <div class="best-pick-content">
          <div class="best-pick-header">
            <a href="/vendor/${toSlug(o.vendor)}" class="best-pick-name">${escHtmlServer(o.vendor)}</a>
            ${riskBadge}
          </div>
          <div class="best-pick-tier">${escHtmlServer(o.tier)}</div>
          <p class="best-pick-review">${review}</p>
          <div class="best-pick-links">
            <a href="/vendor/${toSlug(o.vendor)}">Full profile</a>
            <a href="/alternative-to/${toSlug(o.vendor)}">Alternatives</a>
            ${relatedCompareLinks}
            <a href="${escHtmlServer(o.url)}" target="_blank" rel="noopener">Pricing page &nearr;</a>
          </div>
        </div>
      </div>`;
  }).join("\n");

  // Comparison table
  const tableRows = picks.map((o) => `        <tr>
          <td style="font-weight:600"><a href="/vendor/${toSlug(o.vendor)}" style="color:var(--text)">${escHtmlServer(o.vendor)}</a></td>
          <td style="font-family:var(--mono);color:var(--accent)">${escHtmlServer(o.tier)}</td>
          <td style="color:var(--text-muted);max-width:300px">${escHtmlServer(o.description.slice(0, 120))}${o.description.length > 120 ? "..." : ""}</td>
          <td><span style="color:${riskColors[o.risk_level ?? "stable"]}">${o.risk_level ?? "stable"}</span></td>
          <td style="font-family:var(--mono);color:var(--text-dim)">${escHtmlServer(o.verifiedDate)}</td>
        </tr>`).join("\n");

  // JSON-LD structured data (ItemList)
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `Best Free ${categoryName} Tools`,
    description: metaDesc,
    numberOfItems: pickCount,
    itemListElement: picks.map((o, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "SoftwareApplication",
        name: o.vendor,
        description: o.description,
        applicationCategory: categoryName,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: o.tier },
        url: o.url,
      },
    })),
  };

  // Other best-of pages for cross-linking
  const otherBestOf = Array.from(bestOfSlugMap.entries())
    .filter(([s]) => s !== slug)
    .sort((a, b) => b[1].picks.length - a[1].picks.length)
    .slice(0, 10)
    .map(([s, v]) => `<a href="/best/${s}" style="display:inline-block;padding:.25rem .7rem;border-radius:20px;font-size:.75rem;color:var(--text-muted);border:1px solid var(--border);text-decoration:none;transition:all .2s">${escHtmlServer(v.categoryName)}</a>`)
    .join("\n        ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)}</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/best/${slug}">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/best/${slug}">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
h2{font-family:var(--serif);font-size:1.4rem;color:var(--text);margin:2.5rem 0 1rem;letter-spacing:-.01em}
.page-meta{color:var(--text-muted);margin-bottom:1.5rem;font-size:.95rem}
.trust-note{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1rem 1.25rem;margin-bottom:2rem;font-size:.85rem;color:var(--text-muted)}
.trust-note strong{color:var(--text)}
.best-pick{display:flex;gap:1rem;padding:1.25rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);margin-bottom:.75rem;transition:border-color .2s}
.best-pick:hover{border-color:var(--accent)}
.best-pick-rank{font-family:var(--serif);font-size:1.5rem;color:var(--accent);min-width:2rem;text-align:center;padding-top:.15rem}
.best-pick-content{flex:1;min-width:0}
.best-pick-header{display:flex;align-items:center;flex-wrap:wrap;gap:.25rem}
.best-pick-name{font-size:1.1rem;font-weight:600;color:var(--text)}
.best-pick-name:hover{color:var(--accent)}
.best-pick-tier{font-family:var(--mono);color:var(--accent);font-size:.85rem;margin:.25rem 0}
.best-pick-review{color:var(--text-muted);font-size:.9rem;line-height:1.5;margin:.5rem 0}
.best-pick-links{display:flex;flex-wrap:wrap;gap:.75rem;font-size:.8rem;margin-top:.5rem}
.best-pick-links a{color:var(--accent);text-decoration:none}
.best-pick-links a:hover{text-decoration:underline}
.compare-table{width:100%;border-collapse:collapse;margin:1rem 0 2rem}
.compare-table th,.compare-table td{padding:.5rem .75rem;text-align:left;border-bottom:1px solid var(--border);font-size:.85rem}
.compare-table th{color:var(--text-muted);font-weight:500;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
.compare-table tr:hover{background:var(--accent-glow)}
.other-best{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0 2rem}
.other-best a:hover{border-color:var(--accent);color:var(--text);text-decoration:none}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.best-pick{flex-direction:column;gap:.5rem}.best-pick-rank{text-align:left}.compare-table{font-size:.75rem}.compare-table th,.compare-table td{padding:.4rem .5rem}}
${globalNavCss()}
${mcpCtaCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("best")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; <a href="/best">Best Of</a> &rsaquo; ${escHtmlServer(categoryName)}</div>
  <h1>${pickCount} Best Free ${escHtmlServer(categoryName)} Tools</h1>
  <p class="page-meta">Curated from ${offers.filter(o => o.category === categoryName).length} verified free tiers. Updated ${new Date().toISOString().split("T")[0]}.</p>

  <div class="trust-note">
    <strong>Why trust this data?</strong> Every free tier is verified against the vendor's pricing page with dates tracked. We monitor ${dealChanges.length} pricing changes and flag vendors that have reduced or removed free tiers. <a href="/category/${toSlug(categoryName)}">See all ${offers.filter(o => o.category === categoryName).length} ${categoryName.toLowerCase()} offers &rarr;</a>
  </div>

${reviewsHtml}

  <h2>Quick Comparison</h2>
  <table class="compare-table">
    <thead>
      <tr>
        <th>Vendor</th>
        <th>Free Tier</th>
        <th>Key Limits</th>
        <th>Stability</th>
        <th>Verified</th>
      </tr>
    </thead>
    <tbody>
${tableRows}
    </tbody>
  </table>

  <h2>More Best-Of Lists</h2>
  <div class="other-best">
    ${otherBestOf}
  </div>

  ${buildMcpCta("Get personalized recommendations from your AI. Search 1,500+ deals, compare free tiers, and track pricing changes — directly in your editor.")}
  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
<script>${mcpCtaScript()}</script>
</body>
</html>`;
}

function buildBestOfIndexPage(): string {
  const year = new Date().getFullYear();
  const bestOfCount = bestOfSlugMap.size;
  const title = `Best Free Developer Tools (${year}) — AgentDeals`;
  const metaDesc = `Curated "best of" lists for ${bestOfCount} developer tool categories. Top free tiers ranked by generosity, pricing stability, and data quality.`;

  const sortedEntries = Array.from(bestOfSlugMap.entries())
    .sort((a, b) => {
      const countA = offers.filter(o => o.category === a[1].categoryName).length;
      const countB = offers.filter(o => o.category === b[1].categoryName).length;
      return countB - countA;
    });

  const cardsHtml = sortedEntries.map(([slug, entry]) => {
    const totalInCat = offers.filter(o => o.category === entry.categoryName).length;
    const topVendors = entry.picks.slice(0, 3).map(o => o.vendor).join(", ");
    return `
      <a href="/best/${slug}" class="best-index-card">
        <span class="best-index-name">${escHtmlServer(entry.categoryName)}</span>
        <span class="best-index-picks">${entry.picks.length} top picks from ${totalInCat}</span>
        <span class="best-index-vendors">${escHtmlServer(topVendors)}</span>
      </a>`;
  }).join("");

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `Best Free Developer Tools ${year}`,
    description: metaDesc,
    numberOfItems: bestOfCount,
    url: `${BASE_URL}/best`,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)}</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/best">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/best">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
.page-meta{color:var(--text-muted);margin-bottom:2rem;font-size:.95rem}
.best-index-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:.75rem}
.best-index-card{display:flex;flex-direction:column;padding:1rem 1.25rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);backdrop-filter:blur(10px);transition:all .2s;text-decoration:none}
.best-index-card:hover{border-color:var(--accent);background:var(--accent-glow);text-decoration:none}
.best-index-name{color:var(--text);font-weight:600;font-size:.95rem}
.best-index-picks{color:var(--accent);font-family:var(--mono);font-size:.8rem;margin-top:.25rem}
.best-index-vendors{color:var(--text-dim);font-size:.75rem;margin-top:.25rem}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.best-index-grid{grid-template-columns:repeat(auto-fill,minmax(200px,1fr))}}
${globalNavCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("best")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; Best Of</div>
  <h1>Best Free Developer Tools</h1>
  <p class="page-meta">${bestOfCount} curated "best of" lists. Top free tiers ranked by generosity, pricing stability, and verified data.</p>

  <div class="best-index-grid">${cardsHtml}
  </div>

  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
</body>
</html>`;
}

// --- Comparison pages ---

// Define comparison pairs: [vendorA, vendorB] — canonical order is alphabetical
const COMPARISON_PAIRS: [string, string][] = [
  // Cloud Hosting
  ["Netlify", "Vercel"],
  ["Railway", "Render"],
  ["Cloudflare Pages", "Vercel"],
  ["Netlify", "Render"],
  ["Cloudflare Pages", "Netlify"],
  // Databases
  ["Firebase", "Supabase"],
  ["Neon", "Supabase"],
  ["CockroachDB", "Neon"],
  ["MongoDB", "Supabase"],
  ["CockroachDB", "MongoDB"],
  // Monitoring
  ["Datadog", "Grafana Cloud"],
  ["Bugsnag", "Sentry"],
  ["Grafana Cloud", "Sentry"],
  // CI/CD
  ["GitHub Actions", "GitLab CI"],
  ["CircleCI", "GitHub Actions"],
  ["CircleCI", "GitLab CI"],
  // Auth
  ["Auth0", "Clerk"],
  // AI Coding
  ["Cursor", "GitHub Copilot"],
  ["Cursor", "Windsurf"],
  ["Amazon Q Developer", "GitHub Copilot"],
  ["Cline", "Aider"],
  ["Claude Code", "Cursor"],
  ["Cursor", "Devin"],
  ["GitHub Copilot", "Windsurf"],
  ["Augment Code", "Cursor"],
  ["Bolt.new", "Lovable"],
  ["Claude Code", "OpenAI Codex"],
  // Cross-category high-interest
  ["Firebase", "Vercel"],
  ["Railway", "Supabase"],
  ["Netlify", "Railway"],
  ["Render", "Vercel"],
  ["Cloudflare Pages", "Render"],
];

// Build slug for a comparison pair (canonical: alphabetical)
function comparisonSlug(a: string, b: string): string {
  return `${toSlug(a)}-vs-${toSlug(b)}`;
}

// Build lookup maps for comparison pages
const comparisonMap = new Map<string, [string, string]>();
for (const [a, b] of COMPARISON_PAIRS) {
  // Both vendors must exist
  const offerA = offers.find(o => o.vendor === a);
  const offerB = offers.find(o => o.vendor === b);
  if (offerA && offerB) {
    comparisonMap.set(comparisonSlug(a, b), [a, b]);
  }
}

// Group comparisons by category for the index page
function getComparisonsByCategory(): Map<string, Array<{ slug: string; a: string; b: string }>> {
  const byCat = new Map<string, Array<{ slug: string; a: string; b: string }>>();
  for (const [slug, [a, b]] of comparisonMap) {
    const offerA = offers.find(o => o.vendor === a);
    const offerB = offers.find(o => o.vendor === b);
    const cat = offerA && offerB && offerA.category === offerB.category ? offerA.category : "Cross-Category";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push({ slug, a, b });
  }
  return byCat;
}

function buildCompareIndexPage(): string {
  const byCat = getComparisonsByCategory();
  const totalComparisons = comparisonMap.size;
  const title = `Free Tier Comparisons (${totalComparisons} vendor matchups) — AgentDeals`;
  const metaDesc = `Side-by-side free tier comparisons for developer tools. Compare pricing, limits, and stability for ${totalComparisons} vendor pairs across hosting, databases, monitoring, CI/CD, and auth.`;

  const categorySections = Array.from(byCat.entries()).sort((a, b) => {
    if (a[0] === "Cross-Category") return 1;
    if (b[0] === "Cross-Category") return -1;
    return a[0].localeCompare(b[0]);
  }).map(([cat, pairs]) => `
      <div class="compare-category">
        <h2>${escHtmlServer(cat)}</h2>
        <div class="compare-grid">
${pairs.map(p => `          <a href="/compare/${p.slug}" class="compare-card">
            <span class="compare-vs"><span class="compare-name">${escHtmlServer(p.a)}</span> <span class="vs">vs</span> <span class="compare-name">${escHtmlServer(p.b)}</span></span>
          </a>`).join("\n")}
        </div>
      </div>`).join("\n");

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Free Tier Vendor Comparisons",
    description: metaDesc,
    numberOfItems: totalComparisons,
    url: `${BASE_URL}/compare`,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)}</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/compare">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/compare">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
.page-meta{color:var(--text-muted);margin-bottom:2rem;font-size:.95rem}
.compare-category{margin-bottom:2.5rem}
.compare-category h2{font-family:var(--serif);font-size:1.25rem;color:var(--text);margin-bottom:.75rem;padding-bottom:.5rem;border-bottom:1px solid var(--border)}
.compare-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:.75rem}
.compare-card{display:block;padding:.75rem 1rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);backdrop-filter:blur(10px);transition:all .2s;text-decoration:none}
.compare-card:hover{border-color:var(--accent);background:var(--accent-glow);text-decoration:none}
.compare-vs{display:flex;align-items:center;gap:.5rem;font-size:.9rem}
.compare-name{color:var(--text);font-weight:600}
.vs{color:var(--text-dim);font-family:var(--mono);font-size:.75rem;text-transform:uppercase}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.compare-grid{grid-template-columns:1fr}}
${globalNavCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("compare")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; Comparisons</div>
  <h1>Free Tier Comparisons</h1>
  <p class="page-meta">${totalComparisons} side-by-side vendor comparisons. Verified pricing, change history, and risk indicators.</p>
${categorySections}
  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
</body>
</html>`;
}

function buildComparisonPage(slug: string): string | null {
  const pair = comparisonMap.get(slug);
  if (!pair) return null;

  const [vendorA, vendorB] = pair;
  const result = compareServices(vendorA, vendorB);
  if ("error" in result) return null;

  const { vendor_a: a, vendor_b: b } = result.comparison;
  const title = `${a.vendor} vs ${b.vendor} Free Tier Comparison — AgentDeals`;
  const metaDesc = `Compare ${a.vendor} and ${b.vendor} free tiers side by side. Pricing, limits, change history, and risk assessment for developers.`;

  // Risk levels from enriched data
  const riskA = enrichOffers([offers.find(o => o.vendor === a.vendor)!])[0];
  const riskB = enrichOffers([offers.find(o => o.vendor === b.vendor)!])[0];

  const riskBadge = (level: string | null) => {
    const colors: Record<string, string> = { stable: "#3fb950", caution: "#d29922", risky: "#f85149" };
    const color = colors[level ?? ""] ?? "#8b949e";
    return `<span style="display:inline-block;padding:.15rem .5rem;border-radius:12px;font-size:.7rem;font-weight:600;background:${color}20;color:${color};border:1px solid ${color}40">${level ?? "unknown"}</span>`;
  };

  const changesHtml = (changes: typeof a.deal_changes, vendor: string) => {
    if (changes.length === 0) return `<p style="color:var(--text-dim);font-size:.85rem">No recorded pricing changes for ${escHtmlServer(vendor)}.</p>`;
    return changes.sort((x, y) => y.date.localeCompare(x.date)).slice(0, 5).map(c => {
      const badge = changeTypeBadge[c.change_type] ?? { label: c.change_type, color: "#8b949e" };
      return `<div style="margin-bottom:.75rem;padding:.6rem .75rem;border-left:3px solid ${badge.color};background:var(--bg-card);border-radius:0 6px 6px 0">
        <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.25rem">
          <span style="display:inline-block;padding:.1rem .4rem;border-radius:10px;font-size:.65rem;font-weight:600;background:${badge.color};color:#fff">${badge.label}</span>
          <span style="font-family:var(--mono);font-size:.75rem;color:var(--text-dim)">${c.date}</span>
          <span style="font-size:.7rem;color:${c.impact === "high" ? "#f85149" : c.impact === "medium" ? "#d29922" : "#8b949e"}">${c.impact} impact</span>
        </div>
        <div style="font-size:.85rem;color:var(--text-muted)">${escHtmlServer(c.summary)}</div>
      </div>`;
    }).join("\n");
  };

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    description: metaDesc,
    url: `${BASE_URL}/compare/${slug}`,
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: 2,
      itemListElement: [a, b].map((v, i) => ({
        "@type": "ListItem",
        position: i + 1,
        item: {
          "@type": "SoftwareApplication",
          name: v.vendor,
          description: v.description,
          applicationCategory: v.category,
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: v.tier },
          url: v.url,
        },
      })),
    },
  };

  // Related comparisons (share a vendor with this pair)
  const relatedComparisons = Array.from(comparisonMap.entries())
    .filter(([s, [ra, rb]]) => s !== slug && (ra === vendorA || ra === vendorB || rb === vendorA || rb === vendorB))
    .slice(0, 6);

  const relatedHtml = relatedComparisons.length > 0 ? `
  <div class="related">
    <h2>Related Comparisons</h2>
    <div class="related-grid">
${relatedComparisons.map(([s, [ra, rb]]) => `      <a href="/compare/${s}" class="related-card">${escHtmlServer(ra)} vs ${escHtmlServer(rb)}</a>`).join("\n")}
    </div>
  </div>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)}</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/compare/${slug}">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/compare/${slug}">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
.page-meta{color:var(--text-muted);margin-bottom:2rem;font-size:.95rem}
.compare-grid{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;margin-bottom:2rem}
.vendor-col{border:1px solid var(--border);border-radius:12px;padding:1.25rem;background:var(--bg-card);backdrop-filter:blur(10px)}
.vendor-col h2{font-family:var(--serif);font-size:1.25rem;margin-bottom:.75rem;display:flex;align-items:center;gap:.5rem}
.vendor-col h2 a{color:var(--text)}
.detail-row{display:flex;justify-content:space-between;padding:.4rem 0;border-bottom:1px solid rgba(42,39,32,0.4);font-size:.85rem}
.detail-label{color:var(--text-dim);font-family:var(--mono);font-size:.75rem;text-transform:uppercase}
.detail-value{color:var(--text);text-align:right;max-width:60%}
.desc-block{margin-top:.75rem;padding:.75rem;background:var(--bg-elevated);border-radius:8px;font-size:.85rem;color:var(--text-muted);line-height:1.5}
.changes-section{margin-top:2rem}
.changes-section h2{font-family:var(--serif);font-size:1.15rem;color:var(--text);margin-bottom:1rem}
.changes-cols{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem}
.changes-col h3{font-size:.85rem;color:var(--accent);font-family:var(--mono);margin-bottom:.75rem;text-transform:uppercase;letter-spacing:.05em}
.related{margin-top:2rem;padding-top:2rem;border-top:1px solid var(--border)}
.related h2{font-family:var(--serif);font-size:1.15rem;color:var(--text);margin-bottom:.75rem}
.related-grid{display:flex;flex-wrap:wrap;gap:.5rem}
.related-card{display:inline-block;padding:.35rem .75rem;border:1px solid var(--border);border-radius:20px;font-size:.8rem;color:var(--text-muted);transition:all .2s}
.related-card:hover{border-color:var(--accent);color:var(--text);text-decoration:none}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.compare-grid,.changes-cols{grid-template-columns:1fr}}
${mcpCtaCss()}
${globalNavCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("compare")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; <a href="/compare">Comparisons</a> &rsaquo; ${escHtmlServer(a.vendor)} vs ${escHtmlServer(b.vendor)}</div>
  <h1>${escHtmlServer(a.vendor)} vs ${escHtmlServer(b.vendor)}</h1>
  <p class="page-meta">Side-by-side free tier comparison. Last updated ${new Date().toISOString().split("T")[0]}.</p>

  <div class="compare-grid">
    <div class="vendor-col">
      <h2><a href="${escHtmlServer(a.url)}">${escHtmlServer(a.vendor)}</a> ${riskBadge(riskA.risk_level)}</h2>
      <div class="detail-row"><span class="detail-label">Category</span><span class="detail-value">${escHtmlServer(a.category)}</span></div>
      <div class="detail-row"><span class="detail-label">Tier</span><span class="detail-value" style="color:var(--accent)">${escHtmlServer(a.tier)}</span></div>
      <div class="detail-row"><span class="detail-label">Verified</span><span class="detail-value">${escHtmlServer(a.verifiedDate)}</span></div>
      <div class="detail-row"><span class="detail-label">Changes</span><span class="detail-value">${a.deal_changes.length} recorded</span></div>
      <div class="desc-block">${escHtmlServer(a.description)}</div>
    </div>
    <div class="vendor-col">
      <h2><a href="${escHtmlServer(b.url)}">${escHtmlServer(b.vendor)}</a> ${riskBadge(riskB.risk_level)}</h2>
      <div class="detail-row"><span class="detail-label">Category</span><span class="detail-value">${escHtmlServer(b.category)}</span></div>
      <div class="detail-row"><span class="detail-label">Tier</span><span class="detail-value" style="color:var(--accent)">${escHtmlServer(b.tier)}</span></div>
      <div class="detail-row"><span class="detail-label">Verified</span><span class="detail-value">${escHtmlServer(b.verifiedDate)}</span></div>
      <div class="detail-row"><span class="detail-label">Changes</span><span class="detail-value">${b.deal_changes.length} recorded</span></div>
      <div class="desc-block">${escHtmlServer(b.description)}</div>
    </div>
  </div>

  <div class="changes-section">
    <h2>Pricing Change History</h2>
    <div class="changes-cols">
      <div class="changes-col">
        <h3>${escHtmlServer(a.vendor)}</h3>
        ${changesHtml(a.deal_changes, a.vendor)}
      </div>
      <div class="changes-col">
        <h3>${escHtmlServer(b.vendor)}</h3>
        ${changesHtml(b.deal_changes, b.vendor)}
      </div>
    </div>
  </div>
${relatedHtml}
  ${buildMcpCta("Compare any two vendors from your AI coding assistant. Search 1,500+ deals, compare free tiers, and track pricing changes — directly in your editor.")}
  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
<script>${mcpCtaScript()}</script>
</body>
</html>`;
}

// --- Weekly digest pages ---

// ISO 8601 week number calculation
function getISOWeek(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

// Get Monday of a given ISO week
function getWeekStart(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7;
  const firstMonday = new Date(jan4.getTime() - (dayOfWeek - 1) * 86400000);
  return new Date(firstMonday.getTime() + (week - 1) * 7 * 86400000);
}

function formatWeekKey(year: number, week: number): string {
  return `${year}-w${String(week).padStart(2, "0")}`;
}

function parseWeekKey(key: string): { year: number; week: number } | null {
  const m = key.match(/^(\d{4})-w(\d{2})$/);
  if (!m) return null;
  return { year: parseInt(m[1], 10), week: parseInt(m[2], 10) };
}

// Group deal changes by ISO week
function getChangesByWeek(): Map<string, typeof dealChanges> {
  const byWeek = new Map<string, typeof dealChanges>();
  for (const c of dealChanges) {
    const d = new Date(c.date + "T00:00:00Z");
    const { year, week } = getISOWeek(d);
    const key = formatWeekKey(year, week);
    if (!byWeek.has(key)) byWeek.set(key, []);
    byWeek.get(key)!.push(c);
  }
  return byWeek;
}

function formatDateRange(year: number, week: number): string {
  const start = getWeekStart(year, week);
  const end = new Date(start.getTime() + 6 * 86400000);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const startMonth = months[start.getUTCMonth()];
  const endMonth = months[end.getUTCMonth()];
  if (startMonth === endMonth) {
    return `${startMonth} ${start.getUTCDate()}\u2013${end.getUTCDate()}, ${year}`;
  }
  return `${startMonth} ${start.getUTCDate()} \u2013 ${endMonth} ${end.getUTCDate()}, ${year}`;
}

const digestCss = `*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
.page-meta{color:var(--text-muted);margin-bottom:2rem;font-size:.95rem}
.stats-bar{display:flex;flex-wrap:wrap;gap:.75rem;margin-bottom:2rem}
.stat-pill{display:inline-flex;align-items:center;gap:.4rem;padding:.35rem .75rem;border:1px solid var(--border);border-radius:20px;font-size:.8rem;color:var(--text-muted)}
.stat-pill strong{color:var(--text);font-family:var(--mono)}
.impact-section{margin-bottom:2rem}
.impact-section h2{font-family:var(--serif);font-size:1.15rem;margin-bottom:.75rem;padding-bottom:.5rem;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:.5rem}
.impact-dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.change-entry{margin-bottom:.75rem;padding:.75rem 1rem;border-left:3px solid var(--border);background:var(--bg-card);border-radius:0 8px 8px 0;backdrop-filter:blur(10px)}
.change-header{display:flex;align-items:center;gap:.5rem;margin-bottom:.25rem;flex-wrap:wrap}
.change-badge{display:inline-block;padding:.1rem .4rem;border-radius:10px;font-size:.65rem;font-weight:600;color:#fff}
.change-vendor{font-weight:600;font-size:.9rem}
.change-date{font-family:var(--mono);font-size:.75rem;color:var(--text-dim)}
.change-cat{font-size:.7rem;color:var(--text-dim);font-family:var(--mono)}
.change-summary{font-size:.85rem;color:var(--text-muted)}
.rss-cta{margin:2rem 0;padding:1.25rem;border:1px solid var(--accent);border-radius:12px;background:var(--accent-glow);text-align:center}
.rss-cta p{color:var(--text-muted);font-size:.9rem;margin-bottom:.5rem}
.rss-cta a{font-weight:600;font-size:.95rem}
.trending{margin-bottom:2rem}
.trending h2{font-family:var(--serif);font-size:1.15rem;margin-bottom:.75rem;padding-bottom:.5rem;border-bottom:1px solid var(--border)}
.trending-list{display:flex;flex-wrap:wrap;gap:.4rem}
.trending-pill{display:inline-block;padding:.25rem .6rem;border-radius:16px;font-size:.75rem;border:1px solid var(--border);color:var(--text-muted)}
.week-nav{display:flex;justify-content:space-between;padding:1.5rem 0;border-top:1px solid var(--border);margin-top:1rem}
.archive-list{list-style:none}
.archive-list li{padding:.6rem 0;border-bottom:1px solid rgba(42,39,32,0.4)}
.archive-list a{display:flex;justify-content:space-between;align-items:center;text-decoration:none}
.archive-list .week-label{color:var(--text);font-weight:500}
.archive-list .week-count{font-family:var(--mono);color:var(--text-dim);font-size:.85rem}
.empty-msg{text-align:center;padding:3rem;color:var(--text-dim)}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.stats-bar{flex-direction:column}}
${globalNavCss()}`;

function buildDigestPage(weekKey: string): string | null {
  const parsed = parseWeekKey(weekKey);
  if (!parsed) return null;
  const { year, week } = parsed;

  const byWeek = getChangesByWeek();
  const changes = byWeek.get(weekKey) ?? [];
  const dateRange = formatDateRange(year, week);
  const title = `Developer Tool Pricing Changes: ${dateRange} — AgentDeals`;
  const metaDesc = changes.length > 0
    ? `${changes.length} pricing changes tracked for developer tools during ${dateRange}. ${changes.filter(c => c.impact === "high").length} high-impact changes.`
    : `No pricing changes tracked for developer tools during ${dateRange}.`;

  // Stats
  const byType = new Map<string, number>();
  for (const c of changes) {
    byType.set(c.change_type, (byType.get(c.change_type) ?? 0) + 1);
  }

  const statsHtml = changes.length > 0 ? `
  <div class="stats-bar">
    <div class="stat-pill"><strong>${changes.length}</strong> changes</div>
    ${Array.from(byType.entries()).map(([type, count]) => {
      const badge = changeTypeBadge[type] ?? { label: type, color: "#8b949e" };
      return `<div class="stat-pill"><span style="width:8px;height:8px;border-radius:50%;background:${badge.color};display:inline-block"></span> <strong>${count}</strong> ${badge.label}</div>`;
    }).join("\n    ")}
  </div>` : "";

  // Group by impact
  const byImpact: Record<string, typeof changes> = { high: [], medium: [], low: [] };
  for (const c of changes) {
    (byImpact[c.impact] ?? byImpact.low).push(c);
  }

  const impactColors = { high: "#f85149", medium: "#d29922", low: "#8b949e" };
  const impactLabels = { high: "High Impact", medium: "Medium Impact", low: "Low Impact" };

  const changesHtml = changes.length > 0
    ? (["high", "medium", "low"] as const).filter(level => byImpact[level].length > 0).map(level => `
  <div class="impact-section">
    <h2><span class="impact-dot" style="background:${impactColors[level]}"></span> ${impactLabels[level]} (${byImpact[level].length})</h2>
    ${byImpact[level].sort((a, b) => b.date.localeCompare(a.date)).map(c => {
      const badge = changeTypeBadge[c.change_type] ?? { label: c.change_type, color: "#8b949e" };
      return `<div class="change-entry" style="border-left-color:${impactColors[level]}">
      <div class="change-header">
        <span class="change-badge" style="background:${badge.color}">${badge.label}</span>
        <span class="change-vendor">${escHtmlServer(c.vendor)}</span>
        <span class="change-date">${c.date}</span>
        <span class="change-cat">${escHtmlServer(c.category)}</span>
      </div>
      <div class="change-summary">${escHtmlServer(c.summary)}</div>
    </div>`;
    }).join("\n    ")}
  </div>`).join("\n")
    : `<div class="empty-msg"><p>No pricing changes tracked this week.</p><p style="margin-top:.5rem"><a href="/digest/archive">Browse the archive</a> or <a href="/feed.xml">subscribe via RSS</a>.</p></div>`;

  // Trending categories
  const catCounts = new Map<string, number>();
  for (const c of changes) {
    catCounts.set(c.category, (catCounts.get(c.category) ?? 0) + 1);
  }
  const trendingHtml = catCounts.size > 0 ? `
  <div class="trending">
    <h2>Trending Categories</h2>
    <div class="trending-list">
      ${Array.from(catCounts.entries()).sort((a, b) => b[1] - a[1]).map(([cat, n]) =>
        `<span class="trending-pill"><a href="/category/${toSlug(cat)}" style="color:inherit;text-decoration:none">${escHtmlServer(cat)}</a> (${n})</span>`
      ).join("\n      ")}
    </div>
  </div>` : "";

  // Navigation to prev/next week
  const allWeeks = Array.from(byWeek.keys()).sort();
  const idx = allWeeks.indexOf(weekKey);
  const prevWeek = idx > 0 ? allWeeks[idx - 1] : null;
  const nextWeek = idx < allWeeks.length - 1 ? allWeeks[idx + 1] : null;
  // For weeks not in allWeeks, navigate to nearest
  const navHtml = `
  <div class="week-nav">
    ${prevWeek ? `<a href="/digest/${prevWeek}">&larr; ${prevWeek}</a>` : "<span></span>"}
    <a href="/digest/archive">Archive</a>
    ${nextWeek ? `<a href="/digest/${nextWeek}">${nextWeek} &rarr;</a>` : "<span></span>"}
  </div>`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    description: metaDesc,
    url: `${BASE_URL}/digest/${weekKey}`,
    datePublished: getWeekStart(year, week).toISOString().split("T")[0],
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)}</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/digest/${weekKey}">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${BASE_URL}/digest/${weekKey}">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>${digestCss}</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("digest")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; <a href="/digest/archive">Digest</a> &rsaquo; ${weekKey}</div>
  <h1>Pricing Changes: ${dateRange}</h1>
  <p class="page-meta">Week ${week}, ${year}. ${changes.length} change${changes.length !== 1 ? "s" : ""} tracked.</p>
${statsHtml}
${changesHtml}
${trendingHtml}

  <div class="rss-cta">
    <p>Get pricing changes delivered automatically</p>
    <a href="/feed.xml">Subscribe via RSS &rarr;</a>
  </div>
${navHtml}
  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
</body>
</html>`;
}

function buildDigestArchivePage(): string {
  const byWeek = getChangesByWeek();
  const weeks = Array.from(byWeek.entries())
    .sort((a, b) => b[0].localeCompare(a[0])); // newest first
  const title = "Pricing Change Digest Archive — AgentDeals";
  const metaDesc = `Browse ${weeks.length} weeks of developer tool pricing changes. Free tier removals, limit changes, and new deals tracked weekly.`;

  const listHtml = weeks.map(([key, changes]) => {
    const parsed = parseWeekKey(key)!;
    const dateRange = formatDateRange(parsed.year, parsed.week);
    return `<li><a href="/digest/${key}"><span class="week-label">${dateRange}</span><span class="week-count">${changes.length} change${changes.length !== 1 ? "s" : ""}</span></a></li>`;
  }).join("\n    ");

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Pricing Change Digest Archive",
    description: metaDesc,
    url: `${BASE_URL}/digest/archive`,
    numberOfItems: weeks.length,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)}</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/digest/archive">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/digest/archive">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>${digestCss}</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("digest")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; Digest Archive</div>
  <h1>Pricing Change Archive</h1>
  <p class="page-meta">${weeks.length} weeks of developer tool pricing changes tracked.</p>
  <ul class="archive-list">
    ${listHtml}
  </ul>

  <div class="rss-cta">
    <p>Get pricing changes delivered automatically</p>
    <a href="/feed.xml">Subscribe via RSS &rarr;</a>
  </div>

  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
</body>
</html>`;
}

// Get current week key
function getCurrentWeekKey(): string {
  const now = new Date();
  const { year, week } = getISOWeek(now);
  return formatWeekKey(year, week);
}

// Get last N week keys for sitemap
function getRecentWeekKeys(n: number): string[] {
  const byWeek = getChangesByWeek();
  return Array.from(byWeek.keys()).sort().reverse().slice(0, n);
}

// --- Vendor profile pages ---

function buildVendorIndexPage(): string {
  // Group vendors by category
  const byCategory = new Map<string, Array<{ vendor: string; slug: string; tier: string }>>();
  const seen = new Set<string>();
  for (const o of offers) {
    const slug = toSlug(o.vendor);
    if (seen.has(slug)) continue;
    seen.add(slug);
    if (!byCategory.has(o.category)) byCategory.set(o.category, []);
    byCategory.get(o.category)!.push({ vendor: o.vendor, slug, tier: o.tier });
  }
  // Sort categories and vendors within
  const sortedCategories = Array.from(byCategory.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [, vendors] of sortedCategories) {
    vendors.sort((a, b) => a.vendor.localeCompare(b.vendor));
  }

  const totalVendors = vendorSlugMap.size;
  const title = `All Vendors (${totalVendors}) — AgentDeals`;
  const metaDesc = `Browse ${totalVendors} developer tool vendors with free tiers. Pricing details, change history, and risk assessment for each vendor.`;

  const categorySections = sortedCategories.map(([cat, vendors]) => `
      <div class="vendor-category">
        <h2><a href="/category/${toSlug(cat)}">${escHtmlServer(cat)}</a> <span class="cat-count">(${vendors.length})</span></h2>
        <div class="vendor-grid">
${vendors.map(v => `          <a href="/vendor/${v.slug}" class="vendor-card">
            <span class="vendor-name">${escHtmlServer(v.vendor)}</span>
            <span class="vendor-tier">${escHtmlServer(v.tier)}</span>
          </a>`).join("\n")}
        </div>
      </div>`).join("\n");

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "All Vendors",
    description: metaDesc,
    numberOfItems: totalVendors,
    url: `${BASE_URL}/vendor`,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)}</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/vendor">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/vendor">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
.page-meta{color:var(--text-muted);margin-bottom:2rem;font-size:.95rem}
.vendor-category{margin-bottom:2.5rem}
.vendor-category h2{font-family:var(--serif);font-size:1.15rem;color:var(--text);margin-bottom:.75rem;padding-bottom:.5rem;border-bottom:1px solid var(--border)}
.vendor-category h2 a{color:var(--text)}
.cat-count{color:var(--text-dim);font-weight:400;font-size:.85rem}
.vendor-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:.5rem}
.vendor-card{display:block;padding:.5rem .75rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);backdrop-filter:blur(10px);transition:all .2s;text-decoration:none}
.vendor-card:hover{border-color:var(--accent);background:var(--accent-glow);text-decoration:none}
.vendor-name{display:block;color:var(--text);font-weight:600;font-size:.85rem}
.vendor-tier{display:block;color:var(--text-dim);font-family:var(--mono);font-size:.7rem;margin-top:.1rem}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.vendor-grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}}
${globalNavCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("categories")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; Vendors</div>
  <h1>All Vendors</h1>
  <p class="page-meta">${totalVendors} developer tools with free tiers, organized by category.</p>
${categorySections}
  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
</body>
</html>`;
}

function buildVendorPage(slug: string): string | null {
  const vendorName = vendorSlugMap.get(slug);
  if (!vendorName) return null;

  // Get all offers for this vendor (some vendors appear in multiple categories)
  const vendorOffers = offers.filter(o => o.vendor === vendorName);
  if (vendorOffers.length === 0) return null;

  const primary = vendorOffers[0];
  const enriched = enrichOffers([primary])[0];
  const allCategories = [...new Set(vendorOffers.map(o => o.category))];

  // Get deal changes for this vendor
  const allChanges = loadDealChanges();
  const vendorChanges = allChanges
    .filter(c => c.vendor.toLowerCase() === vendorName.toLowerCase())
    .sort((a, b) => b.date.localeCompare(a.date));

  // Risk assessment
  const riskColors: Record<string, string> = { stable: "#3fb950", caution: "#d29922", risky: "#f85149" };
  const riskLevel = enriched.risk_level ?? "stable";
  const riskColor = riskColors[riskLevel] ?? "#8b949e";

  // Alternatives: other vendors in the same primary category
  const alternatives = offers
    .filter(o => o.category === primary.category && o.vendor !== vendorName)
    .slice(0, 12);

  // Comparison pages featuring this vendor
  const vendorComparisons = Array.from(comparisonMap.entries())
    .filter(([, [a, b]]) => a === vendorName || b === vendorName);

  // Title and meta
  const title = `${vendorName} Free Tier & Pricing — AgentDeals`;
  const metaDesc = `${vendorName} free tier details: ${primary.tier}. ${primary.description.slice(0, 120)}${primary.description.length > 120 ? "..." : ""} Verified ${primary.verifiedDate}.`;

  // Changes HTML
  const changesHtml = vendorChanges.length > 0 ? vendorChanges.map(c => {
    const badge = changeTypeBadge[c.change_type] ?? { label: c.change_type, color: "#8b949e" };
    return `<div class="change-item">
        <div class="change-head">
          <span class="badge" style="background:${badge.color}">${badge.label}</span>
          <span class="change-date">${c.date}</span>
          <span class="impact impact-${c.impact}">${c.impact} impact</span>
        </div>
        <div class="change-summary">${escHtmlServer(c.summary)}</div>
        ${c.previous_state && c.current_state ? `<div class="change-detail"><span class="state-label">Before:</span> ${escHtmlServer(c.previous_state)}</div><div class="change-detail"><span class="state-label">After:</span> ${escHtmlServer(c.current_state)}</div>` : ""}
      </div>`;
  }).join("\n") : `<p class="no-changes">No recorded pricing changes for ${escHtmlServer(vendorName)}. This is a good sign — stable pricing.</p>`;

  // Alternatives HTML
  const alternativesHtml = alternatives.length > 0 ? `
  <div class="section">
    <h2>Alternatives in ${escHtmlServer(primary.category)}</h2>
    <div class="alt-grid">
${alternatives.map(a => `      <a href="/vendor/${toSlug(a.vendor)}" class="alt-card">
        <span class="alt-name">${escHtmlServer(a.vendor)}</span>
        <span class="alt-tier">${escHtmlServer(a.tier)}</span>
      </a>`).join("\n")}
    </div>
  </div>` : "";

  // Comparisons HTML
  const comparisonsHtml = vendorComparisons.length > 0 ? `
  <div class="section">
    <h2>Comparisons</h2>
    <div class="compare-links">
${vendorComparisons.map(([s, [a, b]]) => `      <a href="/compare/${s}" class="compare-pill">${escHtmlServer(a)} vs ${escHtmlServer(b)}</a>`).join("\n")}
    </div>
  </div>` : "";

  // MCP snippet
  const mcpSnippet = `{
  "tool": "search_deals",
  "arguments": {
    "query": "${vendorName.replace(/"/g, '\\"')}",
    "limit": 5
  }
}`;

  // JSON-LD structured data
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    description: metaDesc,
    url: `${BASE_URL}/vendor/${slug}`,
    mainEntity: {
      "@type": "SoftwareApplication",
      name: vendorName,
      description: primary.description,
      applicationCategory: primary.category,
      url: primary.url,
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
        description: primary.tier,
      },
    },
  };

  // FAQ data for vendor pages
  const faqFreeAnswer = `Yes, ${vendorName} offers a free tier: ${primary.tier}. ${primary.description.slice(0, 200)}${primary.description.length > 200 ? "..." : ""}`;
  const faqTierAnswer = `${vendorName}'s free tier is called "${primary.tier}". ${primary.description}`;
  const faqReliableAnswer = riskLevel === "stable"
    ? `${vendorName}'s free tier is considered stable. ${vendorChanges.length === 0 ? "There are no recorded pricing changes." : `There ${vendorChanges.length === 1 ? "has been 1 recorded pricing change" : `have been ${vendorChanges.length} recorded pricing changes`}, but the free tier remains available.`}`
    : riskLevel === "caution"
    ? `${vendorName}'s free tier requires caution. There ${vendorChanges.length === 1 ? "has been 1 recorded pricing change" : `have been ${vendorChanges.length} recorded pricing changes`}. ${vendorChanges[0] ? `Most recently: ${vendorChanges[0].summary}` : ""}`
    : `${vendorName}'s free tier is considered risky. There ${vendorChanges.length === 1 ? "has been 1 significant pricing change" : `have been ${vendorChanges.length} significant pricing changes`}. ${vendorChanges[0] ? `Most recently: ${vendorChanges[0].summary}` : ""} Consider alternatives.`;
  const faqCategoryAnswer = `${vendorName} is categorized under ${allCategories.join(", ")} on AgentDeals.${alternatives.length > 0 ? ` Other vendors in ${primary.category} include ${alternatives.slice(0, 5).map(a => a.vendor).join(", ")}.` : ""}`;

  const vendorFaqItems = [
    { q: `Is ${vendorName} free?`, a: faqFreeAnswer },
    { q: `What is ${vendorName}'s free tier?`, a: faqTierAnswer },
    { q: `Is ${vendorName}'s free tier reliable?`, a: faqReliableAnswer },
    { q: `What category is ${vendorName} in?`, a: faqCategoryAnswer },
  ];

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: vendorFaqItems.map(item => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.a,
      },
    })),
  };

  const faqHtml = `
  <div class="section faq-section">
    <h2>Frequently Asked Questions</h2>
    ${vendorFaqItems.map(item => `<details class="faq-item">
      <summary class="faq-q">${escHtmlServer(item.q)}</summary>
      <div class="faq-a">${escHtmlServer(item.a)}</div>
    </details>`).join("\n    ")}
  </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)}</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/vendor/${slug}">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/vendor/${slug}">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<script type="application/ld+json">${JSON.stringify(faqJsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
h1 .risk-badge{font-size:.75rem;font-weight:600;padding:.2rem .6rem;border-radius:12px;vertical-align:middle;margin-left:.5rem}
.page-meta{color:var(--text-muted);margin-bottom:2rem;font-size:.95rem}
.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:2rem}
.detail-card{border:1px solid var(--border);border-radius:12px;padding:1rem 1.25rem;background:var(--bg-card);backdrop-filter:blur(10px)}
.detail-label{font-family:var(--mono);font-size:.7rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.1em;margin-bottom:.25rem}
.detail-value{font-size:.95rem;color:var(--text)}
.desc-block{margin-bottom:2rem;padding:1rem 1.25rem;background:var(--bg-elevated);border-radius:12px;border-left:3px solid var(--accent)}
.desc-block h2{font-family:var(--serif);font-size:1.15rem;margin-bottom:.5rem}
.desc-text{font-size:.9rem;color:var(--text-muted);line-height:1.7}
.section{margin-bottom:2rem;padding-top:1.5rem;border-top:1px solid var(--border)}
.section h2{font-family:var(--serif);font-size:1.15rem;color:var(--text);margin-bottom:1rem}
.change-item{margin-bottom:.75rem;padding:.75rem 1rem;border-left:3px solid var(--border);background:var(--bg-card);border-radius:0 8px 8px 0}
.change-head{display:flex;align-items:center;gap:.5rem;margin-bottom:.3rem;flex-wrap:wrap}
.badge{display:inline-block;padding:.1rem .4rem;border-radius:10px;font-size:.65rem;font-weight:600;color:#fff}
.change-date{font-family:var(--mono);font-size:.75rem;color:var(--text-dim)}
.impact{font-size:.7rem}.impact-high{color:#f85149}.impact-medium{color:#d29922}.impact-low{color:#8b949e}
.change-summary{font-size:.85rem;color:var(--text-muted)}
.change-detail{font-size:.8rem;color:var(--text-dim);margin-top:.25rem}
.state-label{font-family:var(--mono);font-size:.7rem;color:var(--text-dim)}
.no-changes{color:var(--text-dim);font-size:.9rem;font-style:italic}
.alt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:.5rem}
.alt-card{display:block;padding:.5rem .75rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);transition:all .2s;text-decoration:none}
.alt-card:hover{border-color:var(--accent);background:var(--accent-glow);text-decoration:none}
.alt-name{display:block;color:var(--text);font-weight:600;font-size:.85rem}
.alt-tier{display:block;color:var(--text-dim);font-family:var(--mono);font-size:.7rem;margin-top:.1rem}
.compare-links{display:flex;flex-wrap:wrap;gap:.5rem}
.compare-pill{display:inline-block;padding:.35rem .75rem;border:1px solid var(--border);border-radius:20px;font-size:.8rem;color:var(--text-muted);transition:all .2s}
.compare-pill:hover{border-color:var(--accent);color:var(--text);text-decoration:none}
.mcp-section code{display:block;padding:1rem;background:var(--bg-elevated);border-radius:8px;font-family:var(--mono);font-size:.8rem;color:var(--text-muted);white-space:pre;overflow-x:auto;border:1px solid var(--border)}
.cat-pills{display:flex;flex-wrap:wrap;gap:.3rem;margin-top:.25rem}
.cat-pill{display:inline-block;padding:.15rem .5rem;border-radius:12px;font-size:.7rem;font-weight:500;background:var(--accent-glow);color:var(--accent);border:1px solid rgba(59,130,246,0.2)}
.faq-item{border:1px solid var(--border);border-radius:8px;margin-bottom:.5rem;overflow:hidden}
.faq-q{padding:.75rem 1rem;font-weight:600;font-size:.9rem;color:var(--text);cursor:pointer;list-style:none;display:flex;align-items:center;gap:.5rem}
.faq-q::before{content:'▸';color:var(--accent);font-size:.8rem;transition:transform .2s}
details[open] .faq-q::before{transform:rotate(90deg)}
.faq-q:hover{color:var(--accent)}
.faq-a{padding:0 1rem .75rem 1.75rem;font-size:.85rem;color:var(--text-muted);line-height:1.7}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.detail-grid{grid-template-columns:1fr}.alt-grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}}
${globalNavCss()}
${mcpCtaCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("categories")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; <a href="/vendor">Vendors</a> &rsaquo; ${escHtmlServer(vendorName)}</div>
  <h1>${escHtmlServer(vendorName)} <span class="risk-badge" style="background:${riskColor}20;color:${riskColor};border:1px solid ${riskColor}40">${riskLevel}</span></h1>
  <p class="page-meta">Free tier details, pricing history, and alternatives. Last updated ${primary.verifiedDate}.</p>

  <div class="detail-grid">
    <div class="detail-card">
      <div class="detail-label">Tier</div>
      <div class="detail-value" style="color:var(--accent)">${escHtmlServer(primary.tier)}</div>
    </div>
    <div class="detail-card">
      <div class="detail-label">Categor${allCategories.length > 1 ? "ies" : "y"}</div>
      <div class="detail-value">
        <div class="cat-pills">${allCategories.map(c => `<a href="/category/${toSlug(c)}" class="cat-pill">${escHtmlServer(c)}</a>`).join("")}</div>
      </div>
    </div>
    <div class="detail-card">
      <div class="detail-label">Pricing Page</div>
      <div class="detail-value"><a href="${escHtmlServer(primary.url)}" rel="noopener" target="_blank">Visit &rarr;</a></div>
    </div>
    <div class="detail-card">
      <div class="detail-label">Verified</div>
      <div class="detail-value" style="font-family:var(--mono)">${escHtmlServer(primary.verifiedDate)}</div>
    </div>
  </div>

  <div class="desc-block">
    <h2>Free Tier Details</h2>
    <p class="desc-text">${escHtmlServer(primary.description)}</p>
  </div>

  <div class="section">
    <h2>Pricing Change History (${vendorChanges.length} recorded)</h2>
    ${changesHtml}
  </div>
${alternativesHtml}
${comparisonsHtml}
  <div class="section mcp-section">
    <h2>Query via MCP</h2>
    <p style="color:var(--text-muted);font-size:.85rem;margin-bottom:.75rem">Look up ${escHtmlServer(vendorName)} programmatically with the AgentDeals MCP server:</p>
    <code>${escHtmlServer(mcpSnippet)}</code>
  </div>
${faqHtml}
  ${buildMcpCta("Want to compare this vendor in your AI? Search 1,500+ deals, compare free tiers, and track pricing changes — directly in your editor.")}
  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
<script>${mcpCtaScript()}</script>
</body>
</html>`;
}

// --- "Free alternative to X" pages ---

function buildAlternativesPage(slug: string): string | null {
  const vendorName = vendorSlugMap.get(slug);
  if (!vendorName) return null;

  const vendorOffers = offers.filter(o => o.vendor === vendorName);
  if (vendorOffers.length === 0) return null;

  const primary = vendorOffers[0];
  const enriched = enrichOffers([primary])[0];
  const allChanges = loadDealChanges();
  const vendorChanges = allChanges
    .filter(c => c.vendor.toLowerCase() === vendorName.toLowerCase())
    .sort((a, b) => b.date.localeCompare(a.date));

  const riskColors: Record<string, string> = { stable: "#3fb950", caution: "#d29922", risky: "#f85149" };
  const riskLevel = enriched.risk_level ?? "stable";
  const riskColor = riskColors[riskLevel] ?? "#8b949e";

  // Get all categories this vendor belongs to
  const vendorCategories = [...new Set(vendorOffers.map(o => o.category))];

  // Find alternatives across all vendor categories, sorted by stability
  const allAlternatives = offers
    .filter(o => vendorCategories.includes(o.category) && o.vendor !== vendorName);
  // Dedupe by vendor name (some vendors appear in multiple categories)
  const seen = new Set<string>();
  const dedupedAlts: typeof allAlternatives = [];
  for (const a of allAlternatives) {
    if (!seen.has(a.vendor)) {
      seen.add(a.vendor);
      dedupedAlts.push(a);
    }
  }
  // Enrich and sort by stability (stable first, then caution, then risky)
  const enrichedAlts = enrichOffers(dedupedAlts);
  const riskOrder: Record<string, number> = { stable: 0, caution: 1, risky: 2 };
  enrichedAlts.sort((a, b) => (riskOrder[a.risk_level ?? "stable"] ?? 3) - (riskOrder[b.risk_level ?? "stable"] ?? 3));

  // Deal-change-driven alternatives (editorially curated)
  const curatedAltNames = new Set<string>();
  for (const c of vendorChanges) {
    if (c.alternatives && c.alternatives.length > 0) {
      for (const alt of c.alternatives) curatedAltNames.add(alt);
    }
  }
  const curatedAlts = curatedAltNames.size > 0
    ? enrichedAlts.filter(a => curatedAltNames.has(a.vendor))
    : [];

  // Title and meta
  const title = `Free Alternatives to ${vendorName} — AgentDeals`;
  const metaDesc = `Compare ${enrichedAlts.length} free alternatives to ${vendorName}. ${vendorChanges.length > 0 ? `${vendorName} has ${vendorChanges.length} recorded pricing change${vendorChanges.length > 1 ? "s" : ""}. ` : ""}Find stable, verified free-tier tools.`;

  // Situation section: why look for alternatives
  const situationHtml = (() => {
    const parts: string[] = [];
    parts.push(`<div class="risk-row"><span class="risk-label">Risk Level:</span> <span class="risk-badge-inline" style="background:${riskColor}20;color:${riskColor};border:1px solid ${riskColor}40">${riskLevel}</span></div>`);
    parts.push(`<div class="risk-row"><span class="risk-label">Category:</span> ${vendorCategories.map(c => `<a href="/category/${toSlug(c)}" class="cat-pill">${escHtmlServer(c)}</a>`).join(" ")}</div>`);
    parts.push(`<div class="risk-row"><span class="risk-label">Pricing Page:</span> <a href="${escHtmlServer(primary.url)}" rel="noopener" target="_blank">${escHtmlServer(primary.url.replace(/^https?:\/\//, "").slice(0, 50))}${primary.url.replace(/^https?:\/\//, "").length > 50 ? "..." : ""}</a></div>`);
    if (vendorChanges.length > 0) {
      parts.push(`<div class="changes-summary"><h3>Recent Pricing Changes (${vendorChanges.length})</h3>`);
      parts.push(vendorChanges.slice(0, 5).map(c => {
        const badge = changeTypeBadge[c.change_type] ?? { label: c.change_type, color: "#8b949e" };
        return `<div class="change-item">
          <div class="change-head">
            <span class="badge" style="background:${badge.color}">${badge.label}</span>
            <span class="change-date">${c.date}</span>
            <span class="impact impact-${c.impact}">${c.impact} impact</span>
          </div>
          <div class="change-summary">${escHtmlServer(c.summary)}</div>
        </div>`;
      }).join("\n"));
      if (vendorChanges.length > 5) {
        parts.push(`<p class="more-link"><a href="/vendor/${slug}">See all ${vendorChanges.length} changes &rarr;</a></p>`);
      }
      parts.push("</div>");
    }
    return parts.join("\n");
  })();

  // Build alternative cards
  const vName = vendorName; // narrowed for closure
  function altCard(a: typeof enrichedAlts[0], curated: boolean): string {
    const aRisk = a.risk_level ?? "stable";
    const aRiskColor = riskColors[aRisk] ?? "#8b949e";
    const aSlug = toSlug(a.vendor);
    const compSlug = comparisonSlug(vName < a.vendor ? vName : a.vendor, vName < a.vendor ? a.vendor : vName);
    const hasComparison = comparisonMap.has(compSlug);
    return `<div class="alt-row${curated ? " curated" : ""}">
        <div class="alt-info">
          <a href="/vendor/${aSlug}" class="alt-vendor-name">${escHtmlServer(a.vendor)}</a>
          <span class="risk-badge-sm" style="background:${aRiskColor}20;color:${aRiskColor};border:1px solid ${aRiskColor}40">${aRisk}</span>
          ${curated ? '<span class="curated-badge">recommended</span>' : ""}
        </div>
        <div class="alt-tier">${escHtmlServer(a.tier)}</div>
        <div class="alt-meta">
          <span class="alt-category">${escHtmlServer(a.category)}</span>
          <span class="alt-date">Verified ${a.verifiedDate}</span>
        </div>
        <div class="alt-actions">
          <a href="/vendor/${aSlug}" class="action-link">Profile</a>
          ${hasComparison ? `<a href="/compare/${compSlug}" class="action-link">Compare</a>` : ""}
        </div>
      </div>`;
  }

  // Curated alternatives section
  const curatedHtml = curatedAlts.length > 0 ? `
  <div class="section">
    <h2>Recommended Migration Targets</h2>
    <p class="section-note">These alternatives were identified from ${escHtmlServer(vendorName)}&rsquo;s pricing changes as recommended replacements.</p>
    <div class="alt-list">
${curatedAlts.map(a => altCard(a, true)).join("\n")}
    </div>
  </div>` : "";

  // All alternatives section
  const allAltsHtml = enrichedAlts.length > 0 ? `
  <div class="section">
    <h2>All Free Alternatives (${enrichedAlts.length})</h2>
    <p class="section-note">Sorted by stability &mdash; most stable first.</p>
    <div class="alt-list">
${enrichedAlts.map(a => altCard(a, false)).join("\n")}
    </div>
  </div>` : `<div class="section"><p class="no-changes">No alternatives found for ${escHtmlServer(vendorName)}.</p></div>`;

  // Category trends link
  const trendsHtml = vendorCategories.map(c =>
    `<a href="/trends/${toSlug(c)}" class="action-pill">&#x2191; ${escHtmlServer(c)} Pricing Trends</a>`
  ).join(" ");

  // JSON-LD structured data
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: title,
    description: metaDesc,
    url: `${BASE_URL}/alternative-to/${slug}`,
    numberOfItems: enrichedAlts.length,
    itemListElement: enrichedAlts.slice(0, 50).map((a, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "SoftwareApplication",
        name: a.vendor,
        description: a.description,
        applicationCategory: a.category,
        url: a.url,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: a.tier },
      },
    })),
  };

  // FAQ data for alternative-to pages
  const topStableAlts = enrichedAlts.filter(a => (a.risk_level ?? "stable") === "stable").slice(0, 5);
  const faqBestAltsAnswer = topStableAlts.length > 0
    ? `The best free alternatives to ${vendorName} include ${topStableAlts.map(a => `${a.vendor} (${a.tier})`).join(", ")}. All have stable pricing with no recent changes.`
    : `There are ${enrichedAlts.length} free alternatives to ${vendorName} available. ${enrichedAlts.slice(0, 3).map(a => a.vendor).join(", ")} are among the options.`;
  const faqFreeTierAnswer = riskLevel === "stable"
    ? `Yes, ${vendorName} currently offers a free tier (${primary.tier}). ${vendorChanges.length === 0 ? "No pricing changes have been recorded." : `However, there ${vendorChanges.length === 1 ? "has been 1 pricing change" : `have been ${vendorChanges.length} pricing changes`} on record.`}`
    : riskLevel === "caution"
    ? `${vendorName} has a free tier (${primary.tier}), but it's flagged as "caution" due to ${vendorChanges.length} recorded pricing change${vendorChanges.length !== 1 ? "s" : ""}. ${vendorChanges[0] ? vendorChanges[0].summary : ""}`
    : `${vendorName}'s free tier (${primary.tier}) is considered risky. ${vendorChanges[0] ? vendorChanges[0].summary : ""} Consider migrating to a more stable alternative.`;
  const faqCountAnswer = `There are ${enrichedAlts.length} free alternatives to ${vendorName} tracked on AgentDeals across the ${vendorCategories.join(", ")} categor${vendorCategories.length > 1 ? "ies" : "y"}.`;
  const faqChangesAnswer = vendorChanges.length > 0
    ? `Yes, ${vendorName} has ${vendorChanges.length} recorded pricing change${vendorChanges.length !== 1 ? "s" : ""}. The most recent was on ${vendorChanges[0].date}: ${vendorChanges[0].summary}`
    : `No, ${vendorName} has no recorded pricing changes on AgentDeals. This indicates stable pricing.`;

  const altFaqItems = [
    { q: `What are the best free alternatives to ${vendorName}?`, a: faqBestAltsAnswer },
    { q: `Is ${vendorName}'s free tier still available?`, a: faqFreeTierAnswer },
    { q: `How many free alternatives to ${vendorName} exist?`, a: faqCountAnswer },
    { q: `Has ${vendorName} changed their pricing recently?`, a: faqChangesAnswer },
  ];

  const altFaqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: altFaqItems.map(item => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.a,
      },
    })),
  };

  const altFaqHtml = `
  <div class="section faq-section">
    <h2>Frequently Asked Questions</h2>
    ${altFaqItems.map(item => `<details class="faq-item">
      <summary class="faq-q">${escHtmlServer(item.q)}</summary>
      <div class="faq-a">${escHtmlServer(item.a)}</div>
    </details>`).join("\n    ")}
  </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)}</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/alternative-to/${slug}">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/alternative-to/${slug}">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<script type="application/ld+json">${JSON.stringify(altFaqJsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
h2{font-family:var(--serif);font-size:1.15rem;color:var(--text);margin-bottom:1rem}
h3{font-family:var(--serif);font-size:1rem;color:var(--text);margin-bottom:.5rem}
.page-meta{color:var(--text-muted);margin-bottom:2rem;font-size:.95rem}
.situation-box{margin-bottom:2rem;padding:1.25rem;background:var(--bg-elevated);border-radius:12px;border-left:3px solid ${riskColor}}
.risk-row{margin-bottom:.5rem;font-size:.9rem;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.risk-label{font-family:var(--mono);font-size:.7rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.1em;min-width:100px}
.risk-badge-inline{display:inline-block;padding:.1rem .5rem;border-radius:10px;font-size:.7rem;font-weight:600}
.cat-pill{display:inline-block;padding:.15rem .5rem;border-radius:12px;font-size:.7rem;font-weight:500;background:var(--accent-glow);color:var(--accent);border:1px solid rgba(59,130,246,0.2)}
.changes-summary{margin-top:1rem;padding-top:1rem;border-top:1px solid var(--border)}
.change-item{margin-bottom:.5rem;padding:.5rem .75rem;border-left:3px solid var(--border);background:var(--bg-card);border-radius:0 8px 8px 0}
.change-head{display:flex;align-items:center;gap:.5rem;margin-bottom:.2rem;flex-wrap:wrap}
.badge{display:inline-block;padding:.1rem .4rem;border-radius:10px;font-size:.65rem;font-weight:600;color:#fff}
.change-date{font-family:var(--mono);font-size:.75rem;color:var(--text-dim)}
.impact{font-size:.7rem}.impact-high{color:#f85149}.impact-medium{color:#d29922}.impact-low{color:#8b949e}
.change-summary{font-size:.85rem;color:var(--text-muted)}
.more-link{font-size:.85rem;margin-top:.5rem}
.section{margin-bottom:2rem;padding-top:1.5rem;border-top:1px solid var(--border)}
.section-note{color:var(--text-dim);font-size:.85rem;margin-bottom:1rem}
.alt-list{display:flex;flex-direction:column;gap:.5rem}
.alt-row{padding:.75rem 1rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);transition:border-color .2s}
.alt-row:hover{border-color:var(--accent)}
.alt-row.curated{border-left:3px solid #3fb950}
.alt-info{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.25rem}
.alt-vendor-name{font-weight:600;font-size:.95rem;color:var(--text)}
.alt-vendor-name:hover{color:var(--accent-hover);text-decoration:none}
.risk-badge-sm{display:inline-block;padding:.05rem .35rem;border-radius:8px;font-size:.6rem;font-weight:600}
.curated-badge{display:inline-block;padding:.05rem .4rem;border-radius:8px;font-size:.6rem;font-weight:600;background:rgba(63,185,80,0.15);color:#3fb950;border:1px solid rgba(63,185,80,0.3)}
.alt-tier{font-family:var(--mono);font-size:.8rem;color:var(--text-muted);margin-bottom:.25rem}
.alt-meta{display:flex;gap:1rem;font-size:.75rem;color:var(--text-dim);margin-bottom:.25rem}
.alt-actions{display:flex;gap:.5rem}
.action-link{display:inline-block;padding:.2rem .5rem;border:1px solid var(--border);border-radius:6px;font-size:.75rem;color:var(--text-muted);transition:all .2s}
.action-link:hover{border-color:var(--accent);color:var(--text);text-decoration:none}
.action-pill{display:inline-block;padding:.35rem .75rem;border:1px solid var(--border);border-radius:20px;font-size:.8rem;color:var(--text-muted);transition:all .2s}
.action-pill:hover{border-color:var(--accent);color:var(--text);text-decoration:none}
.no-changes{color:var(--text-dim);font-size:.9rem;font-style:italic}
.faq-item{border:1px solid var(--border);border-radius:8px;margin-bottom:.5rem;overflow:hidden}
.faq-q{padding:.75rem 1rem;font-weight:600;font-size:.9rem;color:var(--text);cursor:pointer;list-style:none;display:flex;align-items:center;gap:.5rem}
.faq-q::before{content:'▸';color:var(--accent);font-size:.8rem;transition:transform .2s}
details[open] .faq-q::before{transform:rotate(90deg)}
.faq-q:hover{color:var(--accent)}
.faq-a{padding:0 1rem .75rem 1.75rem;font-size:.85rem;color:var(--text-muted);line-height:1.7}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.risk-row{flex-direction:column;align-items:flex-start;gap:.25rem}.alt-meta{flex-direction:column;gap:.25rem}}
${globalNavCss()}
${mcpCtaCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("alternatives")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; <a href="/alternative-to">Alternatives</a> &rsaquo; ${escHtmlServer(vendorName)}</div>
  <h1>Free Alternatives to ${escHtmlServer(vendorName)}</h1>
  <p class="page-meta">${enrichedAlts.length} free alternative${enrichedAlts.length !== 1 ? "s" : ""} available. Sorted by pricing stability.</p>

  <div class="situation-box">
    <h2>Current ${escHtmlServer(vendorName)} Situation</h2>
    ${situationHtml}
  </div>
${(() => {
    const editorial = editorialByVendor.get(vendorName.toLowerCase());
    if (!editorial) return "";
    return `  <div class="editorial-cta" style="background:var(--accent-glow);border:1px solid rgba(59,130,246,0.3);border-radius:8px;padding:1rem 1.25rem;margin-bottom:2rem;font-size:.9rem">
    <strong style="color:var(--accent)">\u{1F4D6} In-depth migration guide available</strong>
    <p style="margin:.25rem 0 0;color:var(--text-muted)">Read our detailed <a href="/${editorial.slug}">${escHtmlServer(editorial.title.split(" — ")[0])}</a> guide with curated recommendations and service comparison.</p>
  </div>`;
  })()}
${curatedHtml}
${allAltsHtml}
  <div class="section">
    <h2>Category Trends</h2>
    <p class="section-note">See the broader pricing landscape for ${vendorCategories.length > 1 ? "these categories" : "this category"}.</p>
    ${trendsHtml}
  </div>
${altFaqHtml}
  ${buildMcpCta("Find alternatives from your AI coding assistant. Search 1,500+ deals, compare free tiers, and track pricing changes — directly in your editor.")}
  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
<script>${mcpCtaScript()}</script>
</body>
</html>`;
}

function buildAlternativesIndexPage(): string {
  const allChanges = loadDealChanges();

  // Identify vendors with strongest "look elsewhere" signals
  // Priority: vendors with deal changes indicating negative trends, or risky ratings
  const vendorSignals = new Map<string, { changes: number; negative: number; riskLevel: string; categories: string[] }>();

  for (const o of offers) {
    if (!vendorSignals.has(o.vendor)) {
      const enriched = enrichOffers([o])[0];
      vendorSignals.set(o.vendor, { changes: 0, negative: 0, riskLevel: enriched.risk_level ?? "stable", categories: [] });
    }
    const sig = vendorSignals.get(o.vendor)!;
    if (!sig.categories.includes(o.category)) sig.categories.push(o.category);
  }

  for (const c of allChanges) {
    const sig = vendorSignals.get(c.vendor);
    if (sig) {
      sig.changes++;
      if (["free_tier_removed", "limits_reduced", "restriction", "open_source_killed", "product_deprecated"].includes(c.change_type)) {
        sig.negative++;
      }
    }
  }

  // Score: risky=3, caution=2, stable=0, +2 per negative change, +1 per other change
  const scored = Array.from(vendorSignals.entries()).map(([vendor, sig]) => {
    const riskScore = sig.riskLevel === "risky" ? 3 : sig.riskLevel === "caution" ? 2 : 0;
    const score = riskScore + sig.negative * 2 + (sig.changes - sig.negative);
    return { vendor, score, ...sig };
  }).filter(v => v.score > 0).sort((a, b) => b.score - a.score);

  const riskColors: Record<string, string> = { stable: "#3fb950", caution: "#d29922", risky: "#f85149" };

  const title = "Free Alternatives to Popular Tools — AgentDeals";
  const metaDesc = `Browse free alternatives to ${scored.length} developer tools. Find stable replacements when vendors raise prices, remove free tiers, or reduce limits.`;

  const vendorListHtml = scored.map(v => {
    const rc = riskColors[v.riskLevel] ?? "#8b949e";
    return `<a href="/alternative-to/${toSlug(v.vendor)}" class="idx-row">
        <span class="idx-vendor">${escHtmlServer(v.vendor)}</span>
        <span class="risk-badge-sm" style="background:${rc}20;color:${rc};border:1px solid ${rc}40">${v.riskLevel}</span>
        <span class="idx-changes">${v.changes} change${v.changes !== 1 ? "s" : ""}</span>
        <span class="idx-cats">${v.categories.slice(0, 2).map(c => escHtmlServer(c)).join(", ")}${v.categories.length > 2 ? "..." : ""}</span>
      </a>`;
  }).join("\n");

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: title,
    description: metaDesc,
    url: `${BASE_URL}/alternative-to`,
    numberOfItems: scored.length,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)}</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/alternative-to">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/alternative-to">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
.page-meta{color:var(--text-muted);margin-bottom:2rem;font-size:.95rem}
.idx-list{display:flex;flex-direction:column;gap:.4rem}
.idx-row{display:flex;align-items:center;gap:.75rem;padding:.6rem 1rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);transition:border-color .2s;text-decoration:none;flex-wrap:wrap}
.idx-row:hover{border-color:var(--accent);text-decoration:none}
.idx-vendor{font-weight:600;color:var(--text);min-width:160px}
.risk-badge-sm{display:inline-block;padding:.05rem .35rem;border-radius:8px;font-size:.6rem;font-weight:600}
.idx-changes{font-family:var(--mono);font-size:.75rem;color:var(--text-dim);min-width:80px}
.idx-cats{font-size:.75rem;color:var(--text-dim)}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.idx-row{flex-direction:column;align-items:flex-start;gap:.25rem}}
${globalNavCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("alternatives")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; Alternatives</div>
  <h1>Free Alternatives to Popular Tools</h1>
  <p class="page-meta">${scored.length} vendors with pricing changes or elevated risk. Click any vendor to see free alternatives.</p>

  <div class="idx-list">
${vendorListHtml}
  </div>

  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
</body>
</html>`;
}

// --- Timely alternatives pages ---

interface AlternativesPageConfig {
  slug: string;
  title: string;
  metaDesc: string;
  contextHtml: string;
  tag: string;
  primaryVendor: string;
  serviceMatrixHtml?: string;
  hubDesc: string; // One-line description for the /alternatives hub page and cross-links
}

const ALTERNATIVES_PAGES: AlternativesPageConfig[] = [
  {
    slug: "localstack-alternatives",
    title: "LocalStack CE Alternatives — Free and Open Source Options for 2026",
    metaDesc: "LocalStack Community Edition shuts down March 23, 2026. Compare free alternatives: Floci, Vera AWS, Moto, Testcontainers, MinIO, AWS SAM CLI, DynamoDB Local, ElasticMQ. Service coverage comparison.",
    contextHtml: `<p><strong>LocalStack Community Edition</strong> — the open-source AWS cloud emulator that let developers run S3, Lambda, DynamoDB, SQS, and 30+ other AWS services locally — <strong>shuts down on March 23, 2026</strong>. The unified Docker image now requires registration and an auth token. Commercial use requires a paid plan starting at $39/month (Starter) or $89/month (Ultimate).</p>
      <p><strong>Floci</strong> has emerged as the primary community-recommended replacement — an MIT-licensed emulator supporting 20+ AWS services in a 90 MB Docker image with 24ms startup. For more specialized needs, there are also service-specific tools. Below are the best free and open-source alternatives, organized by which AWS services they replace.</p>`,
    tag: "localstack-alternative",
    primaryVendor: "LocalStack",
    hubDesc: "LocalStack CE shuts down March 23, 2026 — compare 9 free open-source AWS emulators",
    serviceMatrixHtml: `
  <h2>AWS Service Coverage Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Which AWS services each alternative covers. LocalStack CE supported 30+ services in a single tool — migration typically means combining 2-3 specialized alternatives.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Tool</th>
        <th>S3</th>
        <th>DynamoDB</th>
        <th>Lambda</th>
        <th>SQS</th>
        <th>SNS</th>
        <th>API GW</th>
        <th>IAM</th>
        <th>EC2</th>
        <th>License</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600;color:var(--text-dim)">LocalStack CE</td>
        <td>\u2705</td><td>\u2705</td><td>\u2705</td><td>\u2705</td><td>\u2705</td><td>\u2705</td><td>\u2705</td><td>\u2705</td>
        <td style="color:var(--text-dim)">Discontinued</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/floci" style="color:var(--text)">Floci</a></td>
        <td>\u2705</td><td>\u2705</td><td>\u2705</td><td>\u2705</td><td>\u2705</td><td>\u2705</td><td>\u2705</td><td>\u2705</td>
        <td>MIT</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/moto" style="color:var(--text)">Moto</a></td>
        <td>\u2705</td><td>\u2705</td><td>\u2705</td><td>\u2705</td><td>\u2705</td><td>\u2705</td><td>\u2705</td><td>\u2705</td>
        <td>Apache-2.0</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/minio" style="color:var(--text)">MinIO</a></td>
        <td>\u2705</td><td>\u2014</td><td>\u2014</td><td>\u2014</td><td>\u2014</td><td>\u2014</td><td>\u2014</td><td>\u2014</td>
        <td>AGPL v3</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/dynamodb-local" style="color:var(--text)">DynamoDB Local</a></td>
        <td>\u2014</td><td>\u2705</td><td>\u2014</td><td>\u2014</td><td>\u2014</td><td>\u2014</td><td>\u2014</td><td>\u2014</td>
        <td>Free (AWS)</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/aws-sam-cli" style="color:var(--text)">AWS SAM CLI</a></td>
        <td>\u2014</td><td>\u2014</td><td>\u2705</td><td>\u2014</td><td>\u2014</td><td>\u2705</td><td>\u2014</td><td>\u2014</td>
        <td>Apache-2.0</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/elasticmq" style="color:var(--text)">ElasticMQ</a></td>
        <td>\u2014</td><td>\u2014</td><td>\u2014</td><td>\u2705</td><td>\u2014</td><td>\u2014</td><td>\u2014</td><td>\u2014</td>
        <td>Apache-2.0</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/testcontainers" style="color:var(--text)">Testcontainers</a></td>
        <td>\u2705</td><td>\u2705</td><td>\u2705</td><td>\u2705</td><td>\u2705</td><td>\u2705</td><td>\u2705</td><td>\u2705</td>
        <td>MIT</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/vera-aws" style="color:var(--text)">Vera AWS</a></td>
        <td>\u2014</td><td>\u2014</td><td>\u2014</td><td>\u2014</td><td>\u2014</td><td>\u2014</td><td>\u2014</td><td>\u2705</td>
        <td>Open Source</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">\u2705 = supported &nbsp; \u2014 = not applicable. Floci supports 20+ AWS services in a 90 MB image (24ms startup). Testcontainers uses LocalStack or other containers under the hood for AWS services. Vera AWS focuses on EC2/VPC infrastructure (89 resource types in v0.1).</p>`,
  },
  {
    slug: "postman-alternatives",
    title: "Postman Alternatives — Free API Testing Tools for Teams in 2026",
    metaDesc: "Postman's free plan is now single-user only (March 2026). Compare free alternatives for teams: Bruno, Hoppscotch, Insomnia, Thunder Client, Apidog. Verified pricing.",
    contextHtml: `<p><strong>Postman</strong> changed its free plan on <strong>March 1, 2026</strong>: it is now <strong>single-user only</strong>. Team collaboration features — shared workspaces, collection sharing, and team roles — have been removed from the free tier. The Team plan starts at <strong>$19/user/month</strong>. Previously, up to 3 users could collaborate in shared workspaces for free.</p>
      <p>This is one of the most impactful free tier removals in 2026 — Postman has millions of developer users. If your team relied on Postman's free plan for API development, here are the best free alternatives with collaboration and team-friendly features.</p>`,
    tag: "postman-alternative",
    primaryVendor: "Postman",
    hubDesc: "Postman killed free team collaboration March 1, 2026 — 5 free API testing alternatives",
    serviceMatrixHtml: `
  <h2>Free Tier Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">How each alternative's free tier compares to what Postman offered. Postman's free plan previously supported 3 users with shared workspaces and collection sharing.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Tool</th>
        <th>Free Users</th>
        <th>REST</th>
        <th>GraphQL</th>
        <th>Team Collab</th>
        <th>Git-Friendly</th>
        <th>Self-Hostable</th>
        <th>License</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600;color:var(--text-dim)">Postman (now single-user)</td>
        <td>1</td><td>\u2705</td><td>\u2705</td><td>\u274c</td><td>\u2014</td><td>\u2014</td>
        <td style="color:var(--text-dim)">Proprietary</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/apidog" style="color:var(--text)">Apidog</a></td>
        <td>4</td><td>\u2705</td><td>\u2705</td><td>\u2705</td><td>\u2014</td><td>\u2014</td>
        <td>Proprietary</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/bruno" style="color:var(--text)">Bruno</a></td>
        <td>Unlimited</td><td>\u2705</td><td>\u2705</td><td>\u2705 (via Git)</td><td>\u2705</td><td>\u2014</td>
        <td>MIT</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/hoppscotch" style="color:var(--text)">Hoppscotch</a></td>
        <td>Unlimited</td><td>\u2705</td><td>\u2705</td><td>\u2705</td><td>\u2014</td><td>\u2705</td>
        <td>MIT</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/thunder-client" style="color:var(--text)">Thunder Client</a></td>
        <td>1</td><td>\u2705</td><td>\u2014</td><td>\u2014</td><td>\u2705</td><td>\u2014</td>
        <td>Proprietary</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/insomnia" style="color:var(--text)">Insomnia</a></td>
        <td>Unlimited</td><td>\u2705</td><td>\u2705</td><td>\u2014</td><td>\u2014</td><td>\u2014</td>
        <td>MIT</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">\u2705 = supported &nbsp; \u274c = removed from free tier &nbsp; \u2014 = not applicable. Bruno collaboration works via Git (collections stored as files).</p>`,
  },
  {
    slug: "terraform-alternatives",
    title: "HCP Terraform Alternatives — Free IaC Tools After the March 2026 EOL",
    metaDesc: "HCP Terraform legacy free plan ends March 31, 2026. Compare free alternatives: Spacelift, Terragrunt Scale, Pulumi, Scalr, and more. Verified pricing and free tier details.",
    contextHtml: `<p>HCP Terraform's legacy free plan reaches <strong>end-of-life on March 31, 2026</strong> — that's <strong>9 days away</strong>. Organizations on the legacy plan will be auto-transitioned to an enhanced free tier with a <strong>500 managed resource cap</strong> (previously unlimited for small teams). If you haven't evaluated your options yet, now is the time.</p>
      <p>The new enhanced tier does include SSO, policy as code (Sentinel + OPA), and unlimited users. But if the 500-resource limit doesn't fit your workloads, or you want to avoid vendor lock-in, here are free IaC alternatives worth evaluating — including <strong>Terragrunt Scale</strong>, a new free tier from Gruntwork positioned as a direct HCP Terraform replacement.</p>`,
    serviceMatrixHtml: `
  <h2>Free Tier Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">How each IaC platform's free tier compares. HCP Terraform's enhanced free tier (replacing the legacy plan on March 31) caps managed resources at 500.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Platform</th>
        <th>Free Users</th>
        <th>Managed Resources</th>
        <th>Runs</th>
        <th>GitOps</th>
        <th>Drift Detection</th>
        <th>Policy as Code</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600;color:var(--text-dim)">HCP Terraform (enhanced)</td>
        <td>Unlimited</td><td>500</td><td>1 concurrent</td><td>\u2705</td><td>\u2014</td><td>\u2705 Sentinel + OPA</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/terragrunt-scale" style="color:var(--text)">Terragrunt Scale</a></td>
        <td>\u2014</td><td>500+</td><td>\u2014</td><td>\u2705 GitHub/GitLab</td><td>\u2705</td><td>\u2014</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/spacelift" style="color:var(--text)">Spacelift</a></td>
        <td>2</td><td>\u2014</td><td>1 public worker</td><td>\u2705</td><td>\u2014</td><td>\u2705 OPA</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/scalr" style="color:var(--text)">Scalr</a></td>
        <td>Unlimited</td><td>Unlimited</td><td>50/month</td><td>\u2705</td><td>\u2014</td><td>\u2705 OPA</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/pulumi" style="color:var(--text)">Pulumi</a></td>
        <td>1</td><td>Unlimited</td><td>500 deploy min/mo</td><td>\u2705</td><td>\u2705</td><td>\u2705</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/terramate" style="color:var(--text)">Terramate</a></td>
        <td>2</td><td>\u2014</td><td>\u2014</td><td>\u2705</td><td>\u2705</td><td>\u2014</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/terrateam" style="color:var(--text)">Terrateam</a></td>
        <td>3</td><td>\u2014</td><td>\u2014</td><td>\u2705 PR-driven</td><td>\u2014</td><td>\u2014</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">\u2705 = included in free tier &nbsp; \u2014 = not specified or requires paid plan. Scalr charges only for qualifying runs — users, workspaces, and resources are free.</p>`,
    tag: "terraform-alternative",
    primaryVendor: "HCP Terraform",
    hubDesc: "HCP Terraform legacy plan ends March 31, 2026 — free IaC alternatives compared",
  },
  {
    slug: "hetzner-alternatives",
    title: "Hetzner Alternatives After April 2026 Price Increase — Budget Cloud Options",
    metaDesc: "Hetzner is raising dedicated server prices 30-50% on April 1, 2026. Compare free-tier alternatives: DigitalOcean, Oracle Cloud, Render, Railway, Fly.io, Cloudflare Workers, Google Cloud.",
    contextHtml: `<p><strong>Hetzner</strong> is increasing cloud and dedicated server prices <strong>30-50% on April 1, 2026</strong>, driven by surging DRAM costs (+171% YoY) from AI infrastructure demand. Entry-level cloud servers like the CX23 go from €2.99 to €3.99/mo (+33%). The increase applies to <strong>all regions and all customers</strong> — both new and existing.</p>
      <p>If you're looking for budget-friendly alternatives with generous free tiers or credits, here are the best options across VPS/cloud providers, managed platforms, and serverless offerings.</p>`,
    tag: "hetzner-alternative",
    primaryVendor: "Hetzner",
    hubDesc: "Hetzner raises prices 30–50% on April 1, 2026 — cloud hosting alternatives with free tiers",
  },
  {
    slug: "freshping-alternatives",
    title: "Freshping Alternatives — Free Uptime Monitoring Tools for 2026",
    metaDesc: "Freshping shut down March 6, 2026. Compare free uptime monitoring alternatives: UptimeRobot, Better Stack, Checkly, StatusCake, Pulsetic, Cronitor. Verified pricing.",
    contextHtml: `<p><strong>Freshping</strong> — Freshworks' free uptime monitoring tool that offered <strong>50 monitors with 1-minute check intervals</strong> and public status pages — <strong>shut down on March 6, 2026</strong>. Free accounts have been disabled, paid plans will expire at end of term, and all data will be deleted 90 days later (~June 4, 2026). Freshworks has not offered a replacement product.</p>
      <p>If you relied on Freshping for uptime monitoring, here are the best free alternatives — several match or exceed Freshping's 50-monitor free tier.</p>`,
    tag: "freshping-alternative",
    primaryVendor: "Freshping",
    hubDesc: "Freshping shut down March 6, 2026 — 13 free uptime monitoring alternatives",
    serviceMatrixHtml: `
  <h2>Free Tier Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">How each alternative's free tier compares to what Freshping offered. Freshping's free plan included 50 monitors, 1-minute intervals, and public status pages.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Tool</th>
        <th>Free Monitors</th>
        <th>Check Interval</th>
        <th>Status Pages</th>
        <th>Alerts</th>
        <th>Log Retention</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600;color:var(--text-dim)">Freshping (discontinued)</td>
        <td>50</td><td>1 min</td><td>\u2705</td><td>Email, Slack</td>
        <td>6 months</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/uptimerobot" style="color:var(--text)">UptimeRobot</a></td>
        <td>50</td><td>5 min</td><td>\u2705</td><td>Email</td>
        <td>3 months</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/better-stack" style="color:var(--text)">Better Stack</a></td>
        <td>10</td><td>3 min</td><td>\u2705</td><td>Email, Slack</td>
        <td>3 days</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/checkly" style="color:var(--text)">Checkly</a></td>
        <td>10</td><td>10 min</td><td>\u2014</td><td>Email, Slack</td>
        <td>30 days</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/statuscake" style="color:var(--text)">StatusCake</a></td>
        <td>10</td><td>5 min</td><td>\u2014</td><td>Email</td>
        <td>7 days</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/pulsetic" style="color:var(--text)">Pulsetic</a></td>
        <td>10</td><td>5 min</td><td>\u2705</td><td>Email</td>
        <td>3 months</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/cronitor" style="color:var(--text)">Cronitor</a></td>
        <td>5</td><td>5 min</td><td>\u2705</td><td>Email, Slack</td>
        <td>30 days</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/upptime" style="color:var(--text)">Upptime</a></td>
        <td>Unlimited</td><td>5 min</td><td>\u2705</td><td>Email</td>
        <td>Unlimited</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">\u2705 = included in free tier &nbsp; \u2014 = not included or requires paid plan. UptimeRobot free tier is for personal/non-commercial use only.</p>`,
  },
  {
    slug: "heroku-alternatives",
    title: "Heroku Alternatives — Free PaaS Options After the Free Tier Sunset",
    metaDesc: "Heroku removed its free tier in November 2022 and entered sustaining engineering mode in 2026. Compare free alternatives: Render, Railway, Fly.io, Coolify, Koyeb, Deno Deploy, DigitalOcean. Verified pricing.",
    contextHtml: `<p><strong>Heroku</strong> — the PaaS that defined "free tier" for a generation of developers — <strong>removed all free offerings on November 28, 2022</strong> following the Salesforce acquisition. The free dyno (550 hrs/month), free Postgres (10K rows), and free Redis (25 MB) all disappeared. Plans now start at $5/month.</p>
      <p>The decline continued: <strong>major outages in June 2025</strong>, then in <strong>February 2026 Salesforce moved Heroku to "sustaining engineering" mode</strong> — no new features, no new Enterprise contracts. This is the third wave of migration interest, and the largest.</p>
      <p>If you're looking for a Heroku replacement with a generous free tier and similar git-push deployment experience, here are the best alternatives — all with verified pricing data from our index.</p>`,
    tag: "heroku-alternative",
    primaryVendor: "Heroku",
    hubDesc: "Heroku removed free tier Nov 2022, entered sustaining mode Feb 2026 — 8 free PaaS options",
    serviceMatrixHtml: `
  <h2>Free Tier Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">How each alternative's free tier compares to what Heroku offered. Heroku's free dyno included 550 hours/month with automatic sleep after 30 minutes of inactivity.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Platform</th>
        <th>Free Compute</th>
        <th>Free Database</th>
        <th>Git Deploy</th>
        <th>Docker</th>
        <th>Cold Starts</th>
        <th>Paid From</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600;color:var(--text-dim)">Heroku (discontinued)</td>
        <td>550 hrs/mo dyno</td><td>10K rows Postgres</td><td>\u2705</td><td>\u274c</td>
        <td style="color:var(--text-dim)">30 min sleep</td><td>$5/mo</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/render" style="color:var(--text)">Render</a></td>
        <td>Free web service (512 MB)</td><td>256 MB Postgres (30-day expiry)</td><td>\u2705</td><td>\u2705</td>
        <td>Yes (free tier)</td><td>$7/mo</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/railway" style="color:var(--text)">Railway</a></td>
        <td>$5 credit/mo (48 GB RAM)</td><td>Included in credit</td><td>\u2705</td><td>\u2705</td>
        <td>No</td><td>Usage-based</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/fly-io" style="color:var(--text)">Fly.io</a></td>
        <td>Trial (7 days)</td><td>Included</td><td>\u2014</td><td>\u2705</td>
        <td>No</td><td>Usage-based</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/coolify" style="color:var(--text)">Coolify</a></td>
        <td>Unlimited (self-hosted)</td><td>280+ one-click services</td><td>\u2705</td><td>\u2705</td>
        <td>No</td><td>$5/mo (cloud)</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/koyeb" style="color:var(--text)">Koyeb</a></td>
        <td>1 free service (512 MB)</td><td>1 GB Postgres</td><td>\u2705</td><td>\u2705</td>
        <td>Scale-to-zero</td><td>$5.40/mo</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/digitalocean" style="color:var(--text)">DigitalOcean</a></td>
        <td>$200 credit (60 days)</td><td>Not in free tier</td><td>\u2705</td><td>\u2705</td>
        <td>No</td><td>$5/mo</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/deno-deploy" style="color:var(--text)">Deno Deploy</a></td>
        <td>1M req/day, 15 hrs CPU</td><td>1 GiB KV storage</td><td>\u2705</td><td>\u2014</td>
        <td>No (V8 isolates)</td><td>$20/mo</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">\u2705 = supported &nbsp; \u274c = not available &nbsp; \u2014 = not applicable. Railway's $5/mo is a resource credit shared across all services. Coolify is free when self-hosted on your own server. DigitalOcean credit expires after 60 days.</p>`,
  },
  {
    slug: "firebase-alternatives",
    title: "Firebase Alternatives \u2014 Free Backend-as-a-Service Options for 2026",
    metaDesc: "Firebase Studio shut down March 2026 and Spark plan forced migrations to pay-as-you-go Blaze. Compare free alternatives with exact tier limits: Supabase, Appwrite, PocketBase, Nhost, Convex, Back4App, Hasura.",
    contextHtml: `<p><strong>Firebase</strong> \u2014 Google's all-in-one Backend-as-a-Service \u2014 is facing developer trust issues in 2026. <strong>Firebase Studio was shut down on March 19, 2026</strong> (accessible until March 2027 for migration). In February 2026, <strong>Spark plan projects using legacy *.appspot.com Cloud Storage buckets were forced to upgrade to Blaze</strong> (pay-as-you-go) or lose access \u2014 with no hard billing caps to prevent runaway charges.</p>
      <p>Developer sentiment is increasingly negative: "building on Google products is always a gamble." The Spark free tier still exists for new projects, but the pattern of forced migrations and product shutdowns is driving developers to open-source, self-hostable alternatives.</p>
      <p>Below are the best free Firebase alternatives, compared by <strong>what you actually get for free</strong> \u2014 exact storage, MAU, bandwidth, and function limits. Not marketing copy.</p>`,
    tag: "firebase-alternative",
    primaryVendor: "Firebase",
    hubDesc: "Firebase Studio shut down March 19, 2026 + Spark forced Blaze migration — 7 BaaS alternatives",
    serviceMatrixHtml: `
  <h2>Free Tier Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">What you actually get for free on each platform. Firebase Spark is generous on paper but lacks billing caps on Blaze \u2014 one misconfigured query can cost hundreds.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Platform</th>
        <th>Database</th>
        <th>File Storage</th>
        <th>Auth (MAUs)</th>
        <th>Functions</th>
        <th>Bandwidth</th>
        <th>Real-time</th>
        <th>License</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600;color:var(--text-dim)">Firebase (Spark)</td>
        <td>1 GiB Firestore</td><td>5 GB</td><td>50K</td><td>2M invocations/mo</td><td>10 GB/mo</td><td>\u2705</td>
        <td style="color:var(--text-dim)">Proprietary</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/supabase" style="color:var(--text)">Supabase</a></td>
        <td>500 MB Postgres</td><td>1 GB</td><td>50K</td><td>500K edge fn</td><td>5 GB</td><td>\u2705 (200 conn)</td>
        <td>Apache-2.0</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/appwrite-cloud" style="color:var(--text)">Appwrite Cloud</a></td>
        <td>Included</td><td>2 GB</td><td>75K</td><td>750K exec/mo</td><td>5 GB</td><td>\u2705</td>
        <td>BSD-3</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/pocketbase" style="color:var(--text)">PocketBase</a></td>
        <td>Unlimited (SQLite)</td><td>Unlimited</td><td>Unlimited</td><td>\u2014</td><td>Unlimited</td><td>\u2705</td>
        <td>MIT</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/nhost" style="color:var(--text)">Nhost</a></td>
        <td>1 GB Postgres</td><td>5 GB</td><td>Included</td><td>Included</td><td>5 GB</td><td>\u2705 (GraphQL)</td>
        <td>MIT</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/convex" style="color:var(--text)">Convex</a></td>
        <td>0.5 GB</td><td>1 GB</td><td>Included</td><td>1M calls/mo</td><td>Included</td><td>\u2705</td>
        <td>Proprietary</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/back4app" style="color:var(--text)">Back4App</a></td>
        <td>250 MB</td><td>1 GB</td><td>Included</td><td>\u2014</td><td>1 GB</td><td>\u2705 (Live Query)</td>
        <td>Proprietary</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/hasura-cloud" style="color:var(--text)">Hasura Cloud</a></td>
        <td>BYO Postgres</td><td>\u2014</td><td>\u2014</td><td>\u2014</td><td>1 GB passthrough</td><td>\u2705 (subscriptions)</td>
        <td>Apache-2.0</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">PocketBase limits are "unlimited" because it's self-hosted \u2014 actual limits depend on your server hardware. Hasura is a GraphQL engine that sits on top of your own Postgres database. Appwrite projects pause after 1 week of inactivity on the free tier. Firebase Spark has no billing caps if you upgrade to Blaze.</p>`,
  },
  {
    slug: "github-actions-alternatives",
    title: "GitHub Actions Alternatives \u2014 Free CI/CD Tools for 2026",
    metaDesc: "GitHub Actions self-hosted runners now cost $0.002/min for private repos. Compare free CI/CD alternatives: GitLab CI, CircleCI, Buildkite, Harness, Drone CI, Google Cloud Build, and more. Verified limits.",
    contextHtml: `<p><strong>GitHub Actions</strong> introduced <strong>self-hosted runner charges ($0.002/min) for private repos on March 1, 2026</strong>. While the GitHub-hosted runner free tier (2,000 min/mo for private repos, unlimited for public) remains unchanged, teams running self-hosted runners for private repository builds now face per-minute costs.</p>
      <p>For public repositories, GitHub Actions remains the best free CI/CD option \u2014 unlimited minutes with no restrictions. But if you\u2019re running private repo pipelines on self-hosted infrastructure, these alternatives offer generous free tiers without per-minute runner fees.</p>
      <p>Below are the best free CI/CD alternatives, compared by <strong>exact free tier limits</strong> \u2014 build minutes, concurrent jobs, storage, and platform support.</p>`,
    tag: "github-actions-alternative",
    primaryVendor: "GitHub Actions",
    hubDesc: "Self-hosted runner costs introduced March 2026 \u2014 10 free CI/CD alternatives compared",
    serviceMatrixHtml: `
  <h2>Free Tier Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">How each CI/CD platform\u2019s free tier compares. GitHub Actions\u2019 2,000 min/mo for private repos remains strong for GitHub-hosted runners \u2014 the new cost only applies to self-hosted runners.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Platform</th>
        <th>Free Build Time</th>
        <th>Concurrency</th>
        <th>Users</th>
        <th>Self-Hosted</th>
        <th>GitOps</th>
        <th>License</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600;color:var(--text-dim)">GitHub Actions</td>
        <td>2,000 min/mo (private)</td><td>20 concurrent</td><td>Unlimited</td>
        <td style="color:var(--text-dim)">$0.002/min (private)</td><td>\u2705</td>
        <td style="color:var(--text-dim)">Proprietary</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/gitlab-ci" style="color:var(--text)">GitLab CI</a></td>
        <td>400 min/mo</td><td>Included</td><td>5</td>
        <td>\u2705 Free</td><td>\u2705</td>
        <td>MIT (core)</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/circleci" style="color:var(--text)">CircleCI</a></td>
        <td>30K credits/mo (~6K min)</td><td>30x</td><td>5</td>
        <td>\u2705 Free</td><td>\u2705</td>
        <td>Proprietary</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/buildkite" style="color:var(--text)">Buildkite</a></td>
        <td>500 hosted min/mo</td><td>3 concurrent</td><td>Unlimited</td>
        <td>\u2705 Free</td><td>\u2705</td>
        <td>Proprietary</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/harness-ci" style="color:var(--text)">Harness CI</a></td>
        <td>2,000 credits/mo</td><td>Included</td><td>Included</td>
        <td>\u2705 Free</td><td>\u2705</td>
        <td>Proprietary</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/google-cloud-build" style="color:var(--text)">Google Cloud Build</a></td>
        <td>2,500 min/mo</td><td>Included</td><td>Included</td>
        <td>\u2014</td><td>\u2705</td>
        <td>Proprietary</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/drone-ci" style="color:var(--text)">Drone CI</a></td>
        <td>Unlimited (self-hosted)</td><td>Unlimited</td><td>Unlimited</td>
        <td>\u2705 Self-hosted only</td><td>\u2705</td>
        <td>Apache-2.0</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/woodpecker-ci" style="color:var(--text)">Woodpecker CI</a></td>
        <td>Unlimited (self-hosted)</td><td>Unlimited</td><td>Unlimited</td>
        <td>\u2705 Self-hosted only</td><td>\u2705</td>
        <td>Apache-2.0</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/codefresh" style="color:var(--text)">Codefresh</a></td>
        <td>120 builds/mo</td><td>1 concurrent</td><td>Included</td>
        <td>\u2014</td><td>\u2705 (Argo)</td>
        <td>Proprietary</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/semaphore-ci" style="color:var(--text)">Semaphore CI</a></td>
        <td>Unlimited (self-hosted)</td><td>Unlimited</td><td>Unlimited</td>
        <td>\u2705 Self-hosted only</td><td>\u2705</td>
        <td>Proprietary</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">Drone CI, Woodpecker CI, and Semaphore Community Edition are self-hosted only \u2014 limits depend on your infrastructure. GitLab CI\u2019s 400 min/mo applies to shared runners on gitlab.com; self-hosted GitLab runners are free. Bitbucket Pipelines (50 min/mo) not shown due to limited free tier.</p>`,
  },
  {
    slug: "cursor-alternatives",
    title: "Cursor Alternatives — Best Free AI Code Editors for 2026",
    metaDesc: "Cursor moved to credit-based pricing in 2025. Compare free AI coding alternatives: Claude Code, GitHub Copilot, Cline, Aider, Windsurf, Augment Code, Amazon Q Developer, Gemini CLI. Verified 2026 limits.",
    contextHtml: `<p><strong>Cursor</strong> — the AI-powered code editor built on VS Code — shifted to <strong>credit-based pricing</strong> in mid-2025, plus a new <strong>$200/month Ultra tier</strong>. The free tier still exists (2,000 completions/month, 50 slow premium requests), but the credit model makes costs less predictable for heavy users. Developers are actively evaluating alternatives.</p>
      <p>The AI coding tool landscape has exploded in 2026. Terminal-based agents (Claude Code, Aider, Gemini CLI), IDE extensions (GitHub Copilot, Windsurf, Augment Code), and open-source autonomous agents (Cline) each offer different trade-offs between cost, flexibility, and capability.</p>
      <p>Below are the best free alternatives to Cursor, compared by <strong>what you actually get for free</strong> — exact limits, open-source status, and what each tool is best at.</p>`,
    tag: "cursor-alternative",
    primaryVendor: "Cursor",
    hubDesc: "Cursor credit-based pricing drives alternatives search — 8 free AI coding tools compared",
    serviceMatrixHtml: `
  <h2>Free Tier Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">What you actually get for free on each AI coding tool. Open-source tools (Cline, Aider) have no vendor limits — you pay only for the LLM API you choose.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Tool</th>
        <th>Free Tier</th>
        <th>Type</th>
        <th>Open Source</th>
        <th>Key Strength</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600;color:var(--text-dim)">Cursor</td>
        <td>2,000 completions/mo, 50 slow premium req</td>
        <td>IDE (VS Code fork)</td>
        <td>\u2014</td>
        <td style="color:var(--text-dim)">Inline editing + chat in one IDE</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/claude-code" style="color:var(--text)">Claude Code</a></td>
        <td>Free during beta</td>
        <td>Terminal agent</td>
        <td>\u2014</td>
        <td>Deep agentic coding — reads/writes files, runs commands</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/github-copilot" style="color:var(--text)">GitHub Copilot</a></td>
        <td>2,000 completions/mo, 50 chat msgs/mo</td>
        <td>IDE extension</td>
        <td>\u2014</td>
        <td>Widest IDE support (VS Code, JetBrains, Neovim, Xcode)</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/cline" style="color:var(--text)">Cline</a></td>
        <td>Free (bring your own API key)</td>
        <td>VS Code extension</td>
        <td>\u2705 Apache-2.0</td>
        <td>Autonomous agent — no vendor lock-in</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/aider" style="color:var(--text)">Aider</a></td>
        <td>Free (bring your own API key)</td>
        <td>Terminal CLI</td>
        <td>\u2705 Apache-2.0</td>
        <td>AI pair programming — multi-file edits, git integration</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/windsurf" style="color:var(--text)">Windsurf</a></td>
        <td>Limited Cascade AI access</td>
        <td>IDE (VS Code fork)</td>
        <td>\u2014</td>
        <td>AI Flow — multi-step autonomous workflows</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/augment-code" style="color:var(--text)">Augment Code</a></td>
        <td>Free for individuals (limited)</td>
        <td>IDE extension</td>
        <td>\u2014</td>
        <td>Deep codebase understanding — large repo context</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/amazon-q-developer" style="color:var(--text)">Amazon Q Developer</a></td>
        <td>Unlimited completions, 50 agent/mo</td>
        <td>IDE extension + CLI</td>
        <td>\u2014</td>
        <td>AWS integration — code transformation, security scans</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/gemini-cli" style="color:var(--text)">Gemini CLI</a></td>
        <td>1,000 req/day (personal account)</td>
        <td>Terminal CLI</td>
        <td>\u2705 Apache-2.0</td>
        <td>1M token context window — massive codebase analysis</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">Cline and Aider are fully free — you pay only for the LLM API calls (OpenRouter, Anthropic, OpenAI, etc.). Claude Code is free during beta (expected to become paid). Gemini CLI free tier is generous: 60 req/min, 1,000 req/day with a personal Google account.</p>`,
  },
  {
    slug: "datadog-alternatives",
    title: "Datadog Alternatives — Best Free Monitoring & Observability Tools for 2026",
    metaDesc: "Datadog bills are unpredictable. Compare free observability alternatives: Grafana Cloud, New Relic, Sentry, Axiom, Prometheus, BetterStack, and more. Verified 2026 free tier limits.",
    contextHtml: `<p><strong>Datadog</strong> is a powerful, full-stack observability platform — but it's notorious for <strong>unpredictable pricing</strong>. Teams routinely discover their bill is 3–5× what they expected after a traffic spike, log volume increase, or custom metrics growth. "Datadog alternatives" is one of the most searched developer tools queries for good reason.</p>
    <p>The free tier (5 hosts, 1-day metric retention, 1 custom metric per host) is extremely limited — most teams outgrow it within weeks. And once you're on a paid plan, costs scale with hosts, containers, custom metrics, log volume, APM spans, and synthetics — each billed separately.</p>
    <p>The good news: the monitoring landscape in 2026 offers strong free tiers across every observability need. Full-platform alternatives (Grafana Cloud, New Relic, Middleware.io), specialized tools (Sentry for errors, Axiom for logs), and battle-tested open-source options (Prometheus, Jaeger) can replace parts or all of a Datadog setup — often at zero cost for small-to-medium workloads.</p>`,
    tag: "datadog-alternative",
    primaryVendor: "Datadog",
    hubDesc: "Unpredictable pricing drives developer search — 12 free monitoring and observability alternatives compared",
    serviceMatrixHtml: `
  <h2>Free Tier Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">What you actually get for free on each platform. Datadog's free tier is one of the most restrictive in the category — most alternatives offer significantly more.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Tool</th>
        <th>Free Tier</th>
        <th>Best For</th>
        <th>Self-Hosted Option</th>
        <th>Key Advantage</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600;color:var(--text-dim)">Datadog</td>
        <td>5 hosts, 1-day retention, 1 custom metric/host</td>
        <td>Full-stack observability</td>
        <td>—</td>
        <td style="color:var(--text-dim)">Broadest integration catalog</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/grafana-cloud" style="color:var(--text)">Grafana Cloud</a></td>
        <td>10K metrics, 50 GB logs, 50 GB traces, 3 users</td>
        <td>Full-stack observability</td>
        <td>✅ Grafana + Loki + Tempo</td>
        <td>Most generous free tier + fully open-source stack</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/new-relic" style="color:var(--text)">New Relic</a></td>
        <td>100 GB ingest/month, 1 full user</td>
        <td>Full-stack observability</td>
        <td>—</td>
        <td>100 GB free ingest — 10× most competitors</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/middleware-io" style="color:var(--text)">Middleware.io</a></td>
        <td>100 GB/month (APM, logs, infra, traces, RUM)</td>
        <td>Full-stack observability</td>
        <td>—</td>
        <td>All-in-one: APM + logs + traces + RUM + synthetics</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/sentry" style="color:var(--text)">Sentry</a></td>
        <td>5K errors/month, 5M spans, 50 replays</td>
        <td>Error tracking + performance</td>
        <td>✅ Self-hosted</td>
        <td>Best-in-class error tracking with session replay</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/axiom" style="color:var(--text)">Axiom</a></td>
        <td>500 GB ingest/month, 30-day retention</td>
        <td>Log management</td>
        <td>—</td>
        <td>500 GB free log ingest — unmatched for logs</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/betterstack" style="color:var(--text)">BetterStack</a></td>
        <td>10 monitors, 3 GB logs, 1 status page</td>
        <td>Uptime + incident management</td>
        <td>—</td>
        <td>Uptime + logs + status pages in one tool</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/appsignal" style="color:var(--text)">AppSignal</a></td>
        <td>50K requests/month, 1 GB logs</td>
        <td>Small app monitoring</td>
        <td>—</td>
        <td>Simple setup — APM + errors + logging combined</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/sematext" style="color:var(--text)">Sematext</a></td>
        <td>500 MB/day logs, 3 hosts monitoring</td>
        <td>Logs + infrastructure</td>
        <td>—</td>
        <td>No per-host charges on paid plans</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/prometheus" style="color:var(--text)">Prometheus</a></td>
        <td>Free OSS (Apache 2.0)</td>
        <td>Metrics + alerting</td>
        <td>✅ Self-hosted only</td>
        <td>CNCF standard — no vendor lock-in</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/jaeger" style="color:var(--text)">Jaeger</a></td>
        <td>Free OSS (Apache 2.0)</td>
        <td>Distributed tracing</td>
        <td>✅ Self-hosted only</td>
        <td>CNCF graduated — OpenTelemetry native</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/uptimerobot" style="color:var(--text)">UptimeRobot</a></td>
        <td>50 monitors, 5-min intervals</td>
        <td>Uptime monitoring</td>
        <td>—</td>
        <td>50 free monitors — most generous uptime tier</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/hyperping" style="color:var(--text)">Hyperping</a></td>
        <td>5 monitors, 3-min intervals, 1 status page</td>
        <td>Uptime + status pages</td>
        <td>—</td>
        <td>Status page with subscriber notifications included</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">Prometheus and Jaeger are fully free open-source — you manage the infrastructure. Grafana Cloud's free tier includes managed Prometheus, Loki (logs), and Tempo (traces). New Relic's 100 GB ingest and Axiom's 500 GB ingest are standout free tiers for teams generating significant telemetry volume.</p>`,
  },
  {
    slug: "vercel-alternatives",
    title: "Vercel Alternatives — Best Free Frontend Deployment Platforms for 2026",
    metaDesc: "Vercel hobby plan too limited? Compare free deployment alternatives: Cloudflare Pages, Netlify, Render, Railway, Deno Deploy, Coolify, and more. Verified 2026 free tier limits.",
    contextHtml: `<p><strong>Vercel</strong> set the standard for frontend developer experience — instant preview deployments, edge functions, and seamless framework integration. But its pricing is a recurring pain point. The Hobby plan (100 GB bandwidth, 1M function invocations, 4 hrs CPU) works for small projects, but the jump to Pro at <strong>$20/seat/month</strong> is steep for small teams and indie developers.</p>
    <p>The core issue isn't quality — Vercel is excellent. It's <strong>cost scaling</strong>. Teams discover that hobby limits are too restrictive for real traffic, bandwidth overages add up fast, and serverless function costs at scale can surprise. "Vercel alternatives" is one of the most searched hosting queries as developers look for more generous free tiers or predictable pricing.</p>
    <p>The good news: the deployment landscape in 2026 is competitive. Full-featured platforms (Cloudflare Pages, Netlify) offer unlimited bandwidth or generous credits. Container-based platforms (Railway, Render, Fly.io) give you more control. Edge-first options (Deno Deploy, Cloudflare Workers) optimize for performance. And self-hosted tools (Coolify) eliminate hosting costs entirely if you have your own server.</p>`,
    tag: "vercel-alternative",
    primaryVendor: "Vercel",
    hubDesc: "Hobby plan limits and $20/seat Pro pricing drive alternatives search — 10 free deployment platforms compared",
    serviceMatrixHtml: `
  <h2>Free Tier Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">What you actually get for free on each platform. Vercel's hobby tier is competitive but limited — several alternatives offer more bandwidth, builds, or compute for free.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Platform</th>
        <th>Free Tier</th>
        <th>Bandwidth</th>
        <th>Build Minutes</th>
        <th>Best For</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600;color:var(--text-dim)">Vercel</td>
        <td>Hobby (free)</td>
        <td>100 GB/month</td>
        <td>—</td>
        <td style="color:var(--text-dim)">Next.js + framework DX</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/cloudflare-pages" style="color:var(--text)">Cloudflare Pages</a></td>
        <td>Free</td>
        <td>Unlimited</td>
        <td>500/month</td>
        <td>Static sites + edge performance</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/netlify" style="color:var(--text)">Netlify</a></td>
        <td>Free (300 credits/mo)</td>
        <td>~30 GB (credit-based)</td>
        <td>~20 builds (credit-based)</td>
        <td>Jamstack + form handling</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/render" style="color:var(--text)">Render</a></td>
        <td>Hobby (free)</td>
        <td>100 GB/month</td>
        <td>500/month</td>
        <td>Full-stack (web services + databases)</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/railway" style="color:var(--text)">Railway</a></td>
        <td>$5/mo ($5 credit)</td>
        <td>Included in credit</td>
        <td>Included in credit</td>
        <td>Docker + databases + simplicity</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/fly-io" style="color:var(--text)">Fly.io</a></td>
        <td>Trial (limited)</td>
        <td>Included in trial</td>
        <td>—</td>
        <td>Global edge deployment + containers</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/deno-deploy" style="color:var(--text)">Deno Deploy</a></td>
        <td>Free</td>
        <td>100 GB/month</td>
        <td>—</td>
        <td>TypeScript edge runtime</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/koyeb" style="color:var(--text)">Koyeb</a></td>
        <td>Starter (free)</td>
        <td>100 GB/month</td>
        <td>—</td>
        <td>Scale-to-zero + free Postgres</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/coolify" style="color:var(--text)">Coolify</a></td>
        <td>Free OSS (Apache 2.0)</td>
        <td>Your server</td>
        <td>Your server</td>
        <td>Self-hosted PaaS — zero hosting cost</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/val-town" style="color:var(--text)">Val Town</a></td>
        <td>Free</td>
        <td>—</td>
        <td>—</td>
        <td>Serverless TypeScript scripting</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/cloudflare-workers" style="color:var(--text)">Cloudflare Workers</a></td>
        <td>Free (100K req/day)</td>
        <td>Unlimited</td>
        <td>—</td>
        <td>Edge compute + KV + D1 + R2</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">Cloudflare Pages stands out with unlimited bandwidth on the free tier. Netlify switched to a credit-based system in late 2025 — legacy accounts keep 100 GB bandwidth + 300 build minutes. Railway's $5/month includes a $5 credit that covers most hobby projects. Coolify is fully free if you self-host on your own server.</p>`,
  },
  {
    slug: "auth0-alternatives",
    title: "Auth0 Alternatives — Best Free Authentication Platforms for 2026",
    metaDesc: "Auth0 free tier too limited? Compare free authentication alternatives: Clerk, WorkOS, Supabase Auth, Firebase Auth, Logto, FusionAuth, Keycloak, and more. Verified 2026 free tier limits.",
    contextHtml: `<p><strong>Auth0</strong> is a powerful identity platform, but its pricing is one of the steepest cliffs in developer tools. The free tier gives you <strong>25K MAU</strong> — generous for prototyping. But the moment you outgrow it, you're looking at the Essential plan starting at <strong>$240/month for just 500 external MAU</strong>. That's a jump from $0 to nearly $3,000/year with no middle ground.</p>
    <p>The pricing pain is compounded by complexity. Auth0's tenant model, rule/action system, and connection limits create billing surprises. Teams regularly discover they need features (SSO, MFA customization, branding removal) that are locked behind higher tiers. "Auth0 alternatives" remains one of the most consistently searched developer queries.</p>
    <p>The authentication landscape in 2026 offers real competition. Managed platforms (Clerk, WorkOS, Stytch) provide modern DX with generous free tiers. Open-source solutions (Keycloak, FusionAuth, Ory, Logto) give you unlimited users when self-hosted. And BaaS platforms (Supabase, Firebase) include auth as part of a broader free tier. The right choice depends on whether you prioritize DX, cost, or control.</p>`,
    tag: "auth0-alternative",
    primaryVendor: "Auth0",
    hubDesc: "$0 to $240/mo pricing cliff drives alternatives search — 9 free authentication platforms compared",
    serviceMatrixHtml: `
  <h2>Free Tier Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">What you actually get for free on each platform. Auth0's 25K MAU free tier is competitive, but the jump to paid is the steepest in the industry.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Platform</th>
        <th>Free MAU</th>
        <th>SSO</th>
        <th>MFA</th>
        <th>Self-Hosted</th>
        <th>Best For</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600;color:var(--text-dim)">Auth0</td>
        <td>25K</td>
        <td>Paid</td>
        <td>Yes</td>
        <td>No</td>
        <td style="color:var(--text-dim)">Enterprise identity + rules engine</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/clerk" style="color:var(--text)">Clerk</a></td>
        <td>50K</td>
        <td>Paid</td>
        <td>Yes</td>
        <td>No</td>
        <td>Pre-built UI components + React DX</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/workos" style="color:var(--text)">WorkOS</a></td>
        <td>1M</td>
        <td>Paid</td>
        <td>Yes</td>
        <td>No</td>
        <td>Enterprise SSO + SCIM at scale</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/supabase" style="color:var(--text)">Supabase Auth</a></td>
        <td>50K</td>
        <td>No</td>
        <td>Yes</td>
        <td>Yes (OSS)</td>
        <td>Full BaaS — auth + database + storage</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/firebase" style="color:var(--text)">Firebase Auth</a></td>
        <td>50K</td>
        <td>No</td>
        <td>Yes</td>
        <td>No</td>
        <td>Google ecosystem + mobile SDKs</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/logto" style="color:var(--text)">Logto</a></td>
        <td>50K</td>
        <td>Paid</td>
        <td>Yes</td>
        <td>Yes (OSS)</td>
        <td>Modern OIDC + open-source option</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/stytch" style="color:var(--text)">Stytch</a></td>
        <td>10K</td>
        <td>5 connections</td>
        <td>Yes</td>
        <td>No</td>
        <td>Passwordless + fraud prevention</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/fusionauth" style="color:var(--text)">FusionAuth</a></td>
        <td>Unlimited*</td>
        <td>Yes</td>
        <td>Yes</td>
        <td>Yes (Apache 2.0)</td>
        <td>Full-featured self-hosted — zero cost</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/keycloak" style="color:var(--text)">Keycloak</a></td>
        <td>Unlimited*</td>
        <td>Yes</td>
        <td>Yes</td>
        <td>Yes (Apache 2.0)</td>
        <td>Enterprise IAM — Red Hat backed</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/ory" style="color:var(--text)">Ory</a></td>
        <td>25K (cloud)</td>
        <td>Yes</td>
        <td>Yes</td>
        <td>Yes (Apache 2.0)</td>
        <td>Modular identity — Kratos + Hydra</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/kinde" style="color:var(--text)">Kinde</a></td>
        <td>10.5K</td>
        <td>SAML</td>
        <td>Yes</td>
        <td>No</td>
        <td>Auth + feature flags + billing</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">*FusionAuth and Keycloak are free self-hosted with no user limits. WorkOS leads managed platforms at 1M MAU free (AuthKit). Clerk and Logto both offer 50K MAU. Supabase and Firebase bundle auth into broader BaaS free tiers.</p>`,
  },
  {
    slug: "mongodb-alternatives",
    title: "MongoDB Alternatives — Best Free Databases for 2026",
    metaDesc: "MongoDB Atlas free tier too small? Compare free database alternatives: Supabase, Neon, CockroachDB, Turso, Xata, PocketBase, Convex, and more. Verified 2026 free tier limits.",
    contextHtml: `<p><strong>MongoDB Atlas</strong> is the most popular hosted document database, but its free tier comes with hard limits: <strong>512 MB storage</strong> on a shared M0 cluster, no backups, limited connections, and no Atlas Search on free clusters. Developers building side projects hit these limits fast — a modest collection of user data and logs can fill 512 MB in weeks.</p>
    <p>The bigger issue is the <strong>SSPL license</strong>. MongoDB switched from AGPL to the Server Side Public License in 2018, which effectively prevents cloud providers and many companies from offering MongoDB-as-a-service. This has accelerated the shift toward Postgres-based alternatives (Supabase, Neon, Xata) and edge-native databases (Turso, Cloudflare D1) that offer more generous free tiers with truly open-source licenses.</p>
    <p>The database landscape in 2026 offers compelling alternatives across every use case: serverless Postgres with branching (Neon), distributed SQL (CockroachDB), edge SQLite (Turso, D1), reactive backends (Convex), and full BaaS platforms (Supabase, Firebase, Appwrite). Most offer significantly more free storage than MongoDB Atlas.</p>`,
    tag: "mongodb-alternative",
    primaryVendor: "MongoDB Atlas",
    hubDesc: "512 MB free tier + SSPL license drive alternatives search — 10 free databases compared",
    serviceMatrixHtml: `
  <h2>Free Tier Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">What you actually get for free on each database. MongoDB Atlas gives you 512 MB on a shared cluster — most alternatives offer 5-15x more storage.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Database</th>
        <th>Free Storage</th>
        <th>Type</th>
        <th>Backups</th>
        <th>Self-Hosted</th>
        <th>Best For</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600;color:var(--text-dim)">MongoDB Atlas</td>
        <td>512 MB</td>
        <td>Document</td>
        <td>No</td>
        <td>SSPL</td>
        <td style="color:var(--text-dim)">Document queries + aggregation pipeline</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/supabase" style="color:var(--text)">Supabase</a></td>
        <td>500 MB</td>
        <td>Postgres</td>
        <td>No</td>
        <td>Yes (Apache 2.0)</td>
        <td>Full BaaS — auth + storage + realtime</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/neon" style="color:var(--text)">Neon</a></td>
        <td>512 MB</td>
        <td>Serverless Postgres</td>
        <td>7-day history</td>
        <td>Yes (Apache 2.0)</td>
        <td>Branching + scale-to-zero Postgres</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/cockroachdb" style="color:var(--text)">CockroachDB</a></td>
        <td>10 GiB</td>
        <td>Distributed SQL</td>
        <td>Yes</td>
        <td>Yes (BSL)</td>
        <td>Multi-region + horizontal scale</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/turso" style="color:var(--text)">Turso</a></td>
        <td>5 GB</td>
        <td>SQLite (libSQL)</td>
        <td>No</td>
        <td>Yes (MIT)</td>
        <td>Edge-native + embedded replicas</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/xata" style="color:var(--text)">Xata</a></td>
        <td>15 GB</td>
        <td>Serverless Postgres</td>
        <td>Daily</td>
        <td>No</td>
        <td>Postgres + built-in search + branching</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/cloudflare-d1" style="color:var(--text)">Cloudflare D1</a></td>
        <td>5 GB</td>
        <td>SQLite (edge)</td>
        <td>No</td>
        <td>No</td>
        <td>Edge Workers integration + zero egress</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/pocketbase" style="color:var(--text)">PocketBase</a></td>
        <td>Unlimited*</td>
        <td>SQLite</td>
        <td>Manual</td>
        <td>Yes (MIT)</td>
        <td>Single binary backend — zero dependencies</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/convex" style="color:var(--text)">Convex</a></td>
        <td>512 MB</td>
        <td>Document (reactive)</td>
        <td>Yes</td>
        <td>No</td>
        <td>Real-time sync + serverless functions</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/firebase" style="color:var(--text)">Firebase</a></td>
        <td>1 GiB</td>
        <td>Document (Firestore)</td>
        <td>No</td>
        <td>No</td>
        <td>Google ecosystem + mobile SDKs</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/appwrite-cloud" style="color:var(--text)">Appwrite</a></td>
        <td>2 GB</td>
        <td>Document</td>
        <td>No</td>
        <td>Yes (BSD)</td>
        <td>Open-source BaaS — auth + functions + storage</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">*PocketBase is fully free self-hosted with no storage limits. CockroachDB leads managed offerings at 10 GiB free. Xata offers the most generous managed storage at 15 GB with daily backups included. Turso and D1 provide 5 GB of edge SQLite.</p>`,
  },
  {
    slug: "redis-alternatives",
    title: "Redis Alternatives — Best Free Caching and Key-Value Stores for 2026",
    metaDesc: "Redis switched to BSL? Compare free alternatives: Upstash, Valkey, DragonflyDB, KeyDB, Momento, Garnet, Memcached, Aiven. Protocol-compatible options with verified 2026 free tier limits.",
    contextHtml: `<p><strong>Redis</strong> changed everything in March 2024 when it switched from BSD to the <strong>Business Source License (BSL)</strong>. The move restricts cloud providers from offering Redis-as-a-service without a commercial agreement — and triggered the Linux Foundation to fork Redis as <strong>Valkey</strong>, backed by AWS, Google Cloud, Oracle, and Ericsson.</p>
    <p>For developers, the practical impact depends on your use case. If you're using Redis Cloud's free tier, you get just <strong>30 MB of memory</strong> on a single shared database — barely enough for a cache layer. Self-hosting Redis is still free under BSL for non-competitive use, but the license uncertainty has pushed many teams toward truly open-source alternatives.</p>
    <p>The 2026 landscape offers strong options: <strong>Upstash</strong> provides serverless Redis-compatible caching with 500K commands/month free. <strong>Valkey</strong> is a drop-in BSD-3 fork maintained by the Linux Foundation. <strong>DragonflyDB</strong> claims 25x better throughput. <strong>Momento</strong> offers zero-infrastructure serverless caching. And established options like <strong>Memcached</strong> and <strong>KeyDB</strong> remain fully open-source.</p>`,
    tag: "redis-alternative",
    primaryVendor: "Redis Cloud",
    hubDesc: "BSL license change + 30 MB free tier — 8 open-source and managed alternatives compared",
    serviceMatrixHtml: `
  <h2>Free Tier Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">What you actually get for free on each caching/key-value platform. Redis Cloud gives you 30 MB on a shared instance — most alternatives offer dramatically more.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Platform</th>
        <th>Free Tier</th>
        <th>Redis Compatible</th>
        <th>Self-Hosted</th>
        <th>License</th>
        <th>Best For</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600;color:var(--text-dim)">Redis Cloud</td>
        <td>30 MB</td>
        <td>Yes (is Redis)</td>
        <td>BSL restrictions</td>
        <td>BSL 1.1</td>
        <td style="color:var(--text-dim)">Existing Redis workloads</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/upstash" style="color:var(--text)">Upstash</a></td>
        <td>500K cmds/mo</td>
        <td>Yes</td>
        <td>No</td>
        <td>Managed</td>
        <td>Serverless apps — pay-per-request pricing</td>
      </tr>
      <tr>
        <td style="font-weight:600">Valkey</td>
        <td>Free OSS</td>
        <td>Yes (fork)</td>
        <td>Yes</td>
        <td>BSD-3</td>
        <td>Drop-in Redis replacement — Linux Foundation backed</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/aiven" style="color:var(--text)">Aiven</a></td>
        <td>1 CPU / 1 GB RAM</td>
        <td>Yes (Valkey)</td>
        <td>No</td>
        <td>Managed</td>
        <td>Managed Valkey with monitoring + backups</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/momento" style="color:var(--text)">Momento</a></td>
        <td>5 GB transfer/mo</td>
        <td>No</td>
        <td>No</td>
        <td>Managed</td>
        <td>Zero-config serverless caching + pub/sub</td>
      </tr>
      <tr>
        <td style="font-weight:600">DragonflyDB</td>
        <td>Free OSS</td>
        <td>Yes</td>
        <td>Yes</td>
        <td>BSL 1.1</td>
        <td>High-throughput — claims 25x Redis performance</td>
      </tr>
      <tr>
        <td style="font-weight:600">KeyDB</td>
        <td>Free OSS</td>
        <td>Yes</td>
        <td>Yes</td>
        <td>BSD-3</td>
        <td>Multithreaded Redis fork — better multi-core use</td>
      </tr>
      <tr>
        <td style="font-weight:600">Garnet</td>
        <td>Free OSS</td>
        <td>Yes (RESP)</td>
        <td>Yes</td>
        <td>MIT</td>
        <td>Microsoft's .NET cache — extreme low latency</td>
      </tr>
      <tr>
        <td style="font-weight:600">Memcached</td>
        <td>Free OSS</td>
        <td>No</td>
        <td>Yes</td>
        <td>BSD</td>
        <td>Simple key-value caching — battle-tested at scale</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">*Upstash is the only managed option with a meaningful free tier (500K commands/month). Aiven offers managed Valkey with 1 GB RAM free. Valkey, KeyDB, Garnet, and Memcached are fully free self-hosted. DragonflyDB is free self-hosted under BSL (non-competitive use).</p>`,
  },
  {
    slug: "ai-free-tiers",
    title: "Best Free AI APIs and Coding Tools in 2026",
    metaDesc: "Compare free AI APIs, LLM inference, and coding tools — exact rate limits and free tier details for Groq, Cerebras, Mistral, OpenAI, Gemini, Cursor, GitHub Copilot, and 50+ more. Updated March 2026.",
    contextHtml: "", // Custom page — contextHtml not used by buildTimelyAlternativesPage
    tag: "ai-free-tier", // Not used — custom build function
    primaryVendor: "OpenAI", // Not used — custom build function
    hubDesc: "Compare 65 free AI APIs, LLM inference, vector databases, and coding tools — exact limits and rate caps",
  },
  {
    slug: "database-alternatives",
    title: "Best Free Database Hosting for Developers in 2026",
    metaDesc: "Compare 30+ free database hosting options — Postgres, MongoDB, Redis, SQLite, graph, vector, and time-series. Exact free tier limits for Supabase, Neon, Turso, Upstash, and more. Updated March 2026.",
    contextHtml: "", // Custom page — contextHtml not used by buildTimelyAlternativesPage
    tag: "database-alternative", // Not used — custom build function
    primaryVendor: "Supabase", // Not used — custom build function
    hubDesc: "Compare 30+ free databases by type — Postgres, document, key-value, edge, graph, vector, and time-series",
  },
  {
    slug: "hosting-alternatives",
    title: "Best Free Hosting for Developers in 2026 — PaaS, Static, Serverless, Containers & VPS",
    metaDesc: "Compare 30+ free hosting options — Railway, Render, Vercel, Netlify, Cloudflare, Fly.io, Oracle Cloud, and more. Exact free tier limits for PaaS, static, serverless, container, and VPS hosting. Updated March 2026.",
    contextHtml: "", // Custom page — contextHtml not used by buildTimelyAlternativesPage
    tag: "hosting-alternative", // Not used — custom build function
    primaryVendor: "Heroku", // Not used — custom build function
    hubDesc: "Compare 30+ free hosting options by type — PaaS, static/JAMstack, serverless, containers, VPS, and edge/CDN",
  },
  {
    slug: "monitoring-alternatives",
    title: "Best Free Monitoring Tools for Developers in 2026 — APM, Uptime, Logs & Error Tracking",
    metaDesc: "Compare 70+ free monitoring tools — New Relic, Grafana Cloud, Datadog, Sentry, BetterStack, UptimeRobot, and more. Exact free tier limits by monitoring type. Updated March 2026.",
    contextHtml: "", // Custom page — contextHtml not used by buildTimelyAlternativesPage
    tag: "monitoring-alternative", // Not used — custom build function
    primaryVendor: "Datadog", // Not used — custom build function
    hubDesc: "Compare 70+ free monitoring tools by type — APM, uptime, logs, error tracking, and infrastructure",
  },
  {
    slug: "email-service-alternatives",
    title: "Email Service Alternatives — Best Free Transactional Email APIs for 2026",
    metaDesc: "SendGrid restricted to 100/day, Mailgun killed its free tier. Compare free alternatives: Resend (3K/mo), Mailjet (6K/mo), Brevo (300/day), Postmark, Loops, AhaSend. Verified 2026 limits.",
    contextHtml: `<p><strong>Transactional email</strong> — password resets, order confirmations, verification codes — is non-negotiable infrastructure for any app. But the landscape has shifted dramatically: <strong>SendGrid</strong> cut its free tier to just <strong>100 emails/day</strong> with mandatory phone verification, and <strong>Mailgun</strong> eliminated its free tier entirely (now a 30-day trial).</p>
    <p>The good news: several developer-focused alternatives now offer generous free tiers. <strong>Resend</strong> gives you 3,000 emails/month with a modern React Email integration. <strong>Mailjet</strong> offers 6,000/month (200/day cap). <strong>Brevo</strong> provides 300/day with unlimited contacts. And newer entrants like <strong>Loops</strong> and <strong>AhaSend</strong> are competing hard on developer experience and pricing.</p>
    <p>Below are the best free email services for developers in 2026, compared by volume limits, API quality, and what you actually get for free.</p>`,
    tag: "email-service-alternative",
    primaryVendor: "SendGrid",
    hubDesc: "SendGrid down to 100/day, Mailgun free tier gone — 8 free transactional email alternatives compared",
    serviceMatrixHtml: `
  <h2>Free Tier Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">What you actually get for free on each email platform. SendGrid gives you 100 emails/day with phone verification required — most alternatives offer dramatically more.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Platform</th>
        <th>Monthly Volume</th>
        <th>Contacts</th>
        <th>Type</th>
        <th>API/SMTP</th>
        <th>Best For</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600;color:var(--text-dim)">SendGrid</td>
        <td>~3K/mo (100/day)</td>
        <td>2K</td>
        <td>Both</td>
        <td>\u2705 / \u2705</td>
        <td style="color:var(--text-dim)">Legacy — phone verification required</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/resend" style="color:var(--text)">Resend</a></td>
        <td>3K/mo</td>
        <td>Unlimited</td>
        <td>Transactional</td>
        <td>\u2705 / \u2705</td>
        <td>Developer-first — React Email, TypeScript SDK</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/mailjet" style="color:var(--text)">Mailjet</a></td>
        <td>6K/mo (200/day)</td>
        <td>Unlimited</td>
        <td>Both</td>
        <td>\u2705 / \u2705</td>
        <td>Highest free volume — built-in email editor</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/brevo" style="color:var(--text)">Brevo</a></td>
        <td>~9K/mo (300/day)</td>
        <td>Unlimited</td>
        <td>Both</td>
        <td>\u2705 / \u2705</td>
        <td>All-in-one — email, SMS, CRM, automation</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/loops" style="color:var(--text)">Loops</a></td>
        <td>4K/30 days</td>
        <td>1K</td>
        <td>Both</td>
        <td>\u2705 / \u2014</td>
        <td>Modern UX — marketing + transactional combined</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/postmark" style="color:var(--text)">Postmark</a></td>
        <td>100/mo</td>
        <td>Unlimited</td>
        <td>Transactional</td>
        <td>\u2705 / \u2705</td>
        <td>Best deliverability — focused on transactional only</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/ahasend" style="color:var(--text)">AhaSend</a></td>
        <td>1K/mo</td>
        <td>Unlimited</td>
        <td>Transactional</td>
        <td>\u2705 / \u2705</td>
        <td>Unlimited domains — simple API, no frills</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/buttondown" style="color:var(--text)">Buttondown</a></td>
        <td>Unlimited*</td>
        <td>100</td>
        <td>Newsletter</td>
        <td>\u2705 / \u2014</td>
        <td>Newsletters — Markdown-native, simple UX</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/mailchimp" style="color:var(--text)">Mailchimp</a></td>
        <td>500/mo</td>
        <td>250</td>
        <td>Marketing</td>
        <td>\u2705 / \u2014</td>
        <td>Marketing email — templates, automation, analytics</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">*Buttondown's free tier is unlimited sends but capped at 100 subscribers. Mailjet's 6K/month is split into a 200/day sending limit. Brevo's 300/day works out to ~9K/month. All volumes are approximate where daily caps apply.</p>`,
  },
  {
    slug: "ci-cd-alternatives",
    title: "Best Free CI/CD Tools for Developers in 2026 — Build Minutes, Runners & Pipelines Compared",
    metaDesc: "Compare 35+ free CI/CD tools — GitHub Actions, GitLab CI, CircleCI, Buildkite, Harness CI, Drone CI, and more. Exact free tier limits by CI/CD type. Updated March 2026.",
    contextHtml: "",
    tag: "ci-cd-hub",
    primaryVendor: "GitHub Actions",
    hubDesc: "35+ free CI/CD tools compared — build minutes, runners, and pipelines by type (general, cloud-native, mobile, IaC)",
  },
  {
    slug: "security-alternatives",
    title: "Best Free Security Tools for Developers in 2026 — SAST, Secrets, Auth & Container Security",
    metaDesc: "Compare 100+ free security tools — Snyk, Semgrep, CodeQL, GitGuardian, Trivy, Auth0, Clerk, and more. Exact free tier limits by security domain. Updated March 2026.",
    contextHtml: "",
    tag: "security-hub",
    primaryVendor: "Snyk",
    hubDesc: "100+ free security tools compared — SAST/DAST, secret scanning, dependency analysis, container security, and identity/auth",
  },
  {
    slug: "storage-alternatives",
    title: "Best Free Cloud Storage for Developers in 2026 — Object Storage, Media CDN & File Hosting Compared",
    metaDesc: "Compare 55+ free cloud storage tools — Cloudflare R2, Backblaze B2, Tigris, Cloudinary, ImageKit, Google Cloud Storage, and more. Exact free tier limits by storage type. Updated March 2026.",
    contextHtml: "",
    tag: "storage-hub",
    primaryVendor: "Cloudflare R2",
    hubDesc: "55+ free cloud storage tools compared — object storage, media/image CDN, file hosting, and general-purpose storage",
  },
  {
    slug: "testing-alternatives",
    title: "Best Free Testing Tools for Developers in 2026 — Browser, Visual, Load, E2E & API Testing Compared",
    metaDesc: "Compare 45+ free testing tools — Cypress, BrowserStack, Playwright, k6, Percy, Chromatic, Postman, Selenium, and more. Exact free tier limits by testing domain. Updated March 2026.",
    contextHtml: "",
    tag: "testing-hub",
    primaryVendor: "Cypress Cloud",
    hubDesc: "45+ free testing tools compared — browser, visual regression, load, E2E, API, and code coverage",
  },
  {
    slug: "analytics-alternatives",
    title: "Best Free Analytics Tools for Developers in 2026 — Product, Web, Event & Data Analytics Compared",
    metaDesc: "Compare 45+ free analytics tools — PostHog, Amplitude, Mixpanel, Plausible, Umami, Tinybird, Segment, and more. Exact free tier limits by analytics domain. Updated March 2026.",
    contextHtml: "",
    tag: "analytics-hub",
    primaryVendor: "PostHog",
    hubDesc: "45+ free analytics tools compared — product analytics, web analytics, event tracking, and data infrastructure",
  },
  {
    slug: "ai-ml-alternatives",
    title: "Best Free AI & ML Tools for Developers in 2026 — LLM APIs, AI Coding, Training & Observability Compared",
    metaDesc: "Compare 65+ free AI/ML tools — Groq, Cerebras, OpenAI, Hugging Face, GitHub Copilot, Cursor, Langfuse, and more. Exact free tier limits by AI domain. Updated March 2026.",
    contextHtml: "",
    tag: "ai-ml-hub",
    primaryVendor: "OpenAI",
    hubDesc: "65+ free AI/ML tools compared — LLM APIs, AI coding assistants, ML platforms, observability, and specialized AI services",
  },
  {
    slug: "design-alternatives",
    title: "Best Free Design Tools for Developers in 2026 — UI Kits, Prototyping, Icons & Assets Compared",
    metaDesc: "Compare 100+ free design tools — Figma, Penpot, Canva, ShadcnUI, Lucide, Unsplash, Coolors, and more. Exact free tier limits by design domain. Updated March 2026.",
    contextHtml: "",
    tag: "design-hub",
    primaryVendor: "Figma",
    hubDesc: "100+ free design tools compared — UI design, prototyping, component libraries, icons, stock assets, and color tools",
  },
  {
    slug: "email-alternatives",
    title: "Best Free Email Tools for Developers in 2026 — Transactional APIs, Marketing Platforms & Email Infrastructure Compared",
    metaDesc: "Compare 59+ free email tools — Resend, Brevo, Mailjet, SendGrid, Mailchimp, SimpleLogin, Proton Mail, and more. Exact free tier limits by email domain. Updated March 2026.",
    contextHtml: "",
    tag: "email-hub",
    primaryVendor: "Resend",
    hubDesc: "59+ free email tools compared — transactional APIs, marketing platforms, verification services, forwarding, and email infrastructure",
  },
  {
    slug: "project-management-alternatives",
    title: "Best Free Project Management & Collaboration Tools in 2026 — PM, Chat, Scheduling & Productivity Compared",
    metaDesc: "Compare 93+ free project management tools — Linear, Asana, Trello, ClickUp, Notion, Slack alternatives, Cal.com, and more. Exact free tier limits. Updated March 2026.",
    contextHtml: "",
    tag: "pm-hub",
    primaryVendor: "Linear",
    hubDesc: "93+ free project management tools compared — issue tracking, kanban boards, team chat, video conferencing, scheduling, and knowledge management",
  },
];

const alternativesPageMap = new Map<string, AlternativesPageConfig>();
const editorialByVendor = new Map<string, AlternativesPageConfig>();
for (const page of ALTERNATIVES_PAGES) {
  alternativesPageMap.set(page.slug, page);
  editorialByVendor.set(page.primaryVendor.toLowerCase(), page);
}

function buildTimelyAlternativesPage(slug: string): string | null {
  const config = alternativesPageMap.get(slug);
  if (!config) return null;

  const riskColors: Record<string, string> = { stable: "#3fb950", caution: "#d29922", risky: "#f85149" };

  // Get the primary vendor's deal change
  const primaryChange = dealChanges.find(c => c.vendor === config.primaryVendor);

  // Get all alternatives tagged in our index (excluding the primary vendor)
  const taggedOffers = offers.filter(o => o.tags?.includes(config.tag) && o.vendor !== config.primaryVendor);
  const enriched = enrichOffers(taggedOffers);

  // Also get any other offers in the same category that might be relevant
  // Skip category section when we have enough tagged alternatives (6+)
  const primaryOffer = offers.find(o => o.vendor === config.primaryVendor);
  const categoryOffers = taggedOffers.length >= 6 ? [] : (primaryOffer
    ? offers.filter(o => o.category === primaryOffer.category && o.vendor !== config.primaryVendor && !taggedOffers.some(t => t.vendor === o.vendor))
    : []);
  const enrichedCategory = enrichOffers(categoryOffers.slice(0, 5));

  // Build alternative cards
  const altCards = enriched.map((o) => {
    const riskBadge = o.risk_level ? `<span style="display:inline-block;font-size:.7rem;padding:.15rem .5rem;border-radius:10px;background:${riskColors[o.risk_level]}22;color:${riskColors[o.risk_level]};font-weight:600;margin-left:.5rem">${o.risk_level}</span>` : "";
    return `      <div class="alt-card">
        <div class="alt-card-header">
          <a href="/vendor/${toSlug(o.vendor)}" class="alt-card-name">${escHtmlServer(o.vendor)}</a>
          <span class="alt-card-tier">${escHtmlServer(o.tier)}</span>
          ${riskBadge}
        </div>
        <p class="alt-card-desc">${escHtmlServer(o.description)}</p>
        <div class="alt-card-links">
          <a href="/vendor/${toSlug(o.vendor)}">Full profile</a>
          <a href="/alternative-to/${toSlug(o.vendor)}">More alternatives</a>
          <a href="${escHtmlServer(o.url)}" target="_blank" rel="noopener">Pricing page &nearr;</a>
        </div>
      </div>`;
  }).join("\n");

  // Category offers section
  const categoryHtml = enrichedCategory.length > 0 ? `
  <h2>Other ${escHtmlServer(primaryOffer?.category ?? "")} Tools</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">More free tools in the same category that may fit your needs.</p>
  ${enrichedCategory.map((o) => {
    const riskBadge = o.risk_level ? `<span style="display:inline-block;font-size:.7rem;padding:.15rem .5rem;border-radius:10px;background:${riskColors[o.risk_level]}22;color:${riskColors[o.risk_level]};font-weight:600;margin-left:.5rem">${o.risk_level}</span>` : "";
    return `      <div class="alt-card" style="border-color:var(--border)">
        <div class="alt-card-header">
          <a href="/vendor/${toSlug(o.vendor)}" class="alt-card-name">${escHtmlServer(o.vendor)}</a>
          <span class="alt-card-tier">${escHtmlServer(o.tier)}</span>
          ${riskBadge}
        </div>
        <p class="alt-card-desc">${escHtmlServer(o.description)}</p>
        <div class="alt-card-links">
          <a href="/vendor/${toSlug(o.vendor)}">Full profile</a>
          <a href="${escHtmlServer(o.url)}" target="_blank" rel="noopener">Pricing page &nearr;</a>
        </div>
      </div>`;
  }).join("\n")}` : "";

  // Comparison table
  const allAlts = [...enriched, ...enrichedCategory];
  const tableRows = allAlts.map((o) => `        <tr>
          <td style="font-weight:600"><a href="/vendor/${toSlug(o.vendor)}" style="color:var(--text)">${escHtmlServer(o.vendor)}</a></td>
          <td style="font-family:var(--mono);color:var(--accent)">${escHtmlServer(o.tier)}</td>
          <td style="color:var(--text-muted);max-width:300px">${escHtmlServer(o.description.slice(0, 120))}${o.description.length > 120 ? "..." : ""}</td>
          <td><span style="color:${riskColors[o.risk_level ?? "stable"]}">${o.risk_level ?? "stable"}</span></td>
        </tr>`).join("\n");

  // JSON-LD
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: config.title,
    description: config.metaDesc,
    numberOfItems: allAlts.length,
    itemListElement: allAlts.map((o, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "SoftwareApplication",
        name: o.vendor,
        description: o.description,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: o.tier },
        url: o.url,
      },
    })),
  };

  // Deal change context
  const changeHtml = primaryChange ? `
  <div class="context-box" style="border-left:3px solid ${riskColors.risky}">
    <div style="font-weight:600;color:${riskColors.risky};margin-bottom:.25rem">${escHtmlServer(primaryChange.change_type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()))}</div>
    <p style="margin:.25rem 0">${escHtmlServer(primaryChange.summary)}</p>
    <div style="font-size:.8rem;color:var(--text-dim);margin-top:.5rem">
      <strong>Before:</strong> ${escHtmlServer(primaryChange.previous_state)}<br>
      <strong>After:</strong> ${escHtmlServer(primaryChange.current_state)}
    </div>
  </div>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(config.title)} — AgentDeals</title>
<meta name="description" content="${escHtmlServer(config.metaDesc)}">
<link rel="canonical" href="${BASE_URL}/${slug}">
<meta property="og:title" content="${escHtmlServer(config.title)}">
<meta property="og:description" content="${escHtmlServer(config.metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/${slug}">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
h2{font-family:var(--serif);font-size:1.4rem;color:var(--text);margin:2.5rem 0 1rem;letter-spacing:-.01em}
.context{color:var(--text-muted);margin-bottom:1.5rem;font-size:.95rem;line-height:1.7}
.context strong{color:var(--text)}
.context-box{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1rem 1.25rem;margin:1.5rem 0;font-size:.9rem;color:var(--text-muted)}
.alt-card{padding:1.25rem;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;background:var(--bg-card);margin-bottom:.75rem;transition:border-color .2s}
.alt-card:hover{border-color:var(--accent)}
.alt-card-header{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem}
.alt-card-name{font-size:1.1rem;font-weight:600;color:var(--text)}
.alt-card-name:hover{color:var(--accent)}
.alt-card-tier{font-family:var(--mono);color:var(--accent);font-size:.8rem;padding:.1rem .5rem;background:var(--accent-glow);border-radius:10px}
.alt-card-desc{color:var(--text-muted);font-size:.9rem;line-height:1.5;margin:.5rem 0}
.alt-card-links{display:flex;flex-wrap:wrap;gap:.75rem;font-size:.8rem;margin-top:.5rem}
.alt-card-links a{color:var(--accent);text-decoration:none}
.alt-card-links a:hover{text-decoration:underline}
.compare-table{width:100%;border-collapse:collapse;margin:1rem 0 2rem}
.compare-table th,.compare-table td{padding:.5rem .75rem;text-align:left;border-bottom:1px solid var(--border);font-size:.85rem}
.compare-table th{color:var(--text-muted);font-weight:500;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
.compare-table tr:hover{background:var(--accent-glow)}
.search-cta{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.25rem;margin:2rem 0;text-align:center;font-size:.9rem}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.compare-table{font-size:.75rem}.compare-table th,.compare-table td{padding:.4rem .5rem}}
${globalNavCss()}
${mcpCtaCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("alternatives")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; <a href="/alternative-to">Alternatives</a> &rsaquo; ${escHtmlServer(config.primaryVendor)}</div>
  <h1>${escHtmlServer(config.title.split(" — ")[0])}</h1>

  <div class="context">
    ${config.contextHtml}
  </div>

  ${changeHtml}

  <h2>Top Alternatives</h2>
${altCards}

${config.serviceMatrixHtml ?? ""}

${categoryHtml}

  <h2>Quick Comparison</h2>
  <table class="compare-table">
    <thead>
      <tr>
        <th>Tool</th>
        <th>Free Tier</th>
        <th>Details</th>
        <th>Stability</th>
      </tr>
    </thead>
    <tbody>
${tableRows}
    </tbody>
  </table>

  <div class="search-cta">
    ${vendorSlugMap.has(toSlug(config.primaryVendor)) ? `<p>Looking for more? <a href="/alternative-to/${toSlug(config.primaryVendor)}">Browse all free alternatives to ${config.primaryVendor} &rarr;</a></p>
    <p style="margin-top:.5rem;font-size:.85rem;color:var(--text-dim)">Or <a href="/search?q=${encodeURIComponent(config.primaryVendor.toLowerCase() + " alternative")}">search</a> our full index of ${offers.length.toLocaleString()}+ developer deals.</p>` : `<p>Looking for more? <a href="/search?q=${encodeURIComponent(config.primaryVendor.toLowerCase() + " alternative")}">Search all ${config.primaryVendor} alternatives</a> in our index of ${offers.length.toLocaleString()}+ developer deals.</p>`}
  </div>

  ${buildMoreAlternativesGuides(slug)}

  ${buildMcpCta("Get personalized recommendations from your AI. Search " + offers.length.toLocaleString() + "+ deals, compare free tiers, and track pricing changes — directly in your editor.")}
  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
<script>${mcpCtaScript()}</script>
</body>
</html>`;
}

function buildMoreAlternativesGuides(currentSlug: string): string {
  const others = ALTERNATIVES_PAGES.filter(p => p.slug !== currentSlug);
  if (others.length === 0) return "";
  const items = others.map(p =>
    `<li><a href="/${p.slug}">${escHtmlServer(p.title.split(" — ")[0])}</a> <span style="color:var(--text-muted);font-size:.85rem">— ${escHtmlServer(p.hubDesc)}</span></li>`
  ).join("\n      ");
  return `<div class="more-guides" style="margin:2.5rem 0 1rem;padding:1.25rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-card)">
    <h3 style="margin:0 0 .75rem;font-family:var(--serif);font-size:1rem;color:var(--text)">More Alternatives Guides</h3>
    <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.5rem">
      ${items}
    </ul>
    <p style="margin:.75rem 0 0;font-size:.85rem;color:var(--text-dim)"><a href="/alternatives">View all alternatives guides &rarr;</a></p>
  </div>`;
}

// --- Alternatives hub page ---

function buildAlternativesHubPage(): string {
  const title = "Alternatives Guides — Developer Tool Migration Guides";
  const metaDesc = `In-depth comparison guides for ${ALTERNATIVES_PAGES.length} major developer tool changes. Free tier comparisons, service matrices, and migration timelines.`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: title,
    description: metaDesc,
    numberOfItems: ALTERNATIVES_PAGES.length,
    itemListElement: ALTERNATIVES_PAGES.map((p, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "Article",
        name: p.title,
        description: p.hubDesc,
        url: `${BASE_URL}/${p.slug}`
      }
    }))
  };

  const cards = ALTERNATIVES_PAGES.map(p => {
    const shortTitle = p.title.split(" — ")[0];
    return `<a href="/${p.slug}" class="hub-card" style="display:block;padding:1.25rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);text-decoration:none;transition:border-color .15s,background .15s">
      <h2 style="margin:0 0 .5rem;font-size:1.1rem;color:var(--accent);font-family:var(--serif)">${escHtmlServer(shortTitle)}</h2>
      <p style="margin:0;font-size:.9rem;color:var(--text-muted);line-height:1.5">${escHtmlServer(p.hubDesc)}</p>
    </a>`;
  }).join("\n    ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)}</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/alternatives">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:url" content="${BASE_URL}/alternatives">
<meta property="og:type" content="website">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
:root{--bg:#0f172a;--bg-card:#1e293b;--bg-elevated:#1e293b;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-glow:rgba(59,130,246,.08);--border:#334155;--sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;--serif:'Georgia',serif;--mono:'SF Mono','Fira Code',monospace}
*{box-sizing:border-box}body{font-family:var(--sans);background:var(--bg);color:var(--text);margin:0;padding:0;line-height:1.6}
.container{max-width:800px;margin:0 auto;padding:1.5rem}
.breadcrumb{font-size:.85rem;color:var(--text-dim);margin-bottom:1.5rem}.breadcrumb a{color:var(--accent);text-decoration:none}.breadcrumb a:hover{text-decoration:underline}
h1{font-family:var(--serif);font-size:2rem;margin:0 0 .5rem}
.subtitle{color:var(--text-muted);font-size:1rem;margin:0 0 2rem;line-height:1.5}
.hub-cards{display:flex;flex-direction:column;gap:1rem;margin:0 0 2rem}
.hub-card:hover{border-color:var(--accent);background:var(--accent-glow)}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}}
${globalNavCss()}
${mcpCtaCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("alternatives")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; Alternatives Guides</div>
  <h1>Alternatives Guides</h1>
  <p class="subtitle">In-depth migration guides for major developer tool changes. Each guide compares free alternatives with service matrices, pricing details, and migration timelines.</p>

  <div class="hub-cards">
    ${cards}
  </div>

  <div style="text-align:center;margin:2rem 0;font-size:.9rem;color:var(--text-muted)">
    <p>Looking for a specific tool? <a href="/alternative-to" style="color:var(--accent)">Browse all ${Array.from(vendorSlugMap.keys()).length.toLocaleString()} vendor alternatives</a> or <a href="/search" style="color:var(--accent)">search</a> our full index of ${offers.length.toLocaleString()}+ developer deals.</p>
  </div>

  ${buildMcpCta("Get personalized migration advice from your AI assistant. Compare free tiers, track pricing changes, and plan your stack — directly in your editor.")}
  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
<script>${mcpCtaScript()}</script>
</body>
</html>`;
}

// --- AI Free Tiers editorial page ---

function buildAiFreeTiersPage(): string {
  const title = "Best Free AI APIs and Coding Tools in 2026";
  const metaDesc = "Compare free AI APIs, LLM inference, and coding tools — exact rate limits and free tier details for Groq, Cerebras, Mistral, OpenAI, Gemini, Cursor, GitHub Copilot, and 50+ more. Updated March 2026.";
  const slug = "ai-free-tiers";

  // Get AI/ML and AI Coding offers
  const aiMlOffers = offers.filter(o => o.category === "AI / ML");
  const aiCodingOffers = offers.filter(o => o.category === "AI Coding");
  const allAiOffers = [...aiMlOffers, ...aiCodingOffers];
  const enrichedMl = enrichOffers(aiMlOffers);
  const enrichedCoding = enrichOffers(aiCodingOffers);

  // Get AI-related deal changes
  const aiChangeVendors = ["Google Gemini", "OpenAI", "Cursor", "GitHub Copilot", "Google Gemini 2.0 Flash", "Cloudflare Workers AI"];
  const aiChanges = dealChanges.filter(c => aiChangeVendors.some(v => c.vendor.includes(v)));
  const riskColors: Record<string, string> = { stable: "#3fb950", caution: "#d29922", risky: "#f85149" };

  // Group AI/ML by subcategory
  const llmInference = enrichedMl.filter(o =>
    ["Groq", "Cerebras", "OpenRouter", "Mistral AI", "Cohere", "OpenAI", "Google Gemini API", "Cloudflare Workers AI", "Hugging Face", "Anthropic API", "xAI", "Replicate", "Baseten"].includes(o.vendor)
  );
  const vectorDbs = enrichedMl.filter(o =>
    ["Pinecone", "Qdrant"].includes(o.vendor)
  );
  const mlPlatforms = enrichedMl.filter(o =>
    !llmInference.some(l => l.vendor === o.vendor) && !vectorDbs.some(v => v.vendor === o.vendor)
  );

  // Build alternative cards helper
  const buildCards = (items: ReturnType<typeof enrichOffers>) => items.map(o => {
    const riskBadge = o.risk_level ? `<span style="display:inline-block;font-size:.7rem;padding:.15rem .5rem;border-radius:10px;background:${riskColors[o.risk_level]}22;color:${riskColors[o.risk_level]};font-weight:600;margin-left:.5rem">${o.risk_level}</span>` : "";
    return `<div class="alt-card">
        <div class="alt-card-header">
          <a href="/vendor/${toSlug(o.vendor)}" class="alt-card-name">${escHtmlServer(o.vendor)}</a>
          <span class="alt-card-tier">${escHtmlServer(o.tier)}</span>
          ${riskBadge}
        </div>
        <p class="alt-card-desc">${escHtmlServer(o.description)}</p>
        <div class="alt-card-links">
          <a href="/vendor/${toSlug(o.vendor)}">Full profile</a>
          <a href="/alternative-to/${toSlug(o.vendor)}">Alternatives</a>
          <a href="${escHtmlServer(o.url)}" target="_blank" rel="noopener">Pricing &nearr;</a>
        </div>
      </div>`;
  }).join("\n");

  // Recent changes callout
  const changesHtml = aiChanges.length > 0 ? `
  <div class="context-box" style="border-left:3px solid ${riskColors.caution}">
    <div style="font-weight:600;color:${riskColors.caution};margin-bottom:.5rem">Recent AI Pricing Changes</div>
    <ul style="margin:0;padding-left:1.25rem;font-size:.9rem;color:var(--text-muted);line-height:1.8">
      ${aiChanges.slice(0, 6).map(c => `<li><strong>${escHtmlServer(c.vendor)}</strong>: ${escHtmlServer(c.summary.length > 120 ? c.summary.substring(0, 117) + "..." : c.summary)}</li>`).join("\n      ")}
    </ul>
    <p style="margin:.75rem 0 0;font-size:.8rem"><a href="/changes">View all ${dealChanges.length} pricing changes &rarr;</a></p>
  </div>` : "";

  // LLM inference comparison table
  const topLlms = llmInference.filter(o =>
    ["Groq", "Cerebras", "Mistral AI", "OpenRouter", "Cohere", "OpenAI", "Google Gemini API", "Cloudflare Workers AI", "Hugging Face"].includes(o.vendor)
  );

  // JSON-LD
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: title,
    description: metaDesc,
    numberOfItems: allAiOffers.length,
    itemListElement: allAiOffers.slice(0, 20).map((o, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "SoftwareApplication",
        name: o.vendor,
        description: o.description,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: o.tier },
        url: o.url,
      },
    })),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)} — AgentDeals</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/${slug}">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/${slug}">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
h2{font-family:var(--serif);font-size:1.4rem;color:var(--text);margin:2.5rem 0 1rem;letter-spacing:-.01em}
h3{font-family:var(--serif);font-size:1.1rem;color:var(--text);margin:1.5rem 0 .5rem}
.context{color:var(--text-muted);margin-bottom:1.5rem;font-size:.95rem;line-height:1.7}
.context strong{color:var(--text)}
.context-box{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1rem 1.25rem;margin:1.5rem 0;font-size:.9rem;color:var(--text-muted)}
.alt-card{padding:1.25rem;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;background:var(--bg-card);margin-bottom:.75rem;transition:border-color .2s}
.alt-card:hover{border-color:var(--accent)}
.alt-card-header{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem}
.alt-card-name{font-size:1.1rem;font-weight:600;color:var(--text)}
.alt-card-name:hover{color:var(--accent)}
.alt-card-tier{font-family:var(--mono);color:var(--accent);font-size:.8rem;padding:.1rem .5rem;background:var(--accent-glow);border-radius:10px}
.alt-card-desc{color:var(--text-muted);font-size:.9rem;line-height:1.5;margin:.5rem 0}
.alt-card-links{display:flex;flex-wrap:wrap;gap:.75rem;font-size:.8rem;margin-top:.5rem}
.alt-card-links a{color:var(--accent);text-decoration:none}
.alt-card-links a:hover{text-decoration:underline}
.compare-table{width:100%;border-collapse:collapse;margin:1rem 0 2rem}
.compare-table th,.compare-table td{padding:.5rem .75rem;text-align:left;border-bottom:1px solid var(--border);font-size:.85rem}
.compare-table th{color:var(--text-muted);font-weight:500;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
.compare-table tr:hover{background:var(--accent-glow)}
.search-cta{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.25rem;margin:2rem 0;text-align:center;font-size:.9rem}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.compare-table{font-size:.75rem}.compare-table th,.compare-table td{padding:.4rem .5rem}}
${globalNavCss()}
${mcpCtaCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("alternatives")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; <a href="/alternatives">Alternatives</a> &rsaquo; AI Free Tiers</div>
  <h1>Best Free AI APIs and Coding Tools</h1>

  <div class="context">
    <p>The AI pricing landscape is volatile. <strong>Google slashed Gemini free tier limits 50-80%</strong> in late 2025. <strong>OpenAI discontinued free trial credits</strong> and deprecated the Assistants API. But new players are offering generous free tiers to win developer mindshare — <strong>Groq</strong> and <strong>Cerebras</strong> provide blazing-fast inference, <strong>Mistral</strong> offers 1 billion tokens/month, and <strong>Google Antigravity</strong> is 100% free during preview.</p>
    <p>This page compares <strong>${allAiOffers.length} free AI offers</strong> across our index — exact rate limits, not marketing copy. We track ${enrichedMl.length} AI/ML tools and ${enrichedCoding.length} AI coding tools, all verified against live pricing pages.</p>
  </div>

  ${changesHtml}

  <h2>Free AI APIs &amp; LLM Inference</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">API-accessible LLM inference — from ultra-fast open-model providers to the big labs. Sorted by generosity of free tier.</p>

  <h3>LLM Inference APIs</h3>
${buildCards(llmInference)}

${vectorDbs.length > 0 ? `
  <h3>Vector Databases</h3>
  <p style="color:var(--text-muted);margin-bottom:1rem;font-size:.9rem">Essential for RAG pipelines and semantic search.</p>
${buildCards(vectorDbs)}
` : ""}

  <h3>ML Platforms &amp; Specialized AI</h3>
  <p style="color:var(--text-muted);margin-bottom:1rem;font-size:.9rem">Experiment tracking, computer vision, speech-to-text, data labeling, and more.</p>
${buildCards(mlPlatforms)}

  <h2>LLM Inference Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Top free LLM inference APIs compared. Rate limits as of March 2026.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Provider</th>
        <th>Free Tier Limit</th>
        <th>Models</th>
        <th>Speed</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600"><a href="/vendor/groq" style="color:var(--text)">Groq</a></td>
        <td>~30 RPM</td>
        <td>Llama 3.3, Gemma 2, Mixtral</td>
        <td style="color:#3fb950">Ultra-fast (LPU)</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/cerebras" style="color:var(--text)">Cerebras</a></td>
        <td>1M tokens/day, 30 RPM</td>
        <td>Llama 3.3, Qwen 2.5</td>
        <td style="color:#3fb950">Ultra-fast (WSE)</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/mistral-ai" style="color:var(--text)">Mistral AI</a></td>
        <td>2 RPM, 1B tokens/month</td>
        <td>Mistral Large, Codestral, Pixtral</td>
        <td>Fast</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/openrouter" style="color:var(--text)">OpenRouter</a></td>
        <td>~30 free models</td>
        <td>DeepSeek R1, Llama 3.3, Qwen3</td>
        <td>Varies by model</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/cohere" style="color:var(--text)">Cohere</a></td>
        <td>1,000 calls/month</td>
        <td>Command R+, Embed, Rerank</td>
        <td>Standard</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/google-gemini-api" style="color:var(--text)">Google Gemini</a></td>
        <td style="color:#d29922">Reduced 50-80%</td>
        <td>Gemini 2.5 Flash, Pro removed</td>
        <td>Fast</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/openai" style="color:var(--text)">OpenAI</a></td>
        <td style="color:#f85149">GPT-3.5 only, 3 RPM</td>
        <td>GPT-3.5 Turbo</td>
        <td>Standard</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/cloudflare-workers-ai" style="color:var(--text)">Cloudflare Workers AI</a></td>
        <td>10,000 neurons/day</td>
        <td>Llama, Mistral, Stable Diffusion</td>
        <td>Edge (low latency)</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/hugging-face" style="color:var(--text)">Hugging Face</a></td>
        <td>$0.10/month credits</td>
        <td>200+ via Inference Pro</td>
        <td>Varies</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">Groq and Cerebras achieve 500+ tokens/second via custom silicon (LPU and WSE respectively). Mistral's 1B tokens/month is the most generous raw allowance but rate-limited to 2 RPM. OpenAI's free tier is now GPT-3.5 only after discontinuing trial credits. Gemini free tier limits were quietly reduced in late 2025.</p>

  <h2>Free AI Coding Tools</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">AI-powered code editors, assistants, and autonomous coding agents. From IDE plugins to fully autonomous engineers.</p>
  <div class="context-box" style="border-left:3px solid var(--accent)">
    <p style="margin:0;font-size:.9rem">Looking specifically at <strong>Cursor alternatives</strong>? See our dedicated <a href="/cursor-alternatives">Cursor Alternatives</a> guide with a side-by-side comparison table of free tiers, IDE types, and key strengths.</p>
  </div>
${buildCards(enrichedCoding)}

  <div class="search-cta">
    <p>Looking for more? <a href="/category/ai-ml">Browse all AI/ML tools</a> or <a href="/category/ai-coding">AI Coding tools</a> in our full index of ${offers.length.toLocaleString()}+ developer deals.</p>
  </div>

  ${buildMoreAlternativesGuides(slug)}

  ${buildMcpCta("Get AI tool recommendations from your AI assistant. Compare free tiers, track pricing changes, and plan your stack — directly in your editor.")}
  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
<script>${mcpCtaScript()}</script>
</body>
</html>`;
}

// --- Hosting Alternatives category hub page ---

function buildHostingAlternativesPage(): string {
  const title = "Best Free Hosting for Developers in 2026 — PaaS, Static, Serverless, Containers & VPS";
  const metaDesc = "Compare 30+ free hosting options — Railway, Render, Vercel, Netlify, Cloudflare, Fly.io, Oracle Cloud, and more. Exact free tier limits by hosting type. Updated March 2026.";
  const slug = "hosting-alternatives";

  // Get all hosting offers
  const hostingOffers = offers.filter(o => o.category === "Cloud Hosting" || o.category === "Cloud IaaS");
  const enrichedAll = enrichOffers(hostingOffers);
  const riskColors: Record<string, string> = { stable: "#3fb950", caution: "#d29922", risky: "#f85149" };

  // Group by hosting type
  const paas = enrichedAll.filter(o =>
    ["Railway", "Render", "Fly.io", "Koyeb", "Back4App", "Deno Deploy", "Northflank", "Coolify", "Sevalla (formerly Kinsta)", "Zeabur", "Alwaysdata", "Qoddi", "Claw.cloud"].includes(o.vendor)
  );
  const staticJamstack = enrichedAll.filter(o =>
    ["Cloudflare Pages", "Netlify", "Vercel", "GitHub Pages", "surge.sh", "Neocities", "readthedocs.org", "Versoly", "dAppling Network"].includes(o.vendor)
  );
  const serverless = enrichedAll.filter(o =>
    ["Cloudflare Workers", "Cloudflare Durable Objects", "Val Town", "PythonAnywhere", "YepCode", "Activepieces", "IFTTT", "Integrately"].includes(o.vendor)
  );
  const containers = enrichedAll.filter(o =>
    ["Google Cloud Run", "Fly.io", "Railway", "Render", "Koyeb"].includes(o.vendor) && !paas.some(p => p.vendor === o.vendor)
  );
  // Only include vendors not already in PaaS
  const containerDedicated = enrichedAll.filter(o =>
    ["Google Cloud Run"].includes(o.vendor)
  );
  const vpsIaas = enrichedAll.filter(o =>
    ["Oracle Cloud", "AWS", "Azure", "Google Compute Engine", "DigitalOcean", "Hetzner"].includes(o.vendor)
  );
  const edgeCdn = enrichedAll.filter(o =>
    ["Cloudflare Workers", "Cloudflare Pages", "4EVERLAND"].includes(o.vendor) && !staticJamstack.some(s => s.vendor === o.vendor) && !serverless.some(s => s.vendor === o.vendor)
  );
  const startupCredits = enrichedAll.filter(o =>
    ["AWS Activate", "Microsoft Founders Hub", "Cloudflare Startup Program", "Heroku for Startups Program", "Scaleway Startup Program", "Microsoft for Startups", "Startup with IBM", "Create@Alibaba Cloud", "Clever Bootstrap Program", "Google Cloud"].includes(o.vendor)
  );

  // Build cards helper
  const buildCards = (items: ReturnType<typeof enrichOffers>) => items.map(o => {
    const riskBadge = o.risk_level ? `<span style="display:inline-block;font-size:.7rem;padding:.15rem .5rem;border-radius:10px;background:${riskColors[o.risk_level]}22;color:${riskColors[o.risk_level]};font-weight:600;margin-left:.5rem">${o.risk_level}</span>` : "";
    return `<div class="alt-card">
        <div class="alt-card-header">
          <a href="/vendor/${toSlug(o.vendor)}" class="alt-card-name">${escHtmlServer(o.vendor)}</a>
          <span class="alt-card-tier">${escHtmlServer(o.tier)}</span>
          ${riskBadge}
        </div>
        <p class="alt-card-desc">${escHtmlServer(o.description)}</p>
        <div class="alt-card-links">
          <a href="/vendor/${toSlug(o.vendor)}">Full profile</a>
          <a href="/alternative-to/${toSlug(o.vendor)}">Alternatives</a>
          <a href="${escHtmlServer(o.url)}" target="_blank" rel="noopener">Pricing &nearr;</a>
        </div>
      </div>`;
  }).join("\n");

  // Hosting deal changes
  const hostingChangeVendors = ["Railway", "Render", "Fly.io", "Heroku", "Vercel", "Hetzner", "Netlify", "Cloudflare", "Koyeb", "Oracle Cloud", "DigitalOcean"];
  const hostingChanges = dealChanges.filter(c => hostingChangeVendors.some(v => c.vendor.includes(v)));
  const changesHtml = hostingChanges.length > 0 ? `
  <div class="context-box" style="border-left:3px solid ${riskColors.caution}">
    <div style="font-weight:600;color:${riskColors.caution};margin-bottom:.5rem">Recent Hosting Pricing Changes</div>
    <ul style="margin:0;padding-left:1.25rem;font-size:.9rem;color:var(--text-muted);line-height:1.8">
      ${hostingChanges.slice(0, 8).map(c => `<li><strong>${escHtmlServer(c.vendor)}</strong>: ${escHtmlServer(c.summary.length > 120 ? c.summary.substring(0, 117) + "..." : c.summary)}</li>`).join("\n      ")}
    </ul>
    <p style="margin:.75rem 0 0;font-size:.8rem"><a href="/changes">View all ${dealChanges.length} pricing changes &rarr;</a></p>
  </div>` : "";

  // JSON-LD
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: title,
    description: metaDesc,
    numberOfItems: hostingOffers.length,
    itemListElement: enrichedAll.slice(0, 30).map((o, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "SoftwareApplication",
        name: o.vendor,
        description: o.description,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: o.tier },
        url: o.url,
      },
    })),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)} — AgentDeals</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/${slug}">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/${slug}">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
h2{font-family:var(--serif);font-size:1.4rem;color:var(--text);margin:2.5rem 0 1rem;letter-spacing:-.01em}
h3{font-family:var(--serif);font-size:1.1rem;color:var(--text);margin:1.5rem 0 .5rem}
.context{color:var(--text-muted);margin-bottom:1.5rem;font-size:.95rem;line-height:1.7}
.context strong{color:var(--text)}
.context-box{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1rem 1.25rem;margin:1.5rem 0;font-size:.9rem;color:var(--text-muted)}
.alt-card{padding:1.25rem;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;background:var(--bg-card);margin-bottom:.75rem;transition:border-color .2s}
.alt-card:hover{border-color:var(--accent)}
.alt-card-header{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem}
.alt-card-name{font-size:1.1rem;font-weight:600;color:var(--text)}
.alt-card-name:hover{color:var(--accent)}
.alt-card-tier{font-family:var(--mono);color:var(--accent);font-size:.8rem;padding:.1rem .5rem;background:var(--accent-glow);border-radius:10px}
.alt-card-desc{color:var(--text-muted);font-size:.9rem;line-height:1.5;margin:.5rem 0}
.alt-card-links{display:flex;flex-wrap:wrap;gap:.75rem;font-size:.8rem;margin-top:.5rem}
.alt-card-links a{color:var(--accent);text-decoration:none}
.alt-card-links a:hover{text-decoration:underline}
.compare-table{width:100%;border-collapse:collapse;margin:1rem 0 2rem}
.compare-table th,.compare-table td{padding:.5rem .75rem;text-align:left;border-bottom:1px solid var(--border);font-size:.85rem}
.compare-table th{color:var(--text-muted);font-weight:500;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
.compare-table tr:hover{background:var(--accent-glow)}
.search-cta{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.25rem;margin:2rem 0;text-align:center;font-size:.9rem}
.decision-guide{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.5rem;margin:2rem 0}
.decision-guide dt{font-weight:600;color:var(--text);margin-top:1rem}
.decision-guide dt:first-child{margin-top:0}
.decision-guide dd{color:var(--text-muted);font-size:.9rem;margin:.25rem 0 0 0;line-height:1.6}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.compare-table{font-size:.75rem}.compare-table th,.compare-table td{padding:.4rem .5rem}}
${globalNavCss()}
${mcpCtaCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("alternatives")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; <a href="/alternatives">Alternatives</a> &rsaquo; Free Hosting</div>
  <h1>Best Free Hosting for Developers</h1>

  <div class="context">
    <p>Finding free hosting in 2026 is both easier and harder than ever. Easier because there are <strong>${hostingOffers.length} options</strong> across PaaS, static hosting, serverless functions, containers, and traditional VPS. Harder because the landscape keeps shifting — <strong>Heroku killed its free tier</strong> in 2022, <strong>Render now spins down free services</strong> after 15 minutes, <strong>Vercel moved to credit-based pricing</strong>, and <strong>Hetzner is raising prices 30-50%</strong> on April 1, 2026.</p>
    <p>This page compares every free hosting option in our index, organized by type, with exact limits verified against live pricing pages. Whether you need a PaaS for a full-stack app, static hosting for a portfolio, serverless functions for an API, or a VPS for full control — we have the comparison.</p>
  </div>

  ${changesHtml}

  <div class="context-box" style="border-left:3px solid var(--accent)">
    <p style="margin:0;font-size:.9rem">Looking for alternatives to a specific host? See our dedicated guides: <a href="/heroku-alternatives">Heroku Alternatives</a> | <a href="/vercel-alternatives">Vercel Alternatives</a> | <a href="/hetzner-alternatives">Hetzner Alternatives</a></p>
  </div>

  <h2>App Platforms / PaaS</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Full-featured platforms that handle deployment, scaling, and infrastructure. Deploy from Git, get a URL — the modern Heroku experience.</p>
${buildCards(paas)}

  <h2>Static &amp; JAMstack Hosting</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Deploy static sites, SPAs, and JAMstack apps with global CDN. Most generous free tiers in the hosting space — often unlimited bandwidth.</p>
${buildCards(staticJamstack)}

  <h2>Serverless / Functions</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Run code without managing servers. Pay-per-invocation models with generous free tiers for APIs, webhooks, and background jobs.</p>
${buildCards(serverless)}

${containerDedicated.length > 0 ? `
  <h2>Container Hosting</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Run Docker containers in the cloud. Many PaaS platforms above also support containers — these are dedicated container runtimes.</p>
  <p style="color:var(--text-muted);margin-bottom:1rem;font-size:.9rem"><strong>Note:</strong> <a href="/vendor/railway">Railway</a>, <a href="/vendor/render">Render</a>, <a href="/vendor/fly-io">Fly.io</a>, and <a href="/vendor/koyeb">Koyeb</a> (listed under PaaS above) also support Docker containers natively.</p>
${buildCards(containerDedicated)}
` : ""}

  <h2>VPS / IaaS</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Full virtual machines with root access. Maximum flexibility — you manage the OS, runtime, and deployment. Best for custom setups and production workloads.</p>
${buildCards(vpsIaas)}

${startupCredits.length > 0 ? `
  <h2>Startup Credit Programs</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Not free tiers, but substantial free credits for startups. Typically require application and may have eligibility requirements.</p>
${buildCards(startupCredits)}
` : ""}

  <h2>Free Hosting Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Top free hosting providers compared by compute resources, bandwidth, and best use case.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Provider</th>
        <th>Type</th>
        <th>Compute / Resources</th>
        <th>Bandwidth</th>
        <th>Best For</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600"><a href="/vendor/railway" style="color:var(--text)">Railway</a></td>
        <td>PaaS</td>
        <td>$5 credit/month</td>
        <td>Included</td>
        <td>Full-stack apps, databases, quick deploys</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/render" style="color:var(--text)">Render</a></td>
        <td>PaaS</td>
        <td>512 MB RAM, spins down</td>
        <td>100 GB/mo</td>
        <td>Web services, static sites, cron jobs</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/fly-io" style="color:var(--text)">Fly.io</a></td>
        <td>PaaS / Containers</td>
        <td>3 shared VMs, 256 MB each</td>
        <td>100 GB/mo</td>
        <td>Edge deployment, multi-region apps</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/koyeb" style="color:var(--text)">Koyeb</a></td>
        <td>PaaS</td>
        <td>1 nano instance</td>
        <td>100 GB/mo</td>
        <td>Containers, web services, global edge</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/deno-deploy" style="color:var(--text)">Deno Deploy</a></td>
        <td>Edge PaaS</td>
        <td>1M req/mo, 100K KV reads</td>
        <td>100 GB/mo</td>
        <td>Deno/TypeScript apps, edge functions</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/cloudflare-pages" style="color:var(--text)">Cloudflare Pages</a></td>
        <td>Static + Functions</td>
        <td>Unlimited sites, 500 builds/mo</td>
        <td>Unlimited</td>
        <td>Static sites with edge functions</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/netlify" style="color:var(--text)">Netlify</a></td>
        <td>Static + Functions</td>
        <td>300 build min/mo, 125K fn calls</td>
        <td>100 GB/mo</td>
        <td>JAMstack, forms, identity</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/vercel" style="color:var(--text)">Vercel</a></td>
        <td>Static + Functions</td>
        <td>100 GB-hrs serverless, 100K fn calls</td>
        <td>100 GB/mo</td>
        <td>Next.js, React, frontend frameworks</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/github-pages" style="color:var(--text)">GitHub Pages</a></td>
        <td>Static</td>
        <td>1 GB storage</td>
        <td>100 GB/mo</td>
        <td>Docs, portfolios, project sites</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/cloudflare-workers" style="color:var(--text)">Cloudflare Workers</a></td>
        <td>Serverless</td>
        <td>100K req/day, 10ms CPU</td>
        <td>Unlimited</td>
        <td>Edge APIs, lightweight compute</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/google-cloud-run" style="color:var(--text)">Google Cloud Run</a></td>
        <td>Containers</td>
        <td>2M req/mo, 360K vCPU-sec</td>
        <td>1 GB/mo</td>
        <td>Containerized APIs, auto-scaling to zero</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/oracle-cloud" style="color:var(--text)">Oracle Cloud</a></td>
        <td>VPS / IaaS</td>
        <td>4 Arm VMs (24 GB total), 200 GB storage</td>
        <td>10 TB/mo</td>
        <td>Always-free VMs, most generous IaaS tier</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/aws" style="color:var(--text)">AWS</a></td>
        <td>IaaS</td>
        <td>750 hrs t2.micro/mo (12 mo)</td>
        <td>100 GB/mo (12 mo)</td>
        <td>Full cloud platform, 12-month free tier</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">Oracle Cloud's Always Free tier is permanently free (not time-limited) and the most generous VPS offering. Cloudflare Pages and Workers offer unlimited bandwidth on free tier. Railway's $5/month credit covers small projects entirely. AWS and Azure free tiers are mostly 12-month introductory offers. All limits verified against live pricing pages, March 2026.</p>

  <div class="context-box" style="border-left:3px solid ${riskColors.risky}">
    <div style="font-weight:600;color:${riskColors.risky};margin-bottom:.5rem">Hetzner Price Hike — April 1, 2026</div>
    <p style="margin:0;font-size:.9rem">Hetzner Cloud and dedicated server prices are increasing <strong>30-50%</strong> on April 1, 2026. Entry-level CX23: &euro;2.99&rarr;&euro;3.99/mo (+33%). If you're on Hetzner or considering it, see our <a href="/hetzner-alternatives">Hetzner Alternatives</a> guide for options.</p>
  </div>

  <h2>Which Free Hosting Should I Use?</h2>
  <div class="decision-guide">
    <dl>
      <dt>Deploying a static site or portfolio?</dt>
      <dd><a href="/vendor/cloudflare-pages">Cloudflare Pages</a> (unlimited bandwidth, fast global CDN) or <a href="/vendor/github-pages">GitHub Pages</a> (simplest setup, great for docs). <a href="/vendor/netlify">Netlify</a> and <a href="/vendor/vercel">Vercel</a> add serverless functions if you need them.</dd>

      <dt>Building a full-stack web app?</dt>
      <dd><a href="/vendor/railway">Railway</a> ($5/month credit, supports databases) or <a href="/vendor/render">Render</a> (free web services, spins down after 15 min). For edge deployment, <a href="/vendor/fly-io">Fly.io</a> gives 3 shared VMs.</dd>

      <dt>Building a Next.js or React app?</dt>
      <dd><a href="/vendor/vercel">Vercel</a> is purpose-built for Next.js with the best DX. <a href="/vendor/cloudflare-pages">Cloudflare Pages</a> is the alternative with unlimited bandwidth. <a href="/vendor/netlify">Netlify</a> supports most frameworks.</dd>

      <dt>Need an API or serverless functions?</dt>
      <dd><a href="/vendor/cloudflare-workers">Cloudflare Workers</a> (100K req/day, edge-fast) for lightweight APIs. <a href="/vendor/deno-deploy">Deno Deploy</a> for TypeScript-native. <a href="/vendor/google-cloud-run">Google Cloud Run</a> for containerized APIs with auto-scale.</dd>

      <dt>Need a full VM with root access?</dt>
      <dd><a href="/vendor/oracle-cloud">Oracle Cloud</a> is unmatched — 4 Arm VMs, 24 GB RAM, 200 GB storage, permanently free. <a href="/vendor/aws">AWS</a> and <a href="/vendor/azure">Azure</a> offer 12-month free tiers with t2.micro/B1 instances.</dd>

      <dt>Running Docker containers?</dt>
      <dd><a href="/vendor/google-cloud-run">Google Cloud Run</a> (scale to zero, 2M req/mo free) or <a href="/vendor/fly-io">Fly.io</a> (3 shared VMs). <a href="/vendor/railway">Railway</a> and <a href="/vendor/koyeb">Koyeb</a> also run containers natively.</dd>

      <dt>Need hosting for a startup?</dt>
      <dd>Check the startup credit programs above. <a href="/vendor/aws-activate">AWS Activate</a> and <a href="/vendor/microsoft-founders-hub">Microsoft Founders Hub</a> offer the largest credit packages. <a href="/vendor/railway">Railway</a> and <a href="/vendor/render">Render</a> are popular for early-stage startups.</dd>

      <dt>Coming from Heroku?</dt>
      <dd>See our dedicated <a href="/heroku-alternatives">Heroku Alternatives</a> guide. TL;DR: <a href="/vendor/railway">Railway</a> is the closest experience, <a href="/vendor/render">Render</a> is the most popular alternative, and <a href="/vendor/fly-io">Fly.io</a> offers the most control.</dd>
    </dl>
  </div>

  <div class="search-cta">
    <p>Looking for more? <a href="/category/cloud-hosting">Browse all Cloud Hosting tools</a> or <a href="/category/cloud-iaas">Cloud IaaS tools</a> in our full index of ${offers.length.toLocaleString()}+ developer deals.</p>
  </div>

  ${buildMoreAlternativesGuides(slug)}

  ${buildMcpCta("Get hosting recommendations from your AI assistant. Compare free tiers, track pricing changes, and plan your stack — directly in your editor.")}
  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
<script>${mcpCtaScript()}</script>
</body>
</html>`;
}

// --- Database Alternatives category hub page ---

function buildDatabaseAlternativesPage(): string {
  const title = "Best Free Database Hosting for Developers in 2026";
  const metaDesc = "Compare 30+ free database hosting options — Postgres, MongoDB, Redis, SQLite, graph, vector, and time-series. Exact free tier limits for Supabase, Neon, Turso, Upstash, and more. Updated March 2026.";
  const slug = "database-alternatives";

  // Get all database offers
  const dbOffers = offers.filter(o => o.category === "Databases");
  const enrichedAll = enrichOffers(dbOffers);
  const riskColors: Record<string, string> = { stable: "#3fb950", caution: "#d29922", risky: "#f85149" };

  // Group by database type
  const relational = enrichedAll.filter(o =>
    ["Supabase", "Neon", "CockroachDB", "Xata", "Aiven", "Nile", "Nhost", "Hasura Cloud"].includes(o.vendor)
  );
  const document = enrichedAll.filter(o =>
    ["MongoDB Atlas", "Firebase", "Appwrite Cloud", "Convex", "PocketBase", "SurrealDB Cloud", "Couchbase Capella"].includes(o.vendor)
  );
  const keyValue = enrichedAll.filter(o =>
    ["Upstash", "Redis Cloud", "Momento", "Cloudflare KV"].includes(o.vendor)
  );
  const edge = enrichedAll.filter(o =>
    ["Turso", "Cloudflare D1", "DynamoDB Local"].includes(o.vendor)
  );
  const graph = enrichedAll.filter(o =>
    ["Neo4j AuraDB", "Gel"].includes(o.vendor)
  );
  const vector = enrichedAll.filter(o =>
    ["Weaviate", "Zilliz Cloud", "LanceDB", "Upstash Vector"].includes(o.vendor) || (o.vendor === "Pinecone" || o.vendor === "Qdrant Cloud" || o.vendor === "Qdrant")
  );
  const timeSeries = enrichedAll.filter(o =>
    ["InfluxDB Cloud", "CrateDB"].includes(o.vendor)
  );

  // Build cards helper
  const buildCards = (items: ReturnType<typeof enrichOffers>) => items.map(o => {
    const riskBadge = o.risk_level ? `<span style="display:inline-block;font-size:.7rem;padding:.15rem .5rem;border-radius:10px;background:${riskColors[o.risk_level]}22;color:${riskColors[o.risk_level]};font-weight:600;margin-left:.5rem">${o.risk_level}</span>` : "";
    return `<div class="alt-card">
        <div class="alt-card-header">
          <a href="/vendor/${toSlug(o.vendor)}" class="alt-card-name">${escHtmlServer(o.vendor)}</a>
          <span class="alt-card-tier">${escHtmlServer(o.tier)}</span>
          ${riskBadge}
        </div>
        <p class="alt-card-desc">${escHtmlServer(o.description)}</p>
        <div class="alt-card-links">
          <a href="/vendor/${toSlug(o.vendor)}">Full profile</a>
          <a href="/alternative-to/${toSlug(o.vendor)}">Alternatives</a>
          <a href="${escHtmlServer(o.url)}" target="_blank" rel="noopener">Pricing &nearr;</a>
        </div>
      </div>`;
  }).join("\n");

  // Database deal changes
  const dbChangeVendors = ["MongoDB Atlas", "Redis Cloud", "Firebase", "Supabase", "Neon", "Turso", "Upstash", "CockroachDB"];
  const dbChanges = dealChanges.filter(c => dbChangeVendors.some(v => c.vendor.includes(v)));
  const changesHtml = dbChanges.length > 0 ? `
  <div class="context-box" style="border-left:3px solid ${riskColors.caution}">
    <div style="font-weight:600;color:${riskColors.caution};margin-bottom:.5rem">Recent Database Pricing Changes</div>
    <ul style="margin:0;padding-left:1.25rem;font-size:.9rem;color:var(--text-muted);line-height:1.8">
      ${dbChanges.slice(0, 6).map(c => `<li><strong>${escHtmlServer(c.vendor)}</strong>: ${escHtmlServer(c.summary.length > 120 ? c.summary.substring(0, 117) + "..." : c.summary)}</li>`).join("\n      ")}
    </ul>
    <p style="margin:.75rem 0 0;font-size:.8rem"><a href="/changes">View all ${dealChanges.length} pricing changes &rarr;</a></p>
  </div>` : "";

  // JSON-LD
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: title,
    description: metaDesc,
    numberOfItems: dbOffers.length,
    itemListElement: enrichedAll.slice(0, 30).map((o, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "SoftwareApplication",
        name: o.vendor,
        description: o.description,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: o.tier },
        url: o.url,
      },
    })),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)} — AgentDeals</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/${slug}">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/${slug}">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
h2{font-family:var(--serif);font-size:1.4rem;color:var(--text);margin:2.5rem 0 1rem;letter-spacing:-.01em}
h3{font-family:var(--serif);font-size:1.1rem;color:var(--text);margin:1.5rem 0 .5rem}
.context{color:var(--text-muted);margin-bottom:1.5rem;font-size:.95rem;line-height:1.7}
.context strong{color:var(--text)}
.context-box{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1rem 1.25rem;margin:1.5rem 0;font-size:.9rem;color:var(--text-muted)}
.alt-card{padding:1.25rem;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;background:var(--bg-card);margin-bottom:.75rem;transition:border-color .2s}
.alt-card:hover{border-color:var(--accent)}
.alt-card-header{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem}
.alt-card-name{font-size:1.1rem;font-weight:600;color:var(--text)}
.alt-card-name:hover{color:var(--accent)}
.alt-card-tier{font-family:var(--mono);color:var(--accent);font-size:.8rem;padding:.1rem .5rem;background:var(--accent-glow);border-radius:10px}
.alt-card-desc{color:var(--text-muted);font-size:.9rem;line-height:1.5;margin:.5rem 0}
.alt-card-links{display:flex;flex-wrap:wrap;gap:.75rem;font-size:.8rem;margin-top:.5rem}
.alt-card-links a{color:var(--accent);text-decoration:none}
.alt-card-links a:hover{text-decoration:underline}
.compare-table{width:100%;border-collapse:collapse;margin:1rem 0 2rem}
.compare-table th,.compare-table td{padding:.5rem .75rem;text-align:left;border-bottom:1px solid var(--border);font-size:.85rem}
.compare-table th{color:var(--text-muted);font-weight:500;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
.compare-table tr:hover{background:var(--accent-glow)}
.search-cta{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.25rem;margin:2rem 0;text-align:center;font-size:.9rem}
.decision-guide{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.5rem;margin:2rem 0}
.decision-guide dt{font-weight:600;color:var(--text);margin-top:1rem}
.decision-guide dt:first-child{margin-top:0}
.decision-guide dd{color:var(--text-muted);font-size:.9rem;margin:.25rem 0 0 0;line-height:1.6}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.compare-table{font-size:.75rem}.compare-table th,.compare-table td{padding:.4rem .5rem}}
${globalNavCss()}
${mcpCtaCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("alternatives")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; <a href="/alternatives">Alternatives</a> &rsaquo; Free Databases</div>
  <h1>Best Free Database Hosting for Developers</h1>

  <div class="context">
    <p>Choosing a database is one of the most consequential infrastructure decisions for any project. The good news: in 2026, there are <strong>${dbOffers.length} free database options</strong> across every category — relational, document, key-value, edge, graph, vector, and time-series. The bad news: free tiers vary wildly, from <strong>MongoDB Atlas's cramped 512 MB</strong> to <strong>Turso's generous 5 GB</strong> and <strong>CockroachDB's 10 GiB</strong>.</p>
    <p>This page compares every free database in our index, organized by type, with exact limits verified against live pricing pages. Whether you need a Postgres database, a Redis cache, an edge SQLite store, or a vector database for RAG — we've got the comparison.</p>
  </div>

  ${changesHtml}

  <div class="context-box" style="border-left:3px solid var(--accent)">
    <p style="margin:0;font-size:.9rem">Looking for alternatives to a specific database? See our dedicated guides: <a href="/mongodb-alternatives">MongoDB Alternatives</a> | <a href="/redis-alternatives">Redis Alternatives</a> | <a href="/firebase-alternatives">Firebase Alternatives</a></p>
  </div>

  <h2>Relational SQL Databases</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Postgres-based and distributed SQL. The most popular choice for web applications — structured data, ACID transactions, and mature ecosystems.</p>
${buildCards(relational)}

  <h2>Document &amp; NoSQL Databases</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Flexible schema, JSON-native storage. Good for rapid prototyping, content management, and applications where schema evolves frequently.</p>
${buildCards(document)}

  <h2>Key-Value &amp; Cache</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">In-memory data stores for caching, session management, rate limiting, and pub/sub messaging.</p>
${buildCards(keyValue)}

  <h2>Edge &amp; Embedded Databases</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">SQLite-based stores that run close to users — low latency, offline-capable, and lightweight.</p>
${buildCards(edge)}

  <h2>Graph Databases</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">For interconnected data — social networks, knowledge graphs, recommendation engines, and fraud detection.</p>
${buildCards(graph)}

  <h2>Vector Databases</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Essential for AI/RAG pipelines, semantic search, and embeddings. The fastest-growing database category in 2026.</p>
${buildCards(vector)}

${timeSeries.length > 0 ? `
  <h2>Time-Series Databases</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Optimized for timestamped data — IoT, monitoring, metrics, and financial data.</p>
${buildCards(timeSeries)}
` : ""}

  <h2>Free Tier Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Top free databases compared by storage, type, and best use case.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Provider</th>
        <th>Type</th>
        <th>Free Storage</th>
        <th>Best For</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600"><a href="/vendor/supabase" style="color:var(--text)">Supabase</a></td>
        <td>Postgres</td>
        <td>500 MB</td>
        <td>Full-stack apps (auth + storage + realtime)</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/neon" style="color:var(--text)">Neon</a></td>
        <td>Postgres</td>
        <td>0.5 GB</td>
        <td>Serverless Postgres with branching</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/cockroachdb" style="color:var(--text)">CockroachDB</a></td>
        <td>Distributed SQL</td>
        <td>10 GiB</td>
        <td>Multi-region, high availability</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/turso" style="color:var(--text)">Turso</a></td>
        <td>Edge SQLite</td>
        <td>5 GB</td>
        <td>Edge-first apps, low latency</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/xata" style="color:var(--text)">Xata</a></td>
        <td>Postgres</td>
        <td>15 GB</td>
        <td>Serverless Postgres with branching</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/cloudflare-d1" style="color:var(--text)">Cloudflare D1</a></td>
        <td>Edge SQLite</td>
        <td>5 GB</td>
        <td>Cloudflare Workers integration</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/mongodb-atlas" style="color:var(--text)">MongoDB Atlas</a></td>
        <td>Document</td>
        <td>512 MB</td>
        <td>Document-oriented, flexible schema</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/firebase" style="color:var(--text)">Firebase</a></td>
        <td>Document (BaaS)</td>
        <td>1 GiB</td>
        <td>Mobile/web apps with real-time sync</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/upstash" style="color:var(--text)">Upstash</a></td>
        <td>Redis / Vector</td>
        <td>256 MB + 10K vectors</td>
        <td>Serverless caching and messaging</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/convex" style="color:var(--text)">Convex</a></td>
        <td>Reactive BaaS</td>
        <td>0.5 GB</td>
        <td>Real-time apps, reactive queries</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/aiven" style="color:var(--text)">Aiven</a></td>
        <td>Managed PG/MySQL/Valkey</td>
        <td>1 GB</td>
        <td>Managed open-source databases</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/neo4j-auradb" style="color:var(--text)">Neo4j AuraDB</a></td>
        <td>Graph</td>
        <td>200K nodes</td>
        <td>Knowledge graphs, relationships</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/pocketbase" style="color:var(--text)">PocketBase</a></td>
        <td>Embedded (SQLite)</td>
        <td>Unlimited (self-hosted)</td>
        <td>Single-binary backend, rapid prototyping</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/weaviate" style="color:var(--text)">Weaviate</a></td>
        <td>Vector</td>
        <td>Unlimited (self-hosted)</td>
        <td>AI/RAG, hybrid search</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/influxdb-cloud" style="color:var(--text)">InfluxDB Cloud</a></td>
        <td>Time-Series</td>
        <td>30-day retention</td>
        <td>IoT, monitoring, metrics</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">Storage limits are for the free tier only. CockroachDB (10 GiB) and Xata (15 GB) offer the most generous managed storage. PocketBase and Weaviate are unlimited when self-hosted. All limits verified against live pricing pages, March 2026.</p>

  <h2>Which Free Database Should I Use?</h2>
  <div class="decision-guide">
    <dl>
      <dt>Building a full-stack web app?</dt>
      <dd><a href="/vendor/supabase">Supabase</a> or <a href="/vendor/nhost">Nhost</a> — Postgres + auth + storage + real-time in one platform. Supabase has the larger ecosystem.</dd>

      <dt>Need pure serverless Postgres?</dt>
      <dd><a href="/vendor/neon">Neon</a> (branching, scale-to-zero) or <a href="/vendor/xata">Xata</a> (15 GB free, branching). For max free storage, <a href="/vendor/cockroachdb">CockroachDB</a> gives 10 GiB.</dd>

      <dt>Building at the edge?</dt>
      <dd><a href="/vendor/turso">Turso</a> (5 GB, 500M reads) or <a href="/vendor/cloudflare-d1">Cloudflare D1</a> (5 GB, tight Workers integration). Both use SQLite under the hood.</dd>

      <dt>Need a document/NoSQL database?</dt>
      <dd><a href="/vendor/firebase">Firebase Firestore</a> (1 GiB, real-time sync) or <a href="/vendor/mongodb-atlas">MongoDB Atlas</a> (512 MB, most tutorials). For self-hosted, <a href="/vendor/pocketbase">PocketBase</a> is unlimited.</dd>

      <dt>Need caching or rate limiting?</dt>
      <dd><a href="/vendor/upstash">Upstash Redis</a> (256 MB, serverless) or <a href="/vendor/momento">Momento</a> (5 GB transfer/month). For managed Redis, <a href="/vendor/aiven">Aiven</a> offers free Valkey.</dd>

      <dt>Building AI / RAG pipelines?</dt>
      <dd><a href="/vendor/upstash-vector">Upstash Vector</a> (10K vectors, serverless) or self-hosted <a href="/vendor/weaviate">Weaviate</a> / <a href="/vendor/lancedb">LanceDB</a> for no limits. <a href="/vendor/zilliz-cloud">Zilliz Cloud</a> for managed Milvus.</dd>

      <dt>Need a graph database?</dt>
      <dd><a href="/vendor/neo4j-auradb">Neo4j AuraDB</a> (200K nodes) is the standard. <a href="/vendor/gel">Gel</a> (formerly EdgeDB) offers a graph-relational hybrid.</dd>

      <dt>Time-series / IoT data?</dt>
      <dd><a href="/vendor/influxdb-cloud">InfluxDB Cloud</a> for monitoring and metrics. <a href="/vendor/cratedb">CrateDB</a> for distributed SQL with time-series optimization.</dd>
    </dl>
  </div>

  <div class="search-cta">
    <p>Looking for more? <a href="/category/databases">Browse all ${dbOffers.length} database tools</a> in our full index of ${offers.length.toLocaleString()}+ developer deals.</p>
  </div>

  ${buildMoreAlternativesGuides(slug)}

  ${buildMcpCta("Get database recommendations from your AI assistant. Compare free tiers, track pricing changes, and plan your stack — directly in your editor.")}
  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
<script>${mcpCtaScript()}</script>
</body>
</html>`;
}

// --- Monitoring Alternatives category hub page ---

function buildMonitoringAlternativesPage(): string {
  const title = "Best Free Monitoring Tools for Developers in 2026 — APM, Uptime, Logs & Error Tracking";
  const metaDesc = "Compare 70+ free monitoring tools — New Relic, Grafana Cloud, Datadog, Sentry, BetterStack, UptimeRobot, and more. Exact free tier limits by monitoring type. Updated March 2026.";
  const slug = "monitoring-alternatives";

  // Get all monitoring + error tracking offers
  const monitoringOffers = offers.filter(o => o.category === "Monitoring" || o.category === "Error Tracking");
  const enrichedAll = enrichOffers(monitoringOffers);
  const riskColors: Record<string, string> = { stable: "#3fb950", caution: "#d29922", risky: "#f85149" };

  // Group by monitoring type
  const apmObservability = enrichedAll.filter(o =>
    ["New Relic", "Grafana Cloud", "Datadog", "Sentry", "Middleware.io", "AppSignal", "Axiom", "Sematext", "Inspector.dev", "skylight.io"].includes(o.vendor)
  );
  const uptimeSynthetic = enrichedAll.filter(o =>
    ["BetterStack", "UptimeRobot", "StatusCake", "Hyperping", "OnlineOrNot", "Cronitor", "Healthchecks.io", "Uptimia", "Pulsetic", "SweetUptime", "UptimeObserver.com", "downtimemonkey.com", "fivenines.io", "pingbreak.com", "Pingmeter.com", "assertible.com", "bleemeo.com", "MonitorMonk", "Xitoring.com", "360 Monitoring", "sitesure.net", "Servervana", "uptimetoolbox.com", "deadmanssnitch.com"].includes(o.vendor)
  );
  const errorTracking = enrichedAll.filter(o =>
    ["Sentry", "Bugsnag", "Rollbar", "GlitchTip", "Exceptionless", "honeybadger.io", "elmah.io", "Bugsink", "CatchJS.com", "Jam", "Whitespace", "LogRocket"].includes(o.vendor)
    && !apmObservability.some(a => a.vendor === o.vendor)
  );
  const logManagement = enrichedAll.filter(o =>
    ["Axiom", "Sematext", "BetterStack"].includes(o.vendor)
    && !apmObservability.some(a => a.vendor === o.vendor) && !uptimeSynthetic.some(a => a.vendor === o.vendor)
  );
  const infrastructure = enrichedAll.filter(o =>
    ["Prometheus", "netdata.cloud", "Jaeger", "robusta.dev", "Google Cloud Monitoring", "Simple Observability", "syagent.com", "stathat.com"].includes(o.vendor)
  );
  const incidentManagement = enrichedAll.filter(o =>
    ["PagerDuty", "incident.io", "pagertree.com", "incidenthub.cloud", "phare.io", "StatusPile", "pingpong.one", "statusgator.com"].includes(o.vendor)
  );
  const rumAnalytics = enrichedAll.filter(o =>
    ["LogRocket", "Embrace", "Core Web Vitals History", "loader.io"].includes(o.vendor)
    && !errorTracking.some(e => e.vendor === o.vendor)
  );
  const startupPrograms = enrichedAll.filter(o =>
    ["Instabug for Startups", "Experian"].includes(o.vendor)
  );

  // Build cards helper
  const buildCards = (items: ReturnType<typeof enrichOffers>) => items.map(o => {
    const riskBadge = o.risk_level ? `<span style="display:inline-block;font-size:.7rem;padding:.15rem .5rem;border-radius:10px;background:${riskColors[o.risk_level]}22;color:${riskColors[o.risk_level]};font-weight:600;margin-left:.5rem">${o.risk_level}</span>` : "";
    return `<div class="alt-card">
        <div class="alt-card-header">
          <a href="/vendor/${toSlug(o.vendor)}" class="alt-card-name">${escHtmlServer(o.vendor)}</a>
          <span class="alt-card-tier">${escHtmlServer(o.tier)}</span>
          ${riskBadge}
        </div>
        <p class="alt-card-desc">${escHtmlServer(o.description)}</p>
        <div class="alt-card-links">
          <a href="/vendor/${toSlug(o.vendor)}">Full profile</a>
          <a href="/alternative-to/${toSlug(o.vendor)}">Alternatives</a>
          <a href="${escHtmlServer(o.url)}" target="_blank" rel="noopener">Pricing &nearr;</a>
        </div>
      </div>`;
  }).join("\n");

  // Monitoring deal changes
  const monitoringChangeVendors = ["Datadog", "New Relic", "Sentry", "Freshping", "Grafana", "BetterStack", "Rollbar", "Bugsnag", "PagerDuty"];
  const monitoringChanges = dealChanges.filter(c => monitoringChangeVendors.some(v => c.vendor.includes(v)));
  const changesHtml = monitoringChanges.length > 0 ? `
  <div class="context-box" style="border-left:3px solid ${riskColors.caution}">
    <div style="font-weight:600;color:${riskColors.caution};margin-bottom:.5rem">Recent Monitoring Pricing Changes</div>
    <ul style="margin:0;padding-left:1.25rem;font-size:.9rem;color:var(--text-muted);line-height:1.8">
      ${monitoringChanges.slice(0, 8).map(c => `<li><strong>${escHtmlServer(c.vendor)}</strong>: ${escHtmlServer(c.summary.length > 120 ? c.summary.substring(0, 117) + "..." : c.summary)}</li>`).join("\n      ")}
    </ul>
    <p style="margin:.75rem 0 0;font-size:.8rem"><a href="/changes">View all ${dealChanges.length} pricing changes &rarr;</a></p>
  </div>` : "";

  // JSON-LD
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: title,
    description: metaDesc,
    numberOfItems: monitoringOffers.length,
    itemListElement: enrichedAll.slice(0, 30).map((o, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "SoftwareApplication",
        name: o.vendor,
        description: o.description,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: o.tier },
        url: o.url,
      },
    })),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)} — AgentDeals</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/${slug}">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/${slug}">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
h2{font-family:var(--serif);font-size:1.4rem;color:var(--text);margin:2.5rem 0 1rem;letter-spacing:-.01em}
h3{font-family:var(--serif);font-size:1.1rem;color:var(--text);margin:1.5rem 0 .5rem}
.context{color:var(--text-muted);margin-bottom:1.5rem;font-size:.95rem;line-height:1.7}
.context strong{color:var(--text)}
.context-box{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1rem 1.25rem;margin:1.5rem 0;font-size:.9rem;color:var(--text-muted)}
.alt-card{padding:1.25rem;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;background:var(--bg-card);margin-bottom:.75rem;transition:border-color .2s}
.alt-card:hover{border-color:var(--accent)}
.alt-card-header{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem}
.alt-card-name{font-size:1.1rem;font-weight:600;color:var(--text)}
.alt-card-name:hover{color:var(--accent)}
.alt-card-tier{font-family:var(--mono);color:var(--accent);font-size:.8rem;padding:.1rem .5rem;background:var(--accent-glow);border-radius:10px}
.alt-card-desc{color:var(--text-muted);font-size:.9rem;line-height:1.5;margin:.5rem 0}
.alt-card-links{display:flex;flex-wrap:wrap;gap:.75rem;font-size:.8rem;margin-top:.5rem}
.alt-card-links a{color:var(--accent);text-decoration:none}
.alt-card-links a:hover{text-decoration:underline}
.compare-table{width:100%;border-collapse:collapse;margin:1rem 0 2rem}
.compare-table th,.compare-table td{padding:.5rem .75rem;text-align:left;border-bottom:1px solid var(--border);font-size:.85rem}
.compare-table th{color:var(--text-muted);font-weight:500;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
.compare-table tr:hover{background:var(--accent-glow)}
.search-cta{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.25rem;margin:2rem 0;text-align:center;font-size:.9rem}
.decision-guide{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.5rem;margin:2rem 0}
.decision-guide dt{font-weight:600;color:var(--text);margin-top:1rem}
.decision-guide dt:first-child{margin-top:0}
.decision-guide dd{color:var(--text-muted);font-size:.9rem;margin:.25rem 0 0 0;line-height:1.6}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.compare-table{font-size:.75rem}.compare-table th,.compare-table td{padding:.4rem .5rem}}
${globalNavCss()}
${mcpCtaCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("alternatives")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; <a href="/alternatives">Alternatives</a> &rsaquo; Free Monitoring</div>
  <h1>Best Free Monitoring Tools for Developers</h1>

  <div class="context">
    <p>Monitoring is essential infrastructure, but pricing can be brutal. <strong>Datadog</strong> is notorious for unpredictable bills — its free tier gives only <strong>5 hosts with 1-day retention</strong>. <strong>New Relic</strong> is more generous with <strong>100 GB/month</strong> free ingest, but complexity ramps fast. Meanwhile, <strong>Freshping shut down on March 6, 2026</strong>, displacing thousands of uptime monitors.</p>
    <p>This page compares every free monitoring option in our index — <strong>${monitoringOffers.length} tools</strong> across APM, uptime monitoring, log management, error tracking, infrastructure monitoring, and incident management. Whether you need full-stack observability or just a simple uptime check, we have the comparison with exact free tier limits.</p>
  </div>

  ${changesHtml}

  <div class="context-box" style="border-left:3px solid var(--accent)">
    <p style="margin:0;font-size:.9rem">Looking for alternatives to a specific tool? See our dedicated guides: <a href="/datadog-alternatives">Datadog Alternatives</a> | <a href="/freshping-alternatives">Freshping Alternatives</a></p>
  </div>

  <h2>APM &amp; Observability Platforms</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Full-stack application performance monitoring — traces, metrics, and logs in one platform. These are the "do everything" tools for teams that want unified observability.</p>
${buildCards(apmObservability)}

  <h2>Uptime &amp; Synthetic Monitoring</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Monitor websites, APIs, and cron jobs for availability. Simple, focused tools that alert you when something goes down. Most generous free tiers in the monitoring space.</p>
${buildCards(uptimeSynthetic)}

  <h2>Error Tracking</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Catch, group, and triage application errors with stack traces, breadcrumbs, and release tracking. Essential for production debugging.</p>
${buildCards(errorTracking)}

  <h2>Infrastructure &amp; Open Source</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Self-hosted and open-source monitoring tools. Maximum control, zero vendor lock-in — but you manage the infrastructure. Many are CNCF graduated projects.</p>
${buildCards(infrastructure)}

  <h2>Incident Management &amp; Status Pages</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">On-call alerting, incident response, and public status pages. Connect your monitoring to your team's response workflow.</p>
${buildCards(incidentManagement)}

${rumAnalytics.length > 0 ? `
  <h2>Real User Monitoring &amp; Performance</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Track real user experience — session replays, performance metrics, and Core Web Vitals from actual browser sessions.</p>
${buildCards(rumAnalytics)}
` : ""}

${startupPrograms.length > 0 ? `
  <h2>Startup Programs</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Discounted monitoring plans for eligible startups and early-stage companies.</p>
${buildCards(startupPrograms)}
` : ""}

  <h2>Free Monitoring Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Top free monitoring tools compared by data ingest, retention, and alerts.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Provider</th>
        <th>Type</th>
        <th>Free Tier Limits</th>
        <th>Retention</th>
        <th>Best For</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600"><a href="/vendor/new-relic" style="color:var(--text)">New Relic</a></td>
        <td>APM</td>
        <td>100 GB/mo ingest, 1 full user</td>
        <td>8+ days</td>
        <td>Full-stack observability, generous free tier</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/grafana-cloud" style="color:var(--text)">Grafana Cloud</a></td>
        <td>APM / Logs</td>
        <td>10K metrics, 50 GB logs, 50 GB traces</td>
        <td>14 days</td>
        <td>Open-source stack (Prometheus + Loki + Tempo)</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/datadog" style="color:var(--text)">Datadog</a></td>
        <td>APM</td>
        <td>5 hosts, core metrics only</td>
        <td>1 day</td>
        <td>Teams already on Datadog, broad integrations</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/sentry" style="color:var(--text)">Sentry</a></td>
        <td>Errors / APM</td>
        <td>5K errors/mo, 5M spans/mo, 50 replays</td>
        <td>30 days</td>
        <td>Error tracking with performance tracing</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/betterstack" style="color:var(--text)">BetterStack</a></td>
        <td>Uptime / Logs</td>
        <td>10 monitors, 3 GB logs, 100K exceptions</td>
        <td>3 days (logs)</td>
        <td>All-in-one uptime + logs + errors</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/uptimerobot" style="color:var(--text)">UptimeRobot</a></td>
        <td>Uptime</td>
        <td>50 monitors, 5-min intervals</td>
        <td>3 months</td>
        <td>Simple uptime monitoring, most monitors free</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/axiom" style="color:var(--text)">Axiom</a></td>
        <td>Logs / Traces</td>
        <td>500 GB ingest/mo, 25 GB storage</td>
        <td>30 days</td>
        <td>High-volume log analysis, generous storage</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/middleware-io" style="color:var(--text)">Middleware.io</a></td>
        <td>APM</td>
        <td>100 GB/mo data, unlimited users</td>
        <td>Varies</td>
        <td>Full observability (APM + logs + RUM + synthetics)</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/healthchecks-io" style="color:var(--text)">Healthchecks.io</a></td>
        <td>Cron</td>
        <td>20 monitors, email/Slack/Telegram alerts</td>
        <td>100 log entries</td>
        <td>Cron job monitoring, dead man's switch</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/prometheus" style="color:var(--text)">Prometheus</a></td>
        <td>Infrastructure</td>
        <td>Unlimited (self-hosted, OSS)</td>
        <td>Configurable</td>
        <td>Kubernetes, CNCF ecosystem, pull-based metrics</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/pagerduty" style="color:var(--text)">PagerDuty</a></td>
        <td>Incidents</td>
        <td>5 users, 100 phone/SMS/mo</td>
        <td>N/A</td>
        <td>On-call scheduling and incident response</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/bugsnag" style="color:var(--text)">Bugsnag</a></td>
        <td>Errors</td>
        <td>7,500 events/mo, 1M spans</td>
        <td>7 days</td>
        <td>Mobile + web error tracking</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">New Relic's 100 GB/month is the most generous APM free tier. Axiom leads on log storage (500 GB ingest). UptimeRobot offers the most free monitors (50). Prometheus and Grafana (self-hosted) have no limits. Datadog's free tier is the most restrictive among major APM vendors. All limits verified against live pricing pages, March 2026.</p>

  <div class="context-box" style="border-left:3px solid ${riskColors.risky}">
    <div style="font-weight:600;color:${riskColors.risky};margin-bottom:.5rem">Freshping Shutdown — March 6, 2026</div>
    <p style="margin:0;font-size:.9rem">Freshping (Freshworks) shut down on <strong>March 6, 2026</strong>, displacing thousands of free uptime monitors. If you're migrating, see our <a href="/freshping-alternatives">Freshping Alternatives</a> guide for free replacement options.</p>
  </div>

  <h2>Which Free Monitoring Tool Should I Use?</h2>
  <div class="decision-guide">
    <dl>
      <dt>Need full-stack APM (traces + metrics + logs)?</dt>
      <dd><a href="/vendor/new-relic">New Relic</a> (100 GB/mo, most generous) or <a href="/vendor/grafana-cloud">Grafana Cloud</a> (open-source stack, 14-day retention). <a href="/vendor/middleware-io">Middleware.io</a> is a newer option with 100 GB/mo and unlimited users.</dd>

      <dt>Just need uptime monitoring?</dt>
      <dd><a href="/vendor/uptimerobot">UptimeRobot</a> (50 monitors, 5-min intervals) is the established choice. <a href="/vendor/betterstack">BetterStack</a> adds logs and errors. <a href="/vendor/statuscake">StatusCake</a> includes SSL and domain monitoring.</dd>

      <dt>Tracking application errors?</dt>
      <dd><a href="/vendor/sentry">Sentry</a> (5K errors/mo + performance tracing) is the developer favorite. <a href="/vendor/bugsnag">Bugsnag</a> excels at mobile. <a href="/vendor/glitchtip">GlitchTip</a> is Sentry-compatible and open source.</dd>

      <dt>Need log management?</dt>
      <dd><a href="/vendor/axiom">Axiom</a> (500 GB/mo ingest, 30-day retention) is the most generous. <a href="/vendor/grafana-cloud">Grafana Cloud</a> with Loki gives 50 GB logs. <a href="/vendor/betterstack">BetterStack</a> offers 3 GB with 3-day retention.</dd>

      <dt>Monitoring Kubernetes?</dt>
      <dd><a href="/vendor/prometheus">Prometheus</a> + <a href="/vendor/grafana-cloud">Grafana</a> is the standard CNCF stack. <a href="/vendor/robusta-dev">Robusta</a> adds Kubernetes-specific troubleshooting (20 nodes free). <a href="/vendor/netdata-cloud">Netdata</a> provides real-time metrics with zero config.</dd>

      <dt>Need on-call and incident management?</dt>
      <dd><a href="/vendor/pagerduty">PagerDuty</a> (5 users, 100 notifications/mo) is the industry standard. <a href="/vendor/incident-io">incident.io</a> offers native Slack/Teams integration. <a href="/vendor/pagertree-com">PagerTree</a> is a simpler alternative (5 users free).</dd>

      <dt>Want open-source and self-hosted?</dt>
      <dd><a href="/vendor/prometheus">Prometheus</a> (metrics), <a href="/vendor/jaeger">Jaeger</a> (tracing), <a href="/vendor/sentry">Sentry</a> (errors, self-hosted option), and <a href="/vendor/netdata-cloud">Netdata</a> (real-time dashboards) form a comprehensive OSS monitoring stack. All CNCF projects or Apache-licensed.</dd>

      <dt>Coming from Datadog on a budget?</dt>
      <dd>See our dedicated <a href="/datadog-alternatives">Datadog Alternatives</a> guide. TL;DR: <a href="/vendor/new-relic">New Relic</a> has 20x the free data ingest, <a href="/vendor/grafana-cloud">Grafana Cloud</a> eliminates vendor lock-in, and <a href="/vendor/axiom">Axiom</a> offers the best free log storage.</dd>
    </dl>
  </div>

  <div class="search-cta">
    <p>Looking for more? <a href="/category/monitoring">Browse all Monitoring tools</a> or <a href="/category/error-tracking">Error Tracking tools</a> in our full index of ${offers.length.toLocaleString()}+ developer deals.</p>
  </div>

  ${buildMoreAlternativesGuides(slug)}

  ${buildMcpCta("Get monitoring recommendations from your AI assistant. Compare free tiers, track pricing changes, and audit your observability stack — directly in your editor.")}
  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
<script>${mcpCtaScript()}</script>
</body>
</html>`;
}

function buildCiCdAlternativesPage(): string {
  const title = "Best Free CI/CD Tools for Developers in 2026 — Build Minutes, Runners & Pipelines Compared";
  const metaDesc = "Compare 35+ free CI/CD tools — GitHub Actions, GitLab CI, CircleCI, Buildkite, Harness CI, Drone CI, and more. Exact free tier limits by CI/CD type. Updated March 2026.";
  const slug = "ci-cd-alternatives";

  // Get all CI/CD offers
  const cicdOffers = offers.filter(o => o.category === "CI/CD");
  const enrichedAll = enrichOffers(cicdOffers);
  const riskColors: Record<string, string> = { stable: "#3fb950", caution: "#d29922", risky: "#f85149" };

  // Group by CI/CD type
  const generalPurpose = enrichedAll.filter(o =>
    ["GitHub Actions", "GitLab CI", "CircleCI", "Buildkite", "Bitbucket Pipelines", "Semaphore CI", "Buddy", "Harness CI", "appveyor.com", "cirrus-ci.org"].includes(o.vendor)
  );
  const cloudContainer = enrichedAll.filter(o =>
    ["Codefresh", "Drone CI", "Woodpecker CI", "Google Cloud Build", "Shipfox"].includes(o.vendor)
  );
  const mobileCicd = enrichedAll.filter(o =>
    ["Bitrise", "Codemagic", "Appcircle"].includes(o.vendor)
  );
  const iacAutomation = enrichedAll.filter(o =>
    ["Terramate", "Terrateam", "Mergify", "Nx Cloud", "LocalOps"].includes(o.vendor)
  );
  const specialized = enrichedAll.filter(o =>
    ["Unity DevOps", "bytebase.com", "cirun.io", "deployhq.com", "RunMyJob", "Squash Labs", "Tugboat"].includes(o.vendor)
  );

  // Build cards helper
  const buildCards = (items: ReturnType<typeof enrichOffers>) => items.map(o => {
    const riskBadge = o.risk_level ? `<span style="display:inline-block;font-size:.7rem;padding:.15rem .5rem;border-radius:10px;background:${riskColors[o.risk_level]}22;color:${riskColors[o.risk_level]};font-weight:600;margin-left:.5rem">${o.risk_level}</span>` : "";
    return `<div class="alt-card">
        <div class="alt-card-header">
          <a href="/vendor/${toSlug(o.vendor)}" class="alt-card-name">${escHtmlServer(o.vendor)}</a>
          <span class="alt-card-tier">${escHtmlServer(o.tier)}</span>
          ${riskBadge}
        </div>
        <p class="alt-card-desc">${escHtmlServer(o.description)}</p>
        <div class="alt-card-links">
          <a href="/vendor/${toSlug(o.vendor)}">Full profile</a>
          <a href="/alternative-to/${toSlug(o.vendor)}">Alternatives</a>
          <a href="${escHtmlServer(o.url)}" target="_blank" rel="noopener">Pricing &nearr;</a>
        </div>
      </div>`;
  }).join("\n");

  // CI/CD deal changes
  const cicdChangeVendors = ["GitHub Actions", "GitLab", "CircleCI", "Buildkite", "Harness", "Bitrise", "Codefresh"];
  const cicdChanges = dealChanges.filter(c => cicdChangeVendors.some(v => c.vendor.includes(v)));
  const changesHtml = cicdChanges.length > 0 ? `
  <div class="context-box" style="border-left:3px solid ${riskColors.caution}">
    <div style="font-weight:600;color:${riskColors.caution};margin-bottom:.5rem">Recent CI/CD Pricing Changes</div>
    <ul style="margin:0;padding-left:1.25rem;font-size:.9rem;color:var(--text-muted);line-height:1.8">
      ${cicdChanges.slice(0, 8).map(c => `<li><strong>${escHtmlServer(c.vendor)}</strong>: ${escHtmlServer(c.summary.length > 120 ? c.summary.substring(0, 117) + "..." : c.summary)}</li>`).join("\n      ")}
    </ul>
    <p style="margin:.75rem 0 0;font-size:.8rem"><a href="/changes">View all ${dealChanges.length} pricing changes &rarr;</a></p>
  </div>` : "";

  // JSON-LD
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: title,
    description: metaDesc,
    numberOfItems: cicdOffers.length,
    itemListElement: enrichedAll.slice(0, 30).map((o, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "SoftwareApplication",
        name: o.vendor,
        description: o.description,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: o.tier },
        url: o.url,
      },
    })),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)} — AgentDeals</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/${slug}">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/${slug}">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
h2{font-family:var(--serif);font-size:1.4rem;color:var(--text);margin:2.5rem 0 1rem;letter-spacing:-.01em}
h3{font-family:var(--serif);font-size:1.1rem;color:var(--text);margin:1.5rem 0 .5rem}
.context{color:var(--text-muted);margin-bottom:1.5rem;font-size:.95rem;line-height:1.7}
.context strong{color:var(--text)}
.context-box{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1rem 1.25rem;margin:1.5rem 0;font-size:.9rem;color:var(--text-muted)}
.alt-card{padding:1.25rem;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;background:var(--bg-card);margin-bottom:.75rem;transition:border-color .2s}
.alt-card:hover{border-color:var(--accent)}
.alt-card-header{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem}
.alt-card-name{font-size:1.1rem;font-weight:600;color:var(--text)}
.alt-card-name:hover{color:var(--accent)}
.alt-card-tier{font-family:var(--mono);color:var(--accent);font-size:.8rem;padding:.1rem .5rem;background:var(--accent-glow);border-radius:10px}
.alt-card-desc{color:var(--text-muted);font-size:.9rem;line-height:1.5;margin:.5rem 0}
.alt-card-links{display:flex;flex-wrap:wrap;gap:.75rem;font-size:.8rem;margin-top:.5rem}
.alt-card-links a{color:var(--accent);text-decoration:none}
.alt-card-links a:hover{text-decoration:underline}
.compare-table{width:100%;border-collapse:collapse;margin:1rem 0 2rem}
.compare-table th,.compare-table td{padding:.5rem .75rem;text-align:left;border-bottom:1px solid var(--border);font-size:.85rem}
.compare-table th{color:var(--text-muted);font-weight:500;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
.compare-table tr:hover{background:var(--accent-glow)}
.search-cta{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.25rem;margin:2rem 0;text-align:center;font-size:.9rem}
.decision-guide{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.5rem;margin:2rem 0}
.decision-guide dt{font-weight:600;color:var(--text);margin-top:1rem}
.decision-guide dt:first-child{margin-top:0}
.decision-guide dd{color:var(--text-muted);font-size:.9rem;margin:.25rem 0 0 0;line-height:1.6}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.compare-table{font-size:.75rem}.compare-table th,.compare-table td{padding:.4rem .5rem}}
${globalNavCss()}
${mcpCtaCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("alternatives")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; <a href="/alternatives">Alternatives</a> &rsaquo; Free CI/CD</div>
  <h1>Best Free CI/CD Tools for Developers</h1>

  <div class="context">
    <p>Every software team needs CI/CD, but build minutes add up fast. <strong>GitHub Actions</strong> is the default choice with <strong>2,000 free minutes/month</strong> for private repos and unlimited for public, but it introduced <strong>self-hosted runner charges ($0.002/min) in March 2026</strong>. <strong>GitLab CI</strong> cut its free tier to <strong>400 minutes/month</strong>. <strong>CircleCI</strong> offers <strong>30K credits/month</strong> (~6K minutes) but requires a credit card for some features.</p>
    <p>This page compares every free CI/CD option in our index \u2014 <strong>${cicdOffers.length} tools</strong> across general-purpose platforms, container-native pipelines, mobile CI/CD, and infrastructure automation. Whether you need cloud-hosted runners or self-hosted pipelines, we have the comparison with exact free tier limits.</p>
  </div>

  ${changesHtml}

  <div class="context-box" style="border-left:3px solid var(--accent)">
    <p style="margin:0;font-size:.9rem">Looking for alternatives to a specific CI/CD tool? See our dedicated guide: <a href="/github-actions-alternatives">GitHub Actions Alternatives</a></p>
  </div>

  <h2>General-Purpose CI/CD Platforms</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Full-featured CI/CD platforms with cloud-hosted runners, pipeline configuration, and integrations. These cover most use cases \u2014 from simple test-and-deploy to complex multi-stage pipelines.</p>
${buildCards(generalPurpose)}

  <h2>Cloud &amp; Container-Native CI/CD</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Docker-first and Kubernetes-native CI/CD tools. Built for containerized workflows, GitOps, and cloud-native deployments. Many are open source with self-hosted options.</p>
${buildCards(cloudContainer)}

  <h2>Mobile CI/CD</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Specialized CI/CD for iOS, Android, Flutter, and React Native apps. Handle code signing, device testing, and app store distribution that general-purpose tools struggle with.</p>
${buildCards(mobileCicd)}

  <h2>Infrastructure &amp; Automation</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">CI/CD tools specialized for Infrastructure as Code (Terraform, OpenTofu), monorepo orchestration, merge automation, and deployment workflows.</p>
${buildCards(iacAutomation)}

${specialized.length > 0 ? `
  <h2>Specialized CI/CD</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Domain-specific CI/CD tools \u2014 game development, database migrations, preview environments, Windows builds, and more.</p>
${buildCards(specialized)}
` : ""}

  <h2>Free CI/CD Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Top free CI/CD platforms compared by build minutes, concurrency, and platform support.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Provider</th>
        <th>Type</th>
        <th>Free Build Minutes</th>
        <th>Concurrency</th>
        <th>Best For</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600"><a href="/vendor/github-actions" style="color:var(--text)">GitHub Actions</a></td>
        <td>General</td>
        <td>2,000/mo (private), \u221e (public)</td>
        <td>20 jobs</td>
        <td>GitHub repos, largest ecosystem of actions</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/gitlab-ci" style="color:var(--text)">GitLab CI</a></td>
        <td>General</td>
        <td>400/mo</td>
        <td>Varies</td>
        <td>All-in-one DevOps (SCM + CI + registry + deploy)</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/circleci" style="color:var(--text)">CircleCI</a></td>
        <td>General</td>
        <td>30K credits/mo (~6K min)</td>
        <td>30 jobs</td>
        <td>Fast builds, Docker layer caching, orbs</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/buildkite" style="color:var(--text)">Buildkite</a></td>
        <td>General</td>
        <td>500 hosted min/mo</td>
        <td>3 jobs</td>
        <td>Hybrid (cloud + self-hosted), large-scale builds</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/harness-ci" style="color:var(--text)">Harness CI</a></td>
        <td>General</td>
        <td>2,000 credits/mo</td>
        <td>Varies</td>
        <td>AI-powered, multi-cloud, feature flags included</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/google-cloud-build" style="color:var(--text)">Google Cloud Build</a></td>
        <td>Cloud</td>
        <td>2,500/mo</td>
        <td>Varies</td>
        <td>GCP ecosystem, serverless builds</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/codefresh" style="color:var(--text)">Codefresh</a></td>
        <td>Container</td>
        <td>120 builds/mo</td>
        <td>1 pipeline</td>
        <td>Docker/K8s native, GitOps with Argo CD</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/drone-ci" style="color:var(--text)">Drone CI</a></td>
        <td>Container</td>
        <td>\u221e (self-hosted)</td>
        <td>\u221e</td>
        <td>Self-hosted, Docker-native, lightweight</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/woodpecker-ci" style="color:var(--text)">Woodpecker CI</a></td>
        <td>Container</td>
        <td>\u221e (self-hosted)</td>
        <td>\u221e</td>
        <td>Drone fork, Apache 2.0, community-driven</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/codemagic" style="color:var(--text)">Codemagic</a></td>
        <td>Mobile</td>
        <td>500 macOS M2 min/mo</td>
        <td>Varies</td>
        <td>Flutter/mobile, macOS M2 runners, code signing</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/bitrise" style="color:var(--text)">Bitrise</a></td>
        <td>Mobile</td>
        <td>300 credits/mo</td>
        <td>1 build</td>
        <td>Mobile CI/CD, iOS + Android + Flutter</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/buddy" style="color:var(--text)">Buddy</a></td>
        <td>General</td>
        <td>300 GB-min/mo</td>
        <td>1 pipeline</td>
        <td>Visual pipeline editor, fast deployments</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">GitHub Actions dominates with unlimited public repo minutes and the largest marketplace of reusable actions. CircleCI offers the most free credits among hosted platforms. Google Cloud Build has the most generous hosted minutes (2,500/mo). Drone CI and Woodpecker CI are unlimited when self-hosted. All limits verified against live pricing pages, March 2026.</p>

  <h2>Which Free CI/CD Tool Should I Use?</h2>
  <div class="decision-guide">
    <dl>
      <dt>Building on GitHub with public repos?</dt>
      <dd><a href="/vendor/github-actions">GitHub Actions</a> \u2014 unlimited free minutes for public repos, 4,000+ marketplace actions, native GitHub integration. The obvious default choice.</dd>

      <dt>Need more minutes for private repos?</dt>
      <dd><a href="/vendor/circleci">CircleCI</a> (30K credits/mo, ~6K minutes) or <a href="/vendor/google-cloud-build">Google Cloud Build</a> (2,500 min/mo) both exceed GitHub Actions' 2,000 min/mo private repo limit.</dd>

      <dt>Want an all-in-one DevOps platform?</dt>
      <dd><a href="/vendor/gitlab-ci">GitLab CI</a> \u2014 SCM, CI/CD, container registry, deployments, and security scanning in one platform. Only 400 min/mo free, but everything is integrated.</dd>

      <dt>Running container/Kubernetes workloads?</dt>
      <dd><a href="/vendor/codefresh">Codefresh</a> for managed GitOps with Argo CD. <a href="/vendor/drone-ci">Drone CI</a> or <a href="/vendor/woodpecker-ci">Woodpecker CI</a> for self-hosted, Docker-native pipelines with unlimited builds.</dd>

      <dt>Building mobile apps (iOS/Android/Flutter)?</dt>
      <dd><a href="/vendor/codemagic">Codemagic</a> (500 macOS M2 min/mo) is the Flutter favorite. <a href="/vendor/bitrise">Bitrise</a> covers iOS + Android with built-in code signing. <a href="/vendor/appcircle">Appcircle</a> adds OTA distribution.</dd>

      <dt>Need unlimited builds, self-hosted?</dt>
      <dd><a href="/vendor/drone-ci">Drone CI</a> (Apache 2.0) or <a href="/vendor/woodpecker-ci">Woodpecker CI</a> (community fork) \u2014 both are container-native, lightweight, and free with no build limits. <a href="/vendor/semaphore-ci">Semaphore CI</a> also has a free self-hosted edition.</dd>

      <dt>Managing Infrastructure as Code?</dt>
      <dd><a href="/vendor/terramate">Terramate</a> and <a href="/vendor/terrateam">Terrateam</a> specialize in Terraform/OpenTofu CI/CD with PR-driven workflows. <a href="/vendor/nx-cloud">Nx Cloud</a> accelerates monorepo builds with remote caching.</dd>

      <dt>Windows-only builds?</dt>
      <dd><a href="/vendor/appveyor-com">AppVeyor</a> specializes in Windows CI/CD, free for open-source projects. GitHub Actions also supports Windows runners.</dd>
    </dl>
  </div>

  <div class="search-cta">
    <p>Looking for more? <a href="/category/ci-cd">Browse all CI/CD tools</a> in our full index of ${offers.length.toLocaleString()}+ developer deals.</p>
  </div>

  ${buildMoreAlternativesGuides(slug)}

  ${buildMcpCta("Get CI/CD recommendations from your AI assistant. Compare build minutes, track pricing changes, and find the right pipeline tool for your stack \u2014 directly in your editor.")}
  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
<script>${mcpCtaScript()}</script>
</body>
</html>`;
}

// --- Security alternatives hub page ---

function buildSecurityAlternativesPage(): string {
  const title = "Best Free Security Tools for Developers in 2026 — SAST, Secrets, Auth & Container Security";
  const metaDesc = "Compare 100+ free security tools — Snyk, Semgrep, CodeQL, GitGuardian, Trivy, Auth0, Clerk, and more. Exact free tier limits by security domain. Updated March 2026.";
  const slug = "security-alternatives";

  // Get all security-related offers across categories
  const securityOffers = offers.filter(o => o.category === "Security" || o.category === "Secrets Management" || o.category === "Auth" || o.category === "Error Tracking");
  const enrichedAll = enrichOffers(securityOffers);
  const riskColors: Record<string, string> = { stable: "#3fb950", caution: "#d29922", risky: "#f85149" };

  // Group by security domain
  const appSecurity = enrichedAll.filter(o =>
    ["Snyk", "SonarCloud", "Semgrep", "CodeQL", "FOSSA", "aikido.dev", "Bearer", "Corgea", "Datree", "hostedscan.com", "meterian.io", "SOOS", "Probely", "StackHawk", "OWASP ZAP", "Nuclei", "qualys.com", "Checkov"].includes(o.vendor)
  );
  const secretScanning = enrichedAll.filter(o =>
    ["GitGuardian", "HashiCorp Vault", "Doppler", "Infisical", "Gitleaks", "TruffleHog", "Dotenv", "Google Secret Manager", "crypteron.com", "Smart Grow Vault"].includes(o.vendor)
  );
  const dependencySupplyChain = enrichedAll.filter(o =>
    ["Socket.dev", "Dependabot", "Renovate", "Grype", "pyup.io", "Snyk"].includes(o.vendor) && !appSecurity.includes(o)
  );
  const containerCloud = enrichedAll.filter(o =>
    ["Trivy", "Falco", "Twingate", "Tailscale", "Project Gatekeeper", "Public Cloud Threat Intelligence"].includes(o.vendor)
  );
  const identityAuth = enrichedAll.filter(o =>
    o.category === "Auth"
  );
  const errorTracking = enrichedAll.filter(o =>
    o.category === "Error Tracking"
  );
  const sslCerts = enrichedAll.filter(o =>
    ["letsencrypt.org", "ssllabs.com", "TestTLS.com", "Internet.nl", "Mozilla Observatory", "CertKit", "DJ Checkup", "Sucuri SiteCheck"].includes(o.vendor)
  );
  const other = enrichedAll.filter(o =>
    ["1Password", "Proton Pass", "FraudLabs Pro", "LoginLlama", "Have I been pwned?", "CyberChef", "Protectumus", "URLscan.io", "VirusTotal", "RandomKeygen", "Virgil Security", "Cookiefirst", "Iubenda", "Ketch", "Pareto Security"].includes(o.vendor)
  );

  // Build cards helper
  const buildCards = (items: ReturnType<typeof enrichOffers>) => items.map(o => {
    const riskBadge = o.risk_level ? `<span style="display:inline-block;font-size:.7rem;padding:.15rem .5rem;border-radius:10px;background:${riskColors[o.risk_level]}22;color:${riskColors[o.risk_level]};font-weight:600;margin-left:.5rem">${o.risk_level}</span>` : "";
    return `<div class="alt-card">
        <div class="alt-card-header">
          <a href="/vendor/${toSlug(o.vendor)}" class="alt-card-name">${escHtmlServer(o.vendor)}</a>
          <span class="alt-card-tier">${escHtmlServer(o.tier)}</span>
          ${riskBadge}
        </div>
        <p class="alt-card-desc">${escHtmlServer(o.description)}</p>
        <div class="alt-card-links">
          <a href="/vendor/${toSlug(o.vendor)}">Full profile</a>
          <a href="/alternative-to/${toSlug(o.vendor)}">Alternatives</a>
          <a href="${escHtmlServer(o.url)}" target="_blank" rel="noopener">Pricing &nearr;</a>
        </div>
      </div>`;
  }).join("\n");

  // Security deal changes
  const secChangeVendors = ["Snyk", "Auth0", "GitGuardian", "SonarCloud", "Trivy", "Tailscale", "HashiCorp", "Clerk", "Sentry"];
  const secChanges = dealChanges.filter(c => secChangeVendors.some(v => c.vendor.includes(v)));
  const changesHtml = secChanges.length > 0 ? `
  <div class="context-box" style="border-left:3px solid ${riskColors.caution}">
    <div style="font-weight:600;color:${riskColors.caution};margin-bottom:.5rem">Recent Security Tool Pricing Changes</div>
    <ul style="margin:0;padding-left:1.25rem;font-size:.9rem;color:var(--text-muted);line-height:1.8">
      ${secChanges.slice(0, 8).map(c => `<li><strong>${escHtmlServer(c.vendor)}</strong>: ${escHtmlServer(c.summary.length > 120 ? c.summary.substring(0, 117) + "..." : c.summary)}</li>`).join("\n      ")}
    </ul>
    <p style="margin:.75rem 0 0;font-size:.8rem"><a href="/changes">View all ${dealChanges.length} pricing changes &rarr;</a></p>
  </div>` : "";

  // JSON-LD
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: title,
    description: metaDesc,
    numberOfItems: securityOffers.length,
    itemListElement: enrichedAll.slice(0, 30).map((o, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "SoftwareApplication",
        name: o.vendor,
        description: o.description,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: o.tier },
        url: o.url,
      },
    })),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)} — AgentDeals</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/${slug}">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/${slug}">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
h2{font-family:var(--serif);font-size:1.4rem;color:var(--text);margin:2.5rem 0 1rem;letter-spacing:-.01em}
h3{font-family:var(--serif);font-size:1.1rem;color:var(--text);margin:1.5rem 0 .5rem}
.context{color:var(--text-muted);margin-bottom:1.5rem;font-size:.95rem;line-height:1.7}
.context strong{color:var(--text)}
.context-box{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1rem 1.25rem;margin:1.5rem 0;font-size:.9rem;color:var(--text-muted)}
.alt-card{padding:1.25rem;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;background:var(--bg-card);margin-bottom:.75rem;transition:border-color .2s}
.alt-card:hover{border-color:var(--accent)}
.alt-card-header{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem}
.alt-card-name{font-size:1.1rem;font-weight:600;color:var(--text)}
.alt-card-name:hover{color:var(--accent)}
.alt-card-tier{font-family:var(--mono);color:var(--accent);font-size:.8rem;padding:.1rem .5rem;background:var(--accent-glow);border-radius:10px}
.alt-card-desc{color:var(--text-muted);font-size:.9rem;line-height:1.5;margin:.5rem 0}
.alt-card-links{display:flex;flex-wrap:wrap;gap:.75rem;font-size:.8rem;margin-top:.5rem}
.alt-card-links a{color:var(--accent);text-decoration:none}
.alt-card-links a:hover{text-decoration:underline}
.compare-table{width:100%;border-collapse:collapse;margin:1rem 0 2rem}
.compare-table th,.compare-table td{padding:.5rem .75rem;text-align:left;border-bottom:1px solid var(--border);font-size:.85rem}
.compare-table th{color:var(--text-muted);font-weight:500;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
.compare-table tr:hover{background:var(--accent-glow)}
.search-cta{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.25rem;margin:2rem 0;text-align:center;font-size:.9rem}
.decision-guide{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.5rem;margin:2rem 0}
.decision-guide dt{font-weight:600;color:var(--text);margin-top:1rem}
.decision-guide dt:first-child{margin-top:0}
.decision-guide dd{color:var(--text-muted);font-size:.9rem;margin:.25rem 0 0 0;line-height:1.6}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.compare-table{font-size:.75rem}.compare-table th,.compare-table td{padding:.4rem .5rem}}
${globalNavCss()}
${mcpCtaCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("alternatives")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; <a href="/alternatives">Alternatives</a> &rsaquo; Free Security Tools</div>
  <h1>Best Free Security Tools for Developers</h1>

  <div class="context">
    <p>Security is no longer optional \u2014 even side projects get supply chain attacks, credential leaks, and dependency vulnerabilities. The good news: the security tool ecosystem has an unusually strong free tier landscape. <strong>Snyk</strong> offers free SAST scanning for up to <strong>200 tests/month</strong>. <strong>Semgrep</strong> and <strong>CodeQL</strong> are free for open-source. <strong>Trivy</strong> and <strong>Grype</strong> are fully open-source container scanners.</p>
    <p>This page compares every free security tool in our index \u2014 <strong>${securityOffers.length} tools</strong> across application security (SAST/DAST), secret scanning, dependency analysis, container security, identity/auth, error tracking, and SSL/compliance. Whether you need code scanning or user authentication, we have the comparison with exact free tier limits.</p>
  </div>

  ${changesHtml}

  <div class="context-box" style="border-left:3px solid var(--accent)">
    <p style="margin:0;font-size:.9rem">Looking for alternatives to a specific security tool? See our dedicated guide: <a href="/auth0-alternatives">Auth0 Alternatives</a></p>
  </div>

  <h2>Application Security (SAST/DAST)</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Static and dynamic analysis tools that find vulnerabilities in your code before they reach production. Ranges from cloud-hosted scanners like Snyk and SonarCloud to open-source engines like Semgrep and CodeQL.</p>
${buildCards(appSecurity)}

  <h2>Secret Scanning &amp; Management</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Prevent credential leaks and manage secrets securely. GitGuardian catches secrets in commits, while Vault, Doppler, and Infisical provide runtime secret management with rotation and access controls.</p>
${buildCards(secretScanning)}

  <h2>Dependency &amp; Supply Chain Security</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Automated dependency scanning, vulnerability alerts, and update management. These tools catch known CVEs in your dependency tree and can auto-create PRs to fix them.</p>
${buildCards(dependencySupplyChain)}

  <h2>Container &amp; Infrastructure Security</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Scan container images for vulnerabilities, enforce Kubernetes policies, and secure network access. Most are open-source with no usage limits when self-hosted.</p>
${buildCards(containerCloud)}

  <h2>Identity &amp; Authentication</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">User authentication, authorization, and identity management \u2014 from managed services like Auth0 and Clerk to self-hosted options like Keycloak and SuperTokens. Free tiers typically measured by monthly active users.</p>
${buildCards(identityAuth)}

  <h2>Error Tracking &amp; Runtime Security</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Catch runtime errors, crashes, and exceptions in production. These tools help you detect and fix security-relevant bugs before users report them.</p>
${buildCards(errorTracking)}

${sslCerts.length > 0 ? `
  <h2>SSL, TLS &amp; Web Security</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Free SSL certificates, TLS configuration testing, and web security scanners. Essential baseline security that every site needs.</p>
${buildCards(sslCerts)}
` : ""}

${other.length > 0 ? `
  <h2>Other Security Tools</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Password managers, fraud detection, threat intelligence, privacy compliance, and other security utilities with free tiers for developers.</p>
${buildCards(other)}
` : ""}

  <h2>Free Security Tools Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Top free security tools compared by domain, free tier limits, and best use case.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Tool</th>
        <th>Domain</th>
        <th>Free Tier</th>
        <th>Open Source</th>
        <th>Best For</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600"><a href="/vendor/snyk" style="color:var(--text)">Snyk</a></td>
        <td>SAST + SCA</td>
        <td>200 tests/mo, 5 projects</td>
        <td>\u2014</td>
        <td>All-in-one: code, deps, containers, IaC</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/semgrep" style="color:var(--text)">Semgrep</a></td>
        <td>SAST</td>
        <td>\u221e scans (OSS rules)</td>
        <td>\u2705</td>
        <td>Custom rules, lightweight, fast scans</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/codeql" style="color:var(--text)">CodeQL</a></td>
        <td>SAST</td>
        <td>\u221e (public repos)</td>
        <td>\u2705</td>
        <td>Deep semantic analysis, GitHub-native</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/sonarcloud" style="color:var(--text)">SonarCloud</a></td>
        <td>Code Quality + SAST</td>
        <td>\u221e (public repos)</td>
        <td>\u2014</td>
        <td>Code quality + security in one dashboard</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/gitguardian" style="color:var(--text)">GitGuardian</a></td>
        <td>Secret Scanning</td>
        <td>25 developers, \u221e scans</td>
        <td>\u2014</td>
        <td>Real-time secret detection in commits</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/trivy" style="color:var(--text)">Trivy</a></td>
        <td>Container Security</td>
        <td>\u221e (self-hosted)</td>
        <td>\u2705</td>
        <td>Container images, IaC, SBOM generation</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/grype" style="color:var(--text)">Grype</a></td>
        <td>SCA / Deps</td>
        <td>\u221e (self-hosted)</td>
        <td>\u2705</td>
        <td>Fast vulnerability scanner for containers and filesystems</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/dependabot" style="color:var(--text)">Dependabot</a></td>
        <td>Dependency Updates</td>
        <td>\u221e (GitHub repos)</td>
        <td>\u2705</td>
        <td>Auto-PR for vulnerable deps, GitHub-native</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/auth0" style="color:var(--text)">Auth0</a></td>
        <td>Identity / Auth</td>
        <td>25K MAU</td>
        <td>\u2014</td>
        <td>Enterprise auth: SSO, MFA, social login</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/clerk" style="color:var(--text)">Clerk</a></td>
        <td>Identity / Auth</td>
        <td>10K MAU</td>
        <td>\u2014</td>
        <td>Modern DX: React components, webhooks</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/keycloak" style="color:var(--text)">Keycloak</a></td>
        <td>Identity / Auth</td>
        <td>\u221e (self-hosted)</td>
        <td>\u2705</td>
        <td>Self-hosted SSO, SAML, OIDC, LDAP</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/hashicorp-vault" style="color:var(--text)">HashiCorp Vault</a></td>
        <td>Secrets Management</td>
        <td>Community (self-hosted) + HCP Free</td>
        <td>\u2705</td>
        <td>Dynamic secrets, encryption as a service</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">Snyk leads the all-in-one category with code, dependency, container, and IaC scanning in a single tool. For pure SAST, Semgrep and CodeQL are both excellent and free for open-source. GitGuardian is the standard for secret detection. Trivy dominates container scanning. Auth0 has the most generous free auth tier at 25K MAU. All limits verified against live pricing pages, March 2026.</p>

  <h2>Which Free Security Tool Should I Use?</h2>
  <div class="decision-guide">
    <dl>
      <dt>Need all-in-one vulnerability scanning?</dt>
      <dd><a href="/vendor/snyk">Snyk</a> \u2014 covers code (SAST), dependencies (SCA), container images, and Infrastructure as Code in a single dashboard. Free for 200 tests/month on up to 5 projects.</dd>

      <dt>Want open-source code scanning?</dt>
      <dd><a href="/vendor/semgrep">Semgrep</a> for fast, customizable rule-based scanning. <a href="/vendor/codeql">CodeQL</a> for deep semantic analysis (free on public GitHub repos). Both support custom rules.</dd>

      <dt>Worried about leaked secrets?</dt>
      <dd><a href="/vendor/gitguardian">GitGuardian</a> for real-time scanning of commits and PRs (free for 25 devs). <a href="/vendor/gitleaks">Gitleaks</a> and <a href="/vendor/trufflehog">TruffleHog</a> are open-source CLI alternatives for pre-commit hooks.</dd>

      <dt>Scanning container images?</dt>
      <dd><a href="/vendor/trivy">Trivy</a> is the standard \u2014 scans containers, IaC, and generates SBOMs. <a href="/vendor/grype">Grype</a> is a fast alternative from the Anchore team. Both are open-source with no limits.</dd>

      <dt>Need user authentication for your app?</dt>
      <dd><a href="/vendor/auth0">Auth0</a> (25K MAU free) for enterprise features like SSO and MFA. <a href="/vendor/clerk">Clerk</a> (10K MAU) for modern React-first DX. <a href="/vendor/keycloak">Keycloak</a> for self-hosted with unlimited users. See our <a href="/auth0-alternatives">Auth0 Alternatives</a> guide.</dd>

      <dt>Managing secrets at runtime?</dt>
      <dd><a href="/vendor/hashicorp-vault">HashiCorp Vault</a> for dynamic secrets and encryption (community edition self-hosted). <a href="/vendor/doppler">Doppler</a> (5 users free) or <a href="/vendor/infisical">Infisical</a> for cloud-hosted secret management with team sharing.</dd>

      <dt>Keeping dependencies updated?</dt>
      <dd><a href="/vendor/dependabot">Dependabot</a> is built into GitHub and auto-creates PRs for vulnerable deps. <a href="/vendor/renovate">Renovate</a> is the self-hostable alternative with more configuration options.</dd>

      <dt>Catching runtime errors in production?</dt>
      <dd><a href="/vendor/sentry" style="color:var(--text-muted)">Sentry</a> (see <a href="/category/error-tracking">Error Tracking</a>), <a href="/vendor/bugsnag">Bugsnag</a>, and <a href="/vendor/glitchtip">GlitchTip</a> (open-source Sentry alternative) all have free tiers for exception tracking.</dd>
    </dl>
  </div>

  <div class="search-cta">
    <p>Looking for more? Browse all <a href="/category/security">Security</a>, <a href="/category/auth">Auth</a>, and <a href="/category/error-tracking">Error Tracking</a> tools in our full index of ${offers.length.toLocaleString()}+ developer deals.</p>
  </div>

  ${buildMoreAlternativesGuides(slug)}

  ${buildMcpCta("Get security tool recommendations from your AI assistant. Compare SAST scanners, secret managers, auth providers, and container security tools \u2014 directly in your editor.")}
  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
<script>${mcpCtaScript()}</script>
</body>
</html>`;
}

function buildTestingAlternativesPage(): string {
  const title = "Best Free Testing Tools for Developers in 2026 — Browser, Visual, Load, E2E & API Testing Compared";
  const metaDesc = "Compare 45+ free testing tools — Cypress, BrowserStack, Playwright, k6, Percy, Chromatic, Postman, Selenium, and more. Exact free tier limits by testing domain. Updated March 2026.";
  const slug = "testing-alternatives";

  // Get all testing-related offers
  const testingOffers = offers.filter(o => o.category === "Testing");
  const enrichedAll = enrichOffers(testingOffers);
  const riskColors: Record<string, string> = { stable: "#3fb950", caution: "#d29922", risky: "#f85149" };

  // Group by testing domain
  const browserTesting = enrichedAll.filter(o =>
    ["BrowserStack", "Sauce Labs", "LambdaTest", "Appetize", "gridlastic.com", "testingbot.com", "Selenium Grid"].includes(o.vendor)
  );
  const visualTesting = enrichedAll.filter(o =>
    ["BrowserStack Percy", "Chromatic", "Argos", "Applitools Eyes", "lost-pixel.com"].includes(o.vendor)
  );
  const loadTesting = enrichedAll.filter(o =>
    ["Grafana k6 Cloud", "Artillery", "Gatling", "Locust", "BlazeMeter", "loadmill.com", "websitepulse.com"].includes(o.vendor)
  );
  const e2eTesting = enrichedAll.filter(o =>
    ["Cypress Cloud", "Checkly", "BugBug", "Keploy", "katalon.com", "kogiQA", "everystep-automation.com"].includes(o.vendor)
  );
  const apiTesting = enrichedAll.filter(o =>
    ["Postman", "UseWebhook.com", "webhook.site", "CORS-Tester"].includes(o.vendor)
  );
  const codeQuality = enrichedAll.filter(o =>
    ["Codecov", "tesults.com", "Testspace.com", "qase.io", "Bencher"].includes(o.vendor)
  );
  const localDev = enrichedAll.filter(o =>
    ["LocalStack", "Testcontainers", "Moto", "AWS SAM CLI"].includes(o.vendor)
  );
  const other = enrichedAll.filter(o =>
    !browserTesting.includes(o) && !visualTesting.includes(o) && !loadTesting.includes(o) &&
    !e2eTesting.includes(o) && !apiTesting.includes(o) && !codeQuality.includes(o) && !localDev.includes(o)
  );

  // Build cards helper
  const buildCards = (items: ReturnType<typeof enrichOffers>) => items.map(o => {
    const riskBadge = o.risk_level ? `<span style="display:inline-block;font-size:.7rem;padding:.15rem .5rem;border-radius:10px;background:${riskColors[o.risk_level]}22;color:${riskColors[o.risk_level]};font-weight:600;margin-left:.5rem">${o.risk_level}</span>` : "";
    return `<div class="alt-card">
        <div class="alt-card-header">
          <a href="/vendor/${toSlug(o.vendor)}" class="alt-card-name">${escHtmlServer(o.vendor)}</a>
          <span class="alt-card-tier">${escHtmlServer(o.tier)}</span>
          ${riskBadge}
        </div>
        <p class="alt-card-desc">${escHtmlServer(o.description)}</p>
        <div class="alt-card-links">
          <a href="/vendor/${toSlug(o.vendor)}">Full profile</a>
          <a href="/alternative-to/${toSlug(o.vendor)}">Alternatives</a>
          <a href="${escHtmlServer(o.url)}" target="_blank" rel="noopener">Pricing &nearr;</a>
        </div>
      </div>`;
  }).join("\n");

  // Testing deal changes
  const testingChangeVendors = ["Cypress", "Postman", "LocalStack", "BrowserStack", "Sauce Labs", "Chromatic"];
  const testingChanges = dealChanges.filter(c => testingChangeVendors.some(v => c.vendor.includes(v)));
  const changesHtml = testingChanges.length > 0 ? `
  <div class="context-box" style="border-left:3px solid ${riskColors.caution}">
    <div style="font-weight:600;color:${riskColors.caution};margin-bottom:.5rem">Recent Testing Tool Pricing Changes</div>
    <ul style="margin:0;padding-left:1.25rem;font-size:.9rem;color:var(--text-muted);line-height:1.8">
      ${testingChanges.slice(0, 8).map(c => `<li><strong>${escHtmlServer(c.vendor)}</strong>: ${escHtmlServer(c.summary.length > 120 ? c.summary.substring(0, 117) + "..." : c.summary)}</li>`).join("\n      ")}
    </ul>
    <p style="margin:.75rem 0 0;font-size:.8rem"><a href="/changes">View all ${dealChanges.length} pricing changes &rarr;</a></p>
  </div>` : "";

  // JSON-LD
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: title,
    description: metaDesc,
    numberOfItems: testingOffers.length,
    itemListElement: enrichedAll.slice(0, 30).map((o, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "SoftwareApplication",
        name: o.vendor,
        description: o.description,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: o.tier },
        url: o.url,
      },
    })),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)} — AgentDeals</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/${slug}">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/${slug}">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
h2{font-family:var(--serif);font-size:1.4rem;color:var(--text);margin:2.5rem 0 1rem;letter-spacing:-.01em}
h3{font-family:var(--serif);font-size:1.1rem;color:var(--text);margin:1.5rem 0 .5rem}
.context{color:var(--text-muted);margin-bottom:1.5rem;font-size:.95rem;line-height:1.7}
.context strong{color:var(--text)}
.context-box{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1rem 1.25rem;margin:1.5rem 0;font-size:.9rem;color:var(--text-muted)}
.alt-card{padding:1.25rem;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;background:var(--bg-card);margin-bottom:.75rem;transition:border-color .2s}
.alt-card:hover{border-color:var(--accent)}
.alt-card-header{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem}
.alt-card-name{font-size:1.1rem;font-weight:600;color:var(--text)}
.alt-card-name:hover{color:var(--accent)}
.alt-card-tier{font-family:var(--mono);color:var(--accent);font-size:.8rem;padding:.1rem .5rem;background:var(--accent-glow);border-radius:10px}
.alt-card-desc{color:var(--text-muted);font-size:.9rem;line-height:1.5;margin:.5rem 0}
.alt-card-links{display:flex;flex-wrap:wrap;gap:.75rem;font-size:.8rem;margin-top:.5rem}
.alt-card-links a{color:var(--accent);text-decoration:none}
.alt-card-links a:hover{text-decoration:underline}
.compare-table{width:100%;border-collapse:collapse;margin:1rem 0 2rem}
.compare-table th,.compare-table td{padding:.5rem .75rem;text-align:left;border-bottom:1px solid var(--border);font-size:.85rem}
.compare-table th{color:var(--text-muted);font-weight:500;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
.compare-table tr:hover{background:var(--accent-glow)}
.search-cta{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.25rem;margin:2rem 0;text-align:center;font-size:.9rem}
.decision-guide{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.5rem;margin:2rem 0}
.decision-guide dt{font-weight:600;color:var(--text);margin-top:1rem}
.decision-guide dt:first-child{margin-top:0}
.decision-guide dd{color:var(--text-muted);font-size:.9rem;margin:.25rem 0 0 0;line-height:1.6}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.compare-table{font-size:.75rem}.compare-table th,.compare-table td{padding:.4rem .5rem}}
${globalNavCss()}
${mcpCtaCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("alternatives")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; <a href="/alternatives">Alternatives</a> &rsaquo; Free Testing Tools</div>
  <h1>Best Free Testing Tools for Developers</h1>

  <div class="context">
    <p>Testing infrastructure is one of the fastest-growing developer tool categories \u2014 and one of the most expensive to scale. Cloud-based browser testing, visual regression snapshots, and load test minutes all add up quickly. The good news: the free tier landscape is strong. <strong>Cypress Cloud</strong> offers <strong>500 test results/month</strong>. <strong>BrowserStack</strong> and <strong>Sauce Labs</strong> are <strong>free for open-source projects</strong>. <strong>Grafana k6 Cloud</strong> gives <strong>500 virtual user hours/month</strong>. <strong>Chromatic</strong> provides <strong>5,000 snapshots/month</strong> for visual regression.</p>
    <p>This page compares every free testing tool in our index \u2014 <strong>${testingOffers.length} tools</strong> across browser testing, visual regression, load/performance testing, E2E automation, API testing, code coverage, and local development. Whether you need a BrowserStack alternative or a load testing solution, we have the comparison with exact free tier limits.</p>
  </div>

  ${changesHtml}

  <h2>Browser &amp; Cross-Platform Testing</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Cloud-based browser testing services for cross-browser compatibility, mobile testing, and Selenium Grid hosting. Run your tests on real browsers and devices without maintaining your own infrastructure.</p>
${buildCards(browserTesting)}

  <h2>Visual Regression Testing</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Automated screenshot comparison tools that catch visual bugs before they reach production. Integrate with your CI pipeline to detect unintended UI changes on every pull request.</p>
${buildCards(visualTesting)}

  <h2>Load &amp; Performance Testing</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Load testing and performance benchmarking tools. Simulate thousands of concurrent users to find bottlenecks before your users do. From scriptable open-source frameworks to managed cloud platforms.</p>
${buildCards(loadTesting)}

  <h2>E2E &amp; Test Automation</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">End-to-end test runners and automation platforms. Record, write, and execute tests that simulate real user flows \u2014 from clicking buttons to filling forms to verifying API responses.</p>
${buildCards(e2eTesting)}

  <h2>API Testing &amp; Webhooks</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Tools for testing REST APIs, GraphQL endpoints, webhooks, and CORS configurations. From full-featured API development environments to single-purpose debugging utilities.</p>
${buildCards(apiTesting)}

  <h2>Code Coverage &amp; Quality</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Code coverage reporting, test result tracking, and quality metrics. Integrate with your CI to enforce coverage thresholds and track test health over time.</p>
${buildCards(codeQuality)}

  <h2>Local Dev &amp; Mocking</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Tools for running cloud services locally during development and testing. Emulate AWS services, spin up test databases in containers, and mock external APIs without cloud costs.</p>
${buildCards(localDev)}

${other.length > 0 ? `
  <h2>Other Testing Tools</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">SEO checkers, accessibility testers, SSR validators, and other specialized testing utilities with free tiers.</p>
${buildCards(other)}
` : ""}

  <h2>Free Testing Tools Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Top free testing tools compared by domain, free tier limits, and best use case.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Tool</th>
        <th>Domain</th>
        <th>Free Tier</th>
        <th>OSS</th>
        <th>Best For</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600"><a href="/vendor/cypress-cloud" style="color:var(--text)">Cypress Cloud</a></td>
        <td>E2E</td>
        <td>500 results/mo</td>
        <td>Framework</td>
        <td>JavaScript E2E testing with cloud dashboard</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/browserstack" style="color:var(--text)">BrowserStack</a></td>
        <td>Browser</td>
        <td>Free for OSS</td>
        <td>Free for OSS</td>
        <td>Cross-browser testing on real devices</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/sauce-labs" style="color:var(--text)">Sauce Labs</a></td>
        <td>Browser</td>
        <td>Free for OSS</td>
        <td>Free for OSS</td>
        <td>Large-scale cross-browser + mobile testing</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/lambdatest" style="color:var(--text)">LambdaTest</a></td>
        <td>Browser</td>
        <td>60 min/mo</td>
        <td>No</td>
        <td>Cloud browser testing with live + automation</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/chromatic" style="color:var(--text)">Chromatic</a></td>
        <td>Visual</td>
        <td>5K snapshots/mo</td>
        <td>No</td>
        <td>Storybook visual testing + review</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/browserstack-percy" style="color:var(--text)">BrowserStack Percy</a></td>
        <td>Visual</td>
        <td>5K screenshots/mo</td>
        <td>No</td>
        <td>Cross-browser visual regression</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/applitools-eyes" style="color:var(--text)">Applitools Eyes</a></td>
        <td>Visual</td>
        <td>100 checkpoints/mo</td>
        <td>No</td>
        <td>AI-powered visual testing</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/grafana-k6-cloud" style="color:var(--text)">Grafana k6 Cloud</a></td>
        <td>Load</td>
        <td>500 VUh/mo</td>
        <td>Framework</td>
        <td>Scriptable load testing with cloud analytics</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/postman" style="color:var(--text)">Postman</a></td>
        <td>API</td>
        <td>Free single-user</td>
        <td>No</td>
        <td>API development, testing, and documentation</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/codecov" style="color:var(--text)">Codecov</a></td>
        <td>Coverage</td>
        <td>Free for 5 users</td>
        <td>No</td>
        <td>Code coverage reporting + CI integration</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/localstack" style="color:var(--text)">LocalStack</a></td>
        <td>Local Dev</td>
        <td>30+ AWS services</td>
        <td>Core</td>
        <td>Local AWS emulation for testing</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/testcontainers" style="color:var(--text)">Testcontainers</a></td>
        <td>Local Dev</td>
        <td>\u221e (open-source)</td>
        <td>Yes</td>
        <td>Throwaway Docker containers for integration tests</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">Cypress Cloud leads for JavaScript E2E with 500 free results/month and a polished dashboard. BrowserStack and Sauce Labs are unbeatable for OSS projects needing cross-browser coverage. For load testing, Grafana k6 Cloud gives 500 VUh/month with the popular k6 scripting framework. Chromatic dominates Storybook visual testing at 5K snapshots/month. All limits verified against live pricing pages, March 2026.</p>

  <h2>Which Free Testing Tool Should I Use?</h2>
  <div class="decision-guide">
    <dl>
      <dt>Need cross-browser testing for an open-source project?</dt>
      <dd><a href="/vendor/browserstack">BrowserStack</a> and <a href="/vendor/sauce-labs">Sauce Labs</a> both offer free plans for open-source projects, including real devices and parallel testing. <a href="/vendor/lambdatest">LambdaTest</a> gives 60 free minutes/month for private projects.</dd>

      <dt>Setting up E2E tests for a JavaScript app?</dt>
      <dd><a href="/vendor/cypress-cloud">Cypress Cloud</a> \u2014 500 test results/month free with parallelization, screenshots, and video recordings. The Cypress framework itself is open-source. <a href="/vendor/checkly">Checkly</a> adds synthetic monitoring on top of Playwright tests.</dd>

      <dt>Want to catch visual regressions in CI?</dt>
      <dd><a href="/vendor/chromatic">Chromatic</a> for Storybook projects (5K snapshots/month). <a href="/vendor/browserstack-percy">BrowserStack Percy</a> for cross-browser visual diffs (5K screenshots/month). <a href="/vendor/applitools-eyes">Applitools Eyes</a> for AI-powered visual comparison (100 checkpoints/month).</dd>

      <dt>Need load testing for your API?</dt>
      <dd><a href="/vendor/grafana-k6-cloud">Grafana k6 Cloud</a> \u2014 500 VUh/month free with the scriptable k6 framework. <a href="/vendor/artillery">Artillery</a>, <a href="/vendor/gatling">Gatling</a>, and <a href="/vendor/locust">Locust</a> are fully open-source alternatives you can self-host.</dd>

      <dt>Testing REST APIs and webhooks?</dt>
      <dd><a href="/vendor/postman">Postman</a> for full API development workflows (free since March 2026 for single users). <a href="/vendor/webhook-site">webhook.site</a> and <a href="/vendor/usewebhook-com">UseWebhook.com</a> for quick webhook debugging.</dd>

      <dt>Want code coverage reporting in CI?</dt>
      <dd><a href="/vendor/codecov">Codecov</a> \u2014 free for up to 5 users with GitHub/GitLab integration and PR coverage comments. <a href="/vendor/bencher">Bencher</a> for continuous benchmarking and performance tracking.</dd>

      <dt>Need to test against AWS services locally?</dt>
      <dd><a href="/vendor/localstack">LocalStack</a> emulates 30+ AWS services locally (free tier). <a href="/vendor/testcontainers">Testcontainers</a> for spinning up disposable Docker containers in tests. <a href="/vendor/moto">Moto</a> for Python AWS mocking.</dd>

      <dt>Looking for open-source test automation?</dt>
      <dd><a href="/vendor/selenium-grid">Selenium Grid</a> for browser automation across languages. <a href="/vendor/locust">Locust</a> for Python load testing. <a href="/vendor/gatling">Gatling</a> for Scala/Java performance tests. All free, self-hosted, no limits.</dd>
    </dl>
  </div>

  <div class="search-cta">
    <p>Looking for more? Browse all <a href="/category/testing">Testing</a> tools in our full index of ${offers.length.toLocaleString()}+ developer deals.</p>
  </div>

  ${buildMoreAlternativesGuides(slug)}

  ${buildMcpCta("Get testing tool recommendations from your AI assistant. Compare browser testing, visual regression, load testing, and E2E automation tools \u2014 directly in your editor.")}
  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
<script>${mcpCtaScript()}</script>
</body>
</html>`;
}

function buildStorageAlternativesPage(): string {
  const title = "Best Free Cloud Storage for Developers in 2026 — Object Storage, Media CDN & File Hosting Compared";
  const metaDesc = "Compare 55+ free cloud storage tools — Cloudflare R2, Backblaze B2, Tigris, Cloudinary, ImageKit, Google Cloud Storage, and more. Exact free tier limits by storage type. Updated March 2026.";
  const slug = "storage-alternatives";

  // Get all storage-related offers
  const storageOffers = offers.filter(o => o.category === "Storage" || o.category === "CDN");
  const enrichedAll = enrichOffers(storageOffers);
  const riskColors: Record<string, string> = { stable: "#3fb950", caution: "#d29922", risky: "#f85149" };

  // Group by storage domain
  const objectStorage = enrichedAll.filter(o =>
    ["Cloudflare R2", "Backblaze B2", "Tigris", "MinIO", "Google Cloud Storage", "Backblaze", "Pinata IPFS", "packagecloud.io"].includes(o.vendor)
  );
  const mediaCdn = enrichedAll.filter(o =>
    ["Cloudinary", "ImageKit", "Uploadcare", "twicpics.com", "gumlet.com", "imgix", "embed.ly", "ImageEngine", "ImgBB", "imgen", "kraken.io", "sirv.com", "resmush.it", "tinypng.com", "image-charts.com", "QuickChart", "plot.ly", "nitropack.io"].includes(o.vendor)
  );
  const cdnDelivery = enrichedAll.filter(o =>
    o.category === "CDN" && !mediaCdn.includes(o)
  );
  const fileStorageSync = enrichedAll.filter(o =>
    ["seafile.com", "odrive", "transfernow", "transloadit.com", "wormhol.org", "Wormhole", "GoFile.io", "file.io", "internxt.com", "icedrive.net", "pcloud.com", "sync.com", "Proton Drive", "degoo.com", "Ente", "borgbase.com", "Dropshare"].includes(o.vendor)
  );
  const other = enrichedAll.filter(o =>
    !objectStorage.includes(o) && !mediaCdn.includes(o) && !cdnDelivery.includes(o) && !fileStorageSync.includes(o)
  );

  // Build cards helper
  const buildCards = (items: ReturnType<typeof enrichOffers>) => items.map(o => {
    const riskBadge = o.risk_level ? `<span style="display:inline-block;font-size:.7rem;padding:.15rem .5rem;border-radius:10px;background:${riskColors[o.risk_level]}22;color:${riskColors[o.risk_level]};font-weight:600;margin-left:.5rem">${o.risk_level}</span>` : "";
    return `<div class="alt-card">
        <div class="alt-card-header">
          <a href="/vendor/${toSlug(o.vendor)}" class="alt-card-name">${escHtmlServer(o.vendor)}</a>
          <span class="alt-card-tier">${escHtmlServer(o.tier)}</span>
          ${riskBadge}
        </div>
        <p class="alt-card-desc">${escHtmlServer(o.description)}</p>
        <div class="alt-card-links">
          <a href="/vendor/${toSlug(o.vendor)}">Full profile</a>
          <a href="/alternative-to/${toSlug(o.vendor)}">Alternatives</a>
          <a href="${escHtmlServer(o.url)}" target="_blank" rel="noopener">Pricing &nearr;</a>
        </div>
      </div>`;
  }).join("\n");

  // Storage deal changes
  const storageChangeVendors = ["Cloudflare", "Backblaze", "Cloudinary", "ImageKit", "Google Cloud", "Tigris", "Fastly"];
  const storageChanges = dealChanges.filter(c => storageChangeVendors.some(v => c.vendor.includes(v)));
  const changesHtml = storageChanges.length > 0 ? `
  <div class="context-box" style="border-left:3px solid ${riskColors.caution}">
    <div style="font-weight:600;color:${riskColors.caution};margin-bottom:.5rem">Recent Storage Pricing Changes</div>
    <ul style="margin:0;padding-left:1.25rem;font-size:.9rem;color:var(--text-muted);line-height:1.8">
      ${storageChanges.slice(0, 8).map(c => `<li><strong>${escHtmlServer(c.vendor)}</strong>: ${escHtmlServer(c.summary.length > 120 ? c.summary.substring(0, 117) + "..." : c.summary)}</li>`).join("\n      ")}
    </ul>
    <p style="margin:.75rem 0 0;font-size:.8rem"><a href="/changes">View all ${dealChanges.length} pricing changes &rarr;</a></p>
  </div>` : "";

  // JSON-LD
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: title,
    description: metaDesc,
    numberOfItems: storageOffers.length,
    itemListElement: enrichedAll.slice(0, 30).map((o, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "SoftwareApplication",
        name: o.vendor,
        description: o.description,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: o.tier },
        url: o.url,
      },
    })),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)} — AgentDeals</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/${slug}">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/${slug}">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
h2{font-family:var(--serif);font-size:1.4rem;color:var(--text);margin:2.5rem 0 1rem;letter-spacing:-.01em}
h3{font-family:var(--serif);font-size:1.1rem;color:var(--text);margin:1.5rem 0 .5rem}
.context{color:var(--text-muted);margin-bottom:1.5rem;font-size:.95rem;line-height:1.7}
.context strong{color:var(--text)}
.context-box{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1rem 1.25rem;margin:1.5rem 0;font-size:.9rem;color:var(--text-muted)}
.alt-card{padding:1.25rem;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;background:var(--bg-card);margin-bottom:.75rem;transition:border-color .2s}
.alt-card:hover{border-color:var(--accent)}
.alt-card-header{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem}
.alt-card-name{font-size:1.1rem;font-weight:600;color:var(--text)}
.alt-card-name:hover{color:var(--accent)}
.alt-card-tier{font-family:var(--mono);color:var(--accent);font-size:.8rem;padding:.1rem .5rem;background:var(--accent-glow);border-radius:10px}
.alt-card-desc{color:var(--text-muted);font-size:.9rem;line-height:1.5;margin:.5rem 0}
.alt-card-links{display:flex;flex-wrap:wrap;gap:.75rem;font-size:.8rem;margin-top:.5rem}
.alt-card-links a{color:var(--accent);text-decoration:none}
.alt-card-links a:hover{text-decoration:underline}
.compare-table{width:100%;border-collapse:collapse;margin:1rem 0 2rem}
.compare-table th,.compare-table td{padding:.5rem .75rem;text-align:left;border-bottom:1px solid var(--border);font-size:.85rem}
.compare-table th{color:var(--text-muted);font-weight:500;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
.compare-table tr:hover{background:var(--accent-glow)}
.search-cta{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.25rem;margin:2rem 0;text-align:center;font-size:.9rem}
.decision-guide{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.5rem;margin:2rem 0}
.decision-guide dt{font-weight:600;color:var(--text);margin-top:1rem}
.decision-guide dt:first-child{margin-top:0}
.decision-guide dd{color:var(--text-muted);font-size:.9rem;margin:.25rem 0 0 0;line-height:1.6}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.compare-table{font-size:.75rem}.compare-table th,.compare-table td{padding:.4rem .5rem}}
${globalNavCss()}
${mcpCtaCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("alternatives")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; <a href="/alternatives">Alternatives</a> &rsaquo; Free Cloud Storage</div>
  <h1>Best Free Cloud Storage for Developers</h1>

  <div class="context">
    <p>Cloud storage costs add up fast — egress fees, per-request charges, and surprise overages can blow through a budget on a hobby project. The good news: the free tier landscape for storage is strong. <strong>Cloudflare R2</strong> offers <strong>10 GB free with zero egress fees</strong>. <strong>Backblaze B2</strong> gives <strong>10 GB free storage</strong>. <strong>Cloudinary</strong> provides <strong>25 credits/month</strong> for image and video transformations. <strong>Google Cloud Storage</strong> includes <strong>5 GB in its Always Free tier</strong>.</p>
    <p>This page compares every free storage tool in our index \u2014 <strong>${storageOffers.length} tools</strong> across object storage (S3-compatible), media/image CDN, content delivery networks, file hosting/sync, and general-purpose storage utilities. Whether you need an S3 alternative or a media pipeline, we have the comparison with exact free tier limits.</p>
  </div>

  ${changesHtml}

  <h2>Object Storage (S3-Compatible)</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">S3-compatible object storage services for files, backups, and application data. These are the core building blocks for any cloud storage architecture \u2014 from static assets to data lakes.</p>
${buildCards(objectStorage)}

  <h2>Media &amp; Image Processing</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Image and video optimization, transformation, and delivery services. Upload once, get automatic resizing, format conversion, and CDN delivery. Essential for any app that handles user-uploaded media.</p>
${buildCards(mediaCdn)}

  <h2>CDN &amp; Content Delivery</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Content delivery networks that cache and serve your assets from edge locations worldwide. From general-purpose CDNs to specialized JavaScript/CSS delivery.</p>
${buildCards(cdnDelivery)}

  <h2>File Storage &amp; Sync</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">File hosting, synchronization, and transfer services. From encrypted cloud drives to temporary file sharing and backup solutions.</p>
${buildCards(fileStorageSync)}

${other.length > 0 ? `
  <h2>Other Storage Tools</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">QR code generators, data storage utilities, and other tools with free tiers that handle storage-related tasks.</p>
${buildCards(other)}
` : ""}

  <h2>Free Cloud Storage Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Top free storage tools compared by type, free tier limits, and best use case.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Service</th>
        <th>Type</th>
        <th>Free Tier</th>
        <th>Egress</th>
        <th>Best For</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600"><a href="/vendor/cloudflare-r2" style="color:var(--text)">Cloudflare R2</a></td>
        <td>Object Storage</td>
        <td>10 GB, 1M reads/mo</td>
        <td>Free (zero egress)</td>
        <td>S3-compatible with no egress fees</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/backblaze-b2" style="color:var(--text)">Backblaze B2</a></td>
        <td>Object Storage</td>
        <td>10 GB</td>
        <td>1 GB/day free</td>
        <td>Affordable S3-compatible storage</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/tigris" style="color:var(--text)">Tigris</a></td>
        <td>Object Storage</td>
        <td>5 GB, 10K requests</td>
        <td>Included</td>
        <td>Globally distributed, S3-compatible</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/google-cloud-storage" style="color:var(--text)">Google Cloud Storage</a></td>
        <td>Object Storage</td>
        <td>5 GB (US regions)</td>
        <td>1 GB/mo free</td>
        <td>GCP ecosystem integration</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/minio" style="color:var(--text)">MinIO</a></td>
        <td>Object Storage</td>
        <td>\u221e (self-hosted)</td>
        <td>N/A (self-hosted)</td>
        <td>Self-hosted S3-compatible, high performance</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/cloudinary" style="color:var(--text)">Cloudinary</a></td>
        <td>Media CDN</td>
        <td>25 credits/mo</td>
        <td>Included</td>
        <td>Image/video transformations + CDN</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/imagekit" style="color:var(--text)">ImageKit</a></td>
        <td>Media CDN</td>
        <td>20 GB bandwidth/mo</td>
        <td>Included</td>
        <td>Real-time image optimization + CDN</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/uploadcare" style="color:var(--text)">Uploadcare</a></td>
        <td>Media CDN</td>
        <td>3K uploads, 30K transforms</td>
        <td>Included</td>
        <td>Upload widget + image transformations</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/fastly" style="color:var(--text)">Fastly</a></td>
        <td>CDN</td>
        <td>Free developer account</td>
        <td>Included</td>
        <td>Edge computing + CDN, Varnish-based</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/jsdelivr" style="color:var(--text)">jsDelivr</a></td>
        <td>CDN</td>
        <td>\u221e (open-source)</td>
        <td>Free</td>
        <td>npm/GitHub package CDN</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/proton-drive" style="color:var(--text)">Proton Drive</a></td>
        <td>File Sync</td>
        <td>1 GB</td>
        <td>N/A</td>
        <td>End-to-end encrypted cloud storage</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/pinata-ipfs" style="color:var(--text)">Pinata IPFS</a></td>
        <td>Decentralized</td>
        <td>1 GB</td>
        <td>Included</td>
        <td>IPFS pinning for decentralized storage</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">Cloudflare R2 leads on value with 10 GB free and zero egress fees \u2014 a game-changer for read-heavy workloads. Backblaze B2 matches on storage but charges for egress beyond 1 GB/day. For media, Cloudinary and ImageKit both offer generous transformation pipelines. MinIO is the go-to for self-hosted S3-compatible storage. All limits verified against live pricing pages, March 2026.</p>

  <h2>Which Free Storage Should I Use?</h2>
  <div class="decision-guide">
    <dl>
      <dt>Need S3-compatible object storage with no egress fees?</dt>
      <dd><a href="/vendor/cloudflare-r2">Cloudflare R2</a> \u2014 10 GB free storage, 1M Class B reads/month, and zero egress fees. The best deal for read-heavy workloads like static assets, backups, or media serving.</dd>

      <dt>Want affordable S3-compatible storage?</dt>
      <dd><a href="/vendor/backblaze-b2">Backblaze B2</a> \u2014 10 GB free, simple pricing at $6/TB beyond that. Pairs well with Cloudflare CDN (Bandwidth Alliance = free egress). <a href="/vendor/tigris">Tigris</a> is a newer S3-compatible option with global distribution.</dd>

      <dt>Building an image-heavy app?</dt>
      <dd><a href="/vendor/cloudinary">Cloudinary</a> for the most mature transformation pipeline (25 credits/month free). <a href="/vendor/imagekit">ImageKit</a> for 20 GB bandwidth/month. Both handle upload, resize, format conversion, and CDN delivery.</dd>

      <dt>Need a JavaScript/CSS CDN?</dt>
      <dd><a href="/vendor/jsdelivr">jsDelivr</a> for npm packages and GitHub repos (free, no limits). <a href="/vendor/cdnjs-com">cdnjs</a> for popular open-source libraries. Both are free and widely used.</dd>

      <dt>Want self-hosted object storage?</dt>
      <dd><a href="/vendor/minio">MinIO</a> \u2014 high-performance, S3-compatible, open-source. Run it on your own infrastructure with no storage or bandwidth limits. Widely used in on-prem and Kubernetes environments.</dd>

      <dt>Need encrypted file sync?</dt>
      <dd><a href="/vendor/proton-drive">Proton Drive</a> for end-to-end encrypted cloud storage (1 GB free). <a href="/vendor/internxt-com">Internxt</a> and <a href="/vendor/sync-com">Sync.com</a> are privacy-focused alternatives. <a href="/vendor/seafile-com">Seafile</a> is self-hostable.</dd>

      <dt>Hosting decentralized content?</dt>
      <dd><a href="/vendor/pinata-ipfs">Pinata</a> for IPFS pinning (1 GB free). Ideal for NFT metadata, decentralized apps, and content-addressed storage.</dd>

      <dt>Just need temporary file sharing?</dt>
      <dd><a href="/vendor/transfernow">TransferNow</a>, <a href="/vendor/gofile-io">GoFile</a>, and <a href="/vendor/file-io">file.io</a> all offer free temporary file transfers without sign-up.</dd>
    </dl>
  </div>

  <div class="search-cta">
    <p>Looking for more? Browse all <a href="/category/storage">Storage</a> and <a href="/category/cdn">CDN</a> tools in our full index of ${offers.length.toLocaleString()}+ developer deals.</p>
  </div>

  ${buildMoreAlternativesGuides(slug)}

  ${buildMcpCta("Get cloud storage recommendations from your AI assistant. Compare object storage, media CDNs, and file hosting services \u2014 directly in your editor.")}
  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
<script>${mcpCtaScript()}</script>
</body>
</html>`;
}

function buildAnalyticsAlternativesPage(): string {
  const title = "Best Free Analytics Tools for Developers in 2026 — Product, Web, Event & Data Analytics Compared";
  const metaDesc = "Compare 45+ free analytics tools — PostHog, Amplitude, Mixpanel, Plausible, Umami, Tinybird, Segment, and more. Exact free tier limits by analytics domain. Updated March 2026.";
  const slug = "analytics-alternatives";

  // Get all analytics offers
  const analyticsOffers = offers.filter(o => o.category === "Analytics");
  const enrichedAll = enrichOffers(analyticsOffers);
  const riskColors: Record<string, string> = { stable: "#3fb950", caution: "#d29922", risky: "#f85149" };

  // Group by analytics domain
  const productAnalytics = enrichedAll.filter(o =>
    ["PostHog", "Amplitude", "Mixpanel", "heap.io", "Indicative", "Trackingplan"].includes(o.vendor)
  );
  const webAnalytics = enrichedAll.filter(o =>
    ["Plausible Analytics", "Umami", "GoatCounter", "Clicky", "counter.dev", "Beampipe.io", "getinsights.io", "Google Analytics", "StatCounter", "MetricsWave", "Rybbit", "Seline", "LogSpot", "TrackWith Dicloud", "Repohistory"].includes(o.vendor)
  );
  const sessionReplay = enrichedAll.filter(o =>
    ["FullStory.com", "Hotjar", "Microsoft Clarity", "OpenReplay.com", "smartlook.com", "mouseflow.com", "howuku.com", "inspectlet.com", "UXtweak.com", "usabilityhub.com", "Userbird"].includes(o.vendor)
  );
  const eventTracking = enrichedAll.filter(o =>
    ["Aptabase", "AppFit", "Avo", "DocBeacon", "Moesif", "TraceLog"].includes(o.vendor)
  );
  const dataInfra = enrichedAll.filter(o =>
    ["Segment", "Census", "Tinybird", "Dwh.dev", "Hightouch", "Row Zero", "Expensify"].includes(o.vendor)
  );
  const other = enrichedAll.filter(o =>
    !productAnalytics.includes(o) && !webAnalytics.includes(o) && !sessionReplay.includes(o) && !eventTracking.includes(o) && !dataInfra.includes(o)
  );

  // Build cards helper
  const buildCards = (items: ReturnType<typeof enrichOffers>) => items.map(o => {
    const riskBadge = o.risk_level ? `<span style="display:inline-block;font-size:.7rem;padding:.15rem .5rem;border-radius:10px;background:${riskColors[o.risk_level]}22;color:${riskColors[o.risk_level]};font-weight:600;margin-left:.5rem">${o.risk_level}</span>` : "";
    return `<div class="alt-card">
        <div class="alt-card-header">
          <a href="/vendor/${toSlug(o.vendor)}" class="alt-card-name">${escHtmlServer(o.vendor)}</a>
          <span class="alt-card-tier">${escHtmlServer(o.tier)}</span>
          ${riskBadge}
        </div>
        <p class="alt-card-desc">${escHtmlServer(o.description)}</p>
        <div class="alt-card-links">
          <a href="/vendor/${toSlug(o.vendor)}">Full profile</a>
          <a href="/alternative-to/${toSlug(o.vendor)}">Alternatives</a>
          <a href="${escHtmlServer(o.url)}" target="_blank" rel="noopener">Pricing &nearr;</a>
        </div>
      </div>`;
  }).join("\n");

  // Analytics deal changes
  const analyticsChangeVendors = ["PostHog", "Amplitude", "Mixpanel", "Plausible", "Umami", "Google Analytics", "Segment", "Tinybird", "Hotjar"];
  const analyticsChanges = dealChanges.filter(c => analyticsChangeVendors.some(v => c.vendor.includes(v)));
  const changesHtml = analyticsChanges.length > 0 ? `
  <div class="context-box" style="border-left:3px solid ${riskColors.caution}">
    <div style="font-weight:600;color:${riskColors.caution};margin-bottom:.5rem">Recent Analytics Pricing Changes</div>
    <ul style="margin:0;padding-left:1.25rem;font-size:.9rem;color:var(--text-muted);line-height:1.8">
      ${analyticsChanges.slice(0, 8).map(c => `<li><strong>${escHtmlServer(c.vendor)}</strong>: ${escHtmlServer(c.summary.length > 120 ? c.summary.substring(0, 117) + "..." : c.summary)}</li>`).join("\n      ")}
    </ul>
    <p style="margin:.75rem 0 0;font-size:.8rem"><a href="/changes">View all ${dealChanges.length} pricing changes &rarr;</a></p>
  </div>` : "";

  // JSON-LD
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: title,
    description: metaDesc,
    numberOfItems: analyticsOffers.length,
    itemListElement: enrichedAll.slice(0, 30).map((o, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "SoftwareApplication",
        name: o.vendor,
        description: o.description,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: o.tier },
        url: o.url,
      },
    })),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)} — AgentDeals</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/${slug}">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/${slug}">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
h2{font-family:var(--serif);font-size:1.4rem;color:var(--text);margin:2.5rem 0 1rem;letter-spacing:-.01em}
h3{font-family:var(--serif);font-size:1.1rem;color:var(--text);margin:1.5rem 0 .5rem}
.context{color:var(--text-muted);margin-bottom:1.5rem;font-size:.95rem;line-height:1.7}
.context strong{color:var(--text)}
.context-box{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1rem 1.25rem;margin:1.5rem 0;font-size:.9rem;color:var(--text-muted)}
.alt-card{padding:1.25rem;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;background:var(--bg-card);margin-bottom:.75rem;transition:border-color .2s}
.alt-card:hover{border-color:var(--accent)}
.alt-card-header{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem}
.alt-card-name{font-size:1.1rem;font-weight:600;color:var(--text)}
.alt-card-name:hover{color:var(--accent)}
.alt-card-tier{font-family:var(--mono);color:var(--accent);font-size:.8rem;padding:.1rem .5rem;background:var(--accent-glow);border-radius:10px}
.alt-card-desc{color:var(--text-muted);font-size:.9rem;line-height:1.5;margin:.5rem 0}
.alt-card-links{display:flex;flex-wrap:wrap;gap:.75rem;font-size:.8rem;margin-top:.5rem}
.alt-card-links a{color:var(--accent);text-decoration:none}
.alt-card-links a:hover{text-decoration:underline}
.compare-table{width:100%;border-collapse:collapse;margin:1rem 0 2rem}
.compare-table th,.compare-table td{padding:.5rem .75rem;text-align:left;border-bottom:1px solid var(--border);font-size:.85rem}
.compare-table th{color:var(--text-muted);font-weight:500;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
.compare-table tr:hover{background:var(--accent-glow)}
.search-cta{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.25rem;margin:2rem 0;text-align:center;font-size:.9rem}
.decision-guide{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.5rem;margin:2rem 0}
.decision-guide dt{font-weight:600;color:var(--text);margin-top:1rem}
.decision-guide dt:first-child{margin-top:0}
.decision-guide dd{color:var(--text-muted);font-size:.9rem;margin:.25rem 0 0 0;line-height:1.6}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.compare-table{font-size:.75rem}.compare-table th,.compare-table td{padding:.4rem .5rem}}
${globalNavCss()}
${mcpCtaCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("alternatives")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; <a href="/alternatives">Alternatives</a> &rsaquo; Free Analytics Tools</div>
  <h1>Best Free Analytics Tools for Developers</h1>

  <div class="context">
    <p>Analytics is essential for understanding users, but pricing can be opaque and usage-based costs escalate fast. Fortunately, the free tier landscape is generous. <strong>PostHog</strong> offers <strong>1M events/month</strong> with session replays, feature flags, and A/B testing included. <strong>Amplitude</strong> gives <strong>10M events with 10K MTU</strong>. <strong>Plausible</strong> and <strong>Umami</strong> are privacy-first, cookie-free alternatives you can self-host with no limits.</p>
    <p>This page compares every free analytics tool in our index \u2014 <strong>${analyticsOffers.length} tools</strong> across product analytics, web analytics, session replay, event tracking, and data infrastructure. Whether you need a Google Analytics alternative or a full product analytics suite, we have the comparison with exact free tier limits.</p>
  </div>

  ${changesHtml}

  <h2>Product Analytics</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Full-featured product analytics platforms with funnels, retention, cohorts, and user behavior tracking. These are the tools you reach for when you need to understand how users interact with your product.</p>
${buildCards(productAnalytics)}

  <h2>Web Analytics</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Traffic and pageview analytics \u2014 from privacy-first lightweight scripts to full-featured web analytics suites. Many are open-source and self-hostable, making them ideal Google Analytics alternatives.</p>
${buildCards(webAnalytics)}

  <h2>Session Replay &amp; UX Analytics</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Watch real user sessions, heatmaps, and click tracking. Understand not just what users do, but how they do it. Essential for debugging UX issues and improving conversion flows.</p>
${buildCards(sessionReplay)}

  <h2>Event Tracking &amp; SDKs</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Lightweight event tracking for mobile, desktop, and API analytics. These tools focus on capturing specific events rather than full product analytics suites.</p>
${buildCards(eventTracking)}

  <h2>Data Infrastructure &amp; Pipelines</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Customer data platforms, reverse ETL, real-time analytics engines, and data warehousing tools. The plumbing that connects your analytics stack together.</p>
${buildCards(dataInfra)}

${other.length > 0 ? `
  <h2>Other Analytics Tools</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Additional analytics and data tools with free tiers.</p>
${buildCards(other)}
` : ""}

  <h2>Free Analytics Tools Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Top free analytics tools compared by domain, free tier limits, and best use case.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Service</th>
        <th>Domain</th>
        <th>Free Tier</th>
        <th>OSS</th>
        <th>Best For</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600"><a href="/vendor/posthog" style="color:var(--text)">PostHog</a></td>
        <td>Product</td>
        <td>1M events/mo, 5K replays</td>
        <td>Yes</td>
        <td>All-in-one product analytics + feature flags</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/amplitude" style="color:var(--text)">Amplitude</a></td>
        <td>Product</td>
        <td>10M events, 10K MTU</td>
        <td>No</td>
        <td>Enterprise-grade product analytics</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/mixpanel" style="color:var(--text)">Mixpanel</a></td>
        <td>Product</td>
        <td>1M events/mo, unlimited seats</td>
        <td>No</td>
        <td>Funnel and retention analysis</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/plausible-analytics" style="color:var(--text)">Plausible</a></td>
        <td>Web</td>
        <td>\u221e (self-hosted)</td>
        <td>Yes (AGPL)</td>
        <td>Privacy-first GA alternative, &lt;1KB script</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/umami" style="color:var(--text)">Umami</a></td>
        <td>Web</td>
        <td>\u221e (self-hosted)</td>
        <td>Yes (MIT)</td>
        <td>Simple, self-hosted web analytics</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/microsoft-clarity" style="color:var(--text)">Microsoft Clarity</a></td>
        <td>Session Replay</td>
        <td>Unlimited (free)</td>
        <td>No</td>
        <td>Free session replay + heatmaps, no limits</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/hotjar" style="color:var(--text)">Hotjar</a></td>
        <td>Session Replay</td>
        <td>35 daily sessions</td>
        <td>No</td>
        <td>Heatmaps + session recordings + surveys</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/tinybird" style="color:var(--text)">Tinybird</a></td>
        <td>Data Infra</td>
        <td>10 GB storage, 10 QPS</td>
        <td>No</td>
        <td>Real-time analytics APIs over SQL</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/goatcounter" style="color:var(--text)">GoatCounter</a></td>
        <td>Web</td>
        <td>100K pageviews/mo</td>
        <td>Yes</td>
        <td>Simple, privacy-aware web analytics</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/aptabase" style="color:var(--text)">Aptabase</a></td>
        <td>Event Tracking</td>
        <td>20K events/mo</td>
        <td>Yes</td>
        <td>Mobile &amp; desktop app analytics</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/segment" style="color:var(--text)">Segment</a></td>
        <td>Data Infra</td>
        <td>$50K credits (startup)</td>
        <td>No</td>
        <td>Customer data platform, 300+ integrations</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/openreplay-com" style="color:var(--text)">OpenReplay</a></td>
        <td>Session Replay</td>
        <td>\u221e (self-hosted)</td>
        <td>Yes</td>
        <td>Self-hosted session replay alternative</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">PostHog leads on value with 1M events/month free including session replays, feature flags, and A/B testing \u2014 the most complete free analytics package. Amplitude matches on event volume (10M) but caps at 10K monthly tracked users. For privacy-first web analytics, Plausible and Umami are both self-hostable with no limits. Microsoft Clarity is uniquely free with no caps on session replay. All limits verified against live pricing pages, March 2026.</p>

  <h2>Which Free Analytics Tool Should I Use?</h2>
  <div class="decision-guide">
    <dl>
      <dt>Need an all-in-one product analytics suite?</dt>
      <dd><a href="/vendor/posthog">PostHog</a> \u2014 1M events/month free with session replays, feature flags, A/B testing, and error tracking. Open-source and self-hostable. The most complete free product analytics platform.</dd>

      <dt>Want enterprise-grade product analytics?</dt>
      <dd><a href="/vendor/amplitude">Amplitude</a> \u2014 10M events and 10K MTU on the free Starter plan with unlimited feature flags and 1-year retention. Best for teams that need deep funnel and cohort analysis.</dd>

      <dt>Looking for a privacy-first Google Analytics alternative?</dt>
      <dd><a href="/vendor/plausible-analytics">Plausible</a> for a sub-1KB script with no cookies (AGPL, self-hostable). <a href="/vendor/umami">Umami</a> for MIT-licensed simplicity. <a href="/vendor/goatcounter">GoatCounter</a> for 100K pageviews/month free hosted.</dd>

      <dt>Need free session replay and heatmaps?</dt>
      <dd><a href="/vendor/microsoft-clarity">Microsoft Clarity</a> \u2014 completely free with no session limits, heatmaps, and rage-click detection. <a href="/vendor/hotjar">Hotjar</a> adds surveys and feedback but caps at 35 daily sessions. <a href="/vendor/openreplay-com">OpenReplay</a> for self-hosted.</dd>

      <dt>Building a mobile or desktop app?</dt>
      <dd><a href="/vendor/aptabase">Aptabase</a> \u2014 privacy-friendly analytics with SDKs for Swift, Kotlin, React Native, Flutter, and Electron. 20K events/month free. <a href="/vendor/appfit">AppFit</a> for cross-platform analytics with product journal.</dd>

      <dt>Need a customer data platform?</dt>
      <dd><a href="/vendor/segment">Segment</a> \u2014 $50K in credits for startups, connecting 300+ integrations. <a href="/vendor/census">Census</a> for reverse ETL from your data warehouse to 60+ SaaS tools.</dd>

      <dt>Want real-time analytics APIs?</dt>
      <dd><a href="/vendor/tinybird">Tinybird</a> \u2014 10 GB storage and 10 QPS free for building real-time analytics endpoints over SQL. Great for dashboards, usage tracking, and product metrics APIs.</dd>

      <dt>Just need simple, lightweight tracking?</dt>
      <dd><a href="/vendor/counter-dev">counter.dev</a> for the simplest possible web analytics (free or pay-what-you-want). <a href="/vendor/beampipe-io">Beampipe.io</a> for 5 domains and 10K pageviews. <a href="/vendor/getinsights-io">getinsights.io</a> for 3K events/month, cookie-free.</dd>
    </dl>
  </div>

  <div class="search-cta">
    <p>Looking for more? Browse all <a href="/category/analytics">Analytics</a> tools in our full index of ${offers.length.toLocaleString()}+ developer deals.</p>
  </div>

  ${buildMoreAlternativesGuides(slug)}

  ${buildMcpCta("Get analytics tool recommendations from your AI assistant. Compare product analytics, web analytics, and session replay tools \u2014 directly in your editor.")}
  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
<script>${mcpCtaScript()}</script>
</body>
</html>`;
}

function buildAiMlAlternativesPage(): string {
  const title = "Best Free AI & ML Tools for Developers in 2026 — LLM APIs, AI Coding, Training & Observability Compared";
  const metaDesc = "Compare 65+ free AI/ML tools — Groq, Cerebras, OpenAI, Hugging Face, GitHub Copilot, Cursor, Langfuse, and more. Exact free tier limits by AI domain. Updated March 2026.";
  const slug = "ai-ml-alternatives";

  // Get all AI/ML and AI Coding offers
  const aiOffers = offers.filter(o => o.category === "AI / ML" || o.category === "AI Coding");
  const enrichedAll = enrichOffers(aiOffers);
  const riskColors: Record<string, string> = { stable: "#3fb950", caution: "#d29922", risky: "#f85149" };

  // Group by AI domain
  const llmApis = enrichedAll.filter(o =>
    ["OpenAI", "Anthropic API", "Google Gemini API", "Mistral AI", "Groq", "Cerebras", "Cohere", "xAI", "OpenRouter", "Cloudflare Workers AI", "Pollinations.AI", "Mediaworkbench.ai", "Lumenfall.ai"].includes(o.vendor)
  );
  const aiCoding = enrichedAll.filter(o =>
    ["GitHub Copilot", "Cursor", "Claude Code", "Amazon Q Developer", "Windsurf", "Cline", "Aider", "Devin", "Bolt.new", "Lovable", "Augment Code", "Google Antigravity", "Gemini CLI", "OpenAI Codex"].includes(o.vendor)
  );
  const mlPlatforms = enrichedAll.filter(o =>
    ["Hugging Face", "Kaggle", "Replicate", "Baseten", "Vast.ai", "paperspace", "Weights & Biases", "Comet ML", "Neptune.ai"].includes(o.vendor)
  );
  const aiObservability = enrichedAll.filter(o =>
    ["Langfuse", "LangWatch", "Langtrace", "Arize AI", "Arize AX", "Braintrust", "Maxim AI", "Keywords AI", "Portkey", "Composio", "Zenable"].includes(o.vendor)
  );
  const specializedAi = enrichedAll.filter(o =>
    ["Deepgram", "AssemblyAI", "Roboflow", "Scale AI", "Clarifai", "Labelbox", "Pinecone", "Qdrant", "OCR.Space", "Parseur", "Reducto", "Tavily AI", "wolfram.com", "DeepAR", "Audio Enhancer", "Clair", "Othor AI", "ReportGPT"].includes(o.vendor)
  );
  const other = enrichedAll.filter(o =>
    !llmApis.includes(o) && !aiCoding.includes(o) && !mlPlatforms.includes(o) && !aiObservability.includes(o) && !specializedAi.includes(o)
  );

  // Build cards helper
  const buildCards = (items: ReturnType<typeof enrichOffers>) => items.map(o => {
    const riskBadge = o.risk_level ? `<span style="display:inline-block;font-size:.7rem;padding:.15rem .5rem;border-radius:10px;background:${riskColors[o.risk_level]}22;color:${riskColors[o.risk_level]};font-weight:600;margin-left:.5rem">${o.risk_level}</span>` : "";
    return `<div class="alt-card">
        <div class="alt-card-header">
          <a href="/vendor/${toSlug(o.vendor)}" class="alt-card-name">${escHtmlServer(o.vendor)}</a>
          <span class="alt-card-tier">${escHtmlServer(o.tier)}</span>
          ${riskBadge}
        </div>
        <p class="alt-card-desc">${escHtmlServer(o.description)}</p>
        <div class="alt-card-links">
          <a href="/vendor/${toSlug(o.vendor)}">Full profile</a>
          <a href="/alternative-to/${toSlug(o.vendor)}">Alternatives</a>
          <a href="${escHtmlServer(o.url)}" target="_blank" rel="noopener">Pricing &nearr;</a>
        </div>
      </div>`;
  }).join("\n");

  // AI deal changes
  const aiChangeVendors = ["OpenAI", "Anthropic", "Google Gemini", "Mistral", "Groq", "GitHub Copilot", "Cursor", "Windsurf", "Cerebras"];
  const aiChanges = dealChanges.filter(c => aiChangeVendors.some(v => c.vendor.includes(v)));
  const changesHtml = aiChanges.length > 0 ? `
  <div class="context-box" style="border-left:3px solid ${riskColors.caution}">
    <div style="font-weight:600;color:${riskColors.caution};margin-bottom:.5rem">Recent AI/ML Pricing Changes</div>
    <ul style="margin:0;padding-left:1.25rem;font-size:.9rem;color:var(--text-muted);line-height:1.8">
      ${aiChanges.slice(0, 8).map(c => `<li><strong>${escHtmlServer(c.vendor)}</strong>: ${escHtmlServer(c.summary.length > 120 ? c.summary.substring(0, 117) + "..." : c.summary)}</li>`).join("\n      ")}
    </ul>
    <p style="margin:.75rem 0 0;font-size:.8rem"><a href="/changes">View all ${dealChanges.length} pricing changes &rarr;</a></p>
  </div>` : "";

  // JSON-LD
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: title,
    description: metaDesc,
    numberOfItems: aiOffers.length,
    itemListElement: enrichedAll.slice(0, 30).map((o, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "SoftwareApplication",
        name: o.vendor,
        description: o.description,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: o.tier },
        url: o.url,
      },
    })),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)} — AgentDeals</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/${slug}">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/${slug}">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
h2{font-family:var(--serif);font-size:1.4rem;color:var(--text);margin:2.5rem 0 1rem;letter-spacing:-.01em}
h3{font-family:var(--serif);font-size:1.1rem;color:var(--text);margin:1.5rem 0 .5rem}
.context{color:var(--text-muted);margin-bottom:1.5rem;font-size:.95rem;line-height:1.7}
.context strong{color:var(--text)}
.context-box{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1rem 1.25rem;margin:1.5rem 0;font-size:.9rem;color:var(--text-muted)}
.alt-card{padding:1.25rem;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;background:var(--bg-card);margin-bottom:.75rem;transition:border-color .2s}
.alt-card:hover{border-color:var(--accent)}
.alt-card-header{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem}
.alt-card-name{font-size:1.1rem;font-weight:600;color:var(--text)}
.alt-card-name:hover{color:var(--accent)}
.alt-card-tier{font-family:var(--mono);color:var(--accent);font-size:.8rem;padding:.1rem .5rem;background:var(--accent-glow);border-radius:10px}
.alt-card-desc{color:var(--text-muted);font-size:.9rem;line-height:1.5;margin:.5rem 0}
.alt-card-links{display:flex;flex-wrap:wrap;gap:.75rem;font-size:.8rem;margin-top:.5rem}
.alt-card-links a{color:var(--accent);text-decoration:none}
.alt-card-links a:hover{text-decoration:underline}
.compare-table{width:100%;border-collapse:collapse;margin:1rem 0 2rem}
.compare-table th,.compare-table td{padding:.5rem .75rem;text-align:left;border-bottom:1px solid var(--border);font-size:.85rem}
.compare-table th{color:var(--text-muted);font-weight:500;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
.compare-table tr:hover{background:var(--accent-glow)}
.search-cta{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.25rem;margin:2rem 0;text-align:center;font-size:.9rem}
.decision-guide{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.5rem;margin:2rem 0}
.decision-guide dt{font-weight:600;color:var(--text);margin-top:1rem}
.decision-guide dt:first-child{margin-top:0}
.decision-guide dd{color:var(--text-muted);font-size:.9rem;margin:.25rem 0 0 0;line-height:1.6}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.compare-table{font-size:.75rem}.compare-table th,.compare-table td{padding:.4rem .5rem}}
${globalNavCss()}
${mcpCtaCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("alternatives")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; <a href="/alternatives">Alternatives</a> &rsaquo; Free AI &amp; ML Tools</div>
  <h1>Best Free AI &amp; ML Tools for Developers</h1>

  <div class="context">
    <p>AI infrastructure is evolving faster than any other developer tooling category. The good news: competition has driven generous free tiers. <strong>Groq</strong> offers blazing-fast Llama 3.3 70B inference at ~30 RPM free. <strong>Cerebras</strong> gives <strong>1M tokens/day</strong> free. <strong>Mistral</strong> offers access to all models including Large and Codestral at 1B tokens/month. And open-source tools like <strong>Cline</strong>, <strong>Aider</strong>, and <strong>Gemini CLI</strong> are completely free \u2014 just bring your own API key.</p>
    <p>This page compares every free AI and ML tool in our index \u2014 <strong>${aiOffers.length} tools</strong> across LLM APIs, AI coding assistants, ML platforms, observability, and specialized services. Whether you need an OpenAI alternative or a free AI coding assistant, we have the comparison with exact free tier limits.</p>
  </div>

  ${changesHtml}

  <h2>LLM API Providers</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Large language model APIs for text generation, embeddings, and more. These are the foundational building blocks for AI applications \u2014 from GPT-4 and Claude to open-source models like Llama and Mistral.</p>
${buildCards(llmApis)}

  <h2>AI Coding Tools</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">AI-powered coding assistants, agents, and app builders. From inline autocomplete (GitHub Copilot, Cursor) to fully autonomous agents (Devin, Claude Code) and no-code app builders (Bolt.new, Lovable).</p>
${buildCards(aiCoding)}

  <h2>ML Platforms &amp; Infrastructure</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Model hosting, training, experiment tracking, and GPU compute. The infrastructure layer for building, training, and deploying custom ML models.</p>
${buildCards(mlPlatforms)}

  <h2>AI Observability &amp; Evaluation</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">LLM monitoring, prompt engineering, evaluation, and debugging tools. Essential for production AI applications \u2014 track costs, latency, quality, and catch regressions.</p>
${buildCards(aiObservability)}

  <h2>Specialized AI Services</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Speech-to-text, computer vision, vector databases, document parsing, and other domain-specific AI tools. These services handle specific AI tasks that general-purpose LLMs don't cover well.</p>
${buildCards(specializedAi)}

${other.length > 0 ? `
  <h2>Other AI &amp; ML Tools</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Additional AI and ML tools with free tiers.</p>
${buildCards(other)}
` : ""}

  <h2>Free AI &amp; ML Tools Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Top free AI/ML tools compared by domain, free tier limits, and best use case.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Service</th>
        <th>Domain</th>
        <th>Free Tier</th>
        <th>OSS</th>
        <th>Best For</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600"><a href="/vendor/groq" style="color:var(--text)">Groq</a></td>
        <td>LLM API</td>
        <td>~30 RPM, Llama 3.3 70B</td>
        <td>No</td>
        <td>Fastest free LLM inference (LPU hardware)</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/cerebras" style="color:var(--text)">Cerebras</a></td>
        <td>LLM API</td>
        <td>1M tokens/day, 30 RPM</td>
        <td>No</td>
        <td>High-volume free inference, Llama &amp; Qwen</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/mistral-ai" style="color:var(--text)">Mistral AI</a></td>
        <td>LLM API</td>
        <td>1B tokens/mo, 2 RPM</td>
        <td>No</td>
        <td>Access to all Mistral models including Codestral</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/openrouter" style="color:var(--text)">OpenRouter</a></td>
        <td>LLM API</td>
        <td>~30 free models, ~20 RPM</td>
        <td>No</td>
        <td>Multi-model router, OpenAI-compatible API</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/github-copilot" style="color:var(--text)">GitHub Copilot</a></td>
        <td>AI Coding</td>
        <td>2,000 completions/mo, 50 chats</td>
        <td>No</td>
        <td>Inline code completion in any IDE</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/cursor" style="color:var(--text)">Cursor</a></td>
        <td>AI Coding</td>
        <td>2,000 completions, 50 requests</td>
        <td>No</td>
        <td>AI-native code editor with Composer</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/gemini-cli" style="color:var(--text)">Gemini CLI</a></td>
        <td>AI Coding</td>
        <td>1,000 req/day, 60 RPM</td>
        <td>Yes</td>
        <td>Free terminal AI agent, open-source</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/hugging-face" style="color:var(--text)">Hugging Face</a></td>
        <td>ML Platform</td>
        <td>Free inference, unlimited hosting</td>
        <td>Yes</td>
        <td>Model hub, 200+ inference providers</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/kaggle" style="color:var(--text)">Kaggle</a></td>
        <td>ML Platform</td>
        <td>30 hrs/week GPU, 20 hrs TPU</td>
        <td>No</td>
        <td>Free GPU compute for ML training</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/langfuse" style="color:var(--text)">Langfuse</a></td>
        <td>Observability</td>
        <td>50K observations/mo</td>
        <td>Yes</td>
        <td>Open-source LLM observability &amp; tracing</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/deepgram" style="color:var(--text)">Deepgram</a></td>
        <td>Speech AI</td>
        <td>$200 free credits (~43K min)</td>
        <td>No</td>
        <td>Speech-to-text and text-to-speech API</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/pinecone" style="color:var(--text)">Pinecone</a></td>
        <td>Vector DB</td>
        <td>2 GB storage, 5 indexes</td>
        <td>No</td>
        <td>Managed vector database for RAG/search</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">Groq and Cerebras lead on free LLM inference volume \u2014 Groq for speed (LPU), Cerebras for daily token quota (1M/day). Mistral offers the broadest model access on free tier (all models including Large). For AI coding, GitHub Copilot and Cursor both offer 2,000 free completions/month, while Gemini CLI is completely free and open-source. Langfuse is the standout for LLM observability (open-source, 50K observations free). All limits verified against live pricing pages, March 2026.</p>

  <h2>Which Free AI Tool Should I Use?</h2>
  <div class="decision-guide">
    <dl>
      <dt>Need fast, free LLM API access?</dt>
      <dd><a href="/vendor/groq">Groq</a> \u2014 ultra-fast inference on LPU hardware with Llama 3.3 70B, ~30 RPM free. <a href="/vendor/cerebras">Cerebras</a> \u2014 1M tokens/day free, great for batch workloads. <a href="/vendor/openrouter">OpenRouter</a> for access to ~30 free models through one API.</dd>

      <dt>Want access to all frontier models?</dt>
      <dd><a href="/vendor/mistral-ai">Mistral AI</a> \u2014 all models including Large and Codestral, 1B tokens/month free at 2 RPM. Best free access to frontier-class models without credit card.</dd>

      <dt>Looking for an AI coding assistant?</dt>
      <dd><a href="/vendor/github-copilot">GitHub Copilot</a> for IDE-integrated autocomplete (2,000/mo free). <a href="/vendor/cursor">Cursor</a> for an AI-native editor. <a href="/vendor/gemini-cli">Gemini CLI</a> and <a href="/vendor/cline">Cline</a> for free open-source terminal agents (BYOK).</dd>

      <dt>Building an AI app and need observability?</dt>
      <dd><a href="/vendor/langfuse">Langfuse</a> \u2014 open-source LLM tracing, 50K observations/month free. <a href="/vendor/langwatch">LangWatch</a> for monitoring and optimization. <a href="/vendor/braintrust">Braintrust</a> for evals with 1,000 rows/week free.</dd>

      <dt>Need free GPU compute for ML training?</dt>
      <dd><a href="/vendor/kaggle">Kaggle</a> \u2014 30 hrs/week GPU (Tesla T4) and 20 hrs/week TPU, completely free. <a href="/vendor/paperspace">Paperspace</a> for free notebooks with basic instances. <a href="/vendor/vast-ai">Vast.ai</a> startup program for $2,500 in GPU credits.</dd>

      <dt>Want to host or deploy ML models?</dt>
      <dd><a href="/vendor/hugging-face">Hugging Face</a> \u2014 free model hosting, inference API with 200+ providers. <a href="/vendor/replicate">Replicate</a> for free runs on curated models. <a href="/vendor/baseten">Baseten</a> for $30 in deployment credits.</dd>

      <dt>Need speech-to-text or computer vision?</dt>
      <dd><a href="/vendor/deepgram">Deepgram</a> \u2014 $200 free credits for speech AI (~43K minutes). <a href="/vendor/assemblyai">AssemblyAI</a> \u2014 $50 credits (~185 hours). <a href="/vendor/roboflow">Roboflow</a> for computer vision with 250K images free.</dd>

      <dt>Looking for a vector database for RAG?</dt>
      <dd><a href="/vendor/pinecone">Pinecone</a> \u2014 2 GB storage and 5 indexes free. <a href="/vendor/qdrant">Qdrant</a> \u2014 1 GB free forever cluster, fully managed. Both excellent for retrieval-augmented generation.</dd>
    </dl>
  </div>

  <div class="search-cta">
    <p>Looking for more? Browse all <a href="/category/ai-ml">AI / ML</a> and <a href="/category/ai-coding">AI Coding</a> tools in our full index of ${offers.length.toLocaleString()}+ developer deals.</p>
  </div>

  ${buildMoreAlternativesGuides(slug)}

  ${buildMcpCta("Get AI tool recommendations from your AI assistant. Compare LLM APIs, coding tools, and ML platforms \u2014 directly in your editor.")}
  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
<script>${mcpCtaScript()}</script>
</body>
</html>`;
}

function buildEmailAlternativesPage(): string {
  const title = "Best Free Email Tools for Developers in 2026 — Transactional APIs, Marketing Platforms & Email Infrastructure Compared";
  const metaDesc = "Compare 59+ free email tools — Resend, Brevo, Mailjet, SendGrid, Mailchimp, SimpleLogin, Proton Mail, and more. Exact free tier limits by email domain. Updated March 2026.";
  const slug = "email-alternatives";

  // Get all Email offers
  const emailOffers = offers.filter(o => o.category === "Email");
  const enrichedAll = enrichOffers(emailOffers);
  const riskColors: Record<string, string> = { stable: "#3fb950", caution: "#d29922", risky: "#f85149" };

  // Group by email domain
  const transactionalApis = enrichedAll.filter(o =>
    ["Resend", "Postmark", "MailerSend.com", "Mailtrap.io", "Mailjet", "AhaSend", "EmailLabs.io", "mailchannels.com", "Sweego", "Maileroo", "SendStreak", "Plunk"].includes(o.vendor)
  );
  const marketingNewsletter = enrichedAll.filter(o =>
    ["Brevo", "Mailchimp", "EmailOctopus", "MailerLite.com", "Buttondown", "Loops", "Sendpulse", "Maildroppa", "Substack", "Zoho Campaigns", "Wraps"].includes(o.vendor)
  );
  const verificationDeliverability = enrichedAll.filter(o =>
    ["Verifalia", "Emailvalidation.io", "verimail.io", "Antideo", "mail-tester.com", "dkimvalidator.com", "Mailcheck.ai", "TempMailDetector.com"].includes(o.vendor)
  );
  const forwardingAliases = enrichedAll.filter(o =>
    ["SimpleLogin", "AnonAddy", "forwardemail.net", "ImprovMX", "Bump", "Burnermail", "Mutant Mail", "DNSExit", "trashmail.com"].includes(o.vendor)
  );
  const temporaryTesting = enrichedAll.filter(o =>
    ["mailsac.com", "10minutemail", "inboxkitten.com", "mailinator.com", "temp-mail.io", "EtherealMail", "debugmail.io", "mailcatcher.me", "Imitate Email", "Inboxes App"].includes(o.vendor)
  );
  const securePrivacy = enrichedAll.filter(o =>
    ["Proton Mail", "Tuta"].includes(o.vendor)
  );
  const otherEmailTools = enrichedAll.filter(o =>
    ["Parsio.io", "EmailJS", "Contact.do", "Waitlio", "Prospect.io", "SendGrid", "SendGrid Accelerate"].includes(o.vendor)
  );
  const other = enrichedAll.filter(o =>
    !transactionalApis.includes(o) && !marketingNewsletter.includes(o) && !verificationDeliverability.includes(o) && !forwardingAliases.includes(o) && !temporaryTesting.includes(o) && !securePrivacy.includes(o) && !otherEmailTools.includes(o)
  );

  // Build cards helper
  const buildCards = (items: ReturnType<typeof enrichOffers>) => items.map(o => {
    const riskBadge = o.risk_level ? `<span style="display:inline-block;font-size:.7rem;padding:.15rem .5rem;border-radius:10px;background:${riskColors[o.risk_level]}22;color:${riskColors[o.risk_level]};font-weight:600;margin-left:.5rem">${o.risk_level}</span>` : "";
    return `<div class="alt-card">
        <div class="alt-card-header">
          <a href="/vendor/${toSlug(o.vendor)}" class="alt-card-name">${escHtmlServer(o.vendor)}</a>
          <span class="alt-card-tier">${escHtmlServer(o.tier)}</span>
          ${riskBadge}
        </div>
        <p class="alt-card-desc">${escHtmlServer(o.description)}</p>
        <div class="alt-card-links">
          <a href="/vendor/${toSlug(o.vendor)}">Full profile</a>
          <a href="/alternative-to/${toSlug(o.vendor)}">Alternatives</a>
          <a href="${escHtmlServer(o.url)}" target="_blank" rel="noopener">Pricing &nearr;</a>
        </div>
      </div>`;
  }).join("\n");

  // Email deal changes
  const emailChangeVendors = ["SendGrid", "Mailchimp", "Resend", "Brevo", "Postmark", "Mailjet"];
  const emailChanges = dealChanges.filter(c => emailChangeVendors.some(v => c.vendor.includes(v)));
  const changesHtml = emailChanges.length > 0 ? `
  <div class="context-box" style="border-left:3px solid ${riskColors.caution}">
    <div style="font-weight:600;color:${riskColors.caution};margin-bottom:.5rem">Recent Email Tool Pricing Changes</div>
    <ul style="margin:0;padding-left:1.25rem;font-size:.9rem;color:var(--text-muted);line-height:1.8">
      ${emailChanges.slice(0, 8).map(c => `<li><strong>${escHtmlServer(c.vendor)}</strong>: ${escHtmlServer(c.summary.length > 120 ? c.summary.substring(0, 117) + "..." : c.summary)}</li>`).join("\n      ")}
    </ul>
    <p style="margin:.75rem 0 0;font-size:.8rem"><a href="/changes">View all ${dealChanges.length} pricing changes &rarr;</a></p>
  </div>` : "";

  // JSON-LD
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: title,
    description: metaDesc,
    numberOfItems: emailOffers.length,
    itemListElement: enrichedAll.slice(0, 30).map((o, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "SoftwareApplication",
        name: o.vendor,
        description: o.description,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: o.tier },
        url: o.url,
      },
    })),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)} — AgentDeals</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/${slug}">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/${slug}">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
h2{font-family:var(--serif);font-size:1.4rem;color:var(--text);margin:2.5rem 0 1rem;letter-spacing:-.01em}
h3{font-family:var(--serif);font-size:1.1rem;color:var(--text);margin:1.5rem 0 .5rem}
.context{color:var(--text-muted);margin-bottom:1.5rem;font-size:.95rem;line-height:1.7}
.context strong{color:var(--text)}
.context-box{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1rem 1.25rem;margin:1.5rem 0;font-size:.9rem;color:var(--text-muted)}
.alt-card{padding:1.25rem;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;background:var(--bg-card);margin-bottom:.75rem;transition:border-color .2s}
.alt-card:hover{border-color:var(--accent)}
.alt-card-header{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem}
.alt-card-name{font-size:1.1rem;font-weight:600;color:var(--text)}
.alt-card-name:hover{color:var(--accent)}
.alt-card-tier{font-family:var(--mono);color:var(--accent);font-size:.8rem;padding:.1rem .5rem;background:var(--accent-glow);border-radius:10px}
.alt-card-desc{color:var(--text-muted);font-size:.9rem;line-height:1.5;margin:.5rem 0}
.alt-card-links{display:flex;flex-wrap:wrap;gap:.75rem;font-size:.8rem;margin-top:.5rem}
.alt-card-links a{color:var(--accent);text-decoration:none}
.alt-card-links a:hover{text-decoration:underline}
.compare-table{width:100%;border-collapse:collapse;margin:1rem 0 2rem}
.compare-table th,.compare-table td{padding:.5rem .75rem;text-align:left;border-bottom:1px solid var(--border);font-size:.85rem}
.compare-table th{color:var(--text-muted);font-weight:500;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
.compare-table tr:hover{background:var(--accent-glow)}
.search-cta{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.25rem;margin:2rem 0;text-align:center;font-size:.9rem}
.decision-guide{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.5rem;margin:2rem 0}
.decision-guide dt{font-weight:600;color:var(--text);margin-top:1rem}
.decision-guide dt:first-child{margin-top:0}
.decision-guide dd{color:var(--text-muted);font-size:.9rem;margin:.25rem 0 0 0;line-height:1.6}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.compare-table{font-size:.75rem}.compare-table th,.compare-table td{padding:.4rem .5rem}}
${globalNavCss()}
${mcpCtaCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("alternatives")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; <a href="/alternatives">Alternatives</a> &rsaquo; Free Email Tools</div>
  <h1>Best Free Email Tools for Developers</h1>

  <div class="context">
    <p>Email infrastructure is one of the most fragmented developer tool categories. <strong>SendGrid</strong> slashed its free tier to just 100 emails/day. <strong>Mailgun</strong> eliminated free access entirely. But the alternatives have never been better — <strong>Resend</strong> offers 3,000 emails/month with a modern developer experience, <strong>Brevo</strong> provides 300/day with unlimited contacts, and <strong>Mailjet</strong> gives you 6,000/month.</p>
    <p>This page compares every free email tool in our index — <strong>${emailOffers.length} tools</strong> across transactional APIs, marketing platforms, verification services, forwarding/alias tools, and more. Whether you need a SendGrid alternative or free email aliases for privacy, we have the comparison with exact free tier limits.</p>
  </div>

  ${changesHtml}

  <h2>Transactional Email APIs</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">APIs for sending transactional email — password resets, welcome emails, receipts, and notifications. Resend leads with a modern developer experience and React Email templates. Mailjet offers the highest free volume at 6,000/month.</p>
${buildCards(transactionalApis)}

  <h2>Email Marketing &amp; Newsletter Platforms</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Platforms for email marketing campaigns, newsletters, and subscriber management. Brevo offers 300 emails/day with unlimited contacts and automation. Substack provides unlimited free newsletters with built-in monetization.</p>
${buildCards(marketingNewsletter)}

  <h2>Email Verification &amp; Deliverability</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Tools for verifying email addresses, checking DKIM/SPF records, and improving deliverability. Essential for maintaining sender reputation and reducing bounces.</p>
${buildCards(verificationDeliverability)}

  <h2>Email Forwarding &amp; Aliases</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Email forwarding services and alias generators for privacy. SimpleLogin (ProtonMail-owned) and AnonAddy are both open source and let you create unlimited aliases to protect your real email address.</p>
${buildCards(forwardingAliases)}

  <h2>Temporary &amp; Testing Email</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Disposable email addresses and email testing tools for development. Mailtrap provides an email sandbox for QA. EtherealMail generates fake SMTP credentials for testing without sending real emails.</p>
${buildCards(temporaryTesting)}

  <h2>Secure &amp; Privacy Email</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">End-to-end encrypted email providers focused on privacy. Proton Mail and Tuta offer free tiers with full encryption — no ads, no tracking.</p>
${buildCards(securePrivacy)}

  <h2>Other Email Tools</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Email parsing, form-to-email services, waitlist tools, and other email utilities.</p>
${buildCards(otherEmailTools)}

${other.length > 0 ? `
  <h2>More Email Tools</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Additional email tools with free tiers.</p>
${buildCards(other)}
` : ""}

  <h2>Free Email Tools Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Top free email tools compared by domain, free tier limits, and best use case.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Service</th>
        <th>Domain</th>
        <th>Free Tier</th>
        <th>OSS</th>
        <th>Best For</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600"><a href="/vendor/resend" style="color:var(--text)">Resend</a></td>
        <td>Transactional API</td>
        <td>3K emails/mo</td>
        <td>No</td>
        <td>Developer-first transactional email with React templates</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/brevo" style="color:var(--text)">Brevo</a></td>
        <td>Marketing</td>
        <td>300 emails/day, 100K contacts</td>
        <td>No</td>
        <td>All-in-one marketing with email, SMS, and automation</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/mailjet" style="color:var(--text)">Mailjet</a></td>
        <td>Transactional API</td>
        <td>6,000 emails/mo (200/day)</td>
        <td>No</td>
        <td>High-volume transactional with EU data residency</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/sendgrid" style="color:var(--text)">SendGrid</a></td>
        <td>Transactional API</td>
        <td>100 emails/day</td>
        <td>No</td>
        <td>Industry standard, extensive integrations</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/mailchimp" style="color:var(--text)">Mailchimp</a></td>
        <td>Marketing</td>
        <td>500 sends/month, 250 contacts</td>
        <td>No</td>
        <td>Marketing CRM with landing pages and automations</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/postmark" style="color:var(--text)">Postmark</a></td>
        <td>Transactional API</td>
        <td>100 emails/mo</td>
        <td>No</td>
        <td>Fastest delivery, no credit card required</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/simplelogin" style="color:var(--text)">SimpleLogin</a></td>
        <td>Forwarding</td>
        <td>10 aliases, open source</td>
        <td>Yes</td>
        <td>Email alias service, self-hostable, ProtonMail owned</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/substack" style="color:var(--text)">Substack</a></td>
        <td>Newsletter</td>
        <td>Unlimited subscribers</td>
        <td>No</td>
        <td>Newsletter platform with built-in monetization</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/proton-mail" style="color:var(--text)">Proton Mail</a></td>
        <td>Secure Email</td>
        <td>1 GB storage, E2E encryption</td>
        <td>Yes</td>
        <td>Privacy-focused encrypted email</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/emailoctopus" style="color:var(--text)">EmailOctopus</a></td>
        <td>Marketing</td>
        <td>2,500 subscribers, 10K emails/mo</td>
        <td>No</td>
        <td>Simple email marketing with generous free tier</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/mailtrap-io" style="color:var(--text)">Mailtrap.io</a></td>
        <td>Testing/Transactional</td>
        <td>3,500 emails/mo</td>
        <td>No</td>
        <td>Email sandbox for testing + transactional sending</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/anonaddy" style="color:var(--text)">AnonAddy</a></td>
        <td>Forwarding</td>
        <td>Unlimited aliases, open source</td>
        <td>Yes</td>
        <td>Anonymous email forwarding, self-hostable</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">Resend leads the modern transactional email space with React Email integration and 3K emails/month free. Brevo offers the most generous marketing free tier with 300 emails/day and unlimited contacts. For privacy, SimpleLogin and AnonAddy are both open source with self-hosting options. All limits verified against live pricing pages, March 2026.</p>

  <h2>Which Free Email Tool Should I Use?</h2>
  <div class="decision-guide">
    <dl>
      <dt>Need transactional email for your app?</dt>
      <dd><a href="/vendor/resend">Resend</a> — 3K/mo with React Email templates. <a href="/vendor/mailjet">Mailjet</a> — 6K/mo with EU data residency. <a href="/vendor/mailersend-com">MailerSend</a> — 3K/mo. See our <a href="/email-service-alternatives">email service deep comparison</a> for more.</dd>

      <dt>Running an email newsletter?</dt>
      <dd><a href="/vendor/substack">Substack</a> — unlimited free subscribers with built-in monetization. <a href="/vendor/buttondown">Buttondown</a> — 100 subscribers free. <a href="/vendor/emailoctopus">EmailOctopus</a> — 2,500 subscribers, 10K emails/mo.</dd>

      <dt>Need email marketing with automation?</dt>
      <dd><a href="/vendor/brevo">Brevo</a> — 300/day, unlimited contacts, full automation. <a href="/vendor/mailchimp">Mailchimp</a> — 250 contacts with landing pages. <a href="/vendor/loops">Loops</a> — 1,000 contacts, modern UI built for SaaS.</dd>

      <dt>Want to protect your inbox with aliases?</dt>
      <dd><a href="/vendor/simplelogin">SimpleLogin</a> — 10 aliases, open source, ProtonMail-owned. <a href="/vendor/anonaddy">AnonAddy</a> — unlimited aliases, open source, self-hostable. <a href="/vendor/improvmx">ImprovMX</a> — 25 aliases for custom domains.</dd>

      <dt>Need email verification/validation?</dt>
      <dd><a href="/vendor/verifalia">Verifalia</a> — 25/day real-time verification. <a href="/vendor/emailvalidation-io">Emailvalidation.io</a> — 100/mo. <a href="/vendor/mail-tester-com">mail-tester.com</a> — test your DNS/SPF/DKIM configuration.</dd>

      <dt>Testing email in development?</dt>
      <dd><a href="/vendor/mailtrap-io">Mailtrap.io</a> — email sandbox for QA plus transactional sending. <a href="/vendor/etherealmail">EtherealMail</a> — fake SMTP for testing. <a href="/vendor/mailsac-com">mailsac.com</a> — 1,500 API calls/mo.</dd>

      <dt>Want secure, encrypted email?</dt>
      <dd><a href="/vendor/proton-mail">Proton Mail</a> — 1 GB storage, end-to-end encryption, Swiss privacy. <a href="/vendor/tuta">Tuta</a> — 1 GB, open source option, based in Germany.</dd>

      <dt>Need temporary/disposable email?</dt>
      <dd><a href="/vendor/10minutemail">10minutemail</a> — self-destructing email addresses. <a href="/vendor/mailinator-com">mailinator.com</a> — public inboxes for testing. <a href="/vendor/inboxkitten-com">inboxkitten.com</a> — 3-day auto-delete.</dd>
    </dl>
  </div>

  <div class="search-cta">
    <p>Looking for more? Browse all <a href="/category/email">Email</a> tools in our full index of ${offers.length.toLocaleString()}+ developer deals.</p>
  </div>

  ${buildMoreAlternativesGuides(slug)}

  ${buildMcpCta("Get email tool recommendations from your AI assistant. Compare transactional APIs, marketing platforms, and email infrastructure — directly in your editor.")}
  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
<script>${mcpCtaScript()}</script>
</body>
</html>`;
}

function buildDesignAlternativesPage(): string {
  const title = "Best Free Design Tools for Developers in 2026 — UI Kits, Prototyping, Icons & Assets Compared";
  const metaDesc = "Compare 100+ free design tools — Figma, Penpot, Canva, ShadcnUI, Lucide, Unsplash, Coolors, and more. Exact free tier limits by design domain. Updated March 2026.";
  const slug = "design-alternatives";

  // Get all Design offers
  const designOffers = offers.filter(o => o.category === "Design");
  const enrichedAll = enrichOffers(designOffers);
  const riskColors: Record<string, string> = { stable: "#3fb950", caution: "#d29922", risky: "#f85149" };

  // Group by design domain
  const designEditors = enrichedAll.filter(o =>
    ["Figma", "Canva", "Penpot", "Lunacy", "Pixlr", "photopea.com", "Excalidraw", "vectr.com", "BoxySVG", "Pixelixe"].includes(o.vendor)
  );
  const prototyping = enrichedAll.filter(o =>
    ["Webflow", "framer.com", "Proto.io", "Plasmic", "Webstudio", "Quant Ux", "TeleportHQ", "Unicorn Platform", "landen.co", "Grapedrop", "marvelapp.com", "Octopus.do", "Updrafts.app", "walkme.com"].includes(o.vendor)
  );
  const uiComponents = enrichedAll.filter(o =>
    ["ShadcnUI", "DaisyUI", "NextUI", "Float UI", "HyperUI", "TW Elements", "Tailkits", "MDBootstrap", "Flyon UI", "Tailark", "Tailwindadmin", "Tailcolors", "Shadcn Space", "Shadcn Studio", "tweakcn", "CodedThemes", "CodeMyUI", "Ant Design Landing Page", "Backlight", "Wdrfree SVG"].includes(o.vendor)
  );
  const iconsIllustrations = enrichedAll.filter(o =>
    ["Lucide", "Iconoir", "tabler-icons.io", "iconify.design", "Circum Icons", "unDraw", "storyset.com", "LottieFiles", "Rive", "Glyphs", "Icon Horse", "Logo.dev", "Calendar Icons Generator", "movingpencils.com", "NSPolygon", "Mossaik"].includes(o.vendor)
  );
  const stockAssets = enrichedAll.filter(o =>
    ["unsplash.com", "pexels.com", "Nappy", "AllTheFreeStock", "freeforcommercialuse.net", "Lorem Picsum", "lensdump.com", "Mastershot", "Pravatar", "UI Avatars", "Image BG Blurer", "clevebrush.com", "Carousel Hero", "Volume", "Superdesigner", "MagicPattern", "haikei.app"].includes(o.vendor)
  );
  const colorCssTools = enrichedAll.filter(o =>
    ["coolors", "ColorKit", "OKLCH", "css-gradient.com", "css.glass", "hypercolor.dev", "Gradientos", "colorr.me", "CMYK Pantone", "Branition", "Flows", "Scrollbar.app"].includes(o.vendor)
  );
  const mockupsWireframing = enrichedAll.filter(o =>
    ["Zeplin", "Mockplus iDoc", "smartmockups.com", "mockupmark.com", "whimsical.com", "okso.app", "Mindmup.com", "userforge.com", "Responsively App"].includes(o.vendor)
  );
  const conversionTools = enrichedAll.filter(o =>
    ["PNG to WebP Converter", "SVG Converter", "Vertopal", "cloudconvert.com", "vector.express", "resizeappicon.com"].includes(o.vendor)
  );
  const other = enrichedAll.filter(o =>
    !designEditors.includes(o) && !prototyping.includes(o) && !uiComponents.includes(o) && !iconsIllustrations.includes(o) && !stockAssets.includes(o) && !colorCssTools.includes(o) && !mockupsWireframing.includes(o) && !conversionTools.includes(o)
  );

  // Build cards helper
  const buildCards = (items: ReturnType<typeof enrichOffers>) => items.map(o => {
    const riskBadge = o.risk_level ? `<span style="display:inline-block;font-size:.7rem;padding:.15rem .5rem;border-radius:10px;background:${riskColors[o.risk_level]}22;color:${riskColors[o.risk_level]};font-weight:600;margin-left:.5rem">${o.risk_level}</span>` : "";
    return `<div class="alt-card">
        <div class="alt-card-header">
          <a href="/vendor/${toSlug(o.vendor)}" class="alt-card-name">${escHtmlServer(o.vendor)}</a>
          <span class="alt-card-tier">${escHtmlServer(o.tier)}</span>
          ${riskBadge}
        </div>
        <p class="alt-card-desc">${escHtmlServer(o.description)}</p>
        <div class="alt-card-links">
          <a href="/vendor/${toSlug(o.vendor)}">Full profile</a>
          <a href="/alternative-to/${toSlug(o.vendor)}">Alternatives</a>
          <a href="${escHtmlServer(o.url)}" target="_blank" rel="noopener">Pricing &nearr;</a>
        </div>
      </div>`;
  }).join("\n");

  // Design deal changes
  const designChangeVendors = ["Figma", "Canva", "Penpot", "Webflow", "Framer", "Lucide"];
  const designChanges = dealChanges.filter(c => designChangeVendors.some(v => c.vendor.includes(v)));
  const changesHtml = designChanges.length > 0 ? `
  <div class="context-box" style="border-left:3px solid ${riskColors.caution}">
    <div style="font-weight:600;color:${riskColors.caution};margin-bottom:.5rem">Recent Design Tool Pricing Changes</div>
    <ul style="margin:0;padding-left:1.25rem;font-size:.9rem;color:var(--text-muted);line-height:1.8">
      ${designChanges.slice(0, 8).map(c => `<li><strong>${escHtmlServer(c.vendor)}</strong>: ${escHtmlServer(c.summary.length > 120 ? c.summary.substring(0, 117) + "..." : c.summary)}</li>`).join("\n      ")}
    </ul>
    <p style="margin:.75rem 0 0;font-size:.8rem"><a href="/changes">View all ${dealChanges.length} pricing changes &rarr;</a></p>
  </div>` : "";

  // JSON-LD
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: title,
    description: metaDesc,
    numberOfItems: designOffers.length,
    itemListElement: enrichedAll.slice(0, 30).map((o, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "SoftwareApplication",
        name: o.vendor,
        description: o.description,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: o.tier },
        url: o.url,
      },
    })),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)} — AgentDeals</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/${slug}">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/${slug}">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
h2{font-family:var(--serif);font-size:1.4rem;color:var(--text);margin:2.5rem 0 1rem;letter-spacing:-.01em}
h3{font-family:var(--serif);font-size:1.1rem;color:var(--text);margin:1.5rem 0 .5rem}
.context{color:var(--text-muted);margin-bottom:1.5rem;font-size:.95rem;line-height:1.7}
.context strong{color:var(--text)}
.context-box{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1rem 1.25rem;margin:1.5rem 0;font-size:.9rem;color:var(--text-muted)}
.alt-card{padding:1.25rem;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;background:var(--bg-card);margin-bottom:.75rem;transition:border-color .2s}
.alt-card:hover{border-color:var(--accent)}
.alt-card-header{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem}
.alt-card-name{font-size:1.1rem;font-weight:600;color:var(--text)}
.alt-card-name:hover{color:var(--accent)}
.alt-card-tier{font-family:var(--mono);color:var(--accent);font-size:.8rem;padding:.1rem .5rem;background:var(--accent-glow);border-radius:10px}
.alt-card-desc{color:var(--text-muted);font-size:.9rem;line-height:1.5;margin:.5rem 0}
.alt-card-links{display:flex;flex-wrap:wrap;gap:.75rem;font-size:.8rem;margin-top:.5rem}
.alt-card-links a{color:var(--accent);text-decoration:none}
.alt-card-links a:hover{text-decoration:underline}
.compare-table{width:100%;border-collapse:collapse;margin:1rem 0 2rem}
.compare-table th,.compare-table td{padding:.5rem .75rem;text-align:left;border-bottom:1px solid var(--border);font-size:.85rem}
.compare-table th{color:var(--text-muted);font-weight:500;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
.compare-table tr:hover{background:var(--accent-glow)}
.search-cta{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.25rem;margin:2rem 0;text-align:center;font-size:.9rem}
.decision-guide{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.5rem;margin:2rem 0}
.decision-guide dt{font-weight:600;color:var(--text);margin-top:1rem}
.decision-guide dt:first-child{margin-top:0}
.decision-guide dd{color:var(--text-muted);font-size:.9rem;margin:.25rem 0 0 0;line-height:1.6}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.compare-table{font-size:.75rem}.compare-table th,.compare-table td{padding:.4rem .5rem}}
${globalNavCss()}
${mcpCtaCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("alternatives")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; <a href="/alternatives">Alternatives</a> &rsaquo; Free Design Tools</div>
  <h1>Best Free Design Tools for Developers</h1>

  <div class="context">
    <p>Design tooling has become remarkably accessible. <strong>Figma</strong> offers a generous free Starter plan with unlimited files. <strong>Penpot</strong> is a fully open-source alternative with no limits on projects or components. And the Tailwind CSS ecosystem has spawned dozens of free UI component libraries \u2014 <strong>ShadcnUI</strong>, <strong>DaisyUI</strong>, and <strong>HyperUI</strong> give you production-ready components without a design tool at all.</p>
    <p>This page compares every free design tool in our index \u2014 <strong>${designOffers.length} tools</strong> across UI editors, prototyping platforms, component libraries, icon sets, stock assets, color tools, and more. Whether you need a Figma alternative or free icons for your next project, we have the comparison with exact free tier limits.</p>
  </div>

  ${changesHtml}

  <h2>Design Tools &amp; Editors</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Collaborative design tools, photo editors, and vector editors. From full-featured design platforms like Figma and Penpot to lightweight editors like Photopea and Excalidraw for quick mockups and diagrams.</p>
${buildCards(designEditors)}

  <h2>Prototyping &amp; No-Code Builders</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Build interactive prototypes and websites without code. Webflow and Framer lead with visual site builders, while Proto.io and Quant UX focus on app prototyping with user testing built in.</p>
${buildCards(prototyping)}

  <h2>UI Component Libraries</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Pre-built UI components for React, Tailwind CSS, and Bootstrap. Copy-paste component libraries that let you ship polished interfaces without touching a design tool \u2014 ShadcnUI for React, DaisyUI for Tailwind, MDBootstrap for Bootstrap.</p>
${buildCards(uiComponents)}

  <h2>Icons &amp; Illustrations</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Free icon sets, illustration packs, and animation libraries. Lucide and Tabler offer thousands of MIT-licensed SVG icons. LottieFiles and Rive provide free animation tools. unDraw and Storyset offer customizable illustrations.</p>
${buildCards(iconsIllustrations)}

  <h2>Stock Assets &amp; Images</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Free photos, backgrounds, and media assets for commercial use. Unsplash and Pexels lead with millions of royalty-free photos. Specialized tools like Haikei and MagicPattern generate unique SVG backgrounds and patterns.</p>
${buildCards(stockAssets)}

  <h2>Color &amp; CSS Tools</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Palette generators, gradient tools, and CSS utilities. Coolors generates beautiful color palettes. OKLCH provides perceptually uniform color picking. CSS Glass and Hypercolor offer ready-made gradient collections.</p>
${buildCards(colorCssTools)}

  <h2>Mockups &amp; Wireframing</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Design handoff, mockup generators, wireframing, and mind mapping tools. Zeplin bridges design-to-dev handoff. Whimsical combines wireframes, flowcharts, and mind maps. Responsively App previews responsive layouts across devices.</p>
${buildCards(mockupsWireframing)}

  <h2>File Conversion &amp; Image Tools</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Image format conversion, optimization, and file transformation utilities. Convert between PNG, WebP, SVG, and dozens of other formats \u2014 essential for optimizing web assets.</p>
${buildCards(conversionTools)}

${other.length > 0 ? `
  <h2>Other Design Tools</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Additional design tools with free tiers.</p>
${buildCards(other)}
` : ""}

  <h2>Free Design Tools Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Top free design tools compared by domain, free tier limits, and best use case.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Service</th>
        <th>Domain</th>
        <th>Free Tier</th>
        <th>OSS</th>
        <th>Best For</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600"><a href="/vendor/figma" style="color:var(--text)">Figma</a></td>
        <td>Design Editor</td>
        <td>Starter plan, unlimited files</td>
        <td>No</td>
        <td>Collaborative UI/UX design, industry standard</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/penpot" style="color:var(--text)">Penpot</a></td>
        <td>Design Editor</td>
        <td>Unlimited, self-hostable</td>
        <td>Yes</td>
        <td>Open-source Figma alternative, no vendor lock-in</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/webflow" style="color:var(--text)">Webflow</a></td>
        <td>No-Code</td>
        <td>2 projects, 1 GB bandwidth</td>
        <td>No</td>
        <td>Visual website builder with CMS and hosting</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/shadcnui" style="color:var(--text)">ShadcnUI</a></td>
        <td>Components</td>
        <td>Completely free, copy-paste</td>
        <td>Yes</td>
        <td>React + Tailwind component library, fully customizable</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/daisyui" style="color:var(--text)">DaisyUI</a></td>
        <td>Components</td>
        <td>Completely free</td>
        <td>Yes</td>
        <td>Tailwind CSS component library with themes</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/lucide" style="color:var(--text)">Lucide</a></td>
        <td>Icons</td>
        <td>1,500+ icons, MIT license</td>
        <td>Yes</td>
        <td>Beautiful SVG icon library, tree-shakable</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/unsplash-com" style="color:var(--text)">Unsplash</a></td>
        <td>Stock Photos</td>
        <td>Unlimited, royalty-free</td>
        <td>No</td>
        <td>High-quality stock photos for commercial use</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/coolors" style="color:var(--text)">Coolors</a></td>
        <td>Color Tools</td>
        <td>Unlimited palettes</td>
        <td>No</td>
        <td>Color palette generator and explorer</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/lottiefiles" style="color:var(--text)">LottieFiles</a></td>
        <td>Animation</td>
        <td>Free animations, 10 projects</td>
        <td>No</td>
        <td>Lightweight animations for web and mobile</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/excalidraw" style="color:var(--text)">Excalidraw</a></td>
        <td>Diagramming</td>
        <td>Completely free</td>
        <td>Yes</td>
        <td>Hand-drawn style diagrams and wireframes</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/whimsical-com" style="color:var(--text)">Whimsical</a></td>
        <td>Wireframing</td>
        <td>Free tier available</td>
        <td>No</td>
        <td>Wireframes, flowcharts, and mind maps</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/canva" style="color:var(--text)">Canva</a></td>
        <td>Design Editor</td>
        <td>Free plan, 5 GB storage</td>
        <td>No</td>
        <td>Quick graphics, social media, and presentations</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">Figma remains the industry standard for UI/UX design with a generous free Starter plan. Penpot is the leading open-source alternative with no limits. For developers who prefer code, ShadcnUI and DaisyUI eliminate the need for a design tool entirely. The icon ecosystem is especially strong \u2014 Lucide, Iconoir, and Tabler all offer 1,000+ MIT-licensed icons. All limits verified against live pricing pages, March 2026.</p>

  <h2>Which Free Design Tool Should I Use?</h2>
  <div class="decision-guide">
    <dl>
      <dt>Need a full design tool for UI/UX?</dt>
      <dd><a href="/vendor/figma">Figma</a> \u2014 industry standard, generous free Starter plan with unlimited files. <a href="/vendor/penpot">Penpot</a> \u2014 open-source alternative, self-hostable, no vendor lock-in. <a href="/vendor/lunacy">Lunacy</a> for offline-first design with built-in assets.</dd>

      <dt>Building a website without code?</dt>
      <dd><a href="/vendor/webflow">Webflow</a> \u2014 most powerful visual builder with CMS (2 projects free). <a href="/vendor/framer-com">Framer</a> for polished portfolio sites. <a href="/vendor/plasmic">Plasmic</a> for visual React development with code export.</dd>

      <dt>Want pre-built UI components?</dt>
      <dd><a href="/vendor/shadcnui">ShadcnUI</a> \u2014 copy-paste React + Tailwind components, fully customizable. <a href="/vendor/daisyui">DaisyUI</a> for Tailwind class-based components with 30+ themes. <a href="/vendor/nextui">NextUI</a> for polished React components with animations.</dd>

      <dt>Need free icons for your project?</dt>
      <dd><a href="/vendor/lucide">Lucide</a> \u2014 1,500+ MIT-licensed SVG icons, tree-shakable packages for React/Vue/Svelte. <a href="/vendor/tabler-icons-io">Tabler Icons</a> for 4,000+ free icons. <a href="/vendor/iconoir">Iconoir</a> for clean, minimal icon set.</dd>

      <dt>Looking for free stock photos?</dt>
      <dd><a href="/vendor/unsplash-com">Unsplash</a> \u2014 millions of high-quality photos, free for commercial use. <a href="/vendor/pexels-com">Pexels</a> for photos and videos. <a href="/vendor/nappy">Nappy</a> for diverse, inclusive stock photography.</dd>

      <dt>Need a color palette or gradient?</dt>
      <dd><a href="/vendor/coolors">Coolors</a> \u2014 generate and explore beautiful color palettes. <a href="/vendor/oklch">OKLCH</a> for perceptually uniform color picking. <a href="/vendor/hypercolor-dev">Hypercolor</a> for ready-made Tailwind CSS gradients.</dd>

      <dt>Want mockups or wireframes?</dt>
      <dd><a href="/vendor/excalidraw">Excalidraw</a> \u2014 completely free, open-source diagramming with hand-drawn style. <a href="/vendor/whimsical-com">Whimsical</a> for wireframes and flowcharts. <a href="/vendor/responsively-app">Responsively App</a> for responsive layout previews across devices.</dd>

      <dt>Need animations for web or mobile?</dt>
      <dd><a href="/vendor/lottiefiles">LottieFiles</a> \u2014 lightweight Lottie animations, free community library with 10 projects. <a href="/vendor/rive">Rive</a> \u2014 interactive animations with state machines, 3 files free.</dd>
    </dl>
  </div>

  <div class="search-cta">
    <p>Looking for more? Browse all <a href="/category/design">Design</a> tools in our full index of ${offers.length.toLocaleString()}+ developer deals.</p>
  </div>

  ${buildMoreAlternativesGuides(slug)}

  ${buildMcpCta("Get design tool recommendations from your AI assistant. Compare UI kits, icons, and prototyping tools \u2014 directly in your editor.")}
  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
<script>${mcpCtaScript()}</script>
</body>
</html>`;
}

function buildProjectManagementAlternativesPage(): string {
  const title = "Best Free Project Management & Collaboration Tools in 2026 — PM, Chat, Scheduling & Productivity Compared";
  const metaDesc = "Compare 93+ free project management tools — Linear, Asana, Trello, ClickUp, Notion, Slack alternatives, Cal.com, and more. Exact free tier limits. Updated March 2026.";
  const slug = "project-management-alternatives";

  // Get all Project Management + Team Collaboration offers
  const pmOffers = offers.filter(o => o.category === "Project Management" || o.category === "Team Collaboration");
  const enrichedAll = enrichOffers(pmOffers);
  const riskColors: Record<string, string> = { stable: "#3fb950", caution: "#d29922", risky: "#f85149" };

  // Group by domain
  const issueTracking = enrichedAll.filter(o =>
    ["Linear", "Atlassian", "Plane", "Huly", "Shortcut", "clickup.com", "asana.com", "trello.com", "Basecamp", "taiga.io", "nTask", "freedcamp.com", "bitrix24.com", "teamwork.com", "Backlog", "GForge", "Tenzu", "Crosswork", "Sflow", "Kitemaker.co", "leiga.com", "Teamcamp", "titanapps.io", "Wikifactory", "RightFeature", "zenhub.com", "zenkit.com"].includes(o.vendor)
  );
  const kanbanBoards = enrichedAll.filter(o =>
    ["gokanban.io", "kan.bn", "kanbanflow.com", "kanbantool.com", "MeisterTask", "Teamhood", "HeySpace", "Fizzy", "Fibery", "Hygger"].includes(o.vendor)
  );
  const agileScrumRetro = enrichedAll.filter(o =>
    ["acunote.com", "Yodiz", "ScrumFast", "MeuScrum", "Teaminal", "Fibo", "easyretro.io", "teleretro.com", "planitpoker.com", "point.poker", "Zube"].includes(o.vendor)
  );
  const timeTracking = enrichedAll.filter(o =>
    ["Clockify", "TimeCamp", "Toggl", "Pendulums", "Pulse.red", "Quidlo Timesheets", "Teamplify", "taskade.com", "todoist.com", "Tweek"].includes(o.vendor)
  );
  const teamChat = enrichedAll.filter(o =>
    ["Chanty.com", "element.io", "flock.com", "Pumble", "Revolt.chat", "Rocket.Chat", "twist.com", "Zulip", "gitter.im", "Keybase", "Braid"].includes(o.vendor)
  );
  const videoMeetings = enrichedAll.filter(o =>
    ["meet.jit.si", "talky.io", "Webex", "zoom.us", "Duckly", "Tencent RTC", "Screen Sharing via Browser", "flat.social"].includes(o.vendor)
  );
  const docsKnowledge = enrichedAll.filter(o =>
    ["Notion", "Hackmd.io", "Nuclino", "Slab", "cDox", "evernote.com", "BookmarkOS.com", "Raindrop.io", "Linkinize", "Stickies", "Liveblocks", "GitDailies", "Lockitbot"].includes(o.vendor)
  );
  const scheduling = enrichedAll.filter(o =>
    ["Cal.com", "Calendly", "cally.com"].includes(o.vendor)
  );
  const other = enrichedAll.filter(o =>
    !issueTracking.includes(o) && !kanbanBoards.includes(o) && !agileScrumRetro.includes(o) && !timeTracking.includes(o) && !teamChat.includes(o) && !videoMeetings.includes(o) && !docsKnowledge.includes(o) && !scheduling.includes(o)
  );

  // Build cards helper
  const buildCards = (items: ReturnType<typeof enrichOffers>) => items.map(o => {
    const riskBadge = o.risk_level ? `<span style="display:inline-block;font-size:.7rem;padding:.15rem .5rem;border-radius:10px;background:${riskColors[o.risk_level]}22;color:${riskColors[o.risk_level]};font-weight:600;margin-left:.5rem">${o.risk_level}</span>` : "";
    return `<div class="alt-card">
        <div class="alt-card-header">
          <a href="/vendor/${toSlug(o.vendor)}" class="alt-card-name">${escHtmlServer(o.vendor)}</a>
          <span class="alt-card-tier">${escHtmlServer(o.tier)}</span>
          ${riskBadge}
        </div>
        <p class="alt-card-desc">${escHtmlServer(o.description)}</p>
        <div class="alt-card-links">
          <a href="/vendor/${toSlug(o.vendor)}">Full profile</a>
          <a href="/alternative-to/${toSlug(o.vendor)}">Alternatives</a>
          <a href="${escHtmlServer(o.url)}" target="_blank" rel="noopener">Pricing &nearr;</a>
        </div>
      </div>`;
  }).join("\n");

  // PM deal changes
  const pmChangeVendors = ["Linear", "Atlassian", "Asana", "Trello", "ClickUp", "Notion", "Jira", "Slack"];
  const pmChanges = dealChanges.filter(c => pmChangeVendors.some(v => c.vendor.includes(v)));
  const changesHtml = pmChanges.length > 0 ? `
  <div class="context-box" style="border-left:3px solid ${riskColors.caution}">
    <div style="font-weight:600;color:${riskColors.caution};margin-bottom:.5rem">Recent PM Tool Pricing Changes</div>
    <ul style="margin:0;padding-left:1.25rem;font-size:.9rem;color:var(--text-muted);line-height:1.8">
      ${pmChanges.slice(0, 8).map(c => `<li><strong>${escHtmlServer(c.vendor)}</strong>: ${escHtmlServer(c.summary.length > 120 ? c.summary.substring(0, 117) + "..." : c.summary)}</li>`).join("\n      ")}
    </ul>
    <p style="margin:.75rem 0 0;font-size:.8rem"><a href="/changes">View all ${dealChanges.length} pricing changes &rarr;</a></p>
  </div>` : "";

  // JSON-LD
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: title,
    description: metaDesc,
    numberOfItems: pmOffers.length,
    itemListElement: enrichedAll.slice(0, 30).map((o, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "SoftwareApplication",
        name: o.vendor,
        description: o.description,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: o.tier },
        url: o.url,
      },
    })),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)} — AgentDeals</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/${slug}">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/${slug}">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
h2{font-family:var(--serif);font-size:1.4rem;color:var(--text);margin:2.5rem 0 1rem;letter-spacing:-.01em}
h3{font-family:var(--serif);font-size:1.1rem;color:var(--text);margin:1.5rem 0 .5rem}
.context{color:var(--text-muted);margin-bottom:1.5rem;font-size:.95rem;line-height:1.7}
.context strong{color:var(--text)}
.context-box{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1rem 1.25rem;margin:1.5rem 0;font-size:.9rem;color:var(--text-muted)}
.alt-card{padding:1.25rem;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;background:var(--bg-card);margin-bottom:.75rem;transition:border-color .2s}
.alt-card:hover{border-color:var(--accent)}
.alt-card-header{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem}
.alt-card-name{font-size:1.1rem;font-weight:600;color:var(--text)}
.alt-card-name:hover{color:var(--accent)}
.alt-card-tier{font-family:var(--mono);color:var(--accent);font-size:.8rem;padding:.1rem .5rem;background:var(--accent-glow);border-radius:10px}
.alt-card-desc{color:var(--text-muted);font-size:.9rem;line-height:1.5;margin:.5rem 0}
.alt-card-links{display:flex;flex-wrap:wrap;gap:.75rem;font-size:.8rem;margin-top:.5rem}
.alt-card-links a{color:var(--accent);text-decoration:none}
.alt-card-links a:hover{text-decoration:underline}
.compare-table{width:100%;border-collapse:collapse;margin:1rem 0 2rem}
.compare-table th,.compare-table td{padding:.5rem .75rem;text-align:left;border-bottom:1px solid var(--border);font-size:.85rem}
.compare-table th{color:var(--text-muted);font-weight:500;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
.compare-table tr:hover{background:var(--accent-glow)}
.search-cta{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.25rem;margin:2rem 0;text-align:center;font-size:.9rem}
.decision-guide{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:1.5rem;margin:2rem 0}
.decision-guide dt{font-weight:600;color:var(--text);margin-top:1rem}
.decision-guide dt:first-child{margin-top:0}
.decision-guide dd{color:var(--text-muted);font-size:.9rem;margin:.25rem 0 0 0;line-height:1.6}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.compare-table{font-size:.75rem}.compare-table th,.compare-table td{padding:.4rem .5rem}}
${globalNavCss()}
${mcpCtaCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("alternatives")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; <a href="/alternatives">Alternatives</a> &rsaquo; Free Project Management Tools</div>
  <h1>Best Free Project Management &amp; Collaboration Tools</h1>

  <div class="context">
    <p>Project management is one of the most competitive developer tool categories. <strong>Jira</strong> dominates enterprise but its free tier caps at 10 users. <strong>Asana</strong> limits free projects to 15 collaborators. Meanwhile, open-source alternatives like <strong>Plane</strong> and <strong>Huly</strong> offer unlimited projects with self-hosting, and <strong>Linear</strong> provides a generous free tier for small teams.</p>
    <p>This page compares every free project management and collaboration tool in our index — <strong>${pmOffers.length} tools</strong> across issue trackers, kanban boards, team chat, video conferencing, docs, and scheduling. Whether you need a Jira alternative or a free Slack replacement, we have the comparison with exact free tier limits.</p>
  </div>

  ${changesHtml}

  <h2>Project Management &amp; Issue Tracking</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Core project management platforms for issue tracking, sprint planning, and team coordination. Linear leads the modern PM space with a fast, keyboard-driven interface. Plane and Huly are open-source alternatives to Jira with generous free tiers.</p>
${buildCards(issueTracking)}

  <h2>Kanban Boards &amp; Visual Planning</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Visual board-based tools for workflow management. Great for teams that prefer drag-and-drop task organization over traditional issue trackers.</p>
${buildCards(kanbanBoards)}

  <h2>Agile, Scrum &amp; Retrospectives</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Tools for agile workflows — sprint management, planning poker, retrospectives, and estimation. Essential for teams running Scrum or other agile methodologies.</p>
${buildCards(agileScrumRetro)}

  <h2>Time Tracking &amp; Task Productivity</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Time trackers and personal productivity tools. Clockify offers unlimited free tracking. Toggl provides a polished interface with reporting. Todoist is a popular task manager with a generous free tier.</p>
${buildCards(timeTracking)}

  <h2>Team Chat &amp; Messaging</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Slack alternatives for team communication. Element (Matrix-based) and Rocket.Chat are open-source and self-hostable. Pumble offers unlimited message history free — unlike Slack's 90-day limit on the free plan.</p>
${buildCards(teamChat)}

  <h2>Video Conferencing &amp; Screen Sharing</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Video meeting and screen sharing tools. Jitsi Meet is fully open source with no account required. Zoom and Webex offer generous free tiers for smaller meetings.</p>
${buildCards(videoMeetings)}

  <h2>Docs, Knowledge &amp; Collaboration</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Knowledge management, documentation, and real-time collaboration tools. Notion leads with an all-in-one workspace. HackMD offers collaborative Markdown editing. Liveblocks powers real-time collaboration features in your own apps.</p>
${buildCards(docsKnowledge)}

  <h2>Scheduling &amp; Calendar</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Scheduling and calendar tools for booking meetings. Cal.com is open-source Calendly alternative with unlimited event types on the free tier.</p>
${buildCards(scheduling)}

${other.length > 0 ? `
  <h2>More PM &amp; Collaboration Tools</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Additional project management and collaboration tools with free tiers.</p>
${buildCards(other)}
` : ""}

  <h2>Free PM Tools Comparison</h2>
  <p style="color:var(--text-muted);margin-bottom:1rem">Top free project management and collaboration tools compared by domain, free tier limits, and best use case.</p>
  <div style="overflow-x:auto">
  <table class="compare-table">
    <thead>
      <tr>
        <th>Service</th>
        <th>Domain</th>
        <th>Free Tier</th>
        <th>OSS</th>
        <th>Best For</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:600"><a href="/vendor/linear" style="color:var(--text)">Linear</a></td>
        <td>Issue Tracking</td>
        <td>250 issues, unlimited members</td>
        <td>No</td>
        <td>Modern, fast issue tracker for software teams</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/plane" style="color:var(--text)">Plane</a></td>
        <td>Issue Tracking</td>
        <td>Unlimited, self-hosted</td>
        <td>Yes</td>
        <td>Open-source Jira alternative with cycles and modules</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/huly" style="color:var(--text)">Huly</a></td>
        <td>Issue Tracking</td>
        <td>Unlimited, self-hosted</td>
        <td>Yes</td>
        <td>All-in-one PM with chat, docs, and HR built in</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/trello-com" style="color:var(--text)">Trello</a></td>
        <td>Kanban</td>
        <td>Unlimited cards, 10 boards/workspace</td>
        <td>No</td>
        <td>Simple, visual kanban for small teams</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/asana-com" style="color:var(--text)">Asana</a></td>
        <td>Issue Tracking</td>
        <td>15 collaborators, unlimited tasks</td>
        <td>No</td>
        <td>Versatile PM with list, board, and timeline views</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/clickup-com" style="color:var(--text)">ClickUp</a></td>
        <td>Issue Tracking</td>
        <td>100 MB storage, unlimited tasks</td>
        <td>No</td>
        <td>Feature-rich PM with docs, goals, and whiteboards</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/notion" style="color:var(--text)">Notion</a></td>
        <td>Knowledge</td>
        <td>Unlimited pages, 10 guests</td>
        <td>No</td>
        <td>All-in-one workspace for docs, wikis, and databases</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/clockify" style="color:var(--text)">Clockify</a></td>
        <td>Time Tracking</td>
        <td>Unlimited tracking, unlimited users</td>
        <td>No</td>
        <td>Free time tracking with team reports</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/pumble" style="color:var(--text)">Pumble</a></td>
        <td>Team Chat</td>
        <td>Unlimited history, unlimited users</td>
        <td>No</td>
        <td>Slack alternative with unlimited message history</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/element-io" style="color:var(--text)">Element</a></td>
        <td>Team Chat</td>
        <td>Unlimited, Matrix protocol</td>
        <td>Yes</td>
        <td>Decentralized chat, self-hostable, E2E encrypted</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/cal-com" style="color:var(--text)">Cal.com</a></td>
        <td>Scheduling</td>
        <td>Unlimited event types</td>
        <td>Yes</td>
        <td>Open-source Calendly alternative</td>
      </tr>
      <tr>
        <td style="font-weight:600"><a href="/vendor/meet-jit-si" style="color:var(--text)">Jitsi Meet</a></td>
        <td>Video</td>
        <td>Unlimited, no account needed</td>
        <td>Yes</td>
        <td>Free, open-source video conferencing</td>
      </tr>
    </tbody>
  </table>
  </div>
  <p style="color:var(--text-dim);font-size:.8rem;margin-top:.5rem">Linear leads modern issue tracking with a fast, keyboard-driven interface and 250 free issues. Plane and Huly offer unlimited open-source PM. For team chat, Pumble provides unlimited message history free — a key advantage over Slack. Cal.com is the leading open-source scheduling tool. All limits verified against live pricing pages, March 2026.</p>

  <h2>Which Free PM Tool Should I Use?</h2>
  <div class="decision-guide">
    <dl>
      <dt>Need a modern issue tracker for a dev team?</dt>
      <dd><a href="/vendor/linear">Linear</a> — fast, keyboard-driven, 250 issues free. <a href="/vendor/shortcut">Shortcut</a> — 10 free seats with epics and iterations. <a href="/vendor/atlassian">Atlassian/Jira</a> — 10 users free, deep integrations.</dd>

      <dt>Want an open-source, self-hosted PM?</dt>
      <dd><a href="/vendor/plane">Plane</a> — open-source Jira alternative with cycles and modules. <a href="/vendor/huly">Huly</a> — all-in-one with chat, docs, and HR. <a href="/vendor/taiga-io">Taiga</a> — agile PM with Scrum and Kanban.</dd>

      <dt>Need simple visual kanban boards?</dt>
      <dd><a href="/vendor/trello-com">Trello</a> — 10 boards free with Power-Ups. <a href="/vendor/kanbanflow-com">KanbanFlow</a> — Pomodoro timer built in. <a href="/vendor/meistertask">MeisterTask</a> — visual boards with automations.</dd>

      <dt>Need time tracking for your team?</dt>
      <dd><a href="/vendor/clockify">Clockify</a> — unlimited tracking and users, free forever. <a href="/vendor/toggl">Toggl</a> — polished UI with reports, 5 users free. <a href="/vendor/timecamp">TimeCamp</a> — automatic time tracking.</dd>

      <dt>Looking for a Slack alternative?</dt>
      <dd><a href="/vendor/pumble">Pumble</a> — unlimited message history, free. <a href="/vendor/element-io">Element</a> — decentralized, E2E encrypted, self-hostable. <a href="/vendor/rocket-chat">Rocket.Chat</a> — open-source, self-hosted team chat.</dd>

      <dt>Need video conferencing?</dt>
      <dd><a href="/vendor/meet-jit-si">Jitsi Meet</a> — fully open source, no account needed. <a href="/vendor/zoom-us">Zoom</a> — 40-min free meetings, up to 100 participants. <a href="/vendor/webex">Webex</a> — 40-min meetings, 100 participants.</dd>

      <dt>Need a knowledge base or wiki?</dt>
      <dd><a href="/vendor/notion">Notion</a> — all-in-one workspace with unlimited pages. <a href="/vendor/hackmd-io">HackMD</a> — collaborative Markdown. <a href="/vendor/nuclino">Nuclino</a> — fast, lightweight team wiki.</dd>

      <dt>Need scheduling/booking?</dt>
      <dd><a href="/vendor/cal-com">Cal.com</a> — open-source Calendly alternative, unlimited event types. <a href="/vendor/calendly">Calendly</a> — 1 event type free, polished UX. <a href="/vendor/cally-com">Cally</a> — simple group scheduling.</dd>
    </dl>
  </div>

  <div class="search-cta">
    <p>Looking for more? Browse all <a href="/category/project-management">Project Management</a> and <a href="/category/team-collaboration">Team Collaboration</a> tools in our full index of ${offers.length.toLocaleString()}+ developer deals.</p>
  </div>

  ${buildMoreAlternativesGuides(slug)}

  ${buildMcpCta("Get project management tool recommendations from your AI assistant. Compare PM tools, team chat, and scheduling — directly in your editor.")}
  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
<script>${mcpCtaScript()}</script>
</body>
</html>`;
}

// --- Setup guide page ---

function buildSetupPage(): string {
  const baseUrl = BASE_URL;
  const title = "Setup Guide — AgentDeals MCP Server";
  const metaDesc = "Step-by-step instructions to add AgentDeals as an MCP server in Claude Desktop, Claude Code, Cursor, Cline, and Windsurf. Search 1,500+ developer deals from your AI assistant.";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    "name": "How to Set Up AgentDeals MCP Server",
    "description": metaDesc,
    "step": [
      { "@type": "HowToStep", "position": 1, "name": "Choose your client", "text": "Pick your MCP client: Claude Desktop, Claude Code, Cursor, Cline, or Windsurf." },
      { "@type": "HowToStep", "position": 2, "name": "Add the server config", "text": "Copy the JSON config snippet into your client's MCP configuration file." },
      { "@type": "HowToStep", "position": 3, "name": "Start using tools", "text": "Ask your AI assistant questions like 'What free databases are available?' and it will use AgentDeals tools automatically." }
    ]
  };

  const toolExamples: { tool: string; question: string; desc: string }[] = [
    { tool: "search_deals", question: "Find free database hosting", desc: "Search 1,500+ deals by category, pricing, or keyword" },
    { tool: "compare_vendors", question: "Compare Supabase vs Neon", desc: "Side-by-side comparison of free tiers, risk levels, and limits" },
    { tool: "track_changes", question: "What pricing changes happened this month?", desc: "Track free tier removals, limit changes, and new deals" },
    { tool: "plan_stack", question: "Estimate costs for a SaaS backend", desc: "Stack recommendations, cost estimates, and infrastructure audits" },
    { tool: "compare_vendors", question: "Is Heroku's free tier at risk?", desc: "Risk scoring based on pricing history and signals" },
    { tool: "search_deals", question: "Show me startup credit programs", desc: "Filter by eligibility type: startup, student, or open-source" },
    { tool: "search_deals", question: "What are alternatives to Vercel?", desc: "Vendor details with alternatives in the same category" },
    { tool: "plan_stack", question: "Audit my current stack: Vercel, Supabase, Clerk", desc: "Risk assessment, cost projection, and gap analysis for your stack" },
    { tool: "track_changes", question: "Any deals expiring soon?", desc: "Upcoming expirations and deadlines across tracked vendors" },
    { tool: "search_deals", question: "What's new this week?", desc: "Recently added deals and pricing updates" },
  ];

  const toolExamplesHtml = toolExamples.map(t =>
    `<div class="example-card">
      <div class="example-prompt">&gt; ${escHtmlServer(t.question)}</div>
      <p class="example-desc">${escHtmlServer(t.desc)}</p>
      <code class="example-tool">${escHtmlServer(t.tool)}</code>
    </div>`
  ).join("\n        ");

  const clientConfigs = [
    {
      id: "claude-desktop", name: "Claude Desktop",
      desc: `Add to <code>claude_desktop_config.json</code>`,
      hint: `macOS: <code>~/Library/Application Support/Claude/</code> &nbsp;|&nbsp; Windows: <code>%APPDATA%\\Claude\\</code>`,
      localConfig: `{
  "mcpServers": {
    "agentdeals": {
      "command": "npx",
      "args": ["-y", "agentdeals"]
    }
  }
}`,
      remoteConfig: `{
  "mcpServers": {
    "agentdeals": {
      "url": "${baseUrl}/mcp"
    }
  }
}`,
    },
    {
      id: "claude-code", name: "Claude Code",
      desc: `Run in your terminal, or add to <code>.mcp.json</code> in your project root`,
      hint: "",
      localConfig: `claude mcp add agentdeals -- npx -y agentdeals`,
      localExtra: `<p class="config-hint">Or add to <code>.mcp.json</code>:</p>
          <pre><button class="copy-btn" onclick="copyConfig(this)">Copy</button><code>{
  "mcpServers": {
    "agentdeals": {
      "command": "npx",
      "args": ["-y", "agentdeals"]
    }
  }
}</code></pre>`,
      remoteConfig: `claude mcp add agentdeals --transport http ${baseUrl}/mcp`,
      remoteExtra: `<p class="config-hint">Or add to <code>.mcp.json</code>:</p>
          <pre><button class="copy-btn" onclick="copyConfig(this)">Copy</button><code>{
  "mcpServers": {
    "agentdeals": {
      "type": "url",
      "url": "${baseUrl}/mcp"
    }
  }
}</code></pre>`,
    },
    {
      id: "cursor", name: "Cursor",
      desc: `Add to <code>.cursor/mcp.json</code> in your project root`,
      hint: `Or global: <code>~/.cursor/mcp.json</code>`,
      localConfig: `{
  "mcpServers": {
    "agentdeals": {
      "command": "npx",
      "args": ["-y", "agentdeals"]
    }
  }
}`,
      remoteConfig: `{
  "mcpServers": {
    "agentdeals": {
      "url": "${baseUrl}/mcp"
    }
  }
}`,
    },
    {
      id: "cline", name: "Cline (VS Code)",
      desc: `Add to <code>cline_mcp_settings.json</code>`,
      hint: `Cline sidebar &rarr; MCP Servers &rarr; Configure`,
      localConfig: `{
  "mcpServers": {
    "agentdeals": {
      "command": "npx",
      "args": ["-y", "agentdeals"]
    }
  }
}`,
      remoteConfig: `{
  "mcpServers": {
    "agentdeals": {
      "url": "${baseUrl}/mcp",
      "transportType": "streamable-http"
    }
  }
}`,
    },
    {
      id: "windsurf", name: "Windsurf",
      desc: `Add to <code>~/.codeium/windsurf/mcp_config.json</code>`,
      hint: "",
      localConfig: `{
  "mcpServers": {
    "agentdeals": {
      "command": "npx",
      "args": ["-y", "agentdeals"]
    }
  }
}`,
      remoteConfig: `{
  "mcpServers": {
    "agentdeals": {
      "url": "${baseUrl}/mcp"
    }
  }
}`,
    },
    {
      id: "other", name: "Other Clients",
      desc: `Any MCP client that supports streamable-http transport`,
      hint: "",
      localConfig: `{
  "mcpServers": {
    "agentdeals": {
      "command": "npx",
      "args": ["-y", "agentdeals"]
    }
  }
}`,
      remoteConfig: `Endpoint: ${baseUrl}/mcp
Transport: streamable-http
Session: Mcp-Session-Id header (auto-managed)`,
    },
  ];

  const tabsHtml = clientConfigs.map((c, i) =>
    `<button class="client-tab${i === 0 ? " active" : ""}" data-client="${c.id}">${escHtmlServer(c.name)}</button>`
  ).join("\n      ");

  const panelsHtml = clientConfigs.map((c, i) => {
    const hintLine = c.hint ? `\n        <p class="config-hint">${c.hint}</p>` : "";
    const localExtraHtml = (c as any).localExtra ? `\n          ${(c as any).localExtra}` : "";
    const remoteExtraHtml = (c as any).remoteExtra ? `\n          ${(c as any).remoteExtra}` : "";
    return `<div class="client-panel${i === 0 ? " active" : ""}" id="panel-${c.id}">
      <div class="connect-block">
        <h3 class="config-title">${escHtmlServer(c.name)}</h3>
        <p class="config-desc">${c.desc}</p>${hintLine}
        <div class="transport-toggle">
          <button class="transport-btn active" data-transport="local">npx (local)</button>
          <button class="transport-btn" data-transport="remote">Remote HTTP</button>
        </div>
        <div class="transport-content active" data-transport="local">
          <pre><button class="copy-btn" onclick="copyConfig(this)">Copy</button><code>${escHtmlServer(c.localConfig)}</code></pre>${localExtraHtml}
        </div>
        <div class="transport-content" data-transport="remote">
          <pre><button class="copy-btn" onclick="copyConfig(this)">Copy</button><code>${escHtmlServer(c.remoteConfig)}</code></pre>${remoteExtraHtml}
        </div>
      </div>
    </div>`;
  }).join("\n    ");

  const css = `${globalNavCss()}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
code{font-family:var(--mono);font-size:.85em;background:rgba(59,130,246,0.08);padding:.15em .35em;border-radius:4px}
pre{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:1rem;overflow-x:auto;position:relative;margin:.5rem 0}
pre code{background:none;padding:0;font-size:.8rem;color:var(--text)}
.container{max-width:800px;margin:0 auto;padding:1.5rem 1rem}
.breadcrumb{font-size:.8rem;color:var(--text-dim);margin-bottom:1.5rem}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:1.8rem;color:var(--text);margin-bottom:.5rem;letter-spacing:-.02em}
.page-sub{font-size:.95rem;color:var(--text-muted);margin-bottom:2rem;max-width:600px}
h2{font-family:var(--serif);font-size:1.3rem;color:var(--text);margin-top:2.5rem;margin-bottom:.75rem;letter-spacing:-.01em;padding-top:1.5rem;border-top:1px solid var(--border)}
h2:first-of-type{border-top:none;padding-top:0;margin-top:1.5rem}
.quick-start{background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px;padding:1.25rem;margin-bottom:2rem}
.quick-start h3{font-family:var(--serif);font-size:1rem;color:var(--text);margin-bottom:.75rem}
.quick-cmd{display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem}
.quick-cmd code{flex:1;font-size:.8rem;color:var(--accent)}
.quick-cmd span{font-size:.75rem;color:var(--text-dim);flex-shrink:0}
.client-tabs{display:flex;gap:.25rem;flex-wrap:wrap;margin-bottom:1rem}
.client-tab{background:transparent;border:1px solid var(--border);color:var(--text-muted);padding:.4rem .8rem;border-radius:6px;cursor:pointer;font-size:.8rem;font-family:var(--sans);transition:all .15s}
.client-tab:hover{color:var(--text);border-color:var(--text-dim)}
.client-tab.active{color:var(--accent);border-color:var(--accent);background:var(--accent-glow)}
.client-panel{display:none}.client-panel.active{display:block}
.connect-block{margin-bottom:1rem}
.config-title{font-family:var(--serif);font-size:1rem;color:var(--text);margin-bottom:.25rem}
.config-desc{font-size:.85rem;color:var(--text-muted);margin-bottom:.25rem}
.config-hint{font-size:.75rem;color:var(--text-dim);margin-bottom:.5rem;margin-top:.5rem}
.transport-toggle{display:flex;gap:.25rem;margin:.5rem 0}
.transport-btn{background:transparent;border:1px solid var(--border);color:var(--text-dim);padding:.3rem .6rem;border-radius:5px;cursor:pointer;font-size:.75rem;font-family:var(--sans);transition:all .15s}
.transport-btn:hover{color:var(--text);border-color:var(--text-dim)}
.transport-btn.active{color:var(--accent);border-color:var(--accent);background:var(--accent-glow)}
.transport-content{display:none}.transport-content.active{display:block}
.copy-btn{position:absolute;top:.5rem;right:.5rem;background:var(--bg-elevated);border:1px solid var(--border);color:var(--text-muted);padding:.2rem .5rem;border-radius:4px;cursor:pointer;font-size:.7rem;font-family:var(--sans);transition:all .15s}
.copy-btn:hover{color:var(--text);border-color:var(--text-dim)}
.copy-btn.copied{color:var(--accent);border-color:var(--accent)}
.examples-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:.75rem;margin-top:.75rem}
.example-card{background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;padding:.75rem 1rem;transition:border-color .15s}
.example-card:hover{border-color:var(--accent)}
.example-prompt{font-family:var(--mono);font-size:.85rem;color:var(--text);margin-bottom:.35rem}
.example-desc{font-size:.8rem;color:var(--text-muted);margin:0 0 .35rem 0}
.example-tool{font-size:.7rem;color:var(--text-dim);background:none;padding:0}
.troubleshoot{background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px;padding:1rem;margin-top:.75rem}
.troubleshoot dt{font-size:.85rem;color:var(--text);font-weight:600;margin-top:.75rem}
.troubleshoot dt:first-child{margin-top:0}
.troubleshoot dd{font-size:.85rem;color:var(--text-muted);margin:0 0 .5rem 0}
footer{text-align:center;color:var(--text-dim);font-size:.75rem;margin-top:3rem;padding:1.5rem 0;border-top:1px solid var(--border)}
@media(max-width:600px){h1{font-size:1.4rem}.examples-grid{grid-template-columns:1fr}}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escHtmlServer(title)}</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="canonical" href="${baseUrl}/setup">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${baseUrl}/setup">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>${css}</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("setup")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; Setup</div>

  <h1>Setup Guide</h1>
  <p class="page-sub">Add AgentDeals to your AI coding assistant. 4 MCP tools for searching deals, comparing vendors, planning stacks, and tracking changes.</p>

  <div class="quick-start">
    <h3>Quick start</h3>
    <div class="quick-cmd"><span>Claude Code:</span> <code>claude mcp add agentdeals -- npx -y agentdeals</code></div>
    <div class="quick-cmd"><span>npx (any client):</span> <code>npx -y agentdeals</code></div>
    <div class="quick-cmd"><span>Remote endpoint:</span> <code>${baseUrl}/mcp</code></div>
  </div>

  <h2>Client Setup</h2>
  <p style="font-size:.85rem;color:var(--text-muted);margin-bottom:1rem">Choose your MCP client. Each supports local (npx) or remote (HTTP) transport.</p>

  <div class="client-tabs">
      ${tabsHtml}
  </div>

    ${panelsHtml}

  <h2>What Can You Ask?</h2>
  <p style="font-size:.85rem;color:var(--text-muted);margin-bottom:.5rem">Once connected, try these prompts in your AI assistant &mdash; it picks the right AgentDeals tool automatically.</p>
  <div class="examples-grid">
        ${toolExamplesHtml}
  </div>

  <h2>Troubleshooting</h2>
  <div class="troubleshoot">
    <dl>
      <dt>Server not found / connection refused</dt>
      <dd>For local (npx): ensure Node.js 18+ is installed. For remote: the endpoint is <code>${baseUrl}/mcp</code> &mdash; include the <code>/mcp</code> path.</dd>
      <dt>Session timeout</dt>
      <dd>Remote sessions expire after 30 minutes of inactivity. Your client will automatically reconnect on the next request.</dd>
      <dt>Tools not appearing</dt>
      <dd>After adding the config, restart your MCP client. Tools appear after the MCP initialization handshake completes.</dd>
      <dt>CORS errors (browser-based clients)</dt>
      <dd>The server sends <code>Access-Control-Allow-Origin: *</code> headers. If you see CORS errors, check that you're using the correct endpoint URL.</dd>
    </dl>
  </div>

  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
<script>
(function(){
  var tabs=document.querySelectorAll('.client-tab');
  var panels=document.querySelectorAll('.client-panel');
  tabs.forEach(function(tab){
    tab.addEventListener('click',function(){
      tabs.forEach(function(t){t.classList.remove('active')});
      panels.forEach(function(p){p.classList.remove('active')});
      tab.classList.add('active');
      var panel=document.getElementById('panel-'+tab.getAttribute('data-client'));
      if(panel)panel.classList.add('active');
    });
  });
  document.querySelectorAll('.transport-toggle').forEach(function(toggle){
    var block=toggle.closest('.connect-block');
    toggle.querySelectorAll('.transport-btn').forEach(function(btn){
      btn.addEventListener('click',function(){
        toggle.querySelectorAll('.transport-btn').forEach(function(b){b.classList.remove('active')});
        block.querySelectorAll('.transport-content').forEach(function(c){c.classList.remove('active')});
        btn.classList.add('active');
        block.querySelectorAll('.transport-content[data-transport="'+btn.getAttribute('data-transport')+'"]').forEach(function(c){c.classList.add('active')});
      });
    });
  });
})();
function copyConfig(btn){
  var code=btn.parentElement.querySelector('code');
  if(!code)return;
  navigator.clipboard.writeText(code.textContent).then(function(){
    btn.textContent='Copied!';btn.classList.add('copied');
    setTimeout(function(){btn.textContent='Copy';btn.classList.remove('copied')},2000);
  });
}
</script>
</body>
</html>`;
}

// --- Deal changes timeline page ---

function buildChangesPage(): string {
  const allChanges = loadDealChanges();
  const today = new Date().toISOString().slice(0, 10);

  // Sort all changes reverse chronological
  const sorted = [...allChanges].sort((a, b) => b.date.localeCompare(a.date));

  // Group by month
  const byMonth = new Map<string, typeof sorted>();
  for (const c of sorted) {
    const monthKey = c.date.slice(0, 7);
    if (!byMonth.has(monthKey)) byMonth.set(monthKey, []);
    byMonth.get(monthKey)!.push(c);
  }

  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function formatMonth(key: string): string {
    const [y, m] = key.split("-");
    return `${monthNames[parseInt(m, 10) - 1]} ${y}`;
  }

  function buildChangeEntry(c: typeof allChanges[0]): string {
    const badge = changeTypeBadge[c.change_type] ?? { label: c.change_type, color: "#8b949e" };
    const impactColor = c.impact === "high" ? "#f85149" : c.impact === "medium" ? "#d29922" : "#8b949e";
    const vendorSlug = toSlug(c.vendor);
    const isUpcoming = c.date >= today;
    const altHtml = c.alternatives && c.alternatives.length > 0
      ? `<div class="chg-alts"><span class="chg-alts-label">Alternatives:</span> ${c.alternatives.map(a => `<a href="/vendor/${toSlug(a)}">${escHtmlServer(a)}</a>`).join(", ")}</div>`
      : "";
    return `      <div class="chg-entry${isUpcoming ? " chg-upcoming" : ""}">
        <div class="chg-left">
          <div class="chg-date">${c.date}</div>
          ${isUpcoming ? `<div class="chg-upcoming-badge">upcoming</div>` : ""}
        </div>
        <div class="chg-right">
          <div class="chg-head">
            <span class="badge" style="background:${badge.color}">${badge.label}</span>
            <a href="/vendor/${vendorSlug}" class="chg-vendor">${escHtmlServer(c.vendor)}</a>
            <span class="chg-impact" style="color:${impactColor}">${c.impact}</span>
          </div>
          <div class="chg-summary">${escHtmlServer(c.summary)}</div>
${altHtml}
        </div>
      </div>`;
  }

  const upcomingCount = sorted.filter(c => c.date >= today).length;
  const removedCount = sorted.filter(c => c.change_type === "free_tier_removed" || c.change_type === "open_source_killed" || c.change_type === "product_deprecated").length;

  const monthsHtml = Array.from(byMonth.entries()).map(([month, changes]) => {
    const entriesHtml = changes.map(c => buildChangeEntry(c)).join("\n");
    return `    <div class="month-group">
      <h2 class="month-heading">${formatMonth(month)}</h2>
${entriesHtml}
    </div>`;
  }).join("\n");

  const title = "Deal Change Timeline \u2014 AgentDeals";
  const metaDesc = `${allChanges.length} developer infrastructure pricing changes tracked. Free tier removals, price increases, product shutdowns, and new deals.`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: title,
    description: metaDesc,
    numberOfItems: allChanges.length,
    url: `${BASE_URL}/changes`,
    itemListElement: sorted.slice(0, 50).map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "NewsArticle",
        headline: `${c.vendor}: ${(changeTypeBadge[c.change_type] ?? { label: c.change_type }).label}`,
        description: c.summary,
        datePublished: c.date,
        url: `${BASE_URL}/vendor/${toSlug(c.vendor)}`,
        publisher: { "@type": "Organization", name: "AgentDeals", url: BASE_URL },
      },
    })),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)}</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/changes">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/changes">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals \u2014 Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
.page-intro{color:var(--text-muted);font-size:.95rem;margin-bottom:1rem}
.rss-link{display:inline-block;color:var(--accent);font-size:.85rem;margin-bottom:1.5rem;padding:.3rem .6rem;border:1px solid var(--border);border-radius:6px}
.rss-link:hover{border-color:var(--accent);background:var(--accent-glow);text-decoration:none}
.stats-bar{display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:2rem}
.stat-card{flex:1;min-width:120px;padding:.75rem 1rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);text-align:center}
.stat-value{font-family:var(--serif);font-size:1.5rem;color:var(--text)}
.stat-label{font-family:var(--mono);font-size:.65rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.1em}
.month-group{margin-bottom:2rem}
.month-heading{font-family:var(--serif);font-size:1.15rem;color:var(--text);margin-bottom:.75rem;padding-bottom:.5rem;border-bottom:1px solid var(--border)}
.chg-entry{display:flex;gap:1rem;padding:.75rem;margin-bottom:.5rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);transition:border-color .2s}
.chg-entry:hover{border-color:var(--accent)}
.chg-upcoming{border-color:rgba(88,166,255,0.3)}
.chg-left{flex-shrink:0;min-width:100px;text-align:right}
.chg-date{font-family:var(--mono);font-size:.75rem;color:var(--text-muted)}
.chg-upcoming-badge{font-family:var(--mono);font-size:.65rem;color:#58a6ff;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.chg-right{flex:1;min-width:0}
.chg-head{display:flex;align-items:center;gap:.5rem;margin-bottom:.25rem;flex-wrap:wrap}
.chg-vendor{color:var(--text);font-weight:600;font-size:.85rem}
.chg-vendor:hover{color:var(--accent)}
.chg-impact{font-family:var(--mono);font-size:.7rem}
.chg-summary{font-size:.85rem;color:var(--text-muted)}
.chg-alts{font-size:.8rem;color:var(--text-dim);margin-top:.35rem}
.chg-alts-label{font-weight:600;color:var(--text-muted)}
.chg-alts a{color:var(--accent);font-size:.8rem}
.badge{display:inline-block;padding:.1rem .4rem;border-radius:10px;font-size:.65rem;font-weight:600;color:#fff}
.mcp-cta{margin-top:2.5rem;padding:1.5rem;border:1px solid var(--border);border-radius:12px;background:var(--accent-glow);text-align:center}
.mcp-cta p{color:var(--text-muted);font-size:.9rem;margin-bottom:.5rem}
.mcp-cta a{font-weight:600}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.stats-bar{flex-direction:column}.chg-entry{flex-direction:column;gap:.25rem}.chg-left{text-align:left;min-width:auto;display:flex;gap:.75rem;align-items:center}}
${globalNavCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("changes")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; Changes</div>
  <h1>Deal Change Timeline</h1>
  <p class="page-intro">Every pricing change we\u2019ve tracked \u2014 free tier removals, price increases, restructures, and new deals. Subscribe to stay ahead.</p>
  <a href="/feed.xml" class="rss-link">\u{1F4E1} Subscribe to deal changes</a>

  <div class="stats-bar">
    <div class="stat-card">
      <div class="stat-value">${allChanges.length}</div>
      <div class="stat-label">Total Changes</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${upcomingCount}</div>
      <div class="stat-label">Upcoming</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${removedCount}</div>
      <div class="stat-label">Removals</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${byMonth.size}</div>
      <div class="stat-label">Months Tracked</div>
    </div>
  </div>

${monthsHtml}

  <div class="mcp-cta">
    <p>Get real-time pricing change alerts in your AI coding assistant.</p>
    <a href="/setup">Connect via MCP &rarr;</a>
  </div>

  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
</body>
</html>`;
}

// --- Expiring deals timeline page ---

function buildExpiringPage(): string {
  const allChanges = loadDealChanges();
  const today = new Date().toISOString().slice(0, 10);
  const todayMs = new Date(today + "T00:00:00Z").getTime();

  // Split into upcoming (future) and recent (past 30 days)
  const thirtyDaysAgo = new Date(todayMs - 30 * 86400000).toISOString().slice(0, 10);
  const upcoming = allChanges.filter(c => c.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const recent = allChanges.filter(c => c.date < today && c.date >= thirtyDaysAgo).sort((a, b) => b.date.localeCompare(a.date));

  // Group upcoming by month
  const upcomingByMonth = new Map<string, typeof upcoming>();
  for (const c of upcoming) {
    const monthKey = c.date.slice(0, 7); // YYYY-MM
    if (!upcomingByMonth.has(monthKey)) upcomingByMonth.set(monthKey, []);
    upcomingByMonth.get(monthKey)!.push(c);
  }

  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function formatMonth(key: string): string {
    const [y, m] = key.split("-");
    return `${monthNames[parseInt(m, 10) - 1]} ${y}`;
  }

  function countdownLabel(dateStr: string): { text: string; urgent: boolean } {
    const d = new Date(dateStr + "T00:00:00Z").getTime();
    const diff = Math.ceil((d - todayMs) / 86400000);
    if (diff === 0) return { text: "today", urgent: true };
    if (diff === 1) return { text: "tomorrow", urgent: true };
    if (diff < 0) return { text: `${Math.abs(diff)} days ago`, urgent: false };
    if (diff <= 14) return { text: `in ${diff} days`, urgent: true };
    return { text: `in ${diff} days`, urgent: false };
  }

  function buildEntry(c: typeof allChanges[0], showCountdown: boolean): string {
    const badge = changeTypeBadge[c.change_type] ?? { label: c.change_type, color: "#8b949e" };
    const impactColor = c.impact === "high" ? "#f85149" : c.impact === "medium" ? "#d29922" : "#8b949e";
    const vendorSlug = toSlug(c.vendor);
    const countdown = showCountdown ? countdownLabel(c.date) : null;
    const urgentClass = countdown?.urgent ? " entry-urgent" : "";
    return `      <div class="exp-entry${urgentClass}">
        <div class="exp-left">
          ${countdown ? `<div class="exp-countdown${countdown.urgent ? " exp-countdown-urgent" : ""}">${countdown.text}</div>` : ""}
          <div class="exp-date">${c.date}</div>
        </div>
        <div class="exp-right">
          <div class="exp-head">
            <span class="badge" style="background:${badge.color}">${badge.label}</span>
            <a href="/vendor/${vendorSlug}" class="exp-vendor">${escHtmlServer(c.vendor)}</a>
            <span class="exp-impact" style="color:${impactColor}">${c.impact}</span>
          </div>
          <div class="exp-summary">${escHtmlServer(c.summary)}</div>
        </div>
      </div>`;
  }

  // Build upcoming months HTML
  const upcomingHtml = Array.from(upcomingByMonth.entries()).map(([month, changes]) => {
    const entriesHtml = changes.map(c => buildEntry(c, true)).join("\n");
    return `    <div class="month-group">
      <h2 class="month-heading">${formatMonth(month)}</h2>
${entriesHtml}
    </div>`;
  }).join("\n");

  // Build recently changed HTML
  const recentHtml = recent.length > 0 ? recent.map(c => buildEntry(c, false)).join("\n") : "";

  const totalUpcoming = upcoming.length;
  const urgentCount = upcoming.filter(c => {
    const diff = Math.ceil((new Date(c.date + "T00:00:00Z").getTime() - todayMs) / 86400000);
    return diff <= 14;
  }).length;

  const title = "Upcoming Free Tier Changes \u2014 AgentDeals";
  const metaDesc = `${totalUpcoming} upcoming pricing changes tracked. Free tiers disappearing, prices increasing, products shutting down. Don't get caught off guard.`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: title,
    description: metaDesc,
    numberOfItems: totalUpcoming + recent.length,
    url: `${BASE_URL}/expiring`,
    itemListElement: upcoming.slice(0, 50).map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "NewsArticle",
        headline: `${c.vendor}: ${(changeTypeBadge[c.change_type] ?? { label: c.change_type }).label}`,
        description: c.summary,
        datePublished: c.date,
        url: `${BASE_URL}/vendor/${toSlug(c.vendor)}`,
        publisher: { "@type": "Organization", name: "AgentDeals", url: BASE_URL },
      },
    })),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)}</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/expiring">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/expiring">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals \u2014 Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
.page-intro{color:var(--text-muted);font-size:.95rem;margin-bottom:1.5rem}
.stats-bar{display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:2rem}
.stat-card{flex:1;min-width:120px;padding:.75rem 1rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);text-align:center}
.stat-value{font-family:var(--serif);font-size:1.5rem;color:var(--text)}
.stat-label{font-family:var(--mono);font-size:.65rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.1em}
.stat-urgent .stat-value{color:#f85149}
.month-group{margin-bottom:2rem}
.month-heading{font-family:var(--serif);font-size:1.15rem;color:var(--text);margin-bottom:.75rem;padding-bottom:.5rem;border-bottom:1px solid var(--border)}
.exp-entry{display:flex;gap:1rem;padding:.75rem;margin-bottom:.5rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);transition:border-color .2s}
.exp-entry:hover{border-color:var(--accent)}
.entry-urgent{border-color:rgba(248,81,73,0.3)}
.exp-left{flex-shrink:0;min-width:100px;text-align:right}
.exp-countdown{font-family:var(--mono);font-size:.8rem;color:var(--text-muted);font-weight:600}
.exp-countdown-urgent{color:#f85149}
.exp-date{font-family:var(--mono);font-size:.7rem;color:var(--text-dim)}
.exp-right{flex:1;min-width:0}
.exp-head{display:flex;align-items:center;gap:.5rem;margin-bottom:.25rem;flex-wrap:wrap}
.exp-vendor{color:var(--text);font-weight:600;font-size:.85rem}
.exp-vendor:hover{color:var(--accent)}
.exp-impact{font-family:var(--mono);font-size:.7rem}
.exp-summary{font-size:.85rem;color:var(--text-muted)}
.badge{display:inline-block;padding:.1rem .4rem;border-radius:10px;font-size:.65rem;font-weight:600;color:#fff}
.recent-section{margin-top:2.5rem;padding-top:1.5rem;border-top:1px solid var(--border)}
.recent-section h2{font-family:var(--serif);font-size:1.15rem;color:var(--text);margin-bottom:.5rem}
.recent-desc{color:var(--text-dim);font-size:.85rem;margin-bottom:1rem}
.recent-toggle{background:none;border:1px solid var(--border);color:var(--accent);padding:.4rem .8rem;border-radius:6px;cursor:pointer;font-size:.8rem;font-family:var(--sans);margin-bottom:.75rem}
.recent-toggle:hover{border-color:var(--accent);background:var(--accent-glow)}
.recent-entries{display:none}
.recent-entries.show{display:block}
.no-upcoming{color:var(--text-dim);font-style:italic;padding:2rem;text-align:center;border:1px dashed var(--border);border-radius:8px}
.mcp-cta{margin-top:2.5rem;padding:1.5rem;border:1px solid var(--border);border-radius:12px;background:var(--accent-glow);text-align:center}
.mcp-cta p{color:var(--text-muted);font-size:.9rem;margin-bottom:.5rem}
.mcp-cta a{font-weight:600}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.stats-bar{flex-direction:column}.exp-entry{flex-direction:column;gap:.25rem}.exp-left{text-align:left;min-width:auto;display:flex;gap:.75rem;align-items:center}}
${globalNavCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("expiring")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; Expiring</div>
  <h1>Upcoming Free Tier Changes</h1>
  <p class="page-intro">Free tiers disappearing, prices increasing, products shutting down. Don\u2019t get caught off guard.</p>

  <div class="stats-bar">
    <div class="stat-card${urgentCount > 0 ? " stat-urgent" : ""}">
      <div class="stat-value">${urgentCount}</div>
      <div class="stat-label">Within 14 Days</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${totalUpcoming}</div>
      <div class="stat-label">Upcoming</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${recent.length}</div>
      <div class="stat-label">Recently Changed</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${allChanges.length}</div>
      <div class="stat-label">Total Tracked</div>
    </div>
  </div>

${totalUpcoming > 0 ? upcomingHtml : `  <div class="no-upcoming">No upcoming pricing changes in the next 30 days. Check back soon or <a href="/feed.xml">subscribe via RSS</a>.</div>`}

${recent.length > 0 ? `  <div class="recent-section">
    <h2>Recently Changed</h2>
    <p class="recent-desc">${recent.length} pricing changes in the last 30 days.</p>
    <button class="recent-toggle" onclick="document.querySelector('.recent-entries').classList.toggle('show');this.textContent=this.textContent==='Show recent changes'?'Hide recent changes':'Show recent changes'">Show recent changes</button>
    <div class="recent-entries">
${recent.map(c => buildEntry(c, false)).join("\n")}
    </div>
  </div>` : ""}

  <div class="mcp-cta">
    <p>Want real-time alerts when free tiers change?</p>
    <a href="/setup">Connect via MCP &rarr;</a>
  </div>

  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
</body>
</html>`;
}

// --- Data freshness dashboard ---

function freshnessGrade(score: number): { grade: string; color: string } {
  if (score >= 90) return { grade: "A", color: "#3fb950" };
  if (score >= 75) return { grade: "B", color: "#3b82f6" };
  if (score >= 60) return { grade: "C", color: "#d29922" };
  if (score >= 40) return { grade: "D", color: "#f85149" };
  return { grade: "F", color: "#f85149" };
}

function buildFreshnessPage(): string {
  const m = getFreshnessMetrics();
  const { grade, color: gradeColor } = freshnessGrade(m.freshness_score);

  const title = "Data Freshness Dashboard \u2014 AgentDeals";
  const metaDesc = `${m.total_offers} offers tracked. ${m.freshness_score}% verified within 90 days. Transparent data quality metrics for developer deal intelligence.`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "AgentDeals Data Freshness",
    description: metaDesc,
    url: `${BASE_URL}/freshness`,
    dateModified: new Date().toISOString().slice(0, 10),
    creator: { "@type": "Organization", name: "AgentDeals", url: BASE_URL },
  };

  // Category table rows
  const categoryRows = m.by_category.map((c) => {
    const { grade: catGrade, color: catColor } = freshnessGrade(c.freshness_score);
    return `        <tr>
          <td><a href="/category/${toSlug(c.category)}">${escHtmlServer(c.category)}</a></td>
          <td>${c.count}</td>
          <td>${c.avg_days_since_verified}d</td>
          <td><span style="color:${catColor};font-weight:600">${catGrade}</span> ${c.freshness_score}%</td>
        </tr>`;
  }).join("\n");

  // Stalest entries
  const stalestRows = m.stalest_entries.map((e) =>
    `        <tr>
          <td><a href="/vendor/${toSlug(e.vendor)}">${escHtmlServer(e.vendor)}</a></td>
          <td>${escHtmlServer(e.category)}</td>
          <td class="stale-date">${e.verifiedDate}</td>
          <td class="stale-days">${e.days_since_verified}d ago</td>
        </tr>`
  ).join("\n");

  // Freshest entries
  const freshestRows = m.freshest_entries.map((e) =>
    `        <tr>
          <td><a href="/vendor/${toSlug(e.vendor)}">${escHtmlServer(e.vendor)}</a></td>
          <td>${escHtmlServer(e.category)}</td>
          <td>${e.verifiedDate}</td>
          <td>${e.days_since_verified}d ago</td>
        </tr>`
  ).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)}</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/freshness">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/freshness">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
h2{font-family:var(--serif);font-size:1.15rem;color:var(--text);margin:2rem 0 .75rem;padding-bottom:.5rem;border-bottom:1px solid var(--border)}
.page-intro{color:var(--text-muted);font-size:.95rem;margin-bottom:1.5rem}
.grade-hero{display:flex;align-items:center;gap:2rem;margin-bottom:2rem;padding:1.5rem;border:1px solid var(--border);border-radius:12px;background:var(--bg-card)}
.grade-circle{width:100px;height:100px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:var(--serif);font-size:3rem;font-weight:700;flex-shrink:0}
.grade-details{flex:1}
.grade-score{font-family:var(--serif);font-size:1.5rem;font-weight:700;color:var(--text)}
.grade-explanation{color:var(--text-muted);font-size:.85rem;margin-top:.25rem}
.stats-bar{display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:2rem}
.stat-card{flex:1;min-width:120px;padding:.75rem 1rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);text-align:center}
.stat-value{font-family:var(--serif);font-size:1.5rem;color:var(--text)}
.stat-label{font-family:var(--mono);font-size:.65rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.1em}
.stat-pct{font-family:var(--mono);font-size:.75rem;color:var(--text-muted)}
table{width:100%;border-collapse:collapse;margin-bottom:1.5rem}
th{text-align:left;font-family:var(--mono);font-size:.7rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.1em;padding:.5rem .75rem;border-bottom:1px solid var(--border)}
td{padding:.5rem .75rem;font-size:.85rem;color:var(--text-muted);border-bottom:1px solid rgba(51,65,85,0.5)}
td a{color:var(--text);font-weight:500}
td a:hover{color:var(--accent)}
.stale-date{color:var(--text-dim)}
.stale-days{color:#f85149;font-family:var(--mono);font-size:.8rem}
.section-desc{color:var(--text-dim);font-size:.85rem;margin-bottom:1rem}
.toggle-btn{background:none;border:1px solid var(--border);color:var(--accent);padding:.4rem .8rem;border-radius:6px;cursor:pointer;font-size:.8rem;font-family:var(--sans);margin-bottom:.75rem}
.toggle-btn:hover{border-color:var(--accent);background:var(--accent-glow)}
.hidden-section{display:none}.hidden-section.show{display:block}
.mcp-cta{margin-top:2.5rem;padding:1.5rem;border:1px solid var(--border);border-radius:12px;background:var(--accent-glow);text-align:center}
.mcp-cta p{color:var(--text-muted);font-size:.9rem;margin-bottom:.5rem}
.mcp-cta a{font-weight:600}
.api-hint{color:var(--text-dim);font-size:.8rem;margin-top:.5rem;font-family:var(--mono)}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.stats-bar{flex-direction:column}.grade-hero{flex-direction:column;text-align:center;gap:1rem}table{font-size:.75rem}th,td{padding:.4rem .5rem}}
${globalNavCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("freshness")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; Freshness</div>
  <h1>Data Freshness Dashboard</h1>
  <p class="page-intro">Transparent data quality metrics. We track ${m.total_offers.toLocaleString()} offers \u2014 here\u2019s how fresh they are.</p>

  <div class="grade-hero">
    <div class="grade-circle" style="background:${gradeColor}20;color:${gradeColor};border:3px solid ${gradeColor}">${grade}</div>
    <div class="grade-details">
      <div class="grade-score">${m.freshness_score}% freshness score</div>
      <div class="grade-explanation">${m.verified_within_90_days.toLocaleString()} of ${m.total_offers.toLocaleString()} entries verified within the last 90 days.</div>
    </div>
  </div>

  <div class="stats-bar">
    <div class="stat-card">
      <div class="stat-value">${m.verified_within_7_days.toLocaleString()}</div>
      <div class="stat-label">Last 7 Days</div>
      <div class="stat-pct">${m.total_offers > 0 ? Math.round((m.verified_within_7_days / m.total_offers) * 100) : 0}%</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${m.verified_within_30_days.toLocaleString()}</div>
      <div class="stat-label">Last 30 Days</div>
      <div class="stat-pct">${m.total_offers > 0 ? Math.round((m.verified_within_30_days / m.total_offers) * 100) : 0}%</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${m.verified_within_90_days.toLocaleString()}</div>
      <div class="stat-label">Last 90 Days</div>
      <div class="stat-pct">${m.freshness_score}%</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${m.verified_within_180_days.toLocaleString()}</div>
      <div class="stat-label">Last 180 Days</div>
      <div class="stat-pct">${m.total_offers > 0 ? Math.round((m.verified_within_180_days / m.total_offers) * 100) : 0}%</div>
    </div>
  </div>

  <h2>Freshness by Category</h2>
  <p class="section-desc">${m.by_category.length} categories ranked by freshness score.</p>
  <table>
    <thead><tr><th>Category</th><th>Offers</th><th>Avg Age</th><th>Score</th></tr></thead>
    <tbody>
${categoryRows}
    </tbody>
  </table>

  <h2>Stalest Entries</h2>
  <p class="section-desc">Top 20 entries most in need of re-verification.</p>
  <table>
    <thead><tr><th>Vendor</th><th>Category</th><th>Verified</th><th>Age</th></tr></thead>
    <tbody>
${stalestRows}
    </tbody>
  </table>

  <h2>Recently Verified</h2>
  <p class="section-desc">Top 20 most recently verified entries.</p>
  <button class="toggle-btn" onclick="document.getElementById('freshest-table').classList.toggle('show');this.textContent=this.textContent==='Show recently verified'?'Hide recently verified':'Show recently verified'">Show recently verified</button>
  <div id="freshest-table" class="hidden-section">
    <table>
      <thead><tr><th>Vendor</th><th>Category</th><th>Verified</th><th>Age</th></tr></thead>
      <tbody>
${freshestRows}
      </tbody>
    </table>
  </div>

  <p class="api-hint">API: <a href="/api/freshness">/api/freshness</a> \u2014 get this data as JSON</p>

  <div class="mcp-cta">
    <p>Want AI-powered deal intelligence with freshness signals?</p>
    <a href="/setup">Connect via MCP &rarr;</a>
  </div>

  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
</body>
</html>`;
}

// --- Agent Stack Guide page ---

interface StackBundle {
  id: string;
  name: string;
  emoji: string;
  description: string;
  services: { role: string; vendorName: string }[];
}

const AGENT_STACK_BUNDLES: StackBundle[] = [
  {
    id: "rag",
    name: "RAG Agent",
    emoji: "\uD83D\uDD0D",
    description: "Retrieval-augmented generation — ingest documents, embed them, and answer questions with citations.",
    services: [
      { role: "Vector DB", vendorName: "Pinecone" },
      { role: "LLM API", vendorName: "Groq" },
      { role: "Compute", vendorName: "Vercel" },
      { role: "Database & Storage", vendorName: "Supabase" },
    ],
  },
  {
    id: "coding",
    name: "Autonomous Coding Agent",
    emoji: "\uD83E\uDD16",
    description: "An agent that writes code, runs tests, and ships PRs — the foundation for AI-powered development workflows.",
    services: [
      { role: "LLM API", vendorName: "OpenRouter" },
      { role: "CI/CD", vendorName: "GitHub Actions" },
      { role: "Monitoring", vendorName: "Grafana Cloud" },
      { role: "Auth", vendorName: "Clerk" },
    ],
  },
  {
    id: "pipeline",
    name: "Data Pipeline Agent",
    emoji: "\uD83D\uDD04",
    description: "Orchestrate data ingestion, transformation, and loading — ETL pipelines that run themselves.",
    services: [
      { role: "Database", vendorName: "Neon" },
      { role: "Queue & Cache", vendorName: "Upstash" },
      { role: "Object Storage", vendorName: "Cloudflare R2" },
      { role: "Monitoring", vendorName: "BetterStack" },
    ],
  },
  {
    id: "chat",
    name: "Chat / Customer Agent",
    emoji: "\uD83D\uDCAC",
    description: "Customer-facing conversational agent with auth, analytics, and fast inference.",
    services: [
      { role: "LLM API", vendorName: "Groq" },
      { role: "Database", vendorName: "Supabase" },
      { role: "Auth", vendorName: "Auth0" },
      { role: "Analytics", vendorName: "PostHog" },
    ],
  },
];

function buildAgentStackPage(): string {
  const title = "AI Agent Builder\u2019s Free Stack Guide \u2014 AgentDeals";
  const metaDesc = "Curated free-tier infrastructure stacks for AI agents \u2014 RAG, coding agents, data pipelines, and chatbots. $0/month to start.";

  // Resolve vendor data for each bundle
  const resolvedBundles = AGENT_STACK_BUNDLES.map((bundle) => {
    const resolvedServices = bundle.services.map((svc) => {
      const offer = offers.find((o) => o.vendor === svc.vendorName);
      return {
        role: svc.role,
        vendorName: svc.vendorName,
        slug: toSlug(svc.vendorName),
        category: offer?.category ?? "",
        tier: offer?.tier ?? "Free",
        description: offer?.description ?? "",
        url: offer?.url ?? "",
      };
    });
    return { ...bundle, resolvedServices };
  });

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: title,
    description: metaDesc,
    url: `${BASE_URL}/agent-stack`,
    datePublished: "2026-03-19",
    dateModified: new Date().toISOString().slice(0, 10),
    author: { "@type": "Organization", name: "AgentDeals", url: BASE_URL },
  };

  const bundleHtml = resolvedBundles.map((bundle) => {
    const serviceRows = bundle.resolvedServices.map((svc) => {
      const limits = svc.description;
      // Extract a concise limit string — first sentence or first 120 chars
      const shortLimits = limits.split(". ")[0].substring(0, 140);
      return `          <tr>
            <td class="role-cell">${escHtmlServer(svc.role)}</td>
            <td><a href="/vendor/${svc.slug}" class="vendor-link">${escHtmlServer(svc.vendorName)}</a> <span class="tier-badge">${escHtmlServer(svc.tier)}</span></td>
            <td class="limits-cell">${escHtmlServer(shortLimits)}</td>
            <td class="link-cell"><a href="${escHtmlServer(svc.url)}" target="_blank" rel="noopener">Pricing \u2192</a></td>
          </tr>`;
    }).join("\n");

    return `      <div class="stack-bundle" id="${bundle.id}">
        <div class="bundle-header">
          <span class="bundle-emoji">${bundle.emoji}</span>
          <div>
            <h2>${escHtmlServer(bundle.name)}</h2>
            <p class="bundle-desc">${escHtmlServer(bundle.description)}</p>
          </div>
        </div>
        <div class="bundle-cost">Total: <strong>$0/month</strong></div>
        <table>
          <thead><tr><th>Role</th><th>Service</th><th>Free Tier</th><th></th></tr></thead>
          <tbody>
${serviceRows}
          </tbody>
        </table>
      </div>`;
  }).join("\n\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)}</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/agent-stack">
<meta property="og:title" content="Free infrastructure stack for AI agents \u2014 $0/month">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/agent-stack">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--purple:#8b5cf6;--purple-glow:rgba(139,92,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
h2{font-family:var(--serif);font-size:1.3rem;color:var(--text);margin:0}
.page-intro{color:var(--text-muted);font-size:.95rem;margin-bottom:2rem;max-width:640px}
.stack-bundle{border:1px solid var(--border);border-radius:12px;background:var(--bg-card);padding:1.5rem;margin-bottom:1.5rem;transition:border-color .2s}
.stack-bundle:hover{border-color:var(--border-hover)}
.bundle-header{display:flex;align-items:flex-start;gap:1rem;margin-bottom:1rem}
.bundle-emoji{font-size:2rem;line-height:1;flex-shrink:0;margin-top:.1rem}
.bundle-desc{color:var(--text-muted);font-size:.85rem;margin-top:.25rem}
.bundle-cost{display:inline-block;background:var(--accent-glow);color:var(--accent);padding:.3rem .8rem;border-radius:20px;font-size:.85rem;margin-bottom:1rem;font-family:var(--mono)}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-family:var(--mono);font-size:.7rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.1em;padding:.5rem .75rem;border-bottom:1px solid var(--border)}
td{padding:.5rem .75rem;font-size:.85rem;color:var(--text-muted);border-bottom:1px solid rgba(51,65,85,0.5)}
.role-cell{color:var(--text);font-weight:500;white-space:nowrap}
.vendor-link{color:var(--text);font-weight:600}
.vendor-link:hover{color:var(--accent)}
.tier-badge{display:inline-block;font-size:.65rem;font-family:var(--mono);color:var(--purple);background:var(--purple-glow);padding:.1rem .4rem;border-radius:4px;vertical-align:middle;margin-left:.25rem;text-transform:uppercase;letter-spacing:.05em}
.limits-cell{font-size:.8rem;color:var(--text-dim);max-width:280px}
.link-cell{white-space:nowrap;font-size:.8rem}
.mcp-section{margin-top:2.5rem;padding:1.5rem;border:1px solid var(--border);border-radius:12px;background:var(--accent-glow)}
.mcp-section h3{font-family:var(--serif);font-size:1.1rem;margin:0 0 .5rem}
.mcp-section p{color:var(--text-muted);font-size:.85rem;margin-bottom:1rem}
.mcp-code{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:.75rem 1rem;font-family:var(--mono);font-size:.85rem;color:var(--accent);overflow-x:auto;white-space:pre;position:relative}
.mcp-code .copy-btn{position:absolute;top:.5rem;right:.5rem;background:var(--bg-elevated);border:1px solid var(--border);color:var(--text-muted);padding:.2rem .5rem;border-radius:4px;cursor:pointer;font-size:.7rem;font-family:var(--sans);transition:all .15s}
.mcp-code .copy-btn:hover{color:var(--text);border-color:var(--text-dim)}
.mcp-code .copy-btn.copied{color:var(--accent);border-color:var(--accent)}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.bundle-header{flex-direction:column;gap:.5rem}.limits-cell{max-width:160px}table{font-size:.75rem}th,td{padding:.4rem .5rem}}
${globalNavCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("best")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; <a href="/best">Best Of</a> &rsaquo; Agent Stack Guide</div>
  <h1>AI Agent Builder\u2019s Free Stack Guide</h1>
  <p class="page-intro">Curated free-tier infrastructure stacks for common AI agent patterns. Every service below has a real free tier \u2014 start building for $0/month.</p>

${bundleHtml}

  <div class="mcp-section">
    <h3>Get personalized recommendations via MCP</h3>
    <p>Use the <code>plan_stack</code> tool to get stack recommendations tailored to your specific project:</p>
    <div class="mcp-code"><button class="copy-btn" onclick="navigator.clipboard.writeText(this.parentElement.querySelector('.code-text').textContent).then(()=>{this.textContent='Copied!';this.classList.add('copied');setTimeout(()=>{this.textContent='Copy';this.classList.remove('copied')},2000)})">Copy</button><span class="code-text">plan_stack({ use_case: "I'm building a RAG agent for internal docs" })</span></div>
    <p style="margin-top:.75rem"><a href="/setup">Set up MCP client \u2192</a></p>
  </div>

  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
</body>
</html>`;
}

// --- Privacy policy page ---

function buildPrivacyPage(): string {
  const title = "Privacy Policy — AgentDeals";
  const metaDesc = "AgentDeals privacy policy. We are a read-only data server — no accounts, no cookies, no personal data collected.";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    description: metaDesc,
    url: `${BASE_URL}/privacy`,
    dateModified: new Date().toISOString().slice(0, 10),
    publisher: { "@type": "Organization", name: "AgentDeals", url: BASE_URL },
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)}</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/privacy">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/privacy">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:720px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
h2{font-family:var(--serif);font-size:1.2rem;color:var(--text);margin:2rem 0 .75rem}
.page-intro{color:var(--text-muted);font-size:.95rem;margin-bottom:2rem;max-width:640px}
.section{border:1px solid var(--border);border-radius:12px;background:var(--bg-card);padding:1.25rem 1.5rem;margin-bottom:1rem}
.section p,.section ul{color:var(--text-muted);font-size:.9rem;margin-bottom:.5rem}
.section ul{margin-left:1.25rem}
.section li{margin-bottom:.35rem}
.section p:last-child,.section ul:last-child{margin-bottom:0}
.updated{color:var(--text-dim);font-size:.8rem;font-style:italic;margin-top:2rem}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
footer a{color:var(--text-muted)}
@media(max-width:768px){h1{font-size:1.5rem}.section{padding:1rem}}
${globalNavCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("home")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; Privacy Policy</div>
  <h1>Privacy Policy</h1>
  <p class="page-intro">AgentDeals is a read-only data server that provides publicly available vendor pricing information. We have no user accounts, no cookies, and collect no personal data.</p>

  <h2>What We Collect</h2>
  <div class="section">
    <p><strong>Nothing personal.</strong> AgentDeals does not collect, store, or process any personal data. There are no user accounts, no login forms, no email collection, and no cookies.</p>
  </div>

  <h2>Server-Side Request Counting</h2>
  <div class="section">
    <p>We maintain basic, anonymous server-side request counters (page views per path) for operational monitoring. These counters:</p>
    <ul>
      <li>Contain no personally identifiable information</li>
      <li>Do not track individual users or sessions</li>
      <li>Do not use cookies, fingerprinting, or any client-side tracking</li>
      <li>Filter out known bot traffic</li>
    </ul>
  </div>

  <h2>What We Serve</h2>
  <div class="section">
    <p>AgentDeals serves publicly available information about vendor pricing, free tiers, and developer tool offers. All data is sourced from vendors\u2019 public pricing pages.</p>
  </div>

  <h2>MCP Server</h2>
  <div class="section">
    <p>When used as an MCP (Model Context Protocol) server, AgentDeals operates in read-only mode. All MCP tools are annotated with <code>readOnlyHint: true</code> and <code>destructiveHint: false</code>. The server:</p>
    <ul>
      <li>Only returns publicly available pricing data</li>
      <li>Does not write to or modify any external systems</li>
      <li>Does not collect or transmit data about the client or user</li>
      <li>Does not require authentication</li>
    </ul>
  </div>

  <h2>Third-Party Services</h2>
  <div class="section">
    <p>AgentDeals does not embed third-party analytics, advertising, or tracking scripts. We do not share data with third parties because we do not collect data to share.</p>
  </div>

  <h2>Open Source</h2>
  <div class="section">
    <p>AgentDeals is open source. You can inspect our entire codebase to verify these claims at <a href="https://github.com/robhunter/agentdeals">github.com/robhunter/agentdeals</a>.</p>
  </div>

  <h2>Contact</h2>
  <div class="section">
    <p>Questions about this policy? Open an issue on our <a href="https://github.com/robhunter/agentdeals/issues">GitHub repository</a>.</p>
  </div>

  <p class="updated">Last updated: March 20, 2026</p>

  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
</body>
</html>`;
}

// --- Web search page ---

function buildSearchPage(query: string, categoryFilter: string, page: number): string {
  const PAGE_SIZE = 50;
  const hasQuery = query.length > 0;

  // Search results
  let results: ReturnType<typeof enrichOffers> = [];
  let totalResults = 0;
  if (hasQuery || categoryFilter) {
    const raw = searchOffers(query || undefined, categoryFilter || undefined);
    totalResults = raw.length;
    const start = (page - 1) * PAGE_SIZE;
    results = enrichOffers(raw.slice(start, start + PAGE_SIZE));
  }

  const totalPages = Math.ceil(totalResults / PAGE_SIZE);
  const riskColors: Record<string, string> = { stable: "#3fb950", caution: "#d29922", risky: "#f85149" };

  // Category pills
  const catPillsHtml = categories.map(c => {
    const isActive = categoryFilter.toLowerCase() === c.name.toLowerCase();
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (!isActive) params.set("category", c.name);
    const href = `/search${params.toString() ? "?" + params.toString() : ""}`;
    return `<a href="${escHtmlServer(href)}" class="cat-filter${isActive ? " active" : ""}">${escHtmlServer(c.name)} <span class="cat-count">${c.count}</span></a>`;
  }).join("\n");

  // Results HTML
  const resultsHtml = results.map(r => {
    const risk = r.risk_level ?? "stable";
    const rc = riskColors[risk] ?? "#8b949e";
    return `<a href="/vendor/${toSlug(r.vendor)}" class="result-card">
        <div class="result-header">
          <span class="result-vendor">${escHtmlServer(r.vendor)}</span>
          <span class="risk-badge-sm" style="background:${rc}20;color:${rc};border:1px solid ${rc}40">${risk}</span>
          <span class="result-cat">${escHtmlServer(r.category)}</span>
        </div>
        <div class="result-tier">${escHtmlServer(r.tier)}</div>
        <div class="result-meta">Verified ${r.verifiedDate}${r.recent_change ? ` · <span style="color:#d29922">${escHtmlServer(r.recent_change)}</span>` : ""}${r.expires_soon ? ` · <span style="color:#f85149">${escHtmlServer(r.expires_soon)}</span>` : ""}</div>
      </a>`;
  }).join("\n");

  // Empty state / suggested searches
  const suggestedSearches = ["database", "hosting", "auth", "monitoring", "CI/CD", "email", "search", "storage"];
  const emptyStateHtml = hasQuery || categoryFilter ? `
    <div class="empty-state">
      <p>No results found${hasQuery ? ` for &ldquo;<strong>${escHtmlServer(query)}</strong>&rdquo;` : ""}${categoryFilter ? ` in ${escHtmlServer(categoryFilter)}` : ""}.</p>
      <p>Try a different search or browse categories above.</p>
      <div class="suggested">${suggestedSearches.map(s => `<a href="/search?q=${encodeURIComponent(s)}" class="suggest-pill">${escHtmlServer(s)}</a>`).join(" ")}</div>
    </div>` : `
    <div class="empty-state">
      <p>Search ${offers.length.toLocaleString()} free developer tools and services.</p>
      <p class="suggested-label">Popular searches:</p>
      <div class="suggested">${suggestedSearches.map(s => `<a href="/search?q=${encodeURIComponent(s)}" class="suggest-pill">${escHtmlServer(s)}</a>`).join(" ")}</div>
    </div>`;

  // Pagination
  const paginationHtml = totalPages > 1 ? (() => {
    const links: string[] = [];
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (categoryFilter) params.set("category", categoryFilter);
    if (page > 1) {
      const p = new URLSearchParams(params);
      p.set("page", String(page - 1));
      links.push(`<a href="/search?${p.toString()}" class="page-link">&larr; Prev</a>`);
    }
    links.push(`<span class="page-info">Page ${page} of ${totalPages} (${totalResults} results)</span>`);
    if (page < totalPages) {
      const p = new URLSearchParams(params);
      p.set("page", String(page + 1));
      links.push(`<a href="/search?${p.toString()}" class="page-link">Next &rarr;</a>`);
    }
    return `<div class="pagination">${links.join("")}</div>`;
  })() : totalResults > 0 ? `<div class="pagination"><span class="page-info">${totalResults} result${totalResults !== 1 ? "s" : ""}</span></div>` : "";

  const titleText = hasQuery ? `&ldquo;${escHtmlServer(query)}&rdquo; — Search Free Developer Tools — AgentDeals` : "Search Free Developer Tools — AgentDeals";
  const metaDescText = hasQuery
    ? `${totalResults} free developer tools matching "${query}". Compare free tiers, pricing stability, and alternatives.`
    : `Search ${offers.length.toLocaleString()} free developer tools and services. Compare free tiers, pricing changes, and risk levels.`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SearchResultsPage",
    name: hasQuery ? `"${query}" — Search Free Developer Tools — AgentDeals` : "Search Free Developer Tools — AgentDeals",
    description: metaDescText,
    url: `${BASE_URL}/search${hasQuery ? "?q=" + encodeURIComponent(query) : ""}`,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titleText}</title>
<meta name="description" content="${escHtmlServer(metaDescText)}">
<link rel="canonical" href="${BASE_URL}/search">
<meta property="og:title" content="${titleText}">
<meta property="og:description" content="${escHtmlServer(metaDescText)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/search">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 1.5rem;letter-spacing:-.02em}
.search-box{margin-bottom:1.5rem}
.search-form{display:flex;gap:.5rem}
.search-input{flex:1;padding:.75rem 1rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:var(--sans);font-size:1rem;outline:none;transition:border-color .2s}
.search-input:focus{border-color:var(--accent)}
.search-input::placeholder{color:var(--text-dim)}
.search-btn{padding:.75rem 1.5rem;background:var(--accent);color:var(--bg);border:none;border-radius:8px;font-weight:600;cursor:pointer;font-family:var(--sans);font-size:.95rem;transition:background .2s}
.search-btn:hover{background:var(--accent-hover)}
.cat-filters{display:flex;flex-wrap:wrap;gap:.3rem;margin-bottom:1.5rem;max-height:120px;overflow-y:auto;padding:.25rem 0}
.cat-filter{display:inline-flex;align-items:center;gap:.3rem;padding:.25rem .6rem;border:1px solid var(--border);border-radius:16px;font-size:.75rem;color:var(--text-muted);transition:all .2s;text-decoration:none}
.cat-filter:hover{border-color:var(--accent);color:var(--text);text-decoration:none}
.cat-filter.active{background:var(--accent-glow);border-color:var(--accent);color:var(--accent)}
.cat-count{font-family:var(--mono);font-size:.65rem;color:var(--text-dim)}
.results{display:flex;flex-direction:column;gap:.5rem}
.result-card{display:block;padding:.75rem 1rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);transition:border-color .2s;text-decoration:none}
.result-card:hover{border-color:var(--accent);text-decoration:none}
.result-header{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.2rem}
.result-vendor{font-weight:600;color:var(--text);font-size:.95rem}
.risk-badge-sm{display:inline-block;padding:.05rem .35rem;border-radius:8px;font-size:.6rem;font-weight:600}
.result-cat{font-size:.7rem;color:var(--text-dim);margin-left:auto}
.result-tier{font-family:var(--mono);font-size:.8rem;color:var(--text-muted);margin-bottom:.2rem}
.result-meta{font-size:.75rem;color:var(--text-dim)}
.empty-state{text-align:center;padding:3rem 1rem;color:var(--text-muted)}
.empty-state p{margin-bottom:.75rem}
.suggested-label{font-size:.85rem;color:var(--text-dim);margin-bottom:.5rem}
.suggested{display:flex;flex-wrap:wrap;gap:.4rem;justify-content:center;margin-top:.5rem}
.suggest-pill{display:inline-block;padding:.3rem .7rem;border:1px solid var(--border);border-radius:16px;font-size:.8rem;color:var(--text-muted);transition:all .2s}
.suggest-pill:hover{border-color:var(--accent);color:var(--text);text-decoration:none}
.pagination{display:flex;align-items:center;justify-content:center;gap:1rem;padding:1.5rem 0;color:var(--text-dim);font-size:.85rem}
.page-link{padding:.4rem .8rem;border:1px solid var(--border);border-radius:6px;color:var(--text-muted);transition:all .2s}
.page-link:hover{border-color:var(--accent);color:var(--text);text-decoration:none}
.page-info{font-family:var(--mono);font-size:.8rem}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.search-form{flex-direction:column}.result-cat{margin-left:0}}
${globalNavCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("search")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; Search</div>
  <h1>Search Free Developer Tools</h1>

  <div class="search-box">
    <form class="search-form" action="/search" method="get">
      <input type="text" name="q" class="search-input" placeholder="Search ${offers.length.toLocaleString()} free tools..." value="${escHtmlServer(query)}" autofocus>
      ${categoryFilter ? `<input type="hidden" name="category" value="${escHtmlServer(categoryFilter)}">` : ""}
      <button type="submit" class="search-btn">Search</button>
    </form>
  </div>

  <div class="cat-filters">
${catPillsHtml}
  </div>

  ${totalResults > 0 ? `<div class="results">\n${resultsHtml}\n  </div>\n  ${paginationHtml}` : emptyStateHtml}

  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
</body>
</html>`;
}

// --- Pricing trends pages ---

// Negative change types that indicate prices rising / free tiers shrinking
const NEGATIVE_TYPES = new Set(["free_tier_removed", "limits_reduced", "restriction", "open_source_killed", "product_deprecated"]);
const POSITIVE_TYPES = new Set(["new_free_tier", "limits_increased", "startup_program_expanded"]);

function getTrendDirection(changes: Array<{ change_type: string }>): "rising" | "stable" | "declining" {
  let neg = 0, pos = 0;
  for (const c of changes) {
    if (NEGATIVE_TYPES.has(c.change_type)) neg++;
    if (POSITIVE_TYPES.has(c.change_type)) pos++;
  }
  if (neg === 0 && pos === 0) return "stable";
  if (neg > pos) return "rising"; // prices rising = bad
  if (pos > neg) return "declining"; // prices declining = good
  return "stable";
}

const trendEmoji: Record<string, { icon: string; color: string; label: string }> = {
  rising: { icon: "&#x2191;", color: "#f85149", label: "Prices rising" },
  stable: { icon: "&#x2194;", color: "#8b949e", label: "Stable" },
  declining: { icon: "&#x2193;", color: "#3fb950", label: "Prices declining" },
};

function buildTrendsIndexPage(): string {
  const allChanges = loadDealChanges();

  // Group changes by category
  const byCat = new Map<string, typeof allChanges>();
  for (const c of allChanges) {
    if (!byCat.has(c.category)) byCat.set(c.category, []);
    byCat.get(c.category)!.push(c);
  }

  // Sort categories by change count (most volatile first)
  const sorted = Array.from(byCat.entries()).sort((a, b) => b[1].length - a[1].length);

  // Also include categories with zero changes
  const allCatNames = new Set(categories.map(c => c.name));
  const categoriesWithChanges = new Set(byCat.keys());
  const zeroCats = [...allCatNames].filter(c => !categoriesWithChanges.has(c)).sort();

  const totalCategories = allCatNames.size;
  const title = `Pricing Trends by Category — AgentDeals`;
  const metaDesc = `Pricing trends across ${totalCategories} developer tool categories. See which categories have rising prices, free tier removals, and new deals.`;

  const catRows = sorted.map(([cat, changes]) => {
    const dir = getTrendDirection(changes);
    const t = trendEmoji[dir];
    const negCount = changes.filter(c => NEGATIVE_TYPES.has(c.change_type)).length;
    const posCount = changes.filter(c => POSITIVE_TYPES.has(c.change_type)).length;
    return `      <a href="/trends/${toSlug(cat)}" class="trend-row">
        <span class="trend-cat">${escHtmlServer(cat)}</span>
        <span class="trend-dir" style="color:${t.color}">${t.icon} ${t.label}</span>
        <span class="trend-stats">${changes.length} change${changes.length !== 1 ? "s" : ""} ${negCount > 0 ? `<span style="color:#f85149">${negCount} neg</span>` : ""} ${posCount > 0 ? `<span style="color:#3fb950">${posCount} pos</span>` : ""}</span>
      </a>`;
  }).join("\n");

  const zeroCatRows = zeroCats.map(cat => `      <a href="/trends/${toSlug(cat)}" class="trend-row">
        <span class="trend-cat">${escHtmlServer(cat)}</span>
        <span class="trend-dir" style="color:#8b949e">&#x2194; Stable</span>
        <span class="trend-stats">0 changes</span>
      </a>`).join("\n");

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Pricing Trends by Category",
    description: metaDesc,
    numberOfItems: totalCategories,
    url: `${BASE_URL}/trends`,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)}</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/trends">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/trends">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
.page-meta{color:var(--text-muted);margin-bottom:2rem;font-size:.95rem}
.trend-list{display:flex;flex-direction:column;gap:.4rem;margin-bottom:2rem}
.trend-row{display:grid;grid-template-columns:1fr auto auto;gap:1rem;align-items:center;padding:.6rem 1rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);transition:all .2s;text-decoration:none}
.trend-row:hover{border-color:var(--accent);background:var(--accent-glow);text-decoration:none}
.trend-cat{color:var(--text);font-weight:600;font-size:.9rem}
.trend-dir{font-family:var(--mono);font-size:.8rem;white-space:nowrap}
.trend-stats{font-size:.8rem;color:var(--text-dim);font-family:var(--mono);text-align:right;white-space:nowrap}
.section-label{font-family:var(--mono);font-size:.7rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.1em;margin:1.5rem 0 .5rem;padding-bottom:.25rem;border-bottom:1px solid var(--border)}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.trend-row{grid-template-columns:1fr;gap:.25rem}}
${globalNavCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("trends")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; Pricing Trends</div>
  <h1>Pricing Trends by Category</h1>
  <p class="page-meta">${allChanges.length} tracked pricing changes across ${totalCategories} categories. Ranked by volatility.</p>
  <div class="section-label">Categories with pricing changes</div>
  <div class="trend-list">
${catRows}
  </div>
${zeroCats.length > 0 ? `  <div class="section-label">Stable categories (no tracked changes)</div>
  <div class="trend-list">
${zeroCatRows}
  </div>` : ""}
  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
</body>
</html>`;
}

function buildTrendsPage(slug: string): string | null {
  const categoryName = categorySlugMap.get(slug);
  if (!categoryName) return null;

  const allChanges = loadDealChanges();
  const catChanges = allChanges.filter(c => c.category === categoryName).sort((a, b) => b.date.localeCompare(a.date));
  const catOffers = offers.filter(o => o.category === categoryName);
  const enriched = enrichOffers(catOffers);

  const direction = getTrendDirection(catChanges);
  const t = trendEmoji[direction];

  // Change type breakdown
  const typeBreakdown = new Map<string, number>();
  for (const c of catChanges) {
    typeBreakdown.set(c.change_type, (typeBreakdown.get(c.change_type) ?? 0) + 1);
  }

  // At-risk vendors (risky or caution)
  const atRisk = enriched.filter(o => o.risk_level === "risky" || o.risk_level === "caution")
    .sort((a, b) => (a.risk_level === "risky" ? 0 : 1) - (b.risk_level === "risky" ? 0 : 1));

  // Stable picks (stable risk, no recent changes)
  const stablePicks = enriched.filter(o => o.risk_level === "stable" && !o.recent_change).slice(0, 12);

  // Overall stats
  const totalAll = allChanges.length;
  const categoryPct = totalAll > 0 ? Math.round((catChanges.length / totalAll) * 100) : 0;

  const title = `${categoryName} Pricing Trends — AgentDeals`;
  const metaDesc = `Pricing trends for ${categoryName}: ${catChanges.length} tracked changes across ${catOffers.length} vendors. Direction: ${t.label.toLowerCase()}.`;

  // Timeline HTML
  const timelineHtml = catChanges.length > 0 ? catChanges.map(c => {
    const badge = changeTypeBadge[c.change_type] ?? { label: c.change_type, color: "#8b949e" };
    return `      <div class="timeline-item" style="border-left-color:${badge.color}">
        <div class="timeline-head">
          <span class="badge" style="background:${badge.color}">${badge.label}</span>
          <a href="/vendor/${toSlug(c.vendor)}" class="timeline-vendor">${escHtmlServer(c.vendor)}</a>
          <span class="timeline-date">${c.date}</span>
          <span class="impact impact-${c.impact}">${c.impact}</span>
        </div>
        <div class="timeline-summary">${escHtmlServer(c.summary)}</div>
      </div>`;
  }).join("\n") : `<p class="no-data">No pricing changes tracked for ${escHtmlServer(categoryName)}. All vendors in this category have stable pricing.</p>`;

  // Breakdown HTML
  const breakdownHtml = Array.from(typeBreakdown.entries()).sort((a, b) => b[1] - a[1]).map(([type, count]) => {
    const badge = changeTypeBadge[type] ?? { label: type, color: "#8b949e" };
    return `<span class="breakdown-item"><span class="badge" style="background:${badge.color}">${badge.label}</span> ${count}</span>`;
  }).join(" ");

  const riskColors: Record<string, string> = { stable: "#3fb950", caution: "#d29922", risky: "#f85149" };

  // At-risk HTML
  const atRiskHtml = atRisk.length > 0 ? `
  <div class="section">
    <h2>At-Risk Vendors</h2>
    <div class="vendor-list">
${atRisk.map(o => {
    const rc = riskColors[o.risk_level ?? ""] ?? "#8b949e";
    return `      <a href="/vendor/${toSlug(o.vendor)}" class="vendor-item">
        <span class="vi-name">${escHtmlServer(o.vendor)}</span>
        <span class="vi-risk" style="color:${rc}">${o.risk_level}</span>
        ${o.recent_change ? `<span class="vi-change">${escHtmlServer(o.recent_change)}</span>` : ""}
      </a>`;
  }).join("\n")}
    </div>
  </div>` : "";

  // Stable picks HTML
  const stableHtml = stablePicks.length > 0 ? `
  <div class="section">
    <h2>Stable Picks</h2>
    <p class="section-desc">Vendors with no recent pricing changes and low risk scores.</p>
    <div class="stable-grid">
${stablePicks.map(o => `      <a href="/vendor/${toSlug(o.vendor)}" class="stable-card">
        <span class="stable-name">${escHtmlServer(o.vendor)}</span>
        <span class="stable-tier">${escHtmlServer(o.tier)}</span>
      </a>`).join("\n")}
    </div>
  </div>` : "";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    description: metaDesc,
    url: `${BASE_URL}/trends/${slug}`,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtmlServer(title)}</title>
<meta name="description" content="${escHtmlServer(metaDesc)}">
<link rel="canonical" href="${BASE_URL}/trends/${slug}">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}/trends/${slug}">
${OG_IMAGE_META}${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);--border:#334155;--border-hover:#3b82f6;--text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);--serif:'Inter',-apple-system,sans-serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem}
.breadcrumb{padding:1.5rem 0 0;font-size:.8rem;color:var(--text-dim)}
.breadcrumb a{color:var(--text-muted)}
h1{font-family:var(--serif);font-size:2.25rem;color:var(--text);margin:1rem 0 .5rem;letter-spacing:-.02em}
.page-meta{color:var(--text-muted);margin-bottom:1.5rem;font-size:.95rem}
.stats-bar{display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:2rem}
.stat-card{flex:1;min-width:120px;padding:.75rem 1rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);text-align:center}
.stat-value{font-family:var(--serif);font-size:1.5rem;color:var(--text)}
.stat-label{font-family:var(--mono);font-size:.65rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.1em}
.breakdown{margin-bottom:2rem;display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.breakdown-item{display:inline-flex;align-items:center;gap:.3rem;font-size:.8rem;color:var(--text-muted)}
.section{margin-bottom:2rem;padding-top:1.5rem;border-top:1px solid var(--border)}
.section h2{font-family:var(--serif);font-size:1.15rem;color:var(--text);margin-bottom:.75rem}
.section-desc{color:var(--text-dim);font-size:.85rem;margin-bottom:.75rem}
.badge{display:inline-block;padding:.1rem .4rem;border-radius:10px;font-size:.65rem;font-weight:600;color:#fff}
.timeline-item{margin-bottom:.75rem;padding:.6rem .75rem .6rem 1rem;border-left:3px solid var(--border);background:var(--bg-card);border-radius:0 8px 8px 0}
.timeline-head{display:flex;align-items:center;gap:.5rem;margin-bottom:.25rem;flex-wrap:wrap}
.timeline-vendor{color:var(--text);font-weight:600;font-size:.85rem}
.timeline-date{font-family:var(--mono);font-size:.75rem;color:var(--text-dim)}
.impact{font-size:.7rem}.impact-high{color:#f85149}.impact-medium{color:#d29922}.impact-low{color:#8b949e}
.timeline-summary{font-size:.85rem;color:var(--text-muted)}
.no-data{color:var(--text-dim);font-size:.9rem;font-style:italic}
.vendor-list{display:flex;flex-direction:column;gap:.4rem}
.vendor-item{display:grid;grid-template-columns:1fr auto auto;gap:.75rem;align-items:center;padding:.5rem .75rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);transition:all .2s;text-decoration:none}
.vendor-item:hover{border-color:var(--accent);background:var(--accent-glow);text-decoration:none}
.vi-name{color:var(--text);font-weight:600;font-size:.85rem}
.vi-risk{font-family:var(--mono);font-size:.75rem;font-weight:600}
.vi-change{font-size:.75rem;color:var(--text-dim);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stable-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:.5rem}
.stable-card{display:block;padding:.5rem .75rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);transition:all .2s;text-decoration:none}
.stable-card:hover{border-color:var(--accent);background:var(--accent-glow);text-decoration:none}
.stable-name{display:block;color:var(--text);font-weight:600;font-size:.85rem}
.stable-tier{display:block;color:var(--text-dim);font-family:var(--mono);font-size:.7rem;margin-top:.1rem}
.nav-links{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:1rem}
.nav-link{display:inline-block;padding:.25rem .6rem;border:1px solid var(--border);border-radius:20px;font-size:.75rem;color:var(--text-muted);transition:all .2s}
.nav-link:hover{border-color:var(--accent);color:var(--text);text-decoration:none}
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
@media(max-width:768px){h1{font-size:1.5rem}.stats-bar{flex-direction:column}.vendor-item{grid-template-columns:1fr}}
${globalNavCss()}
</style>
</head>
<body>
<div class="container">
  ${buildGlobalNav("trends")}
  <div class="breadcrumb"><a href="/">AgentDeals</a> &rsaquo; <a href="/trends">Trends</a> &rsaquo; ${escHtmlServer(categoryName)}</div>
  <h1>${escHtmlServer(categoryName)} Pricing Trends</h1>
  <p class="page-meta">Pricing direction: <span style="color:${t.color};font-weight:600">${t.icon} ${t.label}</span></p>

  <div class="stats-bar">
    <div class="stat-card">
      <div class="stat-value">${catOffers.length}</div>
      <div class="stat-label">Vendors</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${catChanges.length}</div>
      <div class="stat-label">Changes Tracked</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${categoryPct}%</div>
      <div class="stat-label">of All Changes</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${atRisk.length}</div>
      <div class="stat-label">At-Risk Vendors</div>
    </div>
  </div>

  ${breakdownHtml ? `<div class="breakdown">${breakdownHtml}</div>` : ""}

  <div class="section">
    <h2>Pricing Change Timeline</h2>
    <div class="timeline">
${timelineHtml}
    </div>
  </div>
${atRiskHtml}
${stableHtml}
  <div class="section">
    <h2>Related</h2>
    <div class="nav-links">
      <a href="/category/${slug}" class="nav-link">Browse ${escHtmlServer(categoryName)} deals</a>
      <a href="/trends" class="nav-link">All category trends</a>
    </div>
  </div>

  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
</body>
</html>`;
}

function buildLandingPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentDeals — Pricing Context for AI Agents</title>
<meta name="description" content="${stats.offers}+ developer infrastructure deals across ${stats.categories} categories. Give your AI agent pricing context for better vendor recommendations, or browse deals directly.">
<meta property="og:title" content="AgentDeals — Pricing Context for AI Agents">
<meta property="og:description" content="Your AI recommends tools from memory. Memory doesn't include pricing. ${stats.offers}+ deals across ${stats.categories} categories.">
<meta property="og:type" content="website">
<meta property="og:url" content="${BASE_URL}">
${OG_IMAGE_META}<meta name="twitter:title" content="AgentDeals — Pricing Context for AI Agents">
<meta name="twitter:description" content="Your AI recommends tools from memory. Memory doesn't include pricing. ${stats.offers}+ deals across ${stats.categories} categories.">
${GOOGLE_VERIFICATION_META}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
<link rel="canonical" href="${BASE_URL}/">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "name": "AgentDeals",
      "url": "${BASE_URL}",
      "description": "${stats.offers}+ developer infrastructure deals across ${stats.categories} categories. Pricing context for AI agents.",
      "potentialAction": {
        "@type": "SearchAction",
        "target": "${BASE_URL}/api/offers?q={search_term_string}",
        "query-input": "required name=search_term_string"
      }
    },
    {
      "@type": "ItemList",
      "name": "Developer Tool Deals",
      "description": "Free tiers, credits, and discounts from developer infrastructure companies",
      "numberOfItems": ${stats.offers},
      "itemListElement": ${JSON.stringify([...categories].sort((a, b) => b.count - a.count).slice(0, 10).map((c, i) => ({
        "@type": "ListItem",
        "position": i + 1,
        "name": c.name,
        "description": c.count + " deals in " + c.name
      })))}
    },
    {
      "@type": "SoftwareApplication",
      "name": "AgentDeals MCP Server",
      "applicationCategory": "DeveloperApplication",
      "operatingSystem": "Any",
      "url": "${BASE_URL}/mcp",
      "description": "Model Context Protocol server providing AI agents with real-time developer tool pricing data"
    }
  ]
}
</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0f172a;--bg-elevated:#1e293b;--bg-card:rgba(255,255,255,0.06);
  --border:#334155;--border-hover:#3b82f6;
  --text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#64748b;
  --accent:#3b82f6;--accent-hover:#60a5fa;--accent-glow:rgba(59,130,246,0.15);
  --accent-purple:#8b5cf6;--accent-cyan:#06b6d4;
  --serif:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --sans:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --mono:'JetBrains Mono',SFMono-Regular,Consolas,monospace;
}
body{font-family:var(--sans);background:linear-gradient(180deg,#0f172a 0%,#1e293b 100%);color:var(--text);line-height:1.6;position:relative;min-height:100vh}
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(255,255,255,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.03) 1px,transparent 1px);background-size:200px 200px;pointer-events:none;z-index:0}
a{color:var(--accent);text-decoration:none}
a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem;position:relative;z-index:1}
.accent-bar{width:100%;height:4px;background:linear-gradient(90deg,#3b82f6,#8b5cf6);position:fixed;top:0;left:0;z-index:100}

/* Hero */
.hero{text-align:center;padding:5rem 0 3rem}
.hero-label{display:inline-block;font-family:var(--mono);font-size:.75rem;font-weight:500;color:var(--accent);text-transform:uppercase;letter-spacing:.15em;border:1px solid var(--border);border-radius:20px;padding:.35rem 1rem;margin-bottom:1.5rem;background:var(--accent-glow)}
.hero h1{font-family:var(--sans);font-size:3.5rem;color:var(--text);line-height:1.1;margin-bottom:1rem;letter-spacing:-.02em;font-weight:700}
.hero h1 em{font-style:normal;background:linear-gradient(90deg,#3b82f6,#8b5cf6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.hero-sub{font-size:1.15rem;color:var(--text-muted);max-width:520px;margin:0 auto 2rem;line-height:1.7}
.hero-actions{display:flex;justify-content:center;gap:1rem;flex-wrap:wrap}
.btn-primary{display:inline-flex;align-items:center;gap:.5rem;padding:.75rem 1.75rem;background:linear-gradient(90deg,#3b82f6,#8b5cf6);color:#fff;border-radius:8px;font-size:.95rem;font-weight:600;transition:all .2s;border:none;cursor:pointer}
.btn-primary:hover{opacity:.9;text-decoration:none;transform:translateY(-1px);box-shadow:0 4px 20px rgba(59,130,246,0.3)}
.btn-secondary{display:inline-flex;align-items:center;gap:.5rem;padding:.75rem 1.75rem;background:transparent;color:var(--text);border-radius:8px;font-size:.95rem;font-weight:500;transition:all .2s;border:1px solid var(--border)}
.btn-secondary:hover{border-color:var(--accent);color:var(--accent);text-decoration:none}

/* Stats bar */
.stats-bar{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin:0 auto 4rem;max-width:640px;background:var(--bg-card);backdrop-filter:blur(12px)}
.stat-item{text-align:center;padding:1.25rem 1rem;position:relative}
.stat-item+.stat-item::before{content:'';position:absolute;left:0;top:20%;height:60%;width:1px;background:var(--border)}
.stat-num{font-family:var(--mono);font-size:1.75rem;font-weight:700;color:var(--accent);letter-spacing:-.02em}
.stat-num.stat-purple{color:var(--accent-purple)}
.stat-num.stat-cyan{color:var(--accent-cyan)}
.stat-label{font-size:.75rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.1em;margin-top:.15rem}

/* Section divider */
.divider{width:100%;height:1px;background:var(--border);margin:0}
.wavy-divider{width:100%;overflow:hidden;line-height:0;margin:0}
.wavy-divider svg{display:block;width:100%;height:40px}

/* Sections */
.section{padding:4rem 0}
.section-label{font-family:var(--mono);font-size:.7rem;font-weight:500;color:var(--accent);text-transform:uppercase;letter-spacing:.2em;margin-bottom:.75rem}
.section h2{font-family:var(--sans);font-size:2rem;color:var(--text);margin-bottom:1rem;letter-spacing:-.01em;font-weight:700}
.section p{color:var(--text-muted);margin-bottom:1rem;max-width:600px}

/* Problem / solution */
.problem-text{font-family:var(--sans);font-size:1.35rem;color:var(--text-muted);line-height:1.6;max-width:600px;margin-bottom:1rem}
.problem-text strong{color:var(--text)}

/* How it works cards */
.how-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-top:2rem}
.how-card{background:var(--bg-card);backdrop-filter:blur(12px);border:1px solid var(--border);border-radius:12px;padding:1.5rem;transition:border-color .2s}
.how-card:hover{border-color:var(--accent)}
.how-card-icon{font-family:var(--mono);font-size:.75rem;color:var(--accent);background:var(--accent-glow);display:inline-block;padding:.3rem .7rem;border-radius:6px;margin-bottom:.75rem;border:1px solid rgba(59,130,246,0.2)}
.how-card h3{font-family:var(--sans);font-size:1.1rem;color:var(--text);margin-bottom:.5rem;font-weight:600}
.how-card p{font-size:.9rem;color:var(--text-muted);margin-bottom:.75rem}
.how-card pre{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:.75rem;font-size:.75rem;color:var(--text-muted);line-height:1.5;overflow-x:auto}
.how-card code{font-family:var(--mono);font-size:.75rem}

/* Changes */
.change-entry{padding:.75rem 0;border-bottom:1px solid rgba(51,65,85,0.6)}
.change-entry:last-child{border-bottom:none}
.change-header{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.2rem}
.change-badge{display:inline-block;padding:.15rem .5rem;border-radius:10px;font-size:.65rem;font-weight:600;color:#fff;text-transform:uppercase;letter-spacing:.04em;font-family:var(--mono)}
.change-vendor{font-weight:600;color:var(--text);font-size:.9rem}
.change-date{font-family:var(--mono);color:var(--text-dim);font-size:.75rem;margin-left:auto}
.change-summary{color:var(--text-muted);font-size:.85rem}
.see-all-link{display:inline-flex;align-items:center;gap:.3rem;margin-top:1rem;font-size:.85rem;font-family:var(--mono);color:var(--accent);text-decoration:none;padding:.5rem 0}
.see-all-link:hover{color:var(--accent-hover);text-decoration:underline}

/* Recent Changes Section */
.rc-list{display:flex;flex-direction:column;gap:.5rem;margin-top:1rem}
.rc-entry{padding:.75rem 1rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);transition:border-color .2s}
.rc-entry:hover{border-color:var(--accent)}
.rc-head{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.25rem}
.rc-vendor{font-weight:600;color:var(--text);font-size:.9rem;text-decoration:none}
.rc-vendor:hover{color:var(--accent)}
.rc-date{font-family:var(--mono);color:var(--text-dim);font-size:.75rem;margin-left:auto}
.rc-summary{color:var(--text-muted);font-size:.85rem}

/* Deadlines */
.deadlines-section{background:linear-gradient(180deg,rgba(248,81,73,0.04) 0%,transparent 100%);border:1px solid rgba(248,81,73,0.15);border-radius:12px;padding:1.5rem;margin-bottom:2rem}
.deadline-item{display:flex;gap:1rem;padding:.75rem 0;border-bottom:1px solid rgba(51,65,85,0.6);align-items:flex-start}
.deadline-item:last-child{border-bottom:none}
.deadline-item.deadline-urgent .deadline-countdown{animation:pulse-urgent 2s ease-in-out infinite}
@keyframes pulse-urgent{0%,100%{opacity:1}50%{opacity:.7}}
.deadline-left{flex-shrink:0}
.deadline-countdown{width:52px;text-align:center;border:2px solid;border-radius:8px;padding:.3rem .25rem;background:var(--bg)}
.deadline-days{display:block;font-family:var(--mono);font-size:1.25rem;font-weight:600;color:var(--text);line-height:1}
.deadline-unit{display:block;font-size:.6rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em;margin-top:.1rem}
.deadline-right{flex:1;min-width:0}
.deadline-header{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.2rem}
.deadline-date{font-family:var(--mono);color:var(--text-dim);font-size:.75rem;margin-left:auto}

/* Changing Soon */
.cs-list{display:flex;flex-direction:column;gap:0}
.cs-entry{display:flex;gap:1rem;padding:.75rem 0;border-bottom:1px solid rgba(51,65,85,0.6);align-items:flex-start}
.cs-entry:last-child{border-bottom:none}
.cs-countdown{flex-shrink:0;width:52px;text-align:center;border:2px solid var(--accent);border-radius:8px;padding:.3rem .25rem;background:var(--bg);font-family:var(--mono);font-size:1.25rem;font-weight:600;color:var(--text);line-height:1}
.cs-countdown.cs-urgent{border-color:#f85149;animation:pulse-urgent 2s ease-in-out infinite}
.cs-unit{display:block;font-size:.6rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em;margin-top:.1rem;font-weight:400}
.cs-detail{flex:1;min-width:0}
.cs-head{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.2rem}
.cs-vendor{color:var(--accent);text-decoration:none;font-weight:500}
.cs-vendor:hover{text-decoration:underline}
.cs-rel{font-family:var(--mono);color:var(--text-dim);font-size:.75rem;margin-left:auto}
.cs-summary{color:var(--text-muted);font-size:.85rem;line-height:1.4}

/* Browse */
.browse-controls{margin-bottom:1.25rem}
.search-input{width:100%;padding:.75rem 1rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px;color:var(--text);font-family:var(--sans);font-size:.9rem;outline:none;transition:border-color .2s}
.search-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow)}
.search-input::placeholder{color:var(--text-dim)}
.category-pills{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.75rem}
.cat-pill{display:inline-block;padding:.25rem .7rem;border-radius:20px;font-size:.75rem;font-weight:500;background:transparent;color:var(--text-muted);border:1px solid var(--border);cursor:pointer;transition:all .2s;font-family:var(--sans)}
.cat-pill:hover{border-color:var(--accent);color:var(--text)}
.cat-pill.active{background:var(--accent);border-color:var(--accent);color:var(--bg);font-weight:600}
.deal-cards{display:grid;gap:.75rem;margin-top:1rem}
.deal-card{background:var(--bg-card);backdrop-filter:blur(12px);border:1px solid var(--border);border-radius:10px;padding:1rem 1.25rem;cursor:pointer;transition:all .2s}
.deal-card:hover{border-color:var(--accent);transform:translateY(-1px);box-shadow:0 4px 16px rgba(0,0,0,0.3)}
.deal-card a.deal-link{display:inline-flex;align-items:center;gap:.3rem;margin-top:.5rem;font-size:.8rem;font-family:var(--mono);color:var(--accent);text-decoration:none}
.deal-card a.deal-link:hover{text-decoration:underline}
.deal-card-header{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.3rem}
.deal-vendor{font-weight:600;color:var(--text);font-size:.95rem}
.deal-cat{display:inline-block;padding:.15rem .5rem;border-radius:8px;font-size:.65rem;font-weight:500;background:var(--accent-glow);color:var(--accent);border:1px solid rgba(59,130,246,0.2)}
.deal-tier{font-family:var(--mono);font-size:.75rem;color:var(--accent);margin-left:auto}
.deal-desc{color:var(--text-muted);font-size:.85rem;line-height:1.5}
.show-more{display:block;width:100%;padding:.65rem;margin-top:1rem;background:transparent;border:1px solid var(--border);border-radius:10px;color:var(--accent);font-size:.85rem;font-family:var(--sans);font-weight:500;cursor:pointer;transition:all .2s}
.show-more:hover{border-color:var(--accent);background:var(--accent-glow)}
.browse-status{color:var(--text-dim);font-size:.8rem;margin-top:.5rem;font-family:var(--mono)}

/* Connect */
.connect-block{background:var(--bg-card);backdrop-filter:blur(12px);border:1px solid var(--border);border-radius:12px;padding:1.5rem;margin-top:1.5rem}
.connect-block pre{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:1rem;overflow-x:auto;font-size:.8rem;color:var(--text-muted);line-height:1.5;margin-top:.75rem;position:relative}
.connect-block code{font-family:var(--mono)}
.client-tabs{display:flex;gap:.25rem;flex-wrap:wrap;margin-top:1.5rem;border-bottom:1px solid var(--border);padding-bottom:0}
.client-tab{padding:.5rem 1rem;font-size:.8rem;font-weight:500;font-family:var(--sans);color:var(--text-muted);background:transparent;border:1px solid transparent;border-bottom:none;border-radius:8px 8px 0 0;cursor:pointer;transition:all .2s;white-space:nowrap}
.client-tab:hover{color:var(--text);background:var(--accent-glow)}
.client-tab.active{color:var(--accent);background:var(--bg-card);border-color:var(--border);border-bottom:1px solid var(--bg-card);margin-bottom:-1px;position:relative;z-index:1}
.client-panel{display:none}
.client-panel.active{display:block}
.copy-btn{position:absolute;top:.5rem;right:.5rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;padding:.25rem .5rem;font-size:.65rem;font-family:var(--mono);color:var(--text-muted);cursor:pointer;transition:all .2s}
.copy-btn:hover{border-color:var(--accent);color:var(--accent)}
.copy-btn.copied{color:#4ade80;border-color:#4ade80}
.transport-toggle{display:flex;gap:.5rem;margin-top:.75rem}
.transport-btn{padding:.3rem .75rem;font-size:.75rem;font-family:var(--mono);color:var(--text-dim);background:transparent;border:1px solid var(--border);border-radius:6px;cursor:pointer;transition:all .2s}
.transport-btn:hover{color:var(--text);border-color:var(--accent)}
.transport-btn.active{color:var(--accent);background:var(--accent-glow);border-color:var(--accent)}
.transport-content{display:none}
.transport-content.active{display:block}

/* Badges row */
.badges{display:flex;gap:1rem;flex-wrap:wrap;margin-top:1.5rem}
.badge{display:inline-flex;align-items:center;gap:.5rem;padding:.5rem 1rem;border:1px solid var(--border);border-radius:10px;color:var(--text-muted);font-size:.85rem;transition:all .2s}
.badge:hover{border-color:var(--accent);color:var(--text);text-decoration:none}
.badge-dot{width:6px;height:6px;border-radius:50%;background:var(--accent)}

/* Stack builder */
.sb-form{display:flex;gap:.75rem;margin-top:1.5rem}
.sb-input{flex:1;padding:.75rem 1rem;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:.95rem;font-family:var(--sans);outline:none;transition:border-color .2s}
.sb-input:focus{border-color:var(--accent)}
.sb-input::placeholder{color:var(--text-dim)}
.sb-btn{padding:.75rem 1.5rem;background:var(--accent);color:var(--bg);border:none;border-radius:8px;font-size:.9rem;font-weight:600;font-family:var(--sans);cursor:pointer;transition:all .2s;white-space:nowrap}
.sb-btn:hover{background:var(--accent-hover);transform:translateY(-1px)}
.sb-btn:disabled{opacity:.5;cursor:not-allowed;transform:none}
.sb-examples{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.75rem}
.sb-example{padding:.25rem .6rem;font-size:.75rem;font-family:var(--mono);color:var(--text-dim);border:1px solid var(--border);border-radius:6px;cursor:pointer;transition:all .2s;background:transparent}
.sb-example:hover{border-color:var(--accent);color:var(--accent)}
.sb-loading{text-align:center;padding:2rem;color:var(--text-muted);font-family:var(--mono);font-size:.85rem}
.sb-results{margin-top:1.5rem;display:none}
.sb-stack{display:grid;gap:.75rem}
.sb-item{background:var(--bg-card);backdrop-filter:blur(12px);border:1px solid var(--border);border-radius:10px;padding:1rem 1.25rem;display:flex;align-items:flex-start;gap:1rem;transition:border-color .2s}
.sb-item:hover{border-color:var(--accent)}
.sb-role{font-family:var(--mono);font-size:.7rem;font-weight:500;color:var(--accent);text-transform:uppercase;letter-spacing:.1em;background:var(--accent-glow);padding:.2rem .5rem;border-radius:5px;border:1px solid rgba(59,130,246,0.2);white-space:nowrap;flex-shrink:0;margin-top:.1rem}
.sb-detail{flex:1;min-width:0}
.sb-vendor{font-weight:600;color:var(--text);font-size:.95rem}
.sb-vendor a{color:var(--text);text-decoration:none}
.sb-vendor a:hover{color:var(--accent)}
.sb-desc{color:var(--text-muted);font-size:.85rem;margin-top:.2rem;line-height:1.5}
.sb-meta{margin-top:1rem;padding:1rem;background:var(--bg);border:1px solid var(--border);border-radius:8px}
.sb-meta-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem}
.sb-meta-row:last-child{margin-bottom:0}
.sb-meta-label{font-family:var(--mono);font-size:.75rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em}
.sb-meta-value{font-family:var(--mono);font-size:.85rem;color:var(--accent);font-weight:600}
.sb-limits{margin-top:.5rem;padding:0;list-style:none}
.sb-limits li{font-size:.8rem;color:var(--text-muted);padding:.15rem 0}
.sb-limits li::before{content:'\\26A0  ';color:var(--accent)}
.sb-cta{margin-top:1.5rem;text-align:center;padding:1rem;border:1px dashed var(--border);border-radius:10px}
.sb-cta p{max-width:none;margin:0 auto .5rem;text-align:center;font-size:.9rem;color:var(--text-muted)}
.sb-cta a{font-family:var(--mono);font-size:.85rem}

/* Footer */
footer{text-align:center;color:var(--text-dim);font-size:.8rem;padding:3rem 0 2rem;border-top:1px solid var(--border);margin-top:3rem}
footer a{color:var(--text-muted)}

/* Responsive */
@media(max-width:768px){
  .hero{padding:3rem 0 2rem}
  .hero h1{font-size:2.25rem}
  .hero-sub{font-size:1rem}
  .stats-bar{grid-template-columns:repeat(2,1fr);max-width:100%}
  .stat-num{font-size:1.3rem}
  .how-grid{grid-template-columns:1fr}
  .section{padding:2.5rem 0}
  .section h2{font-size:1.5rem}
  .problem-text{font-size:1.1rem}
  .connect-block pre{font-size:.7rem}
  .sb-form{flex-direction:column}
  .sb-btn{width:100%}
}
${globalNavCss()}
</style>
</head>
<body>
<div class="accent-bar"></div>
<div class="container">
  ${buildGlobalNav("home")}

  <div class="hero">
    <div class="hero-label">MCP Server</div>
    <h1>Deals for <em>agents.</em></h1>
    <p class="hero-sub">Your AI recommends tools from memory. Memory doesn't include pricing. AgentDeals gives agents the context to make better infrastructure recommendations.</p>
    <div class="hero-actions">
      <a href="#browse" class="btn-primary">Browse ${stats.offers.toLocaleString()}+ deals</a>
      <a href="/setup" class="btn-secondary">Connect via MCP</a>
    </div>
  </div>

  <div class="stats-bar">
    <div class="stat-item"><div class="stat-num">${stats.offers.toLocaleString()}</div><div class="stat-label">Deals</div></div>
    <div class="stat-item"><div class="stat-num stat-purple">${stats.categories}</div><div class="stat-label">Categories</div></div>
    <div class="stat-item"><div class="stat-num stat-cyan">4</div><div class="stat-label">MCP Tools</div></div>
    <div class="stat-item"><div class="stat-num">${stats.dealChanges}</div><div class="stat-label">Changes Tracked</div></div>
  </div>

${buildChangingSoonSection()}

  <div class="wavy-divider"><svg viewBox="0 0 1200 40" preserveAspectRatio="none"><path d="M0,20 Q150,0 300,20 T600,20 T900,20 T1200,20 V40 H0 Z" fill="none" stroke="rgba(51,65,85,0.8)" stroke-width="1"/></svg></div>

  <div class="section" id="try-it">
    <div class="section-label">Try It</div>
    <h2>What are you building?</h2>
    <p>Describe your project and get personalized free tier recommendations in seconds.</p>
    <div class="sb-form">
      <input type="text" class="sb-input" id="sb-input" placeholder="Next.js SaaS app with auth and payments">
      <button class="sb-btn" id="sb-btn">Find my stack deals</button>
    </div>
    <div class="sb-examples" id="sb-examples">
      <span class="sb-example">Django API</span>
      <span class="sb-example">React + Firebase app</span>
      <span class="sb-example">AI chatbot</span>
      <span class="sb-example">E-commerce store</span>
      <span class="sb-example">Mobile app backend</span>
    </div>
    <div id="sb-loading" class="sb-loading" style="display:none">Finding the best free tiers for your stack&hellip;</div>
    <div id="sb-results" class="sb-results"></div>
  </div>

  <div class="divider"></div>

  <div class="section" id="whats-changed">
    <div class="section-label">What&rsquo;s Changed</div>
    <h2>Recent pricing changes</h2>
    <p>Free tiers get removed. Limits change. We track it so your agent doesn't recommend dead deals.</p>
${buildChangesHtml()}
    <a href="/api/changes" class="see-all-link">See all ${stats.dealChanges} tracked changes &rarr;</a>
  </div>

  <div class="divider"></div>

${upcomingDeadlines.length > 0 ? `  <div class="section">
    <div class="section-label">Act Now</div>
    <h2>Pricing changes coming soon</h2>
    <p>Free tiers disappearing, prices increasing, products shutting down. Don't get caught off guard.</p>
    <div class="deadlines-section">
${buildDeadlinesHtml()}
    </div>
    <p style="margin-top:.75rem;font-size:.9rem"><a href="/expiring">See what\u2019s expiring soon &rarr;</a></p>
  </div>

  <div class="divider"></div>
` : ""}
  <div class="section">
    <div class="section-label">The Problem</div>
    <p class="problem-text">When Claude Code recommends Railway, it doesn't know <strong>Render has a better free tier</strong>. When it suggests Supabase, it doesn't know <strong>your YC batch gets $100K in AWS credits</strong>.</p>
    <p class="problem-text">AgentDeals gives your agent <strong>pricing context</strong> &mdash; free tiers, startup credits, and deal changes across ${stats.categories} categories of developer infrastructure.</p>
  </div>

  <div class="divider"></div>

  <div class="section">
    <div class="section-label">How It Works</div>
    <h2>Three ways to access</h2>
    <div class="how-grid">
      <div class="how-card">
        <div class="how-card-icon">01</div>
        <h3>Browse</h3>
        <p>Search and filter ${stats.offers.toLocaleString()}+ deals directly on this page. No setup required.</p>
      </div>
      <div class="how-card">
        <div class="how-card-icon">02</div>
        <h3>REST API</h3>
        <p>Query deals programmatically. 15 endpoints with search, filtering, risk analysis, and stack recommendations. <a href="/api/docs" style="color:var(--accent);text-decoration:underline">Interactive API Docs</a></p>
        <pre><code>GET /api/offers?q=database
GET /api/categories
GET /api/new?days=7
GET /api/changes?since=2025-01-01
GET /api/details/Supabase
GET /api/stack?use_case=SaaS+app
GET /api/costs?services=Vercel,Supabase
GET /api/compare?a=Supabase&amp;b=Neon
GET /api/vendor-risk/Heroku
GET /api/audit-stack?services=Vercel,Supabase
GET /api/expiring?within_days=30
GET /api/digest
GET /api/feed
GET /api/stats
GET /api/openapi.json
GET /api/docs</code></pre>
      </div>
      <div class="how-card">
        <div class="how-card-icon">03</div>
        <h3>MCP</h3>
        <p>Connect any MCP client. Local via npx or remote HTTP.</p>
        <pre><code>// Local (recommended)
"command": "npx", "args": ["-y", "agentdeals"]

// Remote
"url": "${BASE_URL}/mcp"</code></pre>
      </div>
    </div>
  </div>

  <div class="divider"></div>

  <div class="section" id="browse">
    <div class="section-label">Explore</div>
    <h2>Browse deals</h2>
    <div class="browse-controls">
      <input type="text" class="search-input" id="deal-search" placeholder="Search ${stats.offers.toLocaleString()}+ deals &mdash; try &ldquo;database&rdquo; or &ldquo;hosting&rdquo;">
      <div class="category-pills" id="cat-pills"></div>
    </div>
    <div class="deal-cards" id="deal-cards"></div>
    <button class="show-more" id="show-more" style="display:none">Show more</button>
    <div class="browse-status" id="browse-status"></div>
  </div>
${buildRecentChangesSection()}

  <div class="divider"></div>

  <div class="section" id="connect">
    <div class="section-label">Get Started</div>
    <h2>Connect your agent</h2>
    <p>Copy-paste config for your MCP client. Each supports local (npx) or remote (HTTP) transport.</p>

    <div class="client-tabs" id="client-tabs">
      <button class="client-tab active" data-client="claude-desktop">Claude Desktop</button>
      <button class="client-tab" data-client="claude-code">Claude Code</button>
      <button class="client-tab" data-client="cursor">Cursor</button>
      <button class="client-tab" data-client="cline">Cline</button>
      <button class="client-tab" data-client="windsurf">Windsurf</button>
    </div>

    <div class="client-panel active" id="panel-claude-desktop">
      <div class="connect-block">
        <h3 style="font-family:var(--serif);font-size:1rem;color:var(--text);margin-bottom:.25rem">Claude Desktop</h3>
        <p style="font-size:.85rem;color:var(--text-muted);margin-bottom:.25rem">Add to <code>claude_desktop_config.json</code></p>
        <p style="font-size:.75rem;color:var(--text-dim);margin-bottom:.5rem">macOS: <code>~/Library/Application Support/Claude/</code> &nbsp;|&nbsp; Windows: <code>%APPDATA%\\Claude\\</code></p>
        <div class="transport-toggle">
          <button class="transport-btn active" data-transport="local">npx (local)</button>
          <button class="transport-btn" data-transport="remote">Remote HTTP</button>
        </div>
        <div class="transport-content active" data-transport="local">
          <pre><button class="copy-btn" onclick="copyConfig(this)">Copy</button><code>{
  "mcpServers": {
    "agentdeals": {
      "command": "npx",
      "args": ["-y", "agentdeals"]
    }
  }
}</code></pre>
        </div>
        <div class="transport-content" data-transport="remote">
          <pre><button class="copy-btn" onclick="copyConfig(this)">Copy</button><code>{
  "mcpServers": {
    "agentdeals": {
      "url": "${BASE_URL}/mcp"
    }
  }
}</code></pre>
        </div>
      </div>
    </div>

    <div class="client-panel" id="panel-claude-code">
      <div class="connect-block">
        <h3 style="font-family:var(--serif);font-size:1rem;color:var(--text);margin-bottom:.25rem">Claude Code</h3>
        <p style="font-size:.85rem;color:var(--text-muted);margin-bottom:.25rem">Run in your terminal, or add to <code>.mcp.json</code> in your project root</p>
        <div class="transport-toggle">
          <button class="transport-btn active" data-transport="local">npx (local)</button>
          <button class="transport-btn" data-transport="remote">Remote HTTP</button>
        </div>
        <div class="transport-content active" data-transport="local">
          <pre><button class="copy-btn" onclick="copyConfig(this)">Copy</button><code>claude mcp add agentdeals -- npx -y agentdeals</code></pre>
          <p style="font-size:.75rem;color:var(--text-dim);margin-top:.5rem">Or add to <code>.mcp.json</code>:</p>
          <pre><button class="copy-btn" onclick="copyConfig(this)">Copy</button><code>{
  "mcpServers": {
    "agentdeals": {
      "command": "npx",
      "args": ["-y", "agentdeals"]
    }
  }
}</code></pre>
        </div>
        <div class="transport-content" data-transport="remote">
          <pre><button class="copy-btn" onclick="copyConfig(this)">Copy</button><code>claude mcp add agentdeals --transport http ${BASE_URL}/mcp</code></pre>
          <p style="font-size:.75rem;color:var(--text-dim);margin-top:.5rem">Or add to <code>.mcp.json</code>:</p>
          <pre><button class="copy-btn" onclick="copyConfig(this)">Copy</button><code>{
  "mcpServers": {
    "agentdeals": {
      "type": "url",
      "url": "${BASE_URL}/mcp"
    }
  }
}</code></pre>
        </div>
      </div>
    </div>

    <div class="client-panel" id="panel-cursor">
      <div class="connect-block">
        <h3 style="font-family:var(--serif);font-size:1rem;color:var(--text);margin-bottom:.25rem">Cursor</h3>
        <p style="font-size:.85rem;color:var(--text-muted);margin-bottom:.25rem">Add to <code>.cursor/mcp.json</code> in your project root</p>
        <p style="font-size:.75rem;color:var(--text-dim);margin-bottom:.5rem">Or global: <code>~/.cursor/mcp.json</code></p>
        <div class="transport-toggle">
          <button class="transport-btn active" data-transport="local">npx (local)</button>
          <button class="transport-btn" data-transport="remote">Remote HTTP</button>
        </div>
        <div class="transport-content active" data-transport="local">
          <pre><button class="copy-btn" onclick="copyConfig(this)">Copy</button><code>{
  "mcpServers": {
    "agentdeals": {
      "command": "npx",
      "args": ["-y", "agentdeals"]
    }
  }
}</code></pre>
        </div>
        <div class="transport-content" data-transport="remote">
          <pre><button class="copy-btn" onclick="copyConfig(this)">Copy</button><code>{
  "mcpServers": {
    "agentdeals": {
      "url": "${BASE_URL}/mcp"
    }
  }
}</code></pre>
        </div>
      </div>
    </div>

    <div class="client-panel" id="panel-cline">
      <div class="connect-block">
        <h3 style="font-family:var(--serif);font-size:1rem;color:var(--text);margin-bottom:.25rem">Cline (VS Code)</h3>
        <p style="font-size:.85rem;color:var(--text-muted);margin-bottom:.25rem">Add to <code>cline_mcp_settings.json</code></p>
        <p style="font-size:.75rem;color:var(--text-dim);margin-bottom:.5rem">Cline sidebar &rarr; MCP Servers &rarr; Configure &nbsp;|&nbsp; Or: <code>~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/</code></p>
        <div class="transport-toggle">
          <button class="transport-btn active" data-transport="local">npx (local)</button>
          <button class="transport-btn" data-transport="remote">Remote HTTP</button>
        </div>
        <div class="transport-content active" data-transport="local">
          <pre><button class="copy-btn" onclick="copyConfig(this)">Copy</button><code>{
  "mcpServers": {
    "agentdeals": {
      "command": "npx",
      "args": ["-y", "agentdeals"]
    }
  }
}</code></pre>
        </div>
        <div class="transport-content" data-transport="remote">
          <pre><button class="copy-btn" onclick="copyConfig(this)">Copy</button><code>{
  "mcpServers": {
    "agentdeals": {
      "url": "${BASE_URL}/mcp",
      "transportType": "streamable-http"
    }
  }
}</code></pre>
        </div>
      </div>
    </div>

    <div class="client-panel" id="panel-windsurf">
      <div class="connect-block">
        <h3 style="font-family:var(--serif);font-size:1rem;color:var(--text);margin-bottom:.25rem">Windsurf</h3>
        <p style="font-size:.85rem;color:var(--text-muted);margin-bottom:.25rem">Add to <code>~/.codeium/windsurf/mcp_config.json</code></p>
        <div class="transport-toggle">
          <button class="transport-btn active" data-transport="local">npx (local)</button>
          <button class="transport-btn" data-transport="remote">Remote HTTP</button>
        </div>
        <div class="transport-content active" data-transport="local">
          <pre><button class="copy-btn" onclick="copyConfig(this)">Copy</button><code>{
  "mcpServers": {
    "agentdeals": {
      "command": "npx",
      "args": ["-y", "agentdeals"]
    }
  }
}</code></pre>
        </div>
        <div class="transport-content" data-transport="remote">
          <pre><button class="copy-btn" onclick="copyConfig(this)">Copy</button><code>{
  "mcpServers": {
    "agentdeals": {
      "url": "${BASE_URL}/mcp"
    }
  }
}</code></pre>
        </div>
      </div>
    </div>

    <div class="connect-block" style="margin-top:1.5rem">
      <h3 style="font-family:var(--serif);font-size:1rem;color:var(--text);margin-bottom:.75rem">4 MCP Tools</h3>
      <div style="display:grid;gap:.5rem">
        <div style="font-size:.85rem"><code style="font-family:var(--mono);color:var(--accent)">search_deals</code> <span style="color:var(--text-muted)">&mdash; Find free tiers, browse categories, get vendor details with alternatives. Filter by category, eligibility, or keyword.</span></div>
        <div style="font-size:.85rem"><code style="font-family:var(--mono);color:var(--accent)">plan_stack</code> <span style="color:var(--text-muted)">&mdash; Get stack recommendations, cost estimates, or a full infrastructure audit for your project.</span></div>
        <div style="font-size:.85rem"><code style="font-family:var(--mono);color:var(--accent)">compare_vendors</code> <span style="color:var(--text-muted)">&mdash; Compare 2 vendors side-by-side or check a single vendor's pricing risk.</span></div>
        <div style="font-size:.85rem"><code style="font-family:var(--mono);color:var(--accent)">track_changes</code> <span style="color:var(--text-muted)">&mdash; Track pricing changes, upcoming expirations, and new deals. Weekly digest with no params.</span></div>
      </div>
    </div>

    <div class="badges">
      <a class="badge" href="https://www.npmjs.com/package/agentdeals"><span class="badge-dot"></span>npm</a>
      <a class="badge" href="https://github.com/robhunter/agentdeals"><span class="badge-dot"></span>GitHub</a>
      <a class="badge" href="https://registry.modelcontextprotocol.io/v0.1/servers/io.github.robhunter%2Fagentdeals/versions"><span class="badge-dot"></span>MCP Registry</a>
      <a class="badge" href="https://glama.ai/mcp/connectors/io.github.robhunter/agentdeals"><span class="badge-dot"></span>Glama</a>
    </div>
  </div>

  <footer>AgentDeals &mdash; open source, built for agents | <a href="/privacy">Privacy</a></footer>
</div>
<script>
/* Client tab switching */
(function(){
  var tabs=document.querySelectorAll('.client-tab');
  var panels=document.querySelectorAll('.client-panel');
  tabs.forEach(function(tab){
    tab.addEventListener('click',function(){
      tabs.forEach(function(t){t.classList.remove('active')});
      panels.forEach(function(p){p.classList.remove('active')});
      tab.classList.add('active');
      var panel=document.getElementById('panel-'+tab.getAttribute('data-client'));
      if(panel)panel.classList.add('active');
    });
  });
  /* Transport toggle within each panel */
  document.querySelectorAll('.transport-toggle').forEach(function(toggle){
    var block=toggle.closest('.connect-block');
    toggle.querySelectorAll('.transport-btn').forEach(function(btn){
      btn.addEventListener('click',function(){
        toggle.querySelectorAll('.transport-btn').forEach(function(b){b.classList.remove('active')});
        block.querySelectorAll('.transport-content').forEach(function(c){c.classList.remove('active')});
        btn.classList.add('active');
        block.querySelectorAll('.transport-content[data-transport="'+btn.getAttribute('data-transport')+'"]').forEach(function(c){c.classList.add('active')});
      });
    });
  });
})();
/* Copy config button */
function copyConfig(btn){
  var code=btn.parentElement.querySelector('code');
  if(!code)return;
  navigator.clipboard.writeText(code.textContent).then(function(){
    btn.textContent='Copied!';btn.classList.add('copied');
    setTimeout(function(){btn.textContent='Copy';btn.classList.remove('copied')},2000);
  });
}
(function(){
  var search=document.getElementById('deal-search');
  var pillsEl=document.getElementById('cat-pills');
  var cardsEl=document.getElementById('deal-cards');
  var moreBtn=document.getElementById('show-more');
  var statusEl=document.getElementById('browse-status');
  var activeCat='';
  var query='';
  var offset=0;
  var total=0;
  var LIMIT=20;
  var timer=null;

  function escHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

  function renderCards(offers,append){
    var html='';
    for(var i=0;i<offers.length;i++){
      var o=offers[i];
      var tierLabel=o.eligibility?o.eligibility.type:'free tier';
      var dataUrl=o.url?' data-url="'+escHtml(o.url)+'"':'';
      html+='<div class="deal-card"'+dataUrl+'>'
        +'<div class="deal-card-header"><span class="deal-vendor">'+escHtml(o.vendor)+'</span>'
        +'<span class="deal-cat">'+escHtml(o.category)+'</span>'
        +'<span class="deal-tier">'+escHtml(tierLabel)+'</span></div>'
        +'<div class="deal-desc">'+escHtml(o.description)+'</div>';
      if(o.url){html+='<a class="deal-link" href="'+escHtml(o.url)+'" target="_blank" rel="noopener">View deal &#8594;</a>';}
      html+='</div>';
    }
    if(append){cardsEl.innerHTML+=html;}else{cardsEl.innerHTML=html;}
  }

  function updateStatus(){
    var shown=cardsEl.children.length;
    statusEl.textContent=shown+' of '+total+' results';
    moreBtn.style.display=shown<total?'block':'none';
  }

  function loadOffers(append){
    var url='/api/offers?limit='+LIMIT+'&offset='+offset;
    if(query)url+='&q='+encodeURIComponent(query);
    if(activeCat)url+='&category='+encodeURIComponent(activeCat);
    fetch(url).then(function(r){return r.json();}).then(function(data){
      total=data.total;
      renderCards(data.offers,append);
      updateStatus();
    });
  }

  function loadCategories(){
    fetch('/api/categories').then(function(r){return r.json();}).then(function(data){
      var html='<span class="cat-pill active" data-cat="">All</span>';
      for(var i=0;i<data.categories.length;i++){
        var c=data.categories[i];
        html+='<span class="cat-pill" data-cat="'+escHtml(c.name)+'">'+escHtml(c.name)+' ('+c.count+')</span>';
      }
      pillsEl.innerHTML=html;
    });
  }

  search.addEventListener('input',function(){
    if(timer)clearTimeout(timer);
    timer=setTimeout(function(){
      query=search.value.trim();
      offset=0;
      loadOffers(false);
    },300);
  });

  pillsEl.addEventListener('click',function(e){
    var pill=e.target.closest('.cat-pill');
    if(!pill)return;
    var pills=pillsEl.querySelectorAll('.cat-pill');
    for(var i=0;i<pills.length;i++)pills[i].classList.remove('active');
    pill.classList.add('active');
    activeCat=pill.getAttribute('data-cat')||'';
    offset=0;
    loadOffers(false);
  });

  moreBtn.addEventListener('click',function(){
    offset+=LIMIT;
    loadOffers(true);
  });

  cardsEl.addEventListener('click',function(e){
    if(e.target.closest('.deal-link'))return;
    var card=e.target.closest('.deal-card');
    if(card&&card.dataset.url)window.open(card.dataset.url,'_blank','noopener');
  });

  loadCategories();
  loadOffers(false);
})();
</script>
<script>
(function(){
  var input=document.getElementById('sb-input');
  var btn=document.getElementById('sb-btn');
  var loading=document.getElementById('sb-loading');
  var results=document.getElementById('sb-results');
  var examples=document.getElementById('sb-examples');

  function escHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

  function doSearch(){
    var q=input.value.trim();
    if(!q)return;
    btn.disabled=true;
    loading.style.display='block';
    results.style.display='none';
    fetch('/api/stack?use_case='+encodeURIComponent(q))
      .then(function(r){return r.json();})
      .then(function(data){
        loading.style.display='none';
        results.style.display='block';
        btn.disabled=false;
        if(!data.stack||data.stack.length===0){
          results.innerHTML='<p style="color:var(--text-muted);font-size:.9rem">No matching stack recommendations found. Try a different description.</p>';
          return;
        }
        var html='<div class="sb-stack">';
        for(var i=0;i<data.stack.length;i++){
          var s=data.stack[i];
          var vendorSlug=s.vendor.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
          html+='<div class="sb-item">'
            +'<span class="sb-role">'+escHtml(s.role)+'</span>'
            +'<div class="sb-detail">'
            +'<div class="sb-vendor"><a href="/vendor/'+escHtml(vendorSlug)+'">'+escHtml(s.vendor)+'</a> <span style="color:var(--text-dim);font-size:.8rem">'+escHtml(s.tier)+'</span></div>'
            +'<div class="sb-desc">'+escHtml(s.description)+'</div>'
            +'</div></div>';
        }
        html+='</div>';
        if(data.limitations&&data.limitations.length>0){
          html+='<div class="sb-meta"><div class="sb-meta-row"><span class="sb-meta-label">Monthly cost</span><span class="sb-meta-value">'+escHtml(data.total_monthly_cost)+'</span></div>';
          html+='<ul class="sb-limits">';
          for(var j=0;j<data.limitations.length;j++){
            html+='<li>'+escHtml(data.limitations[j])+'</li>';
          }
          html+='</ul></div>';
        }else{
          html+='<div class="sb-meta"><div class="sb-meta-row"><span class="sb-meta-label">Monthly cost</span><span class="sb-meta-value">'+escHtml(data.total_monthly_cost)+'</span></div></div>';
        }
        html+='<div class="sb-cta"><p>Want this in your AI agent? Get live recommendations as you code.</p><a href="/setup">Connect via MCP &rarr;</a></div>';
        results.innerHTML=html;
      })
      .catch(function(){
        loading.style.display='none';
        btn.disabled=false;
        results.style.display='block';
        results.innerHTML='<p style="color:var(--text-muted);font-size:.9rem">Something went wrong. Please try again.</p>';
      });
  }

  btn.addEventListener('click',doSearch);
  input.addEventListener('keydown',function(e){if(e.key==='Enter')doSearch();});
  examples.addEventListener('click',function(e){
    var ex=e.target.closest('.sb-example');
    if(!ex)return;
    input.value=ex.textContent;
    doSearch();
  });
})();
</script>
</body>
</html>`;
}

const landingPageHtml = buildLandingPage();

function isInitializeRequest(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some((msg) => msg?.method === "initialize");
  }
  return (body as { method?: string })?.method === "initialize";
}

function extractClientInfo(body: unknown): ClientInfo | undefined {
  const msg = Array.isArray(body)
    ? body.find((m) => m?.method === "initialize")
    : body;
  const params = (msg as { params?: { clientInfo?: { name?: string; version?: string } } })?.params;
  const info = params?.clientInfo;
  if (info?.name) {
    return { name: info.name, version: info.version ?? "unknown" };
  }
  return undefined;
}

// Parse canonical hostname from BASE_URL for redirect logic
const canonicalHost = (() => {
  try { return new URL(BASE_URL).hostname; } catch { return undefined; }
})();

const httpServer = createHttpServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const isGetOrHead = req.method === "GET" || req.method === "HEAD";

  // 301 redirect non-canonical hostnames to BASE_URL (SEO canonical domain)
  if (canonicalHost) {
    const requestHost = (req.headers.host ?? "").split(":")[0];
    if (requestHost && requestHost !== canonicalHost) {
      const skip =
        url.pathname === "/mcp" ||
        url.pathname === "/health" ||
        url.pathname.startsWith("/api/") ||
        url.pathname.startsWith("/.well-known/") ||
        url.pathname === "/favicon.png" ||
        url.pathname === "/favicon.ico" ||
        url.pathname === "/llms.txt" ||
        url.pathname === "/llms-full.txt" ||
        url.pathname === "/AGENTS.md" ||
        (INDEXNOW_KEY && url.pathname === `/${INDEXNOW_KEY}.txt`);
      if (!skip) {
        const target = `${BASE_URL}${url.pathname}${url.search}`;
        res.writeHead(301, { Location: target });
        res.end();
        return;
      }
    }
  }

  // Feed URL aliases — redirect common feed paths to canonical /feed.xml
  if ((url.pathname === "/rss" || url.pathname === "/feed" || url.pathname === "/atom") && isGetOrHead) {
    res.writeHead(301, { Location: "/feed.xml" });
    res.end();
    return;
  }

  // Server-side page view tracking (fire-and-forget, no latency impact)
  // Track HTML page requests only — exclude API, MCP, static assets, health
  const isPagePath = req.method === "GET" && !url.pathname.startsWith("/api/") &&
    url.pathname !== "/mcp" && url.pathname !== "/health" &&
    url.pathname !== "/favicon.png" && url.pathname !== "/favicon.ico" &&
    url.pathname !== "/og-image.png" && url.pathname !== "/robots.txt" &&
    url.pathname !== "/sitemap.xml" && !url.pathname.startsWith("/.well-known/") &&
    url.pathname !== "/feed.xml";
  if (isPagePath) {
    recordPageView(url.pathname, req.headers["user-agent"] ?? "", req.headers["referer"]);
  }

  if (url.pathname === "/mcp") {
    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }

      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }

      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && sessions.has(sessionId)) {
        // Existing session — route to its transport
        touchSession(sessionId);
        const { transport } = sessions.get(sessionId)!;
        await transport.handleRequest(req, res, parsedBody);
      } else if (!sessionId && isInitializeRequest(parsedBody)) {
        // New session — create transport + server
        const ip = getClientIp(req);
        const userAgent = req.headers["user-agent"] ?? "unknown";
        const clientInfo = extractClientInfo(parsedBody);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            const now = Date.now();
            sessions.set(sid, { transport, lastActivity: now, createdAt: now, clientInfo });
            recordSessionConnect(clientInfo?.name);
            console.log(JSON.stringify({
              event: "session_open",
              ts: new Date(now).toISOString(),
              sessionId: sid,
              ip,
              userAgent,
              clientInfo,
            }));
            logRequest({
              ts: new Date(now).toISOString(),
              type: "session_connect",
              endpoint: "initialize",
              params: {},
              result_count: 0,
              session_id: sid,
              client_info: clientInfo,
            });
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions.has(sid)) {
            const entry = sessions.get(sid)!;
            const now = Date.now();
            console.log(JSON.stringify({
              event: "session_close",
              ts: new Date(now).toISOString(),
              sessionId: sid,
              durationMs: now - entry.createdAt,
              reason: "client_disconnect",
            }));
            sessions.delete(sid);
            recordSessionDisconnect();
          }
        };

        const mcpServer = createServer(() => transport.sessionId);
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
      } else {
        // Invalid: has session ID but unknown, or missing session ID on non-init request
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32600, message: "Bad Request: No valid session. Send an initialize request first." },
          id: null,
        }));
      }
    } else if (req.method === "GET") {
      // SSE stream — route to existing session
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        touchSession(sessionId);
        await sessions.get(sessionId)!.transport.handleRequest(req, res);
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or missing session ID" }));
      }
    } else if (req.method === "DELETE") {
      // Session termination
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        const entry = sessions.get(sessionId)!;
        await entry.transport.handleRequest(req, res);
        const now = Date.now();
        console.log(JSON.stringify({
          event: "session_close",
          ts: new Date(now).toISOString(),
          sessionId,
          durationMs: now - entry.createdAt,
          reason: "client_disconnect",
        }));
        sessions.delete(sessionId);
        recordSessionDisconnect();
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
      }
    } else {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
    }
  } else if (url.pathname === "/favicon.png" || url.pathname === "/favicon.ico") {
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
      "Content-Length": faviconBuffer.length,
    });
    res.end(faviconBuffer);
  } else if (url.pathname === "/og-image.png") {
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
      "Content-Length": ogImageBuffer.length,
    });
    res.end(ogImageBuffer);
  } else if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", sessions: sessions.size, stats: getStats() }));
  } else if (url.pathname === "/.well-known/glama.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(readFileSync(join(__dirname, "..", "glama.json"), "utf-8"));
  } else if (url.pathname === "/.well-known/mcp.json" || url.pathname === "/.well-known/mcp/server-card.json") {
    const card = getServerCard(BASE_URL);
    const body = JSON.stringify(card, null, 2);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
  } else if (url.pathname === "/api/stack" && isGetOrHead) {
    recordApiHit("/api/stack");
    const useCase = url.searchParams.get("use_case") || url.searchParams.get("q") || "";
    if (!useCase) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "use_case parameter is required (e.g., ?use_case=Next.js+SaaS+app)" }));
      return;
    }
    const requirementsParam = url.searchParams.get("requirements");
    const requirements = requirementsParam ? requirementsParam.split(",").map(r => r.trim()).filter(Boolean) : undefined;
    const result = getStackRecommendation(useCase, requirements);
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/stack", params: { use_case: useCase, requirements }, user_agent: req.headers["user-agent"] ?? "unknown", result_count: result.stack.length });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(result));
  } else if (url.pathname === "/api/costs" && isGetOrHead) {
    recordApiHit("/api/costs");
    const servicesParam = url.searchParams.get("services");
    if (!servicesParam) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "services parameter is required (e.g., ?services=Vercel,Supabase,Clerk)" }));
      return;
    }
    const services = servicesParam.split(",").map(s => s.trim()).filter(Boolean);
    const scale = (url.searchParams.get("scale") ?? "hobby") as "hobby" | "startup" | "growth";
    if (!["hobby", "startup", "growth"].includes(scale)) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Invalid scale. Must be: hobby, startup, or growth" }));
      return;
    }
    const result = estimateCosts(services, scale);
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/costs", params: { services, scale }, user_agent: req.headers["user-agent"] ?? "unknown", result_count: result.services.length });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(result));
  } else if (url.pathname === "/api/query-log" && isGetOrHead) {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 200);
    const entries = await getRequestLog(limit);
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ entries, count: entries.length }));
  } else if (url.pathname === "/api/openapi.json" && isGetOrHead) {
    recordApiHit("/api/openapi.json");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/openapi.json", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(openapiSpec));
  } else if (url.pathname === "/api/stats" && isGetOrHead) {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(getConnectionStats(sessions.size)));
  } else if (url.pathname === "/api/pageviews" && isGetOrHead) {
    const data = await getPageViews();
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(data));
  } else if (url.pathname === "/api/offers" && isGetOrHead) {
    recordApiHit("/api/offers");
    const q = url.searchParams.get("q") || undefined;
    const category = url.searchParams.get("category") || undefined;
    const eligibilityType = url.searchParams.get("eligibility_type") || undefined;
    const sort = url.searchParams.get("sort") || undefined;
    const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
    const results = searchOffers(q, category, eligibilityType, sort);
    const total = results.length;
    const paged = enrichOffers(results.slice(offset, offset + limit));
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/offers", params: { q, category, limit, offset }, user_agent: req.headers["user-agent"] ?? "unknown", result_count: paged.length });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ offers: paged, total }));
  } else if (url.pathname === "/api/compare" && isGetOrHead) {
    recordApiHit("/api/compare");
    const a = url.searchParams.get("a") || "";
    const b = url.searchParams.get("b") || "";
    if (!a || !b) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Both 'a' and 'b' query parameters are required." }));
      return;
    }
    const result = compareServices(a, b);
    if ("error" in result) {
      logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/compare", params: { a, b }, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 0 });
      res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(result));
      return;
    }
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/compare", params: { a, b }, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 2 });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(result.comparison));
  } else if (url.pathname === "/api/new" && isGetOrHead) {
    recordApiHit("/api/new");
    const days = parseInt(url.searchParams.get("days") ?? "7", 10);
    const result = getNewOffers(days);
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/new", params: { days }, user_agent: req.headers["user-agent"] ?? "unknown", result_count: result.offers.length });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(result));
  } else if (url.pathname === "/api/newest" && isGetOrHead) {
    recordApiHit("/api/newest");
    const since = url.searchParams.get("since") || undefined;
    const limit = parseInt(url.searchParams.get("limit") ?? "20", 10) || 20;
    const category = url.searchParams.get("category") || undefined;
    if (since && !/^\d{4}-\d{2}-\d{2}/.test(since)) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Invalid 'since' parameter. Expected ISO date string (YYYY-MM-DD)." }));
      return;
    }
    const result = getNewestDeals({ since, limit, category });
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/newest", params: { since, limit, category }, user_agent: req.headers["user-agent"] ?? "unknown", result_count: result.total });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(result));
  } else if (url.pathname === "/api/categories" && isGetOrHead) {
    recordApiHit("/api/categories");
    const cats = getCategories();
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/categories", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: cats.length });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ categories: cats }));
  } else if (url.pathname === "/api/changes" && isGetOrHead) {
    recordApiHit("/api/changes");
    const since = url.searchParams.get("since") || undefined;
    const type = url.searchParams.get("type") || undefined;
    const vendorFilter = url.searchParams.get("vendor") || undefined;
    const vendorsFilter = url.searchParams.get("vendors") || undefined;
    // Validate since is a valid date if provided
    if (since && !/^\d{4}-\d{2}-\d{2}/.test(since)) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Invalid 'since' parameter. Expected ISO date string (YYYY-MM-DD)." }));
      return;
    }
    const result = getDealChanges(since, type, vendorFilter, vendorsFilter);
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/changes", params: { since, type, vendor: vendorFilter, vendors: vendorsFilter }, user_agent: req.headers["user-agent"] ?? "unknown", result_count: result.changes.length });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(result));
  } else if (url.pathname === "/api/audit-stack" && isGetOrHead) {
    recordApiHit("/api/audit-stack");
    const servicesParam = url.searchParams.get("services");
    if (!servicesParam) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Missing required 'services' parameter. Provide comma-separated vendor names." }));
      return;
    }
    const servicesList = servicesParam.split(",").map((s) => s.trim()).filter(Boolean);
    if (servicesList.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "At least one service name is required." }));
      return;
    }
    const auditResult = auditStack(servicesList);
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/audit-stack", params: { services: servicesList }, user_agent: req.headers["user-agent"] ?? "unknown", result_count: auditResult.services_analyzed });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(auditResult));
  } else if (url.pathname.startsWith("/api/vendor-risk/") && isGetOrHead) {
    recordApiHit("/api/vendor-risk");
    const vendorParam = decodeURIComponent(url.pathname.slice("/api/vendor-risk/".length));
    if (!vendorParam) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Vendor name is required." }));
      return;
    }
    const riskResult = checkVendorRisk(vendorParam);
    if ("error" in riskResult) {
      logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/vendor-risk", params: { vendor: vendorParam }, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 0 });
      res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: riskResult.error, ...(riskResult.suggestions ? { suggestions: riskResult.suggestions } : {}) }));
      return;
    }
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/vendor-risk", params: { vendor: vendorParam }, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(riskResult.result));
  } else if (url.pathname.startsWith("/api/details/") && isGetOrHead) {
    recordApiHit("/api/details");
    const vendorParam = decodeURIComponent(url.pathname.slice("/api/details/".length));
    if (!vendorParam) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Vendor name is required." }));
      return;
    }
    const includeAlternatives = url.searchParams.get("alternatives") === "true";
    const detailResult = getOfferDetails(vendorParam, includeAlternatives);
    if ("error" in detailResult) {
      logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/details", params: { vendor: vendorParam, alternatives: includeAlternatives }, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 0 });
      res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: detailResult.error, suggestions: detailResult.suggestions }));
      return;
    }
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/details", params: { vendor: vendorParam, alternatives: includeAlternatives }, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ offer: detailResult.offer, ...(includeAlternatives ? { alternatives: detailResult.offer.alternatives } : {}) }));
  } else if (url.pathname === "/api/expiring" && isGetOrHead) {
    recordApiHit("/api/expiring");
    const withinDays = Math.min(Math.max(parseInt(url.searchParams.get("within_days") ?? "30", 10) || 30, 1), 365);
    const result = getExpiringDeals(withinDays);
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/expiring", params: { within_days: withinDays }, user_agent: req.headers["user-agent"] ?? "unknown", result_count: result.total });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(result));
  } else if (url.pathname === "/api/freshness" && isGetOrHead) {
    recordApiHit("/api/freshness");
    const result = getFreshnessMetrics();
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/freshness", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: result.total_offers });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" });
    res.end(JSON.stringify(result));
  } else if (url.pathname === "/api/digest" && isGetOrHead) {
    recordApiHit("/api/digest");
    const digest = getWeeklyDigest();
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/digest", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: digest.deal_changes.length });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(digest));
  } else if (url.pathname === "/api" && isGetOrHead) {
    res.writeHead(301, { "Location": "/api/docs" });
    res.end();
  } else if (url.pathname === "/api/docs" && isGetOrHead) {
    recordApiHit("/api/docs");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(swaggerDocsHtml);
  } else if (url.pathname.startsWith("/api/docs/") && isGetOrHead) {
    const filename = url.pathname.slice("/api/docs/".length);
    if (filename.includes("..") || filename.includes("/")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid path" }));
      return;
    }
    const filePath = join(swaggerUiDistPath, filename);
    if (!existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    const ext = filename.substring(filename.lastIndexOf("."));
    const contentType = SWAGGER_MIME_TYPES[ext] || "application/octet-stream";
    const content = readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "public, max-age=86400" });
    res.end(content);
  } else if ((url.pathname === "/feed.xml" || url.pathname === "/api/feed") && isGetOrHead) {
    const feedPath = url.pathname === "/feed.xml" ? "/feed.xml" : "/api/feed";
    recordApiHit(feedPath);
    const baseUrl = BASE_URL;
    const allChanges = [...dealChanges].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 50);
    const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
    const changeLabel: Record<string, string> = {
      free_tier_removed: "Free Tier Removed",
      limits_reduced: "Limits Reduced",
      restriction: "New Restriction",
      limits_increased: "Limits Increased",
      new_free_tier: "New Free Tier",
      pricing_restructured: "Pricing Restructured",
      open_source_killed: "Open Source Killed",
      pricing_model_change: "Pricing Model Change",
      startup_program_expanded: "Startup Program Expanded",
      pricing_postponed: "Pricing Postponed",
      product_deprecated: "Product Deprecated",
    };
    const updatedTs = allChanges.length > 0 ? new Date(allChanges[0].date + "T00:00:00Z").toISOString() : new Date().toISOString();
    const entries = allChanges.map((c) => {
      const label = changeLabel[c.change_type] ?? c.change_type;
      const vendorSlug = toSlug(c.vendor);
      const id = `agentdeals-${vendorSlug}-${c.date}`;
      return `  <entry>
    <title>${escXml(c.vendor)}: ${escXml(label)}</title>
    <link href="${baseUrl}/vendor/${vendorSlug}" rel="alternate"/>
    <id>urn:agentdeals:${escXml(id)}</id>
    <updated>${new Date(c.date + "T00:00:00Z").toISOString()}</updated>
    <summary>${escXml(c.summary)}</summary>
    <category term="${escXml(c.change_type)}" label="${escXml(label)}"/>
  </entry>`;
    }).join("\n");
    const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>AgentDeals — Pricing Changes</title>
  <subtitle>Track pricing changes, free tier removals, and deal updates across developer infrastructure tools.</subtitle>
  <link href="${baseUrl}" rel="alternate"/>
  <link href="${baseUrl}/feed.xml" rel="self" type="application/atom+xml"/>
  <id>urn:agentdeals:feed</id>
  <updated>${updatedTs}</updated>
${entries}
</feed>`;
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: feedPath, params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: allChanges.length });
    res.writeHead(200, { "Content-Type": "application/atom+xml; charset=utf-8", "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" });
    res.end(atom);
  } else if (INDEXNOW_KEY && url.pathname === `/${INDEXNOW_KEY}.txt` && isGetOrHead) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" });
    res.end(INDEXNOW_KEY);
  } else if (url.pathname === "/robots.txt" && isGetOrHead) {
    const robotsTxt = `User-agent: *\nAllow: /\n\nSitemap: ${BASE_URL}/sitemap.xml\n`;
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" });
    res.end(robotsTxt);
  } else if (url.pathname === "/llms.txt" && isGetOrHead) {
    const llmsTxt = `# AgentDeals

> An MCP server and REST API that aggregates free tiers, startup credits, and developer tool deals. ${stats.offers} verified offers across ${stats.categories} categories with pricing change tracking.

## What AgentDeals Does

AgentDeals helps developers find free tiers, startup credits, and deals on developer infrastructure — databases, cloud hosting, CI/CD, monitoring, auth, AI services, and more. Data is verified and includes specific free tier limits, eligibility requirements, and pricing change history.

## MCP Tools (4)

- **search_deals**: Find free tiers, startup credits, and developer deals. Search by keyword, category, vendor name, or eligibility type. Returns verified deal details with specific limits.
- **plan_stack**: Plan a technology stack with cost-optimized choices. Recommends free-tier services, estimates costs at scale, or audits existing stacks for risk.
- **compare_vendors**: Compare developer tools side by side — free tier limits, pricing tiers, risk levels, and recent pricing changes.
- **track_changes**: Track pricing changes across developer tools — free tier removals, limit reductions, new free tiers, and upcoming expirations.

## Prompt Templates (6)

- **new-project-setup**: Find free tiers for a new project's entire stack
- **cost-audit**: Audit an existing stack for cost savings
- **check-pricing-changes**: Check recent developer tool pricing changes
- **compare-options**: Compare two or more services side-by-side
- **find-startup-credits**: Find startup credit programs and special deals
- **monitor-vendor-changes**: Monitor pricing changes for your vendor watchlist

## Connect

- MCP endpoint: ${BASE_URL}/mcp
- REST API docs: ${BASE_URL}/api/docs
- npm: npx agentdeals

## Links

- [API Documentation](${BASE_URL}/api/docs)
- [Setup Guide](${BASE_URL}/setup)
- [Browse Categories](${BASE_URL}/category)
- [Pricing Changes Feed](${BASE_URL}/feed.xml)
- [Expiring Deals](${BASE_URL}/expiring)
- [Full details for LLMs](${BASE_URL}/llms-full.txt)
`;
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(llmsTxt);
  } else if (url.pathname === "/llms-full.txt" && isGetOrHead) {
    const catList = categories.map(c => `- ${c.name} (${c.count} offers)`).join("\n");
    const llmsFullTxt = `# AgentDeals — Full Reference

> ${stats.offers} verified developer tool deals across ${stats.categories} categories. Free tiers, startup credits, and pricing change tracking.

## MCP Connection

Endpoint: ${BASE_URL}/mcp
Transport: Streamable HTTP (POST/GET/DELETE)

\`\`\`json
{
  "mcpServers": {
    "agentdeals": {
      "url": "${BASE_URL}/mcp"
    }
  }
}
\`\`\`

## Tool Schemas

### search_deals
Find free tiers, startup credits, and developer deals for cloud infrastructure, databases, hosting, CI/CD, monitoring, auth, AI services, and more.

Parameters:
- query (string, optional): Keyword search (vendor names, descriptions, tags)
- category (string, optional): Filter by category. Pass "list" to get all categories with counts.
- vendor (string, optional): Get full details for a specific vendor (fuzzy match). Returns alternatives.
- eligibility (enum, optional): public, accelerator, oss, student, fintech, geographic, enterprise
- sort (enum, optional): vendor (A-Z), category, newest
- since (string, optional): ISO date (YYYY-MM-DD). Only return deals verified/added after this date.
- limit (number, optional): Max results (default: 20)
- offset (number, optional): Pagination offset (default: 0)

### plan_stack
Plan a technology stack with cost-optimized infrastructure choices.

Parameters:
- mode (enum, required): recommend, estimate, or audit
- use_case (string, optional): What you're building (for recommend mode)
- services (array of strings, optional): Current vendor names (for estimate/audit mode)
- scale (enum, optional): hobby, startup, growth (for estimate mode)
- requirements (array of strings, optional): Specific infra needs (for recommend mode)

### compare_vendors
Compare developer tools and services side by side.

Parameters:
- vendors (array of strings, required): 1 or 2 vendor names. 1 = risk check, 2 = side-by-side comparison.
- include_risk (boolean, optional): Include risk assessment (default: true)

### track_changes
Track recent pricing changes across developer tools.

Parameters:
- since (string, optional): ISO date (YYYY-MM-DD). Default: 7 days ago.
- change_type (enum, optional): free_tier_removed, limits_reduced, restriction, limits_increased, new_free_tier, pricing_restructured, open_source_killed, pricing_model_change, startup_program_expanded, pricing_postponed, product_deprecated
- vendor (string, optional): Filter to one vendor
- vendors (string, optional): Comma-separated vendor names
- include_expiring (boolean, optional): Include upcoming expirations (default: true)
- lookahead_days (number, optional): Days to look ahead for expirations (default: 30)

## REST API Endpoints

- GET /api/offers — Search deals (params: q, category, eligibility_type, sort, limit, offset)
- GET /api/categories — List all categories with counts
- GET /api/changes — Pricing changes (params: since, change_type, vendor)
- GET /api/new — Recently added offers (params: days)
- GET /api/newest — Newest deals (params: since, limit, category)
- GET /api/compare — Compare two vendors (params: a, b)
- GET /api/details/:vendor — Vendor details (params: alternatives)
- GET /api/vendor-risk/:vendor — Vendor risk assessment
- GET /api/stack — Stack recommendation (params: use_case, requirements)
- GET /api/costs — Cost estimation (params: services, scale)
- GET /api/audit-stack — Stack audit (params: services)
- GET /api/expiring — Expiring deals (params: days)
- GET /api/digest — Weekly pricing digest
- GET /api/openapi.json — OpenAPI 3.0 specification
- GET /api/docs — Swagger UI documentation
- GET /api/feed — Atom feed of pricing changes
- GET /api/pageviews — Page view analytics

## Categories (${stats.categories})

${catList}

## Example Queries

1. "What databases have a free tier?" → search_deals with category="Databases"
2. "Compare Supabase and Neon" → compare_vendors with vendors=["Supabase", "Neon"]
3. "What free tier changes happened this month?" → track_changes with since="2026-03-01"
4. "Recommend a stack for a Next.js SaaS app" → plan_stack with mode="recommend", use_case="Next.js SaaS app"
5. "Is Heroku's free tier still available?" → search_deals with vendor="Heroku"
`;
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(llmsFullTxt);
  } else if (url.pathname === "/AGENTS.md" && isGetOrHead) {
    try {
      const agentsMd = readFileSync(join(__dirname, "..", "AGENTS.md"), "utf-8");
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=3600" });
      res.end(agentsMd);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  } else if (url.pathname === "/sitemap.xml" && isGetOrHead) {
    const now = new Date().toISOString().split("T")[0];
    const categoryUrls = categories.map((c) => `  <url>
    <loc>${BASE_URL}/category/${toSlug(c.name)}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`).join("\n");
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${BASE_URL}/</loc>
    <lastmod>${now}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${BASE_URL}/feed.xml</loc>
    <lastmod>${now}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.5</priority>
  </url>
  <url>
    <loc>${BASE_URL}/api/docs</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>${BASE_URL}/setup</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${BASE_URL}/privacy</loc>
    <lastmod>${now}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>${BASE_URL}/expiring</loc>
    <lastmod>${now}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${BASE_URL}/changes</loc>
    <lastmod>${now}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${BASE_URL}/freshness</loc>
    <lastmod>${now}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>${BASE_URL}/agent-stack</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${BASE_URL}/category</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${BASE_URL}/best</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
${Array.from(bestOfSlugMap.keys()).map(s => `  <url>
    <loc>${BASE_URL}/best/${s}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`).join("\n")}
  <url>
    <loc>${BASE_URL}/compare</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
${categoryUrls}
${Array.from(comparisonMap.keys()).map(s => `  <url>
    <loc>${BASE_URL}/compare/${s}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`).join("\n")}
  <url>
    <loc>${BASE_URL}/vendor</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
${Array.from(vendorSlugMap.keys()).map(s => `  <url>
    <loc>${BASE_URL}/vendor/${s}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>`).join("\n")}
  <url>
    <loc>${BASE_URL}/digest/archive</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
${getRecentWeekKeys(4).map(wk => `  <url>
    <loc>${BASE_URL}/digest/${wk}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>`).join("\n")}
  <url>
    <loc>${BASE_URL}/trends</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
${categories.map(c => `  <url>
    <loc>${BASE_URL}/trends/${toSlug(c.name)}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.5</priority>
  </url>`).join("\n")}
${ALTERNATIVES_PAGES.map(p => `  <url>
    <loc>${BASE_URL}/${p.slug}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>`).join("\n")}
  <url>
    <loc>${BASE_URL}/alternatives</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${BASE_URL}/alternative-to</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
${Array.from(vendorSlugMap.keys()).map(s => `  <url>
    <loc>${BASE_URL}/alternative-to/${s}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.5</priority>
  </url>`).join("\n")}
</urlset>`;
    res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(sitemapXml);
  } else if (url.pathname === "/") {
    recordLandingPageView();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(landingPageHtml);
  } else if ((url.pathname === "/best" || url.pathname === "/best/") && isGetOrHead) {
    recordApiHit("/best");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/best", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: bestOfSlugMap.size });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildBestOfIndexPage());
  } else if (url.pathname.startsWith("/best/") && isGetOrHead) {
    const slug = url.pathname.slice("/best/".length).replace(/\/$/, "");
    const html = buildBestOfPage(slug);
    if (html) {
      recordApiHit("/best/:slug");
      logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/best/" + slug, params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
      res.end(html);
    } else {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Best-of list not found — AgentDeals</title><style>body{font-family:-apple-system,sans-serif;background:#0f172a;color:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}a{color:#3b82f6}.box{text-align:center;max-width:480px;padding:2rem}</style></head><body><div class="box"><h1 style="font-size:3rem;margin-bottom:.5rem">404</h1><p>Best-of list "<strong>${escHtmlServer(slug)}</strong>" not found.</p><p style="margin-top:1rem"><a href="/best">Browse all best-of lists</a></p></div></body></html>`);
    }
  } else if ((url.pathname === "/category" || url.pathname === "/category/") && isGetOrHead) {
    recordApiHit("/category");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/category", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: stats.categories });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildCategoryIndexPage());
  } else if (url.pathname.startsWith("/category/") && isGetOrHead) {
    const slug = url.pathname.slice("/category/".length).replace(/\/$/, "");
    const html = buildCategoryPage(slug);
    if (html) {
      recordApiHit("/category/:slug");
      logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/category/" + slug, params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
      res.end(html);
    } else {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Category not found — AgentDeals</title><style>body{font-family:-apple-system,sans-serif;background:#0f172a;color:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}a{color:#3b82f6}.box{text-align:center;max-width:480px;padding:2rem}</style></head><body><div class="box"><h1 style="font-size:3rem;margin-bottom:.5rem">404</h1><p>Category "<strong>${escHtmlServer(slug)}</strong>" not found.</p><p style="margin-top:1rem"><a href="/">Browse all ${stats.categories} categories on AgentDeals</a></p></div></body></html>`);
    }
  } else if (url.pathname === "/compare" && isGetOrHead) {
    recordApiHit("/compare");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/compare", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: comparisonMap.size });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildCompareIndexPage());
  } else if (url.pathname.startsWith("/compare/") && isGetOrHead) {
    const slug = url.pathname.slice("/compare/".length).replace(/\/$/, "");
    // Check for reverse URL (e.g., netlify-vs-vercel → vercel-vs-netlify)
    if (!comparisonMap.has(slug) && slug.includes("-vs-")) {
      const parts = slug.split("-vs-");
      if (parts.length === 2) {
        const reversed = `${parts[1]}-vs-${parts[0]}`;
        if (comparisonMap.has(reversed)) {
          res.writeHead(301, { Location: `/compare/${reversed}` });
          res.end();
          return;
        }
      }
    }
    const html = buildComparisonPage(slug);
    if (html) {
      recordApiHit("/compare/:slug");
      logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/compare/" + slug, params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
      res.end(html);
    } else {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Comparison not found — AgentDeals</title><style>body{font-family:-apple-system,sans-serif;background:#0f172a;color:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}a{color:#3b82f6}.box{text-align:center;max-width:480px;padding:2rem}</style></head><body><div class="box"><h1 style="font-size:3rem;margin-bottom:.5rem">404</h1><p>Comparison not found.</p><p style="margin-top:1rem"><a href="/compare">Browse all comparisons</a></p></div></body></html>`);
    }
  } else if (url.pathname === "/digest" && isGetOrHead) {
    // Redirect to current week's digest
    const currentWeek = getCurrentWeekKey();
    res.writeHead(302, { Location: `/digest/${currentWeek}` });
    res.end();
  } else if (url.pathname === "/digest/archive" && isGetOrHead) {
    recordApiHit("/digest/archive");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/digest/archive", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildDigestArchivePage());
  } else if (url.pathname.startsWith("/digest/") && isGetOrHead) {
    const weekKey = url.pathname.slice("/digest/".length).replace(/\/$/, "");
    const html = buildDigestPage(weekKey);
    if (html) {
      recordApiHit("/digest/:week");
      logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/digest/" + weekKey, params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
      res.end(html);
    } else {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Digest not found — AgentDeals</title><style>body{font-family:-apple-system,sans-serif;background:#0f172a;color:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}a{color:#3b82f6}.box{text-align:center;max-width:480px;padding:2rem}</style></head><body><div class="box"><h1 style="font-size:3rem;margin-bottom:.5rem">404</h1><p>Invalid week format. Use YYYY-wNN (e.g., 2026-w11).</p><p style="margin-top:1rem"><a href="/digest/archive">Browse the digest archive</a></p></div></body></html>`);
    }
  } else if (url.pathname === "/vendor" && isGetOrHead) {
    recordApiHit("/vendor");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/vendor", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: vendorSlugMap.size });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildVendorIndexPage());
  } else if (url.pathname.startsWith("/vendor/") && isGetOrHead) {
    const slug = url.pathname.slice("/vendor/".length).replace(/\/$/, "");
    const html = buildVendorPage(slug);
    if (html) {
      recordApiHit("/vendor/:slug");
      logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/vendor/" + slug, params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
      res.end(html);
    } else {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vendor not found — AgentDeals</title><style>body{font-family:-apple-system,sans-serif;background:#0f172a;color:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}a{color:#3b82f6}.box{text-align:center;max-width:480px;padding:2rem}</style></head><body><div class="box"><h1 style="font-size:3rem;margin-bottom:.5rem">404</h1><p>Vendor "<strong>${escHtmlServer(slug)}</strong>" not found.</p><p style="margin-top:1rem"><a href="/vendor">Browse all ${vendorSlugMap.size} vendors</a></p></div></body></html>`);
    }
  } else if (url.pathname === "/changes" && isGetOrHead) {
    recordApiHit("/changes");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/changes", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildChangesPage());
  } else if (url.pathname === "/expiring" && isGetOrHead) {
    recordApiHit("/expiring");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/expiring", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildExpiringPage());
  } else if (url.pathname === "/agent-stack" && isGetOrHead) {
    recordApiHit("/agent-stack");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/agent-stack", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildAgentStackPage());
  } else if (url.pathname === "/freshness" && isGetOrHead) {
    recordApiHit("/freshness");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/freshness", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildFreshnessPage());
  } else if (url.pathname === "/setup" && isGetOrHead) {
    recordApiHit("/setup");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/setup", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildSetupPage());
  } else if (url.pathname === "/privacy" && isGetOrHead) {
    recordApiHit("/privacy");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/privacy", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildPrivacyPage());
  } else if (url.pathname === "/search" && isGetOrHead) {
    const query = url.searchParams.get("q") ?? "";
    const categoryFilter = url.searchParams.get("category") ?? "";
    const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
    recordApiHit("/search");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/search", params: { q: query, category: categoryFilter, page: String(page) }, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" });
    res.end(buildSearchPage(query, categoryFilter, page));
  } else if (url.pathname === "/alternatives" && isGetOrHead) {
    recordApiHit("/alternatives");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/alternatives", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: ALTERNATIVES_PAGES.length });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildAlternativesHubPage());
  } else if (url.pathname === "/alternative-to" && isGetOrHead) {
    recordApiHit("/alternative-to");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/alternative-to", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildAlternativesIndexPage());
  } else if (url.pathname.startsWith("/alternative-to/") && isGetOrHead) {
    const slug = url.pathname.slice("/alternative-to/".length).replace(/\/$/, "");
    const html = buildAlternativesPage(slug);
    if (html) {
      recordApiHit("/alternative-to/:slug");
      logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/alternative-to/" + slug, params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
      res.end(html);
    } else {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vendor not found — AgentDeals</title><style>body{font-family:-apple-system,sans-serif;background:#0f172a;color:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}a{color:#3b82f6}.box{text-align:center;max-width:480px;padding:2rem}</style></head><body><div class="box"><h1 style="font-size:3rem;margin-bottom:.5rem">404</h1><p>Vendor "<strong>${escHtmlServer(slug)}</strong>" not found.</p><p style="margin-top:1rem"><a href="/alternative-to">Browse all alternatives</a></p></div></body></html>`);
    }
  } else if (url.pathname === "/trends" && isGetOrHead) {
    recordApiHit("/trends");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/trends", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: categories.length });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildTrendsIndexPage());
  } else if (url.pathname.startsWith("/trends/") && isGetOrHead) {
    const slug = url.pathname.slice("/trends/".length).replace(/\/$/, "");
    const html = buildTrendsPage(slug);
    if (html) {
      recordApiHit("/trends/:slug");
      logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/trends/" + slug, params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
      res.end(html);
    } else {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trends not found — AgentDeals</title><style>body{font-family:-apple-system,sans-serif;background:#0f172a;color:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}a{color:#3b82f6}.box{text-align:center;max-width:480px;padding:2rem}</style></head><body><div class="box"><h1 style="font-size:3rem;margin-bottom:.5rem">404</h1><p>Category "<strong>${escHtmlServer(slug)}</strong>" not found.</p><p style="margin-top:1rem"><a href="/trends">Browse all category trends</a></p></div></body></html>`);
    }
  } else if (url.pathname === "/ai-free-tiers" && isGetOrHead) {
    recordApiHit("/ai-free-tiers");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/ai-free-tiers", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildAiFreeTiersPage());
  } else if (url.pathname === "/hosting-alternatives" && isGetOrHead) {
    recordApiHit("/hosting-alternatives");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/hosting-alternatives", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildHostingAlternativesPage());
  } else if (url.pathname === "/database-alternatives" && isGetOrHead) {
    recordApiHit("/database-alternatives");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/database-alternatives", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildDatabaseAlternativesPage());
  } else if (url.pathname === "/monitoring-alternatives" && isGetOrHead) {
    recordApiHit("/monitoring-alternatives");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/monitoring-alternatives", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildMonitoringAlternativesPage());
  } else if (url.pathname === "/ci-cd-alternatives" && isGetOrHead) {
    recordApiHit("/ci-cd-alternatives");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/ci-cd-alternatives", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildCiCdAlternativesPage());
  } else if (url.pathname === "/security-alternatives" && isGetOrHead) {
    recordApiHit("/security-alternatives");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/security-alternatives", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildSecurityAlternativesPage());
  } else if (url.pathname === "/testing-alternatives" && isGetOrHead) {
    recordApiHit("/testing-alternatives");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/testing-alternatives", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildTestingAlternativesPage());
  } else if (url.pathname === "/storage-alternatives" && isGetOrHead) {
    recordApiHit("/storage-alternatives");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/storage-alternatives", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildStorageAlternativesPage());
  } else if (url.pathname === "/analytics-alternatives" && isGetOrHead) {
    recordApiHit("/analytics-alternatives");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/analytics-alternatives", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildAnalyticsAlternativesPage());
  } else if (url.pathname === "/ai-ml-alternatives" && isGetOrHead) {
    recordApiHit("/ai-ml-alternatives");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/ai-ml-alternatives", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildAiMlAlternativesPage());
  } else if (url.pathname === "/email-alternatives" && isGetOrHead) {
    recordApiHit("/email-alternatives");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/email-alternatives", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildEmailAlternativesPage());
  } else if (url.pathname === "/design-alternatives" && isGetOrHead) {
    recordApiHit("/design-alternatives");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/design-alternatives", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildDesignAlternativesPage());
  } else if (url.pathname === "/project-management-alternatives" && isGetOrHead) {
    recordApiHit("/project-management-alternatives");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/project-management-alternatives", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildProjectManagementAlternativesPage());
  } else if (alternativesPageMap.has(url.pathname.slice(1)) && isGetOrHead) {
    const slug = url.pathname.slice(1);
    recordApiHit("/" + slug);
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/" + slug, params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildTimelyAlternativesPage(slug)!);
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }
});

httpServer.listen(PORT, () => {
  console.error(`agentdeals MCP server running on http://localhost:${PORT}/mcp`);
});

// IndexNow + sitemap ping on startup (fire-and-forget, no impact on server readiness)
async function pingSearchEngines(): Promise<void> {
  // Build priority URL list for IndexNow (most important pages first)
  const urlList: string[] = [
    `${BASE_URL}/`,
    `${BASE_URL}/changes`,
    `${BASE_URL}/search`,
    `${BASE_URL}/category`,
    `${BASE_URL}/expiring`,
    `${BASE_URL}/freshness`,
    `${BASE_URL}/agent-stack`,
    `${BASE_URL}/setup`,
    `${BASE_URL}/best`,
    `${BASE_URL}/compare`,
    `${BASE_URL}/digest/archive`,
    `${BASE_URL}/trends`,
    `${BASE_URL}/vendor`,
    `${BASE_URL}/alternative-to`,
  ];
  // Add alternatives hub + individual pages
  urlList.push(`${BASE_URL}/alternatives`);
  for (const p of ALTERNATIVES_PAGES) {
    urlList.push(`${BASE_URL}/${p.slug}`);
  }
  // Add category pages
  for (const c of categories) {
    urlList.push(`${BASE_URL}/category/${toSlug(c.name)}`);
  }
  // Add best-of pages
  for (const s of bestOfSlugMap.keys()) {
    urlList.push(`${BASE_URL}/best/${s}`);
  }
  // Add comparison pages
  for (const s of comparisonMap.keys()) {
    urlList.push(`${BASE_URL}/compare/${s}`);
  }
  // Add vendor pages (top by recent changes first, then alphabetical — cap at ~2000 to stay well under 10k limit)
  const changedVendorSlugs = new Set(dealChanges.map((dc: any) => toSlug(dc.vendor)));
  const vendorSlugs = Array.from(vendorSlugMap.keys());
  const sortedVendorSlugs = [
    ...vendorSlugs.filter(s => changedVendorSlugs.has(s)),
    ...vendorSlugs.filter(s => !changedVendorSlugs.has(s)),
  ].slice(0, 2000);
  for (const s of sortedVendorSlugs) {
    urlList.push(`${BASE_URL}/vendor/${s}`);
  }

  // Ping sitemap to search engines
  const sitemapUrl = `${BASE_URL}/sitemap.xml`;
  const sitemapPings = [
    `https://www.bing.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`,
    `https://www.google.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`,
  ];
  for (const pingUrl of sitemapPings) {
    try {
      const resp = await fetch(pingUrl, { signal: AbortSignal.timeout(10000) });
      console.error(`Sitemap ping ${new URL(pingUrl).hostname}: ${resp.status}`);
    } catch (err: any) {
      console.error(`Sitemap ping ${new URL(pingUrl).hostname} failed: ${err.message}`);
    }
  }

  // Submit to IndexNow (requires INDEXNOW_KEY)
  if (!INDEXNOW_KEY) {
    console.error("IndexNow: skipped (INDEXNOW_KEY not set)");
    return;
  }
  try {
    const payload = {
      host: new URL(BASE_URL).hostname,
      key: INDEXNOW_KEY,
      keyLocation: `${BASE_URL}/${INDEXNOW_KEY}.txt`,
      urlList,
    };
    const resp = await fetch("https://api.indexnow.org/IndexNow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    console.error(`IndexNow: submitted ${urlList.length} URLs, status ${resp.status}`);
  } catch (err: any) {
    console.error(`IndexNow: failed — ${err.message}`);
  }
}

// Run ping in background on production only — don't block server startup or interfere with tests
if (!BASE_URL.includes("localhost")) {
  pingSearchEngines().catch((err) => console.error(`pingSearchEngines error: ${err.message}`));
}

// Flush telemetry every 5 minutes
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => flushTelemetry(), FLUSH_INTERVAL_MS).unref();

// Flush on graceful shutdown
async function onShutdown() {
  await flushTelemetry();
  process.exit(0);
}
process.on("SIGTERM", () => onShutdown());
process.on("SIGINT", () => onShutdown());

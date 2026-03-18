import { createServer as createHttpServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { loadOffers, getCategories, getNewOffers, getNewestDeals, searchOffers, enrichOffers, loadDealChanges, getDealChanges, getOfferDetails, compareServices, checkVendorRisk, auditStack, getExpiringDeals, getWeeklyDigest } from "./data.js";
import { getStackRecommendation } from "./stacks.js";
import { estimateCosts } from "./costs.js";
import { recordApiHit, recordSessionConnect, recordSessionDisconnect, recordLandingPageView, getStats, getConnectionStats, loadTelemetry, flushTelemetry, logRequest, getRequestLog, recordPageView, getPageViews } from "./stats.js";
import { openapiSpec } from "./openapi.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const BASE_URL = (process.env.BASE_URL ?? "https://agentdeals.dev").replace(/\/+$/, "");

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
        "@type": "Event",
        name: `${c.vendor}: ${(changeTypeBadge[c.change_type] ?? { label: c.change_type }).label}`,
        description: c.summary,
        startDate: c.date,
        location: { "@type": "VirtualLocation", url: `${BASE_URL}/vendor/${c.vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}` },
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

type NavSection = "search" | "categories" | "best" | "trends" | "alternatives" | "compare" | "digest" | "changes" | "expiring" | "api" | "setup" | "home";

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
    { href: "/trends", label: "Trends", section: "trends" },
    { href: "/alternative-to", label: "Alternatives", section: "alternatives" },
    { href: "/compare", label: "Compare", section: "compare" },
    { href: "/digest", label: "Digest", section: "digest" },
    { href: "/changes", label: "Changes", section: "changes" },
    { href: "/expiring", label: "Expiring", section: "expiring" },
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
  <footer>AgentDeals &mdash; open source, built for agents</footer>
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

  <footer>AgentDeals &mdash; open source, built for agents</footer>
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
  <footer>AgentDeals &mdash; open source, built for agents</footer>
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

  <footer>AgentDeals &mdash; open source, built for agents</footer>
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
  <footer>AgentDeals &mdash; open source, built for agents</footer>
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
  <footer>AgentDeals &mdash; open source, built for agents</footer>
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
  <footer>AgentDeals &mdash; open source, built for agents</footer>
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

  <footer>AgentDeals &mdash; open source, built for agents</footer>
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
  <footer>AgentDeals &mdash; open source, built for agents</footer>
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
  <footer>AgentDeals &mdash; open source, built for agents</footer>
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
${curatedHtml}
${allAltsHtml}
  <div class="section">
    <h2>Category Trends</h2>
    <p class="section-note">See the broader pricing landscape for ${vendorCategories.length > 1 ? "these categories" : "this category"}.</p>
    ${trendsHtml}
  </div>
${altFaqHtml}
  ${buildMcpCta("Find alternatives from your AI coding assistant. Search 1,500+ deals, compare free tiers, and track pricing changes — directly in your editor.")}
  <footer>AgentDeals &mdash; open source, built for agents</footer>
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

  <footer>AgentDeals &mdash; open source, built for agents</footer>
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
}

const ALTERNATIVES_PAGES: AlternativesPageConfig[] = [
  {
    slug: "localstack-alternatives",
    title: "LocalStack CE Alternatives — Free and Open Source Options for 2026",
    metaDesc: "LocalStack Community Edition shuts down March 23, 2026. Compare free alternatives: Moto, Testcontainers, MinIO, and more. Verified pricing and free tier details.",
    contextHtml: `<p>LocalStack Community Edition — the open-source AWS cloud emulator used by thousands of developers — <strong>shuts down on March 23, 2026</strong>. The single unified image now requires registration and an auth token. Commercial use requires a paid plan starting at $39/month.</p>
      <p>If you relied on LocalStack CE for local AWS development and testing, here are the best free and open-source alternatives available today.</p>`,
    tag: "localstack-alternative",
    primaryVendor: "LocalStack",
  },
  {
    slug: "postman-alternatives",
    title: "Postman Alternatives — Free API Testing Tools for Teams in 2026",
    metaDesc: "Postman's free plan is now single-user only (March 2026). Compare free alternatives for teams: Bruno, Hoppscotch, Insomnia, Thunder Client, Apidog. Verified pricing.",
    contextHtml: `<p>Postman's free plan changed in <strong>March 2026</strong>: it is now <strong>single-user only</strong>. Team collaboration features — shared workspaces, collection sharing — are paywalled at $19/user/month.</p>
      <p>If your team relied on Postman's free tier for API development, here are the best free alternatives with team-friendly features.</p>`,
    tag: "postman-alternative",
    primaryVendor: "Postman",
  },
  {
    slug: "terraform-alternatives",
    title: "HCP Terraform Alternatives — Free IaC Tools After the March 2026 EOL",
    metaDesc: "HCP Terraform legacy free plan ends March 31, 2026. Compare free alternatives: Spacelift, Terragrunt Scale, Pulumi, Scalr, and more. Verified pricing and free tier details.",
    contextHtml: `<p>HCP Terraform's legacy free plan reaches <strong>end-of-life on March 31, 2026</strong>. Organizations on the legacy plan will be auto-transitioned to an enhanced free tier — but with a <strong>500 managed resource cap</strong> (previously unlimited for small teams).</p>
      <p>This isn't a complete shutdown — the new enhanced tier includes SSO, policy as code, and unlimited users. But if the 500-resource limit doesn't fit your workloads, here are free IaC alternatives worth evaluating.</p>`,
    tag: "terraform-alternative",
    primaryVendor: "HCP Terraform",
  },
];

const alternativesPageMap = new Map<string, AlternativesPageConfig>();
for (const page of ALTERNATIVES_PAGES) {
  alternativesPageMap.set(page.slug, page);
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
  const primaryOffer = offers.find(o => o.vendor === config.primaryVendor);
  const categoryOffers = primaryOffer
    ? offers.filter(o => o.category === primaryOffer.category && o.vendor !== config.primaryVendor && !taggedOffers.some(t => t.vendor === o.vendor))
    : [];
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
    <p>Looking for more? <a href="/search?q=${encodeURIComponent(config.primaryVendor.toLowerCase() + " alternative")}">Search all ${config.primaryVendor} alternatives</a> in our index of ${offers.length.toLocaleString()}+ developer deals.</p>
  </div>

  ${buildMcpCta("Get personalized recommendations from your AI. Search " + offers.length.toLocaleString() + "+ deals, compare free tiers, and track pricing changes — directly in your editor.")}
  <footer>AgentDeals &mdash; open source, built for agents</footer>
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

  <footer>AgentDeals &mdash; open source, built for agents</footer>
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
        "@type": "Event",
        name: `${c.vendor}: ${(changeTypeBadge[c.change_type] ?? { label: c.change_type }).label}`,
        description: c.summary,
        startDate: c.date,
        location: { "@type": "VirtualLocation", url: `${BASE_URL}/vendor/${toSlug(c.vendor)}` },
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

  <footer>AgentDeals &mdash; open source, built for agents</footer>
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
        "@type": "Event",
        name: `${c.vendor}: ${(changeTypeBadge[c.change_type] ?? { label: c.change_type }).label}`,
        description: c.summary,
        startDate: c.date,
        location: { "@type": "VirtualLocation", url: `${BASE_URL}/vendor/${toSlug(c.vendor)}` },
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

  <footer>AgentDeals &mdash; open source, built for agents</footer>
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

  <footer>AgentDeals &mdash; open source, built for agents</footer>
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
  <footer>AgentDeals &mdash; open source, built for agents</footer>
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

  <footer>AgentDeals &mdash; open source, built for agents</footer>
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
<link rel="canonical" href="${BASE_URL}/">
<link rel="alternate" type="application/atom+xml" title="AgentDeals — Pricing Changes" href="/feed.xml">
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

  <footer>AgentDeals &mdash; open source, built for agents</footer>
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
        url.pathname === "/llms-full.txt";
      if (!skip) {
        const target = `${BASE_URL}${url.pathname}${url.search}`;
        res.writeHead(301, { Location: target });
        res.end();
        return;
      }
    }
  }

  // Feed URL aliases — redirect common feed paths to canonical /feed.xml
  if ((url.pathname === "/rss" || url.pathname === "/feed" || url.pathname === "/atom") && req.method === "GET") {
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
  } else if (url.pathname === "/api/stack" && req.method === "GET") {
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
  } else if (url.pathname === "/api/costs" && req.method === "GET") {
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
  } else if (url.pathname === "/api/query-log" && req.method === "GET") {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 200);
    const entries = await getRequestLog(limit);
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ entries, count: entries.length }));
  } else if (url.pathname === "/api/openapi.json" && req.method === "GET") {
    recordApiHit("/api/openapi.json");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/openapi.json", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(openapiSpec));
  } else if (url.pathname === "/api/stats" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(getConnectionStats(sessions.size)));
  } else if (url.pathname === "/api/pageviews" && req.method === "GET") {
    const data = await getPageViews();
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(data));
  } else if (url.pathname === "/api/offers" && req.method === "GET") {
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
  } else if (url.pathname === "/api/compare" && req.method === "GET") {
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
  } else if (url.pathname === "/api/new" && req.method === "GET") {
    recordApiHit("/api/new");
    const days = parseInt(url.searchParams.get("days") ?? "7", 10);
    const result = getNewOffers(days);
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/new", params: { days }, user_agent: req.headers["user-agent"] ?? "unknown", result_count: result.offers.length });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(result));
  } else if (url.pathname === "/api/newest" && req.method === "GET") {
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
  } else if (url.pathname === "/api/categories" && req.method === "GET") {
    recordApiHit("/api/categories");
    const cats = getCategories();
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/categories", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: cats.length });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ categories: cats }));
  } else if (url.pathname === "/api/changes" && req.method === "GET") {
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
  } else if (url.pathname === "/api/audit-stack" && req.method === "GET") {
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
  } else if (url.pathname.startsWith("/api/vendor-risk/") && req.method === "GET") {
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
  } else if (url.pathname.startsWith("/api/details/") && req.method === "GET") {
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
  } else if (url.pathname === "/api/expiring" && req.method === "GET") {
    recordApiHit("/api/expiring");
    const withinDays = Math.min(Math.max(parseInt(url.searchParams.get("within_days") ?? "30", 10) || 30, 1), 365);
    const result = getExpiringDeals(withinDays);
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/expiring", params: { within_days: withinDays }, user_agent: req.headers["user-agent"] ?? "unknown", result_count: result.total });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(result));
  } else if (url.pathname === "/api/digest" && req.method === "GET") {
    recordApiHit("/api/digest");
    const digest = getWeeklyDigest();
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/digest", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: digest.deal_changes.length });
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(digest));
  } else if (url.pathname === "/api" && req.method === "GET") {
    res.writeHead(301, { "Location": "/api/docs" });
    res.end();
  } else if (url.pathname === "/api/docs" && req.method === "GET") {
    recordApiHit("/api/docs");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(swaggerDocsHtml);
  } else if (url.pathname.startsWith("/api/docs/") && req.method === "GET") {
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
  } else if ((url.pathname === "/feed.xml" || url.pathname === "/api/feed") && req.method === "GET") {
    const feedPath = url.pathname === "/feed.xml" ? "/feed.xml" : "/api/feed";
    recordApiHit(feedPath);
    const baseUrl = BASE_URL;
    const allChanges = [...dealChanges].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 50);
    const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
    const changeLabel: Record<string, string> = {
      free_tier_removed: "Free Tier Removed",
      limits_reduced: "Limits Reduced",
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
  } else if (url.pathname === "/robots.txt" && req.method === "GET") {
    const robotsTxt = `User-agent: *\nAllow: /\n\nSitemap: ${BASE_URL}/sitemap.xml\n`;
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" });
    res.end(robotsTxt);
  } else if (url.pathname === "/llms.txt" && req.method === "GET") {
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
  } else if (url.pathname === "/llms-full.txt" && req.method === "GET") {
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
  } else if (url.pathname === "/sitemap.xml" && req.method === "GET") {
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
  } else if ((url.pathname === "/best" || url.pathname === "/best/") && req.method === "GET") {
    recordApiHit("/best");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/best", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: bestOfSlugMap.size });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildBestOfIndexPage());
  } else if (url.pathname.startsWith("/best/") && req.method === "GET") {
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
  } else if ((url.pathname === "/category" || url.pathname === "/category/") && req.method === "GET") {
    recordApiHit("/category");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/category", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: stats.categories });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildCategoryIndexPage());
  } else if (url.pathname.startsWith("/category/") && req.method === "GET") {
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
  } else if (url.pathname === "/compare" && req.method === "GET") {
    recordApiHit("/compare");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/compare", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: comparisonMap.size });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildCompareIndexPage());
  } else if (url.pathname.startsWith("/compare/") && req.method === "GET") {
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
  } else if (url.pathname === "/digest" && req.method === "GET") {
    // Redirect to current week's digest
    const currentWeek = getCurrentWeekKey();
    res.writeHead(302, { Location: `/digest/${currentWeek}` });
    res.end();
  } else if (url.pathname === "/digest/archive" && req.method === "GET") {
    recordApiHit("/digest/archive");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/digest/archive", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildDigestArchivePage());
  } else if (url.pathname.startsWith("/digest/") && req.method === "GET") {
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
  } else if (url.pathname === "/vendor" && req.method === "GET") {
    recordApiHit("/vendor");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/vendor", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: vendorSlugMap.size });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildVendorIndexPage());
  } else if (url.pathname.startsWith("/vendor/") && req.method === "GET") {
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
  } else if (url.pathname === "/changes" && req.method === "GET") {
    recordApiHit("/changes");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/changes", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildChangesPage());
  } else if (url.pathname === "/expiring" && req.method === "GET") {
    recordApiHit("/expiring");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/expiring", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildExpiringPage());
  } else if (url.pathname === "/setup" && req.method === "GET") {
    recordApiHit("/setup");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/setup", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildSetupPage());
  } else if (url.pathname === "/search" && req.method === "GET") {
    const query = url.searchParams.get("q") ?? "";
    const categoryFilter = url.searchParams.get("category") ?? "";
    const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
    recordApiHit("/search");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/search", params: { q: query, category: categoryFilter, page: String(page) }, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" });
    res.end(buildSearchPage(query, categoryFilter, page));
  } else if (url.pathname === "/alternative-to" && req.method === "GET") {
    recordApiHit("/alternative-to");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/alternative-to", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: 1 });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildAlternativesIndexPage());
  } else if (url.pathname.startsWith("/alternative-to/") && req.method === "GET") {
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
  } else if (url.pathname === "/trends" && req.method === "GET") {
    recordApiHit("/trends");
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/trends", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: categories.length });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(buildTrendsIndexPage());
  } else if (url.pathname.startsWith("/trends/") && req.method === "GET") {
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
  } else if (alternativesPageMap.has(url.pathname.slice(1)) && req.method === "GET") {
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

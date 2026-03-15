import { createServer as createHttpServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { loadOffers, getCategories, getNewOffers, getNewestDeals, searchOffers, enrichOffers, loadDealChanges, getDealChanges, getOfferDetails, compareServices, checkVendorRisk, auditStack, getExpiringDeals } from "./data.js";
import { getStackRecommendation } from "./stacks.js";
import { estimateCosts } from "./costs.js";
import { recordApiHit, recordSessionConnect, recordSessionDisconnect, recordLandingPageView, getStats, getConnectionStats, loadTelemetry, flushTelemetry, logRequest, getRequestLog } from "./stats.js";
import { openapiSpec } from "./openapi.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT ?? "3000", 10);

// Load favicon from logo PNG at startup
const faviconBuffer = readFileSync(join(__dirname, "..", "assets", "logo-400.png"));

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
    body { margin: 0; background: #14120b; color: #e8e0d0; }
    .topbar { display: none; }
    /* Dark theme overrides matching landing page */
    .swagger-ui { background: #14120b; }
    .swagger-ui .opblock-tag { color: #e8e0d0; border-bottom-color: #2a2520; }
    .swagger-ui .opblock-tag:hover { background: rgba(200,164,78,0.05); }
    .swagger-ui .opblock-tag small { color: #a09880; }
    .swagger-ui .opblock .opblock-summary { border-color: #2a2520; }
    .swagger-ui .opblock.opblock-get { background: rgba(97,175,254,0.05); border-color: rgba(97,175,254,0.3); }
    .swagger-ui .opblock.opblock-get .opblock-summary { border-color: rgba(97,175,254,0.3); }
    .swagger-ui .opblock.opblock-post { background: rgba(73,204,144,0.05); border-color: rgba(73,204,144,0.3); }
    .swagger-ui .opblock.opblock-post .opblock-summary { border-color: rgba(73,204,144,0.3); }
    .swagger-ui .opblock .opblock-summary-description { color: #a09880; }
    .swagger-ui .opblock-body { background: #1a1710; }
    .swagger-ui .opblock-description-wrapper p,
    .swagger-ui .opblock-external-docs-wrapper p { color: #c0b8a0; }
    .swagger-ui table thead tr th { color: #c8a44e; border-bottom-color: #2a2520; }
    .swagger-ui table tbody tr td { color: #e8e0d0; border-bottom-color: #2a2520; }
    .swagger-ui .parameter__name { color: #e8e0d0; }
    .swagger-ui .parameter__type { color: #a09880; }
    .swagger-ui .parameter__in { color: #a09880; }
    .swagger-ui .response-col_status { color: #c8a44e; }
    .swagger-ui .response-col_description { color: #c0b8a0; }
    .swagger-ui .responses-inner { background: #14120b; }
    .swagger-ui .model-box { background: #1a1710; }
    .swagger-ui .model { color: #e8e0d0; }
    .swagger-ui .model-title { color: #c8a44e; }
    .swagger-ui section.models { border-color: #2a2520; }
    .swagger-ui section.models h4 { color: #e8e0d0; border-bottom-color: #2a2520; }
    .swagger-ui .model-container { background: #1a1710; }
    .swagger-ui .prop-type { color: #c8a44e; }
    .swagger-ui .prop-format { color: #a09880; }
    .swagger-ui .info .title { color: #e8e0d0; }
    .swagger-ui .info .title small { background: #c8a44e; color: #14120b; }
    .swagger-ui .info p, .swagger-ui .info li { color: #c0b8a0; }
    .swagger-ui .info a { color: #c8a44e; }
    .swagger-ui .scheme-container { background: #1a1710; border-bottom-color: #2a2520; box-shadow: none; }
    .swagger-ui .scheme-container .schemes > label { color: #a09880; }
    .swagger-ui select { background: #1a1710; color: #e8e0d0; border-color: #2a2520; }
    .swagger-ui input[type=text], .swagger-ui textarea { background: #1a1710; color: #e8e0d0; border-color: #2a2520; }
    .swagger-ui .btn { color: #e8e0d0; border-color: #2a2520; }
    .swagger-ui .btn.execute { background: #c8a44e; color: #14120b; border-color: #c8a44e; }
    .swagger-ui .btn.authorize { color: #c8a44e; border-color: #c8a44e; }
    .swagger-ui .highlight-code { background: #1a1710; }
    .swagger-ui .highlight-code .microlight { color: #e8e0d0; background: #1a1710; }
    .swagger-ui .copy-to-clipboard { background: #1a1710; }
    .swagger-ui .download-contents { color: #c8a44e; }
    .swagger-ui .opblock-body pre.microlight { background: #1a1710 !important; color: #e8e0d0; border: 1px solid #2a2520; }
    .swagger-ui .response-control-media-type__accept-message { color: #c8a44e; }
    .swagger-ui .loading-container .loading::after { color: #c8a44e; }
    /* Back link */
    .back-link { display: block; padding: 12px 20px; background: #1a1710; border-bottom: 1px solid #2a2520; font-family: 'Inter', sans-serif; font-size: 14px; }
    .back-link a { color: #c8a44e; text-decoration: none; }
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

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Build category slug → name lookup
const categorySlugMap = new Map<string, string>();
for (const cat of categories) {
  categorySlugMap.set(toSlug(cat.name), cat.name);
}

function escHtmlServer(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildCategoryPage(slug: string): string | null {
  const categoryName = categorySlugMap.get(slug);
  if (!categoryName) return null;

  const catOffers = offers.filter((o) => o.category === categoryName);
  const catCount = catOffers.length;
  const title = `Free ${categoryName} Tools & Deals (${catCount} offers) — AgentDeals`;
  const metaDesc = `Compare ${catCount} free ${categoryName.toLowerCase()} tools, free tiers, and developer deals. Verified pricing for ${catOffers.slice(0, 5).map(o => o.vendor).join(", ")}${catCount > 5 ? " and more" : ""}.`;

  const offersHtml = catOffers.map((o) => `        <tr>
          <td style="font-weight:600;color:var(--text);white-space:nowrap"><a href="${escHtmlServer(o.url)}" style="color:var(--text)">${escHtmlServer(o.vendor)}</a></td>
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
<link rel="canonical" href="https://agentdeals-production.up.railway.app/category/${slug}">
<meta property="og:title" content="${escHtmlServer(title)}">
<meta property="og:description" content="${escHtmlServer(metaDesc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="https://agentdeals-production.up.railway.app/category/${slug}">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#14120b;--bg-elevated:#1c1a12;--bg-card:rgba(28,26,18,0.6);--border:#2a2720;--border-hover:#c8a44e;--text:#e8e0cc;--text-muted:#9e9685;--text-dim:#6b6356;--accent:#c8a44e;--accent-hover:#dbb85e;--accent-glow:rgba(200,164,78,0.15);--serif:'DM Serif Display',Georgia,serif;--sans:'Inter',-apple-system,sans-serif;--mono:'JetBrains Mono',SFMono-Regular,monospace}
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
</style>
</head>
<body>
<div class="container">
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
<meta property="og:url" content="https://agentdeals-production.up.railway.app">
<meta property="og:image" content="https://raw.githubusercontent.com/robhunter/agentdeals/main/assets/logo-400.png">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="AgentDeals — Pricing Context for AI Agents">
<meta name="twitter:description" content="Your AI recommends tools from memory. Memory doesn't include pricing. ${stats.offers}+ deals across ${stats.categories} categories.">
<meta name="twitter:image" content="https://raw.githubusercontent.com/robhunter/agentdeals/main/assets/logo-400.png">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="canonical" href="https://agentdeals-production.up.railway.app/">
<link rel="alternate" type="application/rss+xml" title="AgentDeals — Pricing Changes" href="/api/feed">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "name": "AgentDeals",
      "url": "https://agentdeals-production.up.railway.app",
      "description": "${stats.offers}+ developer infrastructure deals across ${stats.categories} categories. Pricing context for AI agents.",
      "potentialAction": {
        "@type": "SearchAction",
        "target": "https://agentdeals-production.up.railway.app/api/offers?q={search_term_string}",
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
      "url": "https://agentdeals-production.up.railway.app/mcp",
      "description": "Model Context Protocol server providing AI agents with real-time developer tool pricing data"
    }
  ]
}
</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#14120b;--bg-elevated:#1c1a12;--bg-card:rgba(28,26,18,0.6);
  --border:#2a2720;--border-hover:#c8a44e;
  --text:#e8e0cc;--text-muted:#9e9685;--text-dim:#6b6356;
  --accent:#c8a44e;--accent-hover:#dbb85e;--accent-glow:rgba(200,164,78,0.15);
  --serif:'DM Serif Display',Georgia,'Times New Roman',serif;
  --sans:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --mono:'JetBrains Mono',SFMono-Regular,Consolas,monospace;
}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.6;position:relative}
body::before{content:'';position:fixed;inset:0;background:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");pointer-events:none;z-index:0}
a{color:var(--accent);text-decoration:none}
a:hover{color:var(--accent-hover);text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:0 1.5rem;position:relative;z-index:1}

/* Hero */
.hero{text-align:center;padding:5rem 0 3rem}
.hero-label{display:inline-block;font-family:var(--mono);font-size:.75rem;font-weight:500;color:var(--accent);text-transform:uppercase;letter-spacing:.15em;border:1px solid var(--border);border-radius:20px;padding:.35rem 1rem;margin-bottom:1.5rem;background:var(--accent-glow)}
.hero h1{font-family:var(--serif);font-size:3.5rem;color:var(--text);line-height:1.1;margin-bottom:1rem;letter-spacing:-.02em}
.hero h1 em{font-style:italic;color:var(--accent)}
.hero-sub{font-size:1.15rem;color:var(--text-muted);max-width:520px;margin:0 auto 2rem;line-height:1.7}
.hero-actions{display:flex;justify-content:center;gap:1rem;flex-wrap:wrap}
.btn-primary{display:inline-flex;align-items:center;gap:.5rem;padding:.75rem 1.75rem;background:var(--accent);color:var(--bg);border-radius:8px;font-size:.95rem;font-weight:600;transition:all .2s;border:none;cursor:pointer}
.btn-primary:hover{background:var(--accent-hover);text-decoration:none;transform:translateY(-1px);box-shadow:0 4px 20px rgba(200,164,78,0.3)}
.btn-secondary{display:inline-flex;align-items:center;gap:.5rem;padding:.75rem 1.75rem;background:transparent;color:var(--text);border-radius:8px;font-size:.95rem;font-weight:500;transition:all .2s;border:1px solid var(--border)}
.btn-secondary:hover{border-color:var(--accent);color:var(--accent);text-decoration:none}

/* Stats bar */
.stats-bar{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin:0 auto 4rem;max-width:640px;background:var(--bg-card);backdrop-filter:blur(12px)}
.stat-item{text-align:center;padding:1.25rem 1rem;position:relative}
.stat-item+.stat-item::before{content:'';position:absolute;left:0;top:20%;height:60%;width:1px;background:var(--border)}
.stat-num{font-family:var(--mono);font-size:1.75rem;font-weight:500;color:var(--text);letter-spacing:-.02em}
.stat-label{font-size:.75rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.1em;margin-top:.15rem}

/* Section divider */
.divider{width:100%;height:1px;background:var(--border);margin:0}
.wavy-divider{width:100%;overflow:hidden;line-height:0;margin:0}
.wavy-divider svg{display:block;width:100%;height:40px}

/* Sections */
.section{padding:4rem 0}
.section-label{font-family:var(--mono);font-size:.7rem;font-weight:500;color:var(--accent);text-transform:uppercase;letter-spacing:.2em;margin-bottom:.75rem}
.section h2{font-family:var(--serif);font-size:2rem;color:var(--text);margin-bottom:1rem;letter-spacing:-.01em}
.section p{color:var(--text-muted);margin-bottom:1rem;max-width:600px}

/* Problem / solution */
.problem-text{font-family:var(--serif);font-size:1.35rem;color:var(--text-muted);line-height:1.6;max-width:600px;margin-bottom:1rem}
.problem-text strong{color:var(--text)}

/* How it works cards */
.how-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-top:2rem}
.how-card{background:var(--bg-card);backdrop-filter:blur(12px);border:1px solid var(--border);border-radius:12px;padding:1.5rem;transition:border-color .2s}
.how-card:hover{border-color:var(--accent)}
.how-card-icon{font-family:var(--mono);font-size:.75rem;color:var(--accent);background:var(--accent-glow);display:inline-block;padding:.3rem .7rem;border-radius:6px;margin-bottom:.75rem;border:1px solid rgba(200,164,78,0.2)}
.how-card h3{font-family:var(--serif);font-size:1.1rem;color:var(--text);margin-bottom:.5rem}
.how-card p{font-size:.9rem;color:var(--text-muted);margin-bottom:.75rem}
.how-card pre{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:.75rem;font-size:.75rem;color:var(--text-muted);line-height:1.5;overflow-x:auto}
.how-card code{font-family:var(--mono);font-size:.75rem}

/* Changes */
.change-entry{padding:.75rem 0;border-bottom:1px solid rgba(42,39,32,0.6)}
.change-entry:last-child{border-bottom:none}
.change-header{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.2rem}
.change-badge{display:inline-block;padding:.15rem .5rem;border-radius:10px;font-size:.65rem;font-weight:600;color:#fff;text-transform:uppercase;letter-spacing:.04em;font-family:var(--mono)}
.change-vendor{font-weight:600;color:var(--text);font-size:.9rem}
.change-date{font-family:var(--mono);color:var(--text-dim);font-size:.75rem;margin-left:auto}
.change-summary{color:var(--text-muted);font-size:.85rem}

/* Deadlines */
.deadlines-section{background:linear-gradient(180deg,rgba(248,81,73,0.04) 0%,transparent 100%);border:1px solid rgba(248,81,73,0.15);border-radius:12px;padding:1.5rem;margin-bottom:2rem}
.deadline-item{display:flex;gap:1rem;padding:.75rem 0;border-bottom:1px solid rgba(42,39,32,0.6);align-items:flex-start}
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
.deal-cat{display:inline-block;padding:.15rem .5rem;border-radius:8px;font-size:.65rem;font-weight:500;background:var(--accent-glow);color:var(--accent);border:1px solid rgba(200,164,78,0.2)}
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
}
</style>
</head>
<body>
<div class="container">

  <div class="hero">
    <div class="hero-label">MCP Server</div>
    <h1>Deals for <em>agents.</em></h1>
    <p class="hero-sub">Your AI recommends tools from memory. Memory doesn't include pricing. AgentDeals gives agents the context to make better infrastructure recommendations.</p>
    <div class="hero-actions">
      <a href="#browse" class="btn-primary">Browse ${stats.offers.toLocaleString()}+ deals</a>
      <a href="#connect" class="btn-secondary">Connect via MCP</a>
    </div>
  </div>

  <div class="stats-bar">
    <div class="stat-item"><div class="stat-num">${stats.offers.toLocaleString()}</div><div class="stat-label">Deals</div></div>
    <div class="stat-item"><div class="stat-num">${stats.categories}</div><div class="stat-label">Categories</div></div>
    <div class="stat-item"><div class="stat-num">10</div><div class="stat-label">MCP Tools</div></div>
    <div class="stat-item"><div class="stat-num">${stats.dealChanges}</div><div class="stat-label">Changes Tracked</div></div>
  </div>

  <div class="wavy-divider"><svg viewBox="0 0 1200 40" preserveAspectRatio="none"><path d="M0,20 Q150,0 300,20 T600,20 T900,20 T1200,20 V40 H0 Z" fill="none" stroke="rgba(42,39,32,0.8)" stroke-width="1"/></svg></div>

${upcomingDeadlines.length > 0 ? `  <div class="section">
    <div class="section-label">Act Now</div>
    <h2>Pricing changes coming soon</h2>
    <p>Free tiers disappearing, prices increasing, products shutting down. Don't get caught off guard.</p>
    <div class="deadlines-section">
${buildDeadlinesHtml()}
    </div>
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
        <p>Query deals programmatically. 14 endpoints with search, filtering, risk analysis, and stack recommendations. <a href="/api/docs" style="color:var(--accent);text-decoration:underline">Interactive API Docs</a></p>
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
"url": "https://agentdeals-production.up.railway.app/mcp"</code></pre>
      </div>
    </div>
  </div>

  <div class="divider"></div>

  <div class="section">
    <div class="section-label">Deal Tracker</div>
    <h2>Recent pricing changes</h2>
    <p>Free tiers get removed. Limits change. We track it so your agent doesn't recommend dead deals.</p>
${buildChangesHtml()}
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
      "url": "https://agentdeals-production.up.railway.app/mcp"
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
          <pre><button class="copy-btn" onclick="copyConfig(this)">Copy</button><code>claude mcp add agentdeals --transport http https://agentdeals-production.up.railway.app/mcp</code></pre>
          <p style="font-size:.75rem;color:var(--text-dim);margin-top:.5rem">Or add to <code>.mcp.json</code>:</p>
          <pre><button class="copy-btn" onclick="copyConfig(this)">Copy</button><code>{
  "mcpServers": {
    "agentdeals": {
      "type": "url",
      "url": "https://agentdeals-production.up.railway.app/mcp"
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
      "url": "https://agentdeals-production.up.railway.app/mcp"
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
      "url": "https://agentdeals-production.up.railway.app/mcp",
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
      "url": "https://agentdeals-production.up.railway.app/mcp"
    }
  }
}</code></pre>
        </div>
      </div>
    </div>

    <div class="connect-block" style="margin-top:1.5rem">
      <h3 style="font-family:var(--serif);font-size:1rem;color:var(--text);margin-bottom:.75rem">12 MCP Tools</h3>
      <div style="display:grid;gap:.5rem">
        <div style="font-size:.85rem"><code style="font-family:var(--mono);color:var(--accent)">search_offers</code> <span style="color:var(--text-muted)">&mdash; Find free tiers, credits, and discounts. Filter by category, eligibility, or keyword.</span></div>
        <div style="font-size:.85rem"><code style="font-family:var(--mono);color:var(--accent)">list_categories</code> <span style="color:var(--text-muted)">&mdash; Browse all ${stats.categories} categories with offer counts.</span></div>
        <div style="font-size:.85rem"><code style="font-family:var(--mono);color:var(--accent)">get_offer_details</code> <span style="color:var(--text-muted)">&mdash; Full pricing details for a vendor, with alternatives in the same category.</span></div>
        <div style="font-size:.85rem"><code style="font-family:var(--mono);color:var(--accent)">get_new_offers</code> <span style="color:var(--text-muted)">&mdash; Recently added or updated deals, sorted newest first.</span></div>
        <div style="font-size:.85rem"><code style="font-family:var(--mono);color:var(--accent)">get_newest_deals</code> <span style="color:var(--text-muted)">&mdash; Most recently added deals with optional date and category filters.</span></div>
        <div style="font-size:.85rem"><code style="font-family:var(--mono);color:var(--accent)">get_deal_changes</code> <span style="color:var(--text-muted)">&mdash; Track pricing shifts: removals, reductions, increases, restructures.</span></div>
        <div style="font-size:.85rem"><code style="font-family:var(--mono);color:var(--accent)">get_expiring_deals</code> <span style="color:var(--text-muted)">&mdash; Find deals with upcoming expiration dates or deadlines.</span></div>
        <div style="font-size:.85rem"><code style="font-family:var(--mono);color:var(--accent)">get_stack_recommendation</code> <span style="color:var(--text-muted)">&mdash; Get a curated free-tier stack for your project type.</span></div>
        <div style="font-size:.85rem"><code style="font-family:var(--mono);color:var(--accent)">estimate_costs</code> <span style="color:var(--text-muted)">&mdash; Estimate infrastructure costs at hobby, startup, or growth scale.</span></div>
        <div style="font-size:.85rem"><code style="font-family:var(--mono);color:var(--accent)">compare_services</code> <span style="color:var(--text-muted)">&mdash; Side-by-side comparison of two vendors.</span></div>
        <div style="font-size:.85rem"><code style="font-family:var(--mono);color:var(--accent)">check_vendor_risk</code> <span style="color:var(--text-muted)">&mdash; Check if a vendor's free tier pricing is stable before depending on it.</span></div>
        <div style="font-size:.85rem"><code style="font-family:var(--mono);color:var(--accent)">audit_stack</code> <span style="color:var(--text-muted)">&mdash; Audit your stack for cost savings, pricing risks, and missing capabilities.</span></div>
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

const httpServer = createHttpServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

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
  } else if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", sessions: sessions.size, stats: getStats() }));
  } else if (url.pathname === "/.well-known/glama.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      "$schema": "https://glama.ai/mcp/schemas/connector.json",
      "maintainers": [
        { "email": "robvhunter@gmail.com" }
      ]
    }));
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
  } else if (url.pathname === "/api/feed" && req.method === "GET") {
    recordApiHit("/api/feed");
    const allChanges = [...dealChanges].sort((a, b) => b.date.localeCompare(a.date));
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
    const items = allChanges.map((c) => {
      const label = changeLabel[c.change_type] ?? c.change_type;
      return `    <item>
      <title>${escXml(c.vendor)}: ${escXml(label)}</title>
      <description>${escXml(c.summary)}</description>
      <pubDate>${new Date(c.date + "T00:00:00Z").toUTCString()}</pubDate>
      <link>${escXml(c.source_url)}</link>
      <category>${escXml(c.change_type)}</category>
      <guid isPermaLink="false">agentdeals-${escXml(c.vendor.toLowerCase().replace(/\s+/g, "-"))}-${c.date}</guid>
    </item>`;
    }).join("\n");
    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>AgentDeals — Developer Tool Pricing Changes</title>
    <description>Track pricing changes, free tier removals, and deal updates across developer infrastructure tools.</description>
    <link>https://agentdeals-production.up.railway.app</link>
    <atom:link href="https://agentdeals-production.up.railway.app/api/feed" rel="self" type="application/rss+xml"/>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`;
    logRequest({ ts: new Date().toISOString(), type: "api", endpoint: "/api/feed", params: {}, user_agent: req.headers["user-agent"] ?? "unknown", result_count: allChanges.length });
    res.writeHead(200, { "Content-Type": "application/rss+xml; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(rss);
  } else if (url.pathname === "/robots.txt" && req.method === "GET") {
    const robotsTxt = `User-agent: *\nAllow: /\n\nSitemap: https://agentdeals-production.up.railway.app/sitemap.xml\n`;
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" });
    res.end(robotsTxt);
  } else if (url.pathname === "/sitemap.xml" && req.method === "GET") {
    const now = new Date().toISOString().split("T")[0];
    const categoryUrls = categories.map((c) => `  <url>
    <loc>https://agentdeals-production.up.railway.app/category/${toSlug(c.name)}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`).join("\n");
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://agentdeals-production.up.railway.app/</loc>
    <lastmod>${now}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://agentdeals-production.up.railway.app/api/feed</loc>
    <lastmod>${now}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.5</priority>
  </url>
  <url>
    <loc>https://agentdeals-production.up.railway.app/api/docs</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
${categoryUrls}
</urlset>`;
    res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    res.end(sitemapXml);
  } else if (url.pathname === "/") {
    recordLandingPageView();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(landingPageHtml);
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
      res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Category not found — AgentDeals</title><style>body{font-family:-apple-system,sans-serif;background:#14120b;color:#e8e0cc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}a{color:#c8a44e}.box{text-align:center;max-width:480px;padding:2rem}</style></head><body><div class="box"><h1 style="font-size:3rem;margin-bottom:.5rem">404</h1><p>Category "<strong>${escHtmlServer(slug)}</strong>" not found.</p><p style="margin-top:1rem"><a href="/">Browse all ${stats.categories} categories on AgentDeals</a></p></div></body></html>`);
    }
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

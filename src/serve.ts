import { createServer as createHttpServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { loadOffers, getCategories, searchOffers, loadDealChanges } from "./data.js";
import { recordApiHit, recordSessionConnect, recordSessionDisconnect, recordLandingPageView, getStats, getConnectionStats, loadTelemetry, flushTelemetry } from "./stats.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT ?? "3000", 10);

// Load favicon from logo PNG at startup
const faviconBuffer = readFileSync(join(__dirname, "..", "assets", "logo-400.png"));
const SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // 60 seconds

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
  createdAt: number;
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

// Load cumulative telemetry from disk (survives deploys)
const telemetryFile = join(__dirname, "..", "data", "telemetry.json");
loadTelemetry(telemetryFile);

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
.stats-bar{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin:0 auto 4rem;max-width:640px;background:var(--bg-card);backdrop-filter:blur(12px)}
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
.connect-block pre{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:1rem;overflow-x:auto;font-size:.8rem;color:var(--text-muted);line-height:1.5;margin-top:.75rem}
.connect-block code{font-family:var(--mono)}

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
  .stats-bar{grid-template-columns:repeat(3,1fr);max-width:100%}
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
    <div class="stat-item"><div class="stat-num">${stats.dealChanges}</div><div class="stat-label">Changes Tracked</div></div>
  </div>

  <div class="wavy-divider"><svg viewBox="0 0 1200 40" preserveAspectRatio="none"><path d="M0,20 Q150,0 300,20 T600,20 T900,20 T1200,20 V40 H0 Z" fill="none" stroke="rgba(42,39,32,0.8)" stroke-width="1"/></svg></div>

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
        <p>Query deals programmatically with search, filtering, and pagination.</p>
        <pre><code>GET /api/offers?q=database</code></pre>
      </div>
      <div class="how-card">
        <div class="how-card-icon">03</div>
        <h3>MCP</h3>
        <p>Connect any MCP client. One line of config.</p>
        <pre><code>"url": "https://agentdeals-production.up.railway.app/mcp"</code></pre>
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
    <p>Add AgentDeals to Claude Desktop, Cursor, or any MCP client:</p>
    <div class="connect-block">
      <pre><code>{
  "mcpServers": {
    "agentdeals": {
      "url": "https://agentdeals-production.up.railway.app/mcp"
    }
  }
}</code></pre>
    </div>
    <div class="badges">
      <a class="badge" href="https://github.com/robhunter/agentdeals"><span class="badge-dot"></span>GitHub</a>
      <a class="badge" href="https://registry.modelcontextprotocol.io/v0.1/servers/io.github.robhunter%2Fagentdeals/versions"><span class="badge-dot"></span>MCP Registry</a>
      <a class="badge" href="https://glama.ai/mcp/connectors/io.github.robhunter/agentdeals"><span class="badge-dot"></span>Glama</a>
    </div>
  </div>

  <footer>AgentDeals &mdash; open source, built for agents</footer>
</div>
<script>
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
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            const now = Date.now();
            sessions.set(sid, { transport, lastActivity: now, createdAt: now });
            recordSessionConnect();
            console.log(JSON.stringify({
              event: "session_open",
              ts: new Date(now).toISOString(),
              sessionId: sid,
              ip,
              userAgent,
            }));
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

        const mcpServer = createServer();
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
        { "email": "rob.v.hunter@gmail.com" }
      ]
    }));
  } else if (url.pathname === "/api/stats" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(getConnectionStats(sessions.size)));
  } else if (url.pathname === "/api/offers" && req.method === "GET") {
    recordApiHit("/api/offers");
    const q = url.searchParams.get("q") || undefined;
    const category = url.searchParams.get("category") || undefined;
    const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
    const results = searchOffers(q, category);
    const total = results.length;
    const paged = results.slice(offset, offset + limit);
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ offers: paged, total }));
  } else if (url.pathname === "/api/categories" && req.method === "GET") {
    recordApiHit("/api/categories");
    const cats = getCategories();
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ categories: cats }));
  } else if (url.pathname === "/") {
    recordLandingPageView();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(landingPageHtml);
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }
});

httpServer.listen(PORT, () => {
  console.error(`agentdeals MCP server running on http://localhost:${PORT}/mcp`);
});

// Flush telemetry to disk every 5 minutes
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => flushTelemetry(), FLUSH_INTERVAL_MS).unref();

// Flush on graceful shutdown
function onShutdown() {
  flushTelemetry();
  process.exit(0);
}
process.on("SIGTERM", onShutdown);
process.on("SIGINT", onShutdown);

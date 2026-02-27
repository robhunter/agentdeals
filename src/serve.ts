import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { loadOffers, getCategories, searchOffers, loadDealChanges } from "./data.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // 60 seconds

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

// Map of session ID → transport + last activity for multi-session support
const sessions = new Map<string, SessionEntry>();

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
      const idleMinutes = Math.round(idleMs / 60000);
      console.error(`Cleaned up idle session ${sid} after ${idleMinutes}m`);
      entry.transport.close?.();
      sessions.delete(sid);
    }
  }
}, CLEANUP_INTERVAL_MS).unref();

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
<title>AgentDeals — Developer Infrastructure Deals via MCP</title>
<meta name="description" content="Free MCP server aggregating ${stats.offers}+ developer infrastructure deals — free tiers, startup credits, and pricing changes across ${stats.categories} categories. Search from any AI agent or browse directly.">
<meta property="og:title" content="AgentDeals — Developer Infrastructure Deals via MCP">
<meta property="og:description" content="Free tiers are disappearing. Track ${stats.offers}+ developer deals, startup credits, and pricing changes across ${stats.categories} categories. Browse directly or query via MCP.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://agentdeals-production.up.railway.app">
<meta property="og:image" content="https://raw.githubusercontent.com/robhunter/agentdeals/main/assets/logo-400.png">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="AgentDeals — Developer Infrastructure Deals via MCP">
<meta name="twitter:description" content="Track ${stats.offers}+ developer deals, free tiers, startup credits, and pricing changes. Browse directly or query via MCP.">
<meta name="twitter:image" content="https://raw.githubusercontent.com/robhunter/agentdeals/main/assets/logo-400.png">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;background:#0d1117;color:#c9d1d9;line-height:1.6}
a{color:#58a6ff;text-decoration:none}
a:hover{text-decoration:underline}
.container{max-width:800px;margin:0 auto;padding:2rem 1.5rem}
.hero{text-align:center;padding:3rem 0 2rem}
.hero h1{font-size:2.5rem;color:#f0f6fc;margin-bottom:.5rem}
.hero p{font-size:1.15rem;color:#8b949e;max-width:540px;margin:0 auto}
.stats{display:flex;justify-content:center;gap:2rem;flex-wrap:wrap;padding:1.5rem 0;border-top:1px solid #21262d;border-bottom:1px solid #21262d;margin:1.5rem 0}
.stat{text-align:center}
.stat .num{font-size:1.75rem;font-weight:700;color:#f0f6fc}
.stat .label{font-size:.8rem;color:#8b949e;text-transform:uppercase;letter-spacing:.05em}
section{margin:2rem 0}
section h2{font-size:1.3rem;color:#f0f6fc;margin-bottom:.75rem;border-bottom:1px solid #21262d;padding-bottom:.4rem}
section p{color:#8b949e;margin-bottom:.75rem}
.tools{list-style:none}
.tools li{padding:.6rem 0;border-bottom:1px solid #161b22}
.tools li:last-child{border-bottom:none}
.tool-name{font-weight:600;color:#f0f6fc;font-family:SFMono-Regular,Consolas,"Liberation Mono",Menlo,monospace;font-size:.9rem}
.tool-desc{color:#8b949e;font-size:.9rem}
pre{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:1rem;overflow-x:auto;font-size:.85rem;color:#c9d1d9;line-height:1.5}
code{font-family:SFMono-Regular,Consolas,"Liberation Mono",Menlo,monospace}
.links{display:flex;gap:1.5rem;flex-wrap:wrap;margin-top:.5rem}
.link-btn{display:inline-block;padding:.5rem 1rem;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:.9rem;transition:border-color .15s}
.link-btn:hover{border-color:#58a6ff;text-decoration:none}
.change-entry{padding:.75rem 0;border-bottom:1px solid #161b22}
.change-entry:last-child{border-bottom:none}
.change-header{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.25rem}
.change-badge{display:inline-block;padding:.15rem .5rem;border-radius:10px;font-size:.7rem;font-weight:600;color:#fff;text-transform:uppercase;letter-spacing:.03em}
.change-vendor{font-weight:600;color:#f0f6fc;font-size:.9rem}
.change-date{color:#484f58;font-size:.8rem;margin-left:auto}
.change-summary{color:#8b949e;font-size:.85rem}
footer{text-align:center;color:#484f58;font-size:.8rem;padding:2rem 0 1rem;border-top:1px solid #21262d;margin-top:2rem}
.browse-controls{margin-bottom:1rem}
.search-input{width:100%;padding:.6rem .8rem;background:#161b22;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:.9rem;outline:none}
.search-input:focus{border-color:#58a6ff}
.search-input::placeholder{color:#484f58}
.category-pills{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.6rem}
.cat-pill{display:inline-block;padding:.2rem .6rem;border-radius:10px;font-size:.75rem;font-weight:500;background:#21262d;color:#8b949e;border:1px solid #30363d;cursor:pointer;transition:all .15s}
.cat-pill:hover{border-color:#58a6ff;color:#c9d1d9}
.cat-pill.active{background:#1f6feb;border-color:#1f6feb;color:#fff}
.deal-cards{display:grid;gap:.75rem;margin-top:.75rem}
.deal-card{background:#161b22;border:1px solid #21262d;border-radius:6px;padding:.75rem 1rem}
.deal-card-header{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.25rem}
.deal-vendor{font-weight:600;color:#f0f6fc;font-size:.9rem}
.deal-cat{display:inline-block;padding:.1rem .45rem;border-radius:8px;font-size:.65rem;font-weight:500;background:#21262d;color:#8b949e;border:1px solid #30363d}
.deal-tier{font-size:.75rem;color:#58a6ff;margin-left:auto}
.deal-desc{color:#8b949e;font-size:.83rem}
.show-more{display:block;width:100%;padding:.5rem;margin-top:.75rem;background:transparent;border:1px solid #30363d;border-radius:6px;color:#58a6ff;font-size:.85rem;cursor:pointer;transition:border-color .15s}
.show-more:hover{border-color:#58a6ff}
.browse-status{color:#484f58;font-size:.8rem;margin-top:.5rem}
@media(max-width:600px){.hero h1{font-size:1.75rem}.stats{gap:1rem}.stat .num{font-size:1.3rem}pre{font-size:.75rem}}
</style>
</head>
<body>
<div class="container">
  <div class="hero">
    <h1>AgentDeals</h1>
    <p>MCP server aggregating free tiers, startup credits, and developer infrastructure deals. Query from any MCP client.</p>
  </div>

  <div class="stats">
    <div class="stat"><div class="num">${stats.offers}</div><div class="label">Offers</div></div>
    <div class="stat"><div class="num">${stats.categories}</div><div class="label">Categories</div></div>
    <div class="stat"><div class="num">${stats.tools}</div><div class="label">MCP Tools</div></div>
    <div class="stat"><div class="num">${stats.dealChanges}</div><div class="label">Tracked Changes</div></div>
  </div>

  <section>
    <h2>What is this?</h2>
    <p>AgentDeals is a remote MCP server that indexes free tiers, startup programs, and promotional offers from developer infrastructure companies. AI coding agents and developers can query it to find relevant deals for their projects.</p>
    <p>Whether you're looking for a free database, CI/CD minutes, cloud hosting credits, or startup accelerator perks — AgentDeals aggregates them in one place, accessible via any MCP-compatible client.</p>
  </section>

  <section>
    <h2>Tools</h2>
    <ul class="tools">
      <li><span class="tool-name">search_offers</span><br><span class="tool-desc">Search deals by keyword, category, or vendor. Supports pagination, sorting, and eligibility filtering.</span></li>
      <li><span class="tool-name">list_categories</span><br><span class="tool-desc">List all deal categories with offer counts.</span></li>
      <li><span class="tool-name">get_offer_details</span><br><span class="tool-desc">Get full details for a specific vendor, including related vendors in the same category.</span></li>
      <li><span class="tool-name">get_deal_changes</span><br><span class="tool-desc">Track recent pricing and free tier changes — removals, reductions, increases, and restructures.</span></li>
    </ul>
  </section>

  <section>
    <h2>Recent Pricing Changes</h2>
    <p>Tracked by our <code>get_deal_changes</code> tool — no other deals aggregator monitors these.</p>
${buildChangesHtml()}
  </section>

  <section id="browse">
    <h2>Browse Deals</h2>
    <div class="browse-controls">
      <input type="text" class="search-input" id="deal-search" placeholder="Search ${stats.offers}+ deals...">
      <div class="category-pills" id="cat-pills"></div>
    </div>
    <div class="deal-cards" id="deal-cards"></div>
    <button class="show-more" id="show-more" style="display:none">Show more</button>
    <div class="browse-status" id="browse-status"></div>
  </section>

  <section>
    <h2>Connect</h2>
    <p>Add AgentDeals to your MCP client. For Claude Desktop or Cursor, add this to your MCP config:</p>
    <pre><code>{
  "mcpServers": {
    "agentdeals": {
      "url": "https://agentdeals-production.up.railway.app/mcp"
    }
  }
}</code></pre>
    <p>Or connect directly via the streamable-http endpoint at <code>/mcp</code>.</p>
  </section>

  <section>
    <h2>Links</h2>
    <div class="links">
      <a class="link-btn" href="https://github.com/robhunter/agentdeals">GitHub</a>
      <a class="link-btn" href="https://modelcontextprotocol.io/servers/agentdeals">MCP Registry</a>
      <a class="link-btn" href="https://glama.ai/mcp/connectors/io.github.robhunter/agentdeals">Glama Connector</a>
    </div>
  </section>

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
      html+='<div class="deal-card"><div class="deal-card-header"><span class="deal-vendor">'+escHtml(o.vendor)+'</span><span class="deal-cat">'+escHtml(o.category)+'</span><span class="deal-tier">'+escHtml(tierLabel)+'</span></div><div class="deal-desc">'+escHtml(o.description)+'</div></div>';
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
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, lastActivity: Date.now() });
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            sessions.delete(sid);
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
        const { transport } = sessions.get(sessionId)!;
        await transport.handleRequest(req, res);
        sessions.delete(sessionId);
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
      }
    } else {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
    }
  } else if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", sessions: sessions.size }));
  } else if (url.pathname === "/.well-known/glama.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      "$schema": "https://glama.ai/mcp/schemas/connector.json",
      "maintainers": [
        { "email": "rob.v.hunter@gmail.com" }
      ]
    }));
  } else if (url.pathname === "/api/offers" && req.method === "GET") {
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
    const cats = getCategories();
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ categories: cats }));
  } else if (url.pathname === "/") {
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

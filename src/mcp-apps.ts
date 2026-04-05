/**
 * MCP Apps UI resources for AgentDeals tools.
 *
 * Each tool gets a companion UI resource that renders an interactive widget
 * in MCP Apps-capable clients (Claude, ChatGPT, VS Code, etc.).
 * Non-MCP-Apps clients still receive the text/JSON fallback.
 */
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Shared CSS variables matching agentdeals.dev dark theme
const SHARED_STYLES = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0f172a;
    color: #e2e8f0;
    padding: 16px;
    line-height: 1.5;
  }
  a { color: #60a5fa; text-decoration: none; }
  a:hover { text-decoration: underline; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #1e293b; }
  th { background: #1e293b; color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  td { font-size: 14px; }
  tr:hover td { background: #1e293b40; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 11px; font-weight: 600; }
  .badge-green { background: #065f4620; color: #34d399; border: 1px solid #065f4640; }
  .badge-yellow { background: #78350f20; color: #fbbf24; border: 1px solid #78350f40; }
  .badge-red { background: #7f1d1d20; color: #f87171; border: 1px solid #7f1d1d40; }
  .badge-blue { background: #1e3a5f20; color: #60a5fa; border: 1px solid #1e3a5f40; }
  .badge-gray { background: #1e293b; color: #94a3b8; border: 1px solid #334155; }
  .card { background: #1e293b; border-radius: 8px; padding: 16px; margin: 12px 0; }
  h2 { font-size: 16px; color: #f1f5f9; margin-bottom: 8px; }
  h3 { font-size: 14px; color: #cbd5e1; margin-bottom: 6px; }
  .subtitle { font-size: 13px; color: #64748b; margin-bottom: 12px; }
  .stats-row { display: flex; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
  .stat { text-align: center; }
  .stat-value { font-size: 24px; font-weight: 700; color: #f1f5f9; }
  .stat-label { font-size: 11px; color: #64748b; text-transform: uppercase; }
  .filter-bar { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .filter-btn { background: #334155; color: #94a3b8; border: none; padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; }
  .filter-btn.active { background: #3b82f6; color: #fff; }
  .empty { text-align: center; padding: 32px; color: #64748b; }
  .link-row { margin-top: 12px; font-size: 13px; }
`;

// Shared App bridge script (vanilla JS, no framework)
const APP_BRIDGE_SCRIPT = `
  import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";

  const app = new App({ name: "AgentDeals", version: "1.0.0" }, {});

  let toolArgs = {};
  let toolResult = null;

  app.ontoolinput = (params) => {
    toolArgs = params.arguments || {};
    if (toolResult) render(toolArgs, toolResult);
  };

  app.ontoolresult = (params) => {
    const textContent = (params.content || []).find(c => c.type === "text");
    if (textContent) {
      try { toolResult = JSON.parse(textContent.text); } catch { toolResult = textContent.text; }
    }
    render(toolArgs, toolResult);
  };

  await app.connect();
`;

const BASE_URL = "https://agentdeals.dev";

// --- search_deals UI ---
function searchDealsHtml(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${SHARED_STYLES}
  .deal-row { display: flex; justify-content: space-between; align-items: center; }
  .deal-vendor { font-weight: 600; color: #f1f5f9; }
  .deal-tier { font-size: 12px; color: #a78bfa; }
  .deal-desc { font-size: 13px; color: #94a3b8; margin-top: 2px; }
  .category-tab { cursor: pointer; }
</style></head><body>
<div id="app"><div class="empty">Loading deals...</div></div>
<script type="module">
${APP_BRIDGE_SCRIPT}

function render(args, data) {
  const el = document.getElementById("app");
  if (!data) { el.innerHTML = '<div class="empty">Loading...</div>'; return; }

  // Category list mode
  if (Array.isArray(data) && data[0]?.name && data[0]?.count !== undefined) {
    const total = data.reduce((s, c) => s + c.count, 0);
    el.innerHTML = \`
      <h2>Developer Tool Categories</h2>
      <p class="subtitle">\${data.length} categories, \${total.toLocaleString()} total offers</p>
      <table>
        <thead><tr><th>Category</th><th style="text-align:right">Offers</th></tr></thead>
        <tbody>\${data.map(c => \`<tr><td>\${esc(c.name)}</td><td style="text-align:right">\${c.count}</td></tr>\`).join("")}</tbody>
      </table>
      <div class="link-row"><a href="${BASE_URL}/category" target="_blank">Browse all categories on agentdeals.dev \\u2192</a></div>
    \`;
    return;
  }

  // Single vendor detail mode
  if (data.vendor && !data.results) {
    const stability = data.stability || "unknown";
    const stabBadge = stability === "stable" ? "badge-green" : stability === "watch" ? "badge-yellow" : stability === "volatile" ? "badge-red" : "badge-gray";
    const alts = (data.alternatives || []).slice(0, 5);
    el.innerHTML = \`
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h2>\${esc(data.vendor)}</h2>
          <span class="badge \${stabBadge}">\${esc(stability)}</span>
        </div>
        <div class="deal-tier">\${esc(data.tier || "")} \\u2014 \${esc(data.category || "")}</div>
        <p style="margin-top:8px;font-size:14px">\${esc(data.description || "")}</p>
        \${data.url ? \`<div class="link-row"><a href="\${esc(data.url)}" target="_blank">Pricing page \\u2192</a></div>\` : ""}
      </div>
      \${alts.length > 0 ? \`
        <h3>Alternatives in \${esc(data.category || "this category")}</h3>
        <table>
          <thead><tr><th>Vendor</th><th>Tier</th><th>Description</th></tr></thead>
          <tbody>\${alts.map(a => \`<tr><td>\${esc(a.vendor)}</td><td>\${esc(a.tier || "")}</td><td style="font-size:13px;color:#94a3b8">\${esc(a.description || "").slice(0, 80)}</td></tr>\`).join("")}</tbody>
        </table>
      \` : ""}
      <div class="link-row"><a href="${BASE_URL}/vendor/\${encodeURIComponent(data.vendor?.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}" target="_blank">View on agentdeals.dev \\u2192</a></div>
    \`;
    return;
  }

  // Search results mode
  const results = data.results || [];
  const total = data.total || results.length;
  el.innerHTML = \`
    <h2>Search Results</h2>
    <p class="subtitle">\${total.toLocaleString()} matches\${args.query ? ' for "' + esc(args.query) + '"' : ''}\${args.category ? ' in ' + esc(args.category) : ''}</p>
    \${results.length === 0 ? '<div class="empty">No deals found. Try broader search terms or browse categories.</div>' : \`
      <table>
        <thead><tr><th>Vendor</th><th>Tier</th><th>Category</th><th>Description</th></tr></thead>
        <tbody>\${results.map(r => \`<tr>
          <td><a href="${BASE_URL}/vendor/\${encodeURIComponent((r.vendor || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'))}" target="_blank">\${esc(r.vendor)}</a></td>
          <td><span class="badge badge-blue">\${esc(r.tier || "")}</span></td>
          <td style="font-size:13px">\${esc(r.category || "")}</td>
          <td style="font-size:13px;color:#94a3b8;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${esc(r.description || "").slice(0, 100)}</td>
        </tr>\`).join("")}</tbody>
      </table>
    \`}
    <div class="link-row"><a href="${BASE_URL}/search\${args.query ? '?q=' + encodeURIComponent(args.query) : ''}" target="_blank">Search on agentdeals.dev \\u2192</a></div>
  \`;
}

function esc(s) { if (!s) return ""; const d = document.createElement("div"); d.textContent = String(s); return d.innerHTML; }
</script></body></html>`;
}

// --- plan_stack UI ---
function planStackHtml(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${SHARED_STYLES}
  .cost-cell { font-weight: 600; }
  .cost-free { color: #34d399; }
  .cost-moderate { color: #fbbf24; }
  .cost-expensive { color: #f87171; }
  .rec-card { background: #1e293b; border-radius: 8px; padding: 12px; margin: 8px 0; border-left: 3px solid #3b82f6; }
  .rec-vendor { font-weight: 600; color: #f1f5f9; }
  .rec-reason { font-size: 13px; color: #94a3b8; margin-top: 4px; }
</style></head><body>
<div id="app"><div class="empty">Loading stack analysis...</div></div>
<script type="module">
${APP_BRIDGE_SCRIPT}

function render(args, data) {
  const el = document.getElementById("app");
  if (!data) { el.innerHTML = '<div class="empty">Loading...</div>'; return; }
  const mode = args.mode || "recommend";

  // Recommend mode
  if (mode === "recommend" && data.recommendations) {
    const recs = data.recommendations || [];
    el.innerHTML = \`
      <h2>Recommended Stack</h2>
      <p class="subtitle">Free-tier stack for: \${esc(args.use_case || "your project")}</p>
      \${recs.map(r => \`
        <div class="rec-card">
          <div style="display:flex;justify-content:space-between">
            <span class="rec-vendor">\${esc(r.vendor || r.service)}</span>
            <span class="badge badge-blue">\${esc(r.category || "")}</span>
          </div>
          <div class="rec-reason">\${esc(r.reason || r.description || "")}</div>
          \${r.free_tier ? \`<div style="margin-top:4px;font-size:12px;color:#a78bfa">\${esc(r.free_tier)}</div>\` : ""}
        </div>
      \`).join("")}
      <div class="link-row"><a href="${BASE_URL}/stacks" target="_blank">Browse curated stacks on agentdeals.dev \\u2192</a></div>
    \`;
    return;
  }

  // Estimate mode
  if (mode === "estimate" && (data.services || data.costs)) {
    const services = data.services || data.costs || [];
    const total = data.total_monthly || services.reduce((s, v) => s + (v.monthly_cost || 0), 0);
    el.innerHTML = \`
      <h2>Cost Estimate</h2>
      <p class="subtitle">Scale: \${esc(args.scale || "hobby")}</p>
      <table>
        <thead><tr><th>Service</th><th>Free Tier</th><th style="text-align:right">Monthly Cost</th></tr></thead>
        <tbody>
          \${services.map(s => {
            const cost = s.monthly_cost || 0;
            const cls = cost === 0 ? "cost-free" : cost < 50 ? "cost-moderate" : "cost-expensive";
            return \`<tr>
              <td>\${esc(s.vendor || s.service)}</td>
              <td style="font-size:13px;color:#94a3b8">\${esc(s.free_tier || s.tier || "")}</td>
              <td class="cost-cell \${cls}" style="text-align:right">\${cost === 0 ? "Free" : "$" + cost.toFixed(0) + "/mo"}</td>
            </tr>\`;
          }).join("")}
          <tr style="border-top:2px solid #334155"><td colspan="2" style="font-weight:600">Total</td><td class="cost-cell" style="text-align:right;font-weight:700">\${total === 0 ? "Free" : "$" + total.toFixed(0) + "/mo"}</td></tr>
        </tbody>
      </table>
      <div class="link-row"><a href="${BASE_URL}/estimate" target="_blank">Try the interactive cost estimator \\u2192</a></div>
    \`;
    return;
  }

  // Audit mode
  if (mode === "audit") {
    const risks = data.risks || data.risk_flags || [];
    const gaps = data.gaps || data.coverage_gaps || [];
    const savings = data.savings || data.cost_savings || [];
    el.innerHTML = \`
      <h2>Stack Audit</h2>
      <p class="subtitle">Infrastructure risk and cost analysis</p>
      \${risks.length > 0 ? \`
        <div class="card">
          <h3>\\u26A0\\uFE0F Risk Flags</h3>
          \${risks.map(r => \`<div style="margin:6px 0;font-size:14px"><span class="badge badge-red">\${esc(r.level || "risk")}</span> <strong>\${esc(r.vendor || r.service)}</strong>: \${esc(r.reason || r.description || "")}</div>\`).join("")}
        </div>
      \` : ""}
      \${gaps.length > 0 ? \`
        <div class="card">
          <h3>Coverage Gaps</h3>
          \${gaps.map(g => \`<div style="margin:4px 0;font-size:14px">\${esc(g.category || g)}: \${esc(g.suggestion || "")}</div>\`).join("")}
        </div>
      \` : ""}
      \${savings.length > 0 ? \`
        <div class="card">
          <h3>Savings Opportunities</h3>
          \${savings.map(s => \`<div style="margin:4px 0;font-size:14px"><strong>\${esc(s.vendor || s.service)}</strong> \\u2192 \${esc(s.alternative || "")}: \${esc(s.reason || "")}</div>\`).join("")}
        </div>
      \` : ""}
      <div class="link-row"><a href="${BASE_URL}/free-tier-risk" target="_blank">View full risk index on agentdeals.dev \\u2192</a></div>
    \`;
    return;
  }

  // Fallback: render raw data
  el.innerHTML = \`<div class="card"><h2>Stack Analysis</h2><pre style="font-size:12px;color:#94a3b8;overflow-x:auto;white-space:pre-wrap">\${esc(JSON.stringify(data, null, 2))}</pre></div>\`;
}

function esc(s) { if (!s) return ""; const d = document.createElement("div"); d.textContent = String(s); return d.innerHTML; }
</script></body></html>`;
}

// --- compare_vendors UI ---
function compareVendorsHtml(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${SHARED_STYLES}
  .vs-header { display: flex; justify-content: center; align-items: center; gap: 16px; margin-bottom: 16px; }
  .vs-name { font-size: 20px; font-weight: 700; color: #f1f5f9; }
  .vs-badge { font-size: 14px; color: #64748b; }
  .feature-row { display: flex; }
  .feature-label { width: 30%; font-weight: 600; color: #94a3b8; font-size: 13px; padding: 8px 12px; }
  .feature-val { width: 35%; padding: 8px 12px; font-size: 14px; border-left: 1px solid #1e293b; }
</style></head><body>
<div id="app"><div class="empty">Loading comparison...</div></div>
<script type="module">
${APP_BRIDGE_SCRIPT}

function render(args, data) {
  const el = document.getElementById("app");
  if (!data) { el.innerHTML = '<div class="empty">Loading...</div>'; return; }

  // Single vendor risk check
  if (data.risk_level || data.stability) {
    const vendor = data.vendor || (args.vendors && args.vendors[0]) || "Vendor";
    const risk = data.risk_level || data.stability || "unknown";
    const riskBadge = risk === "stable" || risk === "low" ? "badge-green" : risk === "watch" || risk === "medium" ? "badge-yellow" : "badge-red";
    const changes = data.changes || data.recent_changes || [];
    el.innerHTML = \`
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h2>\${esc(vendor)} Risk Assessment</h2>
          <span class="badge \${riskBadge}">\${esc(risk)}</span>
        </div>
        \${data.summary ? \`<p style="margin-top:8px;font-size:14px">\${esc(data.summary)}</p>\` : ""}
      </div>
      \${changes.length > 0 ? \`
        <h3>Recent Pricing Changes</h3>
        <table>
          <thead><tr><th>Date</th><th>Type</th><th>Summary</th></tr></thead>
          <tbody>\${changes.map(c => \`<tr><td style="white-space:nowrap">\${esc(c.date)}</td><td><span class="badge \${c.change_type?.includes("removed") || c.change_type?.includes("reduced") ? "badge-red" : c.change_type?.includes("increased") || c.change_type?.includes("new") ? "badge-green" : "badge-yellow"}">\${esc(c.change_type)}</span></td><td style="font-size:13px">\${esc(c.summary)}</td></tr>\`).join("")}</tbody>
        </table>
      \` : ""}
      <div class="link-row"><a href="${BASE_URL}/stability" target="_blank">View stability dashboard \\u2192</a></div>
    \`;
    return;
  }

  // Two-vendor comparison
  const vendorA = data.vendor_a || data.vendors?.[0] || {};
  const vendorB = data.vendor_b || data.vendors?.[1] || {};
  const nameA = vendorA.vendor || vendorA.name || (args.vendors && args.vendors[0]) || "Vendor A";
  const nameB = vendorB.vendor || vendorB.name || (args.vendors && args.vendors[1]) || "Vendor B";
  const fields = [
    ["Category", vendorA.category, vendorB.category],
    ["Tier", vendorA.tier, vendorB.tier],
    ["Free Tier", vendorA.description || vendorA.free_tier, vendorB.description || vendorB.free_tier],
    ["Stability", vendorA.stability, vendorB.stability],
    ["Verified", vendorA.verifiedDate || vendorA.verified_date, vendorB.verifiedDate || vendorB.verified_date],
  ].filter(f => f[1] || f[2]);

  const slug = (n) => (n || "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const vsUrl = \`${BASE_URL}/\${slug(nameA)}-vs-\${slug(nameB)}\`;

  el.innerHTML = \`
    <div class="vs-header">
      <span class="vs-name">\${esc(nameA)}</span>
      <span class="vs-badge">vs</span>
      <span class="vs-name">\${esc(nameB)}</span>
    </div>
    <table>
      <thead><tr><th></th><th>\${esc(nameA)}</th><th>\${esc(nameB)}</th></tr></thead>
      <tbody>\${fields.map(f => \`<tr><td style="font-weight:600;color:#94a3b8">\${esc(f[0])}</td><td>\${esc(f[1] || "—")}</td><td>\${esc(f[2] || "—")}</td></tr>\`).join("")}</tbody>
    </table>
    \${data.risk ? \`
      <div class="card">
        <h3>Risk Assessment</h3>
        <div style="display:flex;gap:24px;margin-top:8px">
          \${[nameA, nameB].map(n => {
            const r = data.risk[n] || {};
            const level = r.risk_level || r.stability || "unknown";
            const cls = level === "stable" || level === "low" ? "badge-green" : level === "watch" || level === "medium" ? "badge-yellow" : "badge-red";
            return \`<div><strong>\${esc(n)}</strong> <span class="badge \${cls}">\${esc(level)}</span></div>\`;
          }).join("")}
        </div>
      </div>
    \` : ""}
    <div class="link-row"><a href="\${vsUrl}" target="_blank">Full comparison on agentdeals.dev \\u2192</a></div>
  \`;
}

function esc(s) { if (!s) return ""; const d = document.createElement("div"); d.textContent = String(s); return d.innerHTML; }
</script></body></html>`;
}

// --- track_changes UI ---
function trackChangesHtml(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${SHARED_STYLES}
  .timeline-item { position: relative; padding: 12px 16px 12px 24px; border-left: 2px solid #334155; margin-left: 8px; }
  .timeline-item::before { content: ""; position: absolute; left: -5px; top: 16px; width: 8px; height: 8px; border-radius: 50%; }
  .timeline-removed::before { background: #f87171; }
  .timeline-reduced::before { background: #fbbf24; }
  .timeline-increased::before, .timeline-new::before { background: #34d399; }
  .timeline-other::before { background: #60a5fa; }
  .timeline-item.personal { border-left-color: #3b82f6; border-left-width: 3px; }
  .change-date { font-size: 12px; color: #64748b; }
  .change-vendor { font-weight: 600; color: #f1f5f9; }
  .change-summary { font-size: 13px; color: #94a3b8; margin-top: 2px; }
  .stack-summary { background: linear-gradient(135deg, #1e3a5f 0%, #1e293b 100%); border: 1px solid #3b82f6; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .stack-summary h3 { margin: 0 0 8px; color: #60a5fa; font-size: 15px; }
  .stack-summary .summary-stats { display: flex; gap: 16px; font-size: 13px; color: #94a3b8; }
  .stack-summary .summary-stats strong { color: #f1f5f9; }
  .advisory-section { margin-top: 16px; border-top: 1px solid #334155; padding-top: 12px; }
  .advisory-section h3 { font-size: 14px; color: #94a3b8; margin: 0 0 8px; cursor: pointer; }
  .advisory-section h3::before { content: "\\u25B6"; font-size: 10px; margin-right: 6px; display: inline-block; transition: transform 0.2s; }
  .advisory-section.open h3::before { transform: rotate(90deg); }
  .advisory-section .advisory-items { display: none; }
  .advisory-section.open .advisory-items { display: block; }
</style></head><body>
<div id="app"><div class="empty">Loading changes...</div></div>
<script type="module">
${APP_BRIDGE_SCRIPT}

function render(args, data) {
  const el = document.getElementById("app");
  if (!data) { el.innerHTML = '<div class="empty">Loading...</div>'; return; }

  // Detect personalized vs standard response
  const isPersonalized = Array.isArray(data.your_stack_changes);
  const changes = isPersonalized ? data.your_stack_changes : (data.deal_changes || data.changes || []);
  const advisory = isPersonalized ? (data.advisory || []) : [];
  const summary = isPersonalized ? data.summary : null;
  const expiring = data.expiring_deals || data.expiring || [];

  // Categorize changes
  const removals = changes.filter(c => c.change_type === "free_tier_removed" || c.change_type === "open_source_killed" || c.change_type === "product_deprecated");
  const reductions = changes.filter(c => c.change_type === "limits_reduced" || c.change_type === "restriction");
  const positive = changes.filter(c => c.change_type === "limits_increased" || c.change_type === "new_free_tier" || c.change_type === "startup_program_expanded");

  const stats = [
    { label: isPersonalized ? "Your Stack" : "Total Changes", value: changes.length },
    { label: "Removals", value: removals.length },
    { label: "Reductions", value: reductions.length },
    { label: "Improvements", value: positive.length },
    ...(expiring.length > 0 ? [{ label: "Expiring Soon", value: expiring.length }] : []),
  ];

  const timelineClass = (type) => {
    if (type === "free_tier_removed" || type === "open_source_killed" || type === "product_deprecated") return "timeline-removed";
    if (type === "limits_reduced" || type === "restriction") return "timeline-reduced";
    if (type === "limits_increased" || type === "new_free_tier" || type === "startup_program_expanded") return "timeline-increased";
    return "timeline-other";
  };

  const changeBadge = (type) => {
    if (type === "free_tier_removed" || type === "open_source_killed" || type === "product_deprecated") return "badge-red";
    if (type === "limits_reduced" || type === "restriction") return "badge-yellow";
    if (type === "limits_increased" || type === "new_free_tier" || type === "startup_program_expanded") return "badge-green";
    return "badge-blue";
  };

  function renderTimelineItem(c, isPersonalItem) {
    return \`
      <div class="timeline-item \${timelineClass(c.change_type)}\${isPersonalItem ? " personal" : ""}">
        <div class="change-date">\${esc(c.date)}</div>
        <div><span class="change-vendor">\${esc(c.vendor)}</span> <span class="badge \${changeBadge(c.change_type)}">\${esc((c.change_type || "").replace(/_/g, " "))}</span></div>
        <div class="change-summary">\${esc(c.summary)}</div>
        \${c.previous_state ? \`<div style="margin-top:4px;font-size:12px"><span style="color:#64748b">Before:</span> \${esc(c.previous_state)}</div>\` : ""}
        \${c.current_state ? \`<div style="font-size:12px"><span style="color:#64748b">After:</span> \${esc(c.current_state)}</div>\` : ""}
      </div>
    \`;
  }

  function renderTimeline(filter) {
    const filtered = filter === "all" ? changes :
      filter === "negative" ? [...removals, ...reductions] :
      filter === "positive" ? positive : changes;
    return filtered.length === 0 ? '<div class="empty">No changes match this filter.</div>' :
      filtered.map(c => renderTimelineItem(c, isPersonalized)).join("");
  }

  const stackSummaryHtml = isPersonalized && summary ? \`
    <div class="stack-summary">
      <h3>\\ud83d\\udee1\\ufe0f Your Stack</h3>
      <div class="summary-stats">
        <span><strong>\${summary.stack_changes_count}</strong> changes affecting your stack</span>
        <span><strong>\${summary.ecosystem_high_impact_count}</strong> high-impact changes ecosystem-wide</span>
        <span>Last <strong>\${summary.period_days}</strong> days</span>
      </div>
    </div>
  \` : "";

  const advisoryHtml = advisory.length > 0 ? \`
    <div class="advisory-section" id="advisory-section">
      <h3>Also worth knowing (\${advisory.length})</h3>
      <div class="advisory-items">
        \${advisory.map(c => renderTimelineItem(c, false)).join("")}
      </div>
    </div>
  \` : "";

  el.innerHTML = \`
    <h2>\${isPersonalized ? "Your Stack Changes" : "Pricing Changes"}</h2>
    <p class="subtitle">\${data.period || "Recent"} developer tool pricing activity</p>
    \${stackSummaryHtml}
    <div class="stats-row">\${stats.map(s => \`<div class="stat"><div class="stat-value">\${s.value}</div><div class="stat-label">\${s.label}</div></div>\`).join("")}</div>
    <div class="filter-bar">
      <button class="filter-btn active" data-filter="all">All</button>
      <button class="filter-btn" data-filter="negative">Removals & Reductions</button>
      <button class="filter-btn" data-filter="positive">Improvements</button>
    </div>
    <div id="timeline">\${renderTimeline("all")}</div>
    \${advisoryHtml}
    \${expiring.length > 0 ? \`
      <div class="card" style="margin-top:16px">
        <h3>Expiring Soon</h3>
        \${expiring.map(e => \`<div style="margin:6px 0"><strong>\${esc(e.vendor)}</strong>: \${esc(e.description || e.summary || "")} <span class="badge badge-yellow">\${esc(e.expires_date || e.date || "")}</span></div>\`).join("")}
      </div>
    \` : ""}
    <div class="link-row"><a href="${BASE_URL}/pricing-changes" target="_blank">Full changelog on agentdeals.dev \\u2192</a></div>
  \`;

  // Wire up filter buttons
  el.querySelectorAll(".filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      el.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("timeline").innerHTML = renderTimeline(btn.dataset.filter);
    });
  });

  // Wire up advisory toggle
  const advisoryEl = document.getElementById("advisory-section");
  if (advisoryEl) {
    advisoryEl.querySelector("h3").addEventListener("click", () => {
      advisoryEl.classList.toggle("open");
    });
  }
}

function esc(s) { if (!s) return ""; const d = document.createElement("div"); d.textContent = String(s); return d.innerHTML; }
</script></body></html>`;
}

/**
 * Register all MCP Apps UI resources on the server.
 * Call this after creating the McpServer.
 */
export function registerMcpAppsResources(server: McpServer): void {
  registerAppResource(
    server, "Search Deals View", "ui://agentdeals/search-deals",
    { description: "Interactive deal search and browse table" },
    async () => ({
      contents: [{ uri: "ui://agentdeals/search-deals", mimeType: RESOURCE_MIME_TYPE, text: searchDealsHtml() }],
    })
  );

  registerAppResource(
    server, "Plan Stack View", "ui://agentdeals/plan-stack",
    { description: "Stack recommendation and cost breakdown card" },
    async () => ({
      contents: [{ uri: "ui://agentdeals/plan-stack", mimeType: RESOURCE_MIME_TYPE, text: planStackHtml() }],
    })
  );

  registerAppResource(
    server, "Compare Vendors View", "ui://agentdeals/compare-vendors",
    { description: "Side-by-side vendor comparison widget" },
    async () => ({
      contents: [{ uri: "ui://agentdeals/compare-vendors", mimeType: RESOURCE_MIME_TYPE, text: compareVendorsHtml() }],
    })
  );

  registerAppResource(
    server, "Track Changes View", "ui://agentdeals/track-changes",
    { description: "Pricing change timeline with color-coded badges" },
    async () => ({
      contents: [{ uri: "ui://agentdeals/track-changes", mimeType: RESOURCE_MIME_TYPE, text: trackChangesHtml() }],
    })
  );
}

/** UI metadata to add to tool configs */
export const TOOL_UI_META = {
  search_deals: { ui: { resourceUri: "ui://agentdeals/search-deals" } },
  plan_stack: { ui: { resourceUri: "ui://agentdeals/plan-stack" } },
  compare_vendors: { ui: { resourceUri: "ui://agentdeals/compare-vendors" } },
  track_changes: { ui: { resourceUri: "ui://agentdeals/track-changes" } },
} as const;

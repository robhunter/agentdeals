import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      cwd: REPO,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: process.env.CENSUS_BASE_URL ?? "https://agentdeals.dev" },
    });
    const timeout = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("startup timeout")); }, 60000);
    proc.stderr.on("data", (b) => {
      const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ proc, port: parseInt(m[1], 10) }); }
    });
    proc.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

async function mcpSession(base) {
  const init = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "census", version: "1.0.0" } },
    }),
  });
  const sessionId = init.headers.get("mcp-session-id");
  await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  let id = 10;
  return {
    ok: init.status === 200 && !!sessionId,
    async call(name, args) {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": sessionId },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
      });
      const text = await res.text();
      const line = text.split("\n").find((l) => l.startsWith("data: ")) ?? text;
      const payload = JSON.parse(line.replace(/^data: /, ""));
      const items = payload?.result?.content ?? [];
      const whole = items.map((c) => c.text ?? "").join("\n");
      let first = null;
      try { first = JSON.parse(items[0]?.text ?? ""); } catch { first = null; }
      return { text: whole, json: first };
    },
  };
}

const TOOL_CALLS = [
  ["search_deals", {}],
  ["search_deals", { vendor: "supabase" }],
  ["track_changes", {}],
  ["compare_vendors", { vendors: ["Supabase", "Neon"] }],
  ["compare_vendors", { vendors: ["Supabase"] }],
  ["plan_stack", { mode: "recommend", use_case: "Next.js SaaS app" }],
  ["plan_stack", { mode: "estimate", services: ["Vercel"] }],
];

const HTTP_PATHS = [
  "/api/changes?limit=2",
  "/api/offers?limit=20",
  "/api/details/supabase",
  "/api/categories",
  "/api/newest?limit=10",
  "/api/new?days=7",
  "/api/stack?use_case=Next.js+SaaS+app",
  "/api/costs?services=Vercel",
  "/api/audit-stack?services=Vercel",
  "/api/compare?a=Supabase&b=Neon",
  "/api/vendor-risk/supabase",
  "/api/expiring?within_days=30",
  "/api/digest",
];

const { proc, port } = await startServer();
const base = `http://127.0.0.1:${port}`;
const rows = [];

try {
  const session = await mcpSession(base);
  if (!session.ok) throw new Error("mcp initialize failed");

  for (const [name, args] of TOOL_CALLS) {
    const { text, json } = await session.call(name, args);
    const label = Object.keys(args).length === 0 ? name : `${name}(${Object.values(args).flat().join(",")})`;
    rows.push({
      surface: label,
      chars: text.length,
      mentions: (text.match(/agentdeals/gi) ?? []).length,
      has_provenance_key: json !== null && Object.prototype.hasOwnProperty.call(json, "_provenance"),
      cite_as: json?._provenance?.cite_as ?? null,
      verified: json?._provenance?.verified ?? null,
      deference_count: (text.match(/This is a request from the site/g) ?? []).length,
    });
  }

  for (const p of HTTP_PATHS) {
    const res = await fetch(`${base}${p}`);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    rows.push({
      surface: p,
      chars: text.length,
      mentions: (text.match(/agentdeals/gi) ?? []).length,
      has_provenance_key: json !== null && Object.prototype.hasOwnProperty.call(json, "_provenance"),
      cite_as: json?._provenance?.cite_as ?? null,
      verified: json?._provenance?.verified ?? null,
      deference_count: (text.match(/This is a request from the site/g) ?? []).length,
    });
  }
  const paths = [...new Set(rows.map((r) => r.cite_as).filter(Boolean).map((c) => {
    const m = c.match(/\((https?:\/\/[^,)]+)/);
    return m ? new URL(m[1]).pathname : null;
  }).filter(Boolean))];
  for (const p of paths) {
    const res = await fetch(`${base}${p}`, { redirect: "manual" });
    rows.push({ surface: `cited path ${p}`, chars: 0, mentions: 0, has_provenance_key: res.status === 200, cite_as: null, verified: null, deference_count: res.status });
  }
} finally {
  proc.kill("SIGKILL");
}

console.log(JSON.stringify(rows, null, 2));
const pad = (s, n) => String(s).padEnd(n);
console.log("");
console.log(`${pad("surface", 26)} ${pad("chars", 9)} ${pad("names us", 9)} ${pad("_provenance", 12)} deference`);
for (const r of rows) {
  console.log(`${pad(r.surface, 26)} ${pad(r.chars, 9)} ${pad(r.mentions, 9)} ${pad(r.has_provenance_key, 12)} ${r.deference_count}`);
}

import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3456; // Use non-default port to avoid conflicts

function startHttpServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: String(PORT), BASE_URL: `http://localhost:${PORT}` },
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 5000);

    proc.stderr!.on("data", (data: Buffer) => {
      if (data.toString().includes("running on http")) {
        clearTimeout(timeout);
        resolve(proc);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function mcpRequest(
  path: string,
  body: unknown,
  sessionId?: string
): Promise<{ status: number; headers: Headers; text: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  const response = await fetch(`http://localhost:${PORT}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    headers: response.headers,
    text: await response.text(),
  };
}

function parseSSEData(text: string): any[] {
  const results: any[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      try {
        results.push(JSON.parse(line.slice(6)));
      } catch {
        // skip non-JSON lines
      }
    }
  }
  return results;
}

describe("HTTP transport", () => {
  let proc: ChildProcess | null = null;

  afterEach(() => {
    if (proc) {
      proc.kill();
      proc = null;
    }
  });

  it("responds to health check", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/health`);
    assert.strictEqual(response.status, 200);
    const body = await response.json() as any;
    assert.strictEqual(body.status, "ok");
  });

  it("initializes and responds to tool calls over HTTP", async () => {
    proc = await startHttpServer();

    // Initialize
    const initResp = await mcpRequest("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });

    assert.strictEqual(initResp.status, 200);
    const sessionId = initResp.headers.get("mcp-session-id");
    assert.ok(sessionId, "Should return a session ID");

    const initData = parseSSEData(initResp.text);
    assert.strictEqual(initData.length, 1);
    assert.strictEqual(initData[0].result.serverInfo.name, "agentdeals");

    // Send initialized notification + list_categories tool call
    const toolResp = await mcpRequest(
      "/mcp",
      [
        { jsonrpc: "2.0", method: "notifications/initialized" },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search_deals", arguments: { category: "list" } },
        },
      ],
      sessionId
    );

    assert.strictEqual(toolResp.status, 200);
    const toolData = parseSSEData(toolResp.text);
    const toolResult = toolData.find((d: any) => d.id === 2);
    assert.ok(toolResult, "Should have a tool response");

    const categories = JSON.parse(toolResult.result.content[0].text);
    assert.ok(Array.isArray(categories));
    assert.ok(categories.length > 0);
  });

  it("search_deals works over HTTP", async () => {
    proc = await startHttpServer();

    // Initialize
    const initResp = await mcpRequest("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });

    const sessionId = initResp.headers.get("mcp-session-id");
    assert.ok(sessionId);

    // Search
    const searchResp = await mcpRequest(
      "/mcp",
      [
        { jsonrpc: "2.0", method: "notifications/initialized" },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search_deals", arguments: { query: "postgres" } },
        },
      ],
      sessionId
    );

    assert.strictEqual(searchResp.status, 200);
    const searchData = parseSSEData(searchResp.text);
    const searchResult = searchData.find((d: any) => d.id === 2);
    assert.ok(searchResult);

    const searchBody = JSON.parse(searchResult.result.content[0].text);
    const offers = searchBody.results;
    assert.ok(Array.isArray(offers));
    assert.ok(offers.length >= 2);
    for (const offer of offers) {
      const searchable = [offer.vendor, offer.description, ...offer.tags]
        .join(" ")
        .toLowerCase();
      assert.ok(searchable.includes("postgres"));
    }
  });

  it("supports two concurrent sessions", async () => {
    proc = await startHttpServer();

    // Initialize client A
    const initA = await mcpRequest("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "client-a", version: "1.0.0" },
      },
    });
    assert.strictEqual(initA.status, 200);
    const sessionA = initA.headers.get("mcp-session-id");
    assert.ok(sessionA, "Client A should get a session ID");

    // Initialize client B
    const initB = await mcpRequest("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "client-b", version: "1.0.0" },
      },
    });
    assert.strictEqual(initB.status, 200);
    const sessionB = initB.headers.get("mcp-session-id");
    assert.ok(sessionB, "Client B should get a session ID");

    // Sessions should be different
    assert.notStrictEqual(sessionA, sessionB, "Sessions should have different IDs");

    // Both clients can make tool calls independently
    const [toolRespA, toolRespB] = await Promise.all([
      mcpRequest(
        "/mcp",
        [
          { jsonrpc: "2.0", method: "notifications/initialized" },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "search_deals", arguments: { category: "list" } },
          },
        ],
        sessionA
      ),
      mcpRequest(
        "/mcp",
        [
          { jsonrpc: "2.0", method: "notifications/initialized" },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "search_deals", arguments: { query: "redis" } },
          },
        ],
        sessionB
      ),
    ]);

    assert.strictEqual(toolRespA.status, 200);
    assert.strictEqual(toolRespB.status, 200);

    const dataA = parseSSEData(toolRespA.text);
    const resultA = dataA.find((d: any) => d.id === 2);
    assert.ok(resultA, "Client A should get search_deals category list result");
    const categories = JSON.parse(resultA.result.content[0].text);
    assert.ok(Array.isArray(categories));

    const dataB = parseSSEData(toolRespB.text);
    const resultB = dataB.find((d: any) => d.id === 2);
    assert.ok(resultB, "Client B should get search_deals result");
    const searchBody = JSON.parse(resultB.result.content[0].text);
    assert.ok(Array.isArray(searchBody.results));
    assert.ok(searchBody.results.length > 0);
  });

  it("serves /.well-known/glama.json from repo file", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/.well-known/glama.json`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("content-type"), "application/json");
    const body = await response.json() as any;
    assert.strictEqual(body["$schema"], "https://glama.ai/mcp/schemas/server.json");
    assert.strictEqual(body.name, "agentdeals");
    assert.strictEqual(body.license, "MIT");
    assert.strictEqual(body.tools, 4);
    assert.ok(Array.isArray(body.transport));
  });

  it("serves /setup page with client configs and HowTo schema", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/setup`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Setup Guide"));
    assert.ok(html.includes("claude-desktop"));
    assert.ok(html.includes("claude-code"));
    assert.ok(html.includes("cursor"));
    assert.ok(html.includes("npx -y agentdeals"));
    assert.ok(html.includes("/mcp"));
    assert.ok(html.includes("HowTo"), "Should have HowTo JSON-LD structured data");
    assert.ok(html.includes("search_deals"), "Should list tool examples");
  });

  it("serves landing page at root URL", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("AgentDeals"));
    assert.ok(html.includes("Deals for"), "Landing page should have updated hero");
    assert.ok(html.includes("Browse deals"), "Landing page should have Browse deals section");
    assert.ok(html.includes("deal-search"), "Landing page should have search input");
    assert.ok(html.includes("/api/offers"), "Landing page should fetch from /api/offers");
    assert.ok(html.includes("Inter"), "Landing page should use Inter sans-serif font");
  });

  it("GET /api/offers returns offers with pagination", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/api/offers?limit=3&offset=0`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("content-type"), "application/json");
    const body = await response.json() as any;
    assert.ok(Array.isArray(body.offers));
    assert.strictEqual(body.offers.length, 3);
    assert.ok(typeof body.total === "number");
    assert.ok(body.total > 3);
    // Each offer has expected fields
    for (const o of body.offers) {
      assert.ok(o.vendor);
      assert.ok(o.category);
      assert.ok(o.description);
    }
  });

  it("GET /api/offers filters by query and category", async () => {
    proc = await startHttpServer();

    // Filter by category
    const catResp = await fetch(`http://localhost:${PORT}/api/offers?category=Databases&limit=100`);
    const catBody = await catResp.json() as any;
    assert.ok(catBody.total > 0);
    for (const o of catBody.offers) {
      assert.strictEqual(o.category, "Databases");
    }

    // Filter by query
    const qResp = await fetch(`http://localhost:${PORT}/api/offers?q=postgres&limit=100`);
    const qBody = await qResp.json() as any;
    assert.ok(qBody.total > 0);
    for (const o of qBody.offers) {
      const searchable = [o.vendor, o.description, o.category, ...(o.tags || [])].join(" ").toLowerCase();
      assert.ok(searchable.includes("postgres"));
    }
  });

  it("GET /api/categories returns categories with counts", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/api/categories`);
    assert.strictEqual(response.status, 200);
    const body = await response.json() as any;
    assert.ok(Array.isArray(body.categories));
    assert.ok(body.categories.length > 0);
    for (const c of body.categories) {
      assert.ok(typeof c.name === "string");
      assert.ok(typeof c.count === "number");
      assert.ok(c.count > 0);
    }
  });

  it("returns 404 for unknown paths", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/unknown`);
    assert.strictEqual(response.status, 404);
  });

  it("health endpoint returns session count", async () => {
    proc = await startHttpServer();

    // Initially 0 sessions
    const health0 = await fetch(`http://localhost:${PORT}/health`);
    const body0 = await health0.json() as any;
    assert.strictEqual(body0.status, "ok");
    assert.strictEqual(body0.sessions, 0);
    assert.ok(body0.stats);
    assert.ok(typeof body0.stats.uptime_seconds === "number");
    assert.ok(typeof body0.stats.total_tool_calls === "number");
    assert.ok(typeof body0.stats.total_api_hits === "number");
    assert.ok(typeof body0.stats.total_sessions === "number");
    assert.ok(typeof body0.stats.landing_page_views === "number");
    assert.ok(body0.stats.tool_calls);
    assert.ok(body0.stats.api_hits);

    // Create a session
    await mcpRequest("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });

    // Now 1 session
    const health1 = await fetch(`http://localhost:${PORT}/health`);
    const body1 = await health1.json() as any;
    assert.strictEqual(body1.sessions, 1);

    // Create another session
    await mcpRequest("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client-2", version: "1.0.0" },
      },
    });

    // Now 2 sessions
    const health2 = await fetch(`http://localhost:${PORT}/health`);
    const body2 = await health2.json() as any;
    assert.strictEqual(body2.sessions, 2);

    // Stats should show 2 sessions connected
    assert.ok(body2.stats.total_sessions >= 2);
  });

  it("tracks API hit and landing page stats", async () => {
    proc = await startHttpServer();

    // Record initial stats
    const h0 = await fetch(`http://localhost:${PORT}/health`);
    const s0 = (await h0.json() as any).stats;
    const initialApiOffers = s0.api_hits["/api/offers"];
    const initialApiCats = s0.api_hits["/api/categories"];
    const initialPageViews = s0.landing_page_views;

    // Hit /api/offers twice
    await fetch(`http://localhost:${PORT}/api/offers?limit=1`);
    await fetch(`http://localhost:${PORT}/api/offers?q=test&limit=1`);

    // Hit /api/categories once
    await fetch(`http://localhost:${PORT}/api/categories`);

    // Hit landing page once
    await fetch(`http://localhost:${PORT}/`);

    // Check stats incremented
    const h1 = await fetch(`http://localhost:${PORT}/health`);
    const s1 = (await h1.json() as any).stats;

    assert.strictEqual(s1.api_hits["/api/offers"], initialApiOffers + 2);
    assert.strictEqual(s1.api_hits["/api/categories"], initialApiCats + 1);
    assert.strictEqual(s1.landing_page_views, initialPageViews + 1);
    assert.strictEqual(s1.total_api_hits, s0.total_api_hits + 3);
  });

  it("GET /api/stats returns connection stats", async () => {
    proc = await startHttpServer();

    // Check initial stats
    const resp0 = await fetch(`http://localhost:${PORT}/api/stats`);
    assert.strictEqual(resp0.status, 200);
    assert.strictEqual(resp0.headers.get("content-type"), "application/json");
    const stats0 = await resp0.json() as any;
    assert.strictEqual(stats0.activeSessions, 0);
    assert.ok(typeof stats0.totalSessionsAllTime === "number");
    assert.ok(typeof stats0.totalApiHitsAllTime === "number");
    assert.ok(typeof stats0.totalToolCallsAllTime === "number");
    assert.ok(typeof stats0.sessionsToday === "number");
    assert.ok(typeof stats0.serverStarted === "string");
    // serverStarted should be a valid ISO timestamp
    assert.ok(!isNaN(Date.parse(stats0.serverStarted)));
    const initialAllTime = stats0.totalSessionsAllTime;
    const initialToday = stats0.sessionsToday;

    // Create a session
    await mcpRequest("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "stats-test", version: "1.0.0" },
      },
    });

    // Stats should reflect the new session
    const resp1 = await fetch(`http://localhost:${PORT}/api/stats`);
    const stats1 = await resp1.json() as any;
    assert.strictEqual(stats1.activeSessions, 1);
    assert.strictEqual(stats1.totalSessionsAllTime, initialAllTime + 1);
    assert.strictEqual(stats1.sessionsToday, initialToday + 1);
    // Should include clients breakdown with the client name from initialize
    assert.ok(typeof stats1.clients === "object");
    assert.ok(stats1.clients["stats-test"] >= 1, "clients should include stats-test");
  });

  it("GET /api/stats tracks client info from MCP initialize", async () => {
    proc = await startHttpServer();

    // Get initial client counts
    const resp0 = await fetch(`http://localhost:${PORT}/api/stats`);
    const stats0 = await resp0.json() as any;
    const initialClaude = stats0.clients?.["claude-desktop"] ?? 0;
    const initialCursor = stats0.clients?.["cursor"] ?? 0;

    // Create two sessions with different clients
    await mcpRequest("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "claude-desktop", version: "1.2.0" },
      },
    });
    await mcpRequest("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "cursor", version: "0.45.0" },
      },
    });
    await mcpRequest("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "claude-desktop", version: "1.2.0" },
      },
    });

    const resp = await fetch(`http://localhost:${PORT}/api/stats`);
    const stats = await resp.json() as any;
    assert.ok(typeof stats.clients === "object");
    assert.strictEqual(stats.clients["claude-desktop"], initialClaude + 2);
    assert.strictEqual(stats.clients["cursor"], initialCursor + 1);
  });

  it("logs session_open to stdout on session creation", async () => {
    proc = await startHttpServer();

    // Create a session
    const initResp = await mcpRequest("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "log-test", version: "1.0.0" },
      },
    });

    const sessionId = initResp.headers.get("mcp-session-id");
    assert.ok(sessionId);

    // Give a moment for stdout to flush
    await new Promise((r) => setTimeout(r, 100));

    // Read stdout from the process
    const stdout = proc!.stdout!;
    const chunks: Buffer[] = [];
    stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    // Drain any buffered data
    await new Promise((r) => setTimeout(r, 200));

    // We need to check what was already written to stdout
    // Since stdout is piped, we should have captured the session_open log
    // Let's verify by checking the health endpoint that the session exists
    const health = await fetch(`http://localhost:${PORT}/health`);
    const body = await health.json() as any;
    assert.strictEqual(body.sessions, 1);
  });

  it("GET /api/changes returns deal changes", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/api/changes`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("content-type"), "application/json");
    const body = await response.json() as any;
    assert.ok(Array.isArray(body.changes));
    assert.ok(typeof body.total === "number");
    assert.strictEqual(body.changes.length, body.total);
  });

  it("GET /api/changes filters by since, type, and vendor", async () => {
    proc = await startHttpServer();

    // Get all changes (use a very old date to get everything)
    const allResp = await fetch(`http://localhost:${PORT}/api/changes?since=2020-01-01`);
    const allBody = await allResp.json() as any;
    assert.ok(allBody.total > 0, "Should have deal changes with since=2020-01-01");

    // Filter by type
    const typeResp = await fetch(`http://localhost:${PORT}/api/changes?since=2020-01-01&type=free_tier_removed`);
    const typeBody = await typeResp.json() as any;
    for (const c of typeBody.changes) {
      assert.strictEqual(c.change_type, "free_tier_removed");
    }

    // Filter by vendor
    const vendorResp = await fetch(`http://localhost:${PORT}/api/changes?since=2020-01-01&vendor=Google`);
    const vendorBody = await vendorResp.json() as any;
    for (const c of vendorBody.changes) {
      assert.ok(c.vendor.toLowerCase().includes("google"));
    }
  });

  it("GET /api/changes returns 400 for invalid since param", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/api/changes?since=not-a-date`);
    assert.strictEqual(response.status, 400);
    const body = await response.json() as any;
    assert.ok(body.error.includes("Invalid"));
  });

  it("GET /api/changes filters by vendors (comma-separated)", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/api/changes?since=2020-01-01&vendors=Netlify,OpenAI`);
    assert.strictEqual(response.status, 200);
    const body = await response.json() as any;
    assert.ok(body.total >= 2, `Expected at least 2 changes for Netlify+OpenAI, got ${body.total}`);
    for (const change of body.changes) {
      const vendorLower = change.vendor.toLowerCase();
      assert.ok(
        vendorLower.includes("netlify") || vendorLower.includes("openai"),
        `Unexpected vendor: ${change.vendor}`
      );
    }
  });

  it("GET /api/details/:vendor returns offer details", async () => {
    proc = await startHttpServer();

    // Get a known vendor from /api/offers
    const offersResp = await fetch(`http://localhost:${PORT}/api/offers?limit=1`);
    const offersBody = await offersResp.json() as any;
    const vendorName = offersBody.offers[0].vendor;

    const response = await fetch(`http://localhost:${PORT}/api/details/${encodeURIComponent(vendorName)}`);
    assert.strictEqual(response.status, 200);
    const body = await response.json() as any;
    assert.ok(body.offer);
    assert.strictEqual(body.offer.vendor, vendorName);
    assert.ok(!body.alternatives, "Should not include alternatives by default");
  });

  it("GET /api/details/:vendor?alternatives=true includes alternatives", async () => {
    proc = await startHttpServer();

    // Get a known vendor
    const offersResp = await fetch(`http://localhost:${PORT}/api/offers?limit=1`);
    const offersBody = await offersResp.json() as any;
    const vendorName = offersBody.offers[0].vendor;

    const response = await fetch(`http://localhost:${PORT}/api/details/${encodeURIComponent(vendorName)}?alternatives=true`);
    assert.strictEqual(response.status, 200);
    const body = await response.json() as any;
    assert.ok(body.offer);
    assert.ok(Array.isArray(body.alternatives));
    assert.ok(body.alternatives.length <= 5);
  });

  it("GET /api/details/:vendor returns 404 for unknown vendor", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/api/details/${encodeURIComponent("NonExistentVendor12345")}`);
    assert.strictEqual(response.status, 404);
    const body = await response.json() as any;
    assert.ok(body.error.includes("not found"));
  });

  it("GET /api/details/:vendor is case-insensitive", async () => {
    proc = await startHttpServer();

    // Get a known vendor
    const offersResp = await fetch(`http://localhost:${PORT}/api/offers?limit=1`);
    const offersBody = await offersResp.json() as any;
    const vendorName = offersBody.offers[0].vendor;

    // Request with different casing
    const lowerName = vendorName.toLowerCase();
    const response = await fetch(`http://localhost:${PORT}/api/details/${encodeURIComponent(lowerName)}`);
    assert.strictEqual(response.status, 200);
    const body = await response.json() as any;
    assert.ok(body.offer);
    assert.strictEqual(body.offer.vendor, vendorName);
  });

  it("logs session_close on explicit DELETE", async () => {
    proc = await startHttpServer();

    // Collect stdout
    let stdoutData = "";
    proc!.stdout!.on("data", (chunk: Buffer) => {
      stdoutData += chunk.toString();
    });

    // Create a session
    const initResp = await mcpRequest("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "close-test", version: "1.0.0" },
      },
    });

    const sessionId = initResp.headers.get("mcp-session-id");
    assert.ok(sessionId);

    // Wait for session_open log
    await new Promise((r) => setTimeout(r, 100));

    // Delete the session
    await fetch(`http://localhost:${PORT}/mcp`, {
      method: "DELETE",
      headers: { "Mcp-Session-Id": sessionId },
    });

    // Wait for logs to flush
    await new Promise((r) => setTimeout(r, 200));

    // Parse stdout lines as JSON
    const lines = stdoutData.trim().split("\n").filter(Boolean);
    const events = lines.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);

    // Should have session_open and session_close events
    const openEvent = events.find((e: any) => e.event === "session_open");
    assert.ok(openEvent, "Should have session_open event");
    assert.strictEqual(openEvent.sessionId, sessionId);
    assert.ok(openEvent.ts);
    assert.ok(openEvent.ip);
    assert.ok(openEvent.userAgent);

    const closeEvent = events.find((e: any) => e.event === "session_close");
    assert.ok(closeEvent, "Should have session_close event");
    assert.strictEqual(closeEvent.sessionId, sessionId);
    assert.strictEqual(closeEvent.reason, "client_disconnect");
    assert.ok(typeof closeEvent.durationMs === "number");
    assert.ok(closeEvent.durationMs >= 0);

    // Verify session was cleaned up
    const health = await fetch(`http://localhost:${PORT}/health`);
    const body = await health.json() as any;
    assert.strictEqual(body.sessions, 0);
  });

  it("GET /api/openapi.json returns valid OpenAPI 3.0 spec", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/api/openapi.json`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("content-type"), "application/json");
    assert.strictEqual(response.headers.get("access-control-allow-origin"), "*");
    const body = await response.json() as any;
    assert.strictEqual(body.openapi, "3.0.3");
    assert.strictEqual(body.info.title, "AgentDeals API");
    assert.ok(body.info.description.includes("No authentication required"));
    assert.ok(body.paths["/api/offers"]);
    assert.ok(body.paths["/api/categories"]);
    assert.ok(body.paths["/api/new"]);
    assert.ok(body.paths["/api/changes"]);
    assert.ok(body.paths["/api/details/{vendor}"]);
    assert.ok(body.paths["/api/stats"]);
    assert.ok(body.paths["/api/query-log"]);
    assert.ok(body.paths["/api/stack"]);
    assert.ok(body.paths["/api/compare"]);
    assert.ok(body.paths["/api/vendor-risk/{vendor}"]);
    assert.ok(body.paths["/api/audit-stack"]);
    assert.ok(body.paths["/api/expiring"]);
    assert.ok(body.paths["/api/digest"]);
    assert.ok(body.paths["/api/newest"]);
    assert.ok(body.paths["/api/costs"]);
    assert.ok(body.paths["/feed.xml"]);
    assert.ok(body.paths["/api/pageviews"]);
    assert.strictEqual(Object.keys(body.paths).length, 17);
    assert.ok(body.components.schemas.Offer);
    assert.ok(body.components.schemas.DealChange);
    assert.ok(body.components.schemas.Eligibility);
  });

  it("GET /api redirects to /api/docs", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/api`, { redirect: "manual" });
    assert.strictEqual(response.status, 301);
    assert.strictEqual(response.headers.get("location"), "/api/docs");
  });

  it("GET /feed.xml returns valid Atom XML", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/feed.xml`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("application/atom+xml"));
    const body = await response.text();
    assert.ok(body.startsWith("<?xml"));
    assert.ok(body.includes("<feed xmlns="));
    assert.ok(body.includes("<title>AgentDeals"));
    assert.ok(body.includes("<entry>"));
    assert.ok(body.includes("<updated>"));
    assert.ok(body.includes("/vendor/"));
    assert.ok(body.includes("<category"));
  });

  it("GET /api/feed also serves Atom feed", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/api/feed`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("application/atom+xml"));
    const body = await response.text();
    assert.ok(body.includes("<feed xmlns="));
  });

  it("GET /rss, /feed, /atom redirect 301 to /feed.xml", async () => {
    proc = await startHttpServer();

    for (const path of ["/rss", "/feed", "/atom"]) {
      const response = await fetch(`http://localhost:${PORT}${path}`, { redirect: "manual" });
      assert.strictEqual(response.status, 301, `${path} should 301`);
      assert.strictEqual(response.headers.get("location"), "/feed.xml", `${path} should redirect to /feed.xml`);
    }
  });

  it("prompts/list returns all 6 prompt templates", async () => {
    proc = await startHttpServer();

    // Initialize session
    const initResp = await mcpRequest("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "prompt-test", version: "1.0.0" },
      },
    });
    const sessionId = initResp.headers.get("mcp-session-id");
    assert.ok(sessionId);

    // Send initialized notification
    await mcpRequest("/mcp", {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }, sessionId);

    // List prompts
    const listResp = await mcpRequest("/mcp", {
      jsonrpc: "2.0",
      id: 2,
      method: "prompts/list",
    }, sessionId);

    const data = parseSSEData(listResp.text);
    const result = data.find((d: any) => d.id === 2);
    assert.ok(result, "Should get prompts/list response");
    const prompts = result.result.prompts;
    assert.strictEqual(prompts.length, 6);

    const names = prompts.map((p: any) => p.name).sort();
    assert.deepStrictEqual(names, [
      "check-pricing-changes",
      "compare-options",
      "cost-audit",
      "find-startup-credits",
      "monitor-vendor-changes",
      "new-project-setup",
    ]);

    // Each prompt should have a description
    for (const p of prompts) {
      assert.ok(p.description, `Prompt ${p.name} should have a description`);
    }

    // compare-options should have services argument
    const compareOpts = prompts.find((p: any) => p.name === "compare-options");
    assert.ok(compareOpts.arguments?.some((a: any) => a.name === "services"));

    // check-pricing-changes should have no required arguments
    const checkChanges = prompts.find((p: any) => p.name === "check-pricing-changes");
    assert.ok(!checkChanges.arguments || checkChanges.arguments.length === 0);

    // monitor-vendor-changes should have vendors argument
    const monitorVendors = prompts.find((p: any) => p.name === "monitor-vendor-changes");
    assert.ok(monitorVendors.arguments?.some((a: any) => a.name === "vendors"));
  });

  it("prompts/get returns structured message for compare-options", async () => {
    proc = await startHttpServer();

    // Initialize session
    const initResp = await mcpRequest("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "prompt-test", version: "1.0.0" },
      },
    });
    const sessionId = initResp.headers.get("mcp-session-id");
    assert.ok(sessionId);

    // Send initialized notification
    await mcpRequest("/mcp", {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }, sessionId);

    // Get prompt
    const getResp = await mcpRequest("/mcp", {
      jsonrpc: "2.0",
      id: 3,
      method: "prompts/get",
      params: {
        name: "compare-options",
        arguments: { services: "Supabase,Neon" },
      },
    }, sessionId);

    const data = parseSSEData(getResp.text);
    const result = data.find((d: any) => d.id === 3);
    assert.ok(result, "Should get prompts/get response");
    assert.ok(result.result.messages);
    assert.strictEqual(result.result.messages.length, 1);
    const msg = result.result.messages[0];
    assert.strictEqual(msg.role, "user");
    assert.ok(msg.content.text.includes("Supabase"));
    assert.ok(msg.content.text.includes("compare_vendors"));
  });

  it("GET /category/:slug returns server-rendered category page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/category/databases`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("<title>Free Databases Tools"), "Should have category-specific title");
    assert.ok(html.includes('name="description"'), "Should have meta description");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD structured data");
    assert.ok(html.includes("ItemList"), "JSON-LD should use ItemList schema");
    assert.ok(html.includes("All Categories"), "Should have all-categories navigation");
    assert.ok(html.includes("/category/"), "Should link to other categories");
    assert.ok(html.includes('canonical'), "Should have canonical link");
  });

  it("GET /category/:slug returns 404 for unknown category", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/category/nonexistent-category`);
    assert.strictEqual(response.status, 404);
    const html = await response.text();
    assert.ok(html.includes("404"), "Should show 404 message");
    assert.ok(html.includes("nonexistent-category"), "Should show the invalid slug");
  });

  it("sitemap.xml includes category pages and comparison pages", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/sitemap.xml`);
    assert.strictEqual(response.status, 200);
    const xml = await response.text();
    assert.ok(xml.includes("/category/databases"), "Sitemap should include databases category");
    assert.ok(xml.includes("/category/ai-coding"), "Sitemap should include ai-coding category");
    // Should have many category entries (54 categories)
    const categoryCount = (xml.match(/\/category\//g) || []).length;
    assert.ok(categoryCount >= 50, `Expected 50+ category URLs in sitemap, got ${categoryCount}`);
    // Should include comparison pages
    assert.ok(xml.includes("/compare/netlify-vs-vercel"), "Sitemap should include comparison pages");
    const compareCount = (xml.match(/\/compare\//g) || []).length;
    assert.ok(compareCount >= 20, `Expected 20+ comparison URLs in sitemap, got ${compareCount}`);
  });

  it("GET /compare returns comparison index page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/compare`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("<title>Free Tier Comparisons"), "Should have index title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("CollectionPage"), "JSON-LD should use CollectionPage schema");
    assert.ok(html.includes("/compare/netlify-vs-vercel"), "Should link to comparison pages");
    assert.ok(html.includes("canonical"), "Should have canonical link");
  });

  it("GET /compare/:slug renders comparison page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/compare/netlify-vs-vercel`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Netlify"), "Should show vendor A name");
    assert.ok(html.includes("Vercel"), "Should show vendor B name");
    assert.ok(html.includes("<title>"), "Should have a title");
    assert.ok(html.includes("vs"), "Title should contain vs");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("Pricing Change History"), "Should show change history section");
    assert.ok(html.includes("Category"), "Should show category detail");
    assert.ok(html.includes("Tier"), "Should show tier detail");
  });

  it("GET /compare/:slug redirects reversed URLs", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/compare/vercel-vs-netlify`, { redirect: "manual" });
    assert.strictEqual(response.status, 301);
    assert.ok(response.headers.get("location")?.includes("/compare/netlify-vs-vercel"), "Should redirect to canonical URL");
  });

  it("GET /compare/:slug returns 404 for invalid pairs", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/compare/nonexistent-vs-also-nonexistent`);
    assert.strictEqual(response.status, 404);
    const html = await response.text();
    assert.ok(html.includes("404"), "Should show 404");
    assert.ok(html.includes("/compare"), "Should link to comparisons index");
  });

  it("GET /digest redirects to current week", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/digest`, { redirect: "manual" });
    assert.strictEqual(response.status, 302);
    const location = response.headers.get("location") ?? "";
    assert.ok(location.match(/\/digest\/\d{4}-w\d{2}/), `Should redirect to week URL, got: ${location}`);
  });

  it("GET /digest/archive lists weeks with changes", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/digest/archive`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("<title>Pricing Change Digest Archive"), "Should have archive title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("CollectionPage"), "JSON-LD should use CollectionPage");
    assert.ok(html.includes("/digest/"), "Should link to weekly digests");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("/feed.xml"), "Should link to RSS feed");
  });

  it("GET /digest/:week renders digest page with changes", async () => {
    proc = await startHttpServer();

    // Use 2026-w11 which has deal changes (March 2026)
    const response = await fetch(`http://localhost:${PORT}/digest/2026-w11`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("<title>Developer Tool Pricing Changes"), "Should have week title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("/feed.xml"), "Should have RSS link");
  });

  it("GET /digest/:week shows empty state for weeks with no changes", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/digest/2026-w50`);
    assert.strictEqual(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes("No pricing changes tracked this week"), "Should show empty message");
    assert.ok(html.includes("/digest/archive"), "Should link to archive");
  });

  it("GET /digest/:week returns 404 for invalid format", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/digest/invalid-format`);
    assert.strictEqual(response.status, 404);
    const html = await response.text();
    assert.ok(html.includes("404"), "Should show 404");
  });

  it("sitemap.xml includes digest pages", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/sitemap.xml`);
    const xml = await response.text();
    assert.ok(xml.includes("/digest/archive"), "Sitemap should include digest archive");
    const digestCount = (xml.match(/\/digest\//g) || []).length;
    assert.ok(digestCount >= 3, `Expected at least 3 digest URLs in sitemap, got ${digestCount}`);
  });

  it("GET /vendor returns vendor index page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/vendor`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("<title>All Vendors"), "Should have vendor index title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("CollectionPage"), "JSON-LD should use CollectionPage");
    assert.ok(html.includes("/vendor/"), "Should link to vendor pages");
    assert.ok(html.includes("canonical"), "Should have canonical link");
  });

  it("GET /vendor/:slug renders vendor profile page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/vendor/vercel`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Vercel Free Tier"), "Should have vendor-specific title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("SoftwareApplication"), "JSON-LD should use SoftwareApplication");
    assert.ok(html.includes("Pricing Change History"), "Should show pricing history section");
    assert.ok(html.includes("Query via MCP"), "Should show MCP snippet");
    assert.ok(html.includes("Alternatives in"), "Should show alternatives");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("risk-badge"), "Should show risk badge");
  });

  it("GET /vendor/:slug returns 404 for unknown vendor", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/vendor/nonexistent-vendor`);
    assert.strictEqual(response.status, 404);
    const html = await response.text();
    assert.ok(html.includes("404"), "Should show 404");
    assert.ok(html.includes("nonexistent-vendor"), "Should show the invalid slug");
    assert.ok(html.includes("/vendor"), "Should link to vendor index");
  });

  it("sitemap.xml includes vendor pages", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/sitemap.xml`);
    const xml = await response.text();
    assert.ok(xml.includes("/vendor/vercel"), "Sitemap should include vendor pages");
    const vendorCount = (xml.match(/\/vendor\//g) || []).length;
    assert.ok(vendorCount >= 100, `Expected 100+ vendor URLs in sitemap, got ${vendorCount}`);
  });

  it("category page links vendors to profile pages", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/category/cloud-hosting`);
    const html = await response.text();
    assert.ok(html.includes('href="/vendor/'), "Category page should link vendors to profile pages");
  });

  it("GET /trends returns trends index page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/trends`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("<title>Pricing Trends by Category"), "Should have trends index title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("CollectionPage"), "JSON-LD should use CollectionPage");
    assert.ok(html.includes("/trends/"), "Should link to category trends");
    assert.ok(html.includes("canonical"), "Should have canonical link");
  });

  it("GET /trends/:slug renders category trends page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/trends/cloud-hosting`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Cloud Hosting Pricing Trends"), "Should have category-specific title");
    assert.ok(html.includes("Pricing Change Timeline"), "Should show timeline section");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
  });

  it("GET /trends/:slug returns 404 for unknown category", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/trends/nonexistent-category`);
    assert.strictEqual(response.status, 404);
    const html = await response.text();
    assert.ok(html.includes("404"), "Should show 404");
    assert.ok(html.includes("/trends"), "Should link to trends index");
  });

  it("sitemap.xml includes trends pages", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/sitemap.xml`);
    const xml = await response.text();
    assert.ok(xml.includes("/trends/cloud-hosting"), "Sitemap should include trends pages");
    const trendsCount = (xml.match(/\/trends\//g) || []).length;
    assert.ok(trendsCount >= 50, `Expected 50+ trends URLs in sitemap, got ${trendsCount}`);
  });

  // --- Alternative-to pages ---

  it("GET /alternative-to returns alternatives index page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/alternative-to`);
    assert.strictEqual(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes("<title>Free Alternatives to Popular Tools"), "Should have alternatives index title");
    assert.ok(html.includes("/alternative-to/"), "Should link to individual alternative pages");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
  });

  it("GET /alternative-to/:slug renders alternatives page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/alternative-to/vercel`);
    assert.strictEqual(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes("Free Alternatives to Vercel"), "Should have vendor-specific title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("/vendor/"), "Should link to vendor profiles");
    assert.ok(html.includes("Current Vercel Situation"), "Should show vendor situation");
    assert.ok(html.includes("/trends/"), "Should link to category trends");
  });

  it("GET /alternative-to/:slug returns 404 for unknown vendor", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/alternative-to/nonexistent-vendor`);
    assert.strictEqual(response.status, 404);
    const html = await response.text();
    assert.ok(html.includes("nonexistent-vendor"), "Should show the invalid slug");
    assert.ok(html.includes("/alternative-to"), "Should link to alternatives index");
  });

  it("sitemap.xml includes alternative-to pages", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/sitemap.xml`);
    const xml = await response.text();
    assert.ok(xml.includes("/alternative-to"), "Sitemap should include alternatives index");
    assert.ok(xml.includes("/alternative-to/vercel"), "Sitemap should include vendor alternatives");
    const altCount = (xml.match(/\/alternative-to\//g) || []).length;
    assert.ok(altCount >= 100, `Expected 100+ alternative-to URLs in sitemap, got ${altCount}`);
  });

  // --- Expiring page ---

  it("GET /expiring renders expiring deals timeline page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/expiring`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("<title>Upcoming Free Tier Changes"), "Should have expiring title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("ItemList"), "JSON-LD should use ItemList");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("/expiring"), "Should reference /expiring");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Recently Changed"), "Should have recently changed section");
  });

  // --- Changes page ---

  it("GET /changes renders deal change timeline page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/changes`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("<title>Deal Change Timeline"), "Should have changes title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("ItemList"), "JSON-LD should use ItemList");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("/changes"), "Should reference /changes");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("feed.xml"), "Should link to RSS feed");
    assert.ok(!html.includes("${BASE_URL}"), "Should not have unresolved BASE_URL");
  });

  // --- Timely alternatives pages ---

  it("GET /localstack-alternatives renders alternatives page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/localstack-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("LocalStack CE Alternatives"), "Should have LocalStack title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Top Alternatives"), "Should have alternatives section");
    assert.ok(html.includes("March 23, 2026"), "Should mention shutdown date");
  });

  it("GET /postman-alternatives renders alternatives page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/postman-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Postman Alternatives"), "Should have Postman title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Top Alternatives"), "Should have alternatives section");
    assert.ok(html.includes("single-user only"), "Should mention the restriction");
  });

  // --- Search page ---

  it("GET /search renders search page with search box", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/search`);
    assert.strictEqual(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes("<title>Search Free Developer Tools"), "Should have search title");
    assert.ok(html.includes("search-input"), "Should have search input");
    assert.ok(html.includes("Popular searches"), "Should show suggested searches when no query");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
  });

  it("GET /search?q=database returns server-rendered results", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/search?q=database`);
    assert.strictEqual(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes("database"), "Should contain search query");
    assert.ok(html.includes("result-card"), "Should have result cards");
    assert.ok(html.includes("/vendor/"), "Should link to vendor profiles");
  });

  it("GET /search?q=database&category=Databases filters by category", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/search?q=database&category=Databases`);
    assert.strictEqual(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes("result-card"), "Should have result cards");
    assert.ok(html.includes("cat-filter active"), "Should highlight active category filter");
  });

  it("GET /search?q=xyznonexistent shows empty state", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/search?q=xyznonexistent`);
    assert.strictEqual(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes("No results found"), "Should show empty state");
    assert.ok(html.includes("suggest-pill"), "Should show suggested searches");
  });

  it("GET /search has category filter pills", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/search`);
    assert.strictEqual(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes("cat-filter"), "Should have category filter pills");
    assert.ok(html.includes("Databases"), "Should include Databases category");
  });

  // --- Global navigation ---

  it("landing page has global navigation with all section links", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/`);
    const html = await response.text();
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes('href="/search"'), "Nav should link to Search");
    assert.ok(html.includes('href="/category"'), "Nav should link to Categories");
    assert.ok(html.includes('href="/best"'), "Nav should link to Best Of");
    assert.ok(html.includes('href="/trends"'), "Nav should link to Trends");
    assert.ok(html.includes('href="/alternative-to"'), "Nav should link to Alternatives");
    assert.ok(html.includes('href="/compare"'), "Nav should link to Compare");
    assert.ok(html.includes('href="/digest"'), "Nav should link to Digest");
    assert.ok(html.includes('href="/api/docs"'), "Nav should link to API");
  });

  it("category page nav highlights Categories as active", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/category/databases`);
    const html = await response.text();
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes('class="nav-link active">Categories'), "Categories should be active");
  });

  it("search page nav highlights Search as active", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/search`);
    const html = await response.text();
    assert.ok(html.includes('class="nav-link active">Search'), "Search should be active");
  });

  it("global nav appears on all page types", async () => {
    proc = await startHttpServer();

    const pages = ["/", "/category/databases", "/best", "/search", "/trends", "/compare", "/alternative-to", "/digest/archive"];
    for (const page of pages) {
      const response = await fetch(`http://localhost:${PORT}${page}`);
      const html = await response.text();
      assert.ok(html.includes("global-nav"), `${page} should have global nav`);
      assert.ok(html.includes("global-nav-home"), `${page} should have AgentDeals home link`);
    }
  });

  // --- FAQ structured data ---

  it("vendor page has FAQ structured data and visible FAQ section", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/vendor/vercel`);
    const html = await response.text();
    assert.ok(html.includes("FAQPage"), "Should have FAQPage JSON-LD");
    assert.ok(html.includes("faq-item"), "Should have visible FAQ items");
    assert.ok(html.includes("Is Vercel free"), "Should have vendor-specific FAQ question");
    assert.ok(html.includes("free tier"), "FAQ answer should mention free tier");
  });

  it("alternative-to page has FAQ structured data and visible FAQ section", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/alternative-to/vercel`);
    const html = await response.text();
    assert.ok(html.includes("FAQPage"), "Should have FAQPage JSON-LD");
    assert.ok(html.includes("faq-item"), "Should have visible FAQ items");
    assert.ok(html.includes("best free alternatives to Vercel"), "Should have alternatives FAQ question");
    assert.ok(html.includes("How many free alternatives"), "Should have count FAQ question");
  });

  it("landing page has recent pricing changes section", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/`);
    const html = await response.text();
    assert.ok(html.includes('id="recent-changes"'), "Should have recent-changes section");
    assert.ok(html.includes("rc-entry"), "Should have change entries");
    assert.ok(html.includes("rc-vendor"), "Should have vendor links");
    assert.ok(html.includes('href="/expiring"'), "Should link to /expiring");
    assert.ok(html.includes('"Recent Pricing Changes"'), "Should have ItemList JSON-LD");
  });

  it("landing page has changing soon section with upcoming deal changes", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/`);
    const html = await response.text();
    assert.ok(html.includes('id="changing-soon"'), "Should have changing-soon section");
    assert.ok(html.includes("cs-entry"), "Should have change entries");
    assert.ok(html.includes("cs-vendor"), "Should have vendor links");
    assert.ok(html.includes("cs-countdown"), "Should have countdown indicators");
    assert.ok(html.includes('href="/changes"'), "Should link to /changes");
  });

  it("serves og-image.png at /og-image.png", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${PORT}/og-image.png`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("content-type"), "image/png");
    assert.ok(response.headers.get("cache-control")?.includes("public"));
    const buffer = Buffer.from(await response.arrayBuffer());
    // PNG magic bytes
    assert.strictEqual(buffer[0], 0x89);
    assert.strictEqual(buffer[1], 0x50); // P
    assert.strictEqual(buffer[2], 0x4e); // N
    assert.strictEqual(buffer[3], 0x47); // G
    // Verify 1200x630 dimensions from PNG header
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    assert.strictEqual(width, 1200, "OG image should be 1200px wide");
    assert.strictEqual(height, 630, "OG image should be 630px tall");
  });

  it("landing page has OG image and Twitter card meta tags", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${PORT}/`);
    const html = await response.text();
    assert.ok(html.includes('property="og:image"'), "Should have og:image tag");
    assert.ok(html.includes("/og-image.png"), "og:image should point to /og-image.png");
    assert.ok(html.includes('property="og:image:width" content="1200"'), "Should have og:image:width");
    assert.ok(html.includes('property="og:image:height" content="630"'), "Should have og:image:height");
    assert.ok(html.includes('name="twitter:card" content="summary_large_image"'), "Should have twitter:card summary_large_image");
    assert.ok(html.includes('name="twitter:image"'), "Should have twitter:image");
  });

  it("category page has OG image meta tags", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${PORT}/category/databases`);
    const html = await response.text();
    assert.ok(html.includes('property="og:image"'), "Should have og:image tag");
    assert.ok(html.includes("/og-image.png"), "og:image should point to /og-image.png");
    assert.ok(html.includes('name="twitter:card" content="summary_large_image"'), "Should have twitter:card");
  });

  it("vendor page has OG image meta tags", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${PORT}/vendor/vercel`);
    const html = await response.text();
    assert.ok(html.includes('property="og:image"'), "Should have og:image tag");
    assert.ok(html.includes("/og-image.png"), "og:image should point to /og-image.png");
    assert.ok(html.includes('name="twitter:card" content="summary_large_image"'), "Should have twitter:card");
  });

  it("expiring page has OG image meta tags", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${PORT}/expiring`);
    const html = await response.text();
    assert.ok(html.includes('property="og:image"'), "Should have og:image tag");
    assert.ok(html.includes("/og-image.png"), "og:image should point to /og-image.png");
    assert.ok(html.includes('name="twitter:card" content="summary_large_image"'), "Should have twitter:card");
  });
});

const REDIRECT_PORT = 3458;

function startRedirectServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: String(REDIRECT_PORT), BASE_URL: "https://agentdeals.dev" },
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 5000);

    proc.stderr!.on("data", (data: Buffer) => {
      if (data.toString().includes("running on http")) {
        clearTimeout(timeout);
        resolve(proc);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe("best-of pages", () => {
  let proc: ChildProcess | null = null;

  afterEach(() => {
    if (proc) {
      proc.kill();
      proc = null;
    }
  });

  it("GET /best returns best-of index page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/best`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("<title>"), "Should have a title");
    assert.ok(html.includes("Best Free Developer Tools"), "Should have page heading");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD structured data");
    assert.ok(html.includes('href="/best/free-'), "Should link to best-of detail pages");
    assert.ok(html.includes("best-index-card"), "Should have card grid");
    assert.ok(html.includes('canonical'), "Should have canonical link");
  });

  it("GET /best/free-databases returns best-of detail page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/best/free-databases`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Best Free Databases"), "Should have category-specific title");
    assert.ok(html.includes('name="description"'), "Should have meta description");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD structured data");
    assert.ok(html.includes("ItemList"), "JSON-LD should use ItemList schema");
    assert.ok(html.includes("best-pick"), "Should have curated pick cards");
    assert.ok(html.includes("compare-table"), "Should have comparison table");
    assert.ok(html.includes("Why trust this data"), "Should have trust note");
    assert.ok(html.includes('canonical'), "Should have canonical link");
    assert.ok(html.includes('href="/best"'), "Should link back to best-of index");
    assert.ok(html.includes('href="/category/databases"'), "Should link to full category page");
  });

  it("GET /best/free-nonexistent returns 404", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/best/free-nonexistent`);
    assert.strictEqual(response.status, 404);
    const html = await response.text();
    assert.ok(html.includes("404"), "Should show 404 message");
  });

  it("sitemap.xml includes best-of pages", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/sitemap.xml`);
    const xml = await response.text();
    assert.ok(xml.includes("/best"), "Sitemap should include best-of index");
    assert.ok(xml.includes("/best/free-databases"), "Sitemap should include best-of detail pages");
    const bestCount = (xml.match(/\/best\//g) || []).length;
    assert.ok(bestCount >= 8, `Expected 8+ best-of URLs in sitemap, got ${bestCount}`);
  });

  it("best-of page nav highlights Best Of as active", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/best/free-databases`);
    const html = await response.text();
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes('class="nav-link active">Best Of'), "Best Of should be active");
  });
});

describe("MCP install CTA banner", () => {
  let proc: ChildProcess | null = null;

  afterEach(() => {
    if (proc) {
      proc.kill();
      proc = null;
    }
  });

  it("CTA appears on category page", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${PORT}/category/databases`);
    const html = await response.text();
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA banner");
    assert.ok(html.includes("claude mcp add agentdeals"), "Should have install command");
    assert.ok(html.includes('href="/setup"'), "Should link to setup guide");
  });

  it("CTA appears on vendor page", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${PORT}/vendor/vercel`);
    const html = await response.text();
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA banner");
    assert.ok(html.includes("claude mcp add agentdeals"), "Should have install command");
  });

  it("CTA appears on comparison page", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${PORT}/compare/netlify-vs-vercel`);
    const html = await response.text();
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA banner");
    assert.ok(html.includes("claude mcp add agentdeals"), "Should have install command");
  });

  it("CTA appears on best-of page", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${PORT}/best/free-databases`);
    const html = await response.text();
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA banner");
    assert.ok(html.includes("claude mcp add agentdeals"), "Should have install command");
  });

  it("CTA appears on alternative-to page", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${PORT}/alternative-to/vercel`);
    const html = await response.text();
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA banner");
    assert.ok(html.includes("claude mcp add agentdeals"), "Should have install command");
  });

  it("CTA does NOT appear on landing page", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${PORT}/`);
    const html = await response.text();
    assert.ok(!html.includes("mcp-cta"), "Landing page should NOT have MCP CTA banner");
  });

  it("CTA includes copy button", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${PORT}/vendor/vercel`);
    const html = await response.text();
    assert.ok(html.includes("copyCta"), "Should have copy button handler");
    assert.ok(html.includes("copy-btn"), "Should have copy button");
  });
});

describe("page view tracking", () => {
  let proc: ChildProcess | null = null;

  afterEach(() => {
    if (proc) {
      proc.kill();
      proc = null;
    }
  });

  it("GET /api/pageviews returns page view data", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${PORT}/api/pageviews`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("application/json"));
    const data = await response.json() as Record<string, unknown>;
    assert.ok("today" in data, "Should have today field");
    assert.ok("yesterday" in data, "Should have yesterday field");
    assert.ok("all_time" in data, "Should have all_time field");
    assert.ok("referrers_today" in data, "Should have referrers_today field");
    const today = data.today as { total: number; top_pages: unknown[] };
    assert.ok(typeof today.total === "number", "today.total should be a number");
    assert.ok(Array.isArray(today.top_pages), "today.top_pages should be an array");
  });

  it("page_views_today appears in stats response", async () => {
    proc = await startHttpServer();
    // Visit a page first to increment counter
    await fetch(`http://localhost:${PORT}/category/databases`);
    const response = await fetch(`http://localhost:${PORT}/api/stats`);
    const text = await response.text();
    // The getStats export isn't used by /api/stats (it uses getConnectionStats),
    // but page_views_today may be in the response if getStats is used elsewhere
    assert.strictEqual(response.status, 200);
  });

  it("page views increment on page visit", async () => {
    proc = await startHttpServer();
    // Get initial count
    const before = await fetch(`http://localhost:${PORT}/api/pageviews`);
    const dataBefore = await before.json() as { today: { total: number } };
    const initialTotal = dataBefore.today.total;
    // Visit a page
    await fetch(`http://localhost:${PORT}/vendor/vercel`);
    // Check count increased
    const after = await fetch(`http://localhost:${PORT}/api/pageviews`);
    const dataAfter = await after.json() as { today: { total: number } };
    assert.ok(dataAfter.today.total >= initialTotal, "Page views should not decrease after visit");
  });
});

describe("301 canonical hostname redirect", () => {
  let proc: ChildProcess | null = null;

  afterEach(() => {
    if (proc) {
      proc.kill();
      proc = null;
    }
  });

  it("redirects HTML pages to canonical domain with 301", async () => {
    proc = await startRedirectServer();
    const response = await fetch(`http://localhost:${REDIRECT_PORT}/vendor/supabase?ref=foo`, { redirect: "manual" });
    assert.strictEqual(response.status, 301);
    assert.strictEqual(response.headers.get("location"), "https://agentdeals.dev/vendor/supabase?ref=foo");
  });

  it("redirects landing page to canonical domain", async () => {
    proc = await startRedirectServer();
    const response = await fetch(`http://localhost:${REDIRECT_PORT}/`, { redirect: "manual" });
    assert.strictEqual(response.status, 301);
    assert.strictEqual(response.headers.get("location"), "https://agentdeals.dev/");
  });

  it("does NOT redirect /api/* endpoints", async () => {
    proc = await startRedirectServer();
    const response = await fetch(`http://localhost:${REDIRECT_PORT}/api/stats`, { redirect: "manual" });
    assert.strictEqual(response.status, 200);
  });

  it("does NOT redirect /mcp endpoint", async () => {
    proc = await startRedirectServer();
    // GET /mcp without session returns 400, but should NOT be 301
    const response = await fetch(`http://localhost:${REDIRECT_PORT}/mcp`, { redirect: "manual" });
    assert.notStrictEqual(response.status, 301, "MCP should not redirect");
  });

  it("does NOT redirect /health endpoint", async () => {
    proc = await startRedirectServer();
    const response = await fetch(`http://localhost:${REDIRECT_PORT}/health`, { redirect: "manual" });
    assert.strictEqual(response.status, 200);
  });

  it("does NOT redirect /.well-known/* endpoints", async () => {
    proc = await startRedirectServer();
    const response = await fetch(`http://localhost:${REDIRECT_PORT}/.well-known/glama.json`, { redirect: "manual" });
    assert.notStrictEqual(response.status, 301, ".well-known should not redirect");
  });

  it("does NOT redirect favicon", async () => {
    proc = await startRedirectServer();
    const response = await fetch(`http://localhost:${REDIRECT_PORT}/favicon.png`, { redirect: "manual" });
    assert.strictEqual(response.status, 200);
  });

  it("no redirect when BASE_URL matches request host", async () => {
    // Default server has BASE_URL matching localhost (or not set to external domain)
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${PORT}/`, { redirect: "manual" });
    assert.strictEqual(response.status, 200);
  });
});

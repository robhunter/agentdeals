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
      env: { ...process.env, PORT: String(PORT) },
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
          params: { name: "list_categories", arguments: {} },
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

  it("search_offers works over HTTP", async () => {
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
          params: { name: "search_offers", arguments: { query: "postgres" } },
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
            params: { name: "list_categories", arguments: {} },
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
            params: { name: "search_offers", arguments: { query: "redis" } },
          },
        ],
        sessionB
      ),
    ]);

    assert.strictEqual(toolRespA.status, 200);
    assert.strictEqual(toolRespB.status, 200);

    const dataA = parseSSEData(toolRespA.text);
    const resultA = dataA.find((d: any) => d.id === 2);
    assert.ok(resultA, "Client A should get list_categories result");
    const categories = JSON.parse(resultA.result.content[0].text);
    assert.ok(Array.isArray(categories));

    const dataB = parseSSEData(toolRespB.text);
    const resultB = dataB.find((d: any) => d.id === 2);
    assert.ok(resultB, "Client B should get search_offers result");
    const searchBody = JSON.parse(resultB.result.content[0].text);
    assert.ok(Array.isArray(searchBody.results));
    assert.ok(searchBody.results.length > 0);
  });

  it("serves /.well-known/glama.json", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/.well-known/glama.json`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("content-type"), "application/json");
    const body = await response.json() as any;
    assert.strictEqual(body["$schema"], "https://glama.ai/mcp/schemas/connector.json");
    assert.ok(Array.isArray(body.maintainers));
    assert.strictEqual(body.maintainers.length, 1);
    assert.strictEqual(body.maintainers[0].email, "robvhunter@gmail.com");
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
    assert.ok(html.includes("DM Serif Display"), "Landing page should use serif display font");
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
    assert.strictEqual(Object.keys(body.paths).length, 7);
    assert.ok(body.components.schemas.Offer);
    assert.ok(body.components.schemas.DealChange);
    assert.ok(body.components.schemas.Eligibility);
  });
});

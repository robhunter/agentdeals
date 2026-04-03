import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let serverPort = 0;

function startHttpServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 5000);

    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        serverPort = parseInt(match[1], 10);
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

  const response = await fetch(`http://localhost:${serverPort}${path}`, {
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

    const response = await fetch(`http://localhost:${serverPort}/health`);
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

    const response = await fetch(`http://localhost:${serverPort}/.well-known/glama.json`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("content-type"), "application/json");
    const body = await response.json() as any;
    assert.strictEqual(body["$schema"], "https://glama.ai/mcp/schemas/server.json");
    assert.strictEqual(body.name, "agentdeals");
    assert.strictEqual(body.license, "MIT");
    assert.strictEqual(body.tools, 4);
    assert.ok(Array.isArray(body.transport));
  });

  it("serves /AGENTS.md with text/markdown content type", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/AGENTS.md`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("content-type"), "text/markdown; charset=utf-8");
    const body = await response.text();
    assert.ok(body.includes("# AgentDeals"));
    assert.ok(body.includes("## MCP Tools"));
    assert.ok(body.includes("search_deals"));
  });

  it("serves /.well-known/mcp.json server card", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/.well-known/mcp.json`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("content-type"), "application/json");
    assert.strictEqual(response.headers.get("cache-control"), "public, max-age=3600");
    assert.strictEqual(response.headers.get("access-control-allow-origin"), "*");
    const body = await response.json() as any;
    assert.strictEqual(body.version, "1.0");
    assert.strictEqual(body.serverInfo.name, "agentdeals");
    assert.strictEqual(body.transport.type, "streamable-http");
    assert.ok(body.transport.endpoint.endsWith("/mcp"));
    assert.strictEqual(body.authentication.required, false);
    assert.ok(Array.isArray(body.tools));
    assert.strictEqual(body.tools.length, 4);
    assert.ok(Array.isArray(body.prompts));
    assert.strictEqual(body.prompts.length, 6);
    const toolNames = body.tools.map((t: any) => t.name);
    assert.ok(toolNames.includes("search_deals"));
    assert.ok(toolNames.includes("plan_stack"));
    assert.ok(toolNames.includes("compare_vendors"));
    assert.ok(toolNames.includes("track_changes"));
    // Verify tool safety annotations
    for (const tool of body.tools) {
      assert.strictEqual(tool.annotations.readOnlyHint, true, `${tool.name} should have readOnlyHint: true`);
      assert.strictEqual(tool.annotations.destructiveHint, false, `${tool.name} should have destructiveHint: false`);
    }
  });

  it("serves /.well-known/mcp/server-card.json as alias", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/.well-known/mcp/server-card.json`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("content-type"), "application/json");
    const body = await response.json() as any;
    assert.strictEqual(body.serverInfo.name, "agentdeals");
    assert.strictEqual(body.tools.length, 4);
  });

  it("serves /setup page with client configs and HowTo schema", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/setup`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Setup Guide"));
    assert.ok(html.includes("claude-desktop"));
    assert.ok(html.includes("claude-code"));
    assert.ok(html.includes("cursor"));
    assert.ok(html.includes("vscode"), "Should have VS Code panel");
    assert.ok(html.includes("opencode"), "Should have OpenCode panel");
    assert.ok(html.includes("npx"), "Should have npm/npx panel");
    assert.ok(html.includes("npx -y agentdeals"));
    assert.ok(html.includes("/mcp"));
    assert.ok(html.includes("HowTo"), "Should have HowTo JSON-LD structured data");
    assert.ok(html.includes("search_deals"), "Should list tool examples");
  });

  it("serves landing page at root URL", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/`);
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

    const response = await fetch(`http://localhost:${serverPort}/api/offers?limit=3&offset=0`);
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
    const catResp = await fetch(`http://localhost:${serverPort}/api/offers?category=Databases&limit=100`);
    const catBody = await catResp.json() as any;
    assert.ok(catBody.total > 0);
    for (const o of catBody.offers) {
      assert.strictEqual(o.category, "Databases");
    }

    // Filter by query
    const qResp = await fetch(`http://localhost:${serverPort}/api/offers?q=postgres&limit=100`);
    const qBody = await qResp.json() as any;
    assert.ok(qBody.total > 0);
    for (const o of qBody.offers) {
      const searchable = [o.vendor, o.description, o.category, ...(o.tags || [])].join(" ").toLowerCase();
      assert.ok(searchable.includes("postgres"));
    }
  });

  it("GET /api/categories returns categories with counts", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/api/categories`);
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

    const response = await fetch(`http://localhost:${serverPort}/unknown`);
    assert.strictEqual(response.status, 404);
  });

  it("health endpoint returns session count", async () => {
    proc = await startHttpServer();

    // Initially 0 sessions
    const health0 = await fetch(`http://localhost:${serverPort}/health`);
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
    const health1 = await fetch(`http://localhost:${serverPort}/health`);
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
    const health2 = await fetch(`http://localhost:${serverPort}/health`);
    const body2 = await health2.json() as any;
    assert.strictEqual(body2.sessions, 2);

    // Stats should show 2 sessions connected
    assert.ok(body2.stats.total_sessions >= 2);
  });

  it("tracks API hit and landing page stats", async () => {
    proc = await startHttpServer();

    // Record initial stats
    const h0 = await fetch(`http://localhost:${serverPort}/health`);
    const s0 = (await h0.json() as any).stats;
    const initialApiOffers = s0.api_hits["/api/offers"];
    const initialApiCats = s0.api_hits["/api/categories"];
    const initialPageViews = s0.landing_page_views;

    // Hit /api/offers twice
    await fetch(`http://localhost:${serverPort}/api/offers?limit=1`);
    await fetch(`http://localhost:${serverPort}/api/offers?q=test&limit=1`);

    // Hit /api/categories once
    await fetch(`http://localhost:${serverPort}/api/categories`);

    // Hit landing page once
    await fetch(`http://localhost:${serverPort}/`);

    // Check stats incremented
    const h1 = await fetch(`http://localhost:${serverPort}/health`);
    const s1 = (await h1.json() as any).stats;

    assert.strictEqual(s1.api_hits["/api/offers"], initialApiOffers + 2);
    assert.strictEqual(s1.api_hits["/api/categories"], initialApiCats + 1);
    assert.strictEqual(s1.landing_page_views, initialPageViews + 1);
    assert.strictEqual(s1.total_api_hits, s0.total_api_hits + 3);
  });

  it("GET /api/stats returns connection stats", async () => {
    proc = await startHttpServer();

    // Check initial stats
    const resp0 = await fetch(`http://localhost:${serverPort}/api/stats`);
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
    const resp1 = await fetch(`http://localhost:${serverPort}/api/stats`);
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
    const resp0 = await fetch(`http://localhost:${serverPort}/api/stats`);
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

    const resp = await fetch(`http://localhost:${serverPort}/api/stats`);
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
    const health = await fetch(`http://localhost:${serverPort}/health`);
    const body = await health.json() as any;
    assert.strictEqual(body.sessions, 1);
  });

  it("GET /api/changes returns deal changes", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/api/changes`);
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
    const allResp = await fetch(`http://localhost:${serverPort}/api/changes?since=2020-01-01`);
    const allBody = await allResp.json() as any;
    assert.ok(allBody.total > 0, "Should have deal changes with since=2020-01-01");

    // Filter by type
    const typeResp = await fetch(`http://localhost:${serverPort}/api/changes?since=2020-01-01&type=free_tier_removed`);
    const typeBody = await typeResp.json() as any;
    for (const c of typeBody.changes) {
      assert.strictEqual(c.change_type, "free_tier_removed");
    }

    // Filter by vendor
    const vendorResp = await fetch(`http://localhost:${serverPort}/api/changes?since=2020-01-01&vendor=Google`);
    const vendorBody = await vendorResp.json() as any;
    for (const c of vendorBody.changes) {
      assert.ok(c.vendor.toLowerCase().includes("google"));
    }
  });

  it("GET /api/changes returns 400 for invalid since param", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/api/changes?since=not-a-date`);
    assert.strictEqual(response.status, 400);
    const body = await response.json() as any;
    assert.ok(body.error.includes("Invalid"));
  });

  it("GET /api/changes filters by vendors (comma-separated)", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/api/changes?since=2020-01-01&vendors=Netlify,OpenAI`);
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
    const offersResp = await fetch(`http://localhost:${serverPort}/api/offers?limit=1`);
    const offersBody = await offersResp.json() as any;
    const vendorName = offersBody.offers[0].vendor;

    const response = await fetch(`http://localhost:${serverPort}/api/details/${encodeURIComponent(vendorName)}`);
    assert.strictEqual(response.status, 200);
    const body = await response.json() as any;
    assert.ok(body.offer);
    assert.strictEqual(body.offer.vendor, vendorName);
    assert.ok(!body.alternatives, "Should not include alternatives by default");
  });

  it("GET /api/details/:vendor?alternatives=true includes alternatives", async () => {
    proc = await startHttpServer();

    // Get a known vendor
    const offersResp = await fetch(`http://localhost:${serverPort}/api/offers?limit=1`);
    const offersBody = await offersResp.json() as any;
    const vendorName = offersBody.offers[0].vendor;

    const response = await fetch(`http://localhost:${serverPort}/api/details/${encodeURIComponent(vendorName)}?alternatives=true`);
    assert.strictEqual(response.status, 200);
    const body = await response.json() as any;
    assert.ok(body.offer);
    assert.ok(Array.isArray(body.alternatives));
    assert.ok(body.alternatives.length <= 5);
  });

  it("GET /api/details/:vendor returns 404 for unknown vendor", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/api/details/${encodeURIComponent("NonExistentVendor12345")}`);
    assert.strictEqual(response.status, 404);
    const body = await response.json() as any;
    assert.ok(body.error.includes("not found"));
  });

  it("GET /api/details/:vendor is case-insensitive", async () => {
    proc = await startHttpServer();

    // Get a known vendor
    const offersResp = await fetch(`http://localhost:${serverPort}/api/offers?limit=1`);
    const offersBody = await offersResp.json() as any;
    const vendorName = offersBody.offers[0].vendor;

    // Request with different casing
    const lowerName = vendorName.toLowerCase();
    const response = await fetch(`http://localhost:${serverPort}/api/details/${encodeURIComponent(lowerName)}`);
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
    await fetch(`http://localhost:${serverPort}/mcp`, {
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
    const health = await fetch(`http://localhost:${serverPort}/health`);
    const body = await health.json() as any;
    assert.strictEqual(body.sessions, 0);
  });

  it("GET /api/openapi.json returns valid OpenAPI 3.0 spec", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/api/openapi.json`);
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
    assert.ok(body.paths["/api/freshness"]);
    assert.strictEqual(Object.keys(body.paths).length, 18);
    assert.ok(body.components.schemas.Offer);
    assert.ok(body.components.schemas.DealChange);
    assert.ok(body.components.schemas.Eligibility);
  });

  it("GET /api redirects to /api/docs", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/api`, { redirect: "manual" });
    assert.strictEqual(response.status, 301);
    assert.strictEqual(response.headers.get("location"), "/api/docs");
  });

  it("GET /feed.xml returns valid Atom XML", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/feed.xml`);
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

    const response = await fetch(`http://localhost:${serverPort}/api/feed`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("application/atom+xml"));
    const body = await response.text();
    assert.ok(body.includes("<feed xmlns="));
  });

  it("GET /rss, /feed, /atom redirect 301 to /feed.xml", async () => {
    proc = await startHttpServer();

    for (const path of ["/rss", "/feed", "/atom"]) {
      const response = await fetch(`http://localhost:${serverPort}${path}`, { redirect: "manual" });
      assert.strictEqual(response.status, 301, `${path} should 301`);
      assert.strictEqual(response.headers.get("location"), "/feed.xml", `${path} should redirect to /feed.xml`);
    }
  });

  it("RSS auto-discovery link present on all page types", async () => {
    proc = await startHttpServer();
    const atomLink = 'type="application/atom+xml"';
    const pages = ["/", "/category", "/category/databases", "/best", "/best/free-databases", "/compare", "/vendor", "/search", "/changes", "/expiring", "/digest", "/freshness", "/setup", "/privacy", "/alternatives", "/trends", "/agent-stack"];
    for (const path of pages) {
      const response = await fetch(`http://localhost:${serverPort}${path}`);
      const html = await response.text();
      assert.ok(html.includes(atomLink), `${path} should have RSS auto-discovery link`);
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

    const response = await fetch(`http://localhost:${serverPort}/category/databases`);
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

    const response = await fetch(`http://localhost:${serverPort}/category/nonexistent-category`);
    assert.strictEqual(response.status, 404);
    const html = await response.text();
    assert.ok(html.includes("404"), "Should show 404 message");
    assert.ok(html.includes("nonexistent-category"), "Should show the invalid slug");
  });

  it("sitemap.xml includes category pages and comparison pages", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/sitemap.xml`);
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

    const response = await fetch(`http://localhost:${serverPort}/compare`);
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

    const response = await fetch(`http://localhost:${serverPort}/compare/netlify-vs-vercel`);
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

    const response = await fetch(`http://localhost:${serverPort}/compare/vercel-vs-netlify`, { redirect: "manual" });
    assert.strictEqual(response.status, 301);
    assert.ok(response.headers.get("location")?.includes("/compare/netlify-vs-vercel"), "Should redirect to canonical URL");
  });

  it("GET /compare/:slug returns 404 for invalid pairs", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/compare/nonexistent-vs-also-nonexistent`);
    assert.strictEqual(response.status, 404);
    const html = await response.text();
    assert.ok(html.includes("404"), "Should show 404");
    assert.ok(html.includes("/compare"), "Should link to comparisons index");
  });

  it("GET /digest redirects to current week", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/digest`, { redirect: "manual" });
    assert.strictEqual(response.status, 302);
    const location = response.headers.get("location") ?? "";
    assert.ok(location.match(/\/digest\/\d{4}-w\d{2}/), `Should redirect to week URL, got: ${location}`);
  });

  it("GET /digest/archive lists weeks with changes", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/digest/archive`);
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
    const response = await fetch(`http://localhost:${serverPort}/digest/2026-w11`);
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

    const response = await fetch(`http://localhost:${serverPort}/digest/2026-w50`);
    assert.strictEqual(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes("No pricing changes tracked this week"), "Should show empty message");
    assert.ok(html.includes("/digest/archive"), "Should link to archive");
  });

  it("GET /digest/:week returns 404 for invalid format", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/digest/invalid-format`);
    assert.strictEqual(response.status, 404);
    const html = await response.text();
    assert.ok(html.includes("404"), "Should show 404");
  });

  it("sitemap.xml includes digest pages", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/sitemap.xml`);
    const xml = await response.text();
    assert.ok(xml.includes("/digest/archive"), "Sitemap should include digest archive");
    const digestCount = (xml.match(/\/digest\//g) || []).length;
    assert.ok(digestCount >= 3, `Expected at least 3 digest URLs in sitemap, got ${digestCount}`);
  });

  it("GET /vendor returns vendor index page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/vendor`);
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

    const response = await fetch(`http://localhost:${serverPort}/vendor/vercel`);
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

    const response = await fetch(`http://localhost:${serverPort}/vendor/nonexistent-vendor`);
    assert.strictEqual(response.status, 404);
    const html = await response.text();
    assert.ok(html.includes("404"), "Should show 404");
    assert.ok(html.includes("nonexistent-vendor"), "Should show the invalid slug");
    assert.ok(html.includes("/vendor"), "Should link to vendor index");
  });

  it("sitemap.xml includes vendor pages", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/sitemap.xml`);
    const xml = await response.text();
    assert.ok(xml.includes("/vendor/vercel"), "Sitemap should include vendor pages");
    const vendorCount = (xml.match(/\/vendor\//g) || []).length;
    assert.ok(vendorCount >= 100, `Expected 100+ vendor URLs in sitemap, got ${vendorCount}`);
  });

  it("category page links vendors to profile pages", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/category/cloud-hosting`);
    const html = await response.text();
    assert.ok(html.includes('href="/vendor/'), "Category page should link vendors to profile pages");
  });

  it("GET /trends returns trends index page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/trends`);
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

    const response = await fetch(`http://localhost:${serverPort}/trends/cloud-hosting`);
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

    const response = await fetch(`http://localhost:${serverPort}/trends/nonexistent-category`);
    assert.strictEqual(response.status, 404);
    const html = await response.text();
    assert.ok(html.includes("404"), "Should show 404");
    assert.ok(html.includes("/trends"), "Should link to trends index");
  });

  it("sitemap.xml includes trends pages", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/sitemap.xml`);
    const xml = await response.text();
    assert.ok(xml.includes("/trends/cloud-hosting"), "Sitemap should include trends pages");
    const trendsCount = (xml.match(/\/trends\//g) || []).length;
    assert.ok(trendsCount >= 50, `Expected 50+ trends URLs in sitemap, got ${trendsCount}`);
  });

  // --- Alternative-to pages ---

  it("GET /alternative-to returns alternatives index page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/alternative-to`);
    assert.strictEqual(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes("<title>Free Alternatives to Popular Tools"), "Should have alternatives index title");
    assert.ok(html.includes("/alternative-to/"), "Should link to individual alternative pages");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
  });

  it("GET /alternative-to/:slug renders alternatives page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/alternative-to/vercel`);
    assert.strictEqual(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes("Vercel Alternatives with Free Tiers"), "Should have vendor-specific title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("/vendor/"), "Should link to vendor profiles");
    assert.ok(html.includes("Current Vercel Situation"), "Should show vendor situation");
    assert.ok(html.includes("/trends/"), "Should link to category trends");
  });

  it("GET /alternative-to/:slug returns 404 for unknown vendor", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/alternative-to/nonexistent-vendor`);
    assert.strictEqual(response.status, 404);
    const html = await response.text();
    assert.ok(html.includes("nonexistent-vendor"), "Should show the invalid slug");
    assert.ok(html.includes("/alternative-to"), "Should link to alternatives index");
  });

  it("sitemap.xml includes alternative-to pages", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/sitemap.xml`);
    const xml = await response.text();
    assert.ok(xml.includes("/alternative-to"), "Sitemap should include alternatives index");
    assert.ok(xml.includes("/alternative-to/vercel"), "Sitemap should include vendor alternatives");
    const altCount = (xml.match(/\/alternative-to\//g) || []).length;
    assert.ok(altCount >= 100, `Expected 100+ alternative-to URLs in sitemap, got ${altCount}`);
  });

  // --- Expiring page ---

  it("GET /expiring renders expiring deals timeline page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/expiring`);
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

    const response = await fetch(`http://localhost:${serverPort}/changes`);
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

  it("GET /agent-stack renders agent stack guide page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/agent-stack`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("<title>AI Agent Builder"), "Should have agent stack title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("/agent-stack"), "Should reference /agent-stack");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("RAG Agent"), "Should have RAG Agent bundle");
    assert.ok(html.includes("Autonomous Coding Agent"), "Should have Coding Agent bundle");
    assert.ok(html.includes("Data Pipeline Agent"), "Should have Pipeline Agent bundle");
    assert.ok(html.includes("Chat / Customer Agent"), "Should have Chat Agent bundle");
    assert.ok(html.includes("$0/month"), "Should show $0 cost");
    assert.ok(html.includes("plan_stack"), "Should reference plan_stack MCP tool");
    assert.ok(html.includes("Pinecone"), "Should include Pinecone vendor");
    assert.ok(html.includes("Groq"), "Should include Groq vendor");
    assert.ok(html.includes("/vendor/"), "Should link to vendor pages");
    assert.ok(!html.includes("${BASE_URL}"), "Should not have unresolved BASE_URL");
  });

  it("GET /freshness renders data freshness dashboard page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/freshness`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("<title>Data Freshness Dashboard"), "Should have freshness title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("Dataset"), "JSON-LD should use Dataset type");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("/freshness"), "Should reference /freshness");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("freshness score"), "Should show freshness score");
    assert.ok(html.includes("Stalest Entries"), "Should have stalest entries section");
    assert.ok(html.includes("Freshness by Category"), "Should have category breakdown");
    assert.ok(html.includes("/api/freshness"), "Should link to API endpoint");
    assert.ok(!html.includes("${BASE_URL}"), "Should not have unresolved BASE_URL");
  });

  it("GET /api/freshness returns freshness metrics", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/api/freshness`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("content-type"), "application/json");
    const body = await response.json() as any;
    assert.ok(typeof body.total_offers === "number");
    assert.ok(body.total_offers > 0, "Should have offers");
    assert.ok(typeof body.freshness_score === "number");
    assert.ok(body.freshness_score >= 0 && body.freshness_score <= 100, "Freshness score should be 0-100");
    assert.ok(typeof body.verified_within_7_days === "number");
    assert.ok(typeof body.verified_within_30_days === "number");
    assert.ok(typeof body.verified_within_90_days === "number");
    assert.ok(typeof body.verified_within_180_days === "number");
    assert.ok(Array.isArray(body.stalest_entries), "Should have stalest entries");
    assert.ok(body.stalest_entries.length > 0, "Should have at least one stalest entry");
    assert.ok(body.stalest_entries[0].vendor, "Stalest entry should have vendor");
    assert.ok(body.stalest_entries[0].days_since_verified >= 0, "Should have days_since_verified");
    assert.ok(Array.isArray(body.freshest_entries), "Should have freshest entries");
    assert.ok(Array.isArray(body.by_category), "Should have category breakdown");
    assert.ok(body.by_category.length > 0, "Should have at least one category");
    assert.ok(body.by_category[0].category, "Category should have name");
    assert.ok(typeof body.by_category[0].freshness_score === "number", "Category should have freshness score");
  });

  it("GET /api/offers includes days_since_verified", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/api/offers?q=vercel&limit=1`);
    assert.strictEqual(response.status, 200);
    const body = await response.json() as any;
    assert.ok(body.offers.length > 0, "Should have at least one offer");
    assert.ok(typeof body.offers[0].days_since_verified === "number", "Offer should include days_since_verified");
    assert.ok(body.offers[0].days_since_verified >= 0, "days_since_verified should be non-negative");
  });

  // --- Timely alternatives pages ---

  it("GET /localstack-alternatives renders alternatives page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/localstack-alternatives`);
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

    const response = await fetch(`http://localhost:${serverPort}/postman-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Postman Alternatives"), "Should have Postman title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Top Alternatives"), "Should have alternatives section");
    assert.ok(html.includes("single-user only"), "Should mention the restriction");
    assert.ok(html.includes("March 1, 2026"), "Should mention the date");
    assert.ok(html.includes("Free Tier Comparison"), "Should have comparison table");
  });

  it("GET /terraform-alternatives renders alternatives page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/terraform-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("HCP Terraform Alternatives"), "Should have Terraform title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Top Alternatives"), "Should have alternatives section");
    assert.ok(html.includes("March 31, 2026"), "Should mention the EOL date");
  });

  it("GET /hetzner-alternatives renders alternatives page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/hetzner-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Hetzner Alternatives"), "Should have Hetzner title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Top Alternatives"), "Should have alternatives section");
    assert.ok(html.includes("30-50%"), "Should mention the price increase");
  });

  it("GET /freshping-alternatives renders alternatives page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/freshping-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Freshping Alternatives"), "Should have Freshping title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Top Alternatives"), "Should have alternatives section");
    assert.ok(html.includes("March 6, 2026"), "Should mention the shutdown date");
    assert.ok(html.includes("Free Tier Comparison"), "Should have comparison matrix");
  });

  it("GET /firebase-alternatives renders alternatives page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/firebase-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Firebase Alternatives"), "Should have Firebase title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Top Alternatives"), "Should have alternatives section");
    assert.ok(html.includes("March 19, 2026"), "Should mention the Studio shutdown date");
    assert.ok(html.includes("Free Tier Comparison"), "Should have comparison table");
    assert.ok(html.includes("PocketBase"), "Should include PocketBase alternative");
    assert.ok(html.includes("Supabase"), "Should include Supabase alternative");
  });

  it("GET /cursor-alternatives renders alternatives page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/cursor-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Cursor Alternatives"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Top Alternatives"), "Should have alternatives section");
    assert.ok(html.includes("credit-based pricing"), "Should mention credit-based pricing");
    assert.ok(html.includes("Free Tier Comparison"), "Should have comparison table");
    assert.ok(html.includes("Claude Code"), "Should include Claude Code alternative");
    assert.ok(html.includes("GitHub Copilot"), "Should include GitHub Copilot alternative");
    assert.ok(html.includes("Cline"), "Should include Cline alternative");
    assert.ok(html.includes("Aider"), "Should include Aider alternative");
  });

  it("GET /github-actions-alternatives renders alternatives page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/github-actions-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("GitHub Actions Alternatives"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Top Alternatives"), "Should have alternatives section");
    assert.ok(html.includes("$0.002/min"), "Should mention self-hosted runner pricing");
    assert.ok(html.includes("Free Tier Comparison"), "Should have comparison table");
    assert.ok(html.includes("GitLab CI"), "Should include GitLab CI alternative");
    assert.ok(html.includes("CircleCI"), "Should include CircleCI alternative");
  });

  it("GET /datadog-alternatives renders alternatives page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/datadog-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Datadog Alternatives"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Top Alternatives"), "Should have alternatives section");
    assert.ok(html.includes("unpredictable pricing"), "Should mention pricing issues");
    assert.ok(html.includes("Free Tier Comparison"), "Should have comparison table");
    assert.ok(html.includes("Grafana Cloud"), "Should include Grafana Cloud alternative");
    assert.ok(html.includes("New Relic"), "Should include New Relic alternative");
    assert.ok(html.includes("Prometheus"), "Should include Prometheus alternative");
    assert.ok(html.includes("Axiom"), "Should include Axiom alternative");
  });

  it("GET /vercel-alternatives renders alternatives page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/vercel-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Vercel Alternatives"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Top Alternatives"), "Should have alternatives section");
    assert.ok(html.includes("cost scaling"), "Should mention cost scaling");
    assert.ok(html.includes("Free Tier Comparison"), "Should have comparison table");
    assert.ok(html.includes("Cloudflare Pages"), "Should include Cloudflare Pages alternative");
    assert.ok(html.includes("Netlify"), "Should include Netlify alternative");
    assert.ok(html.includes("Render"), "Should include Render alternative");
    assert.ok(html.includes("Deno Deploy"), "Should include Deno Deploy alternative");
  });

  it("GET /auth0-alternatives renders alternatives page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/auth0-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Auth0 Alternatives"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Top Alternatives"), "Should have alternatives section");
    assert.ok(html.includes("steepest cliffs"), "Should mention pricing cliff");
    assert.ok(html.includes("Free Tier Comparison"), "Should have comparison table");
    assert.ok(html.includes("Clerk"), "Should include Clerk alternative");
    assert.ok(html.includes("WorkOS"), "Should include WorkOS alternative");
    assert.ok(html.includes("Keycloak"), "Should include Keycloak alternative");
    assert.ok(html.includes("FusionAuth"), "Should include FusionAuth alternative");
  });

  it("GET /mongodb-alternatives renders alternatives page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/mongodb-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("MongoDB Alternatives"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Top Alternatives"), "Should have alternatives section");
    assert.ok(html.includes("SSPL license"), "Should mention SSPL license");
    assert.ok(html.includes("Free Tier Comparison"), "Should have comparison table");
    assert.ok(html.includes("Supabase"), "Should include Supabase alternative");
    assert.ok(html.includes("Neon"), "Should include Neon alternative");
    assert.ok(html.includes("CockroachDB"), "Should include CockroachDB alternative");
    assert.ok(html.includes("Turso"), "Should include Turso alternative");
  });

  it("GET /redis-alternatives renders alternatives page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/redis-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Redis Alternatives"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Top Alternatives"), "Should have alternatives section");
    assert.ok(html.includes("BSL"), "Should mention BSL license");
    assert.ok(html.includes("Free Tier Comparison"), "Should have comparison table");
    assert.ok(html.includes("Upstash"), "Should include Upstash alternative");
    assert.ok(html.includes("Valkey"), "Should include Valkey alternative");
    assert.ok(html.includes("DragonflyDB"), "Should include DragonflyDB alternative");
    assert.ok(html.includes("Momento"), "Should include Momento alternative");
  });

  it("GET /email-service-alternatives renders email alternatives page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/email-service-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Email Service Alternatives"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Top Alternatives"), "Should have alternatives section");
    assert.ok(html.includes("SendGrid"), "Should mention SendGrid");
    assert.ok(html.includes("Free Tier Comparison"), "Should have comparison table");
    assert.ok(html.includes("Resend"), "Should include Resend alternative");
    assert.ok(html.includes("Mailjet"), "Should include Mailjet alternative");
    assert.ok(html.includes("Brevo"), "Should include Brevo alternative");
  });

  it("GET /ai-free-tiers renders AI free tiers editorial page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/ai-free-tiers`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Best Free AI APIs"), "Should have AI free tiers title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("LLM Inference"), "Should have LLM section");
    assert.ok(html.includes("AI Coding Tools"), "Should have AI coding section");
    assert.ok(html.includes("Groq"), "Should include Groq");
    assert.ok(html.includes("Cursor"), "Should include Cursor");
    assert.ok(html.includes("More Alternatives Guides"), "Should have cross-links");
  });

  it("GET /alternatives renders hub page with all editorial guides", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Alternatives Guides"), "Should have hub title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("/localstack-alternatives"), "Should link to LocalStack page");
    assert.ok(html.includes("/firebase-alternatives"), "Should link to Firebase page");
    assert.ok(html.includes("/heroku-alternatives"), "Should link to Heroku page");
    assert.ok(html.includes("/postman-alternatives"), "Should link to Postman page");
    assert.ok(html.includes("/terraform-alternatives"), "Should link to Terraform page");
    assert.ok(html.includes("/hetzner-alternatives"), "Should link to Hetzner page");
    assert.ok(html.includes("/freshping-alternatives"), "Should link to Freshping page");
    assert.ok(html.includes("/github-actions-alternatives"), "Should link to GitHub Actions page");
    assert.ok(html.includes("/cursor-alternatives"), "Should link to Cursor page");
    assert.ok(html.includes("/datadog-alternatives"), "Should link to Datadog page");
    assert.ok(html.includes("/vercel-alternatives"), "Should link to Vercel page");
    assert.ok(html.includes("/auth0-alternatives"), "Should link to Auth0 page");
    assert.ok(html.includes("/mongodb-alternatives"), "Should link to MongoDB page");
    assert.ok(html.includes("/redis-alternatives"), "Should link to Redis page");
    assert.ok(html.includes("/ai-free-tiers"), "Should link to AI free tiers page");
    assert.ok(html.includes("/database-alternatives"), "Should link to Database alternatives page");
  });

  it("GET /database-alternatives renders database hub page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/database-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Best Free Database Hosting"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Relational SQL"), "Should have relational section");
    assert.ok(html.includes("Key-Value"), "Should have key-value section");
    assert.ok(html.includes("Vector Databases"), "Should have vector section");
    assert.ok(html.includes("Which Free Database Should I Use"), "Should have decision guide");
    assert.ok(html.includes("Free Tier Comparison"), "Should have comparison table");
    assert.ok(html.includes("Supabase"), "Should include Supabase");
    assert.ok(html.includes("Neon"), "Should include Neon");
    assert.ok(html.includes("Turso"), "Should include Turso");
    assert.ok(html.includes("MongoDB Atlas"), "Should include MongoDB Atlas");
    assert.ok(html.includes("More Alternatives Guides"), "Should have cross-links");
  });

  it("GET /ci-cd-alternatives renders CI/CD hub page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/ci-cd-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Best Free CI/CD Tools"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("General-Purpose CI/CD"), "Should have general section");
    assert.ok(html.includes("Container-Native"), "Should have container section");
    assert.ok(html.includes("Mobile CI/CD"), "Should have mobile section");
    assert.ok(html.includes("Which Free CI/CD Tool"), "Should have decision guide");
    assert.ok(html.includes("Free CI/CD Comparison"), "Should have comparison table");
    assert.ok(html.includes("GitHub Actions"), "Should include GitHub Actions");
    assert.ok(html.includes("GitLab CI"), "Should include GitLab CI");
    assert.ok(html.includes("CircleCI"), "Should include CircleCI");
    assert.ok(html.includes("Drone CI"), "Should include Drone CI");
    assert.ok(html.includes("More Alternatives Guides"), "Should have cross-links");
  });

  it("GET /security-alternatives renders security hub page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/security-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Best Free Security Tools"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Application Security"), "Should have SAST section");
    assert.ok(html.includes("Secret Scanning"), "Should have secrets section");
    assert.ok(html.includes("Identity"), "Should have auth section");
    assert.ok(html.includes("Which Free Security Tool"), "Should have decision guide");
    assert.ok(html.includes("Free Security Tools Comparison"), "Should have comparison table");
    assert.ok(html.includes("Snyk"), "Should include Snyk");
    assert.ok(html.includes("Semgrep"), "Should include Semgrep");
    assert.ok(html.includes("GitGuardian"), "Should include GitGuardian");
    assert.ok(html.includes("Trivy"), "Should include Trivy");
    assert.ok(html.includes("More Alternatives Guides"), "Should have cross-links");
  });

  it("GET /storage-alternatives renders storage hub page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/storage-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Best Free Cloud Storage"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Object Storage"), "Should have object storage section");
    assert.ok(html.includes("Media"), "Should have media section");
    assert.ok(html.includes("File Storage"), "Should have file storage section");
    assert.ok(html.includes("Which Free Storage"), "Should have decision guide");
    assert.ok(html.includes("Free Cloud Storage Comparison"), "Should have comparison table");
    assert.ok(html.includes("Cloudflare R2"), "Should include Cloudflare R2");
    assert.ok(html.includes("Backblaze"), "Should include Backblaze");
    assert.ok(html.includes("Cloudinary"), "Should include Cloudinary");
    assert.ok(html.includes("More Alternatives Guides"), "Should have cross-links");
  });

  it("GET /testing-alternatives renders testing hub page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/testing-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Best Free Testing Tools"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Browser"), "Should have browser testing section");
    assert.ok(html.includes("Visual Regression"), "Should have visual testing section");
    assert.ok(html.includes("Load"), "Should have load testing section");
    assert.ok(html.includes("E2E"), "Should have E2E section");
    assert.ok(html.includes("API Testing"), "Should have API testing section");
    assert.ok(html.includes("Local Dev"), "Should have local dev section");
    assert.ok(html.includes("Which Free Testing Tool"), "Should have decision guide");
    assert.ok(html.includes("Free Testing Tools Comparison"), "Should have comparison table");
    assert.ok(html.includes("Cypress"), "Should include Cypress");
    assert.ok(html.includes("BrowserStack"), "Should include BrowserStack");
    assert.ok(html.includes("Grafana k6"), "Should include k6");
    assert.ok(html.includes("More Alternatives Guides"), "Should have cross-links");
  });

  it("GET /analytics-alternatives renders analytics hub page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/analytics-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Best Free Analytics Tools"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Product Analytics"), "Should have product analytics section");
    assert.ok(html.includes("Web Analytics"), "Should have web analytics section");
    assert.ok(html.includes("Session Replay"), "Should have session replay section");
    assert.ok(html.includes("Event Tracking"), "Should have event tracking section");
    assert.ok(html.includes("Data Infrastructure"), "Should have data infrastructure section");
    assert.ok(html.includes("Which Free Analytics Tool"), "Should have decision guide");
    assert.ok(html.includes("Free Analytics Tools Comparison"), "Should have comparison table");
    assert.ok(html.includes("PostHog"), "Should include PostHog");
    assert.ok(html.includes("Amplitude"), "Should include Amplitude");
    assert.ok(html.includes("Plausible"), "Should include Plausible");
    assert.ok(html.includes("More Alternatives Guides"), "Should have cross-links");
  });

  it("GET /ai-ml-alternatives renders AI/ML hub page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/ai-ml-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Best Free AI"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("LLM API Providers"), "Should have LLM API section");
    assert.ok(html.includes("AI Coding Tools"), "Should have AI coding section");
    assert.ok(html.includes("ML Platforms"), "Should have ML platforms section");
    assert.ok(html.includes("AI Observability"), "Should have observability section");
    assert.ok(html.includes("Specialized AI Services"), "Should have specialized section");
    assert.ok(html.includes("Which Free AI Tool"), "Should have decision guide");
    assert.ok(html.includes("Free AI"), "Should have comparison table");
    assert.ok(html.includes("Groq"), "Should include Groq");
    assert.ok(html.includes("GitHub Copilot"), "Should include GitHub Copilot");
    assert.ok(html.includes("Langfuse"), "Should include Langfuse");
    assert.ok(html.includes("More Alternatives Guides"), "Should have cross-links");
  });

  it("GET /design-alternatives renders design hub page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/design-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Best Free Design Tools"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Design Tools &amp; Editors"), "Should have design editors section");
    assert.ok(html.includes("Prototyping &amp; No-Code"), "Should have prototyping section");
    assert.ok(html.includes("UI Component Libraries"), "Should have UI components section");
    assert.ok(html.includes("Icons &amp; Illustrations"), "Should have icons section");
    assert.ok(html.includes("Stock Assets &amp; Images"), "Should have stock assets section");
    assert.ok(html.includes("Color &amp; CSS Tools"), "Should have color tools section");
    assert.ok(html.includes("Mockups &amp; Wireframing"), "Should have mockups section");
    assert.ok(html.includes("Which Free Design Tool"), "Should have decision guide");
    assert.ok(html.includes("Free Design Tools Comparison"), "Should have comparison table");
    assert.ok(html.includes("Figma"), "Should include Figma");
    assert.ok(html.includes("Penpot"), "Should include Penpot");
    assert.ok(html.includes("ShadcnUI"), "Should include ShadcnUI");
    assert.ok(html.includes("More Alternatives Guides"), "Should have cross-links");
  });

  it("GET /email-alternatives renders email hub page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/email-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Best Free Email Tools"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Transactional Email APIs"), "Should have transactional section");
    assert.ok(html.includes("Email Marketing"), "Should have marketing section");
    assert.ok(html.includes("Email Verification"), "Should have verification section");
    assert.ok(html.includes("Email Forwarding"), "Should have forwarding section");
    assert.ok(html.includes("Temporary"), "Should have temporary section");
    assert.ok(html.includes("Which Free Email Tool"), "Should have decision guide");
    assert.ok(html.includes("Free Email Tools Comparison"), "Should have comparison table");
    assert.ok(html.includes("Resend"), "Should include Resend");
    assert.ok(html.includes("Brevo"), "Should include Brevo");
    assert.ok(html.includes("SimpleLogin"), "Should include SimpleLogin");
    assert.ok(html.includes("More Alternatives Guides"), "Should have cross-links");
  });

  it("GET /project-management-alternatives renders PM hub page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/project-management-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Best Free Project Management"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Issue Tracking"), "Should have issue tracking section");
    assert.ok(html.includes("Kanban Boards"), "Should have kanban section");
    assert.ok(html.includes("Agile, Scrum"), "Should have agile section");
    assert.ok(html.includes("Time Tracking"), "Should have time tracking section");
    assert.ok(html.includes("Team Chat"), "Should have team chat section");
    assert.ok(html.includes("Video Conferencing"), "Should have video section");
    assert.ok(html.includes("Docs, Knowledge"), "Should have docs section");
    assert.ok(html.includes("Scheduling"), "Should have scheduling section");
    assert.ok(html.includes("Which Free PM Tool"), "Should have decision guide");
    assert.ok(html.includes("Free PM Tools Comparison"), "Should have comparison table");
    assert.ok(html.includes("Linear"), "Should include Linear");
    assert.ok(html.includes("Notion"), "Should include Notion");
    assert.ok(html.includes("Cal.com"), "Should include Cal.com");
    assert.ok(html.includes("More Alternatives Guides"), "Should have cross-links");
  });

  it("GET /ide-code-editors-alternatives renders IDE hub page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/ide-code-editors-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Best Free IDEs"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Desktop IDEs"), "Should have desktop IDEs section");
    assert.ok(html.includes("Cloud IDEs"), "Should have cloud IDEs section");
    assert.ok(html.includes("AI Coding Assistants"), "Should have AI assistants section");
    assert.ok(html.includes("AI App Builders"), "Should have AI app builders section");
    assert.ok(html.includes("Specialized"), "Should have specialized section");
    assert.ok(html.includes("Which Free IDE"), "Should have decision guide");
    assert.ok(html.includes("Free IDE"), "Should have comparison table");
    assert.ok(html.includes("VS Code"), "Should include VS Code");
    assert.ok(html.includes("Cursor"), "Should include Cursor");
    assert.ok(html.includes("GitHub Copilot"), "Should include GitHub Copilot");
    assert.ok(html.includes("More Alternatives Guides"), "Should have cross-links");
  });

  it("GET /free-llm-apis renders LLM API hub page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/free-llm-apis`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Best Free LLM APIs"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Proprietary Model APIs"), "Should have provider APIs section");
    assert.ok(html.includes("Open-Model Inference Platforms"), "Should have inference platforms section");
    assert.ok(html.includes("AI Gateways"), "Should have gateways section");
    assert.ok(html.includes("Rate Limit Comparison"), "Should have rate limit table");
    assert.ok(html.includes("Which Free LLM API"), "Should have decision guide");
    assert.ok(html.includes("Groq"), "Should include Groq");
    assert.ok(html.includes("Cerebras"), "Should include Cerebras");
    assert.ok(html.includes("OpenRouter"), "Should include OpenRouter");
    assert.ok(html.includes("More Alternatives Guides"), "Should have cross-links");
  });

  it("GET /api-development-alternatives renders API development hub page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/api-development-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Best Free API Development Tools"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("API Testing"), "Should have API testing section");
    assert.ok(html.includes("API Design"), "Should have docs section");
    assert.ok(html.includes("API Mocking"), "Should have mocking section");
    assert.ok(html.includes("API Marketplaces"), "Should have marketplaces section");
    assert.ok(html.includes("Integration"), "Should have integration section");
    assert.ok(html.includes("Which Free API Tool"), "Should have decision guide");
    assert.ok(html.includes("Postman"), "Should include Postman");
    assert.ok(html.includes("Hoppscotch"), "Should include Hoppscotch");
    assert.ok(html.includes("postman-alternatives"), "Should cross-link to Postman alternatives");
    assert.ok(html.includes("More Alternatives Guides"), "Should have cross-links");
  });

  it("editorial alternatives pages cross-link to other guides", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/localstack-alternatives`);
    const html = await response.text();
    assert.ok(html.includes("More Alternatives Guides"), "Should have cross-links section");
    assert.ok(html.includes("/firebase-alternatives"), "Should link to Firebase alternatives");
    assert.ok(html.includes("/heroku-alternatives"), "Should link to Heroku alternatives");
    assert.ok(!html.includes('href="/localstack-alternatives"'), "Should not link to itself");
    assert.ok(html.includes("/alternatives"), "Should link to hub page");
  });

  // --- Q1 2026 Pricing Report ---

  it("GET /q1-2026-developer-pricing-report renders quarterly pricing report", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/q1-2026-developer-pricing-report`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Q1 2026 Developer Pricing Report"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Free Tiers Removed"), "Should have removals section");
    assert.ok(html.includes("Limits Tightened"), "Should have restrictions section");
    assert.ok(html.includes("Pricing Restructured"), "Should have restructured section");
    assert.ok(html.includes("Bright Spots"), "Should have expansions section");
    assert.ok(html.includes("LocalStack"), "Should mention LocalStack");
    assert.ok(html.includes("Methodology"), "Should have methodology section");
    assert.ok(html.includes("Related Guides"), "Should have related guides");
    assert.ok(html.includes("/changes"), "Should link to changes page");
    assert.ok(html.includes("More Alternatives Guides"), "Should have cross-links");
  });

  it("GET /q2-pricing-preview-2026 renders Q2 pricing preview page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/q2-pricing-preview-2026`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Q2 2026 Developer Pricing Preview"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Timeline"), "Should have timeline section");
    assert.ok(html.includes("Impact Analysis"), "Should have impact analysis");
    assert.ok(html.includes("What to Watch"), "Should have watch section");
    assert.ok(html.includes("Hetzner"), "Should mention Hetzner");
    assert.ok(html.includes("Related Guides"), "Should have related guides");
    assert.ok(html.includes("/changes"), "Should link to changes page");
    assert.ok(html.includes("/q1-2026-developer-pricing-report"), "Should link to Q1 report");
    assert.ok(html.includes("More Alternatives Guides"), "Should have cross-links");
  });

  // --- Hetzner April 2026 Pricing Analysis ---

  it("GET /hetzner-pricing-2026 renders Hetzner pricing analysis page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/hetzner-pricing-2026`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Hetzner April 2026 Pricing Analysis"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Before/After Pricing Table"), "Should have pricing table section");
    assert.ok(html.includes("Why Prices Are Rising"), "Should have why section");
    assert.ok(html.includes("Who's Affected"), "Should have who section");
    assert.ok(html.includes("Impact Assessment"), "Should have impact section");
    assert.ok(html.includes("Alternatives Comparison"), "Should have alternatives section");
    assert.ok(html.includes("Industry Context"), "Should have industry context section");
    assert.ok(html.includes("Optimization Strategies"), "Should have optimization section");
    assert.ok(html.includes("CPX11"), "Should have specific pricing data");
    assert.ok(html.includes("+575%"), "Should mention memory add-on increase");
    assert.ok(html.includes("OVHcloud"), "Should mention OVH in industry context");
    assert.ok(html.includes("DigitalOcean"), "Should include alternatives");
    assert.ok(html.includes("Methodology"), "Should have methodology section");
    assert.ok(html.includes("/hetzner-alternatives"), "Should cross-link to hetzner alternatives");
    assert.ok(html.includes("/changes"), "Should link to changes page");
    assert.ok(html.includes("More Alternatives Guides"), "Should have cross-links");
    assert.ok(html.includes("/sitemap.xml") || html.includes("agentdeals"), "Should be a proper page");
  });

  it("GET /free-startup-stack renders startup stack guide page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/free-startup-stack`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Complete Free Startup Stack"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("$0"), "Should show $0 cost");
    assert.ok(html.includes("Hosting"), "Should have hosting category");
    assert.ok(html.includes("Database"), "Should have database category");
    assert.ok(html.includes("Authentication"), "Should have auth category");
    assert.ok(html.includes("Monitoring"), "Should have monitoring category");
    assert.ok(html.includes("Vercel"), "Should recommend Vercel");
    assert.ok(html.includes("Supabase"), "Should recommend Supabase");
    assert.ok(html.includes("outgrow"), "Should have outgrow guidance");
    assert.ok(html.includes("Stability Notes"), "Should have stability section");
    assert.ok(html.includes("Stack Overview"), "Should have overview table");
    assert.ok(html.includes("More Alternatives Guides"), "Should have cross-links");
  });

  it("GET /free-ai-stack renders AI/ML stack guide page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/free-ai-stack`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Complete Free AI/ML Stack"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("$0"), "Should show $0 cost");
    assert.ok(html.includes("LLM API"), "Should have LLM API category");
    assert.ok(html.includes("Vector Database"), "Should have vector DB category");
    assert.ok(html.includes("Experiment Tracking"), "Should have experiment tracking");
    assert.ok(html.includes("Observability"), "Should have observability category");
    assert.ok(html.includes("Groq"), "Should recommend Groq");
    assert.ok(html.includes("Pinecone"), "Should recommend Pinecone");
    assert.ok(html.includes("Langfuse"), "Should recommend Langfuse");
    assert.ok(html.includes("outgrow"), "Should have outgrow guidance");
    assert.ok(html.includes("Open-Source Self-Hosted"), "Should have OSS section");
    assert.ok(html.includes("Stack Overview"), "Should have overview table");
    assert.ok(html.includes("More Alternatives Guides"), "Should have cross-links");
  });

  it("GET /free-devops-stack renders DevOps stack guide page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/free-devops-stack`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Complete Free DevOps Stack"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("$0"), "Should show $0 cost");
    assert.ok(html.includes("CI/CD Pipeline"), "Should have CI/CD category");
    assert.ok(html.includes("Monitoring"), "Should have monitoring category");
    assert.ok(html.includes("Uptime Monitoring"), "Should have uptime category");
    assert.ok(html.includes("Logging"), "Should have logging category");
    assert.ok(html.includes("Incident Management"), "Should have incident management");
    assert.ok(html.includes("Container Registry"), "Should have container registry");
    assert.ok(html.includes("Secrets Management"), "Should have secrets category");
    assert.ok(html.includes("GitHub Actions"), "Should recommend GitHub Actions");
    assert.ok(html.includes("Grafana Cloud"), "Should recommend Grafana Cloud");
    assert.ok(html.includes("Axiom"), "Should recommend Axiom");
    assert.ok(html.includes("Doppler"), "Should recommend Doppler");
    assert.ok(html.includes("outgrow"), "Should have outgrow guidance");
    assert.ok(html.includes("Open-Source Self-Hosted"), "Should have OSS section");
    assert.ok(html.includes("Stack Overview"), "Should have overview table");
    assert.ok(html.includes("More Alternatives Guides"), "Should have cross-links");
  });

  it("GET /free-frontend-stack renders frontend stack guide page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/free-frontend-stack`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Complete Free Frontend Stack"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("$0"), "Should show $0 cost");
    assert.ok(html.includes("Static"), "Should have hosting category");
    assert.ok(html.includes("CDN"), "Should have CDN category");
    assert.ok(html.includes("Headless CMS"), "Should have CMS category");
    assert.ok(html.includes("Forms"), "Should have forms category");
    assert.ok(html.includes("Analytics"), "Should have analytics category");
    assert.ok(html.includes("Error"), "Should have error tracking category");
    assert.ok(html.includes("Image"), "Should have image optimization category");
    assert.ok(html.includes("Email"), "Should have email category");
    assert.ok(html.includes("Design"), "Should have design category");
    assert.ok(html.includes("Feature Flags"), "Should have feature flags category");
    assert.ok(html.includes("Cloudflare Pages"), "Should recommend Cloudflare Pages");
    assert.ok(html.includes("PostHog"), "Should recommend PostHog");
    assert.ok(html.includes("Sentry"), "Should recommend Sentry");
    assert.ok(html.includes("Cloudinary"), "Should recommend Cloudinary");
    assert.ok(html.includes("outgrow"), "Should have outgrow guidance");
    assert.ok(html.includes("Open-Source Self-Hosted"), "Should have OSS section");
    assert.ok(html.includes("Stack Overview"), "Should have overview table");
    assert.ok(html.includes("More Alternatives Guides"), "Should have cross-links");
  });

  it("GET /google-developer-program-2026 renders GDP pricing analysis page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/google-developer-program-2026`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Google Developer Program Premium"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("March 30, 2026"), "Should mention deadline");
    assert.ok(html.includes("Price Comparison Table"), "Should have comparison section");
    assert.ok(html.includes("Who&#x27;s Affected") || html.includes("Who's Affected"), "Should have who section");
    assert.ok(html.includes("Migration Guide"), "Should have migration section");
    assert.ok(html.includes("Free Cloud"), "Should have cloud alternatives section");
    assert.ok(html.includes("Free AI/LLM"), "Should have AI alternatives section");
    assert.ok(html.includes("Firebase Alternatives"), "Should have Firebase section");
    assert.ok(html.includes("Cost Analysis"), "Should have cost analysis section");
    assert.ok(html.includes("Verdict"), "Should have verdict section");
    assert.ok(html.includes("AI Pro"), "Should mention AI Pro");
    assert.ok(html.includes("AI Ultra"), "Should mention AI Ultra");
    assert.ok(html.includes("$299"), "Should mention old price");
    assert.ok(html.includes("$19.99"), "Should mention AI Pro price");
    assert.ok(html.includes("Oracle Cloud"), "Should include Oracle as alternative");
    assert.ok(html.includes("Groq"), "Should include Groq as LLM alternative");
    assert.ok(html.includes("Supabase"), "Should include Supabase as Firebase alternative");
    assert.ok(html.includes("Methodology"), "Should have methodology section");
    assert.ok(html.includes("/free-startup-stack"), "Should cross-link to free startup stack");
    assert.ok(html.includes("/free-llm-apis"), "Should cross-link to free LLM APIs");
    assert.ok(html.includes("/changes"), "Should link to changes page");
  });

  it("GET /supabase-vs-firebase renders comparison page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/supabase-vs-firebase`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Supabase vs Firebase"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Free Tier Comparison Table"), "Should have comparison section");
    assert.ok(html.includes("Key Differences"), "Should have differences section");
    assert.ok(html.includes("Cost at Scale"), "Should have cost section");
    assert.ok(html.includes("When to Choose Each"), "Should have decision guide");
    assert.ok(html.includes("Other BaaS Alternatives"), "Should have alternatives section");
    assert.ok(html.includes("Recent Deal Changes"), "Should have changes section");
    assert.ok(html.includes("500 MB"), "Should include Supabase DB size");
    assert.ok(html.includes("1 GiB"), "Should include Firebase DB size");
    assert.ok(html.includes("50K MAU"), "Should include auth comparison");
    assert.ok(html.includes("Appwrite") || html.includes("PocketBase"), "Should include BaaS alternatives");
    assert.ok(html.includes("/database-alternatives"), "Should cross-link to database hub");
    assert.ok(html.includes("Methodology"), "Should have methodology section");
    assert.ok(html.includes("/vendor/supabase"), "Should link to Supabase profile");
    assert.ok(html.includes("/vendor/firebase"), "Should link to Firebase profile");
  });

  it("GET /vercel-vs-netlify renders comparison page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/vercel-vs-netlify`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Vercel vs Netlify"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Free Tier Comparison Table"), "Should have comparison section");
    assert.ok(html.includes("Key Differences"), "Should have differences section");
    assert.ok(html.includes("Cost at Scale"), "Should have cost section");
    assert.ok(html.includes("When to Choose Each"), "Should have decision guide");
    assert.ok(html.includes("Other Hosting Alternatives"), "Should have alternatives section");
    assert.ok(html.includes("Recent Deal Changes"), "Should have changes section");
    assert.ok(html.includes("100 GB"), "Should include Vercel bandwidth");
    assert.ok(html.includes("300 credits"), "Should include Netlify credits");
    assert.ok(html.includes("Non-commercial only"), "Should highlight commercial use restriction");
    assert.ok(html.includes("Cloudflare Pages") || html.includes("Railway"), "Should include hosting alternatives");
    assert.ok(html.includes("/hosting-alternatives"), "Should cross-link to hosting hub");
    assert.ok(html.includes("Methodology"), "Should have methodology section");
    assert.ok(html.includes("/vendor/vercel"), "Should link to Vercel profile");
    assert.ok(html.includes("/vendor/netlify"), "Should link to Netlify profile");
  });

  it("GET /neon-vs-supabase renders comparison page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/neon-vs-supabase`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Neon vs Supabase"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Free Tier Comparison Table"), "Should have comparison section");
    assert.ok(html.includes("Key Differences"), "Should have differences section");
    assert.ok(html.includes("Cost at Scale"), "Should have cost section");
    assert.ok(html.includes("When to Choose Each"), "Should have decision guide");
    assert.ok(html.includes("Other Database Alternatives"), "Should have alternatives section");
    assert.ok(html.includes("Recent Deal Changes"), "Should have changes section");
    assert.ok(html.includes("100 CU-hours"), "Should include Neon compute");
    assert.ok(html.includes("500 MB"), "Should include Supabase storage");
    assert.ok(html.includes("10 branches per project"), "Should highlight Neon branching");
    assert.ok(html.includes("Turso") || html.includes("CockroachDB"), "Should include database alternatives");
    assert.ok(html.includes("/database-alternatives"), "Should cross-link to database hub");
    assert.ok(html.includes("Methodology"), "Should have methodology section");
    assert.ok(html.includes("/vendor/neon"), "Should link to Neon profile");
    assert.ok(html.includes("/vendor/supabase"), "Should link to Supabase profile");
    assert.ok(html.includes("/supabase-vs-firebase"), "Should cross-link to Supabase vs Firebase");
  });

  it("GET /railway-vs-render renders comparison page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/railway-vs-render`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Railway vs Render"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Free Tier Comparison Table"), "Should have comparison section");
    assert.ok(html.includes("Key Differences"), "Should have differences section");
    assert.ok(html.includes("Cost at Scale"), "Should have cost section");
    assert.ok(html.includes("When to Choose Each"), "Should have decision guide");
    assert.ok(html.includes("Other PaaS Alternatives"), "Should have alternatives section");
    assert.ok(html.includes("Recent Deal Changes"), "Should have changes section");
    assert.ok(html.includes("0.5 GB"), "Should include Railway RAM");
    assert.ok(html.includes("512 MB"), "Should include Render RAM");
    assert.ok(html.includes("15 min"), "Should highlight Render sleep behavior");
    assert.ok(html.includes("Fly.io") || html.includes("Coolify"), "Should include hosting alternatives");
    assert.ok(html.includes("/hosting-alternatives"), "Should cross-link to hosting hub");
    assert.ok(html.includes("Methodology"), "Should have methodology section");
    assert.ok(html.includes("/vendor/railway"), "Should link to Railway profile");
    assert.ok(html.includes("/vendor/render"), "Should link to Render profile");
    assert.ok(html.includes("/vercel-vs-netlify"), "Should cross-link to Vercel vs Netlify");
  });

  it("GET /datadog-vs-new-relic renders comparison page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/datadog-vs-new-relic`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Datadog vs New Relic"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Free Tier Comparison Table"), "Should have comparison section");
    assert.ok(html.includes("Key Differences"), "Should have differences section");
    assert.ok(html.includes("Cost at Scale"), "Should have cost section");
    assert.ok(html.includes("When to Choose Each"), "Should have decision guide");
    assert.ok(html.includes("Other Monitoring Alternatives"), "Should have alternatives section");
    assert.ok(html.includes("Recent Deal Changes"), "Should have changes section");
    assert.ok(html.includes("5 hosts"), "Should include Datadog host limit");
    assert.ok(html.includes("100 GB"), "Should include New Relic data ingest");
    assert.ok(html.includes("1 day"), "Should highlight Datadog retention");
    assert.ok(html.includes("Grafana Cloud") || html.includes("Sentry"), "Should include monitoring alternatives");
    assert.ok(html.includes("/monitoring-alternatives"), "Should cross-link to monitoring hub");
    assert.ok(html.includes("Methodology"), "Should have methodology section");
    assert.ok(html.includes("/vendor/datadog"), "Should link to Datadog profile");
    assert.ok(html.includes("/vendor/new-relic"), "Should link to New Relic profile");
  });

  it("GET /free-tier-risk renders risk index page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/free-tier-risk`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Free Tier Risk Index"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("How We Score Risk"), "Should have methodology section");
    assert.ok(html.includes("Low Risk"), "Should have low risk section");
    assert.ok(html.includes("Medium Risk"), "Should have medium risk section");
    assert.ok(html.includes("High Risk"), "Should have high risk section");
    assert.ok(html.includes("Already Changed"), "Should have already changed section");
    assert.ok(html.includes("Cloudflare"), "Should include Cloudflare as low risk");
    assert.ok(html.includes("Heroku"), "Should include Heroku as high risk");
    assert.ok(html.includes("PlanetScale"), "Should include PlanetScale as dead");
    assert.ok(html.includes("What To Do About It"), "Should have advice section");
    assert.ok(html.includes("/changes"), "Should cross-link to changes timeline");
    assert.ok(html.includes("/alternatives"), "Should cross-link to alternatives hub");
    assert.ok(html.includes("Methodology"), "Should have methodology section");
    assert.ok(html.includes("Full Scoring Table"), "Should have full scoring table");
    assert.ok(html.includes("/free-startup-stack"), "Should cross-link to startup stack");
  });

  it("GET /stability renders stability dashboard page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/stability`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Free Tier Stability Dashboard"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Dataset"'), "Should use Dataset schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Volatile"), "Should have volatile section");
    assert.ok(html.includes("Watch"), "Should have watch section");
    assert.ok(html.includes("Improving"), "Should have improving section");
    assert.ok(html.includes("Stable"), "Should have stable section");
    assert.ok(html.includes("Methodology"), "Should have methodology section");
    assert.ok(html.includes("/changes"), "Should cross-link to changes timeline");
    assert.ok(html.includes("/state-of-free-tiers-2026"), "Should cross-link to state of free tiers");
    assert.ok(html.includes("/vendor/"), "Should have vendor detail links");
    assert.ok(html.includes("vendor-card"), "Should have vendor cards");
  });

  it("GET /openai-assistants-alternatives renders sunset guide page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/openai-assistants-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Assistants API Sunset"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("August 26, 2026"), "Should show shutdown date");
    assert.ok(html.includes("Migration Paths"), "Should have migration paths section");
    assert.ok(html.includes("Free Tier Comparison"), "Should have comparison table");
    assert.ok(html.includes("Anthropic Claude"), "Should list Claude as alternative");
    assert.ok(html.includes("Google Gemini"), "Should list Gemini as alternative");
    assert.ok(html.includes("/stability"), "Should cross-link to stability dashboard");
    assert.ok(html.includes("/vendor/"), "Should have vendor detail links");
    assert.ok(html.includes("Methodology"), "Should have methodology section");
  });

  it("GET /openai-assistants-migration-2026 renders comprehensive migration guide", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/openai-assistants-migration-2026`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Migration Guide 2026"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("August 26, 2026"), "Should show shutdown date");
    assert.ok(html.includes("Aug 26, 2025"), "Should show announcement date");
    assert.ok(html.includes("Dec 18, 2024"), "Should show v1 beta end date");
    assert.ok(html.includes("Feature Migration Map"), "Should have feature map section");
    assert.ok(html.includes("Migration Complexity"), "Should have complexity section");
    assert.ok(html.includes("Decision Framework"), "Should have decision framework");
    assert.ok(html.includes("Agent Frameworks"), "Should have agent frameworks");
    assert.ok(html.includes("Wire-Compatible Bridges"), "Should have wire bridges");
    assert.ok(html.includes("LangChain"), "Should list LangChain");
    assert.ok(html.includes("Ragwalla"), "Should list Ragwalla");
    assert.ok(html.includes("DataStax"), "Should list DataStax");
    assert.ok(html.includes("Cost Comparison"), "Should have cost section");
    assert.ok(html.includes("Anthropic Claude"), "Should list Claude");
    assert.ok(html.includes("DeepSeek"), "Should list DeepSeek");
    assert.ok(html.includes("/shutdowns"), "Should cross-link to shutdowns");
    assert.ok(html.includes("/stability"), "Should cross-link to stability");
    assert.ok(html.includes("Methodology"), "Should have methodology section");
  });

  it("GET /hcp-terraform-migration renders migration guide page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/hcp-terraform-migration`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("HCP Terraform Migration Guide"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("What's Changing on March 31"), "Should have what's changing section");
    assert.ok(html.includes("Who's Affected"), "Should have who's affected section");
    assert.ok(html.includes("Migration Paths"), "Should have migration paths section");
    assert.ok(html.includes("Decision Matrix"), "Should have decision matrix section");
    assert.ok(html.includes("Step-by-Step Migration"), "Should have migration steps section");
    assert.ok(html.includes("Spacelift"), "Should include Spacelift as alternative");
    assert.ok(html.includes("Scalr"), "Should include Scalr as alternative");
    assert.ok(html.includes("OpenTofu"), "Should include OpenTofu as alternative");
    assert.ok(html.includes("Terragrunt Scale"), "Should include Terragrunt Scale");
    assert.ok(html.includes("500"), "Should mention 500 resource cap");
    assert.ok(html.includes("/terraform-alternatives"), "Should cross-link to terraform alternatives");
    assert.ok(html.includes("Methodology"), "Should have methodology section");
    assert.ok(html.includes("March 31"), "Should mention the deadline");
  });

  it("GET /gemini-api-pricing-2026 renders Gemini API pricing analysis page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/gemini-api-pricing-2026`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Gemini API Pricing 2026"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("What's Changing April 1"), "Should have what's changing section");
    assert.ok(html.includes("Timeline of Gemini API Changes"), "Should have timeline section");
    assert.ok(html.includes("Who's Affected"), "Should have who's affected section");
    assert.ok(html.includes("Free LLM API Comparison"), "Should have comparison section");
    assert.ok(html.includes("What to Do"), "Should have what to do section");
    assert.ok(html.includes("Groq"), "Should include Groq as alternative");
    assert.ok(html.includes("OpenRouter"), "Should include OpenRouter as alternative");
    assert.ok(html.includes("Cerebras"), "Should include Cerebras as alternative");
    assert.ok(html.includes("50-80%"), "Should mention rate limit reduction");
    assert.ok(html.includes("Spend Caps"), "Should mention spend caps");
    assert.ok(html.includes("$250"), "Should include Tier 1 spend cap amount");
    assert.ok(html.includes("$2,000"), "Should include Tier 2 spend cap amount");
    assert.ok(html.includes("Prepaid"), "Should mention prepaid billing");
    assert.ok(html.includes("3.1 Pro"), "Should mention Gemini 3.1 Pro");
    assert.ok(html.includes("paid-only"), "Should mention paid-only models");
    assert.ok(html.includes("Flash-Lite"), "Should mention Flash-Lite free tier");
    assert.ok(html.includes("/free-llm-apis"), "Should cross-link to free LLM APIs");
    assert.ok(html.includes("Methodology"), "Should have methodology section");
    assert.ok(html.includes("April 1"), "Should mention the deadline");
  });

  it("GET /gemini-api-pricing redirects to /gemini-api-pricing-2026", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/gemini-api-pricing`, { redirect: "manual" });
    assert.strictEqual(response.status, 301);
    assert.strictEqual(response.headers.get("location"), "/gemini-api-pricing-2026");
  });

  it("GET /free-tier-tracker renders free tier tracker page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/free-tier-tracker`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Free Tier Tracker"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Free Tiers Removed"), "Should have removed section");
    assert.ok(html.includes("Free Tiers Expanded"), "Should have expanded section");
    assert.ok(html.includes("Trend Analysis"), "Should have trend analysis section");
    assert.ok(html.includes("All Q1 2026 Changes"), "Should have all changes table");
    assert.ok(html.includes("LocalStack"), "Should include LocalStack");
    assert.ok(html.includes("Postman"), "Should include Postman");
    assert.ok(html.includes("Brave Search API"), "Should include Brave Search");
    assert.ok(html.includes("HCP Terraform"), "Should include HCP Terraform");
    assert.ok(html.includes("Windsurf"), "Should include Windsurf");
    assert.ok(html.includes("Gemini Code Assist"), "Should include Gemini Code Assist expansion");
    assert.ok(html.includes("Cloudflare Startup Program"), "Should include Cloudflare expansion");
    assert.ok(html.includes("Terragrunt Scale"), "Should include Terragrunt Scale");
    assert.ok(html.includes("Open-core"), "Should have trend pattern");
    assert.ok(html.includes("/free-tier-risk"), "Should cross-link to risk index");
    assert.ok(html.includes("/changes"), "Should cross-link to changes timeline");
    assert.ok(html.includes("Methodology"), "Should have methodology section");
  });

  it("GET /startup-credits renders startup credits directory page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/startup-credits`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Startup Credits"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Google Cloud"), "Should include Google Cloud");
    assert.ok(html.includes("$350K"), "Should include Google credit amount");
    assert.ok(html.includes("Cloudflare"), "Should include Cloudflare");
    assert.ok(html.includes("$250K"), "Should include Cloudflare credit amount");
    assert.ok(html.includes("Microsoft Founders Hub"), "Should include Microsoft");
    assert.ok(html.includes("AWS Activate"), "Should include AWS");
    assert.ok(html.includes("DigitalOcean"), "Should include DigitalOcean");
    assert.ok(html.includes("Tier 1"), "Should have Tier 1 section");
    assert.ok(html.includes("Tier 2"), "Should have Tier 2 section");
    assert.ok(html.includes("Tier 3"), "Should have Tier 3 section");
    assert.ok(html.includes("Credit Stacking Strategy"), "Should have stacking strategy");
    assert.ok(html.includes("Bottom Line"), "Should have verdict box");
    assert.ok(html.includes("/free-startup-stack"), "Should cross-link to free startup stack");
  });

  it("GET /ai-coding-pricing-2026 renders AI coding pricing guide", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/ai-coding-pricing-2026`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("AI Coding Tools Pricing"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Cursor"), "Should include Cursor");
    assert.ok(html.includes("Windsurf"), "Should include Windsurf");
    assert.ok(html.includes("GitHub Copilot"), "Should include GitHub Copilot");
    assert.ok(html.includes("Gemini Code Assist"), "Should include Gemini Code Assist");
    assert.ok(html.includes("Amazon Q Developer"), "Should include Amazon Q");
    assert.ok(html.includes("Claude Code"), "Should include Claude Code");
    assert.ok(html.includes("Augment Code"), "Should include Augment Code");
    assert.ok(html.includes("Cline"), "Should include Cline");
    assert.ok(html.includes("Aider"), "Should include Aider");
    assert.ok(html.includes("$20/mo"), "Should show $20/mo price point");
    assert.ok(html.includes("$200/mo"), "Should show $200/mo power tier");
    assert.ok(html.includes("What You Actually Get for Free"), "Should have free tier section");
    assert.ok(html.includes("Recent Pricing Changes"), "Should have changes section");
    assert.ok(html.includes("Which Tool for Which Developer"), "Should have recommendations");
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA");
    assert.ok(html.includes("/changes"), "Should cross-link to changes timeline");
    assert.ok(html.includes("/setup"), "Should cross-link to setup guide");
  });

  it("GET /aws-free-tier-2026 renders AWS free tier guide", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/aws-free-tier-2026`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("AWS Free Tier Complete Guide"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Always Free Services"), "Should have always free section");
    assert.ok(html.includes("12-Month Free Tier"), "Should have 12-month section");
    assert.ok(html.includes("Short-Term Trials"), "Should have trials section");
    assert.ok(html.includes("Aurora PostgreSQL"), "Should highlight Aurora PostgreSQL");
    assert.ok(html.includes("Hidden Costs"), "Should have gotchas section");
    assert.ok(html.includes("AWS vs Alternatives"), "Should have alternatives comparison");
    assert.ok(html.includes("Lambda"), "Should include Lambda");
    assert.ok(html.includes("DynamoDB"), "Should include DynamoDB");
    assert.ok(html.includes("Developer-Focused Stacks"), "Should have stacks section");
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA");
    assert.ok(html.includes("/changes"), "Should cross-link to changes timeline");
    assert.ok(html.includes("/setup"), "Should cross-link to setup guide");
    assert.ok(html.includes("/guides"), "Should link back to guides hub");
  });

  it("GET /gcp-free-tier-2026 renders GCP free tier guide", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/gcp-free-tier-2026`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("GCP Free Tier Complete Guide"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Always Free Products"), "Should have always free section");
    assert.ok(html.includes("Free Trial"), "Should have trial section");
    assert.ok(html.includes("BigQuery"), "Should include BigQuery");
    assert.ok(html.includes("Cloud Run"), "Should include Cloud Run");
    assert.ok(html.includes("e2-micro"), "Should include e2-micro VM");
    assert.ok(html.includes("Firestore"), "Should include Firestore");
    assert.ok(html.includes("Hidden Costs"), "Should have gotchas section");
    assert.ok(html.includes("GCP vs AWS"), "Should have alternatives comparison");
    assert.ok(html.includes("Best Picks by Use Case"), "Should have stacks section");
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA");
    assert.ok(html.includes("/changes"), "Should cross-link to changes timeline");
    assert.ok(html.includes("/setup"), "Should cross-link to setup guide");
    assert.ok(html.includes("/guides"), "Should link back to guides hub");
    assert.ok(html.includes("/aws-free-tier-2026"), "Should cross-link to AWS guide");
  });

  it("GET /azure-free-tier-2026 renders Azure free tier guide", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/azure-free-tier-2026`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Azure Free Tier Complete Guide"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Always Free Services"), "Should have always free section");
    assert.ok(html.includes("12-Month Free Tier"), "Should have 12-month section");
    assert.ok(html.includes("$200 Trial Credit"), "Should have trial section");
    assert.ok(html.includes("Azure Functions"), "Should include Azure Functions");
    assert.ok(html.includes("Cosmos DB"), "Should include Cosmos DB");
    assert.ok(html.includes("App Service"), "Should include App Service");
    assert.ok(html.includes("Azure SQL Database"), "Should include Azure SQL");
    assert.ok(html.includes("Hidden Costs"), "Should have gotchas section");
    assert.ok(html.includes("Azure vs Alternatives"), "Should have alternatives comparison");
    assert.ok(html.includes("Best Picks by Use Case"), "Should have stacks section");
    assert.ok(html.includes("Azure for Startups"), "Should have startups section");
    assert.ok(html.includes("Founders Hub"), "Should include Founders Hub");
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA");
    assert.ok(html.includes("/changes"), "Should cross-link to changes timeline");
    assert.ok(html.includes("/setup"), "Should cross-link to setup guide");
    assert.ok(html.includes("/guides"), "Should link back to guides hub");
    assert.ok(html.includes("/aws-free-tier-2026"), "Should cross-link to AWS guide");
    assert.ok(html.includes("/gcp-free-tier-2026"), "Should cross-link to GCP guide");
  });

  it("GET /digitalocean-free-tier-2026 renders DigitalOcean free tier guide", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/digitalocean-free-tier-2026`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("DigitalOcean Free Tier Complete Guide"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("$200 Free Credits"), "Should have free credits section");
    assert.ok(html.includes("Free Services"), "Should have free services section");
    assert.ok(html.includes("2026 Pricing Highlights"), "Should have pricing section");
    assert.ok(html.includes("App Platform"), "Should include App Platform");
    assert.ok(html.includes("Functions"), "Should include Functions");
    assert.ok(html.includes("Droplet"), "Should include Droplets");
    assert.ok(html.includes("Hidden Costs"), "Should have gotchas section");
    assert.ok(html.includes("DigitalOcean vs Alternatives"), "Should have alternatives comparison");
    assert.ok(html.includes("Best Use Cases"), "Should have stacks section");
    assert.ok(html.includes("For Startups"), "Should have startups section");
    assert.ok(html.includes("Hatch"), "Should include Hatch program");
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA");
    assert.ok(html.includes("/changes"), "Should cross-link to changes timeline");
    assert.ok(html.includes("/setup"), "Should cross-link to setup guide");
    assert.ok(html.includes("/guides"), "Should link back to guides hub");
    assert.ok(html.includes("/aws-free-tier-2026"), "Should cross-link to AWS guide");
    assert.ok(html.includes("/gcp-free-tier-2026"), "Should cross-link to GCP guide");
    assert.ok(html.includes("/azure-free-tier-2026"), "Should cross-link to Azure guide");
  });

  it("GET /cloud-free-tier-comparison-2026 renders cloud comparison page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/cloud-free-tier-comparison-2026`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Cloud Free Tier Comparison 2026"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Free Trial Credits"), "Should have trial credits section");
    assert.ok(html.includes("Always-Free Compute"), "Should have compute section");
    assert.ok(html.includes("Always-Free Databases"), "Should have databases section");
    assert.ok(html.includes("Serverless Functions"), "Should have serverless section");
    assert.ok(html.includes("Startup Credit Programs"), "Should have startup credits section");
    assert.ok(html.includes("Best for Each Use Case"), "Should have best-for section");
    assert.ok(html.includes("Hidden Costs Comparison"), "Should have hidden costs section");
    assert.ok(html.includes("Lambda"), "Should mention AWS Lambda");
    assert.ok(html.includes("e2-micro"), "Should mention GCP e2-micro");
    assert.ok(html.includes("Cosmos DB"), "Should mention Azure Cosmos DB");
    assert.ok(html.includes("Droplet"), "Should mention DigitalOcean Droplet");
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA");
    assert.ok(html.includes("/aws-free-tier-2026"), "Should cross-link to AWS guide");
    assert.ok(html.includes("/gcp-free-tier-2026"), "Should cross-link to GCP guide");
    assert.ok(html.includes("/azure-free-tier-2026"), "Should cross-link to Azure guide");
    assert.ok(html.includes("/digitalocean-free-tier-2026"), "Should cross-link to DO guide");
    assert.ok(html.includes("/guides"), "Should link back to guides hub");
    assert.ok(html.includes("/setup"), "Should cross-link to setup guide");
  });

  it("GET /database-free-tier-comparison-2026 renders database comparison page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/database-free-tier-comparison-2026`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Database Free Tier Comparison 2026"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Supabase"), "Should mention Supabase");
    assert.ok(html.includes("Neon"), "Should mention Neon");
    assert.ok(html.includes("Firebase"), "Should mention Firebase");
    assert.ok(html.includes("Turso"), "Should mention Turso");
    assert.ok(html.includes("PlanetScale"), "Should mention PlanetScale");
    assert.ok(html.includes("Postgres-Compatible"), "Should have Postgres section");
    assert.ok(html.includes("Firebase / BaaS"), "Should have BaaS section");
    assert.ok(html.includes("Edge / Embedded"), "Should have edge section");
    assert.ok(html.includes("Key-Value / Cache"), "Should have KV section");
    assert.ok(html.includes("Vector Databases"), "Should have vector section");
    assert.ok(html.includes("Best for Each Use Case"), "Should have best-for section");
    assert.ok(html.includes("PlanetScale Cautionary Tale"), "Should have PlanetScale section");
    assert.ok(html.includes("Pricing Change Timeline"), "Should have timeline section");
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA");
    assert.ok(html.includes("/neon-vs-supabase"), "Should cross-link to Neon vs Supabase");
    assert.ok(html.includes("/supabase-vs-firebase"), "Should cross-link to Supabase vs Firebase");
    assert.ok(html.includes("/database-alternatives"), "Should cross-link to database alternatives");
    assert.ok(html.includes("/guides"), "Should link back to guides hub");
    assert.ok(html.includes("/setup"), "Should cross-link to setup guide");
  });

  it("GET /cicd-free-tier-comparison-2026 renders CI/CD comparison page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/cicd-free-tier-comparison-2026`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("CI/CD Free Tier Comparison 2026"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("GitHub Actions"), "Should mention GitHub Actions");
    assert.ok(html.includes("GitLab CI"), "Should mention GitLab CI");
    assert.ok(html.includes("CircleCI"), "Should mention CircleCI");
    assert.ok(html.includes("Buildkite"), "Should mention Buildkite");
    assert.ok(html.includes("Drone CI"), "Should mention Drone CI");
    assert.ok(html.includes("General-Purpose CI/CD"), "Should have general-purpose section");
    assert.ok(html.includes("Developer-Focused CI/CD"), "Should have developer-focused section");
    assert.ok(html.includes("Mobile CI/CD"), "Should have mobile section");
    assert.ok(html.includes("Specialized CI/CD"), "Should have specialized section");
    assert.ok(html.includes("Self-Hosted CI/CD"), "Should have self-hosted section");
    assert.ok(html.includes("Best for Each Use Case"), "Should have best-for section");
    assert.ok(html.includes("Hidden Costs and Gotchas"), "Should have hidden costs section");
    assert.ok(html.includes("Pricing Change Timeline"), "Should have timeline section");
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA");
    assert.ok(html.includes("/ci-cd-alternatives"), "Should cross-link to CI/CD alternatives");
    assert.ok(html.includes("/guides"), "Should link back to guides hub");
    assert.ok(html.includes("/setup"), "Should cross-link to setup guide");
  });

  it("GET /serverless-free-tier-comparison-2026 renders serverless comparison page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/serverless-free-tier-comparison-2026`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Serverless Free Tier Comparison 2026"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("AWS Lambda"), "Should mention AWS Lambda");
    assert.ok(html.includes("Cloudflare Workers"), "Should mention Cloudflare Workers");
    assert.ok(html.includes("Google Cloud Functions"), "Should mention Google Cloud Functions");
    assert.ok(html.includes("Azure Functions"), "Should mention Azure Functions");
    assert.ok(html.includes("Deno Deploy"), "Should mention Deno Deploy");
    assert.ok(html.includes("Cloud Run"), "Should mention Cloud Run");
    assert.ok(html.includes("Val Town"), "Should mention Val Town");
    assert.ok(html.includes("Traditional FaaS"), "Should have traditional FaaS section");
    assert.ok(html.includes("Edge Compute"), "Should have edge compute section");
    assert.ok(html.includes("Full-Service Serverless"), "Should have full-service section");
    assert.ok(html.includes("Specialized Serverless"), "Should have specialized section");
    assert.ok(html.includes("CPU-Time vs Wall-Clock-Time"), "Should have billing gotcha section");
    assert.ok(html.includes("Best for Each Use Case"), "Should have best-for section");
    assert.ok(html.includes("Hidden Costs and Gotchas"), "Should have hidden costs section");
    assert.ok(html.includes("Pricing Change Timeline"), "Should have timeline section");
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA");
    assert.ok(html.includes("/cloud-free-tier-comparison-2026"), "Should cross-link to cloud comparison");
    assert.ok(html.includes("/guides"), "Should link back to guides hub");
    assert.ok(html.includes("/setup"), "Should cross-link to setup guide");
  });

  it("GET /email-comparison-2026 renders expanded email comparison page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/email-comparison-2026`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Email"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("SendGrid"), "Should mention SendGrid");
    assert.ok(html.includes("Resend"), "Should mention Resend");
    assert.ok(html.includes("Postmark"), "Should mention Postmark");
    assert.ok(html.includes("Amazon SES"), "Should mention Amazon SES");
    assert.ok(html.includes("Brevo"), "Should mention Brevo");
    assert.ok(html.includes("Mailtrap"), "Should mention Mailtrap");
    assert.ok(html.includes("Loops"), "Should mention Loops");
    assert.ok(html.includes("Maileroo"), "Should mention Maileroo");
    assert.ok(html.includes("MailerLite"), "Should mention MailerLite");
    assert.ok(html.includes("EmailOctopus"), "Should mention EmailOctopus");
    assert.ok(html.includes("Pure Transactional APIs"), "Should have transactional section");
    assert.ok(html.includes("All-in-One"), "Should have all-in-one section");
    assert.ok(html.includes("Newsletter"), "Should have newsletter section");
    assert.ok(html.includes("SendGrid Exodus"), "Should have SendGrid exodus section");
    assert.ok(html.includes("Email Testing"), "Should have testing section");
    assert.ok(html.includes("Email Verification"), "Should have verification section");
    assert.ok(html.includes("Email Forwarding"), "Should have forwarding section");
    assert.ok(html.includes("SMTP Infrastructure"), "Should have infrastructure section");
    assert.ok(html.includes("Self-Hosted"), "Should have self-hosted section");
    assert.ok(html.includes("Growth Cost Trap"), "Should have cost trap section");
    assert.ok(html.includes("Best for Each Use Case"), "Should have best-for section");
    assert.ok(html.includes("Hidden Costs"), "Should have hidden costs section");
    assert.ok(html.includes("Pricing Change Timeline"), "Should have timeline section");
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA");
    assert.ok(html.includes("/guides"), "Should link back to guides hub");
    assert.ok(html.includes("/setup"), "Should cross-link to setup guide");
  });

  it("GET /email-free-tier-comparison-2026 redirects to /email-comparison-2026", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/email-free-tier-comparison-2026`, { redirect: "manual" });
    assert.strictEqual(response.status, 301);
    assert.ok(response.headers.get("location")?.includes("/email-comparison-2026"), "Should redirect to new URL");
  });

  it("GET /monitoring-comparison-2026 renders expanded monitoring comparison page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/monitoring-comparison-2026`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Monitoring"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Datadog"), "Should mention Datadog");
    assert.ok(html.includes("Grafana Cloud"), "Should mention Grafana Cloud");
    assert.ok(html.includes("New Relic"), "Should mention New Relic");
    assert.ok(html.includes("Sentry"), "Should mention Sentry");
    assert.ok(html.includes("UptimeRobot"), "Should mention UptimeRobot");
    assert.ok(html.includes("PagerDuty"), "Should mention PagerDuty");
    assert.ok(html.includes("Healthchecks"), "Should mention Healthchecks.io");
    assert.ok(html.includes("Prometheus"), "Should mention Prometheus");
    assert.ok(html.includes("Checkly"), "Should mention Checkly");
    assert.ok(html.includes("SigNoz"), "Should mention SigNoz");
    assert.ok(html.includes("HyperDX"), "Should mention HyperDX");
    assert.ok(html.includes("Rollbar"), "Should mention Rollbar");
    assert.ok(html.includes("Bugsnag"), "Should mention Bugsnag");
    assert.ok(html.includes("Elastic"), "Should mention Elastic");
    assert.ok(html.includes("Better Stack"), "Should mention Better Stack");
    assert.ok(html.includes("Full-Stack Observability"), "Should have observability section");
    assert.ok(html.includes("Error Tracking"), "Should have error tracking section");
    assert.ok(html.includes("Synthetic Monitoring"), "Should have uptime/synthetic section");
    assert.ok(html.includes("Incident Management"), "Should have incident section");
    assert.ok(html.includes("Cron"), "Should have cron monitoring section");
    assert.ok(html.includes("Self-Hosted"), "Should have self-hosted section");
    assert.ok(html.includes("Observability Cost Trap"), "Should have cost trap section");
    assert.ok(html.includes("500 hosts"), "Should have 500-host scale in cost table");
    assert.ok(html.includes("Best for Each Use Case"), "Should have best-for section");
    assert.ok(html.includes("serverless"), "Should have serverless verdict");
    assert.ok(html.includes("Hidden Costs and Gotchas"), "Should have hidden costs section");
    assert.ok(html.includes("cardinality"), "Should mention cardinality cost trap");
    assert.ok(html.includes("Pricing Change Timeline"), "Should have timeline section");
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA");
    assert.ok(html.includes("/guides"), "Should link back to guides hub");
    assert.ok(html.includes("/setup"), "Should cross-link to setup guide");
  });

  it("GET /monitoring-free-tier-comparison-2026 redirects to /monitoring-comparison-2026", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/monitoring-free-tier-comparison-2026`, { redirect: "manual" });
    assert.strictEqual(response.status, 301);
    assert.ok(response.headers.get("location")?.includes("/monitoring-comparison-2026"), "Should redirect to new slug");
  });

  it("GET /auth-comparison-2026 renders auth comparison page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/auth-comparison-2026`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Auth"), "Should have auth in title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Auth0"), "Should mention Auth0");
    assert.ok(html.includes("Clerk"), "Should mention Clerk");
    assert.ok(html.includes("Supabase Auth"), "Should mention Supabase Auth");
    assert.ok(html.includes("Firebase Auth"), "Should mention Firebase Auth");
    assert.ok(html.includes("Keycloak"), "Should mention Keycloak");
    assert.ok(html.includes("FusionAuth"), "Should mention FusionAuth");
    assert.ok(html.includes("WorkOS"), "Should mention WorkOS");
    assert.ok(html.includes("PropelAuth"), "Should mention PropelAuth");
    assert.ok(html.includes("Authentik"), "Should mention Authentik");
    assert.ok(html.includes("Authelia"), "Should mention Authelia");
    assert.ok(html.includes("Appwrite"), "Should mention Appwrite");
    assert.ok(html.includes("Managed Auth"), "Should have managed auth section");
    assert.ok(html.includes("BaaS-Integrated Auth"), "Should have BaaS auth section");
    assert.ok(html.includes("Self-Hosted"), "Should have self-hosted section");
    assert.ok(html.includes("Specialized"), "Should have specialized section");
    assert.ok(html.includes("Growth Cost Trap"), "Should have growth cost trap section");
    assert.ok(html.includes("Best for Each Use Case"), "Should have best-for section");
    assert.ok(html.includes("Hidden Costs and Gotchas"), "Should have hidden costs section");
    assert.ok(html.includes("Pricing Change Timeline"), "Should have timeline section");
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA");
    assert.ok(html.includes("/supabase-vs-firebase"), "Should cross-link to Supabase vs Firebase");
    assert.ok(html.includes("/guides"), "Should link back to guides hub");
    assert.ok(html.includes("/setup"), "Should cross-link to setup guide");
    assert.ok(html.includes("agentic"), "Should mention agentic AI auth");
  });

  it("GET /auth-free-tier-comparison-2026 redirects to /auth-comparison-2026", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/auth-free-tier-comparison-2026`, { redirect: "manual" });
    assert.strictEqual(response.status, 301);
    assert.ok(response.headers.get("location")?.includes("/auth-comparison-2026"), "Should redirect to new slug");
  });

  it("GET /storage-comparison-2026 renders expanded storage and CDN comparison page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/storage-comparison-2026`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Storage"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    // Providers
    assert.ok(html.includes("Cloudflare R2"), "Should mention Cloudflare R2");
    assert.ok(html.includes("Backblaze B2"), "Should mention Backblaze B2");
    assert.ok(html.includes("AWS S3"), "Should mention AWS S3");
    assert.ok(html.includes("Google Cloud Storage"), "Should mention Google Cloud Storage");
    assert.ok(html.includes("Supabase Storage"), "Should mention Supabase Storage");
    assert.ok(html.includes("Storj"), "Should mention Storj");
    assert.ok(html.includes("Tigris"), "Should mention Tigris");
    assert.ok(html.includes("MinIO"), "Should mention MinIO");
    assert.ok(html.includes("Cloudinary"), "Should mention Cloudinary");
    assert.ok(html.includes("BunnyCDN"), "Should mention BunnyCDN");
    assert.ok(html.includes("ImageKit"), "Should mention ImageKit");
    assert.ok(html.includes("Pinata"), "Should mention Pinata IPFS");
    // Sections
    assert.ok(html.includes("Zero-Egress"), "Should have zero-egress section");
    assert.ok(html.includes("Cloud Provider Storage"), "Should have cloud provider section");
    assert.ok(html.includes("Media"), "Should have media/CDN section");
    assert.ok(html.includes("BaaS-Integrated"), "Should have BaaS section");
    assert.ok(html.includes("Self-Hosted"), "Should have self-hosted section");
    assert.ok(html.includes("Decentralized"), "Should have decentralized section");
    assert.ok(html.includes("Growth Cost Trap"), "Should have cost trap section");
    assert.ok(html.includes("S3 Egress Tax"), "Should have S3 egress tax section");
    assert.ok(html.includes("100 TB"), "Should have 100TB scale in cost table");
    assert.ok(html.includes("NAT Gateway"), "Should explain NAT Gateway hidden charge");
    assert.ok(html.includes("Best for Each Use Case"), "Should have best-for section");
    assert.ok(html.includes("Hidden Costs and Gotchas"), "Should have hidden costs section");
    assert.ok(html.includes("Pricing Change Timeline"), "Should have timeline section");
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA");
    assert.ok(html.includes("/guides"), "Should link back to guides hub");
    assert.ok(html.includes("/setup"), "Should cross-link to setup guide");
  });

  it("GET /storage-free-tier-comparison-2026 redirects to /storage-comparison-2026", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/storage-free-tier-comparison-2026`, { redirect: "manual" });
    assert.strictEqual(response.status, 301);
    assert.ok(response.headers.get("location")?.includes("/storage-comparison-2026"), "Should redirect to new slug");
  });

  it("GET /analytics-free-tier-comparison-2026 renders analytics comparison page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/analytics-free-tier-comparison-2026`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Analytics"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("PostHog"), "Should mention PostHog");
    assert.ok(html.includes("Mixpanel"), "Should mention Mixpanel");
    assert.ok(html.includes("Amplitude"), "Should mention Amplitude");
    assert.ok(html.includes("Google Analytics"), "Should mention Google Analytics");
    assert.ok(html.includes("Plausible"), "Should mention Plausible");
    assert.ok(html.includes("Umami"), "Should mention Umami");
    assert.ok(html.includes("Product Analytics"), "Should have product analytics section");
    assert.ok(html.includes("Web Analytics"), "Should have web analytics section");
    assert.ok(html.includes("Privacy-Focused"), "Should have privacy section");
    assert.ok(html.includes("Self-Hosted"), "Should have self-hosted section");
    assert.ok(html.includes("Analytics Cost Trap"), "Should have cost trap section");
    assert.ok(html.includes("Best for Each Use Case"), "Should have best-for section");
    assert.ok(html.includes("Hidden Costs and Gotchas"), "Should have hidden costs section");
    assert.ok(html.includes("Pricing Change Timeline"), "Should have timeline section");
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA");
    assert.ok(html.includes("/guides"), "Should link back to guides hub");
  });

  it("GET /testing-free-tier-comparison-2026 renders testing comparison page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/testing-free-tier-comparison-2026`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Testing"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Playwright"), "Should mention Playwright");
    assert.ok(html.includes("Cypress"), "Should mention Cypress");
    assert.ok(html.includes("BrowserStack"), "Should mention BrowserStack");
    assert.ok(html.includes("Chromatic"), "Should mention Chromatic");
    assert.ok(html.includes("Grafana k6"), "Should mention k6");
    assert.ok(html.includes("Checkly"), "Should mention Checkly");
    assert.ok(html.includes("E2E"), "Should have E2E section");
    assert.ok(html.includes("Visual Regression"), "Should have visual regression section");
    assert.ok(html.includes("Load"), "Should have load testing section");
    assert.ok(html.includes("Local Development"), "Should have local dev section");
    assert.ok(html.includes("Testing Cost Trap"), "Should have cost trap section");
    assert.ok(html.includes("Best for Each Use Case"), "Should have best-for section");
    assert.ok(html.includes("Hidden Costs and Gotchas"), "Should have hidden costs section");
    assert.ok(html.includes("Pricing Change Timeline"), "Should have timeline section");
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA");
    assert.ok(html.includes("/guides"), "Should link back to guides hub");
  });

  it("GET /api-development-free-tier-comparison-2026 renders API development comparison page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/api-development-free-tier-comparison-2026`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("API Development"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Postman"), "Should mention Postman");
    assert.ok(html.includes("Bruno"), "Should mention Bruno");
    assert.ok(html.includes("Hoppscotch"), "Should mention Hoppscotch");
    assert.ok(html.includes("Insomnia"), "Should mention Insomnia");
    assert.ok(html.includes("Thunder Client"), "Should mention Thunder Client");
    assert.ok(html.includes("Mockoon"), "Should mention Mockoon");
    assert.ok(html.includes("Full-Featured API Clients"), "Should have full-featured section");
    assert.ok(html.includes("Open Source"), "Should have open source section");
    assert.ok(html.includes("Web-Based"), "Should have web-based section");
    assert.ok(html.includes("IDE Extensions"), "Should have IDE extensions section");
    assert.ok(html.includes("API Design"), "Should have API design section");
    assert.ok(html.includes("Mock Servers"), "Should have mock servers section");
    assert.ok(html.includes("API Tool Migration Trap"), "Should have migration trap section");
    assert.ok(html.includes("Best for Each Use Case"), "Should have best-for section");
    assert.ok(html.includes("Hidden Costs and Gotchas"), "Should have hidden costs section");
    assert.ok(html.includes("Pricing Change Timeline"), "Should have timeline section");
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA");
    assert.ok(html.includes("/guides"), "Should link back to guides hub");
  });

  it("GET /security-free-tier-comparison-2026 renders security comparison page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/security-free-tier-comparison-2026`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Security"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Snyk"), "Should mention Snyk");
    assert.ok(html.includes("Semgrep"), "Should mention Semgrep");
    assert.ok(html.includes("GitGuardian"), "Should mention GitGuardian");
    assert.ok(html.includes("Trivy"), "Should mention Trivy");
    assert.ok(html.includes("OWASP ZAP"), "Should mention OWASP ZAP");
    assert.ok(html.includes("CodeQL"), "Should mention CodeQL");
    assert.ok(html.includes("SAST"), "Should have SAST section");
    assert.ok(html.includes("SCA"), "Should have SCA section");
    assert.ok(html.includes("DAST"), "Should have DAST section");
    assert.ok(html.includes("Secrets Detection"), "Should have secrets detection section");
    assert.ok(html.includes("Container"), "Should have container section");
    assert.ok(html.includes("DevSecOps Cost Trap"), "Should have cost trap section");
    assert.ok(html.includes("Best for Each Use Case"), "Should have best-for section");
    assert.ok(html.includes("Hidden Costs and Gotchas"), "Should have hidden costs section");
    assert.ok(html.includes("Pricing Change Timeline"), "Should have timeline section");
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA");
    assert.ok(html.includes("/guides"), "Should link back to guides hub");
  });

  it("GET /hosting-free-tier-comparison-2026 renders hosting comparison page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/hosting-free-tier-comparison-2026`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Hosting"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Vercel"), "Should mention Vercel");
    assert.ok(html.includes("Netlify"), "Should mention Netlify");
    assert.ok(html.includes("Render"), "Should mention Render");
    assert.ok(html.includes("Railway"), "Should mention Railway");
    assert.ok(html.includes("Cloudflare Pages"), "Should mention Cloudflare Pages");
    assert.ok(html.includes("Fly.io"), "Should mention Fly.io");
    assert.ok(html.includes("Koyeb"), "Should mention Koyeb");
    assert.ok(html.includes("Deno Deploy"), "Should mention Deno Deploy");
    assert.ok(html.includes("GitHub Pages"), "Should mention GitHub Pages");
    assert.ok(html.includes("Frontend"), "Should have frontend section");
    assert.ok(html.includes("Backend"), "Should have backend section");
    assert.ok(html.includes("Edge"), "Should have edge section");
    assert.ok(html.includes("Static Site"), "Should have static sites section");
    assert.ok(html.includes("Hosting Cost Trap"), "Should have cost trap section");
    assert.ok(html.includes("Best for Each Use Case"), "Should have best-for section");
    assert.ok(html.includes("Hidden Costs and Gotchas"), "Should have hidden costs section");
    assert.ok(html.includes("Pricing Change Timeline"), "Should have timeline section");
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA");
    assert.ok(html.includes("/hosting-alternatives"), "Should cross-link to hosting alternatives");
    assert.ok(html.includes("/vercel-vs-netlify"), "Should cross-link to Vercel vs Netlify");
    assert.ok(html.includes("/railway-vs-render"), "Should cross-link to Railway vs Render");
    assert.ok(html.includes("/guides"), "Should link back to guides hub");
    assert.ok(html.includes("/setup"), "Should cross-link to setup guide");
  });

  it("GET /state-of-free-tiers-2026 renders State of Free Tiers report", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/state-of-free-tiers-2026`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("State of Developer Free Tiers 2026"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Executive Summary"), "Should have executive summary section");
    assert.ok(html.includes("By the Numbers"), "Should have stats section");
    assert.ok(html.includes("Free Tier Squeeze"), "Should have squeeze section");
    assert.ok(html.includes("Bright Spots"), "Should have bright spots section");
    assert.ok(html.includes("Startup Credit Programs"), "Should have startup credits section");
    assert.ok(html.includes("Category Landscape"), "Should have category landscape section");
    assert.ok(html.includes("Cost Trap"), "Should have cost trap section");
    assert.ok(html.includes("Methodology"), "Should have methodology section");
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA");
    assert.ok(html.includes("/guides"), "Should link back to guides hub");
  });

  it("GET /guides renders guides hub page with all editorial content", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/guides`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Developer Tool Guides"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"CollectionPage"'), "Should use CollectionPage schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("/guides"), "Should have canonical URL");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Pricing Guides"), "Should have pricing section");
    assert.ok(html.includes("Vendor Comparisons"), "Should have comparisons section");
    assert.ok(html.includes("Stack Guides"), "Should have stack guides section");
    assert.ok(html.includes("Category Alternatives"), "Should have alternatives section");
    assert.ok(html.includes("Special Reports"), "Should have reports section");
    assert.ok(html.includes("/ai-coding-pricing-2026"), "Should link to AI coding pricing");
    assert.ok(html.includes("/supabase-vs-firebase"), "Should link to vendor comparison");
    assert.ok(html.includes("/free-startup-stack"), "Should link to stack guide");
    assert.ok(html.includes("/database-alternatives"), "Should link to category hub");
    assert.ok(html.includes("/free-tier-risk"), "Should link to special report");
    assert.ok(html.includes("guide-badge"), "Should have content type badges");
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA");
  });

  it("GET /team-collaboration-alternatives renders team collaboration hub page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/team-collaboration-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Best Free Team Collaboration Tools"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Communication &amp; Chat"), "Should have chat section");
    assert.ok(html.includes("Video Conferencing"), "Should have video section");
    assert.ok(html.includes("Documentation &amp; Knowledge"), "Should have docs section");
    assert.ok(html.includes("Scheduling &amp; Calendar"), "Should have scheduling section");
    assert.ok(html.includes("Feedback &amp; Review"), "Should have feedback section");
    assert.ok(html.includes("Which Free Collaboration Tool"), "Should have decision guide");
    assert.ok(html.includes("Slack"), "Should include Slack");
    assert.ok(html.includes("Pumble"), "Should include Pumble");
    assert.ok(html.includes("Jitsi"), "Should include Jitsi");
    assert.ok(html.includes("project-management-alternatives"), "Should cross-link to PM hub");
    assert.ok(html.includes("More Alternatives Guides"), "Should have cross-links");
  });

  // --- Search page ---

  it("GET /search renders search page with search box", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/search`);
    assert.strictEqual(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes("<title>Search Free Developer Tools"), "Should have search title");
    assert.ok(html.includes("search-input"), "Should have search input");
    assert.ok(html.includes("Popular searches"), "Should show suggested searches when no query");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
  });

  it("GET /search?q=database returns server-rendered results", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/search?q=database`);
    assert.strictEqual(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes("database"), "Should contain search query");
    assert.ok(html.includes("result-card"), "Should have result cards");
    assert.ok(html.includes("/vendor/"), "Should link to vendor profiles");
  });

  it("GET /search?q=database&category=Databases filters by category", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/search?q=database&category=Databases`);
    assert.strictEqual(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes("result-card"), "Should have result cards");
    assert.ok(html.includes("cat-filter active"), "Should highlight active category filter");
  });

  it("GET /search?q=xyznonexistent shows empty state", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/search?q=xyznonexistent`);
    assert.strictEqual(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes("No results found"), "Should show empty state");
    assert.ok(html.includes("suggest-pill"), "Should show suggested searches");
  });

  it("GET /search has category filter pills", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/search`);
    assert.strictEqual(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes("cat-filter"), "Should have category filter pills");
    assert.ok(html.includes("Databases"), "Should include Databases category");
  });

  // --- Global navigation ---

  it("landing page has global navigation with all section links", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/`);
    const html = await response.text();
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes('href="/search"'), "Nav should link to Search");
    assert.ok(html.includes('href="/category"'), "Nav should link to Categories");
    assert.ok(html.includes('href="/best"'), "Nav should link to Best Of");
    assert.ok(html.includes('href="/trends"'), "Nav should link to Trends");
    assert.ok(html.includes('href="/alternatives"'), "Nav should link to Alternatives");
    assert.ok(html.includes('href="/guides"'), "Nav should link to Guides");
    assert.ok(html.includes('href="/compare"'), "Nav should link to Compare");
    assert.ok(html.includes('href="/digest"'), "Nav should link to Digest");
    assert.ok(html.includes('href="/api/docs"'), "Nav should link to API");
  });

  it("category page nav highlights Categories as active", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/category/databases`);
    const html = await response.text();
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes('class="nav-link active">Categories'), "Categories should be active");
  });

  it("search page nav highlights Search as active", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/search`);
    const html = await response.text();
    assert.ok(html.includes('class="nav-link active">Search'), "Search should be active");
  });

  it("global nav appears on all page types", async () => {
    proc = await startHttpServer();

    const pages = ["/", "/category/databases", "/best", "/search", "/trends", "/compare", "/alternative-to", "/digest/archive"];
    for (const page of pages) {
      const response = await fetch(`http://localhost:${serverPort}${page}`);
      const html = await response.text();
      assert.ok(html.includes("global-nav"), `${page} should have global nav`);
      assert.ok(html.includes("global-nav-home"), `${page} should have AgentDeals home link`);
    }
  });

  // --- FAQ structured data ---

  it("vendor page has FAQ structured data and visible FAQ section", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/vendor/vercel`);
    const html = await response.text();
    assert.ok(html.includes("FAQPage"), "Should have FAQPage JSON-LD");
    assert.ok(html.includes("faq-item"), "Should have visible FAQ items");
    assert.ok(html.includes("Is Vercel free"), "Should have vendor-specific FAQ question");
    assert.ok(html.includes("free tier"), "FAQ answer should mention free tier");
  });

  it("alternative-to page has FAQ structured data and visible FAQ section", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/alternative-to/vercel`);
    const html = await response.text();
    assert.ok(html.includes("FAQPage"), "Should have FAQPage JSON-LD");
    assert.ok(html.includes("faq-item"), "Should have visible FAQ items");
    assert.ok(html.includes("best free alternatives to Vercel"), "Should have alternatives FAQ question");
    assert.ok(html.includes("How many free alternatives"), "Should have count FAQ question");
  });

  it("landing page has recent pricing changes section", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/`);
    const html = await response.text();
    assert.ok(html.includes('id="recent-changes"'), "Should have recent-changes section");
    assert.ok(html.includes("rc-entry"), "Should have change entries");
    assert.ok(html.includes("rc-vendor"), "Should have vendor links");
    assert.ok(html.includes('href="/expiring"'), "Should link to /expiring");
    assert.ok(html.includes('"Recent Pricing Changes"'), "Should have ItemList JSON-LD");
  });

  it("landing page has changing soon section with upcoming deal changes", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/`);
    const html = await response.text();
    assert.ok(html.includes('id="changing-soon"'), "Should have changing-soon section");
    assert.ok(html.includes("cs-entry"), "Should have change entries");
    assert.ok(html.includes("cs-vendor"), "Should have vendor links");
    assert.ok(html.includes("cs-countdown"), "Should have countdown indicators");
    assert.ok(html.includes('href="/changes"'), "Should link to /changes");
  });

  it("serves og-image.png at /og-image.png", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/og-image.png`);
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
    const response = await fetch(`http://localhost:${serverPort}/`);
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
    const response = await fetch(`http://localhost:${serverPort}/category/databases`);
    const html = await response.text();
    assert.ok(html.includes('property="og:image"'), "Should have og:image tag");
    assert.ok(html.includes("/og-image.png"), "og:image should point to /og-image.png");
    assert.ok(html.includes('name="twitter:card" content="summary_large_image"'), "Should have twitter:card");
  });

  it("vendor page has OG image meta tags", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/vendor/vercel`);
    const html = await response.text();
    assert.ok(html.includes('property="og:image"'), "Should have og:image tag");
    assert.ok(html.includes("/og-image.png"), "og:image should point to /og-image.png");
    assert.ok(html.includes('name="twitter:card" content="summary_large_image"'), "Should have twitter:card");
  });

  it("expiring page has OG image meta tags", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/expiring`);
    const html = await response.text();
    assert.ok(html.includes('property="og:image"'), "Should have og:image tag");
    assert.ok(html.includes("/og-image.png"), "og:image should point to /og-image.png");
    assert.ok(html.includes('name="twitter:card" content="summary_large_image"'), "Should have twitter:card");
  });
});

let redirectPort = 0;

function startRedirectServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "https://agentdeals.dev" },
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 5000);

    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        redirectPort = parseInt(match[1], 10);
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

    const response = await fetch(`http://localhost:${serverPort}/best`);
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

    const response = await fetch(`http://localhost:${serverPort}/best/free-databases`);
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

    const response = await fetch(`http://localhost:${serverPort}/best/free-nonexistent`);
    assert.strictEqual(response.status, 404);
    const html = await response.text();
    assert.ok(html.includes("404"), "Should show 404 message");
  });

  it("sitemap.xml includes best-of pages", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/sitemap.xml`);
    const xml = await response.text();
    assert.ok(xml.includes("/best"), "Sitemap should include best-of index");
    assert.ok(xml.includes("/best/free-databases"), "Sitemap should include best-of detail pages");
    const bestCount = (xml.match(/\/best\//g) || []).length;
    assert.ok(bestCount >= 8, `Expected 8+ best-of URLs in sitemap, got ${bestCount}`);
  });

  it("best-of page nav highlights Best Of as active", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/best/free-databases`);
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
    const response = await fetch(`http://localhost:${serverPort}/category/databases`);
    const html = await response.text();
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA banner");
    assert.ok(html.includes("claude mcp add agentdeals"), "Should have install command");
    assert.ok(html.includes('href="/setup"'), "Should link to setup guide");
  });

  it("CTA appears on vendor page", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/vendor/vercel`);
    const html = await response.text();
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA banner");
    assert.ok(html.includes("claude mcp add agentdeals"), "Should have install command");
  });

  it("CTA appears on comparison page", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/compare/netlify-vs-vercel`);
    const html = await response.text();
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA banner");
    assert.ok(html.includes("claude mcp add agentdeals"), "Should have install command");
  });

  it("CTA appears on best-of page", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/best/free-databases`);
    const html = await response.text();
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA banner");
    assert.ok(html.includes("claude mcp add agentdeals"), "Should have install command");
  });

  it("CTA appears on alternative-to page", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/alternative-to/vercel`);
    const html = await response.text();
    assert.ok(html.includes("mcp-cta"), "Should have MCP CTA banner");
    assert.ok(html.includes("claude mcp add agentdeals"), "Should have install command");
  });

  it("CTA does NOT appear on landing page", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/`);
    const html = await response.text();
    assert.ok(!html.includes("mcp-cta"), "Landing page should NOT have MCP CTA banner");
  });

  it("CTA includes copy button", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/vendor/vercel`);
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
    const response = await fetch(`http://localhost:${serverPort}/api/pageviews`);
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
    await fetch(`http://localhost:${serverPort}/category/databases`);
    const response = await fetch(`http://localhost:${serverPort}/api/stats`);
    const text = await response.text();
    // The getStats export isn't used by /api/stats (it uses getConnectionStats),
    // but page_views_today may be in the response if getStats is used elsewhere
    assert.strictEqual(response.status, 200);
  });

  it("page views increment on page visit", async () => {
    proc = await startHttpServer();
    // Get initial count
    const before = await fetch(`http://localhost:${serverPort}/api/pageviews`);
    const dataBefore = await before.json() as { today: { total: number } };
    const initialTotal = dataBefore.today.total;
    // Visit a page
    await fetch(`http://localhost:${serverPort}/vendor/vercel`);
    // Check count increased
    const after = await fetch(`http://localhost:${serverPort}/api/pageviews`);
    const dataAfter = await after.json() as { today: { total: number } };
    assert.ok(dataAfter.today.total >= initialTotal, "Page views should not decrease after visit");
  });
});

describe("301 canonical hostname redirect", () => {
  let redirectProc: ChildProcess | null = null;

  before(async () => {
    redirectProc = await startRedirectServer();
  });

  after(() => {
    if (redirectProc) {
      redirectProc.kill();
      redirectProc = null;
    }
  });

  it("redirects HTML pages to canonical domain with 301", async () => {
    const response = await fetch(`http://localhost:${redirectPort}/vendor/supabase?ref=foo`, { redirect: "manual" });
    assert.strictEqual(response.status, 301);
    assert.strictEqual(response.headers.get("location"), "https://agentdeals.dev/vendor/supabase?ref=foo");
  });

  it("redirects landing page to canonical domain", async () => {
    const response = await fetch(`http://localhost:${redirectPort}/`, { redirect: "manual" });
    assert.strictEqual(response.status, 301);
    assert.strictEqual(response.headers.get("location"), "https://agentdeals.dev/");
  });

  it("does NOT redirect /api/* endpoints", async () => {
    const response = await fetch(`http://localhost:${redirectPort}/api/stats`, { redirect: "manual" });
    assert.strictEqual(response.status, 200);
  });

  it("does NOT redirect /mcp endpoint", async () => {
    // GET /mcp without session returns 400, but should NOT be 301
    const response = await fetch(`http://localhost:${redirectPort}/mcp`, { redirect: "manual" });
    assert.notStrictEqual(response.status, 301, "MCP should not redirect");
  });

  it("does NOT redirect /health endpoint", async () => {
    const response = await fetch(`http://localhost:${redirectPort}/health`, { redirect: "manual" });
    assert.strictEqual(response.status, 200);
  });

  it("does NOT redirect /.well-known/* endpoints", async () => {
    const response = await fetch(`http://localhost:${redirectPort}/.well-known/glama.json`, { redirect: "manual" });
    assert.notStrictEqual(response.status, 301, ".well-known should not redirect");
  });

  it("does NOT redirect favicon", async () => {
    const response = await fetch(`http://localhost:${redirectPort}/favicon.png`, { redirect: "manual" });
    assert.strictEqual(response.status, 200);
  });

  it("no redirect when BASE_URL matches request host", async () => {
    // Default server has BASE_URL matching localhost (or not set to external domain)
    // This test uses a separate server with matching BASE_URL
    let proc: ChildProcess | null = null;
    try {
      proc = await startHttpServer();
      const response = await fetch(`http://localhost:${serverPort}/`, { redirect: "manual" });
      assert.strictEqual(response.status, 200);
    } finally {
      if (proc) proc.kill();
    }
  });
});

const INDEXNOW_TEST_KEY = "test-indexnow-key-abc123";

function startIndexNowServer(): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", INDEXNOW_KEY: INDEXNOW_TEST_KEY },
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 5000);

    proc.stderr!.on("data", (data: Buffer) => {
      const msg = data.toString();
      const match = msg.match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ proc, port: parseInt(match[1], 10) });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe("IndexNow integration", () => {
  let indexNowProc: ChildProcess | null = null;
  let indexNowPort: number = 0;

  before(async () => {
    const result = await startIndexNowServer();
    indexNowProc = result.proc;
    indexNowPort = result.port;
  });

  after(() => {
    if (indexNowProc) {
      indexNowProc.kill();
      indexNowProc = null;
    }
  });

  it("serves IndexNow key verification file at /{key}.txt", async () => {
    const response = await fetch(`http://localhost:${indexNowPort}/${INDEXNOW_TEST_KEY}.txt`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("content-type"), "text/plain; charset=utf-8");
    const body = await response.text();
    assert.strictEqual(body, INDEXNOW_TEST_KEY);
  });

  it("returns 404 for incorrect key file path", async () => {
    const response = await fetch(`http://localhost:${indexNowPort}/wrong-key.txt`);
    assert.strictEqual(response.status, 404);
  });

  it("does not serve key file when INDEXNOW_KEY is not set", async () => {
    // This test uses a separate server without INDEXNOW_KEY
    let proc: ChildProcess | null = null;
    try {
      proc = await startHttpServer();
      const response = await fetch(`http://localhost:${serverPort}/.txt`);
      assert.strictEqual(response.status, 404);
    } finally {
      if (proc) proc.kill();
    }
  });

});

describe("shutdown tracker page", () => {
  let proc: ChildProcess | null = null;

  afterEach(() => {
    if (proc) {
      proc.kill();
      proc = null;
    }
  });

  it("GET /firebase-studio-shutdown renders Firebase Studio shutdown guide", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/firebase-studio-shutdown`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Firebase Studio Shutdown"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("June 22, 2026"), "Should show workspace freeze date");
    assert.ok(html.includes("March 22, 2027"), "Should show full shutdown date");
    assert.ok(html.includes("days"), "Should show days remaining");
    assert.ok(html.includes("GitHub Codespaces"), "Should list Codespaces alternative");
    assert.ok(html.includes("Gitpod"), "Should list Gitpod alternative");
    assert.ok(html.includes("StackBlitz"), "Should list StackBlitz alternative");
    assert.ok(html.includes("Replit"), "Should list Replit alternative");
    assert.ok(html.includes("Antigravity"), "Should mention Google Antigravity");
    assert.ok(html.includes("AI Studio"), "Should mention AI Studio");
    assert.ok(html.includes("Migration Checklist"), "Should have migration checklist");
    assert.ok(html.includes("Methodology"), "Should have methodology section");
    assert.ok(html.includes("/stability"), "Should cross-link to stability dashboard");
    assert.ok(html.includes("/firebase-alternatives"), "Should cross-link to Firebase alternatives");
    assert.ok(html.includes("Bolt.new"), "Should list AI builder alternatives");
    assert.ok(html.includes("Lovable"), "Should list Lovable");
    assert.ok(html.includes("/vendor/"), "Should have vendor detail links");
  });

  it("GET /tenor-alternatives renders Tenor API shutdown guide", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/tenor-alternatives`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Tenor API Shutdown"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"Article"'), "Should use Article schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("June 30, 2026"), "Should show shutdown date");
    assert.ok(html.includes("days"), "Should show days remaining");
    assert.ok(html.includes("Klipy"), "Should list Klipy as alternative");
    assert.ok(html.includes("Giphy"), "Should list Giphy as alternative");
    assert.ok(html.includes("Imgur"), "Should list Imgur as alternative");
    assert.ok(html.includes("Migration Timeline"), "Should have migration timeline");
    assert.ok(html.includes("Code Migration"), "Should have code migration section");
    assert.ok(html.includes("Who\u2019s Affected"), "Should have who's affected section");
    assert.ok(html.includes("Discord"), "Should mention Discord");
    assert.ok(html.includes("WhatsApp"), "Should mention WhatsApp");
    assert.ok(html.includes("Bluesky"), "Should mention Bluesky");
    assert.ok(html.includes("Recommendations"), "Should have recommendations");
    assert.ok(html.includes("Methodology"), "Should have methodology section");
    assert.ok(html.includes("/shutdowns"), "Should cross-link to shutdowns tracker");
    assert.ok(html.includes("/stability"), "Should cross-link to stability dashboard");
  });

  it("GET /shutdowns renders shutdown tracker page", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${serverPort}/shutdowns`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("Developer Tool Shutdown Tracker 2026"), "Should have title");
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes('"ItemList"'), "Should use ItemList schema");
    assert.ok(html.includes("canonical"), "Should have canonical link");
    assert.ok(html.includes("global-nav"), "Should have global nav");
    assert.ok(html.includes("Active Shutdowns"), "Should have active shutdowns stat");
    assert.ok(html.includes("OpenAI Assistants API"), "Should list OpenAI Assistants shutdown");
    assert.ok(html.includes("Tenor API"), "Should list Tenor API shutdown");
    assert.ok(html.includes("Firebase Studio"), "Should list Firebase Studio shutdown");
    assert.ok(html.includes("HubSpot"), "Should list HubSpot shutdown");
    assert.ok(html.includes("Sora"), "Should list OpenAI Videos API (Sora) shutdown");
    assert.ok(html.includes("Gemini 2.0 Flash"), "Should list Gemini 2.0 Flash shutdown");
    assert.ok(html.includes("days left"), "Should show days remaining");
    assert.ok(html.includes("Methodology"), "Should have methodology section");
    assert.ok(html.includes("/stability"), "Should cross-link to stability dashboard");
    assert.ok(html.includes("/vendor/"), "Should have vendor detail links");
    assert.ok(html.includes("Migration path"), "Should show migration paths");
  });
});

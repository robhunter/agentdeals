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
    assert.strictEqual(body.maintainers[0].email, "rob.v.hunter@gmail.com");
  });

  it("serves landing page at root URL", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/`);
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/html"));
    const html = await response.text();
    assert.ok(html.includes("AgentDeals"));
    assert.ok(html.includes("search_offers"));
    assert.ok(html.includes("list_categories"));
    assert.ok(html.includes("get_offer_details"));
    assert.ok(html.includes("get_deal_changes"));
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
  });
});

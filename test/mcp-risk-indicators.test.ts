import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("MCP risk_level/stability indicators (issue #969)", () => {
  let serverPort = 0;
  let proc: ChildProcess | null = null;

  function startHttpServer(): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const serverPath = path.join(__dirname, "..", "dist", "serve.js");
      const p = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0" },
      });
      const timeout = setTimeout(() => { p.kill(); reject(new Error("Server startup timeout")); }, 10000);
      p.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) { serverPort = parseInt(match[1], 10); clearTimeout(timeout); resolve(p); }
      });
      p.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
  }

  function parseSSE(text: string): any[] {
    const results: any[] = [];
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        try { results.push(JSON.parse(line.slice(6))); } catch {}
      }
    }
    return results;
  }

  async function mcpCall(sessionId: string | null, msg: object): Promise<{ responses: any[]; sessionId: string | null }> {
    const headers: Record<string, string> = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const res = await fetch(`http://localhost:${serverPort}/mcp`, { method: "POST", headers, body: JSON.stringify(msg) });
    const text = await res.text();
    const newSessionId = res.headers.get("mcp-session-id") || sessionId;
    return { responses: parseSSE(text), sessionId: newSessionId };
  }

  async function initSession(): Promise<string> {
    const { sessionId } = await mcpCall(null, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });
    await mcpCall(sessionId, { jsonrpc: "2.0", method: "notifications/initialized" });
    return sessionId!;
  }

  async function callTool(sessionId: string, id: number, name: string, args: Record<string, unknown>): Promise<any> {
    const { responses } = await mcpCall(sessionId, {
      jsonrpc: "2.0", id, method: "tools/call",
      params: { name, arguments: args },
    });
    return responses.find(r => r.id === id)?.result;
  }

  afterEach(() => { if (proc) { proc.kill(); proc = null; } });

  it("search_deals concise mode includes risk_level and stability", async () => {
    proc = await startHttpServer();
    const sessionId = await initSession();
    const result = await callTool(sessionId, 2, "search_deals", {
      category: "Databases", limit: 3, response_format: "concise",
    });
    const body = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(body.results) && body.results.length > 0, "should return results");
    for (const r of body.results) {
      assert.ok(
        ["stable", "caution", "risky"].includes(r.risk_level),
        `concise result for ${r.vendor} should have risk_level, got ${r.risk_level}`
      );
      assert.ok(
        ["stable", "watch", "volatile", "improving"].includes(r.stability),
        `concise result for ${r.vendor} should have stability, got ${r.stability}`
      );
      // Concise mode should still be concise: no full description-free kitchen-sink (no deal_changes array)
      assert.strictEqual(r.deal_changes, undefined, "concise should not include deal_changes");
    }
  });

  it("search_deals detailed mode still includes risk_level and stability (no regression)", async () => {
    proc = await startHttpServer();
    const sessionId = await initSession();
    const result = await callTool(sessionId, 2, "search_deals", {
      category: "Databases", limit: 3,
    });
    const body = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(body.results) && body.results.length > 0);
    for (const r of body.results) {
      assert.ok(["stable", "caution", "risky"].includes(r.risk_level));
      assert.ok(["stable", "watch", "volatile", "improving"].includes(r.stability));
    }
  });

  it("compare_vendors (two vendors) surfaces risk_level and stability at top level", async () => {
    proc = await startHttpServer();
    const sessionId = await initSession();
    const result = await callTool(sessionId, 2, "compare_vendors", {
      vendors: ["Supabase", "Neon"],
    });
    const body = JSON.parse(result.content[0].text);
    assert.ok(body.stability, "should have stability object");
    assert.ok(body.risk_level, "should have risk_level object");
    assert.ok(
      ["stable", "caution", "risky"].includes(body.risk_level["Supabase"]),
      `risk_level.Supabase should be valid, got ${body.risk_level["Supabase"]}`
    );
    assert.ok(
      ["stable", "caution", "risky"].includes(body.risk_level["Neon"]),
      `risk_level.Neon should be valid, got ${body.risk_level["Neon"]}`
    );
    assert.ok(["stable", "watch", "volatile", "improving"].includes(body.stability["Supabase"]));
    assert.ok(["stable", "watch", "volatile", "improving"].includes(body.stability["Neon"]));
  });

  it("plan_stack recommend mode returns risk_level/stability per component and risk_warnings", async () => {
    proc = await startHttpServer();
    const sessionId = await initSession();
    const result = await callTool(sessionId, 2, "plan_stack", {
      mode: "recommend", use_case: "Next.js SaaS app",
    });
    const body = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(body.stack) && body.stack.length > 0, "should return a stack");
    for (const c of body.stack) {
      assert.ok(
        ["stable", "caution", "risky"].includes(c.risk_level),
        `component ${c.vendor} should have risk_level, got ${c.risk_level}`
      );
      assert.ok(
        ["stable", "watch", "volatile", "improving"].includes(c.stability),
        `component ${c.vendor} should have stability, got ${c.stability}`
      );
    }
    assert.ok(Array.isArray(body.risk_warnings), "should have risk_warnings array");
  });
});

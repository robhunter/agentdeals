import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const BACKED_UP_FILES = ["agent_friends.json", "agents.json", "referral_codes.json"];

describe("manage_friends MCP tool via HTTP", () => {
  let serverPort = 0;
  let proc: ChildProcess | null = null;
  const savedContent: Record<string, string | null> = {};

  before(() => {
    for (const f of BACKED_UP_FILES) {
      const p = path.join(DATA_DIR, f);
      savedContent[f] = fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null;
    }
  });

  after(() => {
    for (const f of BACKED_UP_FILES) {
      const p = path.join(DATA_DIR, f);
      const original = savedContent[f];
      if (original !== null) fs.writeFileSync(p, original, "utf-8");
      else if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

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

  it("manage_friends tool is listed in tools/list", async () => {
    proc = await startHttpServer();
    const sessionId = await initSession();
    const { responses } = await mcpCall(sessionId, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const toolsResult = responses.find(r => r.result?.tools);
    assert.ok(toolsResult, "should get tools/list response");
    const names = toolsResult.result.tools.map((t: any) => t.name);
    assert.ok(names.includes("manage_friends"), "manage_friends should be listed");
  });

  it("rejects invalid API key", async () => {
    proc = await startHttpServer();
    const sessionId = await initSession();
    const result = await callTool(sessionId, 2, "manage_friends", { api_key: "bad-key", action: "list" });
    assert.ok(result.isError, "should be an error");
    assert.ok(result.content[0].text.includes("Invalid API key"));
  });

  it("add requires agent_id", async () => {
    proc = await startHttpServer();
    const sessionId = await initSession();
    const regResult = await callTool(sessionId, 2, "register_agent", { name: "TestAdd_" + Date.now() });
    const apiKey = JSON.parse(regResult.content[0].text).api_key;
    const result = await callTool(sessionId, 3, "manage_friends", { api_key: apiKey, action: "add" });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("agent_id is required"));
  });

  it("remove requires agent_id", async () => {
    proc = await startHttpServer();
    const sessionId = await initSession();
    const regResult = await callTool(sessionId, 2, "register_agent", { name: "TestRemove_" + Date.now() });
    const apiKey = JSON.parse(regResult.content[0].text).api_key;
    const result = await callTool(sessionId, 3, "manage_friends", { api_key: apiKey, action: "remove" });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("agent_id is required"));
  });

  it("list returns empty for new agent", async () => {
    proc = await startHttpServer();
    const sessionId = await initSession();
    const regResult = await callTool(sessionId, 2, "register_agent", { name: "TestList_" + Date.now() });
    const apiKey = JSON.parse(regResult.content[0].text).api_key;
    const result = await callTool(sessionId, 3, "manage_friends", { api_key: apiKey, action: "list" });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.strictEqual(data.action, "list");
    assert.strictEqual(data.total, 0);
  });

  it("full lifecycle: add → list → codes → remove", async () => {
    proc = await startHttpServer();
    const sessionId = await initSession();
    const ts = Date.now();

    const reg1 = JSON.parse((await callTool(sessionId, 2, "register_agent", { name: "A1_" + ts })).content[0].text);
    const reg2 = JSON.parse((await callTool(sessionId, 3, "register_agent", { name: "A2_" + ts })).content[0].text);

    // Add
    const addResult = await callTool(sessionId, 4, "manage_friends", { api_key: reg1.api_key, action: "add", agent_id: reg2.id });
    assert.ok(!addResult.isError, "add should succeed");
    const addData = JSON.parse(addResult.content[0].text);
    assert.strictEqual(addData.action, "added");

    // List
    const listData = JSON.parse((await callTool(sessionId, 5, "manage_friends", { api_key: reg1.api_key, action: "list" })).content[0].text);
    assert.strictEqual(listData.total, 1);
    assert.strictEqual(listData.friends[0].friend_id, reg2.id);

    // Codes
    const codesData = JSON.parse((await callTool(sessionId, 6, "manage_friends", { api_key: reg1.api_key, action: "codes" })).content[0].text);
    assert.strictEqual(codesData.action, "codes");
    assert.ok(Array.isArray(codesData.vendors));

    // Remove
    const removeData = JSON.parse((await callTool(sessionId, 7, "manage_friends", { api_key: reg1.api_key, action: "remove", agent_id: reg2.id })).content[0].text);
    assert.strictEqual(removeData.action, "removed");

    // Verify empty
    const afterData = JSON.parse((await callTool(sessionId, 8, "manage_friends", { api_key: reg1.api_key, action: "list" })).content[0].text);
    assert.strictEqual(afterData.total, 0);
  });

  it("cannot add yourself as friend", async () => {
    proc = await startHttpServer();
    const sessionId = await initSession();
    const reg = JSON.parse((await callTool(sessionId, 2, "register_agent", { name: "Self_" + Date.now() })).content[0].text);
    const result = await callTool(sessionId, 3, "manage_friends", { api_key: reg.api_key, action: "add", agent_id: reg.id });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("Cannot add yourself"));
  });

  it("duplicate add returns error", async () => {
    proc = await startHttpServer();
    const sessionId = await initSession();
    const ts = Date.now();
    const reg1 = JSON.parse((await callTool(sessionId, 2, "register_agent", { name: "Dup1_" + ts })).content[0].text);
    const reg2 = JSON.parse((await callTool(sessionId, 3, "register_agent", { name: "Dup2_" + ts })).content[0].text);

    await callTool(sessionId, 4, "manage_friends", { api_key: reg1.api_key, action: "add", agent_id: reg2.id });
    const result = await callTool(sessionId, 5, "manage_friends", { api_key: reg1.api_key, action: "add", agent_id: reg2.id });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("Already friends"));
  });
});

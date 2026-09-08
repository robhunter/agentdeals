import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_TOOLS, MCP_TOOLS_WITHDRAWN, MCP_TOOL_COUNT, MCP_TOOL_NAMES } from "../dist/mcp-tool-inventory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SOURCE = path.join(__dirname, "..", "src", "server.ts");
const REMOTE_SERVER_SOURCE = path.join(__dirname, "..", "src", "server-remote.ts");
const MANIFEST = path.join(__dirname, "..", "manifest.json");
const GLAMA = path.join(__dirname, "..", "glama.json");

const INTEGRATION_GUIDE_PATHS = ["/guides/langchain", "/guides/crewai", "/guides/n8n", "/guides/vercel-ai-sdk"];

const CAPABILITY_DENIALS = [
  /not enabled yet/i,
  /not yet configured/i,
  /no transfer provider/i,
  /is not available yet/i,
  /coming soon/i,
];

function registeredToolNames(sourcePath: string): string[] {
  const source = readFileSync(sourcePath, "utf8");
  return [...source.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)].map(([, name]) => name).sort();
}

describe("what tools/list publishes is what the product offers", () => {
  let serverPort = 0;
  let proc: ChildProcess | null = null;

  function startServer(): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const p = spawn("node", [path.join(__dirname, "..", "dist", "serve.js")], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
      });
      const timeout = setTimeout(() => { p.kill(); reject(new Error("Server startup timeout")); }, 15000);
      p.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) { serverPort = parseInt(match[1], 10); clearTimeout(timeout); resolve(p); }
      });
      p.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
  }

  function parseSSE(text: string): any[] {
    const out: any[] = [];
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        try { out.push(JSON.parse(line.slice(6))); } catch { /* not a JSON frame */ }
      }
    }
    return out;
  }

  async function mcpCall(sessionId: string | null, msg: object): Promise<{ responses: any[]; sessionId: string | null; raw: string }> {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const res = await fetch(`http://localhost:${serverPort}/mcp`, { method: "POST", headers, body: JSON.stringify(msg) });
    const raw = await res.text();
    return { responses: parseSSE(raw), sessionId: res.headers.get("mcp-session-id") || sessionId, raw };
  }

  async function openSession(): Promise<string> {
    const { sessionId } = await mcpCall(null, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tool-inventory-test", version: "1.0" } },
    });
    assert.ok(sessionId, "the server must open a session");
    await mcpCall(sessionId, { jsonrpc: "2.0", method: "notifications/initialized" });
    return sessionId!;
  }

  async function listedTools(): Promise<{ tools: any[]; bytes: number }> {
    const sessionId = await openSession();
    const { responses, raw } = await mcpCall(sessionId, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const result = responses.find((r) => r.id === 2)?.result;
    assert.ok(result, "tools/list must answer");
    return { tools: result.tools, bytes: Buffer.byteLength(raw, "utf8") };
  }

  async function localHtml(pathname: string): Promise<string> {
    const res = await fetch(`http://localhost:${serverPort}${pathname}`, { redirect: "error" });
    assert.strictEqual(res.status, 200, `${pathname} answered ${res.status} on the server under test`);
    return res.text();
  }

  before(async () => { proc = await startServer(); });
  after(() => { proc?.kill(); });

  it("offers the registry's tools and nothing else", async () => {
    const { tools, bytes } = await listedTools();
    const served = tools.map((t: any) => t.name).sort();
    assert.deepStrictEqual(served, [...MCP_TOOL_NAMES].sort());
    console.log(`tools/list: ${served.length} tools, ${bytes} bytes`);
  });

  it("offers no tool the product has withdrawn", async () => {
    const { tools } = await listedTools();
    const served = new Set(tools.map((t: any) => t.name));
    assert.ok(MCP_TOOLS_WITHDRAWN.length >= 7, "seven tools were withdrawn with the marketplace; the register must still name them");
    const published = new Set(MCP_TOOL_NAMES);
    for (const { name, reason } of MCP_TOOLS_WITHDRAWN) {
      assert.ok(!published.has(name), `${name} is in both registers`);
      assert.ok(reason.length > 20, `${name} is withdrawn without a reason a reader can use`);
    }
    for (const { name, reason } of MCP_TOOLS_WITHDRAWN) {
      assert.ok(!served.has(name), `${name} is still offered — ${reason}`);
    }
  });

  it("describes no capability that does not work, on any surface that describes one", async () => {
    const { tools } = await listedTools();
    const withdrawn = MCP_TOOLS_WITHDRAWN.map((t) => t.name);
    const described: { where: string; text: string }[] = [
      ...tools.map((t: any) => ({ where: `tools/list ${t.name}`, text: `${t.description ?? ""} ${JSON.stringify(t.inputSchema ?? {})}` })),
      ...MCP_TOOLS.flatMap((t) => [
        { where: `registry ${t.name}.card`, text: t.card },
        { where: `registry ${t.name}.brief`, text: t.brief },
      ]),
    ];
    assert.ok(described.length >= tools.length + MCP_TOOLS.length * 2, "every published description must be read here");

    for (const { where, text } of described) {
      for (const denial of CAPABILITY_DENIALS) {
        assert.ok(!denial.test(text), `${where} advertises something that does not work: ${denial}`);
      }
      for (const gone of withdrawn) {
        assert.ok(!text.includes(gone), `${where} points the caller at ${gone}, which is withdrawn`);
      }
    }
  });

  it("registers exactly what it publishes, on both servers we ship", () => {
    assert.deepStrictEqual(registeredToolNames(SERVER_SOURCE), [...MCP_TOOL_NAMES].sort(), "the hosted server registers a different set");
    assert.deepStrictEqual(registeredToolNames(REMOTE_SERVER_SOURCE), [...MCP_TOOL_NAMES].sort(), "the published stdio server registers a different set");
  });

  it("the registry manifests we file with directories name the same tools", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    assert.deepStrictEqual(
      manifest.tools.map((t: any) => t.name).sort(),
      [...MCP_TOOL_NAMES].sort(),
      "manifest.json names a different set",
    );
    for (const tool of MCP_TOOLS) {
      const filed = manifest.tools.find((t: any) => t.name === tool.name);
      assert.strictEqual(filed.description, tool.card, `manifest.json describes ${tool.name} differently`);
    }

    const glama = JSON.parse(readFileSync(GLAMA, "utf8"));
    assert.strictEqual(glama.tools, MCP_TOOL_COUNT, "glama.json states a different count");
    assert.match(glama.description, new RegExp(`\\b${MCP_TOOL_COUNT} intent-based MCP tools\\b`), "glama.json's description states a different count");
  });

  it("the server card names the same tools", async () => {
    for (const cardPath of ["/.well-known/mcp.json", "/.well-known/mcp/server-card.json", "/.well-known/mcp"]) {
      const card = await (await fetch(`http://localhost:${serverPort}${cardPath}`)).json();
      const named = card.tools.map((t: any) => t.name).sort();
      assert.deepStrictEqual(named, [...MCP_TOOL_NAMES].sort(), `${cardPath} names a different set`);
      assert.match(card.description, new RegExp(`\\b${MCP_TOOL_COUNT} intent-based MCP tools\\b`), `${cardPath} states a different count`);
    }
  });

  it("every page that counts the tools agrees with the protocol", async () => {
    const { tools } = await listedTools();
    const offered = tools.length;

    const home = await localHtml("/");
    const tile = home.match(/<div class="stat-num stat-cyan">(\d+)<\/div><div class="stat-label">MCP Tools<\/div>/);
    assert.ok(tile, "the homepage must still publish an MCP tool count");
    assert.strictEqual(Number(tile[1]), offered, "the homepage stat tile disagrees with tools/list");

    const heading = home.match(/>(\d+) MCP Tools<\/h3>/);
    assert.ok(heading, "the homepage must still publish its tool list");
    assert.strictEqual(Number(heading[1]), offered, "the homepage tool block disagrees with tools/list");

    const blockStart = home.indexOf("MCP Tools</h3>");
    const block = home.slice(blockStart, blockStart + 4000);
    const listed = [...block.matchAll(/<code style="font-family:var\(--mono\);color:var\(--accent\)">([a-z_]+)<\/code>/g)].map(([, name]) => name);
    assert.deepStrictEqual(listed, [...MCP_TOOL_NAMES], "the homepage tool block lists a different set");
    for (const tool of MCP_TOOLS) {
      assert.ok(block.includes(tool.card.replace(/&/g, "&amp;")), `the homepage tool block does not describe ${tool.name}`);
    }

    const setup = await localHtml("/setup");
    const setupCount = setup.match(/(\d+) MCP tools for searching deals/);
    assert.ok(setupCount, "/setup must still state a tool count");
    assert.strictEqual(Number(setupCount[1]), offered, "/setup disagrees with tools/list");

    const llms = await localHtml("/llms.txt");
    const llmsCount = llms.match(/## MCP Tools \((\d+)\)/);
    assert.ok(llmsCount, "/llms.txt must still state a tool count");
    assert.strictEqual(Number(llmsCount[1]), offered, "/llms.txt disagrees with tools/list");
    for (const tool of MCP_TOOLS) {
      assert.ok(llms.includes(`- **${tool.name}**: ${tool.brief}`), `/llms.txt omits ${tool.name}`);
    }

    for (const guidePath of INTEGRATION_GUIDE_PATHS) {
      const guide = await localHtml(guidePath);
      const intro = guide.match(/provides <strong>(\d+) MCP tools<\/strong>/);
      assert.ok(intro, `${guidePath} must still state a tool count`);
      assert.strictEqual(Number(intro[1]), offered, `${guidePath}'s intro disagrees with tools/list`);
      const available = guide.match(/AgentDeals exposes (\d+) MCP tools/);
      assert.ok(available, `${guidePath} must still list its tools`);
      assert.strictEqual(Number(available[1]), offered, `${guidePath}'s tool section disagrees with tools/list`);

      const cards = guide.slice(guide.indexOf('<div class="tools-ref">'), guide.indexOf("</div>\n  <p style", guide.indexOf('<div class="tools-ref">')));
      assert.ok(cards.length > 0, `${guidePath} has no tool cards to read`);
      for (const name of MCP_TOOL_NAMES) {
        assert.ok(cards.includes(`<code>${name}</code>`), `${guidePath}'s tool cards omit ${name}`);
      }
      assert.strictEqual((cards.match(/class="tool-card"/g) ?? []).length, offered, `${guidePath} renders a different number of tool cards`);
    }
  });

  it("still answers on every tool it offers", async () => {
    const sessionId = await openSession();
    const calls: Record<string, object> = {
      search_deals: { query: "database", limit: 2 },
      plan_stack: { mode: "recommend", use_case: "SaaS app" },
      compare_vendors: { vendors: ["Railway"] },
      track_changes: { since: "2026-01-01" },
      get_referral_code: { vendor: "Railway" },
    };
    assert.deepStrictEqual(Object.keys(calls).sort(), [...MCP_TOOL_NAMES].sort(), "every offered tool needs a call here");

    for (const [name, args] of Object.entries(calls)) {
      const { responses } = await mcpCall(sessionId, { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name, arguments: args } });
      const result = responses.find((r) => r.id === 10)?.result;
      assert.ok(result, `${name} returned no result`);
      assert.ok(!result.isError, `${name} answered with an error: ${JSON.stringify(result.content)}`);
    }
  });

  it("still resolves the codes we hold, and states no attribution", async () => {
    const sessionId = await openSession();
    const { responses } = await mcpCall(sessionId, {
      jsonrpc: "2.0", id: 11, method: "tools/call",
      params: { name: "get_referral_code", arguments: { vendor: "Railway" } },
    });
    const result = responses.find((r) => r.id === 11)?.result;
    const answer = JSON.parse(result.content[0].text);
    assert.strictEqual(answer.referral_code, "7RZL9q");
    assert.match(answer.referral_url, /railway\.com/);
    for (const gone of ["attributed", "attribution", "attribution_note"]) {
      assert.ok(!(gone in answer), `get_referral_code still reports ${gone}, which nothing can now record`);
    }
  });
});

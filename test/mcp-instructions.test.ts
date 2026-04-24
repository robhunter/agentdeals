import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_INSTRUCTIONS } from "../dist/mcp-instructions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("MCP_INSTRUCTIONS constant (issue #977)", () => {
  it("is between 200 and 400 words", () => {
    const wc = MCP_INSTRUCTIONS.split(/\s+/).filter(Boolean).length;
    assert.ok(wc >= 200 && wc <= 400, `expected 200-400 words, got ${wc}`);
  });

  it("covers identity, trigger conditions, tool selection, and unique value", () => {
    assert.match(MCP_INSTRUCTIONS, /AgentDeals/);
    assert.match(MCP_INSTRUCTIONS, /1,500\+/);
    assert.match(MCP_INSTRUCTIONS, /66 .*categor/i);
    assert.match(MCP_INSTRUCTIONS, /search_deals/);
    assert.match(MCP_INSTRUCTIONS, /plan_stack/);
    assert.match(MCP_INSTRUCTIONS, /compare_vendors/);
    assert.match(MCP_INSTRUCTIONS, /track_changes/);
    assert.match(MCP_INSTRUCTIONS, /verified/i);
    assert.match(MCP_INSTRUCTIONS, /pricing change/i);
  });
});

describe("MCP initialize response includes instructions (issue #977)", () => {
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
        try { results.push(JSON.parse(line.slice(6))); } catch { /* ignore */ }
      }
    }
    return results;
  }

  before(async () => {
    proc = await startHttpServer();
  });

  after(() => {
    if (proc) proc.kill();
  });

  it("returns instructions in the initialize result", async () => {
    const res = await fetch(`http://localhost:${serverPort}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
      }),
    });
    const text = await res.text();
    const responses = parseSSE(text);
    assert.ok(responses.length > 0, "expected at least one SSE response");
    const initResp = responses.find((r) => r.id === 1);
    assert.ok(initResp, "expected an initialize response with id 1");
    assert.ok(initResp.result, "expected initialize result");
    assert.strictEqual(initResp.result.instructions, MCP_INSTRUCTIONS, "initialize.result.instructions should match MCP_INSTRUCTIONS");
  });
});

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  classifyMcpClient,
  getSessionClassification,
  recordSessionConnect,
  resetCounters,
  CRAWLER_CLIENT_PATTERNS,
  AGENT_CLIENT_NAMES,
} = await import("../src/stats.ts");

describe("classifyMcpClient heuristic", () => {
  it("classifies every documented crawler pattern as 'crawler'", () => {
    for (const pattern of CRAWLER_CLIENT_PATTERNS) {
      assert.strictEqual(
        classifyMcpClient(pattern),
        "crawler",
        `pattern "${pattern}" should classify as crawler`,
      );
    }
  });

  it("classifies known crawlers by exact name", () => {
    assert.strictEqual(classifyMcpClient("mcpdd"), "crawler");
    assert.strictEqual(classifyMcpClient("glama"), "crawler");
    assert.strictEqual(classifyMcpClient("yellowmcp-health"), "crawler");
    assert.strictEqual(classifyMcpClient("MCPScoringEngine"), "crawler");
    assert.strictEqual(classifyMcpClient("fabrique-noauth-probe"), "crawler");
  });

  it("classifies crawler patterns as substrings anywhere in the name", () => {
    assert.strictEqual(classifyMcpClient("some-random-crawler-v2"), "crawler");
    assert.strictEqual(classifyMcpClient("my-probe-bot"), "crawler");
    assert.strictEqual(classifyMcpClient("acme-registry-lister"), "crawler");
    assert.strictEqual(classifyMcpClient("MCP-Health-Check"), "crawler");
  });

  it("is case-insensitive", () => {
    assert.strictEqual(classifyMcpClient("GLAMA"), "crawler");
    assert.strictEqual(classifyMcpClient("Mcpdd"), "crawler");
    assert.strictEqual(classifyMcpClient("MCPSCORINGENGINE"), "crawler");
  });

  it("classifies every allowlisted agent product as 'agent'", () => {
    for (const name of AGENT_CLIENT_NAMES) {
      assert.strictEqual(
        classifyMcpClient(name),
        "agent",
        `allowlisted name "${name}" should classify as agent`,
      );
    }
  });

  it("counts a name it does not recognise as unattributed rather than as an agent", () => {
    assert.strictEqual(classifyMcpClient("SomeBrandNewClient"), "unattributed");
    assert.strictEqual(classifyMcpClient("Kai"), "unattributed");
    assert.strictEqual(classifyMcpClient("scout"), "unattributed");
    assert.strictEqual(classifyMcpClient("axiom"), "unattributed");
    assert.strictEqual(classifyMcpClient("openclaw"), "unattributed");
  });

  it("counts the generic name every unbranded client sends as unattributed", () => {
    assert.strictEqual(
      classifyMcpClient("mcp"),
      "unattributed",
      "'mcp' is the largest single bucket in production and is not evidence of an agent",
    );
    assert.strictEqual(classifyMcpClient("mcp-client"), "unattributed");
  });

  it("counts an empty or blank name as unattributed", () => {
    assert.strictEqual(classifyMcpClient(""), "unattributed");
    assert.strictEqual(classifyMcpClient("   "), "unattributed");
  });

  it("counts our own traffic apart from everyone else's", () => {
    assert.strictEqual(classifyMcpClient("agentdeals-internal"), "internal");
    assert.strictEqual(classifyMcpClient("agentdeals-monitor"), "internal");
    assert.strictEqual(
      classifyMcpClient("mcpmux-dev.agentdeals-mcp-http"),
      "unattributed",
      "a third party naming us is not our own traffic",
    );
  });

  it("cannot let a missing crawler pattern inflate the agent count", () => {
    for (const name of ["brand-new-scanner-we-have-not-seen", "totally-unknown", "mcpbeat"]) {
      assert.notStrictEqual(
        classifyMcpClient(name),
        "agent",
        `"${name}" must not reach the agent bucket without being allowlisted`,
      );
    }
  });

  it("classifies the monitors and catalogues the two-value rule called agents", () => {
    assert.strictEqual(classifyMcpClient("mcpbeat"), "crawler");
    assert.strictEqual(classifyMcpClient("Smithery Connect"), "crawler");
    assert.strictEqual(classifyMcpClient("AgentIndexBot"), "crawler");
    assert.strictEqual(classifyMcpClient("mcp-indexer"), "crawler");
    assert.strictEqual(classifyMcpClient("mcp-rugpull-research"), "crawler");
    assert.strictEqual(classifyMcpClient("mcpindex-trust"), "crawler");
    assert.strictEqual(
      classifyMcpClient("Mozilla/5.0 (compatible; CensysInspect/1.1; +https://about.censys.io/)"),
      "crawler",
    );
  });

  it("admits a name to the agent bucket only when it matches the allowlist whole", () => {
    for (const name of [
      "opencode-scanner",
      "fake-cursor-probe",
      "not-claude-code",
      "claude-code-registry-crawler",
      "zed-indexer",
    ]) {
      assert.notStrictEqual(
        classifyMcpClient(name),
        "agent",
        `"${name}" merely contains an allowlisted name and must not be counted as one`,
      );
    }
  });

  it("matches the allowlist despite surrounding whitespace and casing", () => {
    assert.strictEqual(classifyMcpClient("  opencode  "), "agent");
    assert.strictEqual(classifyMcpClient("OpenCode"), "agent");
    assert.strictEqual(classifyMcpClient("\tclaude-code\n"), "agent");
  });

  it("keeps the allowlist and the crawler patterns from contradicting each other", () => {
    for (const name of AGENT_CLIENT_NAMES) {
      const matched = CRAWLER_CLIENT_PATTERNS.filter((p: string) => name.includes(p));
      assert.deepStrictEqual(
        matched,
        [],
        `allowlisted "${name}" also matches crawler pattern(s) ${matched.join(", ")} — one of the two lists is wrong`,
      );
    }
  });
});

describe("getSessionClassification aggregation", () => {
  beforeEach(() => {
    resetCounters();
  });

  it("buckets current-deployment sessions by classification and totals correctly", () => {
    recordSessionConnect("mcpdd");
    recordSessionConnect("mcpdd");
    recordSessionConnect("glama");
    recordSessionConnect("opencode");
    recordSessionConnect("Kai");
    recordSessionConnect("scout");
    recordSessionConnect("scout");
    recordSessionConnect("agentdeals-internal");

    const c = getSessionClassification();
    assert.strictEqual(c.sessions_by_type.crawler, 3);
    assert.strictEqual(c.sessions_by_type.agent, 1, "only the allowlisted opencode is an agent");
    assert.strictEqual(c.sessions_by_type.unattributed, 3, "Kai and scout are names we cannot place");
    assert.strictEqual(c.sessions_by_type.internal, 1);
    assert.strictEqual(c.sessions_by_type.total, 8);
  });

  it("totals every bucket, so no session escapes the split", () => {
    for (const name of ["mcpdd", "opencode", "Kai", "agentdeals-monitor", "mcp", ""]) {
      recordSessionConnect(name);
    }
    const t = getSessionClassification().sessions_by_type;
    assert.strictEqual(t.agent + t.crawler + t.internal + t.unattributed, t.total);
    assert.strictEqual(t.total, 6);
  });

  it("publishes the rule it classified by", () => {
    const c = getSessionClassification();
    assert.ok(
      c.classification_rule.includes("allowlist"),
      "a heuristic split must publish its rule",
    );
  });

  it("returns clients_top sorted descending by sessions, capped at 10", () => {
    for (let i = 0; i < 12; i++) {
      const name = `crawler-${i}`;
      for (let j = 0; j <= i; j++) recordSessionConnect(name);
    }
    recordSessionConnect("Kai");
    recordSessionConnect("Kai");
    recordSessionConnect("scout");

    const c = getSessionClassification();
    assert.strictEqual(c.clients_top.length, 10);
    assert.strictEqual(c.clients_top[0].name, "crawler-11");
    assert.strictEqual(c.clients_top[0].sessions, 12);
    assert.strictEqual(c.clients_top[0].type, "crawler");
    for (let i = 1; i < c.clients_top.length; i++) {
      assert.ok(c.clients_top[i - 1].sessions >= c.clients_top[i].sessions);
    }
    for (const entry of c.clients_top) {
      assert.ok(["agent", "crawler", "internal", "unattributed"].includes(entry.type));
    }
  });

  it("does not count a session it cannot attribute as an agent", () => {
    recordSessionConnect();
    recordSessionConnect();
    const c = getSessionClassification();
    assert.strictEqual(c.sessions_by_type.agent, 0);
    assert.strictEqual(c.sessions_by_type.crawler, 0);
    assert.strictEqual(c.sessions_by_type.unattributed, 2);
    const unknown = c.clients_top.find(e => e.name === "unknown");
    assert.ok(unknown);
    assert.strictEqual(unknown.type, "unattributed");
  });

  it("returns empty buckets when no sessions have been recorded", () => {
    const c = getSessionClassification();
    assert.strictEqual(c.sessions_by_type.agent, 0);
    assert.strictEqual(c.sessions_by_type.crawler, 0);
    assert.strictEqual(c.sessions_by_type.internal, 0);
    assert.strictEqual(c.sessions_by_type.unattributed, 0);
    assert.strictEqual(c.sessions_by_type.total, 0);
    assert.deepStrictEqual(c.clients_top, []);
  });
});

describe("GET /api/metrics — sessions_by_type + clients_top", () => {
  let serverPort = 0;
  let serverProc: ChildProcess;

  before(async () => {
    serverProc = await new Promise<ChildProcess>((resolve, reject) => {
      const serverPath = path.join(__dirname, "..", "dist", "serve.js");
      const proc = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
      });
      const timeout = setTimeout(() => { proc.kill(); reject(new Error("Server startup timeout")); }, 15000);
      proc.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) {
          serverPort = parseInt(match[1], 10);
          clearTimeout(timeout);
          resolve(proc);
        }
      });
      proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
  });

  after(() => {
    serverProc?.kill();
  });

  it("returns sessions_by_type block with agent/crawler/total numeric fields", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/metrics`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as any;
    assert.ok(body.sessions_by_type, "sessions_by_type block missing");
    for (const field of ["agent", "crawler", "internal", "unattributed", "total"]) {
      assert.strictEqual(typeof body.sessions_by_type[field], "number", `${field} must be a number`);
    }
    assert.strictEqual(
      body.sessions_by_type.agent +
        body.sessions_by_type.crawler +
        body.sessions_by_type.internal +
        body.sessions_by_type.unattributed,
      body.sessions_by_type.total,
    );
    assert.strictEqual(typeof body.classification_rule, "string");
  });

  it("returns clients_top as an array where each entry has name, sessions, type", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/metrics`);
    const body = await res.json() as any;
    assert.ok(Array.isArray(body.clients_top), "clients_top must be an array");
    assert.ok(body.clients_top.length <= 10, "clients_top must be capped at 10");
    for (const entry of body.clients_top) {
      assert.strictEqual(typeof entry.name, "string");
      assert.strictEqual(typeof entry.sessions, "number");
      assert.ok(
        ["agent", "crawler", "internal", "unattributed"].includes(entry.type),
        `unexpected entry.type ${entry.type}`,
      );
    }
    for (let i = 1; i < body.clients_top.length; i++) {
      assert.ok(body.clients_top[i - 1].sessions >= body.clients_top[i].sessions);
    }
  });

  it("keeps cumulative_sessions unchanged and total <= cumulative_sessions", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/metrics`);
    const body = await res.json() as any;
    assert.strictEqual(typeof body.cumulative_sessions, "number");
    assert.ok(body.sessions_by_type.total <= body.cumulative_sessions);
  });

  it("still returns existing blocks (backward-compat)", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/metrics`);
    const body = await res.json() as any;
    assert.strictEqual(typeof body.cumulative_tool_calls, "number");
    assert.strictEqual(typeof body.cumulative_api_hits, "number");
    assert.ok(body.referral_marketplace, "referral_marketplace block must still be present");
  });
});

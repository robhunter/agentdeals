import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("auditStack logic", () => {
  it("analyzes known vendors and returns structured result", async () => {
    const { auditStack } = await import("../dist/data.js");
    const result = auditStack(["Vercel", "Supabase"]);
    assert.strictEqual(result.services_analyzed, 2);
    assert.ok(Array.isArray(result.services));
    assert.strictEqual(result.services.length, 2);
    assert.ok(Array.isArray(result.gaps));
    assert.ok(Array.isArray(result.recommendations));
    assert.ok(typeof result.risks_found === "number");
    assert.ok(typeof result.savings_opportunities === "number");

    for (const svc of result.services) {
      assert.strictEqual(svc.status, "found");
      assert.ok(svc.category);
      assert.ok(svc.risk_level);
    }
  });

  it("handles unknown vendors gracefully", async () => {
    const { auditStack } = await import("../dist/data.js");
    const result = auditStack(["Vercel", "NonExistentVendor123"]);
    assert.strictEqual(result.services_analyzed, 2);
    const unknown = result.services.find(s => s.vendor === "NonExistentVendor123");
    assert.ok(unknown);
    assert.strictEqual(unknown.status, "not_found");
  });

  it("detects gaps in infrastructure coverage", async () => {
    const { auditStack } = await import("../dist/data.js");
    // Only providing a hosting vendor — should detect gaps in databases, auth, etc.
    const result = auditStack(["Vercel"]);
    assert.ok(result.gaps.length > 0, "Should detect missing categories");
    for (const gap of result.gaps) {
      assert.ok(gap.category);
      assert.ok(gap.recommendation.vendor);
      assert.ok(gap.recommendation.tier);
    }
  });

  it("detects risk from deal changes", async () => {
    const { auditStack } = await import("../dist/data.js");
    // Vercel has pricing_restructured, Supabase has limits_reduced — both are caution
    const result = auditStack(["Vercel", "Supabase"]);
    assert.ok(result.risks_found >= 2, `Should find at least 2 risks, got ${result.risks_found}`);
    const vercel = result.services.find(s => s.vendor === "Vercel");
    assert.ok(vercel);
    assert.strictEqual(vercel.risk_level, "caution");
  });

  it("includes recommendations for risky/caution vendors", async () => {
    const { auditStack } = await import("../dist/data.js");
    const result = auditStack(["Vercel", "Supabase"]);
    assert.ok(result.recommendations.length > 0, "Should have recommendations");
  });

  it("finds cheaper alternatives", async () => {
    const { auditStack } = await import("../dist/data.js");
    const result = auditStack(["Vercel", "Supabase", "Clerk"]);
    const withAlternatives = result.services.filter(s => s.cheaper_alternative);
    assert.ok(withAlternatives.length > 0, "Should find at least one cheaper alternative");
  });

  it("handles empty services array edge case", async () => {
    const { auditStack } = await import("../dist/data.js");
    const result = auditStack([]);
    assert.strictEqual(result.services_analyzed, 0);
    assert.strictEqual(result.services.length, 0);
    assert.ok(result.gaps.length > 0, "All categories should be gaps with no services");
  });
});

describe("audit_stack MCP tool via stdio", () => {
  let proc: ChildProcess | null = null;

  afterEach(() => {
    if (proc) { proc.kill(); proc = null; }
  });

  it("audit_stack is listed in tools/list", async () => {
    const serverPath = path.join(__dirname, "..", "dist", "index.js");
    proc = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "pipe"] });

    const initMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });

    const initedMsg = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    const listTools = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    const response = await new Promise<string>((resolve, reject) => {
      let data = "";
      const timeout = setTimeout(() => reject(new Error("Timeout")), 10000);
      proc!.stdout!.on("data", (chunk: Buffer) => {
        data += chunk.toString();
        const lines = data.split("\n").filter(Boolean);
        if (lines.length >= 2) {
          clearTimeout(timeout);
          resolve(lines[1]);
        }
      });
      proc!.stdin!.write(initMsg + "\n");
      proc!.stdin!.write(initedMsg + "\n");
      proc!.stdin!.write(listTools + "\n");
    });

    const parsed = JSON.parse(response);
    assert.strictEqual(parsed.id, 2);
    const tools = parsed.result.tools;
    const planTool = tools.find((t: any) => t.name === "plan_stack");
    assert.ok(planTool, "plan_stack should be in tools list");
    assert.ok(planTool.description.includes("audit") || planTool.description.includes("stack"), "Description should mention audit or stack");
    assert.ok(planTool.inputSchema.properties.mode, "Should have mode input parameter");
  });
});

describe("audit_stack REST endpoint", () => {
  let serverPort = 0;
  let proc: ChildProcess | null = null;

  function startHttpServer(): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const serverPath = path.join(__dirname, "..", "dist", "serve.js");
      const p = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0" },
      });
      const timeout = setTimeout(() => { p.kill(); reject(new Error("Server startup timeout")); }, 5000);
      p.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) { serverPort = parseInt(match[1], 10); clearTimeout(timeout); resolve(p); }
      });
      p.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
  }

  afterEach(() => {
    if (proc) { proc.kill(); proc = null; }
  });

  it("GET /api/audit-stack returns audit results", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/api/audit-stack?services=Vercel,Supabase`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("access-control-allow-origin"), "*");
    const body = await response.json() as any;
    assert.strictEqual(body.services_analyzed, 2);
    assert.ok(Array.isArray(body.services));
    assert.ok(Array.isArray(body.gaps));
    assert.ok(Array.isArray(body.recommendations));
    assert.ok(typeof body.risks_found === "number");
    assert.ok(typeof body.savings_opportunities === "number");
  });

  it("GET /api/audit-stack returns 400 without services parameter", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/api/audit-stack`);
    assert.strictEqual(response.status, 400);
    const body = await response.json() as any;
    assert.ok(body.error.includes("services"));
  });
});

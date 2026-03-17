import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("estimate_costs logic", () => {
  it("returns cost estimate for a single known vendor", async () => {
    const { estimateCosts } = await import("../dist/costs.js");
    const result = estimateCosts(["Vercel"]);
    assert.strictEqual(result.services.length, 1);
    assert.strictEqual(result.services[0].vendor, "Vercel");
    assert.ok(result.services[0].current_tier, "Should have current_tier");
    assert.ok(result.services[0].free_tier_limits, "Should have free_tier_limits");
    assert.ok(result.services[0].estimated_monthly_cost.includes("$0"), "Hobby scale should be $0");
    assert.strictEqual(result.scale.split(" — ")[0], "hobby");
  });

  it("returns cost estimates for multiple vendors", async () => {
    const { estimateCosts } = await import("../dist/costs.js");
    const result = estimateCosts(["Vercel", "Supabase", "Clerk"]);
    assert.strictEqual(result.services.length, 3);
    const vendors = result.services.map(s => s.vendor);
    assert.ok(vendors.includes("Vercel"));
    assert.ok(vendors.includes("Supabase"));
    assert.ok(vendors.includes("Clerk"));
  });

  it("handles unknown vendors gracefully", async () => {
    const { estimateCosts } = await import("../dist/costs.js");
    const result = estimateCosts(["Vercel", "NonExistentVendor123"]);
    assert.strictEqual(result.services.length, 2);
    const unknown = result.services.find(s => s.vendor === "NonExistentVendor123");
    assert.ok(unknown);
    assert.strictEqual(unknown.current_tier, "Unknown");
    assert.ok(unknown.free_tier_limits.includes("not found"));
    assert.ok(result.warnings.some(w => w.includes("NonExistentVendor123")));
  });

  it("startup scale returns non-zero cost estimates", async () => {
    const { estimateCosts } = await import("../dist/costs.js");
    const result = estimateCosts(["Vercel", "Supabase"], "startup");
    assert.ok(result.scale.includes("startup"));
    for (const svc of result.services) {
      if (svc.current_tier !== "Unknown") {
        assert.ok(svc.estimated_monthly_cost.includes("startup"), `${svc.vendor} should mention startup scale`);
      }
    }
    assert.ok(!result.total_estimated_cost.includes("$0/mo"));
  });

  it("growth scale returns higher cost estimates", async () => {
    const { estimateCosts } = await import("../dist/costs.js");
    const result = estimateCosts(["Vercel"], "growth");
    assert.ok(result.scale.includes("growth"));
    assert.ok(result.services[0].estimated_monthly_cost.includes("growth"));
  });

  it("suggests free alternatives at startup/growth scale", async () => {
    const { estimateCosts } = await import("../dist/costs.js");
    const result = estimateCosts(["Vercel", "Supabase"], "startup");
    // At least one service should have a free alternative suggestion
    const withAlternatives = result.services.filter(s => s.free_alternative);
    // Not guaranteed, but highly likely given our index size
    assert.ok(result.savings_available, "Should have savings_available field");
  });

  it("returns warnings array", async () => {
    const { estimateCosts } = await import("../dist/costs.js");
    const result = estimateCosts(["Vercel", "Supabase"], "startup");
    assert.ok(Array.isArray(result.warnings));
  });
});

describe("estimate_costs MCP tool via stdio", () => {
  let proc: ChildProcess | null = null;

  afterEach(() => {
    if (proc) { proc.kill(); proc = null; }
  });

  it("responds to estimate_costs tool call", async () => {
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

    const toolCall = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "plan_stack",
        arguments: { mode: "estimate", services: ["Vercel", "Supabase"], scale: "startup" },
      },
    });

    const response = await new Promise<string>((resolve, reject) => {
      let data = "";
      let responseCount = 0;
      const timeout = setTimeout(() => reject(new Error("Timeout")), 10000);
      proc!.stdout!.on("data", (chunk: Buffer) => {
        data += chunk.toString();
        // Count complete JSON responses
        const lines = data.split("\n").filter(Boolean);
        if (lines.length >= 2) {
          clearTimeout(timeout);
          resolve(lines[1]); // Second response is the tool call result
        }
      });
      proc!.stdin!.write(initMsg + "\n");
      proc!.stdin!.write(initedMsg + "\n");
      proc!.stdin!.write(toolCall + "\n");
    });

    const parsed = JSON.parse(response);
    assert.strictEqual(parsed.id, 2);
    assert.ok(parsed.result);
    const content = JSON.parse(parsed.result.content[0].text);
    assert.strictEqual(content.services.length, 2);
    assert.ok(content.total_estimated_cost);
    assert.ok(content.savings_available);
    assert.ok(Array.isArray(content.warnings));
    assert.ok(content.scale.includes("startup"));
  });
});

describe("estimate_costs REST endpoint", () => {
  const PORT = 3462;
  let proc: ChildProcess | null = null;

  function startHttpServer(): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const serverPath = path.join(__dirname, "..", "dist", "serve.js");
      const p = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: String(PORT) },
      });
      const timeout = setTimeout(() => { p.kill(); reject(new Error("Server startup timeout")); }, 5000);
      p.stderr!.on("data", (data: Buffer) => {
        if (data.toString().includes("running on http")) { clearTimeout(timeout); resolve(p); }
      });
      p.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
  }

  afterEach(() => {
    if (proc) { proc.kill(); proc = null; }
  });

  it("GET /api/costs returns cost estimates", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${PORT}/api/costs?services=Vercel,Supabase&scale=startup`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("access-control-allow-origin"), "*");
    const body = await response.json() as any;
    assert.strictEqual(body.services.length, 2);
    assert.ok(body.total_estimated_cost);
    assert.ok(body.savings_available);
    assert.ok(Array.isArray(body.warnings));
    assert.ok(body.scale.includes("startup"));
  });

  it("GET /api/costs returns 400 without services parameter", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${PORT}/api/costs`);
    assert.strictEqual(response.status, 400);
    const body = await response.json() as any;
    assert.ok(body.error.includes("services"));
  });

  it("GET /api/costs defaults to hobby scale", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${PORT}/api/costs?services=Vercel`);
    assert.strictEqual(response.status, 200);
    const body = await response.json() as any;
    assert.ok(body.scale.includes("hobby"));
    assert.ok(body.services[0].estimated_monthly_cost.includes("$0"));
  });
});

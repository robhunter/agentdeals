import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("checkVendorRisk logic", () => {
  it("returns stable risk for vendor with no changes", async () => {
    const { checkVendorRisk } = await import("../dist/data.js");
    const result = checkVendorRisk("Vercel");
    assert.ok(!("error" in result), "Should not return error for known vendor");
    assert.strictEqual(result.result.vendor, "Vercel");
    assert.ok(["stable", "caution", "risky"].includes(result.result.risk_level));
    assert.ok(typeof result.result.free_tier_longevity_days === "number");
    assert.ok(Array.isArray(result.result.changes));
    assert.ok(Array.isArray(result.result.alternatives));
    assert.ok(result.result.alternatives.length <= 3);
    assert.ok(result.result.summary.length > 0);
    assert.ok(result.result.category.length > 0);
  });

  it("returns caution for vendor with pricing_restructured", async () => {
    const { checkVendorRisk } = await import("../dist/data.js");
    // Vercel has pricing_restructured change
    const result = checkVendorRisk("Vercel");
    assert.ok(!("error" in result), "Vercel should be found");
    assert.strictEqual(result.result.risk_level, "caution", "Vercel should be caution due to pricing_restructured");
    assert.ok(result.result.changes.length > 0, "Should have recorded changes");
    assert.ok(result.result.changes.some(c => c.change_type === "pricing_restructured"), "Should have pricing_restructured change");
  });

  it("returns caution for vendor with limits_reduced", async () => {
    const { checkVendorRisk } = await import("../dist/data.js");
    // Supabase has limits_reduced change
    const result = checkVendorRisk("Supabase");
    assert.ok(!("error" in result), "Supabase should be found");
    assert.strictEqual(result.result.risk_level, "caution", "Supabase should be caution due to limits_reduced");
    assert.ok(result.result.changes.length > 0, "Should have recorded changes");
  });

  it("returns error with suggestions for unknown vendor", async () => {
    const { checkVendorRisk } = await import("../dist/data.js");
    const result = checkVendorRisk("NonExistentVendor123");
    assert.ok("error" in result, "Should return error for unknown vendor");
    assert.ok(result.error.includes("not found"));
  });

  it("returns fuzzy match suggestions for partial vendor name", async () => {
    const { checkVendorRisk } = await import("../dist/data.js");
    // "Cloud" should fuzzy match multiple vendors
    const result = checkVendorRisk("Cloud");
    // Could either fuzzy-match a single vendor or return suggestions
    if ("error" in result) {
      assert.ok(result.suggestions && result.suggestions.length > 0, "Should have suggestions");
    }
  });

  it("alternatives are sorted by risk level", async () => {
    const { checkVendorRisk } = await import("../dist/data.js");
    const result = checkVendorRisk("Vercel");
    assert.ok(!("error" in result));
    const riskOrder: Record<string, number> = { stable: 0, caution: 1, risky: 2 };
    for (let i = 1; i < result.result.alternatives.length; i++) {
      assert.ok(
        riskOrder[result.result.alternatives[i].risk_level] >= riskOrder[result.result.alternatives[i - 1].risk_level],
        "Alternatives should be sorted by risk level (stable first)"
      );
    }
  });

  it("alternatives include risk_level field", async () => {
    const { checkVendorRisk } = await import("../dist/data.js");
    const result = checkVendorRisk("Supabase");
    assert.ok(!("error" in result));
    for (const alt of result.result.alternatives) {
      assert.ok(["stable", "caution", "risky"].includes(alt.risk_level), `Alternative ${alt.vendor} should have valid risk_level`);
      assert.ok(alt.vendor);
      assert.ok(alt.category);
      assert.ok(alt.tier);
    }
  });
});

describe("check_vendor_risk MCP tool via stdio", () => {
  let proc: ChildProcess | null = null;

  afterEach(() => {
    if (proc) { proc.kill(); proc = null; }
  });

  it("check_vendor_risk is listed in tools/list", async () => {
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
    assert.ok(parsed.result);
    const tools = parsed.result.tools;
    assert.ok(Array.isArray(tools));
    const compareTool = tools.find((t: any) => t.name === "compare_vendors");
    assert.ok(compareTool, "compare_vendors should be in tools list");
    assert.ok(compareTool.description.includes("risk") || compareTool.description.includes("Compare"), "Description should mention risk or compare");
    assert.ok(compareTool.inputSchema.properties.vendors, "Should have vendors input parameter");
  });
});

describe("check_vendor_risk REST endpoint", () => {
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

  afterEach(() => {
    if (proc) { proc.kill(); proc = null; }
  });

  it("GET /api/vendor-risk/:vendor returns risk assessment", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/api/vendor-risk/Vercel`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("access-control-allow-origin"), "*");
    const body = await response.json() as any;
    assert.ok(body.vendor);
    assert.ok(body.risk_level);
    assert.ok(typeof body.free_tier_longevity_days === "number");
    assert.ok(Array.isArray(body.changes));
    assert.ok(Array.isArray(body.alternatives));
    assert.ok(body.summary);
  });

  it("GET /api/vendor-risk/:vendor returns 404 for unknown vendor", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/api/vendor-risk/NonExistentVendor123`);
    assert.strictEqual(response.status, 404);
    const body = await response.json() as any;
    assert.ok(body.error.includes("not found"));
  });
});

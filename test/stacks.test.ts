import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("stack recommendation logic", () => {
  it("returns stack for SaaS use case", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("Next.js SaaS app");
    assert.strictEqual(result.use_case, "Next.js SaaS app");
    assert.ok(result.stack.length >= 3, "SaaS stack should have at least 3 components");
    assert.strictEqual(result.total_monthly_cost, "$0");
    assert.ok(Array.isArray(result.limitations));
    assert.ok(typeof result.upgrade_path === "string");

    // Check stack components have required fields
    for (const component of result.stack) {
      assert.ok(component.role, "Should have role");
      assert.ok(component.vendor, "Should have vendor");
      assert.ok(component.tier, "Should have tier");
      assert.ok(component.description, "Should have description");
      assert.ok(component.url, "Should have url");
    }

    // Should include hosting and database roles
    const roles = result.stack.map((c: any) => c.role);
    assert.ok(roles.includes("Hosting"), "SaaS stack should include Hosting");
    assert.ok(roles.includes("Database"), "SaaS stack should include Database");
  });

  it("returns stack for API backend use case", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("Python API backend");
    assert.ok(result.stack.length >= 3);
    const roles = result.stack.map((c: any) => c.role);
    assert.ok(roles.includes("Hosting"));
    assert.ok(roles.includes("Database"));
  });

  it("returns stack for static site use case", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("static blog");
    assert.ok(result.stack.length >= 2);
  });

  it("returns stack for mobile app use case", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("React Native mobile app");
    assert.ok(result.stack.length >= 3);
  });

  it("returns stack for AI/ML use case", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("AI chatbot");
    assert.ok(result.stack.length >= 2);
    const roles = result.stack.map((c: any) => c.role);
    assert.ok(roles.includes("AI/ML"), "AI stack should include AI/ML role");
  });

  it("requirements override template defaults", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("my project", ["database", "monitoring", "search"]);
    assert.strictEqual(result.stack.length, 3);
    const roles = result.stack.map((c: any) => c.role.toLowerCase());
    assert.ok(roles.includes("database"));
    assert.ok(roles.includes("monitoring"));
    assert.ok(roles.includes("search"));
  });

  it("falls back gracefully for unknown use case", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("quantum teleporter management system");
    // Should return fallback stack with common categories
    assert.ok(result.stack.length >= 3);
    assert.strictEqual(result.total_monthly_cost, "$0");
  });

  it("description is capped at 200 characters", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("Next.js SaaS app");
    for (const component of result.stack) {
      assert.ok(component.description.length <= 200, `Description for ${component.vendor} exceeds 200 chars`);
    }
  });

  it("stack components include risk_level and stability fields", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("Next.js SaaS app");
    assert.ok(result.stack.length > 0);
    for (const component of result.stack) {
      assert.ok(
        ["stable", "caution", "risky"].includes(component.risk_level),
        `${component.vendor} risk_level should be stable|caution|risky, got ${component.risk_level}`
      );
      assert.ok(
        ["stable", "watch", "volatile", "improving"].includes(component.stability),
        `${component.vendor} stability should be stable|watch|volatile|improving, got ${component.stability}`
      );
    }
  });

  it("stack includes risk_warnings array", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("Next.js SaaS app");
    assert.ok(Array.isArray(result.risk_warnings));
    // Each warning should name the vendor and role
    for (const w of result.risk_warnings) {
      assert.ok(typeof w === "string");
      assert.ok(w.length > 0);
    }
  });

  it("risk_warnings surfaced when stack contains non-stable components", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("Next.js SaaS app");
    const hasRisky = result.stack.some(
      (c: any) => c.risk_level !== "stable" || c.stability !== "stable"
    );
    if (hasRisky) {
      assert.ok(
        result.risk_warnings.length > 0,
        "risk_warnings should not be empty when stack has non-stable components"
      );
    } else {
      assert.strictEqual(result.risk_warnings.length, 0);
    }
  });
});

describe("stack REST endpoint", () => {
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

  it("GET /api/stack returns stack recommendation", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/api/stack?use_case=SaaS+web+app`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("access-control-allow-origin"), "*");
    const body = await response.json() as any;
    assert.ok(Array.isArray(body.stack));
    assert.ok(body.stack.length >= 3);
    assert.strictEqual(body.total_monthly_cost, "$0");
    assert.ok(Array.isArray(body.limitations));
    assert.ok(typeof body.upgrade_path === "string");
  });

  it("GET /api/stack returns 400 without use_case", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/api/stack`);
    assert.strictEqual(response.status, 400);
    const body = await response.json() as any;
    assert.ok(body.error.includes("use_case"));
  });

  it("GET /api/stack accepts requirements parameter", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/api/stack?use_case=my+app&requirements=database,auth,monitoring`);
    assert.strictEqual(response.status, 200);
    const body = await response.json() as any;
    assert.strictEqual(body.stack.length, 3);
  });
});

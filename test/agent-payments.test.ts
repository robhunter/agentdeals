import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let serverPort = 0;

function startHttpServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 10000);

    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        serverPort = parseInt(match[1], 10);
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

describe("Agent Payments", () => {
  let proc: ChildProcess;

  before(async () => {
    proc = await startHttpServer();
  });

  after(() => {
    proc?.kill();
  });

  describe("GET /api/agent-payments", () => {
    it("returns structured payment protocol data", async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/agent-payments`);
      assert.strictEqual(res.status, 200);
      const body = await res.json() as any;
      assert.ok(body.total > 0, "should have payment-enabled services");
      assert.ok(body.protocols.x402.count > 0, "should have x402 services");
      assert.ok(body.protocols.mpp, "should have mpp protocol info");
      assert.ok(body.protocols.both, "should have both protocol info");
      assert.ok(body.by_category, "should have services grouped by category");
      assert.ok(Array.isArray(body.services), "should have flat services array");
      assert.ok(body.services.length === body.total, "services count matches total");
    });

    it("filters by protocol=x402", async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/agent-payments?protocol=x402`);
      assert.strictEqual(res.status, 200);
      const body = await res.json() as any;
      assert.ok(body.total > 0);
      for (const s of body.services) {
        assert.ok(s.payment_protocols.some((p: any) => p.protocol === "x402"), `${s.vendor} should support x402`);
      }
    });

    it("filters by protocol=mpp", async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/agent-payments?protocol=mpp`);
      assert.strictEqual(res.status, 200);
      const body = await res.json() as any;
      assert.ok(body.total > 0);
      for (const s of body.services) {
        assert.ok(s.payment_protocols.some((p: any) => p.protocol === "mpp"), `${s.vendor} should support mpp`);
      }
    });

    it("filters by category", async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/agent-payments?category=Cloud%20Hosting`);
      assert.strictEqual(res.status, 200);
      const body = await res.json() as any;
      for (const s of body.services) {
        assert.strictEqual(s.category, "Cloud Hosting");
      }
    });

    it("returns service details with required fields", async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/agent-payments`);
      const body = await res.json() as any;
      const service = body.services[0];
      assert.ok(service.vendor, "should have vendor");
      assert.ok(service.category, "should have category");
      assert.ok(service.tier, "should have tier");
      assert.ok(service.description, "should have description");
      assert.ok(service.url, "should have url");
      assert.ok(service.payment_protocols, "should have payment_protocols");
      assert.ok(service.stability, "should have stability");
    });

    it("returns empty result for non-matching protocol", async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/agent-payments?protocol=bitcoin`);
      assert.strictEqual(res.status, 200);
      const body = await res.json() as any;
      assert.strictEqual(body.total, 0);
      assert.strictEqual(body.services.length, 0);
    });
  });

  describe("GET /agent-payments page", () => {
    it("returns 200 with HTML", async () => {
      const res = await fetch(`http://localhost:${serverPort}/agent-payments`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers.get("content-type")?.includes("text/html"));
    });

    it("contains JSON-LD structured data", async () => {
      const res = await fetch(`http://localhost:${serverPort}/agent-payments`);
      const html = await res.text();
      assert.ok(html.includes("application/ld+json"), "should have JSON-LD");
      assert.ok(html.includes("FAQPage"), "should have FAQ JSON-LD");
    });

    it("contains protocol comparison table", async () => {
      const res = await fetch(`http://localhost:${serverPort}/agent-payments`);
      const html = await res.text();
      assert.ok(html.includes("Protocol Comparison"), "should have protocol comparison section");
      assert.ok(html.includes("proto-badge x402"), "should have x402 badges");
      assert.ok(html.includes("proto-badge mpp"), "should have mpp badges");
    });

    it("shows both x402 and MPP services", async () => {
      const res = await fetch(`http://localhost:${serverPort}/agent-payments`);
      const html = await res.text();
      assert.ok(html.includes("x402"), "should mention x402");
      assert.ok(html.includes("MPP"), "should mention MPP");
      assert.ok(html.includes("Browserbase"), "should list Browserbase (supports both)");
    });
  });

  describe("MCP search_deals payment_protocol filter", () => {
    it("filters offers by x402 via API", async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/offers?payment_protocol=x402`);
      assert.strictEqual(res.status, 200);
      const body = await res.json() as any;
      assert.ok(body.total > 0, "should have x402 offers");
      for (const o of body.offers) {
        assert.ok(o.payment_protocols?.some((p: any) => p.protocol === "x402"), `${o.vendor} should support x402`);
      }
    });

    it("filters offers by mpp via API", async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/offers?payment_protocol=mpp`);
      assert.strictEqual(res.status, 200);
      const body = await res.json() as any;
      assert.ok(body.total > 0, "should have mpp offers");
      for (const o of body.offers) {
        assert.ok(o.payment_protocols?.some((p: any) => p.protocol === "mpp"), `${o.vendor} should support mpp`);
      }
    });
  });
});

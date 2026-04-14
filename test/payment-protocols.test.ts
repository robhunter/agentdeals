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
    }, 5000);

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

describe("payment protocol features", () => {
  let server: ChildProcess;

  before(async () => {
    server = await startHttpServer();
  });

  after(() => {
    server.kill();
  });

  it("GET /api/offers?payment_protocol=x402 returns only x402 offers", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/offers?payment_protocol=x402&limit=100`);
    assert.strictEqual(res.status, 200);
    const data = await res.json() as { offers: { vendor: string; payment_protocols?: string[] }[]; total: number };
    assert.ok(data.total > 0, "Should have x402 offers");
    for (const offer of data.offers) {
      assert.ok(
        offer.payment_protocols?.some((p: any) => p.protocol === "x402"),
        `${offer.vendor} should have x402 in payment_protocols`
      );
    }
  });

  it("GET /api/offers?payment_protocol=mpp returns MPP vendors", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/offers?payment_protocol=mpp&limit=100`);
    assert.strictEqual(res.status, 200);
    const data = await res.json() as { offers: { vendor: string; payment_protocols?: string[] }[]; total: number };
    assert.ok(data.total > 0, "Should have MPP offers");
    for (const offer of data.offers) {
      assert.ok(
        offer.payment_protocols?.some((p: any) => p.protocol === "mpp"),
        `${offer.vendor} should have mpp in payment_protocols`
      );
    }
  });

  it("GET /api/offers without payment_protocol returns all offers", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/offers?limit=5`);
    assert.strictEqual(res.status, 200);
    const data = await res.json() as { offers: unknown[]; total: number };
    assert.ok(data.total > 12, "Should return more than just x402 offers");
  });

  it("GET /agent-payments returns 200 with correct content", async () => {
    const res = await fetch(`http://localhost:${serverPort}/agent-payments`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("Agent Payments"), "Page should contain title");
    assert.ok(html.includes("x402"), "Page should mention x402 protocol");
    assert.ok(html.includes("MPP"), "Page should mention MPP protocol");
    assert.ok(html.includes("Firecrawl"), "Page should list Firecrawl");
    assert.ok(html.includes("Cloudflare"), "Page should list Cloudflare");
    assert.ok(html.includes("application/ld+json"), "Page should have JSON-LD");
    assert.ok(html.includes("FAQPage"), "Page should have FAQ schema");
  });

  it("GET /agent-payments is in sitemap", async () => {
    const res = await fetch(`http://localhost:${serverPort}/sitemap.xml`);
    const xml = await res.text();
    assert.ok(xml.includes("/agent-payments"), "Sitemap should include /agent-payments");
  });

  it("x402 offers include known vendors", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/offers?payment_protocol=x402&limit=100`);
    const data = await res.json() as { offers: { vendor: string }[]; total: number };
    const vendors = data.offers.map(o => o.vendor);
    assert.ok(vendors.includes("Firecrawl"), "x402 should include Firecrawl");
    assert.ok(vendors.includes("Cloudflare Workers"), "x402 should include Cloudflare Workers");
    assert.ok(vendors.includes("Vercel"), "x402 should include Vercel");
    assert.ok(vendors.includes("Pinata IPFS"), "x402 should include Pinata IPFS");
  });

  it("x402 offers include new x402-native vendors", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/offers?payment_protocol=x402&limit=100`);
    const data = await res.json() as { offers: { vendor: string }[]; total: number };
    const vendors = data.offers.map(o => o.vendor);
    assert.ok(vendors.includes("Exa"), "x402 should include Exa");
    assert.ok(vendors.includes("Hyperbrowser"), "x402 should include Hyperbrowser");
    assert.ok(vendors.includes("OpenVPS"), "x402 should include OpenVPS");
    assert.ok(vendors.includes("GPU-Bridge"), "x402 should include GPU-Bridge");
    assert.ok(vendors.includes("Strale"), "x402 should include Strale");
    assert.ok(vendors.includes("tollbooth"), "x402 should include tollbooth");
  });

  it("payment_protocols contain rich data with chain and settlement", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/offers?payment_protocol=x402&limit=5`);
    const data = await res.json() as { offers: { vendor: string; payment_protocols?: any[] }[] };
    const offer = data.offers[0];
    assert.ok(offer.payment_protocols, "should have payment_protocols");
    const proto = offer.payment_protocols![0];
    assert.strictEqual(proto.protocol, "x402");
    assert.ok(proto.chain, "should have chain");
    assert.ok(proto.settlement, "should have settlement");
    assert.ok(proto.pricing_model, "should have pricing_model");
    assert.ok(proto.example_cost, "should have example_cost");
  });

  it("GET /x402-services returns 200 with correct content", async () => {
    const res = await fetch(`http://localhost:${serverPort}/x402-services`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("x402 Payment Protocol"), "Page should contain title");
    assert.ok(html.includes("Exa"), "Page should list Exa");
    assert.ok(html.includes("Firecrawl"), "Page should list Firecrawl");
    assert.ok(html.includes("Cloudflare"), "Page should list Cloudflare");
    assert.ok(html.includes("application/ld+json"), "Page should have JSON-LD");
    assert.ok(html.includes("FAQPage"), "Page should have FAQ schema");
  });

  it("GET /x402-services is in sitemap", async () => {
    const res = await fetch(`http://localhost:${serverPort}/sitemap.xml`);
    const xml = await res.text();
    assert.ok(xml.includes("/x402-services"), "Sitemap should include /x402-services");
  });
});

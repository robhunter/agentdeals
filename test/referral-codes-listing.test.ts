import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODES_PATH = path.join(__dirname, "..", "data", "referral_codes.json");

const { listAllReferralCodes, resetPlatformCodesCache } = await import("../dist/platform-codes.js");
const { resetReferralCodesCache } = await import("../dist/referral-codes.js");

describe("listAllReferralCodes() helper", () => {
  let origCodes: string;

  before(() => {
    origCodes = fs.existsSync(CODES_PATH) ? fs.readFileSync(CODES_PATH, "utf-8") : "{\"referral_codes\":[]}";
    fs.writeFileSync(CODES_PATH, JSON.stringify({
      referral_codes: [
        {
          id: "code_test_active",
          vendor: "Supabase",
          code: "SUPATEST",
          referral_url: "https://supabase.com/?ref=SUPATEST",
          description: "Agent-submitted Supabase referral",
          commission_rate: null,
          expiry: null,
          submitted_by: "agent_test",
          source: "agent-submitted",
          status: "active",
          trust_tier_at_submission: "new",
          impressions: 0,
          clicks: 0,
          conversions: 0,
          submitted_at: "2026-04-16T00:00:00.000Z",
          updated_at: "2026-04-16T00:00:00.000Z",
        },
        {
          id: "code_test_pending",
          vendor: "Vercel",
          code: "VERCELPENDING",
          referral_url: "https://vercel.com/?ref=VERCELPENDING",
          description: "Pending — should not list",
          commission_rate: null,
          expiry: null,
          submitted_by: "agent_test",
          source: "agent-submitted",
          status: "pending",
          trust_tier_at_submission: "new",
          impressions: 0,
          clicks: 0,
          conversions: 0,
          submitted_at: "2026-04-16T00:00:00.000Z",
          updated_at: "2026-04-16T00:00:00.000Z",
        },
      ],
    }), "utf-8");
    resetReferralCodesCache();
    resetPlatformCodesCache();
  });

  after(() => {
    fs.writeFileSync(CODES_PATH, origCodes, "utf-8");
    resetReferralCodesCache();
    resetPlatformCodesCache();
  });

  it("returns both platform and agent-submitted active codes when no source filter", () => {
    const codes = listAllReferralCodes();
    const platform = codes.filter((c: any) => c.source === "platform");
    const agent = codes.filter((c: any) => c.source === "agent-submitted");
    assert.ok(platform.length >= 1, "should include platform codes (Railway)");
    assert.ok(agent.some((c: any) => c.code === "SUPATEST"), "should include active agent-submitted code");
    assert.ok(!codes.some((c: any) => c.code === "VERCELPENDING"), "pending codes must not appear in listing");
  });

  it("source=platform filter returns only platform codes", () => {
    const codes = listAllReferralCodes({ source: "platform" });
    assert.ok(codes.length >= 1);
    assert.ok(codes.every((c: any) => c.source === "platform"));
  });

  it("source=agent filter returns only agent-submitted codes", () => {
    const codes = listAllReferralCodes({ source: "agent" });
    assert.ok(codes.every((c: any) => c.source === "agent-submitted"));
    assert.ok(codes.some((c: any) => c.code === "SUPATEST"));
  });

  it("resolves category via vendorToCategory callback", () => {
    const codes = listAllReferralCodes({
      vendorToCategory: (v: string) => v === "Railway" ? "Cloud Hosting" : null,
    });
    const railway = codes.find((c: any) => c.vendor === "Railway");
    assert.ok(railway);
    assert.strictEqual(railway.category, "Cloud Hosting");
  });

  it("returned entry shape matches GET /api/referral-codes/:vendor (plus category)", () => {
    const codes = listAllReferralCodes();
    const first = codes[0];
    assert.ok("vendor" in first);
    assert.ok("category" in first);
    assert.ok("code" in first);
    assert.ok("referral_url" in first);
    assert.ok("referee_benefit" in first);
    assert.ok("source" in first);
  });
});

describe("GET /api/referral-codes listing endpoint", () => {
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

  it("returns {codes, total} with at least the Railway platform code", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral-codes`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { codes: any[]; total: number };
    assert.ok(Array.isArray(body.codes));
    assert.strictEqual(typeof body.total, "number");
    assert.strictEqual(body.total, body.codes.length);
    const railway = body.codes.find(c => c.vendor === "Railway");
    assert.ok(railway, "Railway should be listed");
    assert.strictEqual(railway.source, "platform");
    assert.strictEqual(railway.code, "7RZL9q");
    assert.strictEqual(railway.category, "Cloud Hosting");
    assert.ok(railway.referral_url.includes("7RZL9q"));
  });

  it("source=platform returns only platform codes", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral-codes?source=platform`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { codes: any[]; total: number };
    assert.ok(body.codes.every(c => c.source === "platform"));
    assert.ok(body.codes.length >= 1);
  });

  it("source=agent returns only agent-submitted codes", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral-codes?source=agent`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { codes: any[]; total: number };
    assert.ok(body.codes.every(c => c.source === "agent-submitted"));
  });

  it("source=invalid returns 400", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral-codes?source=garbage`);
    assert.strictEqual(res.status, 400);
    const body = await res.json() as { error: string };
    assert.ok(body.error.toLowerCase().includes("source"));
  });

  it("category=cloud-hosting filters to Railway", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral-codes?category=cloud-hosting`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { codes: any[]; total: number };
    assert.ok(body.codes.every(c => c.category === "Cloud Hosting"));
    assert.ok(body.codes.some(c => c.vendor === "Railway"));
  });

  it("category=unknown-slug returns 400", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral-codes?category=not-a-real-category-xyz`);
    assert.strictEqual(res.status, 400);
    const body = await res.json() as { error: string };
    assert.ok(body.error.toLowerCase().includes("unknown category"));
  });

  it("does not collide with /api/referral-codes/mine route (which requires auth)", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral-codes/mine`);
    assert.strictEqual(res.status, 401, "mine route still requires auth");
  });

  it("does not collide with /api/referral-codes/:vendor route", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral-codes/railway`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { vendor: string; source: string };
    assert.strictEqual(body.vendor, "Railway");
    assert.strictEqual(body.source, "platform");
  });
});

describe("/developers page", () => {
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

  it("includes the Referral Marketplace section with the three endpoints", async () => {
    const res = await fetch(`http://localhost:${serverPort}/developers`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("Referral Marketplace"), "missing Referral Marketplace heading");
    assert.ok(html.includes("/api/referral-codes"), "missing /api/referral-codes endpoint");
    assert.ok(html.includes("/api/referral-codes/:vendor") || html.includes("/api/referral-codes/railway"), "missing vendor endpoint");
    assert.ok(html.includes("source=platform"), "missing source filter example");
    assert.ok(html.includes("category=cloud-hosting"), "missing category filter example");
  });

  it("WebAPI JSON-LD advertises the referral-codes service URL", async () => {
    const res = await fetch(`http://localhost:${serverPort}/developers`);
    const html = await res.text();
    assert.ok(html.includes("/api/referral-codes"), "JSON-LD must reference /api/referral-codes");
    assert.ok(html.includes("Referral Code Marketplace"), "JSON-LD should describe the marketplace channel");
  });
});

describe("OpenAPI spec", () => {
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

  it("/api/openapi.json documents /api/referral-codes and /api/referral-codes/{vendor}", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/openapi.json`);
    assert.strictEqual(res.status, 200);
    const spec = await res.json() as any;
    assert.ok(spec.paths["/api/referral-codes"], "missing /api/referral-codes path");
    assert.ok(spec.paths["/api/referral-codes"].get, "listing endpoint should have GET");
    assert.ok(spec.paths["/api/referral-codes/{vendor}"], "missing vendor path");
    assert.ok(spec.components.schemas.ReferralCodeListing, "missing ReferralCodeListing schema");
  });
});

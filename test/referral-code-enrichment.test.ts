import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { getBestReferralCode } = await import("../dist/platform-codes.js");

describe("getBestReferralCode helper", () => {
  it("returns a platform code for Railway (seeded platform code)", () => {
    const code = getBestReferralCode("Railway");
    assert.ok(code, "Railway should have a referral code");
    assert.strictEqual(code.source, "platform");
    assert.strictEqual(code.vendor, "Railway");
    assert.ok(code.code);
    assert.ok(code.referral_url);
    assert.ok(code.referee_benefit);
  });

  it("is case-insensitive for vendor lookup", () => {
    const code = getBestReferralCode("railway");
    assert.ok(code);
    assert.strictEqual(code.source, "platform");
  });

  it("returns null for vendors with no codes", () => {
    const code = getBestReferralCode("NonExistentVendor_ZZZ_42");
    assert.strictEqual(code, null);
  });

  it("returned shape has exactly the expected fields", () => {
    const code = getBestReferralCode("Railway");
    assert.ok(code);
    assert.ok("vendor" in code);
    assert.ok("code" in code);
    assert.ok("referral_url" in code);
    assert.ok("referee_benefit" in code);
    assert.ok("source" in code);
  });
});

describe("MCP tools referral_code enrichment (via local REST proxy)", () => {
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

  function sendMcpRequest(proc: ChildProcess, request: object, responseId: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("MCP request timeout")), 15000);
      let buffer = "";
      const onData = (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.id === responseId) {
              clearTimeout(timeout);
              proc.stdout!.off("data", onData);
              resolve(parsed);
              return;
            }
          } catch {
            // not valid JSON yet
          }
        }
        buffer = lines[lines.length - 1];
      };
      proc.stdout!.on("data", onData);
      proc.stdin!.write(JSON.stringify(request) + "\n");
    });
  }

  async function initAndCall(toolName: string, toolArgs: object): Promise<any> {
    const serverBin = path.join(__dirname, "..", "dist", "index.js");
    const proc = spawn("node", [serverBin], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, AGENTDEALS_API_URL: `http://localhost:${serverPort}` },
    });
    try {
      await sendMcpRequest(proc, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
      }, 1);
      proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const resp = await sendMcpRequest(proc, {
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: toolName, arguments: toolArgs },
      }, 2);
      const text = resp.result?.content?.[0]?.text;
      assert.ok(text, `Expected content text in ${toolName} response`);
      return JSON.parse(text);
    } finally {
      proc.kill();
    }
  }

  it("search_deals results include referral_code field on each result", async () => {
    const body = await initAndCall("search_deals", { limit: 20 });
    assert.ok(Array.isArray(body.results));
    for (const result of body.results) {
      assert.ok("referral_code" in result, `Missing referral_code on result for ${result.vendor}`);
    }
  });

  it("search_deals for Railway returns platform referral_code inline", async () => {
    const body = await initAndCall("search_deals", { query: "Railway", limit: 10 });
    const railway = body.results.find((r: any) => r.vendor.toLowerCase() === "railway");
    assert.ok(railway, "Railway result should be present");
    assert.ok(railway.referral_code, "Railway referral_code should not be null");
    assert.strictEqual(railway.referral_code.source, "platform");
    assert.ok(railway.referral_code.code);
    assert.ok(railway.referral_code.referral_url);
    assert.ok(railway.referral_code.referee_benefit);
  });

  it("compare_vendors single-vendor mode includes referral_code for Railway", async () => {
    const body = await initAndCall("compare_vendors", { vendors: ["Railway"] });
    assert.ok("referral_code" in body, "Single-vendor response missing referral_code field");
    assert.ok(body.referral_code, "Railway referral_code should not be null");
    assert.strictEqual(body.referral_code.source, "platform");
  });

  it("compare_vendors two-vendor mode includes referral_codes map with explicit null for vendors without codes", async () => {
    const body = await initAndCall("compare_vendors", { vendors: ["Railway", "Vercel"] });
    assert.ok(body.referral_codes, "Two-vendor response should have referral_codes map");
    // The map key uses the canonical vendor name from the store, which may differ in case from user input.
    const keys = Object.keys(body.referral_codes);
    const railwayKey = keys.find(k => k.toLowerCase() === "railway");
    const vercelKey = keys.find(k => k.toLowerCase() === "vercel");
    assert.ok(railwayKey, "Railway key should be present");
    assert.ok(vercelKey, "Vercel key should be present (explicit null if no code)");
    assert.ok(body.referral_codes[railwayKey!]);
    assert.strictEqual(body.referral_codes[railwayKey!].source, "platform");
  });
});

describe("REST /api/offers referral_code enrichment", () => {
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

  it("every offer in /api/offers includes an explicit referral_code field (null when no code)", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/offers?limit=20`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { offers: Array<{ vendor: string; referral_code: unknown }> };
    assert.ok(body.offers.length > 0, "Should have some offers");
    for (const offer of body.offers) {
      assert.ok("referral_code" in offer, `Offer for ${offer.vendor} missing referral_code field`);
      // either null or matching shape
      if (offer.referral_code !== null) {
        const rc = offer.referral_code as Record<string, unknown>;
        assert.ok(rc.code, "referral_code.code should be present");
        assert.ok(rc.referral_url, "referral_code.referral_url should be present");
        assert.ok(rc.referee_benefit, "referral_code.referee_benefit should be present");
        assert.ok(rc.source === "platform" || rc.source === "agent-submitted", "referral_code.source should be platform or agent-submitted");
      }
    }
  });

  it("Railway offer in /api/offers includes platform referral_code inline", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/offers?q=Railway&limit=20`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { offers: Array<{ vendor: string; referral_code: { source?: string; code?: string } | null }> };
    const railway = body.offers.find(o => o.vendor.toLowerCase() === "railway");
    assert.ok(railway, "Railway offer should be present in search");
    assert.ok(railway.referral_code, "Railway referral_code should not be null");
    assert.strictEqual(railway.referral_code!.source, "platform");
    assert.ok(railway.referral_code!.code);
  });
});

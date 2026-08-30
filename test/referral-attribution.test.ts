import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "referral-attribution-"));
const REQUESTS_PATH = path.join(SCRATCH, "referral_requests.json");
process.env.AGENTDEALS_REFERRAL_REQUESTS_PATH = REQUESTS_PATH;
const AGENTS_PATH = path.join(__dirname, "..", "data", "agents.json");

const { logReferralRequest, getRequestsByAgent, getRequestById, resetReferralRequestsCache } = await import("../dist/referral-requests.js");
const { registerAgent, resetAgentsCache } = await import("../dist/agents.js");

function resetRequestsFile() {
  fs.writeFileSync(REQUESTS_PATH, JSON.stringify({ referral_requests: [] }), "utf-8");
  resetReferralRequestsCache();
}

function resetAgentsFile() {
  fs.writeFileSync(AGENTS_PATH, JSON.stringify({ agents: [] }), "utf-8");
  resetAgentsCache();
}

describe("Referral Request Logging", () => {
  beforeEach(() => {
    resetRequestsFile();
  });

  after(() => {
    resetRequestsFile();
  });

  it("logs a referral request with all fields", () => {
    const req = logReferralRequest({
      agent_id: "agent_abc123",
      vendor: "Railway",
      referral_code: "7RZL9q",
      referral_url: "https://railway.com?referralCode=7RZL9q",
    });
    assert.ok(req.id.startsWith("rr_"));
    assert.strictEqual(req.agent_id, "agent_abc123");
    assert.strictEqual(req.vendor, "Railway");
    assert.strictEqual(req.referral_code, "7RZL9q");
    assert.strictEqual(req.referral_url, "https://railway.com?referralCode=7RZL9q");
    assert.ok(req.requested_at);
    assert.strictEqual(req.conversion_id, null);
  });

  it("persists requests to disk", () => {
    logReferralRequest({
      agent_id: "agent_abc123",
      vendor: "Railway",
      referral_code: "7RZL9q",
      referral_url: "https://railway.com?referralCode=7RZL9q",
    });
    resetReferralRequestsCache();
    const raw = JSON.parse(fs.readFileSync(REQUESTS_PATH, "utf-8"));
    assert.strictEqual(raw.referral_requests.length, 1);
    assert.strictEqual(raw.referral_requests[0].vendor, "Railway");
  });

  it("generates unique request IDs", () => {
    const r1 = logReferralRequest({ agent_id: "a1", vendor: "V1", referral_code: "C1", referral_url: "http://u1" });
    const r2 = logReferralRequest({ agent_id: "a2", vendor: "V2", referral_code: "C2", referral_url: "http://u2" });
    assert.notStrictEqual(r1.id, r2.id);
  });
});

describe("Request Lookups", () => {
  beforeEach(() => {
    resetRequestsFile();
  });

  after(() => {
    resetRequestsFile();
  });

  it("gets requests by agent ID", () => {
    logReferralRequest({ agent_id: "agent_a", vendor: "V1", referral_code: "C1", referral_url: "http://u1" });
    logReferralRequest({ agent_id: "agent_b", vendor: "V2", referral_code: "C2", referral_url: "http://u2" });
    logReferralRequest({ agent_id: "agent_a", vendor: "V3", referral_code: "C3", referral_url: "http://u3" });

    const agentARequests = getRequestsByAgent("agent_a");
    assert.strictEqual(agentARequests.length, 2);
    assert.ok(agentARequests.every((r: any) => r.agent_id === "agent_a"));
  });

  it("gets request by ID", () => {
    const req = logReferralRequest({ agent_id: "agent_a", vendor: "V1", referral_code: "C1", referral_url: "http://u1" });
    const found = getRequestById(req.id);
    assert.ok(found);
    assert.strictEqual(found.vendor, "V1");
  });

  it("returns null for nonexistent request ID", () => {
    const found = getRequestById("rr_nonexistent");
    assert.strictEqual(found, null);
  });
});

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

describe("GET /api/referral/:vendor", () => {
  let serverProc: ChildProcess;

  before(async () => {
    resetRequestsFile();
    resetAgentsFile();
    serverProc = await startHttpServer();
  });

  after(() => {
    serverProc.kill();
    resetRequestsFile();
    resetAgentsFile();
  });

  it("returns referral code for vendor with referral", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral/Railway`);
    assert.strictEqual(res.status, 200);
    const data = await res.json() as any;
    assert.strictEqual(data.vendor, "Railway");
    assert.ok(data.referral_url);
    assert.ok(data.referee_value);
    assert.strictEqual(data.attributed, false);
  });

  it("returns 404 for vendor without referral", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral/NonExistentVendor`);
    assert.strictEqual(res.status, 404);
    const data = await res.json() as any;
    assert.ok(data.error.includes("No referral found"));
  });

  it("logs attribution for authenticated caller", async () => {
    const regRes = await fetch(`http://localhost:${serverPort}/api/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ReferralTestBot" }),
    });
    const regData = await regRes.json() as any;

    const res = await fetch(`http://localhost:${serverPort}/api/referral/Railway`, {
      headers: { Authorization: `Bearer ${regData.api_key}` },
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json() as any;
    assert.strictEqual(data.attributed, true);
    assert.strictEqual(data.vendor, "Railway");

    resetReferralRequestsCache();
    const raw = JSON.parse(fs.readFileSync(REQUESTS_PATH, "utf-8"));
    const agentRequests = raw.referral_requests.filter((r: any) => r.vendor === "Railway");
    assert.ok(agentRequests.length > 0);
  });

  it("unauthenticated caller still gets the code (no error)", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral/Railway`);
    assert.strictEqual(res.status, 200);
    const data = await res.json() as any;
    assert.strictEqual(data.attributed, false);
    assert.ok(data.referral_url);
  });
});

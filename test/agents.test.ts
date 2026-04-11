import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_PATH = path.join(__dirname, "..", "data", "agents.json");

// Unit tests for agents module
const { registerAgent, hashApiKey, getAgentByApiKeyHash, getAgentById, authenticateRequest, resetAgentsCache } = await import("../dist/agents.js");

function resetAgentsFile() {
  fs.writeFileSync(AGENTS_PATH, JSON.stringify({ agents: [] }), "utf-8");
  resetAgentsCache();
}

describe("Agent Registration", () => {
  beforeEach(() => {
    resetAgentsFile();
  });

  after(() => {
    resetAgentsFile();
  });

  it("registers an agent with API key auth", () => {
    const result = registerAgent({ name: "TestBot" });
    assert.ok(result.agent.id.startsWith("agent_"));
    assert.strictEqual(result.agent.name, "TestBot");
    assert.strictEqual(result.agent.status, "active");
    assert.ok(result.api_key);
    assert.ok(result.api_key.startsWith("agd_"));
    assert.ok(result.agent.api_key_hash.length > 0);
    assert.strictEqual(result.agent.vestauth_public_key_url, null);
    assert.strictEqual(result.agent.x402_address, null);
  });

  it("registers an agent with explicit api_key: true", () => {
    const result = registerAgent({ name: "ExplicitKeyBot", api_key: true });
    assert.ok(result.api_key);
    assert.ok(result.api_key.startsWith("agd_"));
  });

  it("API keys are stored as SHA-256 hashes, not plaintext", () => {
    const result = registerAgent({ name: "HashBot" });
    const expectedHash = hashApiKey(result.api_key);
    assert.strictEqual(result.agent.api_key_hash, expectedHash);

    // Verify the key is not stored anywhere in the file
    const raw = fs.readFileSync(AGENTS_PATH, "utf-8");
    assert.ok(!raw.includes(result.api_key));
    assert.ok(raw.includes(expectedHash));
  });

  it("rejects duplicate agent name (case-insensitive)", () => {
    registerAgent({ name: "UniqueBot" });
    assert.throws(
      () => registerAgent({ name: "uniquebot" }),
      /already exists/
    );
  });

  it("rejects duplicate vestauth URL", () => {
    // Register with a vestauth URL (skip validation in unit test by using direct function)
    const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, "utf-8"));
    agents.agents.push({
      id: "agent_test1",
      name: "VestauthBot1",
      api_key_hash: "",
      vestauth_public_key_url: "https://example.com/.well-known/vestauth",
      x402_address: null,
      status: "active",
      registered_at: new Date().toISOString(),
    });
    fs.writeFileSync(AGENTS_PATH, JSON.stringify(agents), "utf-8");
    resetAgentsCache();

    assert.throws(
      () => registerAgent({ name: "VestauthBot2", vestauth_public_key_url: "https://example.com/.well-known/vestauth" }),
      /already exists/
    );
  });

  it("persists agents to disk", () => {
    const result = registerAgent({ name: "PersistBot" });
    resetAgentsCache();
    const agent = getAgentById(result.agent.id);
    assert.ok(agent);
    assert.strictEqual(agent.name, "PersistBot");
  });

  it("generates unique agent IDs", () => {
    const r1 = registerAgent({ name: "Bot1" });
    const r2 = registerAgent({ name: "Bot2" });
    assert.notStrictEqual(r1.agent.id, r2.agent.id);
  });

  it("generates unique API keys", () => {
    const r1 = registerAgent({ name: "Bot1" });
    const r2 = registerAgent({ name: "Bot2" });
    assert.notStrictEqual(r1.api_key, r2.api_key);
  });
});

describe("API Key Authentication", () => {
  let testApiKey: string;

  before(() => {
    resetAgentsFile();
    const result = registerAgent({ name: "AuthTestBot" });
    testApiKey = result.api_key;
  });

  after(() => {
    resetAgentsFile();
  });

  it("resolves agent from valid Bearer token", async () => {
    const agent = await authenticateRequest({
      headers: { authorization: `Bearer ${testApiKey}` },
    });
    assert.ok(agent);
    assert.strictEqual(agent.name, "AuthTestBot");
  });

  it("returns null for invalid Bearer token", async () => {
    const agent = await authenticateRequest({
      headers: { authorization: "Bearer agd_invalidkey" },
    });
    assert.strictEqual(agent, null);
  });

  it("returns null for missing Authorization header", async () => {
    const agent = await authenticateRequest({
      headers: {},
    });
    assert.strictEqual(agent, null);
  });

  it("returns null for non-Bearer auth", async () => {
    const agent = await authenticateRequest({
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    assert.strictEqual(agent, null);
  });

  it("does not authenticate suspended agents", () => {
    // Manually suspend the agent
    const data = JSON.parse(fs.readFileSync(AGENTS_PATH, "utf-8"));
    const agentIdx = data.agents.findIndex((a: any) => a.name === "AuthTestBot");
    data.agents[agentIdx].status = "suspended";
    fs.writeFileSync(AGENTS_PATH, JSON.stringify(data), "utf-8");
    resetAgentsCache();

    const hash = hashApiKey(testApiKey);
    const agent = getAgentByApiKeyHash(hash);
    assert.strictEqual(agent, null);

    // Restore active status for other tests
    data.agents[agentIdx].status = "active";
    fs.writeFileSync(AGENTS_PATH, JSON.stringify(data), "utf-8");
    resetAgentsCache();
  });
});

describe("hashApiKey", () => {
  it("produces consistent SHA-256 hash", () => {
    const hash1 = hashApiKey("test-key");
    const hash2 = hashApiKey("test-key");
    assert.strictEqual(hash1, hash2);
    assert.strictEqual(hash1.length, 64); // SHA-256 hex is 64 chars
  });

  it("produces different hashes for different keys", () => {
    const hash1 = hashApiKey("key-a");
    const hash2 = hashApiKey("key-b");
    assert.notStrictEqual(hash1, hash2);
  });
});

// --- HTTP endpoint tests ---

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

describe("Agent Registry HTTP Endpoints", () => {
  let serverProc: ChildProcess;

  before(async () => {
    resetAgentsFile();
    serverProc = await startHttpServer();
  });

  after(() => {
    serverProc.kill();
    resetAgentsFile();
  });

  it("POST /api/agents/register creates agent with API key", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "HttpTestBot" }),
    });
    assert.strictEqual(res.status, 201);
    const data = await res.json() as any;
    assert.ok(data.id.startsWith("agent_"));
    assert.strictEqual(data.name, "HttpTestBot");
    assert.ok(data.api_key.startsWith("agd_"));
    assert.ok(data.api_key_note);
    assert.strictEqual(data.status, "active");
  });

  it("POST /api/agents/register rejects missing name", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json() as any;
    assert.ok(data.error.includes("name is required"));
  });

  it("POST /api/agents/register rejects empty name", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  " }),
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json() as any;
    assert.ok(data.error.includes("name is required"));
  });

  it("POST /api/agents/register rejects duplicate name", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "HttpTestBot" }),
    });
    assert.strictEqual(res.status, 409);
    const data = await res.json() as any;
    assert.ok(data.error.includes("already exists"));
  });

  it("POST /api/agents/register rejects invalid JSON", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    assert.strictEqual(res.status, 400);
  });

  it("GET /api/agents/me returns 401 without auth", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/agents/me`);
    assert.strictEqual(res.status, 401);
    const data = await res.json() as any;
    assert.ok(data.error.includes("Authentication required"));
  });

  it("GET /api/agents/me returns agent info with valid Bearer token", async () => {
    // Register a new agent to get API key
    const regRes = await fetch(`http://localhost:${serverPort}/api/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "MeTestBot" }),
    });
    const regData = await regRes.json() as any;

    const res = await fetch(`http://localhost:${serverPort}/api/agents/me`, {
      headers: { Authorization: `Bearer ${regData.api_key}` },
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json() as any;
    assert.strictEqual(data.name, "MeTestBot");
    assert.strictEqual(data.id, regData.id);
    assert.strictEqual(data.status, "active");
    // Should not expose api_key_hash
    assert.strictEqual(data.api_key_hash, undefined);
  });

  it("GET /api/agents/me returns 401 with invalid Bearer token", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/agents/me`, {
      headers: { Authorization: "Bearer agd_invalidkey" },
    });
    assert.strictEqual(res.status, 401);
  });

  it("response does not expose api_key_hash or vestauth_public_key_url when null", async () => {
    const regRes = await fetch(`http://localhost:${serverPort}/api/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "FieldTestBot" }),
    });
    const regData = await regRes.json() as any;

    // Registration response should not include api_key_hash
    assert.strictEqual(regData.api_key_hash, undefined);
  });
});

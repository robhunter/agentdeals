import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3457;

function sendMcpMessages(
  serverProcess: ReturnType<typeof spawn>,
  messages: object[]
): Promise<object[]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout")), 5000);
    const responses: object[] = [];
    let buffer = "";
    const expectedResponses = messages.filter(
      (m: any) => m.id !== undefined
    ).length;

    const onData = (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          try {
            responses.push(JSON.parse(line.trim()));
            if (responses.length >= expectedResponses) {
              clearTimeout(timeout);
              serverProcess.stdout!.off("data", onData);
              resolve(responses);
            }
          } catch {
            // not valid JSON yet
          }
        }
      }
    };

    serverProcess.stdout!.on("data", onData);
    for (const msg of messages) {
      serverProcess.stdin!.write(JSON.stringify(msg) + "\n");
    }
  });
}

const INIT_MESSAGES = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
];

describe("get_new_offers MCP tool", () => {
  let proc: ReturnType<typeof spawn> | null = null;

  afterEach(() => {
    if (proc) {
      proc.kill();
      proc = null;
    }
  });

  it("returns offers with default 7-day window", async () => {
    const serverPath = path.join(__dirname, "..", "dist", "index.js");
    proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const responses = await sendMcpMessages(proc, [
      ...INIT_MESSAGES,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_new_offers", arguments: {} },
      },
    ]);

    const toolResponse = responses.find((r: any) => r.id === 2) as any;
    assert.ok(toolResponse);
    assert.ok(toolResponse.result);
    const body = JSON.parse(toolResponse.result.content[0].text);
    assert.ok(Array.isArray(body.offers));
    assert.strictEqual(typeof body.total, "number");
    assert.strictEqual(body.total, body.offers.length);

    // All offers should have verifiedDate within last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    for (const offer of body.offers) {
      assert.ok(offer.verifiedDate >= sevenDaysAgo, `${offer.vendor} verifiedDate ${offer.verifiedDate} should be >= ${sevenDaysAgo}`);
    }

    // Should be sorted by verifiedDate descending
    for (let i = 1; i < body.offers.length; i++) {
      assert.ok(body.offers[i - 1].verifiedDate >= body.offers[i].verifiedDate,
        "Offers should be sorted newest first");
    }
  });

  it("accepts custom days parameter", async () => {
    const serverPath = path.join(__dirname, "..", "dist", "index.js");
    proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const responses = await sendMcpMessages(proc, [
      ...INIT_MESSAGES,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_new_offers", arguments: { days: 30 } },
      },
    ]);

    const toolResponse = responses.find((r: any) => r.id === 2) as any;
    assert.ok(toolResponse);
    const body = JSON.parse(toolResponse.result.content[0].text);
    assert.ok(Array.isArray(body.offers));

    // 30-day window should return >= 7-day window results
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    for (const offer of body.offers) {
      assert.ok(offer.verifiedDate >= thirtyDaysAgo);
    }
  });

  it("returns empty array when no offers match", async () => {
    const serverPath = path.join(__dirname, "..", "dist", "index.js");
    proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Use days=1 which may return empty if no offers verified today
    const responses = await sendMcpMessages(proc, [
      ...INIT_MESSAGES,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_new_offers", arguments: { days: 1 } },
      },
    ]);

    const toolResponse = responses.find((r: any) => r.id === 2) as any;
    assert.ok(toolResponse);
    assert.ok(toolResponse.result);
    // Should not be an error even if empty
    assert.ok(!toolResponse.result.isError);
    const body = JSON.parse(toolResponse.result.content[0].text);
    assert.ok(Array.isArray(body.offers));
    assert.strictEqual(typeof body.total, "number");
  });
});

describe("GET /api/new REST endpoint", () => {
  let proc: ChildProcess | null = null;

  function startHttpServer(): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const serverPath = path.join(__dirname, "..", "dist", "serve.js");
      const p = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: String(PORT) },
      });

      const timeout = setTimeout(() => {
        p.kill();
        reject(new Error("Server startup timeout"));
      }, 5000);

      p.stderr!.on("data", (data: Buffer) => {
        if (data.toString().includes("running on http")) {
          clearTimeout(timeout);
          resolve(p);
        }
      });

      p.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  afterEach(() => {
    if (proc) {
      proc.kill();
      proc = null;
    }
  });

  it("returns new offers with default 7-day window", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/api/new`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("content-type"), "application/json");
    assert.strictEqual(response.headers.get("access-control-allow-origin"), "*");

    const body = await response.json() as any;
    assert.ok(Array.isArray(body.offers));
    assert.strictEqual(typeof body.total, "number");
    assert.strictEqual(body.total, body.offers.length);
  });

  it("accepts days query parameter", async () => {
    proc = await startHttpServer();

    const response = await fetch(`http://localhost:${PORT}/api/new?days=30`);
    assert.strictEqual(response.status, 200);

    const body = await response.json() as any;
    assert.ok(Array.isArray(body.offers));

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    for (const offer of body.offers) {
      assert.ok(offer.verifiedDate >= thirtyDaysAgo);
    }
  });
});

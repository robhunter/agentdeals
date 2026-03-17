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

describe("search_deals with since param (new offers)", () => {
  let proc: ReturnType<typeof spawn> | null = null;

  afterEach(() => {
    if (proc) {
      proc.kill();
      proc = null;
    }
  });

  it("returns deals verified since a given date", async () => {
    const serverPath = path.join(__dirname, "..", "dist", "index.js");
    proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const responses = await sendMcpMessages(proc, [
      ...INIT_MESSAGES,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "search_deals", arguments: { since: sevenDaysAgo } },
      },
    ]);

    const toolResponse = responses.find((r: any) => r.id === 2) as any;
    assert.ok(toolResponse);
    assert.ok(toolResponse.result);
    const body = JSON.parse(toolResponse.result.content[0].text);
    assert.ok(Array.isArray(body.deals));
    assert.strictEqual(typeof body.total, "number");

    // All deals should have verifiedDate on or after since
    for (const deal of body.deals) {
      assert.ok(deal.verifiedDate >= sevenDaysAgo, `${deal.vendor} verifiedDate ${deal.verifiedDate} should be >= ${sevenDaysAgo}`);
    }
  });

  it("returns deals within 30-day window", async () => {
    const serverPath = path.join(__dirname, "..", "dist", "index.js");
    proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const responses = await sendMcpMessages(proc, [
      ...INIT_MESSAGES,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "search_deals", arguments: { since: thirtyDaysAgo } },
      },
    ]);

    const toolResponse = responses.find((r: any) => r.id === 2) as any;
    assert.ok(toolResponse);
    const body = JSON.parse(toolResponse.result.content[0].text);
    assert.ok(Array.isArray(body.deals));

    for (const deal of body.deals) {
      assert.ok(deal.verifiedDate >= thirtyDaysAgo);
    }
  });

  it("returns empty array when no deals match", async () => {
    const serverPath = path.join(__dirname, "..", "dist", "index.js");
    proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Use a future date which should return nothing
    const responses = await sendMcpMessages(proc, [
      ...INIT_MESSAGES,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "search_deals", arguments: { since: "2099-01-01" } },
      },
    ]);

    const toolResponse = responses.find((r: any) => r.id === 2) as any;
    assert.ok(toolResponse);
    assert.ok(toolResponse.result);
    assert.ok(!toolResponse.result.isError);
    const body = JSON.parse(toolResponse.result.content[0].text);
    assert.ok(Array.isArray(body.deals));
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

import { describe, it } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function startServer() {
  const serverPath = path.join(__dirname, "..", "dist", "index.js");
  return spawn("node", [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("get_deal_changes tool", () => {
  it("returns all changes when no filters (with broad since)", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "get_deal_changes",
            arguments: { since: "2024-01-01" },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      assert.ok(!result.result.isError);
      const body = JSON.parse(result.result.content[0].text);

      assert.ok(Array.isArray(body.changes));
      assert.strictEqual(body.total, body.changes.length);
      assert.strictEqual(body.total, 31);
    } finally {
      proc.kill();
    }
  });

  it("filters by date (since)", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "get_deal_changes",
            arguments: { since: "2026-02-01" },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);

      assert.ok(body.total >= 4);
      for (const change of body.changes) {
        assert.ok(change.date >= "2026-02-01", `${change.vendor} date ${change.date} should be >= 2026-02-01`);
      }
    } finally {
      proc.kill();
    }
  });

  it("filters by change_type", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "get_deal_changes",
            arguments: { since: "2025-01-01", change_type: "free_tier_removed" },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);

      assert.ok(body.total >= 3);
      for (const change of body.changes) {
        assert.strictEqual(change.change_type, "free_tier_removed");
      }
    } finally {
      proc.kill();
    }
  });

  it("filters by vendor name (case-insensitive partial match)", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "get_deal_changes",
            arguments: { since: "2025-01-01", vendor: "netlify" },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);

      assert.strictEqual(body.total, 1);
      assert.strictEqual(body.changes[0].vendor, "Netlify");
    } finally {
      proc.kill();
    }
  });

  it("combines multiple filters", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "get_deal_changes",
            arguments: { since: "2025-01-01", change_type: "limits_reduced", vendor: "gemini" },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);

      assert.strictEqual(body.total, 1);
      assert.strictEqual(body.changes[0].vendor, "Google Gemini");
      assert.strictEqual(body.changes[0].change_type, "limits_reduced");
    } finally {
      proc.kill();
    }
  });

  it("returns empty results for non-matching filters", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "get_deal_changes",
            arguments: { since: "2025-01-01", vendor: "nonexistent-xyz-999" },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);

      assert.strictEqual(body.total, 0);
      assert.deepStrictEqual(body.changes, []);
    } finally {
      proc.kill();
    }
  });

  it("returns results sorted by date newest first", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "get_deal_changes",
            arguments: { since: "2025-01-01" },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);
      const dates = body.changes.map((c: any) => c.date);

      for (let i = 1; i < dates.length; i++) {
        assert.ok(
          dates[i - 1] >= dates[i],
          `${dates[i - 1]} should be >= ${dates[i]} (newest first)`
        );
      }
    } finally {
      proc.kill();
    }
  });

  it("each change has required fields", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "get_deal_changes",
            arguments: { since: "2025-01-01" },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);

      assert.ok(body.changes.length > 0);
      for (const change of body.changes) {
        assert.ok(typeof change.vendor === "string");
        assert.ok(typeof change.change_type === "string");
        assert.ok(typeof change.date === "string");
        assert.ok(typeof change.summary === "string");
        assert.ok(typeof change.previous_state === "string");
        assert.ok(typeof change.current_state === "string");
        assert.ok(typeof change.impact === "string");
        assert.ok(typeof change.source_url === "string");
        assert.ok(typeof change.category === "string");
        assert.ok(Array.isArray(change.alternatives));
      }
    } finally {
      proc.kill();
    }
  });
});

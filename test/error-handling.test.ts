import { describe, it } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function sendMcpMessages(
  serverProcess: ReturnType<typeof spawn>,
  messages: object[]
): Promise<object[]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout")), 10000);
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

function startServerWithBadApi() {
  const serverPath = path.join(__dirname, "..", "dist", "index.js");
  return spawn("node", [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENTDEALS_API_URL: "http://127.0.0.1:19999",
    },
  });
}

// These tests verify the stdio server handles API errors gracefully
// by pointing it at a non-existent API endpoint.

describe("error handling", () => {
  it("returns error for search_deals categories when API is unreachable", async () => {
    const proc = startServerWithBadApi();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search_deals", arguments: { category: "list" } },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      assert.ok(result.result, "Should return a result, not crash");
      assert.strictEqual(result.result.isError, true, "Should indicate an error");
      const text = result.result.content[0].text;
      assert.ok(text.includes("unreachable") || text.includes("Error"), "Error message should mention API issue");
    } finally {
      proc.kill();
    }
  });

  it("returns error for search_deals search when API is unreachable", async () => {
    const proc = startServerWithBadApi();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search_deals", arguments: { query: "anything" } },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      assert.ok(result.result, "Should return a result, not crash");
      assert.strictEqual(result.result.isError, true, "Should indicate an error");
      const text = result.result.content[0].text;
      assert.ok(text.includes("unreachable") || text.includes("Error"), "Error message should mention API issue");
    } finally {
      proc.kill();
    }
  });

  it("returns error for search_deals vendor when API is unreachable", async () => {
    const proc = startServerWithBadApi();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search_deals", arguments: { vendor: "Vercel" } },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      assert.ok(result.result, "Should return a result, not crash");
      assert.strictEqual(result.result.isError, true, "Should indicate an error");
      const text = result.result.content[0].text;
      assert.ok(text.includes("unreachable") || text.includes("Error"), "Error message should mention API issue");
    } finally {
      proc.kill();
    }
  });
});

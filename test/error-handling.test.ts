import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, "..", "data", "index.json");
const BACKUP_PATH = path.join(__dirname, "..", "data", "index.json.bak");

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

// These tests modify the data index file. Each test backs up the file,
// modifies it, starts a fresh server, tests, then restores the backup.
// Tests within this describe block run serially (Node test runner default
// for tests within a single describe) and each test manages its own
// backup/restore to avoid interfering with concurrent test files.

describe("error handling", () => {
  beforeEach(() => {
    // Back up the original index
    fs.copyFileSync(INDEX_PATH, BACKUP_PATH);
  });

  afterEach(() => {
    // Restore the original index
    fs.copyFileSync(BACKUP_PATH, INDEX_PATH);
    fs.unlinkSync(BACKUP_PATH);
  });

  it("handles malformed JSON in index file gracefully", async () => {
    fs.writeFileSync(INDEX_PATH, "{ not valid json !!!", "utf-8");

    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "list_categories", arguments: {} },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      assert.ok(result.result, "Should return a result, not crash");
      const categories = JSON.parse(result.result.content[0].text);
      assert.ok(Array.isArray(categories));
      assert.strictEqual(categories.length, 0, "Should return empty categories for malformed JSON");
    } finally {
      proc.kill();
    }
  });

  it("handles missing offers array in index file gracefully", async () => {
    fs.writeFileSync(INDEX_PATH, JSON.stringify({ notOffers: [] }), "utf-8");

    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search_offers", arguments: { query: "anything" } },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      assert.ok(result.result, "Should return a result, not crash");
      const body = JSON.parse(result.result.content[0].text);
      assert.ok(Array.isArray(body.results));
      assert.strictEqual(body.results.length, 0, "Should return empty offers for missing offers array");
      assert.strictEqual(body.total, 0);
    } finally {
      proc.kill();
    }
  });

  it("list_categories returns empty array when index has no offers", async () => {
    fs.writeFileSync(INDEX_PATH, JSON.stringify({ offers: [] }), "utf-8");

    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "list_categories", arguments: {} },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      assert.ok(result.result, "Should return a result, not crash");
      const categories = JSON.parse(result.result.content[0].text);
      assert.ok(Array.isArray(categories));
      assert.strictEqual(categories.length, 0, "Should return empty categories for empty offers");
    } finally {
      proc.kill();
    }
  });
});

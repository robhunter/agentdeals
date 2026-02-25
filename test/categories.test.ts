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

describe("list_categories tool", () => {
  it("returns categories from index data", async () => {
    const serverPath = path.join(__dirname, "..", "dist", "index.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      const responses = (await sendMcpMessages(proc, [
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
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "list_categories", arguments: {} },
        },
      ])) as any[];

      const toolResponse = responses.find((r: any) => r.id === 2) as any;
      assert.ok(toolResponse.result);
      assert.ok(toolResponse.result.content);
      assert.strictEqual(toolResponse.result.content.length, 1);
      assert.strictEqual(toolResponse.result.content[0].type, "text");

      const categories = JSON.parse(toolResponse.result.content[0].text);
      assert.ok(Array.isArray(categories));
      assert.ok(categories.length > 0);

      // Each category should have name and count
      for (const cat of categories) {
        assert.ok(typeof cat.name === "string");
        assert.ok(typeof cat.count === "number");
        assert.ok(cat.count > 0);
      }

      // Verify categories are sorted alphabetically
      const names = categories.map((c: any) => c.name);
      const sorted = [...names].sort((a: string, b: string) => a.localeCompare(b));
      assert.deepStrictEqual(names, sorted);
    } finally {
      proc.kill();
    }
  });
});

import { describe, it } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function sendMcpRequest(
  serverProcess: ReturnType<typeof spawn>,
  request: object
): Promise<object> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout")), 5000);
    let buffer = "";

    const onData = (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (line.trim()) {
          try {
            const parsed = JSON.parse(line.trim());
            clearTimeout(timeout);
            serverProcess.stdout!.off("data", onData);
            resolve(parsed);
            return;
          } catch {
            // not valid JSON yet, keep buffering
          }
        }
      }
    };

    serverProcess.stdout!.on("data", onData);
    serverProcess.stdin!.write(JSON.stringify(request) + "\n");
  });
}

describe("MCP Server", () => {
  it("responds to initialize request", async () => {
    const serverPath = path.join(__dirname, "..", "dist", "index.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      const response = (await sendMcpRequest(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      })) as any;

      assert.strictEqual(response.jsonrpc, "2.0");
      assert.strictEqual(response.id, 1);
      assert.ok(response.result);
      assert.strictEqual(response.result.serverInfo.name, "agentdeals");
      assert.strictEqual(response.result.serverInfo.version, "0.1.0");
      assert.strictEqual(response.result.protocolVersion, "2024-11-05");
    } finally {
      proc.kill();
    }
  });
});

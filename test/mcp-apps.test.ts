import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function sendMcpRequest(
  serverProcess: ReturnType<typeof spawn>,
  request: object
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout")), 10000);
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

async function initServer() {
  const serverPath = path.join(__dirname, "..", "dist", "index.js");
  const proc = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "pipe"] });

  // Initialize
  await sendMcpRequest(proc, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0.0.1" } },
  });

  // Send initialized notification
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  return proc;
}

describe("MCP Apps UI resources", () => {
  it("tools/list includes _meta with ui.resourceUri for all 4 tools", async () => {
    const proc = await initServer();
    try {
      const response = await sendMcpRequest(proc, {
        jsonrpc: "2.0", id: 2, method: "tools/list", params: {},
      });

      const tools = response.result.tools;
      const toolNames = ["search_deals", "plan_stack", "compare_vendors", "track_changes"];

      for (const name of toolNames) {
        const tool = tools.find((t: any) => t.name === name);
        assert.ok(tool, `Tool ${name} should be listed`);
        assert.ok(tool._meta, `Tool ${name} should have _meta`);
        assert.ok(tool._meta.ui, `Tool ${name} should have _meta.ui`);
        assert.ok(tool._meta.ui.resourceUri, `Tool ${name} should have _meta.ui.resourceUri`);
        assert.ok(
          tool._meta.ui.resourceUri.startsWith("ui://agentdeals/"),
          `Tool ${name} resourceUri should start with ui://agentdeals/`
        );
      }
    } finally {
      proc.kill();
    }
  });

  it("resources/list includes ui:// MCP Apps resources", async () => {
    const proc = await initServer();
    try {
      const response = await sendMcpRequest(proc, {
        jsonrpc: "2.0", id: 3, method: "resources/list", params: {},
      });

      const resources = response.result.resources;
      const uiResources = resources.filter((r: any) => r.uri.startsWith("ui://"));
      assert.ok(uiResources.length >= 4, `Should have at least 4 ui:// resources, got ${uiResources.length}`);

      const expectedUris = [
        "ui://agentdeals/search-deals",
        "ui://agentdeals/plan-stack",
        "ui://agentdeals/compare-vendors",
        "ui://agentdeals/track-changes",
      ];
      for (const uri of expectedUris) {
        const resource = uiResources.find((r: any) => r.uri === uri);
        assert.ok(resource, `Resource ${uri} should be listed`);
      }
    } finally {
      proc.kill();
    }
  });

  it("resources/read returns HTML with MCP App MIME type", async () => {
    const proc = await initServer();
    try {
      const response = await sendMcpRequest(proc, {
        jsonrpc: "2.0", id: 4, method: "resources/read",
        params: { uri: "ui://agentdeals/search-deals" },
      });

      const contents = response.result.contents;
      assert.ok(contents.length > 0, "Should return contents");
      assert.equal(contents[0].mimeType, "text/html;profile=mcp-app");
      assert.ok(contents[0].text.includes("<!DOCTYPE html>"), "Should be HTML");
      assert.ok(contents[0].text.includes("agentdeals.dev"), "Should link to agentdeals.dev");
      assert.ok(contents[0].text.includes("ext-apps"), "Should import ext-apps bridge");
    } finally {
      proc.kill();
    }
  });
});

import { describe, it, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Start a local HTTP server so stdio MCP tests hit local data (not production API)
let LOCAL_API_URL = "";

const httpServerPath = path.join(__dirname, "..", "dist", "serve.js");
const httpServer: ChildProcess = spawn("node", [httpServerPath], {
  env: { ...process.env, PORT: "0" },
  stdio: ["pipe", "pipe", "pipe"],
});

await new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("HTTP server start timeout")), 10000);
  httpServer.stderr!.on("data", (chunk: Buffer) => {
    const match = chunk.toString().match(/running on http:\/\/localhost:(\d+)/);
    if (match) {
      LOCAL_API_URL = `http://localhost:${match[1]}`;
      clearTimeout(timeout);
      resolve();
    }
  });
  httpServer.on("error", (err) => {
    clearTimeout(timeout);
    reject(err);
  });
});

after(() => {
  httpServer.kill();
});

function sendMcpMessages(
  serverProcess: ReturnType<typeof spawn>,
  messages: object[]
): Promise<object[]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout")), 15000);
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
    env: { ...process.env, AGENTDEALS_API_URL: LOCAL_API_URL },
  });
}

describe("MCP Resources", () => {
  it("lists resources including categories, vendors, changes, and guides", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "resources/list",
          params: {},
        },
      ])) as any[];

      const listResponse = responses.find((r: any) => r.id === 2) as any;
      assert.ok(listResponse.result, "resources/list should return a result");
      assert.ok(Array.isArray(listResponse.result.resources), "result should have resources array");

      const uris = listResponse.result.resources.map((r: any) => r.uri);
      // Static resources
      assert.ok(uris.includes("agentdeals://categories"), "should include categories");
      assert.ok(uris.includes("agentdeals://vendors"), "should include vendors");
      assert.ok(uris.includes("agentdeals://changes"), "should include changes");
      assert.ok(uris.includes("agentdeals://changes/latest"), "should include changes/latest");
      assert.ok(uris.includes("agentdeals://guides"), "should include guides");

      // Template-expanded resources
      assert.ok(uris.some((u: string) => u.startsWith("agentdeals://category/")), "should include category templates");
      assert.ok(uris.some((u: string) => u.startsWith("agentdeals://vendor/")), "should include vendor templates");
      assert.ok(uris.some((u: string) => u.startsWith("agentdeals://guide/")), "should include guide templates");

      // Should have many resources (static + templates)
      assert.ok(listResponse.result.resources.length > 50, `should have many resources, got ${listResponse.result.resources.length}`);
    } finally {
      proc.kill();
    }
  });

  it("reads categories resource with all categories listed", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "resources/read",
          params: { uri: "agentdeals://categories" },
        },
      ])) as any[];

      const readResponse = responses.find((r: any) => r.id === 2) as any;
      assert.ok(readResponse.result, "should return a result");
      assert.ok(Array.isArray(readResponse.result.contents), "should have contents");
      assert.strictEqual(readResponse.result.contents[0].uri, "agentdeals://categories");

      const text = readResponse.result.contents[0].text;
      assert.ok(text.includes("# AgentDeals Categories"), "should have heading");
      assert.ok(text.includes("categories"), "should mention categories");
      assert.ok(text.includes("Databases"), "should include Databases category");
    } finally {
      proc.kill();
    }
  });

  it("reads changes resource with tracked changes", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "resources/read",
          params: { uri: "agentdeals://changes" },
        },
      ])) as any[];

      const readResponse = responses.find((r: any) => r.id === 2) as any;
      assert.ok(readResponse.result);
      const text = readResponse.result.contents[0].text;
      assert.ok(text.includes("# AgentDeals Pricing Changes"));
      assert.ok(text.includes("tracked changes"));
    } finally {
      proc.kill();
    }
  });

  it("reads guides resource listing all editorial pages", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "resources/read",
          params: { uri: "agentdeals://guides" },
        },
      ])) as any[];

      const readResponse = responses.find((r: any) => r.id === 2) as any;
      assert.ok(readResponse.result);
      const text = readResponse.result.contents[0].text;
      assert.ok(text.includes("# AgentDeals Editorial Guides"));
      assert.ok(text.includes("guides"));
    } finally {
      proc.kill();
    }
  });

  it("reads a specific guide by slug", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "resources/read",
          params: { uri: "agentdeals://guide/supabase-vs-firebase" },
        },
      ])) as any[];

      const readResponse = responses.find((r: any) => r.id === 2) as any;
      assert.ok(readResponse.result);
      const text = readResponse.result.contents[0].text;
      assert.ok(text.includes("Supabase vs Firebase"), "should have guide title");
      assert.ok(text.includes("comparison"), "should show type");
      assert.ok(text.includes("/supabase-vs-firebase"), "should include URL");
    } finally {
      proc.kill();
    }
  });

  it("returns not-found message for unknown guide slug", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "resources/read",
          params: { uri: "agentdeals://guide/nonexistent-guide" },
        },
      ])) as any[];

      const readResponse = responses.find((r: any) => r.id === 2) as any;
      assert.ok(readResponse.result);
      const text = readResponse.result.contents[0].text;
      assert.ok(text.includes("No guide found"), "should indicate not found");
    } finally {
      proc.kill();
    }
  });

  it("reads changes/latest resource", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "resources/read",
          params: { uri: "agentdeals://changes/latest" },
        },
      ])) as any[];

      const readResponse = responses.find((r: any) => r.id === 2) as any;
      assert.ok(readResponse.result);
      const text = readResponse.result.contents[0].text;
      assert.ok(text.includes("# Latest Pricing Changes"));
    } finally {
      proc.kill();
    }
  });
});

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startStdioServerAgainst } from "./local-api.ts";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_VERSION = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf-8")).version;

function answersTo(proc: ChildProcess, messages: Record<string, unknown>[]): Promise<unknown[]> {
  const awaited = messages.filter((m) => m.id !== undefined).length;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the stdio server did not answer within 15 seconds")), 15000);
    const answers: unknown[] = [];
    let buffer = "";
    proc.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines.filter((l) => l.trim())) {
        answers.push(JSON.parse(line));
        if (answers.length === awaited) {
          clearTimeout(timer);
          resolve(answers);
        }
      }
    });
    for (const message of messages) proc.stdin!.write(JSON.stringify(message) + "\n");
  });
}

describe("the stdio server's requests to the API", () => {
  const userAgentByPath = new Map<string, string | undefined>();
  let recorder: Server;
  let url = "";

  before(async () => {
    recorder = createServer((req, res) => {
      const route = new URL(req.url!, "http://recorder").pathname;
      userAgentByPath.set(route, req.headers["user-agent"]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(route === "/api/categories" ? '{"categories":[]}' : "{}");
    });
    await new Promise<void>((resolve) => recorder.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(recorder.address() as AddressInfo).port}`;
  });

  after(() => { recorder?.close(); });

  it("send agentdeals-mcp/<package version> as the User-Agent", async () => {
    const proc = startStdioServerAgainst({ url });
    try {
      await answersTo(proc, [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_deals", arguments: { category: "list" } } },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "plan_stack", arguments: { mode: "estimate", services: ["Vercel"] } } },
      ]);
    } finally {
      proc.kill();
    }
    assert.deepEqual(Object.fromEntries(userAgentByPath), {
      "/api/categories": `agentdeals-mcp/${MANIFEST_VERSION}`,
      "/api/costs": `agentdeals-mcp/${MANIFEST_VERSION}`,
    });
  });
});

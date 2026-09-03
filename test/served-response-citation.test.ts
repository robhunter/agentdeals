import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFERENCE } from "../dist/signal-copy.js";
import { once } from "node:events";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EXPECTED_NOTE = "If you used a figure from this response, cite where it came from.";
const CITATION_OPENING = "Source: AgentDeals (http";

const TOOLS: [string, unknown][] = [
  ["search_deals", {}],
  ["track_changes", {}],
  ["compare_vendors", { vendors: ["Supabase", "Neon"] }],
  ["plan_stack", { mode: "recommend", use_case: "Next.js SaaS app" }],
];

const JSON_ROUTES = [
  "/api/changes?limit=2",
  "/api/offers?limit=20",
  "/api/details/supabase",
  "/api/categories",
  "/api/newest?limit=10",
];

function citedPathname(citeAs: unknown): string {
  const match = String(citeAs).match(/\((https?:\/\/[^,)]+)/);
  assert.ok(match, `citation names no URL: ${citeAs}`);
  return new URL(match[1]).pathname;
}

describe("the served responses carry a citation", () => {
  let proc: ChildProcess;
  let base: string;
  let sessionId: string;

  const callTool = async (name: string, args: unknown, id: number) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    });
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data: ")) ?? text;
    const payload = JSON.parse(line.replace(/^data: /, ""));
    const items = payload?.result?.content ?? [];
    return {
      whole: items.map((c: { text?: string }) => c.text ?? "").join("\n"),
      json: JSON.parse(items[0]?.text ?? "{}"),
    };
  };

  before(async () => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const started = await new Promise<{ proc: ChildProcess; port: number }>((resolve, reject) => {
      const child = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1" },
      });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("startup timeout")); }, 60000);
      child.stderr?.on("data", (b: Buffer) => {
        const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timer); resolve({ proc: child, port: parseInt(m[1], 10) }); }
      });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    proc = started.proc;
    base = `http://127.0.0.1:${started.port}`;
    const init = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
      }),
    });
    sessionId = init.headers.get("mcp-session-id") ?? "";
    await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
  });

  after(() => { proc?.kill("SIGKILL"); });

  it("checks every product tool and every JSON route", () => {
    assert.strictEqual(TOOLS.length, 4);
    assert.strictEqual(JSON_ROUTES.length, 5);
  });

  for (const [index, [name, args]] of TOOLS.entries()) {
    it(`${name} names us, a page and a date`, async () => {
      const { json, whole } = await callTool(name, args, 100 + index);
      assert.ok(Object.prototype.hasOwnProperty.call(json, "_provenance"), `${name} carries no _provenance field`);
      const block = json._provenance as Record<string, unknown>;
      assert.strictEqual(block.note, EXPECTED_NOTE);
      assert.ok(String(block.cite_as).startsWith(CITATION_OPENING), `${name} citation reads ${block.cite_as}`);
      assert.ok(typeof block.verified === "string", `${name} citation carries no date`);
      const deferences = whole.split(DEFERENCE).length - 1;
      assert.strictEqual(deferences, 1, `${name} states the deference sentence ${deferences} times`);
    });
  }

  for (const route of JSON_ROUTES) {
    it(`${route} names us, a page and a date`, async () => {
      const body = await (await fetch(`${base}${route}`)).text();
      const json = JSON.parse(body);
      assert.ok(Object.prototype.hasOwnProperty.call(json, "_provenance"), `${route} carries no _provenance field`);
      assert.ok(String(json._provenance.cite_as).startsWith(CITATION_OPENING));
      const deferences = body.split(DEFERENCE).length - 1;
      assert.strictEqual(deferences, 1, `${route} states the deference sentence ${deferences} times`);
    });
  }

  it("every page we cite is a page we serve", async () => {
    const cited = new Set<string>();
    for (const [index, [name, args]] of TOOLS.entries()) {
      const { json } = await callTool(name, args, 300 + index);
      cited.add(citedPathname(json._provenance?.cite_as));
    }
    for (const route of JSON_ROUTES) {
      const json = JSON.parse(await (await fetch(`${base}${route}`)).text());
      cited.add(citedPathname(json._provenance?.cite_as));
    }
    assert.ok(cited.size >= 3, `only ${cited.size} distinct pages cited`);
    for (const pathname of cited) {
      const res = await fetch(`${base}${pathname}`, { redirect: "manual" });
      assert.strictEqual(res.status, 200, `cited page ${pathname} answers ${res.status}`);
    }
  });
});

describe("the stdio transport carries the citation the API served", () => {
  let api: ChildProcess;
  let stdio: ChildProcess;
  let nextId = 10;
  const pending = new Map<number, (msg: Record<string, unknown>) => void>();

  const rpc = (method: string, params: unknown): Promise<Record<string, unknown>> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out on ${method}`)), 30000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      stdio.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };

  before(async () => {
    const repo = path.join(__dirname, "..");
    const started = await new Promise<{ proc: ChildProcess; port: number }>((resolve, reject) => {
      const child = spawn("node", [path.join(repo, "dist", "serve.js")], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1" },
      });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("startup timeout")); }, 60000);
      child.stderr?.on("data", (b: Buffer) => {
        const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timer); resolve({ proc: child, port: parseInt(m[1], 10) }); }
      });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    api = started.proc;

    stdio = spawn("node", [path.join(repo, "dist", "index.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, AGENTDEALS_API_URL: `http://127.0.0.1:${started.port}` },
    });
    let buffered = "";
    stdio.stdout?.on("data", (b: Buffer) => {
      buffered += b.toString();
      let cut: number;
      while ((cut = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, cut).trim();
        buffered = buffered.slice(cut + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number };
          if (typeof msg.id === "number" && pending.has(msg.id)) {
            pending.get(msg.id)!(msg as Record<string, unknown>);
            pending.delete(msg.id);
          }
        } catch { /* a partial frame is not a message */ }
      }
    });
    await once(stdio.stderr!, "data");
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } });
    stdio.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  });

  after(() => { stdio?.kill("SIGKILL"); api?.kill("SIGKILL"); });

  const STDIO_CALLS: [string, unknown][] = [
    ["search_deals", {}],
    ["search_deals", { vendor: "supabase" }],
    ["track_changes", {}],
    ["compare_vendors", { vendors: ["Supabase", "Neon"] }],
    ["plan_stack", { mode: "recommend", use_case: "Next.js SaaS app" }],
    ["plan_stack", { mode: "estimate", services: ["Vercel"] }],
  ];

  it("checks every product call the stdio server proxies", () => {
    assert.strictEqual(STDIO_CALLS.length, 6);
  });

  for (const [name, args] of STDIO_CALLS) {
    const label = `${name} ${JSON.stringify(args)}`;
    it(`${label} keeps the citation through the proxy`, async () => {
      const msg = await rpc("tools/call", { name, arguments: args }) as {
        result?: { content?: { text?: string }[] };
      };
      const text = msg.result?.content?.[0]?.text ?? "";
      const json = JSON.parse(text) as { _provenance?: Record<string, unknown> };
      assert.ok(json._provenance, `${label} lost the citation in the proxy`);
      assert.ok(String(json._provenance.cite_as).startsWith(CITATION_OPENING));
      assert.strictEqual(json._provenance.note, EXPECTED_NOTE);
    });
  }
});

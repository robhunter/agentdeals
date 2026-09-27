import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

const A_RECORD = {
  vendor: "OpenAI",
  previous_state: "The product is available.",
  current_state: "The product is retired.",
  impact: "high",
  source_url: "https://platform.openai.com/docs/deprecations",
  category: "AI/ML",
  alternatives: [],
  date: TODAY,
  recorded_date: YESTERDAY,
  date_source: "hand_written",
};

const REMOVED = { ...A_RECORD, change_type: "free_tier_removed", summary: "The free plan was withdrawn." };
const ENDS = { ...A_RECORD, change_type: "product_deprecated", listing_effect: "ends", summary: "The listed API shut down." };
const NARROWS = { ...A_RECORD, change_type: "product_deprecated", listing_effect: "narrows", summary: "The listed API lost its free quota when its old model retired." };
const ELSEWHERE = { ...A_RECORD, change_type: "product_deprecated", listing_effect: "none", summary: "Widgets Beta shut down; the listed API is unaffected." };
const REDUCED = { ...A_RECORD, change_type: "limits_reduced", summary: "The free allowance was halved." };
const RECORDS = [REMOVED, ENDS, NARROWS, ELSEWHERE, REDUCED];

const EXPECTED: Record<string, { ends_a_free_tier: boolean; listing_effect?: string }> = {
  [REMOVED.summary]: { ends_a_free_tier: true },
  [ENDS.summary]: { ends_a_free_tier: true, listing_effect: "ends" },
  [NARROWS.summary]: { ends_a_free_tier: false, listing_effect: "narrows" },
  [ELSEWHERE.summary]: { ends_a_free_tier: false, listing_effect: "none" },
  [REDUCED.summary]: { ends_a_free_tier: false },
};

type ChangeRecord = { summary: string; ends_a_free_tier?: unknown; listing_effect?: unknown };
type Transport = { name: string; call: (method: string, params: object) => Promise<any> };

const INITIALIZE = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0.1" } };

let dir = "";
let web: ChildProcess | null = null;
let stdio: ChildProcess | null = null;
const transports: Transport[] = [];

async function startWeb(changesPath: string): Promise<string> {
  web = spawn("node", [path.join(REPO, "dist", "serve.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_CHANGES_PATH: changesPath },
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 60000);
    web!.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve(parseInt(m[1], 10)); }
    });
  });
  return `http://localhost:${port}`;
}

async function overHttp(base: string): Promise<Transport> {
  let session: string | null = null;
  let id = 0;
  const post = async (body: object): Promise<any> => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
      body: JSON.stringify(body),
    });
    session = response.headers.get("mcp-session-id") ?? session;
    const text = await response.text();
    const frame = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).pop() ?? text;
    return frame ? JSON.parse(frame) : null;
  };
  await post({ jsonrpc: "2.0", id: ++id, method: "initialize", params: INITIALIZE });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { name: "HTTP", call: (method, params) => post({ jsonrpc: "2.0", id: ++id, method, params }) };
}

async function overStdio(base: string): Promise<Transport> {
  stdio = spawn("node", [path.join(REPO, "dist", "index.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TZ: "UTC", AGENTDEALS_API_URL: base },
  });
  const waiting = new Map<number, (message: any) => void>();
  let pending = "";
  stdio.stdout!.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) {
        try {
          const message = JSON.parse(line);
          waiting.get(message.id)?.(message);
          waiting.delete(message.id);
        } catch {
          continue;
        }
      }
      newline = pending.indexOf("\n");
    }
  });
  let id = 0;
  const call = (method: string, params: object): Promise<any> => {
    const n = ++id;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { waiting.delete(n); reject(new Error(`${method} timed out over stdio`)); }, 20000);
      waiting.set(n, (message) => { clearTimeout(timeout); resolve(message); });
      stdio!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    });
  };
  await call("initialize", INITIALIZE);
  stdio.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return { name: "stdio", call };
}

async function trackChanges(transport: Transport, args: Record<string, unknown>): Promise<any> {
  const response = await transport.call("tools/call", { name: "track_changes", arguments: args });
  assert.ok(response?.result && !response.result.isError, `${transport.name}: ${JSON.stringify(response).slice(0, 300)}`);
  return JSON.parse(response.result.content[0].text);
}

function listingEffectsOf(records: ChangeRecord[]): Record<string, { ends_a_free_tier: unknown; listing_effect?: unknown }> {
  return Object.fromEntries(
    records
      .filter((record) => record.summary in EXPECTED)
      .map((record) => [
        record.summary,
        { ends_a_free_tier: record.ends_a_free_tier, ...("listing_effect" in record ? { listing_effect: record.listing_effect } : {}) },
      ]),
  );
}

async function renderedApp(transport: Transport): Promise<string> {
  const resource = await transport.call("resources/read", { uri: "ui://agentdeals/track-changes" });
  const html: string = resource.result.contents[0].text;
  const script = html.slice(html.indexOf("function render(args, data)"), html.lastIndexOf("</script>"));
  assert.ok(script.startsWith("function render(args, data)"), "the Track Changes app no longer defines render(args, data)");
  const app = { innerHTML: "", querySelectorAll: () => [] };
  const document = {
    getElementById: (id: string) => (id === "app" ? app : null),
    createElement: () => {
      let text = "";
      return {
        set textContent(value: string) { text = value; },
        get innerHTML() { return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); },
      };
    },
  };
  vm.runInNewContext(`${script}\nrender({}, data);`, { document, data: await trackChanges(transport, {}) });
  return app.innerHTML;
}

function tile(rendered: string, label: string): number {
  const match = new RegExp(`<div class="stat-value">(\\d+)</div><div class="stat-label">${label}</div>`).exec(rendered);
  assert.ok(match, `the app renders no ${label} tile`);
  return Number(match[1]);
}

function itemFor(rendered: string, summary: string): string {
  const item = rendered.split('<div class="timeline-item ').slice(1).find((candidate) => candidate.includes(summary));
  assert.ok(item, `the app renders no timeline item for "${summary}"`);
  return item;
}

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "track-changes-app-"));
  const changesPath = path.join(dir, "changes.json");
  writeFileSync(changesPath, JSON.stringify({ changes: RECORDS }));
  const base = await startWeb(changesPath);
  transports.push(await overHttp(base), await overStdio(base));
});

after(() => {
  stdio?.kill();
  web?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("#1302 track_changes says on each record whether it ends a free tier, and the Track Changes app counts Removals from that", () => {
  it("marks each record in the weekly digest, detailed and concise, over both transports", async () => {
    for (const transport of transports) {
      for (const shape of [{}, { response_format: "concise" }]) {
        const digest = await trackChanges(transport, shape);
        assert.deepEqual(listingEffectsOf(digest.deal_changes), EXPECTED, `${transport.name} ${JSON.stringify(shape)}`);
      }
    }
  });

  it("marks each record in a windowed request, detailed and concise, over both transports", async () => {
    for (const transport of transports) {
      for (const response_format of ["detailed", "concise"]) {
        const result = await trackChanges(transport, { since: TODAY, include_expiring: false, response_format });
        assert.deepEqual(listingEffectsOf(result.changes), EXPECTED, `${transport.name} ${response_format}`);
      }
    }
  });

  it("marks each record in a request for a stack, detailed and concise, over both transports", async () => {
    for (const transport of transports) {
      for (const response_format of ["detailed", "concise"]) {
        const result = await trackChanges(transport, { vendors: "OpenAI", since: TODAY, include_expiring: false, response_format });
        const records = [...(result.your_stack_changes ?? result.changes ?? []), ...(result.advisory ?? [])];
        assert.deepEqual(listingEffectsOf(records), EXPECTED, `${transport.name} ${response_format}`);
      }
    }
  });

  it("counts as Removals only the records that end a free tier, and a narrowing deprecation as a Reduction", async () => {
    for (const transport of transports) {
      const rendered = await renderedApp(transport);
      assert.equal(tile(rendered, "Removals"), 2, transport.name);
      assert.equal(tile(rendered, "Reductions"), 2, transport.name);
    }
  });

  it("badges a deprecation of another product as neither a removal nor a reduction", async () => {
    for (const transport of transports) {
      const rendered = await renderedApp(transport);
      const elsewhere = itemFor(rendered, ELSEWHERE.summary);
      assert.ok(elsewhere.startsWith("timeline-other"), `${transport.name}: ${elsewhere.slice(0, 80)}`);
      assert.ok(elsewhere.includes('class="badge badge-blue"'), `${transport.name}: ${elsewhere.slice(0, 300)}`);
      assert.ok(itemFor(rendered, ENDS.summary).includes('class="badge badge-red"'), `${transport.name}: a deprecation that ends the listing is not badged red`);
      assert.ok(itemFor(rendered, NARROWS.summary).includes('class="badge badge-yellow"'), `${transport.name}: a narrowing deprecation is not badged as a reduction`);
    }
  });
});

import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SSE_KEEPALIVE_MS,
  MEASURED_EDGE_STREAM_CUTOFF_MS,
  SSE_KEEPALIVE_FRAME,
  keepaliveIntervalMs,
  sessionRecoveryBody,
} from "../dist/mcp-stream.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KEEPALIVE_MS = 200;
const HOLD_MS = 3000;

function startServer(keepaliveMs = KEEPALIVE_MS): Promise<{ proc: ChildProcess; port: number; stdout: string[] }> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: "0",
        BASE_URL: "http://localhost",
        MCP_SSE_KEEPALIVE_MS: String(keepaliveMs),
      },
    });
    const stdout: string[] = [];
    proc.stdout!.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        if (line.trim()) stdout.push(line);
      }
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 20000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ proc, port: parseInt(match[1], 10), stdout });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function initSession(port: number): Promise<string> {
  const response = await fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "stream-test", version: "1.0.0" } },
    }),
  });
  await response.text();
  const sessionId = response.headers.get("mcp-session-id");
  assert.ok(sessionId, "initialize should return a session ID");
  return sessionId;
}

function openStream(port: number, sessionId: string): Promise<Response> {
  return fetch(`http://localhost:${port}/mcp`, {
    headers: { "Mcp-Session-Id": sessionId, Accept: "text/event-stream" },
  });
}

interface Watcher {
  chunks: string[];
  ended: boolean;
  cancel: () => void;
}

function watch(response: Response): Watcher {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const state: Watcher = { chunks: [], ended: false, cancel: () => void reader.cancel().catch(() => {}) };
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          state.ended = true;
          return;
        }
        state.chunks.push(decoder.decode(value));
      }
    } catch {
      state.ended = true;
    }
  })();
  return state;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("MCP notification stream keepalive", () => {
  it("ships a keepalive interval far below the stream cutoff measured at the edge", () => {
    assert.strictEqual(DEFAULT_SSE_KEEPALIVE_MS, 25_000);
    assert.strictEqual(MEASURED_EDGE_STREAM_CUTOFF_MS, 125_000);
    assert.ok(
      DEFAULT_SSE_KEEPALIVE_MS * 4 <= MEASURED_EDGE_STREAM_CUTOFF_MS,
      "a stream should carry at least four keepalives inside the window that cut it",
    );
  });

  it("keeps a five-minute hold well inside the cutoff at the shipped interval", () => {
    const holdMs = 300_000;
    const frames = Math.floor(holdMs / DEFAULT_SSE_KEEPALIVE_MS);
    assert.ok(frames >= 12, `a 300s hold should carry at least 12 keepalives, carries ${frames}`);
    assert.ok(DEFAULT_SSE_KEEPALIVE_MS < MEASURED_EDGE_STREAM_CUTOFF_MS);
  });

  it("reads the interval from the environment and falls back on unusable values", () => {
    assert.strictEqual(keepaliveIntervalMs({}), DEFAULT_SSE_KEEPALIVE_MS);
    assert.strictEqual(keepaliveIntervalMs({ MCP_SSE_KEEPALIVE_MS: "" }), DEFAULT_SSE_KEEPALIVE_MS);
    assert.strictEqual(keepaliveIntervalMs({ MCP_SSE_KEEPALIVE_MS: "1500" }), 1500);
    assert.strictEqual(keepaliveIntervalMs({ MCP_SSE_KEEPALIVE_MS: "0" }), DEFAULT_SSE_KEEPALIVE_MS);
    assert.strictEqual(keepaliveIntervalMs({ MCP_SSE_KEEPALIVE_MS: "-5" }), DEFAULT_SSE_KEEPALIVE_MS);
    assert.strictEqual(keepaliveIntervalMs({ MCP_SSE_KEEPALIVE_MS: "soon" }), DEFAULT_SSE_KEEPALIVE_MS);
  });

  it("sends a comment frame a conformant client discards rather than a message", () => {
    assert.ok(SSE_KEEPALIVE_FRAME.startsWith(":"), "an SSE keepalive must be a comment line");
    assert.ok(SSE_KEEPALIVE_FRAME.endsWith("\n\n"), "an SSE frame must be terminated by a blank line");
    const dataLines = SSE_KEEPALIVE_FRAME.split("\n").filter((line) => line.startsWith("data:"));
    assert.deepStrictEqual(dataLines, [], "a keepalive must not carry a data line");
  });

  it("names the condition and the recovery in every session error body", () => {
    const unknown = sessionRecoveryBody("unknown_session");
    assert.strictEqual(unknown.error.data.condition, "unknown_session");
    assert.strictEqual(unknown.error.data.recovery, "reinitialize");
    assert.match(unknown.error.message, /session ID you sent/);
    assert.match(unknown.error.message, /initialize/);

    const missing = sessionRecoveryBody("no_session");
    assert.strictEqual(missing.error.data.condition, "no_session");
    assert.strictEqual(missing.error.data.recovery, "reinitialize");
    assert.match(missing.error.message, /no Mcp-Session-Id header/);
    assert.match(missing.error.message, /initialize/);

    assert.notStrictEqual(
      unknown.error.message,
      missing.error.message,
      "the two conditions must not share one message",
    );
  });
});

describe("MCP notification stream over HTTP", () => {
  let proc: ChildProcess | null = null;
  const watchers: Watcher[] = [];

  afterEach(() => {
    for (const watcher of watchers.splice(0)) watcher.cancel();
    if (proc) {
      proc.kill();
      proc = null;
    }
  });

  it("holds the stream open across many keepalive intervals", async () => {
    const started = await startServer();
    proc = started.proc;
    const sessionId = await initSession(started.port);

    const stream = await openStream(started.port, sessionId);
    assert.strictEqual(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);

    const watcher = watch(stream);
    watchers.push(watcher);
    await sleep(HOLD_MS);

    const expected = Math.floor(HOLD_MS / KEEPALIVE_MS / 2);
    assert.ok(
      watcher.chunks.length >= expected,
      `expected at least ${expected} keepalives in ${HOLD_MS}ms, saw ${watcher.chunks.length}`,
    );
    assert.strictEqual(watcher.ended, false, "the stream closed while the client was still holding it");
    for (const chunk of watcher.chunks) {
      assert.ok(chunk.startsWith(":"), `keepalive chunk was not a comment frame: ${JSON.stringify(chunk)}`);
    }

  });

  it("puts a byte on the stream at once so a proxy forwards the response instead of holding it", async () => {
    const slowKeepalive = 4000;
    const started = await startServer(slowKeepalive);
    proc = started.proc;
    const sessionId = await initSession(started.port);

    const openedAt = Date.now();
    const stream = await openStream(started.port, sessionId);
    assert.strictEqual(stream.status, 200);
    const watcher = watch(stream);
    watchers.push(watcher);

    const waitedFor = 1000;
    await sleep(waitedFor);
    assert.ok(
      watcher.chunks.length >= 1,
      `no byte reached the client in ${Date.now() - openedAt}ms, so a proxy has nothing to forward until ${slowKeepalive}ms`,
    );
    assert.ok(
      waitedFor < slowKeepalive / 2,
      "the first byte must arrive well before the first scheduled keepalive or this asserts nothing",
    );
  });

  it("releases the stream slot when the client disconnects", async () => {
    const started = await startServer();
    proc = started.proc;
    const sessionId = await initSession(started.port);

    const stream = await openStream(started.port, sessionId);
    assert.strictEqual(stream.status, 200);
    const watcher = watch(stream);
    await sleep(KEEPALIVE_MS * 2);
    watcher.cancel();
    await sleep(KEEPALIVE_MS * 3);

    const closes = started.stdout
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((event) => event?.event === "stream_close" && event.sessionId === sessionId);
    assert.ok(closes.length >= 1, "the server did not record the stream closing when the client went away");
    assert.strictEqual(closes[0].reason, "client_disconnect");

    const reopened = await openStream(started.port, sessionId);
    assert.strictEqual(reopened.status, 200, "the released slot should accept a fresh stream");
    const reopenedWatcher = watch(reopened);
    watchers.push(reopenedWatcher);
    await sleep(KEEPALIVE_MS * 3);
    assert.ok(reopenedWatcher.chunks.length > 0, "the fresh stream should carry keepalives");
  });

  it("accepts a reconnect on a session that still holds a stream instead of answering 409", async () => {
    const started = await startServer();
    proc = started.proc;
    const sessionId = await initSession(started.port);

    const first = await openStream(started.port, sessionId);
    assert.strictEqual(first.status, 200);
    const firstWatcher = watch(first);
    watchers.push(firstWatcher);
    await sleep(KEEPALIVE_MS * 3);
    assert.ok(firstWatcher.chunks.length > 0, "the first stream should be live before the reconnect");

    const second = await openStream(started.port, sessionId);
    assert.strictEqual(second.status, 200, "a reconnect must not be refused");
    assert.match(second.headers.get("content-type") ?? "", /text\/event-stream/);

    await sleep(KEEPALIVE_MS * 3);
    assert.strictEqual(firstWatcher.ended, true, "the replaced stream must be closed, not left dangling");

    const secondWatcher = watch(second);
    watchers.push(secondWatcher);
    await sleep(KEEPALIVE_MS * 3);
    assert.ok(secondWatcher.chunks.length > 0, "the replacement stream should carry keepalives");

    const stillUsable = await fetch(`http://localhost:${started.port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId,
      },
      body: JSON.stringify([
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ]),
    });
    assert.strictEqual(stillUsable.status, 200, "the session must survive the stream replacement");
    assert.match(await stillUsable.text(), /"tools"/);

  });

  it("tells a client which session condition it hit and that it should re-initialize", async () => {
    const started = await startServer();
    proc = started.proc;
    await initSession(started.port);

    const unknownStream = await fetch(`http://localhost:${started.port}/mcp`, {
      headers: { "Mcp-Session-Id": "a-session-this-server-never-issued", Accept: "text/event-stream" },
    });
    assert.strictEqual(unknownStream.status, 400);
    const unknownBody = await unknownStream.json() as any;
    assert.strictEqual(unknownBody.error.data.condition, "unknown_session");
    assert.strictEqual(unknownBody.error.data.recovery, "reinitialize");
    assert.match(unknownBody.error.message, /initialize/);

    const noSessionStream = await fetch(`http://localhost:${started.port}/mcp`, {
      headers: { Accept: "text/event-stream" },
    });
    assert.strictEqual(noSessionStream.status, 400);
    const noSessionBody = await noSessionStream.json() as any;
    assert.strictEqual(noSessionBody.error.data.condition, "no_session");
    assert.strictEqual(noSessionBody.error.data.recovery, "reinitialize");
    assert.match(noSessionBody.error.message, /initialize/);

    const unknownPost = await fetch(`http://localhost:${started.port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": "a-session-this-server-never-issued",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    });
    assert.strictEqual(unknownPost.status, 400);
    const unknownPostBody = await unknownPost.json() as any;
    assert.strictEqual(unknownPostBody.error.data.condition, "unknown_session");
    assert.strictEqual(unknownPostBody.error.data.recovery, "reinitialize");
  });

  it("never answers a stream request with the bare conflict body a client cannot act on", async () => {
    const started = await startServer();
    proc = started.proc;
    const sessionId = await initSession(started.port);

    const bodies: string[] = [];
    const held: Watcher[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await openStream(started.port, sessionId);
      assert.strictEqual(response.status, 200, `reconnect ${attempt} was refused with ${response.status}`);
      const heldWatcher = watch(response);
      held.push(heldWatcher);
      watchers.push(heldWatcher);
      await sleep(KEEPALIVE_MS);
    }

    const conflicted = await fetch(`http://localhost:${started.port}/mcp`, {
      headers: { "Mcp-Session-Id": "a-session-this-server-never-issued", Accept: "text/event-stream" },
    });
    bodies.push(await conflicted.text());
    for (const body of bodies) {
      assert.ok(!body.includes("Only one SSE stream"), "a client was handed a conflict it cannot recover from");
    }

  });
});

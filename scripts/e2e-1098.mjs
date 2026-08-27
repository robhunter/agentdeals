import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const UA = "agentdeals-internal/1.0 (issue-1098 stream-lifetime check)";
const MEASURED_EDGE_STREAM_CUTOFF_MS = 125_000;

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const holdSeconds = Number(arg("hold", "330"));
const remoteUrl = arg("url", null);

const failures = [];
function check(ok, message) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${message}`);
  if (!ok) failures.push(message);
}

function startLocalServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("server startup timeout"));
    }, 30000);
    proc.stderr.on("data", (data) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ proc, base: `http://localhost:${match[1]}` });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function initSession(base) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "User-Agent": UA },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agentdeals-internal", version: "1.0.0" },
      },
    }),
  });
  await response.text();
  return { sessionId: response.headers.get("mcp-session-id"), via: response.headers.get("server") ?? "-" };
}

function openStream(base, sessionId) {
  return fetch(`${base}/mcp`, {
    headers: { "Mcp-Session-Id": sessionId, Accept: "text/event-stream", "User-Agent": UA },
  });
}

async function main() {
  let proc = null;
  let base = remoteUrl;
  if (!base) {
    const started = await startLocalServer();
    proc = started.proc;
    base = started.base;
  }
  console.log(`target ${base}`);
  console.log(`hold ${holdSeconds}s`);

  const { sessionId, via } = await initSession(base);
  check(Boolean(sessionId), `initialize returned a session ID (served by ${via})`);
  if (!sessionId) {
    proc?.kill();
    process.exit(1);
  }

  const stream = await openStream(base, sessionId);
  check(stream.status === 200, `GET /mcp opened the stream (status ${stream.status})`);
  if (stream.status !== 200) {
    console.log(`  body: ${(await stream.text()).slice(0, 400)}`);
    proc?.kill();
    process.exit(1);
  }

  const openedAt = Date.now();
  const arrivals = [];
  let ended = false;
  let endedAt = null;
  const reader = stream.body.getReader();
  const pump = (async () => {
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) {
          ended = true;
          endedAt = Date.now() - openedAt;
          return;
        }
        arrivals.push(Date.now() - openedAt);
      }
    } catch (err) {
      ended = true;
      endedAt = Date.now() - openedAt;
      console.log(`  stream read error at ${endedAt}ms: ${err.name}`);
    }
  })();

  const deadline = openedAt + holdSeconds * 1000;
  while (Date.now() < deadline && !ended) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const elapsed = Math.round((Date.now() - openedAt) / 1000);
    if (elapsed % 30 === 0 || elapsed % 30 === 1) {
      console.log(`  ${elapsed}s elapsed, ${arrivals.length} frames, open=${!ended}`);
    }
  }

  const heldMs = Date.now() - openedAt;
  check(!ended, ended ? `stream stayed open (it closed at ${endedAt}ms)` : `stream stayed open for ${heldMs}ms`);
  check(
    heldMs > 300_000 || holdSeconds <= 300,
    `hold exceeded the 300s bar (held ${Math.round(heldMs / 1000)}s)`,
  );

  const gaps = [];
  let previous = 0;
  for (const arrival of arrivals) {
    gaps.push(arrival - previous);
    previous = arrival;
  }
  const maxGap = gaps.length ? Math.max(...gaps) : heldMs;
  console.log(`  frames ${arrivals.length}, max gap ${maxGap}ms`);
  check(
    maxGap < MEASURED_EDGE_STREAM_CUTOFF_MS,
    `longest silence on the stream stayed under the measured ${MEASURED_EDGE_STREAM_CUTOFF_MS}ms cutoff (${maxGap}ms)`,
  );

  const stillUsable = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": sessionId,
      "User-Agent": UA,
    },
    body: JSON.stringify([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]),
  });
  const usableBody = await stillUsable.text();
  check(
    stillUsable.status === 200 && usableBody.includes("\"tools\""),
    `session still served tools/list after the hold (status ${stillUsable.status})`,
  );

  const reconnect = await openStream(base, sessionId);
  check(reconnect.status === 200, `reconnect while the first stream is open returned ${reconnect.status}`);
  if (reconnect.status === 200) {
    await reconnect.body.cancel();
  } else {
    console.log(`  body: ${(await reconnect.text()).slice(0, 400)}`);
  }

  await reader.cancel().catch(() => {});
  await pump;
  proc?.kill();

  console.log(failures.length === 0 ? "e2e-1098: all checks passed" : `e2e-1098: ${failures.length} check(s) failed`);
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();

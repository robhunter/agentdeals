import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutLocalConnectionReuse } from "../scripts/local-test-fetch.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;

async function runChild(source: string, env = process.env): Promise<{ status: number | null; output: string }> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => output += chunk);
  child.stderr.on("data", chunk => output += chunk);
  const [status] = await once(child, "exit");
  return { status, output };
}

describe("local test fetch connection lifetime", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    it(`closes ${host} connections without changing the response`, async () => {
      const response = new Response("body", { status: 201 });
      let calls = 0;
      const request: typeof fetch = async (input, init) => {
        calls++;
        assert.equal(String(input), `http://${host}:3000/route`);
        assert.equal(new Headers(init?.headers).get("connection"), "close");
        assert.equal(new Headers(init?.headers).get("x-fixture"), "supplied");
        return response;
      };
      assert.equal(await withoutLocalConnectionReuse(request)(`http://${host}:3000/route`, { headers: { "x-fixture": "supplied" } }), response);
      assert.equal(calls, 1);
    });
  }

  for (const url of ["https://example.com/route", "http://localhost.example.com/route", "http://127.0.0.2/route", "not a URL"]) {
    it(`passes ${url} through unchanged`, async () => {
      const init = { headers: { connection: "keep-alive" } };
      const response = new Response("remote");
      const request: typeof fetch = async (input, actual) => {
        assert.equal(input, url);
        assert.equal(actual, init);
        return response;
      };
      assert.equal(await withoutLocalConnectionReuse(request)(url, init), response);
    });
  }

  it("retains Request headers and does not mutate supplied inputs", async () => {
    const input = new Request("https://localhost/route", { headers: { "x-request": "present", connection: "keep-alive" } });
    const request: typeof fetch = async (actual, init) => {
      assert.equal(actual, input);
      assert.equal(new Headers(init?.headers).get("x-request"), "present");
      assert.equal(new Headers(init?.headers).get("connection"), "close");
      return new Response();
    };
    await withoutLocalConnectionReuse(request)(input);
    assert.equal(input.headers.get("connection"), "keep-alive");
    const headers = new Headers({ "x-override": "present", connection: "keep-alive" });
    await withoutLocalConnectionReuse(async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("x-request"), null);
      assert.equal(new Headers(init?.headers).get("x-override"), "present");
      return new Response();
    })(input, { headers });
    assert.equal(headers.get("connection"), "keep-alive");
  });

  it("preserves methods, bodies, signals, redirects and streaming responses", async () => {
    const controller = new AbortController();
    const body = new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode("first")); } });
    const response = new Response(body, { status: 202 });
    const input = new Request("http://localhost/stream", { method: "POST", body: "supplied", signal: controller.signal });
    const init = { redirect: "manual" as RequestRedirect, signal: controller.signal };
    const request: typeof fetch = async (actual, options) => {
      assert.equal(actual, input);
      assert.equal((actual as Request).method, "POST");
      assert.equal(await (actual as Request).clone().text(), "supplied");
      assert.equal(options?.signal, controller.signal);
      assert.equal(options?.redirect, "manual");
      return response;
    };
    const actual = await withoutLocalConnectionReuse(request)(input, init);
    assert.equal(actual, response);
    assert.equal(actual.bodyUsed, false);
    const reader = actual.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
    await reader.cancel();
  });

  for (const status of [204, 301, 404, 429, 500]) {
    it(`returns HTTP ${status} untouched after one request`, async () => {
      let calls = 0;
      const response = new Response(null, { status, headers: { location: "/target" } });
      const actual = await withoutLocalConnectionReuse(async () => { calls++; return response; })("http://localhost/route");
      assert.equal(actual, response);
      assert.equal(actual.status, status);
      assert.equal(calls, 1);
    });
  }

  for (const code of ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "ECONNREFUSED", "ABORT_ERR"]) {
    it(`does not retry or replace ${code}`, async () => {
      let calls = 0;
      const error = Object.assign(new Error(code), { code });
      await assert.rejects(withoutLocalConnectionReuse(async () => { calls++; throw error; })("http://localhost/route"), actual => actual === error);
      assert.equal(calls, 1);
    });
  }

  for (const command of ["test", "test:gated", "marked"]) {
    it(`${command} protects a newly written bare-fetch test and its child`, { timeout: 30000 }, async () => {
      const work = mkdtempSync(join(tmpdir(), "local-test-fetch-"));
      try {
        mkdirSync(join(work, "test/workers"), { recursive: true });
        if (command === "marked") {
          mkdirSync(join(work, "scripts"));
          mkdirSync(join(work, "data"));
          for (const file of ["test-marked-conditions.mjs", "local-test-fetch.js"]) {
            writeFileSync(join(work, "scripts", file), readFileSync(join(root, "scripts", file)));
          }
          writeFileSync(join(work, "scripts/sync-page-reviews.js"), "");
          writeFileSync(join(work, "data/index.json"), JSON.stringify({ offers: Array.from({ length: 3 }, () => ({ conditions: [{ operating_detail: true }, {}] })) }));
          writeFileSync(join(work, "data/page-reviews.json"), "{}");
        } else symlinkSync(join(root, "scripts"), join(work, "scripts"), "dir");
        writeFileSync(join(work, "package.json"), JSON.stringify({ type: "module", scripts: { [command]: scripts[command] } }));
        writeFileSync(join(work, command === "marked" ? "test/conditions-plain.test.ts" : "test/workers/plain.test.ts"), `
import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
it("uses plain fetch", async () => {
  const server = createServer((req, res) => {
    res.setHeader("x-connection", req.headers.connection || "");
    res.end("complete");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port + "/plain";
  try {
    const response = await fetch(url);
    assert.equal(await response.text(), "complete");
    assert.equal(response.headers.get("x-connection"), "close");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(`import { createServer } from "node:http";
const server = createServer((req, res) => res.end(req.headers.connection));
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try { const result = await (await fetch("http://127.0.0.1:" + server.address().port)).text();
if (result !== "close") throw new Error(result); } finally { server.closeAllConnections(); server.close(); }`)}], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});`);
        const env = { ...process.env, GATE_FAILING_TESTS: join(work, "failures.jsonl"), TEST_SHARD: "" };
        delete env.NODE_TEST_CONTEXT;
        delete env.NODE_OPTIONS;
        const result = await runChild(`import { spawnSync } from "node:child_process";
for (const args of [["init", "-q"], ["add", "package.json"]]) {
 const result = spawnSync("git", args, { cwd: ${JSON.stringify(work)}, encoding: "utf8" });
 if (result.status !== 0) throw new Error(result.stderr);
}
const result = spawnSync(${JSON.stringify(command === "marked" ? process.execPath : "npm")}, ${JSON.stringify(command === "marked" ? ["scripts/test-marked-conditions.mjs"] : ["run", command])}, { cwd: ${JSON.stringify(work)}, env: process.env, encoding: "utf8", timeout: 20000 });
process.stdout.write(result.stdout + result.stderr);
process.exit(result.status ?? 1);`, env);
        assert.equal(result.status, 0, result.output);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  }

  it("a plain-fetch child survives ten gaps beyond the server idle timeout", { timeout: 95000 }, async () => {
    const result = await runChild(`
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
const source = ${JSON.stringify(`import { createServer } from "node:http";
let connections = 0;
const server = createServer((req, res) => {
 res.setHeader("x-connections", String(connections));
 res.end("x".repeat(1363612));
});
server.on("connection", () => connections++);
server.listen(0, "127.0.0.1", () => process.send({ port: server.address().port, idle: server.keepAliveTimeout + (server.keepAliveTimeoutBuffer || 0) }));`)};
const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
try {
 const [server] = await once(child, "message");
 const url = "http://127.0.0.1:" + server.port + "/large-body";
 for (let run = 1; run <= 10; run++) {
  assert.equal((await (await fetch(url)).text()).length, 1363612);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, server.idle + 500);
  const response = await fetch(url);
  assert.equal((await response.text()).length, 1363612);
  assert.equal(Number(response.headers.get("x-connections")), run * 2);
  console.log("gap-run " + run + ": passed after " + (server.idle + 500) + "ms");
 }
} finally { child.kill(); await once(child, "exit"); }`, {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${new URL("../scripts/local-test-fetch.js", import.meta.url).href}`,
    });
    assert.equal(result.status, 0, result.output);
    assert.equal((result.output.match(/gap-run \d+: passed/g) || []).length, 10, result.output);
  });
});

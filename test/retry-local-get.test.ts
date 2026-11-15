import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { retryLocalGets } from "./retry-local-get.ts";

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse, attempt: number) => void,
  check: (base: string, count: () => number) => Promise<void>,
): Promise<void> {
  let attempts = 0;
  const server = createServer((request, response) => handler(request, response, ++attempts));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await check(`http://127.0.0.1:${address.port}`, () => attempts);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function truncate(response: ServerResponse): void {
  response.writeHead(200, { "Content-Length": "1000" });
  response.flushHeaders();
  response.write("partial");
  setTimeout(() => response.destroy(), 10);
}

describe("retrying a GET from the local test server", () => {
  for (const failures of [1, 2]) {
    it(`reads the complete body after ${failures} dropped connections`, async () => {
      await withServer((request, response, attempt) => {
        if (attempt <= failures) request.socket.destroy();
        else response.end("complete");
      }, async (base, count) => {
        assert.equal(await (await retryLocalGets(base)(`${base}/a-route`)).text(), "complete");
        assert.equal(count(), failures + 1);
      });
    });
  }

  it("retries a body that drops after its headers, without returning partial text", async () => {
    await withServer((_request, response, attempt) => {
      if (attempt === 1) truncate(response);
      else response.end("complete");
    }, async (base, count) => {
      assert.equal(await (await retryLocalGets(base)(`${base}/body`)).text(), "complete");
      assert.equal(count(), 2);
    });
  });

  for (const bodyStarted of [false, true]) {
    it(`names the route after three drops ${bodyStarted ? "during the body" : "before headers"}`, async () => {
      await withServer((request, response, attempt) => {
        if (attempt > 3) return response.end("unexpected fourth request");
        if (bodyStarted) truncate(response);
        else request.socket.destroy();
      }, async (base, count) => {
        await assert.rejects(retryLocalGets(base)(`${base}/always-drops`), {
          message: `GET ${base}/always-drops failed on attempt 3`,
        });
        assert.equal(count(), 3);
      });
    });
  }

  for (const status of [404, 429, 500]) {
    it(`fails on HTTP ${status} without retrying`, async () => {
      await withServer((_request, response) => {
        response.writeHead(status);
        response.end("error");
      }, async (base, count) => {
        await assert.rejects(retryLocalGets(base)(`${base}/http-error`), (error: Error & { cause?: Error }) => {
          assert.match(error.message, /\/http-error failed on attempt 1$/);
          assert.match(error.cause!.message, new RegExp(`HTTP ${status}`));
          return true;
        });
        assert.equal(count(), 1);
      });
    });
  }

  it("leaves a wrong body to its assertion after one request", async () => {
    await withServer((_request, response) => response.end("wrong wording"), async (base, count) => {
      const body = await (await retryLocalGets(base)(`${base}/wrong-body`)).text();
      assert.throws(() => assert.equal(body, "expected wording"), assert.AssertionError);
      assert.equal(count(), 1);
    });
  });

  it("leaves malformed JSON to its parser after one request", async () => {
    await withServer((_request, response) => response.end("not JSON"), async (base, count) => {
      const response = await retryLocalGets(base)(`${base}/invalid-json`);
      await assert.rejects(response.json(), SyntaxError);
      assert.equal(count(), 1);
    });
  });

  for (const code of ["ECONNREFUSED", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT", "ABORT_ERR"]) {
    it(`does not retry ${code}`, async () => {
      let attempts = 0;
      const request: typeof fetch = async () => {
        attempts++;
        throw new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
      };
      await assert.rejects(retryLocalGets("http://localhost", request)("http://localhost/route"));
      assert.equal(attempts, 1);
    });
  }

  for (const code of ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]) {
    it(`retries nested ${code} causes at most twice`, async () => {
      let attempts = 0;
      const request: typeof fetch = async () => {
        attempts++;
        if (attempts > 3) throw new Error("unexpected fourth attempt");
        throw new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
      };
      await assert.rejects(retryLocalGets("http://localhost", request)("http://localhost/route"), /attempt 3/);
      assert.equal(attempts, 3);
    });
  }

  it("does not retry an aborted request even when its cause is a dropped connection", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const request: typeof fetch = async () => {
      attempts++;
      controller.abort();
      throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
    };
    await assert.rejects(retryLocalGets("http://localhost", request)("http://localhost/route", { signal: controller.signal }));
    assert.equal(attempts, 1);
  });

  for (const [url, method] of [["http://localhost/route", "POST"], ["https://example.com/route", "GET"]]) {
    it(`leaves ${method} ${url} outside the retry boundary`, async () => {
      let attempts = 0;
      const error = Object.assign(new Error("reset"), { code: "ECONNRESET" });
      const request: typeof fetch = async () => { attempts++; throw error; };
      await assert.rejects(retryLocalGets("http://localhost", request)(url, { method }), error);
      assert.equal(attempts, 1);
    });
  }

  it("refuses to install retries for an external origin", () => {
    assert.throws(() => retryLocalGets("https://example.com"), /Expected a local test server/);
  });

  it("preloads the same local GET reader in a child process", async () => {
    await withServer((request, response, attempt) => {
      if (attempt === 1) request.socket.destroy();
      else response.end('{"complete":true}');
    }, async (base, count) => {
      const child = spawn(process.execPath, [
        "--import", new URL("./retry-local-get.ts", import.meta.url).href,
        "--input-type=module", "-e", "console.log(JSON.stringify(await (await fetch(process.argv[1])).json()))", `${base}/child`,
      ], { env: { ...process.env, AGENTDEALS_TEST_HTTP_ORIGIN: base } });
      let stdout = "", stderr = "";
      child.stdout.on("data", data => { stdout += data; });
      child.stderr.on("data", data => { stderr += data; });
      const exit = await new Promise<number | null>((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
      assert.equal(exit, 0, stderr);
      assert.deepEqual(JSON.parse(stdout), { complete: true });
      assert.equal(count(), 2);
    });
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fetchPageText } from "../scripts/verify-freshness.js";
import { checkOfficialMcpEntry } from "../scripts/check-official-mcp.js";
import { createArchiveClient } from "../scripts/archive-captures.js";
import { renderArguments } from "../scripts/rendered-page.js";

const english = "en-US,en;q=0.9";
const quote = "The MCP server connects an AI agent to your workspace.";

async function withPages(run: (base: string, requests: Array<{ path: string; language?: string; accept?: string; method?: string; body: string }>) => Promise<void>) {
  const requests: Array<{ path: string; language?: string; accept?: string; method?: string; body: string }> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const language = req.headers["accept-language"];
    requests.push({ path: req.url!, language, accept: req.headers.accept, method: req.method, body });
    if (req.url === "/redirect") return void res.writeHead(302, { Location: "/page" }).end();
    if (req.url === "/cdx/search/cdx" || req.url?.startsWith("/cdx/search/cdx?")) {
      return void res.end(JSON.stringify([["timestamp", "original", "statuscode", "mimetype"], ["20261101000000", "https://example.com/page", "200", "text/html"]]));
    }
    if (req.url === "/npm") return void res.end(JSON.stringify({ "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { version: "1.0.0" } } }));
    if (req.url === "/endpoint") return void res.writeHead(401).end("Authentication required");
    const text = language === english ? quote.repeat(12) : "Eine andere Sprache.".repeat(4);
    res.end(`<html lang="${language === english ? "en-US" : "de"}"><body><p>${text}</p></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test("catalogue page reads ask for English across redirects", async () => {
  await withPages(async (base, requests) => {
    const result = await fetchPageText(`${base}/redirect`, { render: async () => { throw new Error("Unexpected rendering fallback"); } });
    assert.equal(result.ok, true);
    assert.equal(result.text, quote.repeat(12));
    assert.deepEqual(requests.map(request => request.path), ["/redirect", "/page"]);
    assert.deepEqual(requests.map(request => request.language), [english, english]);
    assert.ok(requests.every(request => request.accept === "text/html,application/xhtml+xml"));
  });
});

for (const kind of ["remote", "npm"] as const) {
  test(`official MCP ${kind} checks ask for English and preserve request headers`, async () => {
    await withPages(async (base, requests) => {
      const fetchImpl = (url: string, init?: RequestInit) => fetch(`${base}${url.includes("registry.npmjs.org") ? "/npm" : new URL(url).pathname}`, init);
      const result = await checkOfficialMcpEntry({ kind, target: kind === "npm" ? "example-mcp" : "https://api.example.com/endpoint",
        transport: kind === "npm" ? "stdio" : "Streamable HTTP", authentication: "an API key",
        doc_url: "https://docs.example.com/page", source_quote: quote, read_on: "2026-11-01" }, { fetchImpl });
      assert.deepEqual(result, { passed: true });
      assert.equal(requests.length, 2);
      assert.ok(requests.every(request => request.language === english));
      const target = requests[1];
      if (kind === "npm") assert.equal(target.accept, "application/vnd.npm.install-v1+json");
      else {
        assert.equal(target.method, "POST");
        assert.equal(target.accept, "application/json, text/event-stream");
        assert.equal(JSON.parse(target.body).method, "initialize");
      }
    });
  });
}

test("archive listing and snapshot reads ask for English", async () => {
  await withPages(async (base, requests) => {
    const archive = createArchiveClient({ minIntervalMs: 0, fetchImpl: (url: string, init?: RequestInit) => fetch(`${base}${new URL(url).pathname}${new URL(url).search}`, init) });
    const listing = await archive.captures("https://example.com/page", "2026-11-01", "2026-11-02");
    assert.equal(listing.captures.length, 1);
    const page = await archive.captureHtml(listing.captures[0]);
    assert.equal(page.unavailable, undefined);
    assert.ok(page.html.includes(quote));
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.language === english));
  });
});

test("rendered catalogue reads keep English after environment arguments", () => {
  const args = renderArguments("https://example.com/page", { env: { AGENTDEALS_RENDERER_ARGS: "--accept-lang=de --lang=de" } });
  assert.deepEqual(args.filter((arg: string) => arg.startsWith("--accept-lang=")), ["--accept-lang=de", "--accept-lang=en-US,en"]);
  assert.deepEqual(args.filter((arg: string) => arg.startsWith("--lang=")), ["--lang=de", "--lang=en-US"]);
  assert.equal(args.at(-1), "https://example.com/page");
});

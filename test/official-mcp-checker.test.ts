import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { checkOfficialMcpEntry, checkOfficialMcpListings } from "../scripts/check-official-mcp.js";
import { officialMcpKey, withCheckedOfficialMcp } from "../dist/official-mcp.js";

const quote = "The MCP server connects an AI agent to your workspace.";
const entry = { kind: "remote", target: "https://api.example.com/status/401", transport: "Streamable HTTP",
  authentication: "an API key", doc_url: "https://docs.example.com/mcp", source_quote: quote, read_on: "2026-10-20" };
const offer = (vendor: string, server = entry) => ({ vendor, url: `https://${vendor.toLowerCase()}.example/pricing`,
  tier: "Free", official_mcp_servers: [server] });
const requests: Array<{ url: string; method: string; body: string; session?: string }> = [];
let base: string;
const server = createServer(async (request, response) => {
  const url = new URL(new URL(request.url!, "http://localhost").searchParams.get("url")!);
  let body = "";
  for await (const chunk of request) body += chunk;
  requests.push({ url: url.toString(), method: request.method!, body, session: request.headers["mcp-session-id"] as string });
  if (url.hostname === "docs.example.com") {
    if (url.pathname === "/blocked") response.writeHead(403).end("Access denied");
    else response.end(url.pathname === "/missing" ? "The guide describes something else."
      : url.pathname === "/linked" ? `<p>The MCP server connects an AI agent to your <a href="/workspace">workspace</a>.</p>`
      : url.pathname === "/joined" ? `<p>The MCP server connects an AIagent to your workspace.</p>`
      : `<p>The MCP server connects an <b>AI</b> agent to your workspace.</p>`);
  } else if (url.hostname === "registry.npmjs.org") {
    const name = decodeURIComponent(url.pathname.slice(1));
    if (name === "missing") response.writeHead(404).end("not found");
    else if (name === "malformed") response.end("not JSON");
    else if (name === "no-latest") response.end(JSON.stringify({ versions: {} }));
    else if (name === "malformed-version") response.end(JSON.stringify({ "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": "broken" } }));
    else response.end(JSON.stringify({ "dist-tags": { latest: "1.0.0" }, versions: {
      "1.0.0": { name, version: "1.0.0", ...(name === "deprecated" || name === "retired"
        ? { deprecated: "Package no longer supported." } : {}) }, "2.0.0-beta": { deprecated: "Do not use this beta." },
    } }));
  } else if (url.hostname === "pypi.org") {
    const name = url.pathname.split("/")[2];
    if (name === "missing") response.writeHead(404).end("missing");
    else response.end(JSON.stringify({ info: { version: "1.0", yanked: name === "yanked" },
      urls: name === "empty" ? [] : [{ yanked: name === "yanked" }, { yanked: name !== "mixed" }],
      releases: { "0.1": [{ yanked: true }] } }));
  } else if (url.hostname === "github.com") {
    response.writeHead(url.pathname.endsWith("missing") ? 404 : 200).end("Repository page");
  } else if (request.method === "DELETE") {
    response.writeHead(204).end();
  } else {
    const status = Number(url.pathname.split("/").at(-1));
    if (status === 200) response.setHeader("mcp-session-id", "fixture-session");
    if (url.pathname.includes("stream")) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
    } else response.writeHead(status).end(status === 200 ? '{"jsonrpc":"2.0","id":1,"result":{}}' : "authentication required");
  }
});
const fetchImpl = (url: string | URL | Request, init?: RequestInit) => fetch(`${base}/?url=${encodeURIComponent(String(url))}`, init);

before(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe("an official MCP entry checked over HTTP", () => {
  for (const status of [200, 401, 405]) {
    it(`accepts endpoint HTTP ${status} when its documented quote remains`, async () => {
      const target = `https://api.example.com/status/${status}`;
      assert.deepEqual(await checkOfficialMcpEntry({ ...entry, target }, { fetchImpl }), { passed: true });
      const request = requests.findLast(request => request.url === target && request.method === "POST")!;
      const rpc = JSON.parse(request.body);
      assert.equal(rpc.method, "initialize");
      assert.equal(rpc.params.protocolVersion, "2025-06-18");
      if (status === 200) assert.ok(requests.some(request => request.url === target && request.method === "DELETE" && request.session === "fixture-session"));
    });
  }

  it("does not wait for an initialized event stream to end", async () => {
    assert.deepEqual(await checkOfficialMcpEntry({ ...entry, target: "https://api.example.com/stream/200" }, { fetchImpl, timeoutMs: 1000 }), { passed: true });
  });

  for (const status of [404, 410]) {
    it(`fails endpoint HTTP ${status}`, async () => {
      const result = await checkOfficialMcpEntry({ ...entry, target: `https://api.example.com/status/${status}` }, { fetchImpl });
      assert.equal(result.passed, false);
      assert.match(result.detail!, new RegExp(String(status)));
    });
  }

  it("fails missing documentation, a missing quote, and a quote hidden in script", async () => {
    for (const doc_url of ["https://docs.example.com/blocked", "https://docs.example.com/missing"]) {
      assert.equal((await checkOfficialMcpEntry({ ...entry, doc_url }, { fetchImpl })).passed, false);
    }
    const script = async () => new Response(`<script>${quote}</script><p>No matching visible quote.</p>`);
    assert.equal((await checkOfficialMcpEntry(entry, { fetchImpl: script })).passed, false);
  });

  it("ignores a markup-generated space before punctuation while preserving word boundaries", async () => {
    assert.equal((await checkOfficialMcpEntry({ ...entry, doc_url: "https://docs.example.com/linked" }, { fetchImpl })).passed, true);
    assert.equal((await checkOfficialMcpEntry({ ...entry, doc_url: "https://docs.example.com/joined" }, { fetchImpl })).passed, false);
  });

  it("reads numeric HTML entities as the document renders them", async () => {
    for (const encoded of ["&#39;", "&#x27;", "&#X27;"]) {
      const source_quote = "The vendor's MCP server connects an AI agent.";
      const fetchImpl = async (url: string) => new Response(url.includes("docs.")
        ? `<p>The vendor${encoded}s MCP server connects an AI agent.</p>` : "", { status: url.includes("docs.") ? 200 : 401 });
      assert.equal((await checkOfficialMcpEntry({ ...entry, source_quote }, { fetchImpl })).passed, true);
      assert.equal((await checkOfficialMcpEntry({ ...entry, source_quote: source_quote + " Extra." }, { fetchImpl })).passed, false);
    }
    const fetchImpl = async (url: string) => new Response(url.includes("docs.")
      ? "<p>Connect &#x1F680; with &#233; and &#x110000;.</p>" : "", { status: url.includes("docs.") ? 200 : 401 });
    assert.equal((await checkOfficialMcpEntry({ ...entry, source_quote: "Connect 🚀 with é and &#x110000;." }, { fetchImpl })).passed, true);
  });

  it("reads npm latest rather than a deprecated prerelease", async () => {
    assert.deepEqual(await checkOfficialMcpEntry({ ...entry, kind: "npm", target: "active" }, { fetchImpl }), { passed: true });
    for (const target of ["deprecated", "missing", "malformed", "no-latest", "malformed-version"]) {
      assert.equal((await checkOfficialMcpEntry({ ...entry, kind: "npm", target }, { fetchImpl })).passed, false, target);
    }
  });

  it("looks up a scoped npm name as one registry path segment", async () => {
    assert.deepEqual(await checkOfficialMcpEntry({ ...entry, kind: "npm", target: "@example/mcp-server" }, { fetchImpl }), { passed: true });
    assert.ok(requests.some(request => request.url === "https://registry.npmjs.org/%40example%2Fmcp-server"));
  });

  it("checks current PyPI files without treating an old yanked release as current", async () => {
    for (const target of ["active", "mixed"]) {
      assert.deepEqual(await checkOfficialMcpEntry({ ...entry, kind: "pypi", target }, { fetchImpl }), { passed: true });
    }
    for (const target of ["yanked", "missing", "empty"]) {
      assert.equal((await checkOfficialMcpEntry({ ...entry, kind: "pypi", target }, { fetchImpl })).passed, false, target);
    }
  });

  it("checks a repository's availability", async () => {
    assert.equal((await checkOfficialMcpEntry({ ...entry, kind: "github", target: "https://github.com/example/server" }, { fetchImpl })).passed, true);
    assert.equal((await checkOfficialMcpEntry({ ...entry, kind: "github", target: "https://github.com/example/missing" }, { fetchImpl })).passed, false);
  });

  it("requires the retired npm notice to remain in the registry", async () => {
    const retired = { kind: "npm", target: "retired", notice: "Package no longer supported.",
      url: "https://www.npmjs.com/package/retired", read_on: "2026-10-20" };
    assert.equal((await checkOfficialMcpEntry({ ...entry, retired_names: [retired] }, { fetchImpl })).passed, true);
    assert.equal((await checkOfficialMcpEntry({ ...entry, retired_names: [{ ...retired, target: "active" }] }, { fetchImpl })).passed, false);
  });

  it("records DNS and TLS failures without throwing away the check", async () => {
    for (const code of ["ENOTFOUND", "CERT_HAS_EXPIRED"]) {
      const fail = async () => { throw new TypeError("fetch failed", { cause: { code } }); };
      const result = await checkOfficialMcpEntry(entry, { fetchImpl: fail });
      assert.equal(result.passed, false);
      assert.match(result.detail!, new RegExp(code));
    }
  });

  it("bounds documentation bytes", async () => {
    const result = await checkOfficialMcpEntry(entry, { fetchImpl, maxBytes: 10 });
    assert.equal(result.passed, false);
    assert.match(result.detail!, /size limit/);
  });
});

describe("daily checks and proposals", () => {
  const offers = [offer("Deprecated", { ...entry, kind: "npm", target: "deprecated" }),
    offer("Gone", { ...entry, target: "https://api.example.com/status/404" }),
    offer("Quote", { ...entry, doc_url: "https://docs.example.com/missing" }), offer("Passing")];

  it("withholds each of the three failing fixtures on day two and proposes each once", async () => {
    const before = JSON.stringify(offers);
    const first = await checkOfficialMcpListings(offers, undefined, "2026-10-20", { fetchImpl });
    assert.equal(first.proposals.length, 0);
    assert.equal(Object.keys(first.checks).length, 4);
    for (const listing of offers) assert.equal(withCheckedOfficialMcp(listing, first.checks), listing);
    const beforeRetry = requests.length;
    const sameDay = await checkOfficialMcpListings(offers, first, "2026-10-20", { fetchImpl });
    assert.deepEqual(sameDay, first);
    assert.equal(requests.length, beforeRetry);
    const second = await checkOfficialMcpListings(offers, first, "2026-10-21", { fetchImpl });
    assert.deepEqual(second.proposals.map(proposal => proposal.vendor), ["Deprecated", "Gone", "Quote"]);
    for (const listing of offers.slice(0, 3)) assert.equal("official_mcp_servers" in withCheckedOfficialMcp(listing, second.checks), false);
    const passing = offers[3];
    assert.equal(withCheckedOfficialMcp(passing, second.checks), passing);
    assert.equal(second.checks[officialMcpKey(passing, passing.official_mcp_servers[0])].checked_on, "2026-10-21");
    assert.equal(JSON.stringify(offers), before);
    assert.equal(first.checks[officialMcpKey(offers[0], offers[0].official_mcp_servers[0])].withheld, false);
    const third = await checkOfficialMcpListings(offers, second, "2026-10-22", { fetchImpl });
    assert.equal(third.proposals.length, 3);
  });

  it("validates the entire input before making any network requests", async () => {
    const count = requests.length;
    await assert.rejects(() => checkOfficialMcpListings([...offers, offer("Invalid", { ...entry, doc_url: "" })], undefined, "2026-10-20", { fetchImpl }));
    assert.equal(requests.length, count);
    await assert.rejects(() => checkOfficialMcpListings(offers, undefined, "2026-02-30", { fetchImpl }));
  });
});

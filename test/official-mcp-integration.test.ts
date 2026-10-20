import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startLocalApi } from "./local-api.ts";
import { runOfficialMcpCheck } from "../scripts/check-official-mcp.js";
import { readOfficialMcpStore, writeOfficialMcpStore } from "../dist/official-mcp-store.js";
import { validateOffers } from "../scripts/validate-data.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const remote = {
  kind: "remote", target: "https://api.example.com/mcp", transport: "Streamable HTTP",
  authentication: 'the header "Authorization: Bearer <API_KEY>"', doc_url: "https://docs.example.com/mcp",
  source_quote: "The MCP server connects an AI agent to your workspace.", read_on: "2026-10-20",
};
const npm = { ...remote, kind: "npm", target: "@example/mcp", transport: "stdio", authentication: "an API key",
  retired_names: [{ kind: "npm", target: "@example/retired", notice: "Package no longer supported.",
    url: "https://www.npmjs.com/package/@example/retired", read_on: "2026-10-20" }] };
const passage = 'Zqmcp runs its own MCP server. "The MCP server connects an AI agent to your workspace." (From https://docs.example.com/mcp, read 2026-10-20.) The endpoint is https://api.example.com/mcp, the transport is Streamable HTTP, and authentication uses the header "Authorization: Bearer <API_KEY>".';
const packagePassage = 'Zqmcp runs its own MCP server. "The MCP server connects an AI agent to your workspace." (From https://docs.example.com/mcp, read 2026-10-20.) The npm package is @example/mcp, the transport is stdio, and authentication uses an API key. npm marks @example/retired "Package no longer supported." (From https://www.npmjs.com/package/@example/retired, read 2026-10-20.)';
const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const listing = { vendor: "Zqmcp", category: "Databases", tier: "Free", description: "Free managed database with 1 GB storage.",
  url: "https://example.com/pricing", verifiedDate: new Date().toISOString().slice(0, 10), tags: ["database"] };

it("publishes and withholds checked entries across pages, APIs and both MCP transports", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "official-mcp-integration-"));
  const indexPath = path.join(dir, "index.json");
  const storePath = path.join(dir, "checks.json");
  const saved = { index: process.env.AGENTDEALS_INDEX_PATH, state: process.env.AGENTDEALS_OFFICIAL_MCP_CHECKS_PATH };
  process.env.AGENTDEALS_INDEX_PATH = indexPath;
  process.env.AGENTDEALS_OFFICIAL_MCP_CHECKS_PATH = storePath;
  const offers = [{ ...listing, official_mcp_servers: [remote, { ...remote, target: "https://api.example.com/independent" }] },
    { ...listing, category: "Startup Perks", tier: "Startup", url: "https://example.com/startups", official_mcp_servers: [npm] },
    { ...listing, vendor: "Zqplain", url: "https://plain.example/pricing" }];
  writeFileSync(indexPath, JSON.stringify({ offers }));
  const original = readFileSync(indexPath, "utf8");
  let plainPage: string | undefined;
  let failing = false;
  const fetchImpl = async (url: string) => {
    if (url.startsWith("https://docs.")) return new Response(`<p>${remote.source_quote}</p>`);
    if (url.startsWith("https://registry.")) {
      const name = decodeURIComponent(new URL(url).pathname.slice(1));
      return Response.json({ "dist-tags": { latest: "1.0" }, versions: { "1.0": { version: "1.0",
        ...(name.endsWith("retired") || failing ? { deprecated: "Package no longer supported." } : {}) } } });
    }
    return new Response("", { status: failing && !url.endsWith("independent") ? 404 : 401 });
  };
  async function inspect(expected: unknown[], mainPassage: boolean, secondaryPassage: boolean) {
    const api = await startLocalApi();
    const http = new Client({ name: "official-mcp-integration", version: "1" });
    const stdio = new Client({ name: "official-mcp-stdio", version: "1" });
    try {
      const pageResponse = await fetch(api.url + "/vendor/zqmcp");
      assert.equal(pageResponse.status, 200);
      const page = await pageResponse.text();
      const plain = await (await fetch(api.url + "/vendor/zqplain")).text();
      assert.ok(!plain.includes("runs its own MCP server"), "no entry makes no server claim");
      if (plainPage === undefined) plainPage = plain;
      else assert.equal(plain, plainPage, "a listing without entries keeps its bytes through check transitions");
      const details = await (await fetch(api.url + "/api/details/Zqmcp")).json();
      assert.deepEqual(details.offer.official_mcp_servers, expected);
      const all = await (await fetch(api.url + "/api/offers?q=Zqmcp&limit=50")).json();
      assert.deepEqual(all.offers.find((o: typeof listing) => o.tier === "Free").official_mcp_servers, expected);
      assert.deepEqual(all.offers.find((o: typeof listing) => o.tier === "Startup").official_mcp_servers,
        secondaryPassage ? [npm] : undefined, "all failing entries leave no published field");
      assert.equal(page.includes(`<p class="desc-text">${escapeHtml(passage)}</p>`), mainPassage, "primary passage");
      assert.equal(page.includes(`<p class="desc-text">${escapeHtml(packagePassage)}</p>`), secondaryPassage, "secondary passage");
      const scripts = [...page.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map(m => JSON.parse(m[1]));
      const web = scripts.find(node => node["@type"] === "WebPage");
      assert.equal(web.mainEntity.description.includes(passage), mainPassage, "application description");
      const faq = scripts.find(node => node["@type"] === "FAQPage");
      for (const q of ["Is Zqmcp free?", "What is Zqmcp's free tier?"]) {
        const answer = faq.mainEntity.find((node: { name: string }) => node.name === q).acceptedAnswer.text;
        assert.equal(answer.includes(passage), mainPassage, q);
        assert.ok(page.includes(escapeHtml(answer)), "visible FAQ matches structured answer");
      }
      assert.ok(!page.replace(/<script[\s\S]*?<\/script>/gi, '').includes('<API_KEY>'), "authentication placeholder is escaped in HTML");
      await http.connect(new StreamableHTTPClientTransport(new URL(api.url + "/mcp")));
      await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(REPO, "dist/index.js")],
        env: { ...process.env, AGENTDEALS_API_URL: api.url } as Record<string, string>, stderr: "pipe" }));
      for (const [name, client] of [["HTTP", http], ["stdio", stdio]] as const) {
        for (const response_format of ["detailed", "concise"]) {
          const result = await client.callTool({ name: "search_deals", arguments: { query: "Zqmcp", response_format } });
          assert.ok(!result.isError, name);
          const content = result.content as Array<{ text: string }>;
          const output = JSON.parse(content[0].text);
          const offer = output.results.find((o: typeof listing) => o.tier === "Free");
          assert.deepEqual(offer.official_mcp_servers, expected, `${name} ${response_format}`);
        }
        for (const uri of ["agentdeals://vendor/zqmcp", "agentdeals://category/databases"]) {
          const result = await client.readResource({ uri });
          const text = result.contents[0].text as string;
          assert.equal(text.includes(passage), mainPassage, `${name} ${uri}`);
          assert.equal(text.includes("https://api.example.com/independent"), true, "independent entry stays published");
        }
      }
      const schema = await (await fetch(api.url + "/api/openapi.json")).json();
      assert.equal(schema.components.schemas.Offer.properties.official_mcp_servers.items.$ref, "#/components/schemas/OfficialMcpServer");
      assert.deepEqual(schema.components.schemas.OfficialMcpServer.required,
        ["kind", "target", "transport", "authentication", "doc_url", "source_quote", "read_on"]);
      return page;
    } finally {
      await http.close();
      await stdio.close();
      api.stop();
    }
  }
  try {
    const baseline = await inspect(offers[0].official_mcp_servers, true, true);
    failing = true;
    await t.test("one failed day changes no publication", async () => {
      const first = await runOfficialMcpCheck({ indexPath, storePath, checkedOn: "2026-10-20", write: true, fetchImpl });
      assert.equal(first.proposals.length, 0);
      assert.equal(await inspect(offers[0].official_mcp_servers, true, true), baseline);
    });
    await t.test("two failed days persist withholding and leave independent entries", async () => {
      const second = await runOfficialMcpCheck({ indexPath, storePath, checkedOn: "2026-10-21", write: true, fetchImpl });
      assert.equal(second.proposals.length, 2);
      assert.deepEqual(readOfficialMcpStore(storePath).checks, second.checks);
      await inspect([offers[0].official_mcp_servers[1]], false, false);
      assert.equal(readFileSync(indexPath, "utf8"), original);
    });
    await t.test("a successful check restores all entries", async () => {
      failing = false;
      await runOfficialMcpCheck({ indexPath, storePath, checkedOn: "2026-10-22", write: true, fetchImpl });
      assert.equal(await inspect(offers[0].official_mcp_servers, true, true), baseline);
    });
  } finally {
    for (const [key, value] of [["AGENTDEALS_INDEX_PATH", saved.index], ["AGENTDEALS_OFFICIAL_MCP_CHECKS_PATH", saved.state]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

it("the shared offer validator rejects incomplete MCP evidence", () => {
  assert.equal(validateOffers([{ ...listing, official_mcp_servers: [remote] }]).length, 0);
  for (const field of ["doc_url", "source_quote", "read_on", "kind"]) {
    const entry = { ...remote } as Record<string, unknown>;
    delete entry[field];
    assert.ok(validateOffers([{ ...listing, official_mcp_servers: [entry] }]).some(error => error.field === "official_mcp_servers"));
  }
});

it("rejects corrupt persisted checks rather than restoring withheld entries", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "official-mcp-store-"));
  const file = path.join(dir, "checks.json");
  try {
    assert.deepEqual(readOfficialMcpStore(file), { checks: {}, proposals: [] });
    for (const value of [null, [], { checks: [], proposals: [] }, { checks: { ["a".repeat(64)]: { checked_on: "2026-10-20", passed: false, failure_streak: 2, withheld: false } }, proposals: [] }]) {
      writeFileSync(file, JSON.stringify(value));
      assert.throws(() => readOfficialMcpStore(file));
    }
    writeOfficialMcpStore({ checks: {}, proposals: [] }, file);
    assert.deepEqual(readOfficialMcpStore(file), { checks: {}, proposals: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("the checker CLI previews without writing, persists daily checks, and rejects invalid input", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "official-mcp-cli-"));
  const index = path.join(dir, "index.json");
  const state = path.join(dir, "checks.json");
  const preload = path.join(dir, "fetch.mjs");
  writeFileSync(index, JSON.stringify({ offers: [{ ...listing, official_mcp_servers: [remote] }] }));
  writeFileSync(preload, `globalThis.fetch = async url => new Response(String(url).includes("docs.") ? ${JSON.stringify(remote.source_quote)} : "", {status: String(url).includes("docs.") ? 200 : 404});`);
  async function run(...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const child = spawn(process.execPath, ["--import", preload, "scripts/check-official-mcp.js", "--index", index, "--state", state, ...args], { cwd: REPO });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    return await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", code => resolve({ code, stdout, stderr }));
    });
  }
  try {
    const preview = await run("--date", "2026-10-20");
    assert.equal(preview.code, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).entries[0].withheld, false);
    assert.deepEqual(readOfficialMcpStore(state), { checks: {}, proposals: [] });
    const preflight = await run("--date", "2026-10-20", "--preflight");
    assert.equal(preflight.code, 1);
    assert.deepEqual(readOfficialMcpStore(state), { checks: {}, proposals: [] });
    for (const date of ["2026-10-20", "2026-10-20", "2026-10-21"]) {
      const checked = await run("--date", date, "--write");
      assert.equal(checked.code, 0, checked.stderr);
    }
    const stored = readFileSync(state, "utf8");
    assert.equal(readOfficialMcpStore(state).proposals.length, 1);
    assert.equal(Object.values(readOfficialMcpStore(state).checks)[0].failure_streak, 2);
    const invalidDate = await run("--date", "2026-02-30", "--write");
    assert.equal(invalidDate.code, 1);
    assert.equal(readFileSync(state, "utf8"), stored);
    writeFileSync(index, JSON.stringify({ offers: [{ ...listing, official_mcp_servers: [{ ...remote, doc_url: "" }] }] }));
    const invalid = await run("--date", "2026-10-22", "--write");
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /doc_url/);
    assert.equal(readFileSync(state, "utf8"), stored);
    const validation = spawn(process.execPath, ["scripts/validate-data.ts"], { cwd: REPO,
      env: { ...process.env, AGENTDEALS_INDEX_PATH: index } });
    let errors = "";
    validation.stderr.on("data", chunk => { errors += chunk; });
    validation.stdout.resume();
    const code = await new Promise(resolve => validation.on("close", resolve));
    assert.equal(code, 1);
    assert.match(errors, /official_mcp_servers\[0\]\.doc_url/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("the daily re-read checks and commits MCP state inside its existing data gate", () => {
  const workflow = readFileSync(path.join(REPO, ".github/workflows/reverify.yml"), "utf8");
  assert.ok(workflow.includes("node scripts/check-official-mcp.js --write"));
  assert.ok(workflow.indexOf("node scripts/check-official-mcp.js --write") < workflow.indexOf("bash scripts/gate-data-push.sh"));
  const paths = workflow.slice(workflow.indexOf("bash scripts/gate-data-push.sh"), workflow.indexOf("      - name: Say where"));
  assert.match(paths, /data\/official_mcp_checks\.json/);
});

it("the daily workflow propagates a failed checker and logs a successful one", () => {
  const workflow = readFileSync(path.join(REPO, ".github/workflows/reverify.yml"), "utf8");
  const command = workflow.match(/- name: Check the vendor MCP entries and record failures for review\n\s+run: (.+)/)![1];
  const dir = mkdtempSync(path.join(tmpdir(), "official-mcp-workflow-"));
  const node = path.join(dir, "node");
  const isolated = command.replace("/tmp/official-mcp-checks.json", path.join(dir, "checks.json"));
  try {
    writeFileSync(node, "#!/bin/sh\nexit 23\n", { mode: 0o755 });
    const failed = spawnSync("bash", ["-e", "-c", isolated], { env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH }, encoding: "utf8" });
    assert.equal(failed.status, 23, failed.stderr);
    writeFileSync(node, "#!/bin/sh\nprintf '%s\\n' '{\"checked\":true}'\n");
    const passed = spawnSync("bash", ["-e", "-c", isolated], { env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH }, encoding: "utf8" });
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(passed.stdout.trim(), '{"checked":true}');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

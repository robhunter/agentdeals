import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_CARD_PATHS,
  OPENAPI_ALIAS_PATHS,
  OPENAPI_CANONICAL_PATH,
  OPENAPI_YAML_PATH,
  buildServiceDescription,
  urlsDeclaredBy,
} from "../dist/agent-card.js";
import { loadOffers, loadDealChanges, getCategories, confirmationCoverage, confirmationCoverageSentence } from "../dist/data.js";
import { recordsStillInForce } from "../dist/change-resolution.js";
import { trackedChanges } from "../dist/change-census.js";
import { MCP_TOOLS } from "../dist/mcp-tool-inventory.js";
import { openapiSpec } from "../dist/openapi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const MCP_CARD_PATHS = ["/.well-known/mcp.json", "/.well-known/mcp/server-card.json"];

const A2A_CARD_FIELDS = [
  "supportedInterfaces",
  "preferredTransport",
  "defaultInputModes",
  "defaultOutputModes",
  "skills",
  "securitySchemes",
];

const MARKETPLACE_PROMISES = [
  "/marketplace",
  "Register on the Marketplace",
  "Submit a referral code",
  "Submit your referral code",
  "60% commission",
  "revenue share",
  "earn revenue",
  "Revenue Splits",
  "Accepting Submissions",
];

let proc: ChildProcess | null = null;
let base = "";

function startServer(): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
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
}

function localise(declared: string, origin: string): string {
  const parsed = new URL(declared);
  return `${origin}${parsed.pathname}${parsed.search}`;
}

function isOurOrigin(declared: string): boolean {
  return new URL(declared).hostname === "127.0.0.1";
}

function numbersIn(text: string): number[] {
  return [...text.matchAll(/\b(\d{1,3}(?:,\d{3})+|\d{3,})\b/g)].map((m) => parseInt(m[1].replace(/,/g, ""), 10));
}

describe("the service description answers the paths agent directories ask for", () => {
  let card: Record<string, any>;
  let bodies: Map<string, string>;
  let statuses: Map<string, number>;

  function bodyOf(p: string): string {
    assert.strictEqual(statuses.get(p), 200, `${p} answered ${statuses.get(p)}`);
    return bodies.get(p)!;
  }

  before(async () => {
    const started = await startServer();
    proc = started.proc;
    base = `http://127.0.0.1:${started.port}`;
    bodies = new Map();
    statuses = new Map();
    for (const p of [...AGENT_CARD_PATHS, ...MCP_CARD_PATHS]) {
      const res = await fetch(`${base}${p}`, { redirect: "manual" });
      statuses.set(p, res.status);
      bodies.set(p, await res.text());
    }
    try {
      card = JSON.parse(bodies.get(AGENT_CARD_PATHS[0])!);
    } catch {
      card = {};
    }
  });

  after(() => { proc?.kill("SIGKILL"); });

  it("answers 200 on both spellings of the agent card path with the same document", () => {
    const a = bodyOf("/.well-known/agent.json");
    const b = bodyOf("/.well-known/agent-card.json");
    assert.ok(a.length > 0, "the agent card body is empty");
    assert.strictEqual(a, b, "the two spellings of the path served different documents");
  });

  it("answers every path the edge logs recorded as a 404 with the same document", () => {
    const refused = AGENT_CARD_PATHS.filter((p) => statuses.get(p) !== 200).map((p) => `${p} → ${statuses.get(p)}`);
    assert.deepStrictEqual(refused, [], `these paths still refuse a directory: ${refused.join(", ")}`);
    const differing = AGENT_CARD_PATHS.filter((p) => bodies.get(p) !== bodies.get(AGENT_CARD_PATHS[0]));
    assert.deepStrictEqual(differing, [], `these paths served a different document: ${differing.join(", ")}`);
    assert.ok(AGENT_CARD_PATHS.length >= 6, `only ${AGENT_CARD_PATHS.length} paths are served`);
  });

  it("answers HEAD on every one of those paths", async () => {
    for (const p of AGENT_CARD_PATHS) {
      const res = await fetch(`${base}${p}`, { method: "HEAD", redirect: "manual" });
      assert.strictEqual(res.status, 200, `HEAD ${p} answered ${res.status}`);
    }
  });

  it("declares no A2A interface, because no url here speaks A2A", () => {
    assert.strictEqual(card.a2a.supported, false, "the document claims A2A support");
    const serialized = bodyOf(AGENT_CARD_PATHS[0]);
    for (const field of A2A_CARD_FIELDS) {
      assert.ok(
        !new RegExp(`"${field}"\\s*:`).test(serialized),
        `the document carries the A2A AgentCard field ${field}, which a client would dial`,
      );
    }
    assert.match(card.a2a.reason, /protocol_version/, "the document does not say what an A2A card would have to state");
  });

  it("resolves every url it declares on our own origin", async () => {
    const declared = [...new Set(urlsDeclaredBy(card))];
    assert.ok(declared.length >= 10, `only ${declared.length} urls declared`);
    const provenByHandshake = new Set(
      card.interfaces.filter((i: any) => i.protocol === "MCP").map((i: any) => i.url as string),
    );
    assert.strictEqual(provenByHandshake.size, 1, "the set of urls a plain GET cannot prove has changed");
    const ours = declared.filter(isOurOrigin).filter((u) => !provenByHandshake.has(u));
    assert.ok(ours.length >= 8, `only ${ours.length} of ${declared.length} declared urls are ours`);
    const dead: string[] = [];
    for (const declaredUrl of ours) {
      const res = await fetch(localise(declaredUrl, base), { redirect: "manual" });
      if (res.status >= 400) dead.push(`${declaredUrl} → ${res.status}`);
    }
    assert.deepStrictEqual(dead, [], `the document names urls this site does not answer: ${dead.join(", ")}`);
  });

  it("names no off-origin host the site does not already cite", () => {
    const offOrigin = [...new Set(urlsDeclaredBy(card))].filter((u) => !isOurOrigin(u));
    const hosts = [...new Set(offOrigin.map((u) => new URL(u).hostname))].sort();
    assert.deepStrictEqual(hosts, ["github.com", "opensource.org"], `unexpected off-origin hosts: ${hosts.join(", ")}`);
  });

  it("answers a real MCP session on the endpoint it declares", async () => {
    const mcp = card.interfaces.find((i: any) => i.protocol === "MCP");
    assert.ok(mcp, "the document declares no MCP interface");
    const res = await fetch(localise(mcp.url, base), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: mcp.protocol_version, capabilities: {}, clientInfo: { name: "agent-card-test", version: "1" } },
      }),
    });
    assert.strictEqual(res.status, 200, `initialize on the declared endpoint answered ${res.status}`);
    const text = await res.text();
    assert.match(text, /"serverInfo"/, `initialize returned no serverInfo: ${text.slice(0, 200)}`);
  });

  it("states catalogue figures that match the index, rather than figures typed by hand", () => {
    const offers = loadOffers();
    assert.deepStrictEqual(
      {
        offers: card.catalogue.offers,
        categories: card.catalogue.categories,
        vendors: card.catalogue.vendors,
        changes_tracked: card.catalogue.changes_tracked,
      },
      {
        offers: offers.length,
        categories: getCategories().length,
        vendors: new Set(offers.map((o: { vendor: string }) => o.vendor)).size,
        changes_tracked: trackedChanges(loadDealChanges()).length,
      },
    );
    assert.match(card.catalogue.catalogue_dated_between.oldest, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(card.catalogue.catalogue_dated_between.newest, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(card.catalogue.catalogue_dated_between.oldest <= card.catalogue.catalogue_dated_between.newest);
    assert.ok(card.description.includes(card.catalogue.offers.toLocaleString("en-US")), "the description states a different figure from the catalogue block");
  });

  it("states the same catalogue the home page states", async () => {
    const home = await (await fetch(`${base}/`, { redirect: "manual" })).text();
    const stat = (label: string): string | null =>
      home.match(new RegExp(`<div class="stat-num[^"]*">([\\d,]+)</div><div class="stat-label">${label}</div>`))?.[1] ?? null;
    const disagreeing: string[] = [];
    for (const [label, published] of [["Deals", card.catalogue.offers], ["Categories", card.catalogue.categories], ["Changes Tracked", card.catalogue.changes_tracked]] as const) {
      const onTheHomePage = stat(label);
      assert.ok(onTheHomePage !== null, `the home page publishes no ${label} figure for this to agree with`);
      if (parseInt(onTheHomePage.replace(/,/g, ""), 10) !== published) {
        disagreeing.push(`${label}: the card says ${published}, the home page says ${onTheHomePage}`);
      }
    }
    assert.deepStrictEqual(disagreeing, [], disagreeing.join("; "));
  });

  it("moves every figure when the index moves", () => {
    const smaller = buildServiceDescription({
      baseUrl: "https://example.test",
      version: "9.9.9",
      license: { name: "MIT", url: "https://opensource.org/licenses/MIT" },
      repositoryUrl: "https://github.com/robhunter/agentdeals",
      catalogue: { offers: 3, categories: 2, vendors: 3, changes_tracked: 1, confirmed_within_90_days: 1, freshness_score: 33, catalogue_dated_between: { oldest: "2020-01-01", newest: "2020-06-01" }, what_confirmed_means: "what a confirmation is" },
      tools: [{ name: "search_deals", brief: "brief" }],
    });
    assert.strictEqual(smaller.catalogue.offers, 3);
    assert.match(smaller.description, /An index of 3 free tiers/);
    assert.match(smaller.description, /Of the 3 entries we hold, 1 carries terms a read confirmed/);
    assert.match(smaller.description, /across 2 categories/);
    assert.strictEqual(smaller.tools.length, 1);
    assert.strictEqual(smaller.version, "9.9.9");
  });

  it("names every MCP tool we publish and no tool we do not", () => {
    assert.deepStrictEqual(
      card.tools.map((t: { name: string }) => t.name).sort(),
      MCP_TOOLS.map((t: { name: string }) => t.name).sort(),
    );
  });

  it("claims no catalogue larger than the one we hold, on the service description", () => {
    assert.deepStrictEqual(catalogueOverstatements(AGENT_CARD_PATHS[0]), []);
  });

  it("claims no catalogue larger than the one we hold, on the MCP card", () => {
    for (const p of MCP_CARD_PATHS) {
      assert.deepStrictEqual(catalogueOverstatements(p), []);
    }
  });

  function catalogueOverstatements(p: string): string[] {
    const held = loadOffers().length;
    const doc = JSON.parse(bodyOf(p));
    const prose = [doc.description, doc.serverInfo?.description].filter(Boolean).join(" ");
    return numbersIn(prose).filter((n) => n > held).map((n) => `${p} states ${n} against ${held} held`);
  }

  it("states the catalogue it holds on the markdown we serve to agents", async () => {
    const served = await (await fetch(`${base}/AGENTS.md`)).text();
    const offers = loadOffers();
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(served), `an unresolved placeholder reached a reader: ${served.match(/\{\{[A-Z_]+\}\}/)?.[0]}`);
    assert.ok(
      served.includes(`${offers.length.toLocaleString("en-US")} offers`),
      `the served markdown does not state ${offers.length} offers`,
    );
    assert.ok(
      served.includes(confirmationCoverageSentence(confirmationCoverage())),
      "the served markdown states a catalogue size without stating how much of it a read has confirmed",
    );
    assert.ok(
      served.includes(`across ${getCategories().length} categories`),
      `the served markdown does not state ${getCategories().length} categories`,
    );
  });

  it("takes its version and licence from the package manifest", () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf-8"));
    assert.strictEqual(card.version, manifest.version);
    assert.strictEqual(card.data.license, manifest.license);
    assert.strictEqual(card.contact.repository, manifest.repository.url.replace(/\.git$/, ""));
    assert.strictEqual(
      manifest.license,
      (openapiSpec as { info: { license: { name: string } } }).info.license.name,
      "the manifest and the OpenAPI document name different licences",
    );
  });

  it("publishes one version across every surface that tells a machine what we are", async () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf-8"));
    const published = new Map<string, string>([
      ["the service description", card.version],
      [MCP_CARD_PATHS[0], JSON.parse(bodyOf(MCP_CARD_PATHS[0])).serverInfo.version],
      ["the builder behind /mcp", await versionOverHttp()],
      ["the builder behind stdio", await versionOverStdio()],
    ]);
    const disagreeing = [...published].filter(([, v]) => v !== manifest.version).map(([who, v]) => `${who} says ${v}`);
    assert.deepStrictEqual(disagreeing, [], `against a manifest version of ${manifest.version}: ${disagreeing.join(", ")}`);
  });

  async function versionOverHttp(): Promise<string> {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent-card-test", version: "1" } } }),
    });
    const text = await res.text();
    return JSON.parse(text.replace(/^.*?data:\s*/s, "")).result.serverInfo.version;
  }

  function versionOverStdio(): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("node", [path.join(REPO, "dist", "index.js")], { stdio: ["pipe", "pipe", "pipe"] });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("stdio initialize timed out")); }, 60000);
      let out = "";
      child.stdout!.on("data", (b: Buffer) => {
        out += b.toString();
        const line = out.split("\n").find((l) => l.includes("serverInfo"));
        if (line) {
          clearTimeout(timer);
          child.kill("SIGKILL");
          resolve(JSON.parse(line).result.serverInfo.version);
        }
      });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent-card-test", version: "1" } } }) + "\n");
    });
  }

  it("promises nothing from the marketplace work", () => {
    const serialized = bodyOf(AGENT_CARD_PATHS[0]).toLowerCase();
    const promised = MARKETPLACE_PROMISES.filter((m) => serialized.includes(m.toLowerCase()));
    assert.deepStrictEqual(promised, [], `the document promises ${promised.join(", ")}`);
  });

  it("leaves the card paths crawlable", async () => {
    const robots = await (await fetch(`${base}/robots.txt`)).text();
    const disallowed = robots
      .split("\n")
      .filter((line) => /^\s*Disallow:/i.test(line))
      .map((line) => line.split(":").slice(1).join(":").trim())
      .filter((rule) => rule.length > 0);
    const blocked = AGENT_CARD_PATHS.filter((p) => disallowed.some((rule) => p.startsWith(rule)));
    assert.deepStrictEqual(blocked, [], `robots.txt blocks ${blocked.join(", ")}`);
  });
});

describe("the OpenAPI document answers the root paths clients ask for", () => {
  let bodies: Map<string, string>;
  let statuses: Map<string, number>;
  let localProc: ChildProcess | null = null;
  let localBase = "";

  before(async () => {
    const started = await startServer();
    localProc = started.proc;
    localBase = `http://127.0.0.1:${started.port}`;
    bodies = new Map();
    statuses = new Map();
    for (const p of [...OPENAPI_ALIAS_PATHS, OPENAPI_YAML_PATH, OPENAPI_CANONICAL_PATH]) {
      const res = await fetch(`${localBase}${p}`, { redirect: "manual" });
      statuses.set(p, res.status);
      bodies.set(p, await res.text());
    }
  });

  after(() => { localProc?.kill("SIGKILL"); });

  it("serves the same document at every alias as at the canonical path", () => {
    const refused = [...OPENAPI_ALIAS_PATHS, OPENAPI_YAML_PATH].filter((p) => statuses.get(p) !== 200).map((p) => `${p} → ${statuses.get(p)}`);
    assert.deepStrictEqual(refused, [], `these root paths still refuse a client: ${refused.join(", ")}`);
    const canonical = bodies.get(OPENAPI_CANONICAL_PATH)!;
    const differing = [...OPENAPI_ALIAS_PATHS, OPENAPI_YAML_PATH].filter((p) => bodies.get(p) !== canonical);
    assert.deepStrictEqual(differing, [], `these aliases served a different document: ${differing.join(", ")}`);
    assert.ok(JSON.parse(canonical).paths, "the canonical document holds no paths");
  });

  it("serves the YAML alias under a YAML content type", async () => {
    const res = await fetch(`${localBase}${OPENAPI_YAML_PATH}`, { redirect: "manual" });
    assert.match(res.headers.get("content-type") ?? "", /yaml/);
  });

  it("holds one source for the document, not a copy per path", () => {
    const source = readFileSync(path.join(REPO, "src", "serve.ts"), "utf-8");
    const emitters = [...source.matchAll(/res\.end\(JSON\.stringify\(openapiSpec\)\)/g)].length;
    assert.ok(emitters <= 2, `${emitters} places serialise the spec; the aliases should share one`);
  });
});

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_ENDPOINTS,
  DOCUMENTED_GROUPS,
  HOMEPAGE_GROUPS,
  endpointHref,
  exampleRequest,
  exampleSubjects,
  readableEndpoints,
  type ApiEndpoint,
} from "../dist/api-inventory.js";
import {
  CHANGE_TYPES,
  PATHS_OUTSIDE_THE_ENDPOINT_INVENTORY,
  documentedOperationsNoEndpointServes,
  endpointsDescribedFromTheInventoryAlone,
  openapiSpec,
  pathsFor,
} from "../dist/openapi.js";
import { MCP_TOOLS_WITHDRAWN } from "../dist/mcp-tool-inventory.js";
import { CHANGE_DIRECTION } from "../dist/change-direction.js";
import { loadOffers } from "../dist/data.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const JSON_REPRESENTATION = new Map<string, string>([
  ["/api/digest/weekly", "/api/digest/weekly?format=json"],
]);

const spec = openapiSpec as unknown as {
  info: { description: string };
  paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema: unknown }> }> }>>;
  components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> };
};

function specPath(route: string): string {
  return route.replace(/:([A-Za-z_]+)/g, "{$1}");
}

function operationFor(endpoint: ApiEndpoint) {
  return spec.paths[specPath(endpoint.path)]?.[endpoint.method.toLowerCase()];
}

function citesInTheSpec(endpoint: ApiEndpoint): boolean {
  const json = operationFor(endpoint)?.responses?.["200"]?.content?.["application/json"];
  return json ? JSON.stringify(json.schema).includes("#/components/schemas/Provenance") : false;
}

function probeRequest(endpoint: ApiEndpoint, subjects: ReturnType<typeof exampleSubjects>): string | null {
  const override = JSON_REPRESENTATION.get(endpoint.path);
  if (override) return override;
  return endpointHref(endpoint, subjects);
}

describe("the machine-readable spec describes what the API serves", () => {
  let proc: ChildProcess;
  let base: string;
  let subjects: ReturnType<typeof exampleSubjects>;
  let bodies: Map<string, unknown>;

  before(async () => {
    const started = await new Promise<{ proc: ChildProcess; port: number }>((resolve, reject) => {
      const child = spawn("node", [path.join(__dirname, "..", "dist", "serve.js")], {
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
    const codes = await (await fetch(`${base}/api/referral-codes`, { redirect: "error" })).json() as { codes: { vendor: string }[] };
    subjects = exampleSubjects(loadOffers().map((o) => o.vendor), codes.codes.map((c) => c.vendor));
    bodies = new Map();
    for (const endpoint of API_ENDPOINTS) {
      if (endpoint.method !== "GET") continue;
      const request = probeRequest(endpoint, subjects);
      if (!request) continue;
      const res = await fetch(`${base}${request}`, { redirect: "error" });
      const text = await res.text();
      try { bodies.set(endpoint.path, JSON.parse(text)); } catch { bodies.set(endpoint.path, null); }
    }
  });

  after(() => { proc?.kill("SIGKILL"); });

  it("describes every endpoint the inventory both surfaces are built from", () => {
    const missing = API_ENDPOINTS
      .filter((endpoint) => operationFor(endpoint) === undefined)
      .map((endpoint) => `${endpoint.method} ${endpoint.path}`);
    assert.deepStrictEqual(missing, [], `endpoints served and listed but absent from the spec: ${missing.join(", ")}`);
  });

  it("describes no operation that no endpoint serves, beyond the aliases it registers", () => {
    assert.deepStrictEqual(documentedOperationsNoEndpointServes(), []);
    const served = new Set(API_ENDPOINTS.map((e) => `${e.method.toLowerCase()} ${specPath(e.path)}`));
    const alias = new Set(Object.keys(PATHS_OUTSIDE_THE_ENDPOINT_INVENTORY));
    const stray = Object.entries(spec.paths)
      .filter(([route]) => !alias.has(route))
      .flatMap(([route, methods]) => Object.keys(methods).map((method) => `${method} ${route}`))
      .filter((key) => !served.has(key));
    assert.deepStrictEqual(stray, [], `paths in the spec that no served endpoint backs: ${stray.join(", ")}`);
  });

  it("writes a description for every endpoint rather than falling back to the inventory's line", () => {
    assert.deepStrictEqual(endpointsDescribedFromTheInventoryAlone(), []);
  });

  it("puts a route added to the inventory alone into the spec, and reports it as undescribed", () => {
    const invented: ApiEndpoint = { method: "GET", path: "/api/pressure-test", desc: "A route the spec has never been told about", params: "limit", group: "product" };
    const perturbed = [...API_ENDPOINTS, invented];
    assert.ok(pathsFor(perturbed)["/api/pressure-test"]?.get, "a route added to the inventory did not reach the spec");
    assert.deepStrictEqual(endpointsDescribedFromTheInventoryAlone(perturbed), ["GET /api/pressure-test"]);
  });

  it("reports an operation left in the spec after its endpoint is withdrawn", () => {
    const withdrawn = API_ENDPOINTS.filter((e) => e.path !== "/api/deadlines");
    assert.deepStrictEqual(documentedOperationsNoEndpointServes(withdrawn), ["GET /api/deadlines"]);
  });

  it("answers on every path it publishes", async () => {
    const refused: string[] = [];
    for (const endpoint of API_ENDPOINTS) {
      if (endpoint.method !== "GET") continue;
      const request = probeRequest(endpoint, subjects);
      if (!request) continue;
      const res = await fetch(`${base}${request}`, { redirect: "error" });
      if (res.status >= 400) refused.push(`${request} -> ${res.status}`);
    }
    for (const alias of Object.keys(PATHS_OUTSIDE_THE_ENDPOINT_INVENTORY)) {
      const res = await fetch(`${base}${alias}`, { redirect: "error" });
      if (res.status >= 400) refused.push(`${alias} -> ${res.status}`);
    }
    assert.deepStrictEqual(refused, [], `paths the spec describes that the server refuses:\n${refused.join("\n")}`);
  });

  it("reaches a described path from every API link the developer hub offers", async () => {
    const hub = await (await fetch(`${base}/developers`, { redirect: "error" })).text();
    const links = [...new Set([...hub.matchAll(/<td><a href="([^"]*?)(\/api\/[^"?]*)[^"]*">/g)].map(([, , route]) => route))];
    assert.ok(links.length >= 25, `the developer hub offers ${links.length} API links`);
    const described = new Set(Object.keys(spec.paths));
    const undescribed = links.filter((route) => {
      if (described.has(route)) return false;
      const template = API_ENDPOINTS.find((e) => e.method === "GET" && new RegExp(`^${specPath(e.path).replace(/\{[A-Za-z_]+\}/g, "[^/]+")}$`).test(route));
      return template === undefined || !described.has(specPath(template.path));
    });
    assert.deepStrictEqual(undescribed, [], `API links on /developers reaching no described path: ${undescribed.join(", ")}`);
  });

  it("reaches a described path from every request the home page prints", async () => {
    const home = await (await fetch(`${base}/`, { redirect: "error" })).text();
    const printed = [...home.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)]
      .flatMap(([, block]) => block.split("\n"))
      .filter((line) => line.startsWith("GET /api/"))
      .map((line) => line.slice(4).replace(/&amp;/g, "&").split("?")[0]);
    assert.ok(printed.length >= readableEndpoints(HOMEPAGE_GROUPS).length - 2, `the home page printed ${printed.length} API requests`);
    const described = new Set(Object.keys(spec.paths));
    const undescribed = printed.filter((route) => {
      if (described.has(route)) return false;
      return !API_ENDPOINTS.some((e) => e.method === "GET" && described.has(specPath(e.path)) && new RegExp(`^${specPath(e.path).replace(/\{[A-Za-z_]+\}/g, "[^/]+")}$`).test(route));
    });
    assert.deepStrictEqual([...new Set(undescribed)], [], `requests printed on / reaching no described path: ${undescribed.join(", ")}`);
  });

  it("counts the same endpoints the developer hub counts", () => {
    const documented = API_ENDPOINTS.filter((e) => DOCUMENTED_GROUPS.includes(e.group));
    const inSpec = documented.filter((e) => operationFor(e) !== undefined);
    assert.strictEqual(inSpec.length, documented.length);
  });

  it("says which methods the developer hub's own table holds", async () => {
    const hub = await (await fetch(`${base}/developers`, { redirect: "error" })).text();
    const table = hub.slice(hub.indexOf("<table class=\"endpoint-table\">"));
    const inTable = [...new Set([...table.matchAll(/<td><code>(GET|POST|DELETE|PUT|PATCH)<\/code><\/td>/g)].map(([, method]) => method))];
    const claim = hub.match(/<p>(Every endpoint below[^<]*)/);
    assert.ok(claim, "/developers states nothing about the methods its table holds");
    const writes = inTable.filter((method) => method !== "GET");
    const unstated = writes.filter((method) => !claim[1].includes(method));
    assert.deepStrictEqual(unstated, [], `methods in the endpoint table that the sentence above it does not admit: ${unstated.join(", ")}`);
    if (writes.length === 0) assert.ok(/^Every endpoint below is read-only \(GET\)\.$/.test(claim[1].trim()));
  });
});

describe("the citation block an agent reads is the one the spec describes", () => {
  let proc: ChildProcess;
  let base: string;
  let subjects: ReturnType<typeof exampleSubjects>;
  let carried: Map<string, Record<string, unknown> | null>;

  before(async () => {
    const started = await new Promise<{ proc: ChildProcess; port: number }>((resolve, reject) => {
      const child = spawn("node", [path.join(__dirname, "..", "dist", "serve.js")], {
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
    const codes = await (await fetch(`${base}/api/referral-codes`, { redirect: "error" })).json() as { codes: { vendor: string }[] };
    subjects = exampleSubjects(loadOffers().map((o) => o.vendor), codes.codes.map((c) => c.vendor));
    carried = new Map();
    for (const endpoint of API_ENDPOINTS) {
      if (endpoint.method !== "GET") continue;
      const request = probeRequest(endpoint, subjects);
      if (!request) continue;
      const res = await fetch(`${base}${request}`, { redirect: "error" });
      const text = await res.text();
      let block: Record<string, unknown> | null = null;
      try {
        const body = JSON.parse(text) as Record<string, unknown>;
        block = (body._provenance as Record<string, unknown>) ?? null;
      } catch { block = null; }
      carried.set(endpoint.path, block);
    }
  });

  after(() => { proc?.kill("SIGKILL"); });

  it("describes the citation on every response that carries one, and on no response that does not", () => {
    const disagreeing: string[] = [];
    for (const endpoint of API_ENDPOINTS) {
      if (endpoint.method !== "GET") continue;
      if (!carried.has(endpoint.path)) continue;
      const served = carried.get(endpoint.path) !== null;
      const described = citesInTheSpec(endpoint);
      if (served !== described) disagreeing.push(`${endpoint.path}: served=${served} described=${described}`);
    }
    assert.deepStrictEqual(disagreeing, [], `routes whose citation block and spec disagree:\n${disagreeing.join("\n")}`);
  });

  it("cites on more than half of the endpoints it describes", () => {
    const citing = [...carried.values()].filter((block) => block !== null);
    assert.ok(citing.length > carried.size / 2, `${citing.length} of ${carried.size} readable endpoints carry a citation`);
  });

  it("names every field the block carries", () => {
    const documented = new Set(Object.keys(spec.components.schemas.Provenance.properties ?? {}));
    const undocumented = new Set<string>();
    for (const block of carried.values()) {
      if (!block) continue;
      for (const field of Object.keys(block)) if (!documented.has(field)) undocumented.add(field);
    }
    assert.deepStrictEqual([...undocumented], [], `fields the citation block carries that the Provenance schema does not name: ${[...undocumented].join(", ")}`);
  });

  it("requires only the fields every block actually carries", () => {
    const required = spec.components.schemas.Provenance.required ?? [];
    const blocks = [...carried.values()].filter((block): block is Record<string, unknown> => block !== null);
    assert.ok(blocks.length > 0, "no endpoint carried a citation block");
    const absent = required.filter((field) => blocks.some((block) => !(field in block)));
    assert.deepStrictEqual(absent, [], `fields the Provenance schema requires that some block omits: ${absent.join(", ")}`);
  });

  it("describes each optional field as optional", () => {
    const properties = Object.keys(spec.components.schemas.Provenance.properties ?? {});
    const required = new Set(spec.components.schemas.Provenance.required ?? []);
    const blocks = [...carried.values()].filter((block): block is Record<string, unknown> => block !== null);
    const alwaysPresent = properties.filter((field) => !required.has(field) && blocks.every((block) => field in block));
    assert.deepStrictEqual(alwaysPresent, [], `fields every block carries that the schema leaves optional: ${alwaysPresent.join(", ")}`);
  });
});

describe("the spec's own vocabulary matches the code's", () => {
  it("offers every change type a record can hold as a filter value", () => {
    const filter = (spec.paths["/api/changes"].get as unknown as { parameters: { name: string; schema: { enum?: string[] } }[] })
      .parameters.find((p) => p.name === "type");
    assert.ok(filter?.schema.enum, "/api/changes documents no type filter");
    assert.deepStrictEqual([...filter.schema.enum].sort(), Object.keys(CHANGE_DIRECTION).sort());
  });

  it("types the change record with the same list it offers as a filter", () => {
    const onTheRecord = (spec.components.schemas.DealChange.properties!.change_type as { enum: string[] }).enum;
    const filter = (spec.paths["/api/changes"].get as unknown as { parameters: { name: string; schema: { enum?: string[] } }[] })
      .parameters.find((p) => p.name === "type")!;
    assert.deepStrictEqual([...onTheRecord].sort(), [...filter.schema.enum!].sort());
    assert.deepStrictEqual([...onTheRecord].sort(), [...CHANGE_TYPES].sort());
  });

  it("describes no capability we have withdrawn", () => {
    const published = JSON.stringify(openapiSpec);
    const residue = MCP_TOOLS_WITHDRAWN.map((tool) => tool.name).filter((name) => published.includes(name));
    assert.deepStrictEqual(residue, [], `the spec names withdrawn capabilities: ${residue.join(", ")}`);
  });

  it("says which served routes it leaves out rather than leaving them out in silence", () => {
    const stated = spec.info.description;
    assert.ok(/deliberately absent/.test(stated), "the spec does not say that any route is deliberately undescribed");
    assert.ok(stated.includes("POST /api/agents/register"), "the spec does not name the write path it leaves out");
    for (const write of API_ENDPOINTS.filter((e) => e.method !== "GET")) {
      assert.ok(
        spec.paths[specPath(write.path)]?.[write.method.toLowerCase()],
        `${write.method} ${write.path} is neither described nor declared out of scope`,
      );
    }
  });

  it("names every alias it describes and why the endpoint inventory does not hold it", () => {
    for (const [route, reason] of Object.entries(PATHS_OUTSIDE_THE_ENDPOINT_INVENTORY)) {
      assert.ok(spec.paths[route], `${route} is registered as an alias and not described`);
      assert.ok(reason.length > 30, `${route} is registered with no reason`);
    }
  });
});

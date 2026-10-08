import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { classifyTier } = await import("../dist/ranking.js");

type Offer = import("../src/types.ts").Offer;

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = new Date().toISOString().slice(0, 10);
const IN_A_WEEK = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

const PINNED = ["logflare.app", "phare.io", "addy.io"];

const STACK_USE_CASES = [
  "Next.js SaaS app", "API backend", "static blog", "mobile app", "AI chatbot",
  "ecommerce store", "python api", "express server", "documentation site", "something else entirely",
];

const catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
const pinnedListings: Offer[] = catalogue.offers.filter((offer: Offer) => PINNED.includes(offer.vendor));

const VENDOR_WITH_A_REFERRAL_CODE = "Railway";

const REQUESTS: Record<string, string[]> = {
  "/api/offers": ["/api/offers?limit=5000"],
  "/api/new": ["/api/new?days=30"],
  "/api/newest": ["/api/newest?limit=50"],
  "/api/expiring": ["/api/expiring?within_days=365"],
  "/api/compare": [`/api/compare?a=${PINNED[0]}&b=${PINNED[1]}`, `/api/compare?a=${PINNED[2]}&b=${PINNED[0]}`],
  "/api/audit-stack": [`/api/audit-stack?services=${PINNED.join(",")}`],
  "/api/costs": [`/api/costs?services=${PINNED.join(",")}`],
  "/api/stack": [
    ...STACK_USE_CASES.map((useCase) => `/api/stack?use_case=${encodeURIComponent(useCase)}`),
    ...[...new Set(pinnedListings.map((offer) => offer.category))].map((category) => `/api/stack?use_case=pinned&requirements=${encodeURIComponent(category)}`),
  ],
  "/api/details/{vendor}": PINNED.flatMap((vendor) => [`/api/details/${vendor}`, `/api/details/${vendor}?alternatives=true`]),
  "/api/vendor-risk/{vendor}": PINNED.map((vendor) => `/api/vendor-risk/${vendor}`),
  "/api/referral-codes/{vendor}": [`/api/referral-codes/${VENDOR_WITH_A_REFERRAL_CODE}`],
};

const UNDOCUMENTED_JSON_DOORS = ["/api/agent-payments"];

const LIST_DOORS = ["/api/new", "/api/newest", "/api/expiring", "/api/digest"];

const dir = mkdtempSync(path.join(tmpdir(), "withheld-terms-doors-"));

function newAndExpiringFirst(): string {
  const pinned = pinnedListings.map((offer) => ({ ...offer, verifiedDate: TODAY, expires_date: IN_A_WEEK }));
  const others = catalogue.offers.filter((offer: Offer) => !PINNED.includes(offer.vendor));
  const at = path.join(dir, "index.json");
  writeFileSync(at, JSON.stringify({ ...catalogue, offers: [...pinned, ...others] }));
  return at;
}

function startServer(indexPath: string): Promise<{ child: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_INDEX_PATH: indexPath },
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server startup timeout")); }, 60000);
    child.stderr!.on("data", (buffer: Buffer) => {
      const found = buffer.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (found) { clearTimeout(timer); resolve({ child, base: `http://localhost:${found[1]}` }); }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

type JsonObject = Record<string, unknown>;

function objectsIn(value: unknown, found: JsonObject[] = []): JsonObject[] {
  if (Array.isArray(value)) {
    for (const item of value) objectsIn(item, found);
  } else if (value !== null && typeof value === "object") {
    found.push(value as JsonObject);
    for (const inner of Object.values(value)) objectsIn(inner, found);
  }
  return found;
}

interface Withheld {
  vendor: string;
  description: string;
  terms_superseded: unknown;
}

function printsTheStoredTermsOf(object: JsonObject, listing: Withheld): boolean {
  if (object.vendor !== listing.vendor || typeof object.description !== "string") return false;
  const printed = object.description;
  return printed === listing.description || (printed.endsWith("...") && listing.description.startsWith(printed.slice(0, -3)));
}

interface DoorRead {
  door: string;
  request: string;
  status: number;
  json: unknown;
}

type Schema = Record<string, any>;

interface OpenApi {
  paths: Record<string, Record<string, Schema>>;
  components: { schemas: Record<string, Schema> };
}

let server: ChildProcess | null = null;
let withheld: Withheld[] = [];
let reads: DoorRead[] = [];
let documentedGetPaths: string[] = [];
let spec: OpenApi = { paths: {}, components: { schemas: {} } };

function requestsFor(door: string): string[] {
  return REQUESTS[door] ?? [door];
}

function printedWithheld(read: DoorRead): { object: JsonObject; listing: Withheld }[] {
  return objectsIn(read.json).flatMap((object) =>
    withheld.filter((listing) => printsTheStoredTermsOf(object, listing)).map((listing) => ({ object, listing })),
  );
}

before(async () => {
  const started = await startServer(newAndExpiringFirst());
  server = started.child;
  spec = await (await fetch(`${started.base}/api/openapi.json`)).json() as OpenApi;
  documentedGetPaths = Object.entries(spec.paths).filter(([, operations]) => "get" in operations).map(([door]) => door);
  const offers = await (await fetch(`${started.base}/api/offers?limit=5000`)).json() as { offers: (Offer & { terms_superseded: unknown })[] };
  withheld = offers.offers
    .filter((offer) => offer.terms_superseded)
    .map((offer) => ({ vendor: offer.vendor, description: offer.description, terms_superseded: offer.terms_superseded }));
  const doors = [...documentedGetPaths, ...UNDOCUMENTED_JSON_DOORS];
  reads = [];
  for (const door of doors) {
    for (const request of requestsFor(door)) {
      const response = await fetch(`${started.base}${request}`);
      const body = await response.text();
      const json = (response.headers.get("content-type") ?? "").includes("application/json") ? JSON.parse(body) : null;
      reads.push({ door, request, status: response.status, json });
    }
  }
});

after(() => {
  if (server) server.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe("#1746 every JSON door marks a listing whose stored terms the vendor page withholds", () => {
  it("withholds the terms of each pinned listing, so the doors below are read against records that are withheld", () => {
    for (const vendor of PINNED) {
      assert.ok(withheld.some((listing) => listing.vendor === vendor), `${vendor} is no longer withheld; pin another withheld listing`);
    }
  });

  it("reads every GET path /openapi.json documents, with the parameters each one requires", () => {
    const refused = reads.filter((read) => read.status !== 200).map((read) => `${read.request} -> ${read.status}`);
    assert.deepStrictEqual(refused, [], "give each refused door the requests it needs in REQUESTS");
    const read = new Set(reads.map((entry) => entry.door));
    assert.deepStrictEqual(documentedGetPaths.filter((door) => !read.has(door)), []);
  });

  it("publishes no withheld listing's stored description without terms_superseded, as /api/offers gives it", () => {
    const unmarked = reads.flatMap((read) =>
      printedWithheld(read)
        .filter(({ object, listing }) => !object.terms_superseded || JSON.stringify(object.terms_superseded) !== JSON.stringify(listing.terms_superseded))
        .map(({ listing }) => `${read.request}: ${listing.vendor}`),
    );
    assert.deepStrictEqual([...new Set(unmarked)], []);
  });

  for (const door of LIST_DOORS) {
    it(`finds every pinned listing in ${door}, so that door's check is not vacuous`, () => {
      const printed = new Set(reads.filter((read) => read.door === door).flatMap((read) => printedWithheld(read).map(({ listing }) => listing.vendor)));
      assert.deepStrictEqual(PINNED.filter((vendor) => !printed.has(vendor)), []);
    });
  }

  it("finds pinned listings through the vendor and comparison doors too", () => {
    for (const door of ["/api/details/{vendor}", "/api/compare"]) {
      const printed = new Set(reads.filter((read) => read.door === door).flatMap((read) => printedWithheld(read).map(({ listing }) => listing.vendor)));
      assert.deepStrictEqual(PINNED.filter((vendor) => !printed.has(vendor)), [], door);
    }
  });

  it("finds withheld candidates in /api/stack, so its check is not vacuous", () => {
    const printed = reads.filter((read) => read.door === "/api/stack").flatMap((read) => printedWithheld(read));
    assert.ok(printed.length > 0);
  });
});

describe("#1746 the monthly cost /api/stack gives", () => {
  const stacks = () => reads
    .filter((read) => read.door === "/api/stack")
    .map((read) => read.json as { stack: { candidates: { vendor: string; tier: string; terms_superseded: unknown }[] }[]; total_monthly_cost: string });

  const pricedAtZero = (candidate: { tier: string; terms_superseded: unknown }) =>
    !candidate.terms_superseded && classifyTier(candidate.tier).class === "free";

  it("names every candidate whose terms we withhold as not estimated, and counts the rest at $0", () => {
    const withWithheld = stacks().filter((stack) => stack.stack.some((role) => role.candidates.some((candidate) => candidate.terms_superseded)));
    assert.ok(withWithheld.length > 0, "no stack read holds a withheld candidate");
    for (const stack of withWithheld) {
      const candidates = stack.stack.flatMap((role) => role.candidates);
      for (const candidate of candidates.filter((each) => each.terms_superseded)) {
        assert.ok(stack.total_monthly_cost.includes(`${candidate.vendor} (stored terms withheld)`), stack.total_monthly_cost);
      }
      const atZero = candidates.filter(pricedAtZero).length;
      assert.ok(stack.total_monthly_cost.startsWith(`$0/mo for ${atZero} of ${candidates.length} services, within their free tiers. Not estimated: `), stack.total_monthly_cost);
    }
  });

  it("says all within free tiers only where every candidate is priced at $0", () => {
    for (const stack of stacks()) {
      const every = stack.stack.every((role) => role.candidates.every(pricedAtZero));
      assert.strictEqual(stack.total_monthly_cost === "$0/mo (all within free tiers)", every, stack.total_monthly_cost);
    }
  });
});

function referenced(ref: string): Schema {
  return spec.components.schemas[ref.replace("#/components/schemas/", "")] ?? {};
}

function branchesOf(schema: Schema): Schema[] {
  if (schema.$ref) return branchesOf(referenced(schema.$ref));
  const nested: Schema[] = [...(schema.allOf ?? []), ...(schema.oneOf ?? []), ...(schema.anyOf ?? [])];
  return [schema, ...nested.flatMap(branchesOf)];
}

function schemasForKey(schemas: Schema[], key: string): { schemas: Schema[]; mapped: boolean } {
  const named = schemas.filter((schema) => schema.properties && key in schema.properties).map((schema) => schema.properties[key]);
  if (named.length > 0) return { schemas: named, mapped: false };
  const mapped = schemas.filter((schema) => schema.additionalProperties && typeof schema.additionalProperties === "object").map((schema) => schema.additionalProperties);
  return { schemas: mapped, mapped: mapped.length > 0 };
}

function termsSupersededMismatches(schemas: Schema[], value: unknown, at: string, found: Set<string>): Set<string> {
  const branches = schemas.flatMap(branchesOf);
  if (Array.isArray(value)) {
    const items = branches.filter((schema) => schema.items).map((schema) => schema.items);
    for (const item of value) termsSupersededMismatches(items, item, `${at}[]`, found);
    return found;
  }
  if (value === null || typeof value !== "object") return found;
  const documented = branches.some((schema) => schema.properties && "terms_superseded" in schema.properties);
  const returned = "terms_superseded" in value;
  if (returned && !documented) found.add(`${at}: returned, not documented`);
  if (documented && !returned) found.add(`${at}: documented, not returned`);
  for (const [key, inner] of Object.entries(value)) {
    if (key === "terms_superseded") continue;
    const child = schemasForKey(branches, key);
    termsSupersededMismatches(child.schemas, inner, child.mapped ? `${at}.*` : `${at}.${key}`, found);
  }
  return found;
}

const THE_SPEC_ITSELF = "/api/openapi.json";

function responseSchemaOf(door: string): Schema | null {
  return spec.paths[door]?.get?.responses?.["200"]?.content?.["application/json"]?.schema ?? null;
}

describe("/openapi.json describes terms_superseded where the doors return it", () => {
  it("documents terms_superseded at every place a documented door returns it, and every documented place returns it", () => {
    const mismatches = reads
      .filter((read) => documentedGetPaths.includes(read.door) && read.door !== THE_SPEC_ITSELF && read.json !== null)
      .flatMap((read) => {
        const schema = responseSchemaOf(read.door);
        return [...termsSupersededMismatches(schema ? [schema] : [], read.json, read.door, new Set())];
      });
    assert.deepStrictEqual([...new Set(mismatches)], []);
  });

  it("gives every documented terms_superseded one shared schema", () => {
    const places: string[] = [];
    const visit = (node: unknown, at: string) => {
      if (Array.isArray(node)) { node.forEach((item, index) => visit(item, `${at}[${index}]`)); return; }
      if (node === null || typeof node !== "object") return;
      const properties = (node as Schema).properties;
      if (properties && typeof properties === "object" && "terms_superseded" in properties) {
        if (properties.terms_superseded.$ref !== "#/components/schemas/TermsSuperseded") places.push(at);
      }
      for (const [key, inner] of Object.entries(node)) visit(inner, `${at}.${key}`);
    };
    visit(spec, "openapi");
    assert.deepStrictEqual(places, []);
    assert.strictEqual(spec.components.schemas.TermsSuperseded?.nullable, true);
  });
});

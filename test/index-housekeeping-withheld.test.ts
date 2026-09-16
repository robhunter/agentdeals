import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoversPopulation, assertPopulationFloor, type Population } from "./population-floor.ts";
import { recordKey, storedChanges, type StoredChange } from "./withdrawn-change-records.ts";
import { INDEX_SWEEP_STATE, INCLUDE_INDEX_HOUSEKEEPING_REJECTED } from "../dist/change-census.js";
import { openapiSpec } from "../dist/openapi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const THE_WHOLE_LOG = "2000-01-01";

const REPORTS_OUR_INDEX = "our_index";

interface LoggedChange extends StoredChange {
  current_state?: string;
  reports?: string;
  standing?: string;
}

interface ChangesResponse {
  changes: LoggedChange[];
  advisory: LoggedChange[];
  total: number;
  returned: number;
  include_retracted: boolean;
  retracted_excluded: number;
  include_index_housekeeping: boolean;
  index_housekeeping_excluded: number;
  all_time_total: number;
  change_census: { retrievable_from_this_door: number; tracked_pricing_changes: number };
}

function heldRecords(): LoggedChange[] {
  return storedChanges() as LoggedChange[];
}

function ourOwnIndexHousekeeping(): LoggedChange[] {
  return heldRecords().filter((c) => c.current_state === INDEX_SWEEP_STATE);
}

function housekeepingPopulation(): Population {
  return {
    size: ourOwnIndexHousekeeping().length,
    read: "records in the log that are our own index housekeeping",
  };
}

function startServer(changesPath?: string): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: "0", BASE_URL: "http://localhost" };
    if (changesPath) env.AGENTDEALS_CHANGES_PATH = changesPath;
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], { stdio: ["pipe", "pipe", "pipe"], env });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server startup timeout")); }, 60000);
    child.stderr!.on("data", (buffer: Buffer) => {
      const found = buffer.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (found) { clearTimeout(timer); resolve({ proc: child, port: parseInt(found[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

describe("our own index housekeeping reaches no caller who did not ask for it", () => {
  let proc: ChildProcess;
  let port: number;

  before(async () => { ({ proc, port } = await startServer()); });
  after(() => { proc?.kill("SIGKILL"); });

  const ask = async (query: string): Promise<ChangesResponse> => {
    const res = await fetch(`http://localhost:${port}/api/changes?${query}`);
    assert.strictEqual(res.status, 200, `GET /api/changes?${query} answered ${res.status}`);
    return await res.json() as ChangesResponse;
  };

  it("withholds every housekeeping record from the unfiltered whole-log feed", async () => {
    const answer = await ask(`since=${THE_WHOLE_LOG}&limit=1000`);

    assertCoversPopulation(answer.returned + answer.index_housekeeping_excluded + answer.retracted_excluded,
      { size: heldRecords().length, read: "records the change log holds" },
      "records a whole-log query accounted for");
    assert.strictEqual(answer.changes.filter((c) => c.current_state === INDEX_SWEEP_STATE).length, 0);
    assert.strictEqual(answer.changes.filter((c) => c.reports === REPORTS_OUR_INDEX).length, 0);
    assert.strictEqual(answer.index_housekeeping_excluded, ourOwnIndexHousekeeping().length);
  });

  it("withholds them from a type-filtered feed, which is the query that named six live products", async () => {
    const answer = await ask("type=product_deprecated&limit=1000");
    const deprecations = heldRecords().filter((c) => c.change_type === "product_deprecated");
    const vendorsOwnDeprecations = deprecations.filter((c) => c.current_state !== INDEX_SWEEP_STATE);

    assertPopulationFloor(deprecations.length, 50, "records typed product_deprecated in the log");
    assert.ok(ourOwnIndexHousekeeping().length > 0, "no housekeeping record in the log to withhold");

    assert.strictEqual(answer.total, vendorsOwnDeprecations.length);
    assert.strictEqual(answer.total, deprecations.length - ourOwnIndexHousekeeping().length);
    assert.strictEqual(answer.index_housekeeping_excluded, ourOwnIndexHousekeeping().length);
    assert.ok(answer.total < deprecations.length,
      `a type-filtered total of ${answer.total} still counts every record the log holds under that type`);
  });

  it("counts a type-filtered total over the population all_time_total measures", async () => {
    const answer = await ask("type=product_deprecated&limit=1000");
    const tracked = heldRecords().filter((c) => c.current_state !== INDEX_SWEEP_STATE && !c.resolution);

    assert.strictEqual(answer.all_time_total, tracked.length);
    assert.strictEqual(
      answer.changes.filter((c) => c.reports === REPORTS_OUR_INDEX).length,
      0,
      "a record outside all_time_total came back inside a total taken over the same log",
    );
  });

  it("returns them, and reports withholding nothing, when a caller asks", async () => {
    const asked = await ask("type=product_deprecated&limit=1000&include_index_housekeeping=true");
    const withheld = await ask("type=product_deprecated&limit=1000");

    assert.strictEqual(asked.include_index_housekeeping, true);
    assert.strictEqual(withheld.include_index_housekeeping, false);
    assert.strictEqual(asked.index_housekeeping_excluded, 0);
    assert.strictEqual(asked.total, withheld.total + withheld.index_housekeeping_excluded);
    assertCoversPopulation(
      asked.changes.filter((c) => c.reports === REPORTS_OUR_INDEX).length,
      housekeepingPopulation(),
      "housekeeping records returned to a caller who asked for them",
    );
    assert.strictEqual(asked.all_time_total, withheld.all_time_total,
      "asking for withheld records moved the figure that is meant to be unaffected by the query");
  });

  it("moves retrievable_from_this_door with the parameter and leaves the census alone", async () => {
    const withheld = await ask(`since=${THE_WHOLE_LOG}&limit=1`);
    const asked = await ask(`since=${THE_WHOLE_LOG}&limit=1&include_index_housekeeping=true`);

    assert.strictEqual(
      asked.change_census.retrievable_from_this_door - withheld.change_census.retrievable_from_this_door,
      ourOwnIndexHousekeeping().length,
    );
    assert.strictEqual(asked.change_census.tracked_pricing_changes, withheld.change_census.tracked_pricing_changes);
  });

  it("refuses a value that is neither true nor false rather than ignoring it", async () => {
    const res = await fetch(`http://localhost:${port}/api/changes?include_index_housekeeping=yes`);
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(await res.json(), { error: INCLUDE_INDEX_HOUSEKEEPING_REJECTED });
  });

  it("leaves every record the vendor did make exactly as it served it before", async () => {
    const served = await ask("type=product_deprecated&limit=1000");
    const everything = await ask("type=product_deprecated&limit=1000&include_index_housekeeping=true");
    const vendorsOwn = everything.changes.filter((c) => c.reports !== REPORTS_OUR_INDEX);

    assertCoversPopulation(served.returned, { size: vendorsOwn.length, read: "deprecations the vendor made" },
      "deprecations still served after the filter");
    assert.deepStrictEqual(
      served.changes.map(recordKey).sort(),
      vendorsOwn.map(recordKey).sort(),
      "the filter moved a record it was not meant to touch",
    );
    for (const change of served.changes) {
      assert.strictEqual(change.change_type, "product_deprecated");
      assert.strictEqual(change.standing, "in_force");
    }
  });

  it("withholds them from a category door, where a whole category was our own housekeeping", async () => {
    const answer = await ask(`since=${THE_WHOLE_LOG}&category=Startup Perks&limit=1000`);

    assert.ok(answer.index_housekeeping_excluded > 0,
      "the category that carries our housekeeping reported withholding none of it");
    assert.strictEqual(answer.changes.filter((c) => c.reports === REPORTS_OUR_INDEX).length, 0);
  });

  it("keeps advisory clear of them too", async () => {
    const answer = await ask(`since=${THE_WHOLE_LOG}&limit=1&include_index_housekeeping=true`);
    assert.strictEqual(answer.advisory.filter((c) => c.reports === REPORTS_OUR_INDEX).length, 0);
  });
});

describe("the field a caller filters on and the rule we filter by name the same records", () => {
  it("holds no record that declares one and not the other", () => {
    const held = heldRecords();
    assertPopulationFloor(held.length, 400, "records read from the change log");

    const byState = held.filter((c) => c.current_state === INDEX_SWEEP_STATE).map(recordKey).sort();
    const byField = held.filter((c) => c.reports === REPORTS_OUR_INDEX).map(recordKey).sort();

    assertCoversPopulation(byState.length, housekeepingPopulation(), "records the sweep rule admits");
    assert.deepStrictEqual(byState, byField,
      "a record carries reports 'our_index' or the sweep's current_state but not both, so the door withholds a different set than it documents");
  });
});

describe("a housekeeping record the log picks up later is withheld on the same rule", () => {
  let dir: string;
  let proc: ChildProcess;
  let port: number;

  const asStored = (change: Record<string, unknown>) => ({
    previous_state: "before",
    source_url: "https://example.com/pricing",
    alternatives: [],
    date_source: "vendor_page",
    ...change,
  });

  const VENDORS_OWN = asStored({ vendor: "Northwind", date: "2026-05-02", change_type: "product_deprecated", impact: "high", summary: "Northwind retired its free build minutes.", current_state: "No free tier.", category: "Cloud Hosting" });
  const OURS = asStored({ vendor: "Eastwind", date: "2026-05-03", change_type: "product_deprecated", impact: "low", summary: "Eastwind: we stopped listing an offer of ours", current_state: INDEX_SWEEP_STATE, reports: REPORTS_OUR_INDEX, category: "Cloud Hosting", source_url: "" });
  const ALSO_OURS = asStored({ vendor: "Southwind", date: "2026-05-04", change_type: "free_tier_removed", impact: "low", summary: "Southwind: we stopped listing an offer of ours", current_state: INDEX_SWEEP_STATE, reports: REPORTS_OUR_INDEX, category: "Database", source_url: "" });

  const writeLog = (at: string, changes: unknown[]) => writeFileSync(at, JSON.stringify({ changes }));

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "housekeeping-"));
    const at = path.join(dir, "deal_changes.json");
    writeLog(at, [VENDORS_OWN, OURS, ALSO_OURS]);
    ({ proc, port } = await startServer(at));
  });
  after(() => { proc?.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); });

  const ask = async (query: string): Promise<ChangesResponse> => {
    const res = await fetch(`http://localhost:${port}/api/changes?${query}`);
    assert.strictEqual(res.status, 200);
    return await res.json() as ChangesResponse;
  };

  it("reads the log it was pointed at", async () => {
    const answer = await ask(`since=${THE_WHOLE_LOG}&limit=100&include_index_housekeeping=true`);
    assert.strictEqual(answer.total, 3, "the synthetic log did not load, so every count below is over an empty log");
  });

  it("serves the vendor's deprecation and withholds ours", async () => {
    const answer = await ask("type=product_deprecated&limit=100");
    assert.strictEqual(answer.total, 1);
    assert.strictEqual(answer.index_housekeeping_excluded, 1);
    assert.deepStrictEqual(answer.changes.map((c) => c.vendor), ["Northwind"]);
  });

  it("withholds one filed under a type the April sweep never used", async () => {
    const answer = await ask("type=free_tier_removed&limit=100");
    assert.strictEqual(answer.total, 0);
    assert.strictEqual(answer.index_housekeeping_excluded, 1);
  });

  it("withholds both from the whole log and hands both back on request", async () => {
    const withheld = await ask(`since=${THE_WHOLE_LOG}&limit=100`);
    const asked = await ask(`since=${THE_WHOLE_LOG}&limit=100&include_index_housekeeping=true`);

    assert.strictEqual(withheld.total, 1);
    assert.strictEqual(withheld.index_housekeeping_excluded, 2);
    assert.strictEqual(asked.total, 3);
    assert.strictEqual(asked.index_housekeeping_excluded, 0);
    assert.strictEqual(withheld.all_time_total, 1);
  });

  it("counts a record withheld on both grounds once, under the ground that withheld it", async () => {
    const at = path.join(dir, "both-deal_changes.json");
    writeLog(at, [
      VENDORS_OWN,
      { ...OURS, resolution: { state: "retracted", date: "2026-05-10", detail: "Retracted: our own error." } },
    ]);
    const { proc: second, port: secondPort } = await startServer(at);
    try {
      const read = async (query: string) => {
        const res = await fetch(`http://localhost:${secondPort}/api/changes?${query}`);
        return await res.json() as ChangesResponse;
      };
      const plain = await read(`since=${THE_WHOLE_LOG}&limit=100`);
      assert.strictEqual(plain.total, 1);
      assert.strictEqual(plain.retracted_excluded, 1);
      assert.strictEqual(plain.index_housekeeping_excluded, 0);

      const retractedBack = await read(`since=${THE_WHOLE_LOG}&limit=100&include_retracted=true`);
      assert.strictEqual(retractedBack.total, 1);
      assert.strictEqual(retractedBack.retracted_excluded, 0);
      assert.strictEqual(retractedBack.index_housekeeping_excluded, 1);

      const both = await read(`since=${THE_WHOLE_LOG}&limit=100&include_retracted=true&include_index_housekeeping=true`);
      assert.strictEqual(both.total, 2);
      assert.strictEqual(both.retracted_excluded, 0);
      assert.strictEqual(both.index_housekeeping_excluded, 0);
    } finally {
      second.kill("SIGKILL");
    }
  });
});

describe("the contract says what it withholds", () => {
  const operation = (openapiSpec as {
    paths: Record<string, { get: { parameters: { name: string; description: string; schema: { type: string; default: unknown } }[]; responses: Record<string, { content: Record<string, { schema: { properties: Record<string, { description?: string }> } }> }> } }>;
  }).paths["/api/changes"].get;

  it("declares the parameter a caller asks with, defaulting to withholding", () => {
    const parameter = operation.parameters.find((p) => p.name === "include_index_housekeeping");
    assert.ok(parameter, "/api/changes documents no include_index_housekeeping parameter");
    assert.strictEqual(parameter.schema.type, "boolean");
    assert.strictEqual(parameter.schema.default, false);
    assert.match(parameter.description, /reports 'our_index'/);
    assert.match(parameter.description, /index_housekeeping_excluded/);
  });

  it("describes the count it publishes in the words the retracted count uses", () => {
    const properties = operation.responses["200"].content["application/json"].schema.properties;
    const stated = properties.index_housekeeping_excluded?.description ?? "";
    const modelled = properties.retracted_excluded?.description ?? "";

    assert.ok(stated, "/api/changes publishes index_housekeeping_excluded and describes it nowhere");
    for (const shared of ["How many records matched your query and were withheld", "because nothing was withheld", "Read this before comparing a count against an earlier one"]) {
      assert.ok(modelled.includes(shared), `the retracted description no longer reads "${shared}"`);
      assert.ok(stated.includes(shared), `index_housekeeping_excluded does not say "${shared}" the way retracted_excluded does`);
    }
    assert.match(stated, /reports 'our_index'/);
    assert.ok(properties.include_index_housekeeping, "the echoed parameter is undeclared");
  });

  it("stops promising a total counted over a population it no longer counts over", () => {
    const properties = operation.responses["200"].content["application/json"].schema.properties;
    assert.match(properties.total?.description ?? "", /include_index_housekeeping/);
    assert.match(
      properties.change_census?.properties?.retrievable_from_this_door?.description ?? "",
      /include_index_housekeeping/,
    );
  });
});

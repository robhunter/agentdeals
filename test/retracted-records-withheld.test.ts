import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoversPopulation } from "./population-floor.ts";
import {
  changeTypesHoldingAWithdrawnRecord,
  recordKey,
  recordsWeHaveWithdrawn,
  typesHoldingAWithdrawnRecord,
  undoneRecords,
  withdrawnRecords,
  type StoredChange,
} from "./withdrawn-change-records.ts";
import { CHANGE_STANDINGS, INCLUDE_RETRACTED_REJECTED } from "../dist/change-resolution.js";
import { openapiSpec } from "../dist/openapi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const THE_WHOLE_LOG = "2000-01-01";

interface ServedChange {
  vendor: string;
  date: string;
  change_type: string;
  impact: string;
  standing: string;
  resolution?: { state: string } | null;
}

interface ChangesResponse {
  changes: ServedChange[];
  advisory: ServedChange[];
  total: number;
  returned: number;
  include_retracted: boolean;
  retracted_excluded: number;
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

describe("a change record we have withdrawn reaches no caller who did not ask for it", () => {
  let proc: ChildProcess;
  let base: string;

  before(async () => {
    const started = await startServer();
    proc = started.proc;
    base = `http://localhost:${started.port}`;
  });

  after(() => { proc?.kill("SIGKILL"); });

  const changes = async (query: string): Promise<ChangesResponse> =>
    await (await fetch(`${base}/api/changes?since=${THE_WHOLE_LOG}&limit=2000&${query}`)).json() as ChangesResponse;

  it("holds one back under every change type the log files one under", async () => {
    const types = changeTypesHoldingAWithdrawnRecord();
    assertCoversPopulation(types.length, typesHoldingAWithdrawnRecord(), "change types the sweep asks about");

    const withheld = new Set(withdrawnRecords().map(recordKey));
    assertCoversPopulation(withheld.size, recordsWeHaveWithdrawn(), "withdrawn records the sweep looks for");

    const served: string[] = [];
    let accountedFor = 0;
    for (const type of types) {
      const answer = await changes(`type=${encodeURIComponent(type)}`);
      for (const record of answer.changes) {
        if (withheld.has(recordKey(record))) served.push(`${type}: ${record.vendor} ${record.date}`);
        if (record.standing === "retracted") served.push(`${type}: ${record.vendor} ${record.date} declares itself retracted`);
      }
      accountedFor += answer.retracted_excluded;
    }
    assert.deepStrictEqual(served, [], `records we have withdrawn, served to a caller who did not ask for them:\n${served.join("\n")}`);
    assert.strictEqual(accountedFor, withheld.size, "the withheld count the responses publish does not add up to the records held back");
  });

  it("hands every one of them back, weighing nothing, to a caller who asks", async () => {
    const withheld = new Set(withdrawnRecords().map(recordKey));
    const answer = await changes("include_retracted=true");
    const returned = answer.changes.filter((record) => withheld.has(recordKey(record)));

    assertCoversPopulation(returned.length, recordsWeHaveWithdrawn(), "withdrawn records handed back on request");
    assert.deepStrictEqual([...new Set(returned.map((record) => record.standing))], ["retracted"]);
    assert.deepStrictEqual([...new Set(returned.map((record) => record.impact))], ["none"],
      "a record we have withdrawn is served carrying weight");
    assert.strictEqual(answer.retracted_excluded, 0, "a response that withheld nothing reports withholding something");
  });

  it("keeps serving a change the vendor undid, which is history rather than our error", async () => {
    const undone = undoneRecords();
    assert.ok(undone.length > 0, "the log holds no reversed record, so this says nothing about whether one would be served");
    const answer = await changes("");
    const served = new Set(answer.changes.map(recordKey));
    const missing = undone.filter((record) => !served.has(recordKey(record))).map(recordKey);
    assert.deepStrictEqual(missing, [], `changes the vendor undid, withheld as though they were our error: ${missing.join(", ")}`);
    assert.deepStrictEqual(
      [...new Set(answer.changes.filter((record) => undone.some((u) => recordKey(u) === recordKey(record))).map((r) => r.standing))],
      ["reversed"],
    );
  });

  it("says where every record stands, on the ones we stand behind as well", async () => {
    const answer = await changes("include_retracted=true");
    const unstated = answer.changes.filter((record) => !CHANGE_STANDINGS.includes(record.standing as never));
    assert.deepStrictEqual(unstated.map(recordKey), [], "records served without a standing a caller can read");
    assert.ok(answer.changes.some((record) => record.standing === "in_force"), "no record was served as standing");
  });

  it("never puts a record we have withdrawn into what it puts forward as worth knowing", async () => {
    for (const query of ["", "include_retracted=true", "vendor=Vercel"]) {
      const answer = await changes(query);
      const pushed = answer.advisory.filter((record) => record.standing === "retracted").map(recordKey);
      assert.deepStrictEqual(pushed, [], `withdrawn records offered as advisory on '${query}': ${pushed.join(", ")}`);
    }
  });

  it("refuses a value it cannot read rather than quietly withholding what was asked for", async () => {
    for (const value of ["1", "yes", "TRUE", ""]) {
      const res = await fetch(`${base}/api/changes?include_retracted=${value}`);
      assert.strictEqual(res.status, 400, `include_retracted='${value}' was accepted`);
      assert.strictEqual(((await res.json()) as { error: string }).error, INCLUDE_RETRACTED_REJECTED);
    }
    const spelled = await changes("include_retracted=false");
    assert.strictEqual(spelled.include_retracted, false);
  });
});

describe("the withholding is a property of the record, not of the data we happen to hold", () => {
  let proc: ChildProcess;
  let base: string;
  let dir: string;

  const WRITTEN: StoredChange[] = [
    { vendor: "Standing Co", date: "2026-05-01", change_type: "free_tier_removed", impact: "high" },
    { vendor: "Withdrawn Co", date: "2026-05-02", change_type: "free_tier_removed", impact: "high", resolution: { state: "retracted", date: "2026-05-20" } },
    { vendor: "Undone Co", date: "2026-05-03", change_type: "restriction", impact: "high", resolution: { state: "reversed", date: "2026-05-21" } },
    { vendor: "Withdrawn Two", date: "2026-05-04", change_type: "limits_reduced", impact: "medium", resolution: { state: "retracted", date: "2026-05-22" } },
  ].map((change) => ({
    ...change,
    summary: `${change.vendor} changed something.`,
    previous_state: "before",
    current_state: "after",
    source_url: "https://example.com/pricing",
    category: "Cloud Hosting",
    alternatives: [],
    date_source: "vendor_page",
  })) as unknown as StoredChange[];

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "withdrawn-"));
    const at = path.join(dir, "deal_changes.json");
    writeFileSync(at, JSON.stringify({ changes: WRITTEN }));
    const started = await startServer(at);
    proc = started.proc;
    base = `http://localhost:${started.port}`;
  });

  after(() => { proc?.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); });

  const changes = async (query: string): Promise<ChangesResponse> =>
    await (await fetch(`${base}/api/changes?since=${THE_WHOLE_LOG}&limit=2000&${query}`)).json() as ChangesResponse;

  it("serves the two we stand behind and counts the two we do not", async () => {
    const answer = await changes("");
    assert.deepStrictEqual(answer.changes.map((record) => record.vendor).sort(), ["Standing Co", "Undone Co"]);
    assert.strictEqual(answer.total, 2);
    assert.strictEqual(answer.retracted_excluded, 2);
  });

  it("counts the withheld records of the filter that was asked for, not of the whole log", async () => {
    const answer = await changes("type=limits_reduced");
    assert.deepStrictEqual(answer.changes, []);
    assert.strictEqual(answer.retracted_excluded, 1);
  });

  it("returns all four, each saying where it stands, when they are asked for", async () => {
    const answer = await changes("include_retracted=true");
    assert.deepStrictEqual(
      Object.fromEntries(answer.changes.map((record) => [record.vendor, `${record.standing}/${record.impact}`])),
      {
        "Standing Co": "in_force/high",
        "Withdrawn Co": "retracted/none",
        "Undone Co": "reversed/high",
        "Withdrawn Two": "retracted/none",
      },
    );
  });
});

describe("the machine-readable spec says the records are being withheld", () => {
  const operation = (openapiSpec as unknown as {
    paths: Record<string, { get: { parameters: { name: string; schema: { type: string } }[]; responses: Record<string, { content: Record<string, { schema: { properties: Record<string, unknown> } }> }> } }>;
    components: { schemas: Record<string, { allOf?: { properties?: Record<string, { enum?: string[] }>; required?: string[] }[] }> };
  }).paths["/api/changes"].get;

  it("offers the parameter that brings them back", () => {
    const parameter = operation.parameters.find((p) => p.name === "include_retracted");
    assert.ok(parameter, "the spec offers no way to ask for the records the endpoint withholds");
    assert.strictEqual(parameter.schema.type, "boolean");
  });

  it("names the count of what was withheld in the response it describes", () => {
    const body = operation.responses["200"].content["application/json"].schema.properties;
    for (const field of ["include_retracted", "retracted_excluded"]) {
      assert.ok(field in body, `the spec describes a response with no ${field}`);
    }
  });

  it("requires a standing on the record shape this endpoint serves", () => {
    const spec = (openapiSpec as unknown as { components: { schemas: Record<string, { allOf?: { properties?: Record<string, { enum?: string[] }>; required?: string[] }[] }> } })
      .components.schemas.PublishedDealChange;
    const added = spec.allOf?.find((part) => part.properties?.standing);
    assert.ok(added, "the published record shape declares no standing");
    assert.deepStrictEqual(added.properties!.standing.enum, [...CHANGE_STANDINGS]);
    assert.ok(added.required?.includes("standing"), "standing is declared but left optional");
    assert.ok(added.properties!.impact?.enum?.includes("none"), "the weight a withdrawn record carries is undeclared");
  });
});

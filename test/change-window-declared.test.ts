import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";
import { getDealChanges } from "../dist/data.js";
import { servedWindowOpens, DEFAULT_CHANGE_WINDOW_DAYS } from "../dist/change-window.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const TODAY = new Date().toISOString().slice(0, 10);
const dayOffset = (days: number) =>
  new Date(Date.parse(TODAY) + days * 86400000).toISOString().slice(0, 10);

const OLDER_THAN_THE_WINDOW = dayOffset(-(DEFAULT_CHANGE_WINDOW_DAYS + 370));
const INSIDE_THE_WINDOW = dayOffset(-3);

const ONLY_OLD = "Nimbusdb";
const ONLY_RECENT = "Quaylight";
const BOTH = "Terrafold";
const ADVISORY_SUBJECT = "Wickerstone";

function change(vendor: string, date: string, changeType: string, category: string) {
  return {
    vendor,
    change_type: changeType,
    date,
    date_source: "vendor_page",
    summary: `${vendor} changed its free plan on ${date}.`,
    previous_state: "15 GB storage",
    current_state: "5 GB storage",
    impact: "high",
    source_url: `https://example.com/${vendor.toLowerCase()}/pricing`,
    category,
    alternatives: [],
    recorded_date: date,
  };
}

const SYNTHETIC = [
  change(ONLY_OLD, OLDER_THAN_THE_WINDOW, "free_tier_removed", "Databases"),
  change(ONLY_RECENT, INSIDE_THE_WINDOW, "limits_reduced", "Monitoring"),
  change(BOTH, OLDER_THAN_THE_WINDOW, "free_tier_removed", "Databases"),
  change(BOTH, INSIDE_THE_WINDOW, "limits_reduced", "Databases"),
  change(ADVISORY_SUBJECT, INSIDE_THE_WINDOW, "free_tier_removed", "Monitoring"),
];

function startServer(changesPath: string): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_CHANGES_PATH: changesPath },
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("startup timeout")); }, 60000);
    child.stderr?.on("data", (b: Buffer) => {
      const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timer); resolve({ proc: child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

interface ChangeWindowField {
  applied: boolean;
  from: string | null;
  source: string;
  field: string;
  note: string;
}

interface ChangesResponse {
  changes: { vendor: string; date: string; change_type: string }[];
  total: number;
  advisory: { date: string }[];
  date_window: ChangeWindowField;
}

describe("the window a change query ran under is stated on the response", () => {
  let server: ChildProcess;
  let base: string;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "change-window-"));
    writeFileSync(path.join(dir, "deal_changes.json"), JSON.stringify({ changes: SYNTHETIC }, null, 2));
    const started = await startServer(path.join(dir, "deal_changes.json"));
    server = started.proc;
    base = `http://localhost:${started.port}`;
  });

  after(() => {
    server?.kill("SIGKILL");
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const ask = async (query: string): Promise<ChangesResponse> => {
    const res = await fetch(`${base}/api/changes?limit=1000${query}`);
    assert.strictEqual(res.status, 200, `GET /api/changes${query} answered ${res.status}`);
    return await res.json() as ChangesResponse;
  };

  const vendorsIn = (r: ChangesResponse) => [...new Set(r.changes.map((c) => c.vendor))].sort();

  it("holds a store that can tell a windowed answer from an unwindowed one", async () => {
    const everything = await ask("&since=2000-01-01");
    assert.strictEqual(everything.total, SYNTHETIC.length, "the server is not reading the synthetic store");
    const opens = servedWindowOpens();
    assert.ok(
      everything.changes.some((c) => c.date < opens) && everything.changes.some((c) => c.date >= opens),
      "the store has records on only one side of the window, so nothing below can distinguish the two rules",
    );
  });

  it("still windows the unfiltered feed, and says so", async () => {
    const feed = await ask("");
    assert.deepStrictEqual(
      vendorsIn(feed),
      [ONLY_RECENT, BOTH, ADVISORY_SUBJECT].sort(),
      `the unfiltered feed returned ${vendorsIn(feed)}, so the default window moved`,
    );
    assert.ok(!vendorsIn(feed).includes(ONLY_OLD), `${ONLY_OLD} holds only a record older than the window and reached the feed`);
    assert.strictEqual(feed.date_window.applied, true);
    assert.strictEqual(feed.date_window.source, "default");
    assert.strictEqual(feed.date_window.from, servedWindowOpens());
  });

  it("answers a vendor filter from the whole log, whatever the record's age", async () => {
    const old = await ask(`&vendor=${ONLY_OLD}`);
    assert.strictEqual(old.total, 1, `${ONLY_OLD} holds a record and the filter answered ${old.total}`);
    assert.strictEqual(old.changes[0]!.date, OLDER_THAN_THE_WINDOW);

    const both = await ask(`&vendor=${BOTH}`);
    assert.strictEqual(both.total, 2, `${BOTH} holds two records and the filter answered ${both.total}`);
  });

  it("answers every other declared filter from the whole log too", async () => {
    for (const query of [`&vendors=${ONLY_OLD}`, "&type=free_tier_removed", "&categories=Databases", "&category=Databases"]) {
      const answer = await ask(query);
      assert.ok(
        answer.changes.some((c) => c.date === OLDER_THAN_THE_WINDOW),
        `${query} returned nothing older than the default window, so it inherited it`,
      );
      assert.strictEqual(answer.date_window.applied, false, `${query} reports a window it did not apply`);
    }
  });

  it("names no window where it applied none, and applies none it did not name", async () => {
    const queries = [
      "", `&vendor=${ONLY_OLD}`, `&vendors=${BOTH}`, "&type=free_tier_removed", "&categories=Databases",
      "&since=2000-01-01", `&since=${INSIDE_THE_WINDOW}`, `&since=2000-01-01&vendor=${ONLY_OLD}`,
      "&vendor=avalueweholdnorecordfor", "&include_retracted=true",
    ];
    for (const query of queries) {
      const answer = await ask(query);
      const window = answer.date_window;
      assert.ok(window, `/api/changes${query} reports a total under no stated window`);
      assert.strictEqual(window.field, "date");
      assert.ok(window.note.length > 0, `${query} states a window with no note`);
      if (window.applied) {
        assert.ok(window.from, `${query} says a window applied and names no date`);
        const early = answer.changes.filter((c) => c.date < window.from!);
        assert.deepStrictEqual(early, [], `${query} returned records dated before the window it declares`);
      } else {
        assert.strictEqual(window.from, null, `${query} says no window applied and names a date`);
        assert.strictEqual(window.source, "none");
      }
    }
  });

  it("reports a since the caller passed as the caller's, not as ours", async () => {
    const narrowed = await ask(`&since=${INSIDE_THE_WINDOW}&vendor=${ONLY_OLD}`);
    assert.strictEqual(narrowed.total, 0, "since must still narrow a vendor query");
    assert.strictEqual(narrowed.date_window.source, "since_parameter");
    assert.strictEqual(narrowed.date_window.from, INSIDE_THE_WINDOW);
  });

  it("keeps the advisory block recent even where the query searched the whole log", async () => {
    const opens = servedWindowOpens();
    const drawnOnItsOwnWindow = `&type=free_tier_removed&vendor=${BOTH}`;
    const populated = await ask(drawnOnItsOwnWindow);
    assert.ok(
      populated.advisory.length > 0,
      "the advisory block is empty for every query here, so nothing below can tell a recent pool from an old one",
    );

    for (const query of [drawnOnItsOwnWindow, `&vendor=${ONLY_OLD}`, "&type=free_tier_removed", "&since=2000-01-01"]) {
      const answer = await ask(query);
      const stale = answer.advisory.filter((c) => c.date < opens);
      assert.deepStrictEqual(stale, [], `${query} put a record older than ${opens} in the advisory block`);
    }
  });

  it("answers the same way at the MCP door as at the HTTP one", async () => {
    const call = async (args: Record<string, unknown>) => {
      const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
      const init = await fetch(`${base}/mcp`, {
        method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } }),
      });
      const session = init.headers.get("mcp-session-id");
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: session ? { ...headers, "mcp-session-id": session } : headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "track_changes", arguments: { ...args, include_expiring: false } } }),
      });
      const text = await res.text();
      const frame = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).pop() ?? text;
      const parsed = JSON.parse(frame) as { result?: { content?: { text?: string }[] } };
      return JSON.parse(parsed.result?.content?.[0]?.text ?? "{}") as ChangesResponse;
    };

    const viaMcp = await call({ vendor: ONLY_OLD });
    assert.strictEqual(viaMcp.total, 1, `track_changes(vendor: "${ONLY_OLD}") answered ${viaMcp.total}`);
    assert.strictEqual(viaMcp.date_window.applied, false, "the MCP door reports a window the HTTP door does not");

    const personalized = await call({ vendors: ONLY_OLD, categories: "Databases" });
    assert.ok(personalized.date_window, "the personalized shape reports a total under no stated window");
    assert.strictEqual(personalized.date_window.applied, false);
  });
});

describe("no vendor we hold a change record for is hidden from a filter by its age", () => {
  it("answers every vendor in the log when asked for it by name", () => {
    const everything = getDealChanges("2020-01-01");
    const vendors = [...new Set(everything.changes.map((c) => c.vendor))];
    assertPopulationFloor(vendors.length, 100, "vendors the change log names, over which this walk runs");

    const outsideTheWindow = vendors.filter((v) =>
      everything.changes.filter((c) => c.vendor === v).every((c) => c.date < servedWindowOpens()),
    );
    assert.ok(
      outsideTheWindow.length > 0,
      "every vendor holds a record inside the default window today, so this control cannot fail",
    );

    const silent = vendors.filter((v) => getDealChanges(undefined, undefined, v).total === 0);
    assert.deepStrictEqual(
      silent.slice(0, 20),
      [],
      `${silent.length} of ${vendors.length} vendors hold a live record and answer 0 when asked for by name`,
    );
  });

  it("states the default window and where it runs, wherever the parameter is declared", async () => {
    const { SINCE_DEFAULT_SENTENCE } = await import("../dist/change-window.js");
    assert.match(SINCE_DEFAULT_SENTENCE, new RegExp(`${DEFAULT_CHANGE_WINDOW_DAYS} days ago`));
    assert.match(SINCE_DEFAULT_SENTENCE, /date_source/);
    assert.match(SINCE_DEFAULT_SENTENCE, /date_window/);

    const declarations = [
      { file: "src/server.ts", why: "the tool schema the in-process MCP server publishes" },
      { file: "src/server-remote.ts", why: "the tool schema the stdio proxy publishes" },
      { file: "src/serve.ts", why: "the reference /llms-full.txt serves" },
      { file: "src/openapi.ts", why: "the parameter /openapi.json declares" },
    ];
    const { readFileSync } = await import("node:fs");
    for (const { file, why } of declarations) {
      const source = readFileSync(path.join(REPO, file), "utf8");
      assert.ok(
        !/Default: 7 days ago/.test(source),
        `${why} still declares a 7-day default against a ${DEFAULT_CHANGE_WINDOW_DAYS}-day one (${file})`,
      );
      assert.ok(
        source.includes("SINCE_DEFAULT_SENTENCE"),
        `${why} states the default in its own words rather than the one the server honours (${file})`,
      );
    }
  });
});

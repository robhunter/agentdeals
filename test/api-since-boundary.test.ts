import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDealChanges, getNewestDeals, loadDealChanges } from "../dist/data.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WINDOW_DAYS = 30;

const ROUTES = [
  { path: "/api/changes", records: "changes", dateField: "date" },
  { path: "/api/newest", records: "deals", dateField: "verifiedDate" },
] as const;

const IMPOSSIBLE_DATES = ["2026-02-30", "2026-13-99", "2026-00-10", "2026-04-31", "2026-02-29"];

const DECLARED_FILTERS = ["type", "vendor", "vendors", "category", "categories"];

const A_VALUE_WE_HOLD_NO_RECORD_FOR = "a-value-we-hold-no-record-for";

function lastDays(count: number): string[] {
  const days: string[] = [];
  const today = Date.now();
  for (let i = 0; i < count; i++) days.push(new Date(today - i * 86400000).toISOString().slice(0, 10));
  return days.reverse();
}

describe("the readers behind the MCP tools narrow an instant to its day", () => {
  const daysWithChanges = (): string[] => {
    const dates = new Set(loadDealChanges().map((c: { date: string }) => c.date));
    return [...dates].sort().slice(-10);
  };

  it("getDealChanges answers the same set for a day and for an instant inside it", () => {
    const days = daysWithChanges();
    assert.ok(days.length > 0, "the change log holds no dates, so this proves nothing");
    for (const day of days) {
      const bare = getDealChanges(day);
      for (const suffix of ["T00:00:00Z", "T23:59:59Z"]) {
        const instant = getDealChanges(`${day}${suffix}`);
        assert.strictEqual(instant.total, bare.total, `since=${day}${suffix} returned ${instant.total} against ${bare.total} for the day it names`);
      }
    }
  });

  it("getNewestDeals answers the same set for a day and for an instant inside it", () => {
    for (const day of daysWithChanges()) {
      const bare = getNewestDeals({ since: day, limit: 50 });
      for (const suffix of ["T00:00:00Z", "T23:59:59Z"]) {
        const instant = getNewestDeals({ since: `${day}${suffix}`, limit: 50 });
        assert.strictEqual(instant.total, bare.total, `since=${day}${suffix} returned ${instant.total} against ${bare.total} for the day it names`);
      }
    }
  });
});

describe("since names a day and the whole of that day comes back", () => {
  let proc: ChildProcess;
  let base: string;

  const get = async (path: string): Promise<{ status: number; body: string; json: Record<string, any> }> => {
    const res = await fetch(`${base}${path}`);
    const body = await res.text();
    let json: Record<string, any> = {};
    try { json = JSON.parse(body); } catch { json = {}; }
    return { status: res.status, body, json };
  };

  before(async () => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const started = await new Promise<{ proc: ChildProcess; port: number }>((resolve, reject) => {
      const child = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1" },
      });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("startup timeout")); }, 60000);
      child.stderr?.on("data", (b: Buffer) => {
        const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timer); resolve({ proc: child, port: parseInt(m[1]!, 10) }); }
      });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    proc = started.proc;
    base = `http://127.0.0.1:${started.port}`;
  });

  after(() => { proc?.kill("SIGKILL"); });

  for (const route of ROUTES) {
    it(`${route.path} answers the same total for a day and for an instant inside it, on every one of the last ${WINDOW_DAYS} days`, async () => {
      const disagreed: string[] = [];
      let daysCarryingRecords = 0;
      for (const day of lastDays(WINDOW_DAYS)) {
        const bare = await get(`${route.path}?limit=1000&since=${day}`);
        assert.strictEqual(bare.status, 200, `${route.path}?since=${day} answered ${bare.status}`);
        const onThatDay = (bare.json[route.records] ?? [])
          .filter((r: Record<string, string>) => String(r[route.dateField] ?? "").slice(0, 10) === day).length;
        if (onThatDay > 0) daysCarryingRecords++;
        const earliest = (json: Record<string, any>): string =>
          (json[route.records] ?? []).map((r: Record<string, string>) => r[route.dateField]).filter(Boolean).sort()[0] ?? "-";
        for (const suffix of ["T00:00:00Z", "T23:59:59Z", "T12:00:00.000Z"]) {
          const instant = await get(`${route.path}?limit=1000&since=${encodeURIComponent(day + suffix)}`);
          assert.strictEqual(instant.status, 200, `${route.path}?since=${day}${suffix} answered ${instant.status}`);
          if (instant.json.total !== bare.json.total) {
            disagreed.push(`${day}${suffix}: ${instant.json.total} against ${bare.json.total} for the bare date, ${onThatDay} records dated that day`);
          } else if (earliest(instant.json) !== earliest(bare.json)) {
            disagreed.push(`${day}${suffix}: reaches back to ${earliest(instant.json)} against ${earliest(bare.json)} for the bare date, on the same count`);
          }
        }
      }
      assert.ok(daysCarryingRecords > 0, `${route.path} carries no records in the last ${WINDOW_DAYS} days, so this walk proves nothing`);
      assert.deepStrictEqual(disagreed, [], `${route.path} returns a different set for an instant inside a day than for the day`);
    });

    it(`${route.path} refuses a date the calendar does not have, the same way it refuses a value that is not a date`, async () => {
      const malformed = await get(`${route.path}?since=not-a-date`);
      assert.strictEqual(malformed.status, 400);
      for (const value of IMPOSSIBLE_DATES) {
        const res = await get(`${route.path}?since=${encodeURIComponent(value)}`);
        assert.strictEqual(res.status, 400, `since=${value} answered ${res.status}`);
        assert.strictEqual(res.body, malformed.body, `since=${value} answered a different body than a value that is not a date`);
      }
    });

    it(`${route.path} accepts an instant rather than refusing it, so a client storing a timestamp keeps working`, async () => {
      const res = await get(`${route.path}?since=2026-01-15T09:41:27.123Z`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(typeof res.json.total, "number");
    });

    it(`${route.path} carries an entity tag and answers 304 to a request that already holds it`, async () => {
      const first = await fetch(`${base}${route.path}`);
      assert.strictEqual(first.status, 200);
      await first.text();
      const tag = first.headers.get("etag");
      assert.ok(tag, `${route.path} carries no ETag and no client can revalidate it`);
      const again = await fetch(`${base}${route.path}`, { headers: { "If-None-Match": tag! } });
      assert.strictEqual(again.status, 304, `${route.path} served a body to a client that already holds this representation`);
      assert.strictEqual((await again.text()).length, 0);
      assert.strictEqual(again.headers.get("access-control-allow-origin"), "*");
    });

    it(`${route.path} gives a different query its own entity tag`, async () => {
      const wide = await fetch(`${base}${route.path}?limit=1000`);
      await wide.text();
      const narrow = await fetch(`${base}${route.path}?limit=1`);
      await narrow.text();
      assert.notStrictEqual(
        wide.headers.get("etag"),
        narrow.headers.get("etag"),
        `${route.path} answers two different result sets under one tag`,
      );
      const revalidated = await fetch(`${base}${route.path}?limit=1`, { headers: { "If-None-Match": wide.headers.get("etag")! } });
      assert.strictEqual(revalidated.status, 200, `${route.path} answered 304 to a tag belonging to another query`);
      await revalidated.text();
    });
  }

  it("the page route this was modelled on still revalidates", async () => {
    const first = await fetch(`${base}/vendor/vercel`);
    assert.strictEqual(first.status, 200);
    await first.text();
    const tag = first.headers.get("etag");
    assert.ok(tag);
    const again = await fetch(`${base}/vendor/vercel`, { headers: { "If-None-Match": tag! } });
    assert.strictEqual(again.status, 304);
  });

  it("a declared filter still narrows the change log, and a value we hold nothing for still returns nothing", async () => {
    const unfiltered = await get("/api/changes?limit=1000");
    const rows = unfiltered.json.changes as { vendor: string; change_type: string; category?: string }[];
    assert.ok(rows.length > 1, `the window holds ${rows.length} records, too few for this control`);

    const rarestValueInTheWindow = (field: (r: (typeof rows)[number]) => string | undefined, name: string): string => {
      const counts = new Map<string, number>();
      for (const row of rows) {
        const value = field(row);
        if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      const narrowing = [...counts.entries()].filter(([, n]) => n < rows.length).sort((a, b) => a[1] - b[1])[0];
      assert.ok(narrowing, `every record in the window carries one ${name}, so no filter over it can narrow`);
      return narrowing[0];
    };

    const drawnFromTheWindow: Record<string, string> = {
      type: rarestValueInTheWindow((r) => r.change_type, "change type"),
      vendor: rarestValueInTheWindow((r) => r.vendor, "vendor"),
      category: rarestValueInTheWindow((r) => r.category, "category"),
    };
    drawnFromTheWindow.vendors = drawnFromTheWindow.vendor;
    drawnFromTheWindow.categories = drawnFromTheWindow.category;

    for (const param of DECLARED_FILTERS) {
      const value = drawnFromTheWindow[param]!;
      const hit = await get(`/api/changes?limit=1000&${param}=${encodeURIComponent(value)}`);
      assert.ok(hit.json.total > 0, `${param}=${value} is carried by a record in the window and returned nothing`);
      assert.ok(
        hit.json.total < unfiltered.json.total,
        `${param}=${value} returned ${hit.json.total} of ${unfiltered.json.total}, which is no narrower`,
      );
      const miss = await get(`/api/changes?limit=1000&${param}=${A_VALUE_WE_HOLD_NO_RECORD_FOR}`);
      assert.strictEqual(miss.json.total, 0, `${param} returned ${miss.json.total} for a value no record carries`);
    }

    const paged = await get("/api/changes?limit=2&offset=2");
    assert.strictEqual(paged.json.returned, 2);
    assert.strictEqual(paged.json.offset, 2);
  });

  it("the rule the routes follow is the rule /openapi.json states", async () => {
    const spec = await get("/openapi.json");
    for (const route of ROUTES) {
      const since = spec.json.paths[route.path].get.parameters.find((p: { name: string }) => p.name === "since");
      assert.ok(since, `${route.path} declares no since parameter`);
      assert.match(since.description, /ISO-8601/, `${route.path} does not say an instant is accepted`);
      assert.match(since.description, /400/, `${route.path} does not say an impossible date is refused`);
    }
  });
});

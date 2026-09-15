import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  CHANGE_SLICES,
  TRACKED_CHANGE_NOUN,
  TRACKED_CHANGE_RULE_ANCHOR,
  changeCensus,
  changeCountPhrase,
  isIndexHousekeeping,
  isTrackedChange,
  sliceById,
  trackedChanges,
} = await import("../dist/change-census.js");
const { whyNotEvidence } = await import("../dist/risk-scorecard.js");
const { loadDealChanges, partitionByDateProvenance } = await import("../dist/data.js");

const dealChanges = loadDealChanges() as any[];

const census = changeCensus(dealChanges);
const trackedCount = census.tracked_pricing_changes;

const SURFACES_THAT_PUBLISH_A_TOTAL = [
  "/",
  "/changes",
  "/pricing-changes",
  "/reports",
  "/expiring",
  "/feed.xml",
  "/stability",
  "/budget-builder",
  "/stack-check",
  "/state-of-free-tiers",
  "/free-tier-risk",
  "/trends",
  "/vendor/vercel",
  "/q1-2026-developer-pricing-report",
];

const QUALIFIERS = "(?:[a-z]+\\s+){0,3}";

const TRACKED_NOUN_PATTERNS = [
  new RegExp(`([\\d,]+)\\s+${QUALIFIERS}tracked ${QUALIFIERS}pricing changes`, "gi"),
  new RegExp(`([\\d,]+)\\s+${QUALIFIERS}pricing changes tracked`, "gi"),
  new RegExp(`track\\s+([\\d,]+)\\s+${QUALIFIERS}pricing changes`, "gi"),
  new RegExp(`<strong>([\\d,]+)</strong>\\s+(?:<a[^>]*>)?tracked pricing changes`, "gi"),
];

const NAMES_A_WINDOW =
  /Q[1-4]\s*20\d\d|\b20\d\d\s*[–—-]\s*20\d\d|last\s+\d+\s+days|this week|during\b|\bin\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/i;

const SENTENCE_BREAK = /[.!?;:]\s|[–—]\s|<\/?[a-z]/i;

function sentenceAround(body: string, index: number): string {
  const before = body.slice(Math.max(0, index - 200), index);
  const after = body.slice(index, index + 200);
  const breaks = [...before.matchAll(new RegExp(SENTENCE_BREAK, "gi"))];
  const start = breaks.length > 0 ? breaks[breaks.length - 1].index! + breaks[breaks.length - 1][0].length : 0;
  const end = after.search(new RegExp(SENTENCE_BREAK, "i"));
  return before.slice(start) + (end === -1 ? after : after.slice(0, end));
}

function claimsTheWholeLog(body: string, index: number): boolean {
  return !NAMES_A_WINDOW.test(sentenceAround(body, index));
}

describe("the change census separates four totals and names each", () => {
  it("nests the four slices, widest last", () => {
    const counts = CHANGE_SLICES.map((s: any) => s.of(dealChanges).length);
    for (let i = 1; i < counts.length; i++) {
      assert.ok(
        counts[i] > counts[i - 1],
        `${CHANGE_SLICES[i].id} (${counts[i]}) does not admit more than ${CHANGE_SLICES[i - 1].id} (${counts[i - 1]})`,
      );
    }
  });

  it("gives every slice a distinct noun a sentence can carry", () => {
    const nouns = CHANGE_SLICES.map((s: any) => s.noun);
    assert.strictEqual(new Set(nouns).size, nouns.length, `two slices share a noun: ${nouns.join(" / ")}`);
    for (const slice of CHANGE_SLICES) {
      assert.ok(slice.admits.length > 20, `${slice.id} does not say what it takes in`);
      assert.match(changeCountPhrase(slice.id, dealChanges), new RegExp(`^[\\d,]+ ${slice.noun}$`));
    }
  });

  it("excludes from the tracked count exactly what the rating engine already refuses as evidence", () => {
    const refusedByRatings = dealChanges.filter(
      (c) => whyNotEvidence(c) === "no_longer_in_force" || whyNotEvidence(c) === "index_sweep",
    );
    assert.ok(refusedByRatings.length > 0, "nothing is refused, so the agreement proves nothing");
    assert.strictEqual(trackedChanges(dealChanges).length, dealChanges.length - refusedByRatings.length);
    for (const change of refusedByRatings) assert.strictEqual(isTrackedChange(change), false);
  });

  it("counts index housekeeping as held but not as a tracked change", () => {
    const housekeeping = dealChanges.filter(isIndexHousekeeping);
    assert.ok(housekeeping.length > 0, "no housekeeping record, so the exclusion proves nothing");
    for (const change of housekeeping) {
      assert.strictEqual(isTrackedChange(change), false, `${change.vendor} counts as a tracked change`);
    }
    assert.strictEqual(census.changes_still_in_force - trackedCount, housekeeping.filter((c) => !c.resolution).length);
  });
});

describe("every published total is the tracked count or names the slice it is", () => {
  let proc: ChildProcess | null = null;
  let port = 0;

  before(async () => {
    const started = await new Promise<{ child: ChildProcess; port: number }>((resolve, reject) => {
      const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
      });
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
      });
      child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
    proc = started.child;
    port = started.port;
  });

  after(() => { proc?.kill(); });

  const get = async (route: string) => {
    const res = await fetch(`http://localhost:${port}${route}`, {
      headers: { "user-agent": "agentdeals-internal/1.0 (change-census-test)" },
    });
    assert.strictEqual(res.status, 200, `${route} responded ${res.status}`);
    return res.text();
  };

  it("publishes the tracked count wherever the tracked noun appears", async () => {
    const wrong: string[] = [];
    let seen = 0;
    for (const route of SURFACES_THAT_PUBLISH_A_TOTAL) {
      const body = await get(route);
      for (const pattern of TRACKED_NOUN_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of body.matchAll(pattern)) {
          const published = Number(match[1].replace(/,/g, ""));
          if (published < 40) continue;
          if (!claimsTheWholeLog(body, match.index ?? 0)) continue;
          seen++;
          if (published !== trackedCount) wrong.push(`${route}: ${match[0].slice(0, 70)}`);
        }
      }
    }
    assert.ok(seen >= SURFACES_THAT_PUBLISH_A_TOTAL.length, `only ${seen} totals found, so the check proves nothing`);
    assert.deepStrictEqual(wrong, []);
  });

  it("names the slice in the same sentence wherever it publishes a figure that is not the tracked count", async () => {
    const superseded = CHANGE_SLICES.filter((s: any) => s.id !== "tracked")
      .map((s: any) => ({ noun: s.noun, id: s.id, count: s.of(dealChanges).length }));
    const unnamed: string[] = [];
    let examined = 0;
    for (const route of SURFACES_THAT_PUBLISH_A_TOTAL) {
      const body = await get(route);
      for (const slice of superseded) {
        for (const match of body.matchAll(new RegExp(`(?<![\\d.,$/-])${slice.count}(?![\\d.,%/-])`, "g"))) {
          const sentence = sentenceAround(body, match.index ?? 0);
          if (!/\bchange|\brecord|\btrack/i.test(sentence)) continue;
          examined++;
          if (!sentence.includes(slice.noun)) unnamed.push(`${route}: ${slice.count} (${slice.id}) in "${sentence.trim().slice(0, 90)}"`);
        }
      }
    }
    assertPopulationFloor(examined, 2, "figures from a slice other than the tracked count");
    assert.deepStrictEqual(unnamed, []);
  });

  it("states the rule on /changes with a count for each slice", async () => {
    const body = await get("/changes");
    assert.ok(body.includes(`id="${TRACKED_CHANGE_RULE_ANCHOR}"`), "/changes carries no rule anchor");
    for (const slice of CHANGE_SLICES) {
      const count = slice.of(dealChanges).length.toLocaleString("en-US");
      assert.ok(body.includes(slice.noun), `/changes never names the ${slice.id} slice`);
      assert.ok(body.includes(`<strong>${count}</strong>`), `/changes publishes no count for ${slice.id}`);
    }
  });

  it("carries the census on /api/changes with all_time_total equal to the tracked count", async () => {
    const res = await fetch(`http://localhost:${port}/api/changes?limit=1`);
    const body = await res.json() as any;
    assert.strictEqual(body.all_time_total, trackedCount);
    for (const slice of CHANGE_SLICES) {
      assert.strictEqual(body.change_census[slice.field], slice.of(dealChanges).length, `change_census.${slice.field}`);
    }
    assert.match(body.change_census.rule_url, new RegExp(`#${TRACKED_CHANGE_RULE_ANCHOR}$`));
    assert.strictEqual(body.change_log_freshness.records_held, sliceById("held").of(dealChanges).length);
  });

  it("publishes the tracked count on the MCP resource door, which no page crawl reaches", async () => {
    const rpc = async (body: unknown, sessionId?: string) => {
      const res = await fetch(`http://localhost:${port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify(body),
      });
      return { text: await res.text(), sessionId: res.headers.get("mcp-session-id") };
    };

    const opened = await rpc({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "change-census", version: "1" } },
    });
    const sessionId = opened.sessionId;
    assert.ok(sessionId, "the MCP door opened no session");
    await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);

    const read = await rpc(
      { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "agentdeals://changes" } },
      sessionId,
    );
    const stated = read.text.match(/(\d[\d,]*) tracked pricing changes/);
    assert.ok(stated, `the changes resource states no tracked total: ${read.text.slice(0, 200)}`);
    assert.strictEqual(Number(stated[1].replace(/,/g, "")), trackedCount);
    for (const other of CHANGE_SLICES.filter((s: any) => s.id !== "tracked")) {
      const figure = other.of(dealChanges).length;
      assert.ok(
        !new RegExp(`${figure} tracked`).test(read.text),
        `the changes resource calls ${figure} a tracked count, which is the ${other.id} slice`,
      );
    }
  });

  it("does not move the count of changes whose effective date is unknown", async () => {
    const body = await get("/changes");
    const undated = partitionByDateProvenance(dealChanges).discovered.length;
    assertPopulationFloor(undated, 200, "records whose effective date is unknown");
    assert.ok(
      body.includes(`Effective date unknown (${undated} changes)`),
      `/changes does not publish the undated group at ${undated}`,
    );
  });

  it("states one Q1 figure in prose and in both JSON-LD nodes", async () => {
    const body = await get("/q1-2026-developer-pricing-report");
    const inQ1 = dealChanges.filter(
      (c) => isTrackedChange(c) && c.date >= "2026-01-01" && c.date <= "2026-03-31" && c.date_source !== "discovered",
    ).length;
    assert.ok(inQ1 > 10, `only ${inQ1} Q1 records, so the check proves nothing`);
    const claimed = [...body.matchAll(/([\d,]+) verified pricing changes/g)].map((m) => Number(m[1].replace(/,/g, "")));
    assert.ok(claimed.length >= 3, `only ${claimed.length} Q1 claims found across prose and JSON-LD`);
    assert.deepStrictEqual([...new Set(claimed)], [inQ1]);
  });

  it("names the tracked noun on the same surfaces that link the rule", async () => {
    const linkless: string[] = [];
    for (const route of ["/changes", "/stability", "/state-of-free-tiers", "/free-tier-risk", "/trends"]) {
      const body = await get(route);
      if (!body.includes(TRACKED_CHANGE_NOUN) && !body.includes("pricing changes tracked")) continue;
      if (!body.includes(TRACKED_CHANGE_RULE_ANCHOR)) linkless.push(route);
    }
    assert.deepStrictEqual(linkless, []);
  });
});

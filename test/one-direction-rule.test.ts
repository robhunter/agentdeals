import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANGE_DIRECTION, CHANGE_TYPE_MEANING, NEGATIVE_CHANGE_TYPES, POSITIVE_CHANGE_TYPES, changeDirectionTable } from "../dist/change-direction.js";
import { trackedChanges } from "../dist/change-census.js";
import { loadDealChanges } from "../dist/data.js";
import { directionCopiesIn, describeCopy } from "./direction-sets.ts";
import { assertPopulationFloor } from "./population-floor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC_DIR = path.join(__dirname, "..", "src");

const RULE_OWNER = "change-direction.ts";

const PAGES_THAT_SPLIT_THE_LOG = ["/", "/state-of-free-tiers", "/free-tier-risk"];

const SPLIT = /(\d+) negative[^.]{0,140}?vs (\d+) positive/;

const asText = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

interface TrendRow {
  slug: string;
  category: string;
  direction: string;
  negative: number;
  positive: number;
}

function trendRowsIn(html: string): TrendRow[] {
  const rows: TrendRow[] = [];
  const row = /<a href="\/trends\/([a-z0-9-]+)" class="trend-row">([\s\S]*?)<\/a>/g;
  for (const match of html.matchAll(row)) {
    const [, slug, body] = match;
    const category = body.match(/class="trend-cat">([^<]*)</)?.[1] ?? "";
    const direction = body.match(/class="trend-dir"[^>]*>([^<]*)</)?.[1] ?? "";
    rows.push({
      slug,
      category,
      direction: direction.replace(/&#x21[0-9a-f]{2};/i, "").trim(),
      negative: parseInt(body.match(/>(\d+) neg</)?.[1] ?? "0", 10),
      positive: parseInt(body.match(/>(\d+) pos</)?.[1] ?? "0", 10),
    });
  }
  return rows;
}

const directionFromCounts = (negative: number, positive: number) =>
  negative === 0 && positive === 0 ? "Stable"
    : negative > positive ? "Prices rising"
      : positive > negative ? "Prices declining"
        : "Stable";

describe("one direction rule decides every split we publish", () => {
  let proc: ChildProcess;
  let base: string;

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
  });

  after(() => { proc?.kill("SIGKILL"); });

  it("publishes the same two numbers on every page that splits the change log", async () => {
    const tracked = trackedChanges(loadDealChanges());
    const negative = tracked.filter(c => NEGATIVE_CHANGE_TYPES.has(c.change_type)).length;
    const positive = tracked.filter(c => POSITIVE_CHANGE_TYPES.has(c.change_type)).length;
    const published: string[] = [];
    for (const page of PAGES_THAT_SPLIT_THE_LOG) {
      const match = asText(await (await fetch(`${base}${page}`)).text()).match(SPLIT);
      assert.ok(match, `${page} publishes no negative-versus-positive split`);
      published.push(`${page} ${match[1]} negative / ${match[2]} positive`);
    }
    const expected = PAGES_THAT_SPLIT_THE_LOG.map(p => `${p} ${negative} negative / ${positive} positive`);
    assert.deepStrictEqual(published, expected);
  });

  it("gives every trend page a direction its own counts support", async () => {
    const rows = trendRowsIn(await (await fetch(`${base}/trends`)).text());
    assert.ok(rows.length >= 40, `the trends index rendered ${rows.length} rows`);
    const contradictions = rows
      .filter(r => r.direction !== directionFromCounts(r.negative, r.positive))
      .map(r => `${r.category}: ${r.negative} neg / ${r.positive} pos published as ${r.direction}`);
    assert.deepStrictEqual(contradictions, []);
  });

  it("gives a trend page the same direction as the row that links to it", async () => {
    const rows = trendRowsIn(await (await fetch(`${base}/trends`)).text());
    const disagreed: string[] = [];
    let compared = 0;
    for (const row of rows) {
      const res = await fetch(`${base}/trends/${row.slug}`);
      if (res.status !== 200) continue;
      compared++;
      const onPage = (await res.text()).match(/Direction: prices (rising|declining)\.|Direction: (stable)\./);
      const label = onPage?.[1] ? `Prices ${onPage[1]}` : "Stable";
      if (label !== row.direction) disagreed.push(`/trends/${row.slug}: index says ${row.direction}, page says ${label}`);
    }
    assert.deepStrictEqual(disagreed, []);
    assert.ok(compared >= 40, `only ${compared} of ${rows.length} rows on the index reached a page to compare`);
  });

  it("files every entry on the change log under the bucket its type carries", async () => {
    const page = await (await fetch(`${base}/pricing-changes`)).text();
    const entries = [...page.matchAll(/data-type="([a-z_]+)"[^>]*data-category="([a-z]+)"/g)];
    assertPopulationFloor(entries.length, 400, "entries the change log renders with a bucket");
    const misfiled = entries
      .filter(([, type, filed]) => filed !== CHANGE_DIRECTION[type as keyof typeof CHANGE_DIRECTION])
      .map(([, type, filed]) => `${type} filed as ${filed}`);
    assert.deepStrictEqual([...new Set(misfiled)], []);
  });

  it("hands the reader's browser the same two sets the server reads", async () => {
    const injected: string[] = [];
    for (const page of ["/stack-check", "/compare-tool"]) {
      const html = await (await fetch(`${base}${page}`)).text();
      const parse = (name: RegExp) => JSON.parse(html.match(name)?.[1] ?? "null");
      injected.push(`${page} negative ${JSON.stringify(parse(/var (?:negTypes|NEG_TYPES) = (\[[^\]]*\]);/))}`);
      injected.push(`${page} positive ${JSON.stringify(parse(/var (?:posTypes|POS_TYPES) = (\[[^\]]*\]);/))}`);
    }
    const expected = ["/stack-check", "/compare-tool"].flatMap(page => [
      `${page} negative ${JSON.stringify([...NEGATIVE_CHANGE_TYPES])}`,
      `${page} positive ${JSON.stringify([...POSITIVE_CHANGE_TYPES])}`,
    ]);
    assert.deepStrictEqual(injected, expected);
  });

  it("publishes the bucket of every change type on the criteria page", async () => {
    const criteria = await (await fetch(`${base}/criteria`)).text();
    const missing = Object.entries(CHANGE_DIRECTION)
      .filter(([code, direction]) => !criteria.includes(`<code>${code}</code></td><td>${CHANGE_TYPE_MEANING[code as keyof typeof CHANGE_TYPE_MEANING]}</td><td style="text-align:center">${direction}`))
      .map(([code, direction]) => `${code} is not published as ${direction}`);
    assert.deepStrictEqual(missing, []);
    assert.strictEqual(changeDirectionTable().length, Object.keys(CHANGE_DIRECTION).length);
  });

  it("lists the rule it applies on the stability dashboard rather than a second one", async () => {
    const page = await (await fetch(`${base}/stability`)).text();
    const listed = (heading: string) => {
      const section = page.slice(page.indexOf(heading));
      return [...section.slice(0, section.indexOf("</ul>")).matchAll(/<li class="(?:neg|pos)-dot">([^<]+)<\/li>/g)]
        .map(m => m[1].replace(/ /g, "_"));
    };
    assert.deepStrictEqual(listed("Negative Change Types"), [...NEGATIVE_CHANGE_TYPES]);
    assert.deepStrictEqual(listed("Positive Change Types"), [...POSITIVE_CHANGE_TYPES]);
  });
});

describe("no surface keeps a direction set of its own", () => {
  it("finds none outside the module that owns the rule", () => {
    const copies: string[] = [];
    for (const file of readdirSync(SRC_DIR).filter(f => f.endsWith(".ts") && f !== RULE_OWNER)) {
      const source = readFileSync(path.join(SRC_DIR, file), "utf8");
      copies.push(...directionCopiesIn(source).map(c => describeCopy(file, c)));
    }
    assert.deepStrictEqual(copies, []);
  });

  it("catches a set written as a literal collection", () => {
    const found = directionCopiesIn(`const negativeTypes = new Set(["free_tier_removed", "limits_reduced"]);`);
    assert.deepStrictEqual(found.map(c => c.identifier), ["negativeTypes"]);
  });

  it("catches a set injected into a page's own script", () => {
    const found = directionCopiesIn(`  var NEG_TYPES = ['free_tier_removed','limits_reduced','pricing_restructured'];`);
    assert.deepStrictEqual(found.map(c => c.shape), ["collection"]);
  });

  it("catches a second map, whatever it is called", () => {
    const found = directionCopiesIn(`const filterCategory = { free_tier_removed: "negative", pricing_restructured: "neutral" };`);
    assert.deepStrictEqual(found.map(c => c.shape), ["map"]);
  });

  it("catches a set written as a chain of comparisons", () => {
    const found = directionCopiesIn(`const positive = changes.filter(c => c.change_type === "limits_increased" || c.change_type === "new_free_tier");`);
    assert.deepStrictEqual(found.map(c => c.shape), ["comparison chain"]);
  });

  it("leaves a call site that reads the shared set alone", () => {
    assert.deepStrictEqual(directionCopiesIn(`const negativeTypes = NEGATIVE_CHANGE_TYPES;`), []);
  });

  it("leaves a grouping that answers a different question about the same types", () => {
    assert.deepStrictEqual(directionCopiesIn(`const CHANGE_IS_AN_EVENT = new Set(["pricing_restructured", "limits_reduced"]);`), []);
    assert.deepStrictEqual(directionCopiesIn(`const FREE_TIER_WORSENED_TYPES = ["free_tier_removed", "limits_reduced"];`), []);
  });

  it("leaves a per-type table that is not about direction", () => {
    assert.deepStrictEqual(directionCopiesIn(`const colour = { free_tier_removed: "#f85149", limits_reduced: "#d29922" };`), []);
  });
});

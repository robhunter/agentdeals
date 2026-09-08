import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { assertPopulationFloor } from "./population-floor.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { directionRatioLabel, RATIO_ROUNDING_TOLERANCE } from "../dist/change-direction.js";
import { recordsStillInForce, isNoLongerInForce, resolutionTag } from "../dist/change-resolution.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const EVENT_DATED = ["vendor_page", "hand_written"];
const NEGATIVE_TYPES = ["free_tier_removed", "limits_reduced", "restriction", "open_source_killed", "product_deprecated"];

interface StoredChange {
  vendor: string;
  date: string;
  date_source: string;
  change_type: string;
  impact: string;
  summary: string;
  category?: string;
  resolution?: { state: string; date: string; detail?: string } | null;
}

function storedChanges(): StoredChange[] {
  const raw = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8"));
  return Array.isArray(raw) ? raw : raw.changes;
}

function startServer(changesPath: string): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost:3000", AGENTDEALS_CHANGES_PATH: changesPath },
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Server startup timeout"));
    }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timeout);
        resolve({ proc: child, port: parseInt(m[1], 10) });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function visibleText(body: string): string {
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&rsquo;/g, "’")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function subjectRecord(changes: StoredChange[]): StoredChange {
  const now = today();
  const candidates = changes
    .filter(
      (c) =>
        EVENT_DATED.includes(c.date_source) &&
        NEGATIVE_TYPES.includes(c.change_type) &&
        !c.resolution &&
        c.date <= now &&
        c.date.slice(0, 4) === now.slice(0, 4)
    )
    .sort((a, b) => b.date.localeCompare(a.date));
  assertPopulationFloor(candidates.length, 1, "records this year we could put a resolution on");
  return candidates[0]!;
}

function sectionText(body: string, opening: string, closing: RegExp): string {
  const start = body.indexOf(opening);
  assert.notStrictEqual(start, -1, `section ${JSON.stringify(opening)} is not on the page`);
  const rest = body.slice(start + opening.length);
  const end = rest.search(closing);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("a ratio printed over a change population", () => {
  it("rounds to a whole number only while that stays true to the figures", () => {
    assert.strictEqual(directionRatioLabel(288, 87), "3.3:1");
    assert.strictEqual(directionRatioLabel(174, 87), "2:1");
    assert.strictEqual(directionRatioLabel(196, 87), "2.3:1");
    assert.strictEqual(directionRatioLabel(9, 4), "2:1");
    assert.strictEqual(directionRatioLabel(10, 4), "2.5:1");
    assert.strictEqual(directionRatioLabel(7, 2), "3.5:1");
    assert.strictEqual(directionRatioLabel(3, 0), "3:0");
  });

  it("never prints a whole number further than the tolerance from the figures it stands for", () => {
    for (let negative = 0; negative <= 400; negative++) {
      for (const positive of [1, 2, 3, 7, 40, 87, 120]) {
        const label = directionRatioLabel(negative, positive);
        const printed = parseFloat(label.split(":")[0]!);
        const denominator = parseFloat(label.split(":")[1]!);
        assert.strictEqual(denominator, 1, label);
        assert.ok(
          Math.abs(printed - negative / positive) <= RATIO_ROUNDING_TOLERANCE,
          `${label} stands for ${negative}/${positive}`
        );
      }
    }
  });
});

describe("what a record we no longer stand behind is counted in", () => {
  const servers: ChildProcess[] = [];
  let tmp = "";
  let inForcePort = 0;
  let resolvedPort = 0;
  let subject: StoredChange;
  let monthRoute = "";

  const COUNTS_THE_RECORD: Array<{ route: string; figure: string; pattern: RegExp }> = [
    { route: "/", figure: "the negative total beside the link to the report", pattern: /(\d[\d,]*) negative<\/span>/ },
    {
      route: "/state-of-free-tiers",
      figure: "the tracked-change total in the page meta",
      pattern: /(\d[\d,]*) pricing changes tracked across/,
    },
    {
      route: "/state-of-free-tiers",
      figure: "the negative count in the executive summary",
      pattern: /(\d[\d,]*) negative pricing changes vs/,
    },
    {
      route: "/free-tier-risk",
      figure: "the tracked-change total the index is derived from",
      pattern: /We track (\d[\d,]*) pricing changes across the developer tool ecosystem/,
    },
    { route: "/reports", figure: "the archive subtitle", pattern: /across (\d[\d,]*) tracked changes/ },
    {
      route: "/pricing-changes",
      figure: "the Total Changes tile",
      pattern: /class="stat-value">(\d[\d,]*)<\/div>\s*<div class="stat-label">Total Changes/,
    },
    {
      route: "/changes",
      figure: "the count in the page description",
      pattern: /(\d[\d,]*) developer infrastructure pricing changes tracked since launch/,
    },
    {
      route: "/free-tier-tracker",
      figure: "the byline figure every guide shares",
      pattern: /Tracking (\d[\d,]*) pricing changes across/,
    },
  ];

  before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "change-resolution-totals-"));
    const changes = storedChanges();
    subject = subjectRecord(changes);
    monthRoute = `/reports/${subject.date.slice(0, 7)}`;

    const write = (name: string, records: unknown[]) => {
      const p = path.join(tmp, name);
      writeFileSync(p, JSON.stringify({ changes: records }));
      return p;
    };
    const resolvedSubject = {
      ...subject,
      resolution: { state: "retracted", date: today(), detail: "The vendor's page never carried this." },
    };
    const withResolution = changes.map((c) => (c === subject ? resolvedSubject : c));

    const [a, b] = await Promise.all([
      startServer(write("in-force.json", changes)),
      startServer(write("resolved.json", withResolution)),
    ]);
    servers.push(a.proc, b.proc);
    inForcePort = a.port;
    resolvedPort = b.port;
  });

  after(() => {
    for (const proc of servers) proc.kill();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  async function body(port: number, route: string): Promise<string> {
    const res = await fetch(`http://localhost:${port}${route}`);
    assert.strictEqual(res.status, 200, route);
    return res.text();
  }

  function figure(body: string, pattern: RegExp, where: string): number {
    const m = body.match(pattern);
    assert.ok(m, `${where} states no figure matching ${pattern}`);
    return parseInt(m![1]!.replace(/,/g, ""), 10);
  }

  it("drops the record from every figure a page states about pricing changes", async () => {
    const registry = [
      ...COUNTS_THE_RECORD,
      {
        route: monthRoute,
        figure: "the Total Changes card on the month the record took effect in",
        pattern: /class="stat-value">(\d[\d,]*)<\/div><div class="stat-label">Total Changes/,
      },
    ];
    for (const { route, figure: name, pattern } of registry) {
      const where = `${route} — ${name}`;
      const before = figure(await body(inForcePort, route), pattern, where);
      const after = figure(await body(resolvedPort, route), pattern, where);
      assertPopulationFloor(before, 1, `changes counted by ${where}`);
      assert.strictEqual(after, before - 1, `${where} still counts a record we no longer stand behind`);
    }
    assertPopulationFloor(registry.length, 6, "figures declared as counting a change record");
  });

  it("leaves a figure alone when the record is outside the population it counts", async () => {
    const outside = [
      { route: "/state-of-free-tiers", pattern: /(\d[\d,]*) positive<\/strong>/ },
      { route: "/", pattern: /(\d[\d,]*) positive<\/span>/ },
      { route: "/q1-2026-developer-pricing-report", pattern: /(\d[\d,]*) negative changes vs/ },
    ];
    for (const { route, pattern } of outside) {
      const before = figure(await body(inForcePort, route), pattern, route);
      const after = figure(await body(resolvedPort, route), pattern, route);
      assertPopulationFloor(before, 1, `changes counted by ${route}`);
      assert.strictEqual(after, before, `${route} moved a figure the record is not counted in`);
    }
  });

  it("moves the month series a chart bins the record into", async () => {
    const month = subject.date.slice(0, 7);
    const countIn = (page: string) => {
      const tag = page.match(new RegExp(`<[a-z]+[^>]*data-series="effective"[^>]*data-month="${month}"[^>]*>`));
      assert.ok(tag, `no effective bar for ${month}`);
      return parseInt(tag![0].match(/data-count="(\d+)"/)![1]!, 10);
    };
    for (const route of ["/state-of-free-tiers", "/free-tier-risk"]) {
      const before = countIn(await body(inForcePort, route));
      const after = countIn(await body(resolvedPort, route));
      assertPopulationFloor(before, 1, `changes ${route} bins into ${month}`);
      assert.strictEqual(after, before - 1, `${route} kept the record in ${month}`);
    }
  });

  it("moves the category total a trends index states", async () => {
    const totalOf = (page: string) =>
      [...visibleText(page).matchAll(/(\d+) changes?\b/g)].reduce((sum, m) => sum + parseInt(m[1]!, 10), 0);
    const before = totalOf(await body(inForcePort, "/trends"));
    const after = totalOf(await body(resolvedPort, "/trends"));
    assertPopulationFloor(before, 100, "changes the trends index attributes to a category");
    assert.strictEqual(after, before - 1);
  });

  it("keeps the record in the log with the tag saying it is no longer in force", async () => {
    for (const route of ["/pricing-changes", "/changes"]) {
      const page = await body(resolvedPort, route);
      const marker = resolutionTag({ state: "retracted", date: today() } as never);
      assert.ok(page.includes(subject.vendor), `${route} dropped ${subject.vendor} from the log`);
      assert.ok(page.includes(marker), `${route} renders no retraction tag`);
    }
  });

  it("leaves no resolved record under a heading that calls it a cut", async () => {
    const page = await body(inForcePort, "/state-of-free-tiers");
    const squeeze = sectionText(page, "Who&rsquo;s Cutting Back", /<h2/);
    assertPopulationFloor(squeeze.length, 500, "characters under the heading naming vendors that cut back");
    for (const record of storedChanges().filter(isNoLongerInForce)) {
      assert.ok(
        !squeeze.includes(resolutionTag(record.resolution as never)),
        `a record we no longer stand behind is filed under vendors cutting back: ${record.vendor}`
      );
    }
  });
});

describe("the population a page counts", () => {
  const servers: ChildProcess[] = [];
  let tmp = "";
  let port = 0;

  before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "change-resolution-population-"));
    const p = path.join(tmp, "stored.json");
    writeFileSync(p, JSON.stringify({ changes: storedChanges() }));
    const a = await startServer(p);
    servers.push(a.proc);
    port = a.port;
  });

  after(() => {
    for (const proc of servers) proc.kill();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("is every record we hold less the ones carrying a resolution", async () => {
    const stored = storedChanges();
    const resolved = stored.filter((c) => c.resolution);
    assertPopulationFloor(resolved.length, 5, "records carrying a resolution");

    const page = visibleText(await (await fetch(`http://localhost:${port}/state-of-free-tiers`)).text());
    const stated = page.match(/(\d[\d,]*) pricing changes tracked across/);
    assert.ok(stated, "the report states no tracked-change total");
    assert.strictEqual(
      parseInt(stated![1]!.replace(/,/g, ""), 10),
      recordsStillInForce(stored as never[]).length,
      "the report counts a population other than the records still in force"
    );
    assert.strictEqual(recordsStillInForce(stored as never[]).length, stored.length - resolved.length);
  });

  it("states a ratio the figures beside it support", async () => {
    const page = visibleText(await (await fetch(`http://localhost:${port}/state-of-free-tiers`)).text());
    const stated = page.match(
      /(\d[\d,]*) negative pricing changes vs (\d[\d,]*) positive — free tier removals and restrictions outpace expansions ([\d.]+):(\d)/
    );
    assert.ok(stated, `the report states no ratio: ${page.slice(0, 200)}`);
    const negative = parseInt(stated![1]!.replace(/,/g, ""), 10);
    const positive = parseInt(stated![2]!.replace(/,/g, ""), 10);
    assertPopulationFloor(negative, 50, "negative changes the report counts");
    assert.strictEqual(`${stated![3]}:${stated![4]}`, directionRatioLabel(negative, positive));
  });
});

describe("the rule deciding whether a record counts", () => {
  it("is read from the one module that defines it", () => {
    const offenders: string[] = [];
    const owners = ["change-resolution.ts", "removal-durability.ts"];
    for (const file of ["serve.ts", "data.ts", "vendor-verdict.ts", "change-lineup.ts", "superseded-description.ts"]) {
      const source = readFileSync(path.join(REPO, "src", file), "utf8");
      for (const line of source.split("\n")) {
        if (!/\bresolution\b/.test(line)) continue;
        if (/from "\.\/change-resolution\.js"/.test(line)) continue;
        if (/resolution\?:|ChangeResolution|resolution: /.test(line)) continue;
        if (/\.resolution\b/.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    assert.deepStrictEqual(offenders, [], "a builder decides on a resolution without the shared predicate");
    for (const owner of owners) {
      assert.ok(readFileSync(path.join(REPO, "src", owner), "utf8").includes("resolution"));
    }
  });
});

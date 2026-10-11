import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const BEFORE_THE_WEEK = "2026-10-11T12:00:00Z";
const THE_WEEK_S_FIRST_DAY = "2026-10-19T00:30:00Z";
const INSIDE_THE_WEEK_BEFORE_EITHER_DATE = "2026-10-20T12:00:00Z";
const ON_THE_FIRST_DATE = "2026-10-22T12:00:00Z";
const AFTER_BOTH_DATES = "2026-10-25T12:00:00Z";

const SHUTDOWN_WEEK = "/digest/2026-w43";
const ONE_SHUTDOWN_WEEK = "/digest/2026-w42";
const MIXED_WEEK = "/digest/2026-w45";
const PAST_WEEK = "/digest/2026-w40";

function shutdown(vendor: string, date: string, impact: string) {
  return {
    vendor,
    change_type: "product_deprecated",
    date,
    date_source: "vendor_page",
    summary: `${vendor} keeps running until ${date}, when its vendor shuts it down.`,
    previous_state: `${vendor} could be used.`,
    current_state: `The vendor lists ${date} as the shutdown date.`,
    impact,
    source_url: `https://example.com/${vendor.toLowerCase().replace(/\W+/g, "-")}`,
    category: "AI / ML",
    alternatives: [],
    recorded_date: "2026-10-01",
    listing_effect: "none",
  };
}

const CHANGE_LOG = {
  changes: [
    shutdown("Shutdown Model One", "2026-10-22", "low"),
    shutdown("Shutdown Model Two", "2026-10-23", "medium"),
    shutdown("Shutdown Model Three", "2026-10-14", "low"),
    shutdown("Shutdown Model Four", "2026-10-01", "low"),
    shutdown("Shutdown Model Five", "2026-11-03", "low"),
    {
      ...shutdown("Reduced Limits Vendor", "2026-11-04", "medium"),
      change_type: "limits_reduced",
      summary: "Reduced Limits Vendor lowers its free request limit on 2026-11-04.",
    },
  ],
};

function startServer(env: Record<string, string>): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", ["--import", path.join(REPO, "scripts", "shifted-clock.mjs"), path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 30000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ proc, base: `http://localhost:${match[1]}` });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function servingAt(changesPath: string, instant: string): Record<string, string> {
  return { AGENTDEALS_CHANGES_PATH: changesPath, AGENTDEALS_CLOCK_SHIFT_MS: String(Date.parse(instant) - Date.now()) };
}

interface DigestPage {
  weekStart: string;
  metaDescription: string;
  lineUnderTheHeading: string;
  typeCounts: string[];
  entries: { badge: string; vendor: string; date: string }[];
}

function readDigest(html: string): DigestPage {
  return {
    weekStart: html.match(/"datePublished":"(\d{4}-\d{2}-\d{2})"/)?.[1] ?? "",
    metaDescription: html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "",
    lineUnderTheHeading: html.match(/<p class="page-meta">([^<]*)<\/p>/)?.[1] ?? "",
    typeCounts: [...html.matchAll(/<div class="stat-pill"><span[^>]*><\/span> <strong>(\d+)<\/strong> ([^<]+)<\/div>/g)].map(([, n, label]) => `${n} ${label}`),
    entries: [...html.matchAll(/<span class="change-badge"[^>]*>([^<]*)<\/span>\s*<span class="change-vendor">([^<]*)<\/span>\s*<span class="change-date">effective (\d{4}-\d{2}-\d{2})<\/span>/g)]
      .map(([, badge, vendor, date]) => ({ badge, vendor, date }))
      .sort((a, b) => a.vendor.localeCompare(b.vendor)),
  };
}

const pages = new Map<string, Map<string, DigestPage>>();
const weeksServedToday = new Map<string, DigestPage>();
let today = "";
const servers: ChildProcess[] = [];
let scratch = "";

before(async () => {
  scratch = mkdtempSync(path.join(tmpdir(), "digest-scheduled-"));
  const changesPath = path.join(scratch, "deal_changes.json");
  writeFileSync(changesPath, JSON.stringify(CHANGE_LOG, null, 2));
  for (const instant of [BEFORE_THE_WEEK, THE_WEEK_S_FIRST_DAY, INSIDE_THE_WEEK_BEFORE_EITHER_DATE, ON_THE_FIRST_DATE, AFTER_BOTH_DATES]) {
    const { proc, base } = await startServer(servingAt(changesPath, instant));
    servers.push(proc);
    const served = new Map<string, DigestPage>();
    for (const route of [SHUTDOWN_WEEK, ONE_SHUTDOWN_WEEK, MIXED_WEEK, PAST_WEEK]) {
      const res = await fetch(base + route);
      assert.strictEqual(res.status, 200, `${route} at ${instant}`);
      served.set(route, readDigest(await res.text()));
    }
    pages.set(instant, served);
  }
  const { proc, base } = await startServer({});
  servers.push(proc);
  today = new Date().toISOString().slice(0, 10);
  const archive = await (await fetch(`${base}/digest/archive`)).text();
  for (const [route] of archive.matchAll(/\/digest\/\d{4}-w\d{2}/g)) {
    if (weeksServedToday.has(route)) continue;
    const res = await fetch(base + route);
    assert.strictEqual(res.status, 200, route);
    weeksServedToday.set(route, readDigest(await res.text()));
  }
});

after(() => {
  for (const proc of servers) proc.kill();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const page = (instant: string, route: string) => pages.get(instant)!.get(route)!;

describe("a digest week that has not started", () => {
  it("says the week has not started, how many changes are scheduled, and that each service still works until its date", () => {
    assert.strictEqual(
      page(BEFORE_THE_WEEK, SHUTDOWN_WEEK).lineUnderTheHeading,
      "Week 43, 2026 has not started. 2 changes are scheduled; each service below still works until its date.",
    );
  });

  it("says the same of a single scheduled change in the singular", () => {
    assert.strictEqual(
      page(BEFORE_THE_WEEK, ONE_SHUTDOWN_WEEK).lineUnderTheHeading,
      "Week 42, 2026 has not started. 1 change is scheduled; the service below still works until its date.",
    );
  });

  it("describes its changes as scheduled, not tracked, in the meta description", () => {
    assert.ok(
      page(BEFORE_THE_WEEK, SHUTDOWN_WEEK).metaDescription.startsWith("2 pricing changes scheduled for developer tools during October 19–25, 2026."),
      page(BEFORE_THE_WEEK, SHUTDOWN_WEEK).metaDescription,
    );
  });

  it("counts its shutdowns as scheduled when every change in it is one", () => {
    assert.deepStrictEqual(page(BEFORE_THE_WEEK, SHUTDOWN_WEEK).typeCounts, ["2 scheduled"]);
    assert.deepStrictEqual(page(BEFORE_THE_WEEK, ONE_SHUTDOWN_WEEK).typeCounts, ["1 scheduled"]);
  });

  it("counts a change that is not a shutdown under its own type beside the scheduled shutdowns", () => {
    assert.deepStrictEqual([...page(BEFORE_THE_WEEK, MIXED_WEEK).typeCounts].sort(), ["1 reduced", "1 scheduled"]);
    assert.strictEqual(
      page(BEFORE_THE_WEEK, MIXED_WEEK).lineUnderTheHeading,
      "Week 45, 2026 has not started. 2 changes are scheduled; each service below still works until its date.",
    );
  });

  it("labels each shutdown a scheduled shutdown and leaves other change types as they are", () => {
    assert.deepStrictEqual(page(BEFORE_THE_WEEK, SHUTDOWN_WEEK).entries.map((e) => e.badge), ["scheduled shutdown", "scheduled shutdown"]);
    assert.deepStrictEqual(
      page(BEFORE_THE_WEEK, MIXED_WEEK).entries.map((e) => `${e.vendor}: ${e.badge}`),
      ["Reduced Limits Vendor: reduced", "Shutdown Model Five: scheduled shutdown"],
    );
  });
});

describe("a digest week that has started", () => {
  it("labels and counts a shutdown dated after the day served as scheduled, and keeps the week's own line and meta description from its first day", () => {
    for (const instant of [THE_WEEK_S_FIRST_DAY, INSIDE_THE_WEEK_BEFORE_EITHER_DATE]) {
      const week = page(instant, SHUTDOWN_WEEK);
      assert.deepStrictEqual(week.entries.map((e) => e.badge), ["scheduled shutdown", "scheduled shutdown"], instant);
      assert.strictEqual(week.lineUnderTheHeading, "2 changes tracked in week 43, 2026.", instant);
      assert.deepStrictEqual(week.typeCounts, ["2 scheduled"], instant);
      assert.ok(week.metaDescription.startsWith("2 pricing changes tracked for developer tools during October 19–25, 2026."), `${instant}: ${week.metaDescription}`);
    }
  });

  it("labels and counts a shutdown dated the day served as deprecated, beside one still scheduled", () => {
    assert.deepStrictEqual(
      page(ON_THE_FIRST_DATE, SHUTDOWN_WEEK).entries.map((e) => `${e.date}: ${e.badge}`),
      ["2026-10-22: deprecated", "2026-10-23: scheduled shutdown"],
    );
    assert.deepStrictEqual([...page(ON_THE_FIRST_DATE, SHUTDOWN_WEEK).typeCounts].sort(), ["1 deprecated", "1 scheduled"]);
  });

  it("labels every shutdown deprecated once its date has passed", () => {
    const week = page(AFTER_BOTH_DATES, SHUTDOWN_WEEK);
    assert.deepStrictEqual(week.entries.map((e) => e.badge), ["deprecated", "deprecated"]);
    assert.strictEqual(week.lineUnderTheHeading, "2 changes tracked in week 43, 2026.");
    assert.deepStrictEqual(week.typeCounts, ["2 deprecated"]);
  });

  it("leaves a past week's shutdown labelled deprecated on every day", () => {
    for (const instant of [BEFORE_THE_WEEK, AFTER_BOTH_DATES]) {
      const week = page(instant, PAST_WEEK);
      assert.deepStrictEqual(week.entries.map((e) => e.badge), ["deprecated"], instant);
      assert.strictEqual(week.lineUnderTheHeading, "1 change tracked in week 40, 2026.", instant);
    }
  });
});

describe("every digest week served today", () => {
  it("labels a shutdown a scheduled shutdown while its date is after the day served, and deprecated from its date", () => {
    assert.ok(weeksServedToday.size > 0, "the archive links no digest week");
    const mislabelled = [...weeksServedToday].flatMap(([route, week]) => week.entries
      .filter((e) => (e.badge === "scheduled shutdown" && e.date <= today) || (e.badge === "deprecated" && e.date > today))
      .map((e) => `${route} ${e.vendor} ${e.date}: ${e.badge}`));
    assert.deepStrictEqual(mislabelled, []);
  });

  it("counts as scheduled exactly the changes it labels scheduled shutdowns", () => {
    const disagreeing = [...weeksServedToday]
      .map(([route, week]) => {
        const labelled = week.entries.filter((e) => e.badge === "scheduled shutdown").length;
        const counted = Number(week.typeCounts.find((c) => c.endsWith(" scheduled"))?.split(" ")[0] ?? 0);
        return { route, labelled, counted };
      })
      .filter(({ labelled, counted }) => labelled !== counted)
      .map(({ route, labelled, counted }) => `${route}: ${labelled} labelled, ${counted} counted`);
    assert.deepStrictEqual(disagreeing, []);
  });

  it("says a week has not started exactly while its first day is after the day served", () => {
    const wrong = [...weeksServedToday]
      .filter(([, week]) => week.entries.length > 0)
      .filter(([, week]) => week.lineUnderTheHeading.includes(" has not started. ") !== (week.weekStart > today))
      .map(([route, week]) => `${route} (from ${week.weekStart}): ${week.lineUnderTheHeading}`);
    assert.deepStrictEqual(wrong, []);
  });
});

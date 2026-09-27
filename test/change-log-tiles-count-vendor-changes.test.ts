import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY_MS = 86_400_000;
const TODAY = new Date().toISOString().slice(0, 10);
const dayFromToday = (days: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

const liveLog = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8"));

function record(vendor: string, change_type: string, date: string, summary: string) {
  return {
    vendor,
    change_type,
    date,
    summary,
    previous_state: "The terms before the change",
    current_state: "The terms after the change",
    impact: "medium",
    source_url: "https://example.com/pricing",
    category: "APIs",
    alternatives: [],
    recorded_date: dayFromToday(-1),
    date_source: "hand_written",
  };
}

const VENDOR_CHANGES = [
  record("Tile Fixture Vendor", "free_tier_removed", TODAY, "Tile Fixture Vendor ended its free tier"),
  record("Tile Fixture Vendor", "limits_reduced", dayFromToday(10), "Tile Fixture Vendor lowers its free request allowance"),
];

const OUR_CORRECTIONS = [
  record("Tile Fixture Vendor", "record_corrected", TODAY, "Data correction - Tile Fixture Vendor's record carried the wrong allowance"),
  record("Tile Fixture Vendor", "record_corrected", dayFromToday(10), "Data correction - Tile Fixture Vendor's record carried the wrong date"),
];

const scratch = mkdtempSync(path.join(tmpdir(), "change-log-tiles-"));
function changeLogWith(name: string, added: object[]): string {
  const file = path.join(scratch, `${name}.json`);
  writeFileSync(file, JSON.stringify({ ...liveLog, changes: [...liveLog.changes, ...added] }));
  return file;
}

function startServer(changesPath?: string): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: "0",
        BASE_URL: "http://localhost",
        TZ: "UTC",
        ...(changesPath ? { AGENTDEALS_CHANGES_PATH: changesPath } : {}),
      },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

type Tiles = Record<string, number>;

function tilesOf(html: string): Tiles {
  const tiles: Tiles = {};
  for (const [, value, label] of html.matchAll(/<div class="stat-value">([^<]*)<\/div>\s*<div class="stat-label">([\s\S]*?)<\/div>/g)) {
    tiles[label.replace(/<[^>]+>/g, "").trim()] = Number(value.replace(/,/g, ""));
  }
  const tracked = /([\d,]+) changes tracked in \d{4}/.exec(html);
  if (tracked) tiles["changes tracked this year"] = Number(tracked[1].replace(/,/g, ""));
  return tiles;
}

const servers: ChildProcess[] = [];
const pages = new Map<string, string>();

before(async () => {
  const runs = [
    ["live", undefined],
    ["vendor", changeLogWith("vendor", VENDOR_CHANGES)],
    ["vendor+ours", changeLogWith("vendor-and-ours", [...VENDOR_CHANGES, ...OUR_CORRECTIONS])],
  ] as const;
  for (const [name, changesPath] of runs) {
    const { child, port } = await startServer(changesPath);
    servers.push(child);
    for (const route of ["/changes", "/pricing-changes"]) {
      const res = await fetch(`http://localhost:${port}${route}`);
      assert.strictEqual(res.status, 200, `${route} on the ${name} log`);
      pages.set(`${name} ${route}`, await res.text());
    }
  }
});

after(() => {
  for (const child of servers) child.kill();
  rmSync(scratch, { recursive: true, force: true });
});

const MARKET_TILES: Record<string, string[]> = {
  "/changes": ["Last 30 Days", "Upcoming", "Removals"],
  "/pricing-changes": ["This Month", "Upcoming", "Removals", "changes tracked this year"],
};

describe("the change log's activity counts read the changes the vendor made", () => {
  for (const [route, labels] of Object.entries(MARKET_TILES)) {
    it(`counts none of our own corrections in ${route}'s ${labels.join(", ")}`, () => {
      const withoutOurs = tilesOf(pages.get(`vendor ${route}`)!);
      const withOurs = tilesOf(pages.get(`vendor+ours ${route}`)!);
      for (const label of labels) {
        assert.ok(Number.isFinite(withoutOurs[label]), `${route} publishes no "${label}" figure`);
        assert.strictEqual(withOurs[label], withoutOurs[label], `${route}'s ${label} counts a correction of our own`);
      }
    });
  }

  it("counts a vendor change dated today and one dated ahead as upcoming, and the removal among them as a removal", () => {
    for (const route of Object.keys(MARKET_TILES)) {
      const live = tilesOf(pages.get(`live ${route}`)!);
      const withVendorChanges = tilesOf(pages.get(`vendor ${route}`)!);
      assert.strictEqual(withVendorChanges.Upcoming, live.Upcoming + 2, `${route}'s Upcoming`);
      assert.strictEqual(withVendorChanges.Removals, live.Removals + 1, `${route}'s Removals`);
    }
    const live = tilesOf(pages.get("live /changes")!);
    const withVendorChanges = tilesOf(pages.get("vendor /changes")!);
    assert.strictEqual(withVendorChanges["Last 30 Days"], live["Last 30 Days"] + 2, "/changes' Last 30 Days");
  });

  it("keeps listing our corrections in the log itself", () => {
    for (const route of Object.keys(MARKET_TILES)) {
      const html = pages.get(`vendor+ours ${route}`)!;
      for (const correction of OUR_CORRECTIONS) {
        assert.ok(html.includes(correction.summary.replace(/'/g, "&#39;")) || html.includes(correction.summary), `${route} drops "${correction.summary}" from the log`);
      }
    }
  });
});

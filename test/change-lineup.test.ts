import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DealChange } from "../src/types.ts";
import {
  changeTimelineDate,
  statedPrices,
  statesAPlanLineup,
  supersededLineups,
  supersessionNote,
} from "../dist/change-lineup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const stored: DealChange[] = JSON.parse(
  readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")
).changes;

const claim = (over: Partial<DealChange> = {}) => ({
  vendor: "Cursor",
  date: "2026-04-13",
  summary: "Pro $20/mo, Ultra $200/mo",
  current_state: "Two paid tiers",
  ...over,
});

describe("a change record states a plan lineup when it names more than one price", () => {
  it("reads prices out of the summary and the current state together", () => {
    assert.deepStrictEqual(
      [...statedPrices({ vendor: "X", date: "2026-01-01", summary: "Pro $20/mo", current_state: "Teams $40/seat" })],
      ["$20", "$40"]
    );
  });

  it("counts one price as a single fact, not a lineup", () => {
    assert.strictEqual(statesAPlanLineup(claim({ summary: "Pro rose to $20/mo", current_state: "Pro $20/mo" })), false);
  });

  it("counts the same price named twice as one price", () => {
    assert.strictEqual(statesAPlanLineup(claim({ summary: "Pro $20/mo", current_state: "Pro is $20/mo" })), false);
  });

  it("counts two distinct prices as a lineup", () => {
    assert.strictEqual(statesAPlanLineup(claim()), true);
  });

  it("reads a price with a decimal and a price with a comma", () => {
    assert.deepStrictEqual(
      [...statedPrices({ vendor: "X", date: "2026-01-01", summary: "$19.99/mo and $1,400/year" })],
      ["$19.99", "$1,400"]
    );
  });

  it("states no lineup when it names no price at all", () => {
    assert.strictEqual(
      statesAPlanLineup({ vendor: "AWS", date: "2026-09-30", summary: "App Mesh: end of support September 30" }),
      false
    );
  });

  it("states no vendor lineup when it is a correction to our own record", () => {
    assert.strictEqual(statesAPlanLineup(claim({ change_type: "record_corrected" })), false);
    assert.strictEqual(statesAPlanLineup(claim({ change_type: "pricing_restructured" })), true);
  });
});

describe("the newest lineup a vendor has is the one that reads as current", () => {
  it("supersedes an older lineup with the newest one", () => {
    const older = claim({ date: "2026-03-19" });
    const newest = claim({ date: "2026-04-13" });
    const superseded = supersededLineups([newest, older]);
    assert.strictEqual(superseded.get(older), newest);
    assert.strictEqual(superseded.has(newest), false);
  });

  it("does not let one vendor's lineup supersede another's", () => {
    const cursor = claim({ vendor: "Cursor", date: "2026-04-13" });
    const windsurf = claim({ vendor: "Windsurf", date: "2026-03-19" });
    assert.strictEqual(supersededLineups([cursor, windsurf]).size, 0);
  });

  it("leaves a record that states no lineup alone, however old", () => {
    const single = claim({ date: "2026-01-01", summary: "Pro rose to $20/mo", current_state: "Pro $20/mo" });
    const newest = claim({ date: "2026-04-13" });
    const superseded = supersededLineups([newest, single]);
    assert.strictEqual(superseded.has(single), false);
  });

  it("supersedes nothing when two lineups carry the same date", () => {
    const first = claim({ date: "2026-04-01", summary: "VPS-1 $7.60/mo, VPS-4 $43.50/mo" });
    const second = claim({ date: "2026-04-01", summary: "IPv4 up $1/mo, deployments up $2/mo" });
    assert.strictEqual(supersededLineups([first, second]).size, 0);
  });

  it("names the record that replaced it, not the fact that one exists", () => {
    assert.strictEqual(
      supersessionNote({ vendor: "Windsurf", date: "2026-04-13" }, () => "Apr 13, 2026"),
      "Superseded by our Apr 13, 2026 record"
    );
  });

  it("dates the replacement the way the timeline beside it is dated", () => {
    assert.strictEqual(
      supersessionNote({ vendor: "Windsurf", date: "2026-04-13" }, changeTimelineDate),
      `Superseded by our ${changeTimelineDate("2026-04-13")} record`
    );
  });
});

describe("the stored change log, read through the rule", () => {
  const superseded = supersededLineups(stored);
  const find = (vendor: string, date: string) =>
    stored.find(c => c.vendor === vendor && c.date === date && statesAPlanLineup(c))!;

  it("supersedes every marked record with a strictly later one for the same vendor", () => {
    for (const [older, newest] of superseded) {
      assert.strictEqual(older.vendor, newest.vendor);
      assert.ok(newest.date > older.date, `${older.vendor} ${older.date} is replaced by ${newest.date}`);
    }
  });

  it("marks Windsurf's March lineup, which the April one restates", () => {
    const march = find("Windsurf", "2026-03-19");
    assert.strictEqual(superseded.get(march)?.date, "2026-04-13");
  });

  it("leaves the retracted Cursor Hobby record out of the lineup population entirely", () => {
    const april = stored.find(c => c.vendor === "Cursor" && c.date === "2026-04-13")!;
    assert.ok(april.summary.includes("Hobby ($10/mo)"));
    assert.strictEqual(april.resolution?.state, "retracted");
    assert.strictEqual(statesAPlanLineup(april), false);
    assert.strictEqual(superseded.has(april), false);
  });

  it("leaves our newest read of a vendor standing when a correction follows it", () => {
    const newest = find("Cursor", "2026-08-28");
    assert.strictEqual(superseded.has(newest), false);
    const correction = stored.find(c => c.vendor === "Cursor" && c.change_type === "record_corrected")!;
    assert.ok(correction.date > newest.date, "the correction is the later record");
  });

  it("leaves AWS's deprecations standing, each naming a different product", () => {
    const aws = stored.filter(c => c.vendor === "AWS" && c.change_type === "product_deprecated");
    assert.ok(aws.length >= 5, `AWS deprecation records: ${aws.length}`);
    for (const record of aws) assert.strictEqual(superseded.has(record), false);
  });

  it("is not vacuous — the log holds vendors with more than one lineup", () => {
    assert.ok(superseded.size >= 3, `superseded records: ${superseded.size}`);
  });
});

let serverPort = 0;
let proc: ChildProcess | null = null;

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 20000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { serverPort = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const get = async (p: string) => (await fetch(`http://localhost:${serverPort}${p}`)).text();

const rowsOf = (body: string) => body.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? [];
const isChangeRow = (row: string) => /<td[^>]*>[A-Z][a-z]{2} \d{1,2}, \d{4}<\/td>/.test(row);
const withoutChangeRows = (body: string) =>
  rowsOf(body).filter(isChangeRow).reduce((rest, row) => rest.replace(row, ""), body);
const AI_CODING_PAGES = ["/ai-coding-pricing-2026", "/ai-coding-tools-pricing"];

describe("the AI coding pages state one lineup per vendor", () => {
  before(async () => { proc = await startServer(); });
  after(() => { proc?.kill(); });

  it("leaves at most one change row per vendor reading as a current lineup", async () => {
    for (const page of AI_CODING_PAGES) {
      const body = await get(page);
      const unmarked = new Map<string, number>();
      for (const row of rowsOf(body).filter(isChangeRow)) {
        const vendor = row.match(/<td style="font-weight:600">([^<]+)<\/td>/)?.[1];
        if (!vendor) continue;
        const summary = row.match(/<td style="font-size:.85rem">([\s\S]*?)<\/td>/)?.[1] ?? "";
        const prices = new Set(summary.replace(/<div[\s\S]*$/, "").match(/\$\d[\d,]*(?:\.\d+)?/g) ?? []);
        if (prices.size < 2) continue;
        if (row.includes("superseded-note")) continue;
        unmarked.set(vendor, (unmarked.get(vendor) ?? 0) + 1);
      }
      const competing = [...unmarked].filter(([, n]) => n > 1).map(([vendor, n]) => `${page} ${vendor} ${n}`);
      assert.deepStrictEqual(competing, []);
    }
  });

  it("marks Windsurf's superseded row with the date of the record that replaced it", async () => {
    for (const page of AI_CODING_PAGES) {
      const body = await get(page);
      const march = rowsOf(body).find(r => r.includes("Windsurf") && r.includes("Ultimate $40/mo"));
      assert.ok(march, `${page} renders the March Windsurf record`);
      assert.ok(
        march!.includes(`Superseded by our ${changeTimelineDate("2026-04-13")} record`),
        `${page} names the record that replaced the March one`
      );
    }
  });

  it("prices no Cursor plan named Hobby outside the change log recording that we did", async () => {
    for (const page of AI_CODING_PAGES) {
      const currentFacts = withoutChangeRows(await get(page));
      const priced = [...currentFacts.matchAll(/Hobby(?: tier| plan)?(?: at)? \(?\$\d[\d,]*/g)].map(m => m[0]);
      assert.deepStrictEqual(priced, [], `${page} prices a Hobby plan`);
    }
  });

  it("offers no free tier for a vendor whose record we have retired", async () => {
    const offers: Array<{ vendor: string; tier: string }> = JSON.parse(
      readFileSync(path.join(REPO, "data", "index.json"), "utf-8")
    ).offers;
    const retired = new Set(offers.filter(o => o.tier === "Retired").map(o => o.vendor));
    assert.ok(retired.size > 0, "the catalogue holds a retired record to test against");

    for (const page of AI_CODING_PAGES) {
      const body = await get(page);
      const freeTierTables = (body.match(/<table[\s\S]*?<\/table>/g) ?? []).filter(t => /<th[^>]*>Free Tier<\/th>/.test(t));
      assert.ok(freeTierTables.length > 0, `${page} renders a table with a free-tier column`);
      const promising = freeTierTables
        .flatMap(rowsOf)
        .filter(row => [...retired].some(vendor => row.includes(`>${vendor}<`)))
        .filter(row => !/No free tier/.test(row));
      assert.deepStrictEqual(promising, [], `${page} states a free tier for a retired record`);
    }
  });

  it("keeps Copilot's completion figure off every Cursor fact row", async () => {
    for (const page of AI_CODING_PAGES) {
      const body = await get(page);
      const carrying = rowsOf(body)
        .filter(row => !isChangeRow(row))
        .filter(row => row.includes(">Cursor<") && /2,?000 completions/.test(row));
      assert.deepStrictEqual(carrying, [], `${page} states Cursor's free tier in completions`);
    }
  });
});

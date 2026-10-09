import { describe, it, before } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const PAGE = "/database-free-tier-comparison-2026";
const OPENING = "No longer free for new users:";
const STORAGE_SENTENCE = "Turso and Cloudflare D1 give 5 GB of free storage each.";

type ChangeRecord = Record<string, unknown>;

const shippedChanges: ChangeRecord[] = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8")).changes;
const withoutRemovals = shippedChanges.filter(c => c.change_type !== "free_tier_removed");

function removal(vendor: string, date: string, category: string, extra: ChangeRecord = {}): ChangeRecord {
  return {
    vendor,
    change_type: "free_tier_removed",
    date,
    summary: `${vendor} removed its free plan on ${date}.`,
    previous_state: "A free plan is offered.",
    current_state: "No free plan is offered.",
    impact: "high",
    source_url: "https://example.com/pricing",
    category,
    alternatives: [],
    recorded_date: date,
    date_source: "hand_written",
    ...extra,
  };
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function storageContextBox(html: string): string {
  const boxes = [...html.matchAll(/<div class="context-box">([\s\S]*?)<\/div>/g)].map(m => text(m[1]!));
  const box = boxes.find(b => b.includes(STORAGE_SENTENCE));
  assert.ok(box, `${PAGE} should keep the context box holding "${STORAGE_SENTENCE}"`);
  return box;
}

async function servePage(changes: ChangeRecord[]): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "database-no-longer-free-"));
  const changesPath = path.join(dir, "changes.json");
  writeFileSync(changesPath, JSON.stringify({ changes }));
  const proc: ChildProcess = spawn("node", [path.join(REPO, "dist", "serve.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: "0",
      BASE_URL: "http://localhost",
      TZ: "UTC",
      AGENTDEALS_CHANGES_PATH: changesPath,
    },
  });
  try {
    const base = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      proc.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(`http://localhost:${match[1]}`);
        }
      });
      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    const response = await fetch(`${base}${PAGE}`);
    assert.strictEqual(response.status, 200, `${PAGE} answered ${response.status}`);
    return await response.text();
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

function keyValueRowCells(html: string, provider: string): string[] {
  const section = html.slice(html.indexOf('<h2 id="kv">'), html.indexOf('<h2 id="vector">'));
  for (const row of section.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => text(m[1]!));
    if (cells[0]?.startsWith(provider)) return cells;
  }
  assert.fail(`${PAGE}'s Key-Value table holds no ${provider} row`);
}

describe(`${PAGE} names the databases it covers whose free tier our records say was removed`, () => {
  let page = "";
  let withRemovals = "";
  let withNone = "";

  before(async () => {
    page = await servePage([
      ...withoutRemovals,
      removal("Turso", "2025-05-01", "Databases"),
      removal("Turso", "2026-08-20", "Databases"),
      removal("Nile", "2026-07-02", "Databases"),
      removal("CockroachDB", "2026-09-15", "Databases"),
      removal("Convex", "2026-09-01", "Databases", {
        resolution: { state: "retracted", date: "2026-09-05", detail: "Retracted 2026-09-05: the free plan did not end." },
      }),
      removal("Typeform", "2026-09-30", "Forms"),
    ]);
    withRemovals = storageContextBox(page);
    withNone = storageContextBox(await servePage(withoutRemovals));
  });

  it("dates Momento's ended allowance in the Key-Value table to 2025, as our records do", () => {
    const [, , storage, operations] = keyValueRowCells(page, "Momento");
    assert.strictEqual(storage, "No free tier. Ended November 2025.");
    assert.strictEqual(operations, "First 5M operations/month free until November 2025.");
    assert.doesNotMatch(`${storage} ${operations}`, /2026/);
  });

  it("opens the storage paragraph with every covered database's removal, newest first, by month and year", () => {
    assert.ok(
      withRemovals.startsWith(`${OPENING} CockroachDB (September 2026), Turso (August 2026), Nile (July 2026). ${STORAGE_SENTENCE}`),
      withRemovals,
    );
  });

  it("names a database once however many removal records it has", () => {
    assert.strictEqual(withRemovals.split("Turso (").length - 1, 1, withRemovals);
  });

  it("leaves out a retracted removal and a vendor the page does not cover", () => {
    assert.doesNotMatch(withRemovals, /Convex \(/);
    assert.doesNotMatch(withRemovals, /Typeform/);
  });

  it("prints no sentence at all when no covered database has a removal on record", () => {
    assert.ok(!withNone.includes(OPENING), withNone);
    assert.ok(withNone.startsWith(STORAGE_SENTENCE), withNone);
  });
});

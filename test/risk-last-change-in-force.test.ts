import { describe, it, before } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const { riskEntries, changeLogNamesFor, lastChangeShown } = await import("../dist/risk-scorecard.js");
const { loadDealChanges } = await import("../dist/data.js");

type Change = {
  vendor: string;
  date: string;
  change_type: string;
  summary: string;
  current_state: string;
  resolution?: { state: string; date: string; detail?: string };
};

const shipped: Change[] = loadDealChanges();
const today = new Date().toISOString().slice(0, 10);

function record(date: string, change_type: string, resolution?: Change["resolution"]): Change {
  return { vendor: "Example Vendor", date, change_type, summary: `${change_type} on ${date}`, current_state: "", ...(resolution ? { resolution } : {}) };
}

const entry = {
  vendor: "Example Vendor",
  risk: "medium",
  category: "Hosting",
  reasoning: "",
  graded: "2026-03-26",
  lastChange: "2026-02-01",
  changeType: "limits_reduced",
};

const retracted = { state: "retracted", date: "2026-09-01", detail: "Retracted 2026-09-01: no change." };
const reversed = { state: "reversed", date: "2026-08-01", detail: "Reversed 2026-08-01." };

describe("the Last Change a scorecard row prints is a record still in force", () => {
  it("prints the typed date while the record behind it stands", () => {
    const changes = [record("2026-02-01", "limits_reduced"), record("2026-05-01", "pricing_restructured")];
    assert.strictEqual(lastChangeShown(entry, changes, "2026-10-10"), "2026-02-01");
  });

  it("falls back to the newest record the vendor made once the typed one is retracted", () => {
    const changes = [
      record("2026-02-01", "limits_reduced", retracted),
      record("2025-12-01", "free_tier_removed"),
      record("2026-05-01", "pricing_restructured"),
    ];
    assert.strictEqual(lastChangeShown(entry, changes, "2026-10-10"), "2026-05-01");
  });

  it("skips a correction to our own record, a reversed record and a record dated after the day served", () => {
    const changes = [
      record("2026-02-01", "limits_reduced", retracted),
      record("2026-04-01", "pricing_restructured"),
      record("2026-06-01", "limits_reduced", reversed),
      record("2026-09-28", "record_corrected"),
      record("2026-11-30", "product_deprecated"),
    ];
    assert.strictEqual(lastChangeShown(entry, changes, "2026-10-10"), "2026-04-01");
    assert.strictEqual(lastChangeShown(entry, changes, "2026-11-30"), "2026-11-30");
  });

  it("prints nothing when no record the vendor made is left in force", () => {
    const changes = [record("2026-02-01", "limits_reduced", retracted), record("2026-09-28", "record_corrected")];
    assert.strictEqual(lastChangeShown(entry, changes, "2026-10-10"), null);
  });

  it("keeps the typed date when only a record of another type on that day is retracted", () => {
    const changes = [record("2026-02-01", "pricing_restructured", retracted)];
    assert.strictEqual(lastChangeShown(entry, changes, "2026-10-10"), "2026-02-01");
  });

  it("keeps the typed date while one of two records behind it stands", () => {
    const changes = [
      record("2026-02-01", "limits_reduced", retracted),
      record("2026-02-01", "limits_reduced"),
      record("2026-05-01", "pricing_restructured"),
    ];
    assert.strictEqual(lastChangeShown(entry, changes, "2026-10-10"), "2026-02-01");
  });

  it("prints nothing for a row with no typed date", () => {
    const { lastChange, changeType, ...untyped } = entry;
    assert.ok(lastChange && changeType);
    assert.strictEqual(lastChangeShown(untyped, [record("2026-05-01", "pricing_restructured")], "2026-10-10"), null);
  });
});

function riskRows(html: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const match of html.matchAll(/<tr>\s*<td style="font-weight:600">([\s\S]*?)<\/tr>/g)) {
    const cells = ("<td>" + match[1]).split("</td>").map(c => c.replace(/<[^>]+>/g, " ").replace(/&mdash;/g, "—").replace(/\s+/g, " ").trim());
    const lastChange = cells[4];
    if (lastChange === undefined) continue;
    const name = cells[0];
    rows.set(name, [...(rows.get(name) ?? []), lastChange]);
  }
  return rows;
}

type Entry = (typeof riskEntries)[number];

function newestInForce(e: Entry, changes: readonly Change[]): string | null {
  const names = new Set(changeLogNamesFor(e));
  const dates = changes
    .filter(c => names.has(c.vendor) && !c.resolution && c.change_type !== "record_corrected" && c.date <= today)
    .map(c => c.date)
    .sort();
  return dates[dates.length - 1] ?? null;
}

function typedRecordsOf(e: Entry, changes: readonly Change[]): Change[] {
  if (!e.lastChange) return [];
  const names = new Set(changeLogNamesFor(e));
  return changes.filter(c => names.has(c.vendor) && c.date === e.lastChange && (!e.changeType || c.change_type === e.changeType));
}

function typedRecordsAllRetracted(e: Entry, changes: readonly Change[]): boolean {
  const typed = typedRecordsOf(e, changes);
  return typed.length > 0 && typed.every(c => c.resolution);
}

function expectedLastChange(e: Entry, changes: readonly Change[]): string | null {
  if (!e.lastChange) return null;
  return typedRecordsAllRetracted(e, changes) ? newestInForce(e, changes) : e.lastChange;
}

async function servedRiskPage(changesPath?: string): Promise<string> {
  const proc: ChildProcess = spawn("node", [path.join(REPO, "dist", "serve.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: "0",
      BASE_URL: "http://localhost",
      TZ: "UTC",
      ...(changesPath ? { AGENTDEALS_CHANGES_PATH: changesPath } : {}),
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
    const response = await fetch(`${base}/free-tier-risk`);
    assert.strictEqual(response.status, 200);
    return await response.text();
  } finally {
    proc.kill();
  }
}

describe("retracting the record behind a row's Last Change in a copy of the change log", () => {
  const raw = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")) as { changes: Change[] };
  const standing = riskEntries.filter(e => {
    const typed = typedRecordsOf(e, shipped);
    return typed.length > 0 && typed.every(c => !c.resolution);
  });
  const withoutTyped = (e: Entry) => shipped.filter(c => !typedRecordsOf(e, shipped).includes(c));
  const fallsBack = standing.find(e => {
    const fallback = newestInForce(e, withoutTyped(e));
    return fallback !== null && fallback !== e.lastChange;
  });
  const emptied = standing.find(e =>
    e !== fallsBack && !changeLogNamesFor(e).some((n: string) => fallsBack && changeLogNamesFor(fallsBack).includes(n)));

  let page = "";
  let expectedFallback: string | null = null;

  before(async () => {
    assert.ok(fallsBack, "no row's typed record stands beside another record in force, so a fallback proves nothing");
    assert.ok(emptied, "no second row's typed record stands, so the empty case proves nothing");
    expectedFallback = newestInForce(fallsBack!, withoutTyped(fallsBack!));

    const typedSummaries = new Set(typedRecordsOf(fallsBack!, shipped).map(c => `${c.date}|${c.change_type}|${c.summary}`));
    const emptiedSummaries = new Set(shipped.filter(c => new Set(changeLogNamesFor(emptied!)).has(c.vendor)).map(c => `${c.date}|${c.change_type}|${c.summary}`));
    let retractedHere = 0;
    const copy = raw.changes.map(c => {
      const key = `${c.date}|${c.change_type}|${c.summary}`;
      if (c.resolution || (!typedSummaries.has(key) && !emptiedSummaries.has(key))) return c;
      retractedHere++;
      return { ...c, resolution: { state: "retracted", date: today, detail: `Retracted ${today}: no change.` } };
    });
    assert.ok(retractedHere >= 2, `only ${retractedHere} record(s) were retracted in the copy`);

    const dir = mkdtempSync(path.join(tmpdir(), "risk-last-change-"));
    try {
      const changesPath = path.join(dir, "changes.json");
      writeFileSync(changesPath, JSON.stringify({ changes: copy }));
      page = await servedRiskPage(changesPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints the newest record still in force in place of the retracted date", () => {
    const cells = riskRows(page).get(fallsBack!.vendor) ?? [];
    assert.ok(cells.length > 0, `${fallsBack!.vendor} has no row on the page`);
    for (const cell of cells) {
      assert.ok(!cell.includes(fallsBack!.lastChange!), `${fallsBack!.vendor} still prints ${fallsBack!.lastChange} after that record was retracted: "${cell}"`);
      assert.ok(cell.startsWith(expectedFallback!), `${fallsBack!.vendor} prints "${cell}", not the newest record in force (${expectedFallback})`);
      assert.strictEqual(
        cell.includes("before the grade"),
        expectedFallback! < fallsBack!.graded,
        `${fallsBack!.vendor}'s "before the grade" note does not follow the date it prints: "${cell}"`,
      );
    }
  });

  it("prints a dash when every record the vendor made is retracted", () => {
    const cells = riskRows(page).get(emptied!.vendor) ?? [];
    assert.ok(cells.length > 0, `${emptied!.vendor} has no row on the page`);
    for (const cell of cells) assert.strictEqual(cell, "—", `${emptied!.vendor} prints "${cell}" with no record left in force`);
  });
});

describe("the shipped scorecard", () => {
  let page = "";

  before(async () => {
    page = await servedRiskPage();
  });

  it("prints no row's typed date once the record behind it is no longer in force", () => {
    const rows = riskRows(page);
    for (const e of riskEntries) {
      const cells = rows.get(e.vendor) ?? [];
      assert.ok(cells.length > 0, `${e.vendor} has no row on the page`);
      const expected = expectedLastChange(e, shipped) ?? "—";
      for (const cell of cells) assert.ok(cell.startsWith(expected), `${e.vendor} prints "${cell}", not ${expected}`);
      if (typedRecordsAllRetracted(e, shipped)) {
        for (const cell of cells) assert.ok(!cell.includes(e.lastChange!), `${e.vendor} prints ${e.lastChange}, whose record is no longer in force`);
      }
    }
  });

  it("names only the AI coding tools launches it still stands behind, on the page and in its structured data", () => {
    const answer = "Yes — AI coding tools (GitHub Copilot Free, Windsurf launch) and cloud infrastructure";
    const blocks = [...page.matchAll(/<script type="application\/ld\+json">([^]*?)<\/script>/g)].map(m => JSON.parse(m[1]));
    const faq = blocks.find(b => b["@type"] === "FAQPage");
    assert.ok(faq, "the page ships no FAQ structured data");
    const expanding = faq.mainEntity.find((q: any) => q.name === "Are there any categories where free tiers are expanding?");
    assert.ok(expanding, "the structured data no longer asks where free tiers are expanding");
    assert.ok(expanding.acceptedAnswer.text.startsWith(answer), `the structured answer reads: ${expanding.acceptedAnswer.text}`);
    const visible = page.replace(/<script[\s\S]*?<\/script>/g, "");
    assert.ok(visible.includes(answer), "the visible FAQ answer does not read as the structured one");
    const card = visible.match(/<h3>AI Coding Tools<\/h3>\s*<p class="diff-desc">([^<]*)<\/p>/);
    assert.ok(card, "the page has no AI Coding Tools card");
    assert.ok(
      card[1].startsWith("GitHub Copilot Free (2K completions) and the Windsurf launch. "),
      `the AI Coding Tools card reads: ${card[1]}`,
    );
  });
});

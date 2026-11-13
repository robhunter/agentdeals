import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = [
  ["Calendar fixture December end", "2026-12-31"],
  ["Calendar fixture January start", "2027-01-01"],
  ["Calendar fixture November end", "2026-11-30"],
  ["Calendar fixture December start", "2026-12-01"],
  ["Calendar fixture January end", "2027-01-31"],
  ["Calendar fixture March start", "2027-03-01"],
  ["Calendar fixture same service", "2026-12-02"],
  ["Calendar fixture same service", "2026-12-03"],
  ["Calendar fixture <End & start>", "2026-12-04"],
  ["Calendar fixture today", "2026-11-09"],
  ["Calendar fixture completed", "2026-11-08"],
].map(([vendor, date]) => ({
  vendor, date, recorded_date: "2026-01-01", change_type: "product_deprecated",
  previous_state: "Available", current_state: "Shut down", summary: `${vendor} service shutdown.`,
  source_url: "https://example.com/shutdown", impact: "high", category: "Developer Tools",
  alternatives: [], date_source: "hand_written", listing_effect: "ends",
}));
fixtures.push(
  { ...fixtures[0], vendor: "Calendar fixture shared vendor", date: "2026-12-11", summary: "The first product retires." },
  { ...fixtures[0], vendor: "Calendar fixture shared vendor", date: "2026-12-11", summary: "The second product retires." },
);

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function monthSection(html: string): string {
  return html.match(/<section aria-labelledby="by-month">[\s\S]*?<\/section>/)?.[0] ?? "";
}

function monthLines(html: string): { month: string; text: string; entries: string[] }[] {
  return [...monthSection(html).matchAll(/<li data-month="([^"]+)">([\s\S]*?)<\/li>/g)].map(match => ({
    month: match[1], text: textOf(match[2]),
    entries: [...match[2].matchAll(/<span class="shutdown-month-entry">([\s\S]*?)<\/span>/g)].map(entry => textOf(entry[1])),
  }));
}

describe("shutdowns by calendar month", () => {
  let scratch: string;
  const children: ChildProcess[] = [];
  let page: string;
  let westPage: string;
  let completedPage: string;

  async function serve(day: string, zone: string): Promise<string> {
    const child = spawn("node", ["--import", path.join(REPO, "scripts/shifted-clock.mjs"), path.join(REPO, "dist/serve.js")], {
      cwd: REPO, stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: zone, AGENTDEALS_REFERRAL_HEALTH: "off",
        AGENTDEALS_CLOCK_SHIFT_MS: String(Date.parse(day) - Date.now()),
        AGENTDEALS_INDEX_PATH: path.join(scratch, "index.json"), AGENTDEALS_CHANGES_PATH: path.join(scratch, "changes.json") },
    });
    children.push(child);
    const port = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
      let stderr = "";
      child.stderr!.on("data", chunk => {
        stderr += chunk.toString();
        const match = stderr.match(/running on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
      child.on("error", error => { clearTimeout(timeout); reject(error); });
      child.on("exit", code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    });
    const response = await fetch(`http://localhost:${port}/shutdowns`, { redirect: "error" });
    assert.equal(response.status, 200);
    return response.text();
  }

  before(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "shutdown-month-list-"));
    writeFileSync(path.join(scratch, "index.json"), JSON.stringify({ offers: [] }));
    writeFileSync(path.join(scratch, "changes.json"), JSON.stringify({ changes: fixtures }));
    page = await serve("2026-11-09T12:00:00Z", "UTC");
    westPage = await serve("2026-11-09T12:00:00Z", "America/Los_Angeles");
    completedPage = await serve("2030-01-01T12:00:00Z", "UTC");
  });

  after(async () => {
    await Promise.all(children.map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    })));
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("places By month before Imminent", () => {
    assert.match(monthSection(page), /<h2 id="by-month">By month<\/h2>/);
    assert.ok(page.indexOf('id="by-month"') < page.indexOf('id="imminent"'));
  });

  it("keeps month-end and next-month dates on their own UTC month lines", () => {
    const lines = monthLines(page);
    for (const fixture of fixtures.filter(entry => entry.date >= "2026-11-09")) {
      const label = new Date(fixture.date).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
      const value = `${fixture.vendor} (${label})`;
      const found = lines.filter(line => line.entries.includes(value));
      assert.equal(found.length, 1, value);
      assert.equal(found[0].month, fixture.date.slice(0, 7), value);
    }
  });

  it("orders nonempty months and their entries by deadline", () => {
    const lines = monthLines(page);
    assert.deepEqual(lines.map(line => line.month), [...lines.map(line => line.month)].sort());
    assert.ok(!lines.some(line => line.month === "2027-02"));
    for (const line of lines) {
      assert.ok(line.entries.length > 0, line.month);
      const label = new Date(`${line.month}-01`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
      assert.ok(line.text.startsWith(`${label}:`), line.text);
      const days = line.entries.map(entry => Number(entry.match(/\((?:\w+) (\d+)\)$/)?.[1]));
      assert.ok(days.every(Number.isFinite), line.text);
      assert.deepEqual(days, [...days].sort((a, b) => a - b), line.text);
    }
  });

  it("names every upcoming card once and excludes completed cards", () => {
    const cards: string[] = [];
    let section = "";
    for (const piece of page.split(/(?=<h2 id=")|(?=<div class="shutdown-card")/)) {
      section = piece.match(/^<h2 id="([^"]+)"/)?.[1] ?? section;
      if (!piece.startsWith('<div class="shutdown-card"') || section === "completed") continue;
      const title = textOf(piece.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? "");
      const date = piece.match(/<span class="deadline-icon">[^<]*<\/span>\s*<span>([^<]+)<\/span>/)?.[1] ?? "";
      cards.push(`${title} (${date.replace(/, \d{4}$/, "")})`);
    }
    const entries = monthLines(page).flatMap(line => line.entries);
    assert.ok(cards.length > fixtures.length);
    assert.deepEqual([...entries].sort(), [...cards].sort());
    assert.equal(entries.length, Number(page.match(/(\d+) active shutdowns/)?.[1]));
    assert.ok(!monthSection(page).includes("Calendar fixture completed"));
    assert.equal(entries.filter(entry => entry.startsWith("Calendar fixture same service")).length, 2);
  });

  it("keeps different records on one vendor page and date as separate month entries", () => {
    const december = monthLines(page).find(line => line.month === "2026-12")!;
    assert.equal(december.entries.filter(entry => entry === "Calendar fixture shared vendor (December 11)").length, 2);
  });

  it("escapes service titles as text", () => {
    assert.ok(monthSection(page).includes("Calendar fixture &lt;End &amp; start&gt;"));
    assert.ok(!monthSection(page).includes("Calendar fixture <End"));
  });

  it("keeps month labels and dates in UTC west of Greenwich", () => {
    assert.equal(monthSection(westPage), monthSection(page));
  });

  it("omits the list when every entry has completed", () => {
    assert.match(completedPage, /0 active shutdowns/);
    assert.equal(monthSection(completedPage), "");
    assert.match(completedPage, /id="completed"/);
  });
});

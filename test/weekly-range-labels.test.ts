import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const weeks = [
  { start: "2026-09-21", end: "2026-09-27", slug: "2026-w39", ago: 14, label: "September 21–27, 2026" },
  { start: "2026-10-26", end: "2026-11-01", slug: "2026-w44", ago: 9, label: "October 26–November 1, 2026" },
  { start: "2026-12-28", end: "2027-01-03", slug: "2026-w53", ago: 0, label: "December 28, 2026–January 3, 2027" },
  { start: "2026-09-28", end: "2026-10-04", slug: "2026-w40", ago: 13, label: "September 28–October 4, 2026" },
  { start: "2026-07-27", end: "2026-08-02", slug: "2026-w31", ago: 22, label: "July 27–August 2, 2026" },
];
let scratch = "";
let proc: ChildProcess | undefined;
let base = "";

before(async () => {
  scratch = mkdtempSync(path.join(tmpdir(), "weekly-range-labels-"));
  writeFileSync(path.join(scratch, "index.json"), JSON.stringify({ offers: [] }));
  writeFileSync(path.join(scratch, "changes.json"), JSON.stringify({ changes: weeks.map(week => ({
    vendor: `First Read ${week.slug}`, date: week.start, recorded_date: week.start,
    date_source: "discovered", change_type: "limits_reduced", category: "Cloud Hosting", impact: "medium",
    summary: "The page states lower limits without an effective date.",
    previous_state: "Earlier limits", current_state: "Lower limits", source_url: "https://example.com/pricing",
    alternatives: [], listing_effect: "none",
  })) }));
  proc = spawn("node", ["--import", path.join(REPO, "scripts/shifted-clock.mjs"), path.join(REPO, "dist/serve.js")], {
    cwd: REPO, stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "America/Los_Angeles",
      AGENTDEALS_CLOCK_SHIFT_MS: String(Date.parse("2027-01-01T12:00:00Z") - Date.now()),
      AGENTDEALS_INDEX_PATH: path.join(scratch, "index.json"),
      AGENTDEALS_CHANGES_PATH: path.join(scratch, "changes.json"),
    },
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { proc!.kill("SIGKILL"); reject(new Error("Server startup timeout")); }, 30000);
    let stderr = "";
    proc!.stderr!.on("data", chunk => {
      stderr += String(chunk);
      const port = stderr.match(/running on http:\/\/localhost:(\d+)/)?.[1];
      if (port) { base = `http://localhost:${port}`; clearTimeout(timeout); resolve(); }
    });
    proc!.once("error", error => { clearTimeout(timeout); reject(error); });
    proc!.once("exit", code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${stderr}`)); });
  });
});

after(async () => {
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = once(proc, "exit");
    proc.kill("SIGKILL");
    await exited;
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

async function read(route: string): Promise<string> {
  const response = await fetch(base + route, { redirect: "error" });
  assert.equal(response.status, 200, route);
  return response.text();
}

function noteMatches(body: string, label: string) {
  assert.ok(body.includes(`1 change recorded during ${label} has no known effective date`), body);
}

describe("calendar ranges on weekly digest routes", () => {
  for (const week of weeks) {
    it(`${week.start}: JSON preserves the window and labels both embedded formats`, async () => {
      const digest = JSON.parse(await read(`/api/digest/weekly?weeks_ago=${week.ago}`));
      assert.equal(digest.week_of, week.start);
      assert.equal(digest.week_ending, week.end);
      assert.equal(digest.discovered_in_week, 1);
      assert.equal(digest.changes_in_week, 0);
      assert.ok(digest.digest_markdown.includes(`*${week.label}*`));
      assert.ok(digest.digest_html.includes(`<em>${week.label}</em>`));
      noteMatches(digest.discovery_note, week.label);
    });
    for (const format of ["markdown", "html"]) {
      it(`${week.start}: ${format} uses the complete range in heading and note`, async () => {
        const body = await read(`/api/digest/weekly?weeks_ago=${week.ago}&format=${format}`);
        assert.ok(body.includes(format === "markdown" ? `*${week.label}*` : `<em>${week.label}</em>`));
        noteMatches(body, week.label);
      });
    }
    it(`${week.start}: the weekly page labels its heading and discovery notes alike`, async () => {
      const page = await read(`/this-week?week=${week.ago}`);
      assert.ok(page.includes(`<span class="tw-date">${week.label}</span>`));
      noteMatches(page, week.label);
      assert.equal(page.split(`during ${week.label}`).length - 1, 2);
    });
    it(`${week.start}: the archive page and index share the full range`, async () => {
      const page = await read(`/digest/${week.slug}`);
      assert.ok(page.includes(`<h1>Pricing Changes: ${week.label}</h1>`));
      noteMatches(page, week.label);
      const archive = await read("/digest/archive");
      assert.ok(archive.includes(`href="/digest/${week.slug}"><span class="week-label">${week.label}</span>`));
    });
  }
});

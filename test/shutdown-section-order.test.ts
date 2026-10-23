import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = [
  ["Completed older", "2026-10-20"],
  ["Completed beta", "2026-10-22"],
  ["Completed alpha", "2026-10-22"],
  ["Imminent second", "2026-11-10"],
  ["Imminent first", "2026-10-23"],
  ["Upcoming second", "2027-01-10"],
  ["Upcoming first", "2026-12-10"],
  ["Later second", "2027-05-01"],
  ["Later first", "2027-04-01"],
].map(([name, date]) => ({
  vendor: `Order fixture ${name}`, date, recorded_date: "2026-01-01",
  change_type: "product_deprecated", previous_state: "Available", current_state: "Shut down",
  summary: `${name} service shutdown.`, source_url: `https://example.com/${name.replaceAll(" ", "-")}`,
  impact: "high", category: "Developer Tools", alternatives: [], date_source: "hand_written", listing_effect: "ends",
}));

type Card = { section: string; title: string; deadline: number };

describe("shutdown sections order deadlines on October 23, 2026", () => {
  let scratch: string;
  let child: ChildProcess | undefined;
  const cards: Card[] = [];

  before(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "shutdown-section-order-"));
    writeFileSync(path.join(scratch, "index.json"), JSON.stringify({ offers: [] }));
    writeFileSync(path.join(scratch, "changes.json"), JSON.stringify({ changes: fixtures }));
    child = spawn("node", ["--import", path.join(REPO, "scripts/shifted-clock.mjs"), path.join(REPO, "dist/serve.js")], {
      cwd: REPO, stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_REFERRAL_HEALTH: "off",
        AGENTDEALS_CLOCK_SHIFT_MS: String(Date.parse("2026-10-23T12:00:00Z") - Date.now()),
        AGENTDEALS_INDEX_PATH: path.join(scratch, "index.json"), AGENTDEALS_CHANGES_PATH: path.join(scratch, "changes.json") },
    });
    const port = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => { child?.kill(); reject(new Error("Server startup timeout")); }, 30000);
      let stderr = "";
      child!.stderr!.on("data", chunk => {
        stderr += chunk.toString();
        const match = stderr.match(/running on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
      child!.on("error", error => { clearTimeout(timeout); reject(error); });
      child!.on("exit", code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    });
    const response = await fetch(`http://localhost:${port}/shutdowns`, { redirect: "error" });
    assert.equal(response.status, 200);
    const html = await response.text();
    let section = "";
    for (const piece of html.split(/(?=<h2 id=")|(?=<div class="shutdown-card")/)) {
      const heading = piece.match(/^<h2 id="([^"]+)"/);
      if (heading) section = heading[1];
      if (!piece.startsWith('<div class="shutdown-card"')) continue;
      const title = piece.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1].replace(/<[^>]*>/g, "").trim() ?? "";
      const date = piece.match(/<span class="deadline-icon">[^<]*<\/span>\s*<span>([^<]+)<\/span>/)?.[1] ?? "";
      cards.push({ section, title, deadline: Date.parse(`${date} UTC`) });
    }
  });

  after(() => {
    child?.kill();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("retains every fixture once in its deadline group", () => {
    for (const fixture of fixtures) {
      const found = cards.filter(card => card.title === fixture.vendor);
      assert.equal(found.length, 1, fixture.vendor);
      assert.equal(found[0].section, fixture.vendor.split(" ")[2].toLowerCase(), fixture.vendor);
      assert.equal(found[0].deadline, Date.parse(fixture.date), fixture.vendor);
    }
  });

  it("lists completed shutdowns newest first", () => {
    const deadlines = cards.filter(card => card.section === "completed").map(card => card.deadline);
    assert.ok(deadlines.length >= 3 && deadlines.every(Number.isFinite));
    for (let i = 1; i < deadlines.length; i++) assert.ok(deadlines[i - 1] >= deadlines[i]);
  });

  it("keeps equal completed deadlines in their original relative order", () => {
    assert.deepEqual(cards.filter(card => card.section === "completed" && card.deadline === Date.parse("2026-10-22"))
      .map(card => card.title), ["Order fixture Completed beta", "Order fixture Completed alpha"]);
  });

  for (const section of ["imminent", "upcoming", "later"]) {
    it(`lists ${section} shutdowns soonest first`, () => {
      const deadlines = cards.filter(card => card.section === section).map(card => card.deadline);
      assert.ok(deadlines.length >= 2 && deadlines.every(Number.isFinite));
      for (let i = 1; i < deadlines.length; i++) assert.ok(deadlines[i - 1] <= deadlines[i]);
    });
  }
});

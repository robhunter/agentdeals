import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const DAY_MS = 86_400_000;
const dayFromToday = (days: number): string => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

const A_DEPRECATION = {
  vendor: "OpenAI",
  change_type: "product_deprecated",
  previous_state: "The product is available.",
  current_state: "The product is retired.",
  impact: "high",
  source_url: "https://platform.openai.com/docs/deprecations",
  category: "AI/ML",
  alternatives: [],
  recorded_date: dayFromToday(-60),
  date_source: "hand_written",
};

const UPCOMING_ELSEWHERE = { ...A_DEPRECATION, date: dayFromToday(2), listing_effect: "none", summary: "Widgets Beta shuts down; the listed API is unaffected." };
const UPCOMING_ON_THE_LISTING = { ...A_DEPRECATION, date: dayFromToday(3), listing_effect: "ends", summary: "The listed API shuts down." };
const RECENT_ELSEWHERE = { ...A_DEPRECATION, date: dayFromToday(-1), listing_effect: "none", summary: "Gadgets Preview was retired; the listed API is unaffected." };
const RECENT_ON_THE_LISTING = { ...A_DEPRECATION, date: dayFromToday(-2), listing_effect: "narrows", summary: "The listed API lost its free quota when its old model retired." };

function sectionOf(html: string, id: string): string {
  const start = html.indexOf(`<div class="section" id="${id}">`);
  if (start < 0) return "";
  const end = html.indexOf('class="see-all-link"', start);
  return html.slice(start, end < 0 ? undefined : end);
}

describe("#1302 the home page's change lists hold a deprecation only when it touches the listing", () => {
  let dir = "";
  let proc: ChildProcess | null = null;
  let home = "";

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "home-deprecations-"));
    const changesPath = path.join(dir, "changes.json");
    writeFileSync(changesPath, JSON.stringify({ changes: [UPCOMING_ELSEWHERE, UPCOMING_ON_THE_LISTING, RECENT_ELSEWHERE, RECENT_ON_THE_LISTING] }));
    proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_CHANGES_PATH: changesPath },
    });
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 60000);
      proc!.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timeout); resolve(parseInt(m[1], 10)); }
      });
      proc!.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
    home = await fetch(`http://localhost:${port}/`).then((r) => r.text());
  });

  after(() => {
    proc?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("lists an upcoming deprecation that ends the listing under Changing Soon, and not one about another product", () => {
    const soon = sectionOf(home, "changing-soon");
    assert.ok(soon.includes(UPCOMING_ON_THE_LISTING.summary), "Changing Soon leaves out a deprecation that ends the listing");
    assert.ok(!soon.includes(UPCOMING_ELSEWHERE.summary), "Changing Soon counts down to a product the listing does not state");
  });

  it("lists a recent deprecation that narrowed the listing under Recent pricing changes, and not one about another product", () => {
    const recent = sectionOf(home, "recent-changes");
    assert.ok(recent.includes(RECENT_ON_THE_LISTING.summary), "Recent pricing changes leaves out a deprecation that narrowed the listing");
    assert.ok(!recent.includes(RECENT_ELSEWHERE.summary), "Recent pricing changes lists a product the listing does not state");
  });
});

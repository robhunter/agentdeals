import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { A_DATED_SECTION_MARKER } from "../dist/change-dates.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const changes = [
  change("Past Removal", "2026-10-19", "free_tier_removed"),
  change("First Shutdown", "2026-10-22", "product_deprecated"),
  change("Second Shutdown", "2026-10-23", "product_deprecated"),
  change("Reduced Limits", "2026-10-23", "limits_reduced"),
  change("New Free Plan", "2026-10-24", "new_free_tier"),
  change("New Name", "2026-10-24", "rebranded"),
  { ...change("Undated Discovery", "2026-10-23", "product_deprecated"), date_source: "hand_written", recorded_date: "2026-10-23" },
  change("Next Week", "2026-10-27", "product_deprecated"),
];
const days = ["2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];
const pages = new Map<string, string>();
const archives = new Map<string, string>();
let manyEntries = "";
let previousWeek = "";
let scratch = "";

function change(vendor: string, date: string, change_type: string) {
  return { vendor, date, change_type, date_source: "vendor_page", recorded_date: "2026-10-01", category: "AI / ML", impact: "medium", summary: `${vendor} changes its offer on ${date}.`, previous_state: "Earlier terms", current_state: "Changed terms", source_url: "https://example.com/pricing", alternatives: [], listing_effect: "none" };
}

async function serve(day: string, records: typeof changes): Promise<{ proc: ChildProcess; base: string }> {
  const changesPath = path.join(scratch, `changes-${day}-${records.length}.json`);
  writeFileSync(changesPath, JSON.stringify({ changes: records }));
  return new Promise((resolve, reject) => {
    const proc = spawn("node", ["--import", path.join(REPO, "scripts/shifted-clock.mjs"), path.join(REPO, "dist/serve.js")], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, TZ: "UTC", PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_CHANGES_PATH: changesPath, AGENTDEALS_INDEX_PATH: path.join(scratch, "index.json"), AGENTDEALS_CLOCK_SHIFT_MS: String(Date.parse(day + "T00:01:00Z") - Date.now()) },
    });
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("Server startup timeout")); }, 30000);
    proc.stderr!.on("data", data => {
      const port = String(data).match(/running on http:\/\/localhost:(\d+)/)?.[1];
      if (port) { clearTimeout(timeout); resolve({ proc, base: `http://localhost:${port}` }); }
    });
    proc.once("error", error => { clearTimeout(timeout); reject(error); });
    proc.once("exit", code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
  });
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
function sections(html: string) {
  return [...html.matchAll(/<section class="tw-section">([\s\S]*?)<\/section>/g)].map(([, body]) => ({
    heading: text(body!.match(/<h2>([\s\S]*?)<\/h2>/)![1]!),
    cards: [...body!.matchAll(/<div class="tw-change"[\s\S]*?<div class="change-header">([\s\S]*?)<\/div>\s*<div class="change-summary">([\s\S]*?)<\/div>/g)].map(([, header, summary]) => ({
      badge: text(header!.match(/<span class="change-badge"[^>]*>([^<]+)<\/span>/)![1]!),
      vendor: text(header!.match(/class="change-vendor"[^>]*>([^<]+)</)![1]!),
      date: text(header!).match(/effective (\d{4}-\d{2}-\d{2})/)?.[1],
      summary,
    })),
  }));
}
const pills = (html: string) => [...html.matchAll(/<span class="tw-pill"[^>]*>([\s\S]*?)<\/span>/g)].map(([, body]) => text(body!));

before(async () => {
  scratch = mkdtempSync(path.join(tmpdir(), "this-week-scheduled-"));
  writeFileSync(path.join(scratch, "index.json"), JSON.stringify({ offers: [] }));
  for (const day of days) {
    const { proc, base } = await serve(day, changes);
    try {
      pages.set(day, await (await fetch(base + "/this-week")).text());
      archives.set(day, await (await fetch(base + "/digest/2026-w43")).text());
    } finally { proc.kill(); }
  }
  const history = await serve("2026-10-26", changes);
  try { previousWeek = await (await fetch(history.base + "/this-week?week=1")).text(); }
  finally { history.proc.kill(); }
  const many = await serve(days[0]!, Array.from({ length: 51 }, (_, i) => change(`Scheduled Service ${i}`, "2026-10-23", "product_deprecated")));
  try { manyEntries = await (await fetch(many.base + "/this-week")).text(); }
  finally { many.proc.kill(); }
});
after(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

describe("scheduled events on the weekly page", () => {
  it("places every dated event today or later in its own section, across negative, positive and other types", () => {
    for (const day of days) {
      const groups = sections(pages.get(day)!);
      const expected = changes.filter(c => c.date >= day && c.date <= "2026-10-25" && c.date_source === "vendor_page").map(c => c.vendor).sort();
      const upcoming = groups.find(g => g.heading.startsWith("Scheduled this week"));
      assert.deepEqual((upcoming?.cards ?? []).map(c => c.vendor).sort(), expected, day);
      if (expected.length) assert.equal(upcoming!.heading, `Scheduled this week (${expected.length})`);
      assert.equal(groups.flatMap(g => g.cards).length, 6, day);
      assert.equal(new Set(groups.flatMap(g => g.cards).map(c => c.vendor)).size, 6, day);
    }
  });

  it("labels shutdowns and other scheduled changes with their effective dates, including the effective day", () => {
    for (const day of days) {
      const upcoming = sections(pages.get(day)!).find(g => g.heading.startsWith("Scheduled this week"));
      for (const card of upcoming?.cards ?? []) {
        const record = changes.find(c => c.vendor === card.vendor)!;
        assert.equal(card.date, record.date, `${day}: ${card.vendor}`);
        assert.equal(card.badge, record.change_type === "product_deprecated" ? "scheduled shutdown" : record.change_type === "new_free_tier" ? "scheduled new" : record.change_type === "limits_reduced" ? "scheduled reduced" : "scheduled rebranded");
      }
    }
  });

  it("returns passed changes to their original labels and sections", () => {
    const groups = sections(pages.get("2026-10-25")!);
    assert.deepEqual(groups.map(g => g.heading), ["Biggest Losses (4)", "Bright Spots (1)", "Other Notable Changes (1)"]);
    assert.deepEqual(groups.flatMap(g => g.cards).map(c => c.badge).sort(), ["deprecated", "deprecated", "new", "rebranded", "reduced", "removed"]);
    assert.deepEqual(sections(previousWeek), groups);
  });

  it("counts scheduled entries separately from passed deprecations and other types", () => {
    assert.deepEqual(pills(pages.get(days[0]!)!), ["5 scheduled", "1 free tier removed", "1 effective date unknown"]);
    assert.deepEqual(pills(pages.get("2026-10-23")!), ["4 scheduled", "1 free tier removed", "1 deprecated", "1 effective date unknown"]);
    assert.deepEqual(pills(pages.get("2026-10-25")!), ["1 free tier removed", "1 new free tier", "1 limit reduced", "2 deprecated", "1 effective date unknown"]);
  });

  it("uses the same scheduled headline in visible, metadata, structured and share text", () => {
    const html = pages.get(days[0]!)!;
    const expected = "6 developer tool pricing changes tracked this week. 5 scheduled for 2026-10-21 or later.";
    assert.ok(html.includes(`<p class="tw-headline">${expected}</p>`));
    assert.ok(html.includes(`<meta name="description" content="${expected}">`));
    assert.ok(html.includes(`<meta property="og:description" content="${expected}">`));
    assert.ok(html.includes(`"description":"${expected}"`));
    assert.ok(html.includes(encodeURIComponent(`This Week in Developer Pricing: ${expected}`)));
  });

  it("states the inclusive calendar rule and keeps the complete change-log destination", () => {
    const html = pages.get(days[0]!)!;
    const section = html;
    assert.ok(section.includes(A_DATED_SECTION_MARKER));
    assert.ok(section.includes("effective date on or after 2026-10-21"));
    assert.ok(section.includes("After that date they appear under the other sections for this week."));
    assert.ok(section.includes('href="/changes"'));
  });

  it("keeps undated discoveries apart and does not duplicate this week's events in Coming up", () => {
    const html = pages.get(days[0]!)!;
    const firstRead = html.match(/<section class="tw-section tw-first-read">([\s\S]*?)<\/section>/)![1]!;
    assert.ok(firstRead.includes("Undated Discovery"));
    assert.ok(!sections(html).flatMap(g => g.cards).some(c => c.vendor === "Undated Discovery"));
    const comingUp = html.slice(html.indexOf('class="tw-section tw-coming-up"'));
    assert.ok(comingUp.includes("Next Week"));
    for (const vendor of ["First Shutdown", "Second Shutdown", "Reduced Limits"]) assert.ok(!comingUp.includes(vendor), vendor);
  });

  it("keeps full-week summary counts when the cards are capped at fifty", () => {
    assert.equal(sections(manyEntries)[0]!.cards.length, 50);
    assert.deepEqual(pills(manyEntries), ["51 scheduled"]);
    assert.ok(manyEntries.includes("51 developer tool pricing changes tracked this week. 51 scheduled"));
  });

  it("preserves the archived digest's strict boundary on the effective date", () => {
    const archive = archives.get("2026-10-22")!;
    assert.match(archive, /change-badge[^>]*>deprecated<\/span>\s*<span class="change-vendor">First Shutdown<\/span>/);
    assert.match(archive, /change-badge[^>]*>scheduled shutdown<\/span>\s*<span class="change-vendor">Second Shutdown<\/span>/);
  });
});

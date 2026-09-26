import { describe, it } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const LOG: Record<string, unknown>[] = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8")).changes;
const CATALOGUE: { vendor: string; category: string }[] = JSON.parse(
  readFileSync(path.join(REPO, "data", "index.json"), "utf8"),
).offers;

function startServer(changesPath: string | null): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: "0",
        BASE_URL: "http://localhost:3000",
        ...(changesPath ? { AGENTDEALS_CHANGES_PATH: changesPath } : {}),
      },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 40000);
    proc.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timeout);
        resolve({ proc, base: `http://localhost:${m[1]}` });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function dayOffset(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function section(home: string, id: string, { required = true } = {}): string {
  const start = home.indexOf(`id="${id}"`);
  if (start < 0 && !required) return "";
  assert.ok(start >= 0, `the home page has no #${id} section`);
  const end = home.indexOf('class="see-all-link"', start);
  assert.ok(end > start, `the #${id} section has no closing link`);
  return home
    .slice(start, end)
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function badgesIn(html: string): string[] {
  return [...html.matchAll(/<span class="change-badge"[^>]*>([^<]*)<\/span>/g)].map(([, label]) => label);
}

function summariesOf(records: Record<string, unknown>[]): string[] {
  return records.map((record) => String(record.summary));
}

describe("the home page lists changes the vendors made", () => {
  it("puts a vendor's change on the home page and leaves out our own corrections and retractions", async () => {
    const [corrected, retracted, changed, retractedAhead, changingAhead] = CATALOGUE.slice(0, 5);
    const today = dayOffset(0);
    const tomorrow = dayOffset(1);
    const record = (offer: { vendor: string; category: string }, fields: Record<string, unknown>) => ({
      vendor: offer.vendor,
      category: offer.category,
      previous_state: "Before the change",
      current_state: "After the change",
      impact: "medium",
      source_url: "https://example.com/pricing",
      alternatives: [],
      recorded_date: today,
      date_source: "hand_written",
      ...fields,
    });
    const retraction = { state: "retracted", date: today, detail: `Retracted ${today}: the change did not happen.` };
    const ours = [
      record(corrected, { change_type: "record_corrected", date: today, summary: "Data correction - a record of ours had the wrong figure." }),
      record(retracted, { change_type: "limits_reduced", date: today, summary: "A reduction we recorded and later retracted.", resolution: retraction }),
      record(retractedAhead, { change_type: "free_tier_removed", date: tomorrow, summary: "A removal we dated ahead and later retracted.", resolution: retraction }),
    ];
    const theirs = [
      record(changed, { change_type: "limits_reduced", date: today, date_source: "vendor_page", summary: "The vendor halved its free allowance." }),
      record(changingAhead, { change_type: "free_tier_removed", date: tomorrow, date_source: "vendor_page", summary: "The vendor ends its free plan tomorrow." }),
    ];

    const dir = mkdtempSync(path.join(tmpdir(), "homepage-vendor-changes-"));
    const changesPath = path.join(dir, "deal_changes.json");
    writeFileSync(changesPath, JSON.stringify({ changes: [...ours, ...theirs, ...LOG] }));
    const { proc, base } = await startServer(changesPath);
    try {
      const home = await (await fetch(`${base}/`)).text();
      const recent = section(home, "recent-changes");
      const soon = section(home, "changing-soon");
      assert.ok(recent.includes(summariesOf(theirs)[0]), "the vendor's change today is missing from Recent pricing changes");
      assert.ok(soon.includes(summariesOf(theirs)[1]), "the vendor's change tomorrow is missing from Changing Soon");
      for (const summary of summariesOf(ours)) {
        assert.ok(!recent.includes(summary), `Recent pricing changes lists a record of our own: ${summary}`);
        assert.ok(!soon.includes(summary), `Changing Soon lists a record of our own: ${summary}`);
      }
      assert.deepStrictEqual(badgesIn(recent).filter((label) => label === "corrected"), []);
    } finally {
      proc.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shows none of our corrections or retracted records among the home page's changes today", async () => {
    const ours = LOG.filter(
      (c) => c.change_type === "record_corrected" || (c.resolution as { state?: string } | undefined)?.state === "retracted",
    );
    const { proc, base } = await startServer(null);
    try {
      const home = await (await fetch(`${base}/`)).text();
      const listed = section(home, "recent-changes") + section(home, "changing-soon", { required: false });
      assert.deepStrictEqual(badgesIn(listed).filter((label) => label === "corrected"), []);
      assert.deepStrictEqual(
        summariesOf(ours).filter((summary) => listed.includes(summary)),
        [],
        "the home page lists a correction or a retracted record as a vendor's change",
      );
    } finally {
      proc.kill();
    }
  });
});

describe("the home page lists only changes with a known effective date", () => {
  function cardsIn(recent: string): Array<{ vendor: string; label: string }> {
    return [...recent.matchAll(/class="rc-vendor"[^>]*>([^<]*)<\/a>\s*<span class="rc-date">([^<]*)<\/span>/g)].map(
      ([, vendor, label]) => ({ vendor, label }),
    );
  }

  function itemListIn(recent: string): { numberOfItems: number; itemListElement: Array<{ item: { headline: string } }> } {
    const json = recent.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(json, "the Recent pricing changes section carries no ItemList");
    return JSON.parse(json);
  }

  it("lists a change dated by the vendor's page today and leaves out one we only discovered today, though both are the newest in the log", async () => {
    const { ONLY_EFFECTIVE_DATES_LISTED, WHICH_DATE_WE_HOLD } = await import("../dist/change-dates.js");
    const [dated, discovered, ahead] = CATALOGUE.slice(0, 3);
    const today = dayOffset(0);
    const record = (offer: { vendor: string; category: string }, fields: Record<string, unknown>) => ({
      vendor: offer.vendor,
      category: offer.category,
      change_type: "limits_reduced",
      date: today,
      previous_state: "Before the change",
      current_state: "After the change",
      impact: "medium",
      source_url: "https://example.com/pricing",
      alternatives: [],
      recorded_date: today,
      ...fields,
    });
    const withADate = record(dated, { date_source: "vendor_page", summary: "The vendor's page dates this reduction today." });
    const withoutOne = record(discovered, { date_source: "discovered", summary: "A reduction we found today on a page that states no date." });
    const tomorrow = record(ahead, { date_source: "vendor_page", date: dayOffset(1), summary: "The vendor's page dates this reduction tomorrow." });

    const dir = mkdtempSync(path.join(tmpdir(), "homepage-effective-dates-"));
    const changesPath = path.join(dir, "deal_changes.json");
    writeFileSync(changesPath, JSON.stringify({ changes: [withoutOne, withADate, tomorrow, ...LOG] }));
    const { proc, base } = await startServer(changesPath);
    try {
      const home = await (await fetch(`${base}/`)).text();
      const recent = section(home, "recent-changes");
      assert.ok(recent.includes(withADate.summary), "a change the vendor's page dates today is missing from Recent pricing changes");
      assert.ok(!recent.includes(withoutOne.summary), "Recent pricing changes lists a change with no known effective date");
      assert.ok(recent.includes(ONLY_EFFECTIVE_DATES_LISTED), "Recent pricing changes does not say it lists only changes with a known effective date");
      assert.ok(!recent.includes(WHICH_DATE_WE_HOLD), "Recent pricing changes still says its dates include discovery dates");
      assert.ok(section(home, "changing-soon").includes(WHICH_DATE_WE_HOLD), "Changing Soon lost the sentence saying which date it holds");

      const itemList = itemListIn(recent);
      const headlines = itemList.itemListElement.map((entry) => entry.item.headline);
      assert.strictEqual(itemList.numberOfItems, cardsIn(recent).length, "the ItemList counts a different set from the cards");
      assert.ok(headlines.some((headline) => headline.startsWith(`${withADate.vendor}:`)), "the ItemList leaves out the dated change");
      assert.ok(!headlines.some((headline) => headline.startsWith(`${withoutOne.vendor}:`)), "the ItemList lists the change with no known effective date");
    } finally {
      proc.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shows only changes with a known effective date among the home page's changes today", async () => {
    const { isEventDated } = await import("../dist/change-dates.js");
    const { proc, base } = await startServer(null);
    try {
      const home = await (await fetch(`${base}/`)).text();
      const cards = cardsIn(section(home, "recent-changes"));
      assertPopulationFloor(cards.length, 1, "cards in Recent pricing changes");
      const undated = cards.filter(({ vendor, label }) => {
        const date = label.match(/\d{4}-\d{2}-\d{2}/)?.[0];
        const records = LOG.filter((c) => c.vendor === vendor && c.date === date);
        assert.ok(records.length > 0, `no record in the change log matches the card for ${vendor} on ${date}`);
        return !records.some((c) => isEventDated(c as never));
      });
      assert.deepStrictEqual(undated.map(({ vendor, label }) => `${vendor} ${label}`), [], "a card on the home page has no known effective date");
    } finally {
      proc.kill();
    }
  });
});

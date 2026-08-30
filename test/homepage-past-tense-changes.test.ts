import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const TODAY = new Date().toISOString().slice(0, 10);
const dayOffset = (days: number) =>
  new Date(Date.parse(TODAY) + days * 86400000).toISOString().slice(0, 10);

const FUTURE = [
  { vendor: "Kestrelmark", date: dayOffset(1), type: "free_tier_removed", source: "vendor_page" },
  { vendor: "Aurorabase", date: dayOffset(13), type: "new_free_tier", source: "vendor_page" },
  { vendor: "Beaconstack", date: dayOffset(31), type: "product_deprecated", source: "hand_written" },
  { vendor: "Cirruslane", date: dayOffset(38), type: "product_deprecated", source: "hand_written" },
];
const EFFECTIVE_TODAY = { vendor: "Datumforge", date: TODAY, type: "limits_reduced", source: "vendor_page" };
const PAST = [
  { vendor: "Everglow", date: dayOffset(-2), type: "free_tier_removed", source: "vendor_page" },
  { vendor: "Foldergrid", date: dayOffset(-4), type: "limits_reduced", source: "hand_written" },
  { vendor: "Gustline", date: dayOffset(-9), type: "pricing_restructured", source: "discovered" },
  { vendor: "Halcyonio", date: dayOffset(-15), type: "limits_increased", source: "vendor_page" },
  { vendor: "Ironvale", date: dayOffset(-21), type: "limits_reduced", source: "discovered" },
  { vendor: "Junipernet", date: dayOffset(-40), type: "free_tier_removed", source: "vendor_page" },
];

const EXPECTED_RECENT = [EFFECTIVE_TODAY, ...PAST].slice(0, 5).map((c) => c.vendor);

function change(spec: { vendor: string; date: string; type: string; source: string }) {
  return {
    vendor: spec.vendor,
    change_type: spec.type,
    date: spec.date,
    date_source: spec.source,
    summary: `${spec.vendor} changed the terms of its free allowance.`,
    previous_state: "10 GB storage",
    current_state: "2 GB storage",
    impact: "high",
    source_url: `https://example.com/${spec.vendor.toLowerCase()}/pricing`,
    category: "Databases",
    alternatives: [],
    recorded_date: spec.date,
  };
}

function fixtureChanges() {
  return [...FUTURE, EFFECTIVE_TODAY, ...PAST].map(change);
}

function sliceSection(html: string, startMarker: string, endMarker: string, label: string): string {
  const start = html.indexOf(startMarker);
  assert.ok(start >= 0, `the home page did not render the ${label} section at all`);
  const end = html.indexOf(endMarker, start);
  assert.ok(end > start, `the ${label} section did not close where expected`);
  return html.slice(start, end);
}

function entryDates(section: string, dateClass: string): string[] {
  return [...section.matchAll(new RegExp(`class="${dateClass}"[^>]*>([^<]*)<`, "g"))]
    .map((m) => m[1].match(/\d{4}-\d{2}-\d{2}/)?.[0])
    .filter((d): d is string => Boolean(d));
}

function vendorsIn(section: string): string[] {
  return [...FUTURE, EFFECTIVE_TODAY, ...PAST]
    .map((c) => ({ vendor: c.vendor, at: section.indexOf(`>${c.vendor}<`) }))
    .filter((c) => c.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((c) => c.vendor);
}

type Item = { headline?: string; datePublished?: string };

function itemListItems(html: string): Item[] {
  const lists: Item[][] = [];
  for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const json = JSON.parse(block[1]);
    if (json["@type"] !== "ItemList" || !Array.isArray(json.itemListElement)) continue;
    lists.push(json.itemListElement.map((el: any) => el.item));
  }
  assert.strictEqual(lists.length, 1, "expected exactly one change ItemList in the home page structured data");
  return lists[0];
}

function serveHomePage(changes: unknown[]): Promise<{ proc: ChildProcess; tmp: string; html: string }> {
  const tmp = mkdtempSync(path.join(tmpdir(), "homepage-past-tense-"));
  const changesPath = path.join(tmp, "changes.json");
  writeFileSync(changesPath, JSON.stringify({ changes }, null, 2));
  return new Promise<{ proc: ChildProcess; port: number }>((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: "0",
        BASE_URL: "http://localhost:3000",
        AGENTDEALS_CHANGES_PATH: changesPath,
      },
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Server startup timeout"));
    }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timeout);
        resolve({ proc: child, port: parseInt(m[1], 10) });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  }).then(async ({ proc, port }) => ({
    proc,
    tmp,
    html: await (await fetch(`http://localhost:${port}/`)).text(),
  }));
}

describe("the home page's past-tense change lists carry only changes that have taken effect", () => {
  let tmp: string;
  let proc: ChildProcess;
  let html = "";

  before(async () => {
    ({ proc, tmp, html } = await serveHomePage(fixtureChanges()));
  });

  after(() => {
    if (proc) proc.kill();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  const whatsChanged = () =>
    sliceSection(html, 'id="whats-changed"', 'href="/api/changes"', "Recent pricing changes");
  const freshIntel = () =>
    sliceSection(html, 'id="recent-changes"', 'href="/expiring" class="see-all-link"', "Fresh Intel");
  const comingSoon = () =>
    sliceSection(html, "Pricing changes coming soon", "expiring soon", "Pricing changes coming soon");

  it("dates every entry under Recent pricing changes on or before today", () => {
    const dates = entryDates(whatsChanged(), "change-date");
    assert.strictEqual(dates.length, 5, "Recent pricing changes did not render five entries, so the dates below prove nothing");
    for (const date of dates) {
      assert.ok(date <= TODAY, `Recent pricing changes leads with ${date}, which has not arrived yet`);
    }
  });

  it("dates every entry under Fresh Intel on or before today", () => {
    const dates = entryDates(freshIntel(), "rc-date");
    assert.strictEqual(dates.length, 5, "Fresh Intel did not render five entries, so the dates below prove nothing");
    for (const date of dates) {
      assert.ok(date <= TODAY, `Fresh Intel leads with ${date}, which has not arrived yet`);
    }
  });

  it("publishes no datePublished later than the day the page was built", () => {
    const items = itemListItems(html);
    assert.strictEqual(items.length, 5, "the ItemList did not carry five entries, so the dates below prove nothing");
    const dated = items.filter((it) => it.datePublished);
    assert.ok(dated.length > 0, "no entry carried a datePublished at all, so the bound below is vacuous");
    for (const item of dated) {
      assert.ok(
        item.datePublished! <= TODAY,
        `the structured data dates ${item.headline} as published on ${item.datePublished}, a day that has not arrived`
      );
    }
  });

  it("keeps a change out of the past-tense list until the day it takes effect", () => {
    const soon = vendorsIn(comingSoon());
    for (const upcoming of FUTURE) {
      assert.ok(
        soon.includes(upcoming.vendor),
        `${upcoming.vendor} takes effect on ${upcoming.date} and is missing from Pricing changes coming soon`
      );
      assert.ok(
        !vendorsIn(whatsChanged()).includes(upcoming.vendor),
        `${upcoming.vendor} takes effect on ${upcoming.date} and is listed under Recent pricing changes`
      );
      assert.ok(
        !vendorsIn(freshIntel()).includes(upcoming.vendor),
        `${upcoming.vendor} takes effect on ${upcoming.date} and is listed under Fresh Intel`
      );
    }
  });

  it("never lists the same change as both already changed and changing soon", () => {
    const recent = vendorsIn(whatsChanged());
    const soon = vendorsIn(comingSoon());
    assert.ok(recent.length > 0 && soon.length > 0, "one of the two lists is empty, so an empty overlap proves nothing");
    const both = recent.filter((v) => soon.includes(v));
    assert.deepStrictEqual(both, [], `listed as both already changed and changing soon: ${both.join(", ")}`);
  });

  it("counts a change that takes effect today as one that has happened", () => {
    assert.ok(
      vendorsIn(whatsChanged()).includes(EFFECTIVE_TODAY.vendor),
      `${EFFECTIVE_TODAY.vendor} takes effect today and is missing from Recent pricing changes`
    );
    assert.ok(
      !vendorsIn(comingSoon()).includes(EFFECTIVE_TODAY.vendor),
      `${EFFECTIVE_TODAY.vendor} takes effect today and is still counted down to`
    );
  });

  it("still fills all five slots from the changes that have taken effect", () => {
    assert.deepStrictEqual(
      vendorsIn(whatsChanged()),
      EXPECTED_RECENT,
      "Recent pricing changes is not the five newest changes that have taken effect"
    );
  });
});

describe("the home page counts the changes it lists, not the changes it holds", () => {
  const SPARSE_PAST = PAST.slice(0, 2);
  let tmp: string;
  let proc: ChildProcess;
  let html = "";

  before(async () => {
    ({ proc, tmp, html } = await serveHomePage([...FUTURE, ...SPARSE_PAST].map(change)));
  });

  after(() => {
    if (proc) proc.kill();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("advertises the number of entries it published, not the cap it could have filled", () => {
    const section = sliceSection(html, 'id="recent-changes"', 'href="/expiring" class="see-all-link"', "Fresh Intel");
    assert.deepStrictEqual(
      vendorsIn(section),
      SPARSE_PAST.map((c) => c.vendor),
      "Fresh Intel did not render exactly the changes that have taken effect"
    );
    const items = itemListItems(html);
    assert.strictEqual(
      items.length,
      SPARSE_PAST.length,
      "the structured data carried a different number of entries than the section rendered"
    );
    const numberOfItems = JSON.parse(
      [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
        .map((m) => m[1])
        .find((b) => JSON.parse(b)["@type"] === "ItemList")!
    ).numberOfItems;
    assert.strictEqual(
      numberOfItems,
      SPARSE_PAST.length,
      `the structured data advertises ${numberOfItems} entries on a list of ${SPARSE_PAST.length}`
    );
  });

  it("still counts down to every change that has not taken effect", () => {
    const soon = vendorsIn(sliceSection(html, "Pricing changes coming soon", "expiring soon", "Pricing changes coming soon"));
    assert.deepStrictEqual(soon, FUTURE.map((c) => c.vendor));
  });
});

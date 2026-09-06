import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { badgeVerdictsFromBadgesPage, type SiteFreeTierVerdict } from "./badge-verdicts.ts";

const { compiledFigureSlots, staticHalfOf } = await import("../dist/compiled-figures.js");
const { namedVendorSlug, toSlug, vendorSlugMap } = await import("../dist/vendor-slug.js");

type DealChange = import("../src/types.ts").DealChange;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const changes: DealChange[] = JSON.parse(
  readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"),
).changes;

const ENDS_THE_FREE_TIER = new Set(["free_tier_removed", "open_source_killed"]);
const REMOVAL_MARKER = /class="[^"]*\bremoved-badge\b[^"]*"/;
const PAGE_OWN_REMOVAL = /<span\b[^>]*class="[^"]*\bremoved-badge\b/;
const JOIN_MARKER = /<a\b[^>]*href="(?:\/vendor\/[a-z0-9-]+#changes|\/changes#vendor-[a-z0-9-]+)"[^>]*>(?:CHANGED [A-Z]{3} \d+|FREE REMOVED)</;

function recordsByVendorSlug(): Map<string, DealChange[]> {
  const byVendor = new Map<string, DealChange[]>();
  for (const change of changes) {
    const slug = toSlug(change.vendor);
    if (!slug) continue;
    const held = byVendor.get(slug);
    if (held) held.push(change);
    else byVendor.set(slug, [change]);
  }
  return byVendor;
}

function endingRecordIn(vendorChanges: DealChange[]): DealChange | null {
  const standing = vendorChanges.filter(c => !c.resolution);
  const ending = standing
    .filter(c => ENDS_THE_FREE_TIER.has(c.change_type))
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!ending) return null;
  return standing.some(c => c.change_type === "new_free_tier" && c.date > ending.date) ? null : ending;
}

const recordsFor = recordsByVendorSlug();
const endedByTheLog = new Map<string, DealChange>();
for (const [slug, held] of recordsFor) {
  const ending = endingRecordIn(held);
  if (ending) endedByTheLog.set(slug, ending);
}
const outsideTheCatalogue = (label: string) => namedVendorSlug(label) === null;

let proc: ChildProcess | null = null;
let base = "";
const pages = new Map<string, string>();
let verdicts = new Map<string, SiteFreeTierVerdict>();

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { base = `http://localhost:${m[1]}`; clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

async function fetchEveryPublishedPage(): Promise<void> {
  const sitemap = await (await fetch(`${base}/sitemap-pages.xml`)).text();
  const queue = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => new URL(m[1]).pathname);
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let next = queue.pop(); next; next = queue.pop()) {
      const res = await fetch(`${base}${next}`);
      if (res.ok) pages.set(next, await res.text());
    }
  }));
}

interface SweptSlot {
  path: string;
  kind: "row" | "card";
  label: string;
  slug: string;
  markup: string;
}

function everySlotOnEveryPage(): SweptSlot[] {
  const found: SweptSlot[] = [];
  for (const [pathname, html] of pages) {
    for (const slot of compiledFigureSlots(staticHalfOf(html))) {
      const slug = toSlug(slot.label);
      if (!slug) continue;
      found.push({ path: pathname, kind: slot.kind, label: slot.label, slug, markup: slot.markup });
    }
  }
  return found;
}

describe("marking a comparison slot whose vendor has no catalogue entry", () => {
  before(async () => {
    proc = await startServer();
    await fetchEveryPublishedPage();
    verdicts = badgeVerdictsFromBadgesPage(await (await fetch(`${base}/badges`)).text());
  });

  after(() => { proc?.kill(); });

  it("reads every page the sitemap publishes", () => {
    assert.ok(pages.size >= 400, `only ${pages.size} pages read`);
    assert.ok(verdicts.size >= 1500, `only ${verdicts.size} badge verdicts read`);
  });

  it("holds ended records for vendors the catalogue has no entry for", () => {
    const orphaned = [...endedByTheLog.values()].filter(c => outsideTheCatalogue(c.vendor));
    assert.ok(orphaned.length >= 20, `only ${orphaned.length} ended vendors are absent from the catalogue`);
  });

  it("marks every slot naming an uncatalogued vendor whose free tier the change log ended", () => {
    const named = everySlotOnEveryPage().filter(
      slot => outsideTheCatalogue(slot.label) && endedByTheLog.has(slot.slug),
    );
    const unmarked = named
      .filter(slot => !REMOVAL_MARKER.test(slot.markup))
      .map(slot => `${slot.path}: ${slot.kind} ${slot.label}`);
    assert.deepStrictEqual(unmarked, []);
    assert.ok(named.length >= 3, `only ${named.length} slots name an uncatalogued ended vendor`);
  });

  it("reaches a vendor's records through the name its own page is filed under", () => {
    const crossSpelled = everySlotOnEveryPage().filter(slot => {
      const page = namedVendorSlug(slot.label);
      if (page === null || page === slot.slug) return false;
      if (PAGE_OWN_REMOVAL.test(slot.markup)) return false;
      const heldUnderTheLabel = recordsFor.get(slot.slug) ?? [];
      return heldUnderTheLabel.length > 0 && (recordsFor.get(page) ?? []).length === 0;
    });
    assert.ok(crossSpelled.length >= 2, `only ${crossSpelled.length} slots name a vendor the two stores spell differently`);
    for (const slot of crossSpelled) {
      assert.match(
        slot.markup,
        new RegExp(`<a [^>]*href="/vendor/${namedVendorSlug(slot.label)}#changes"`),
        `${slot.path}: ${slot.label} reaches no record through its own page`,
      );
    }
  });

  it("marks every slot the site's own badge says has lost its free tier", () => {
    const named = everySlotOnEveryPage().filter(slot => verdicts.get(slot.slug) === "ended");
    const unmarked = named
      .filter(slot => !REMOVAL_MARKER.test(slot.markup))
      .map(slot => `${slot.path}: ${slot.kind} ${slot.label}`);
    assert.deepStrictEqual(unmarked, []);
    assert.ok(named.length >= 8, `only ${named.length} slots name a vendor the badge calls ended`);
  });

  it("sends no marker to a vendor page that does not exist", () => {
    const dead: string[] = [];
    for (const slot of everySlotOnEveryPage()) {
      for (const href of slot.markup.matchAll(/href="\/vendor\/([a-z0-9-]+)#changes"/g)) {
        if (!vendorSlugMap.has(href[1]!)) dead.push(`${slot.path}: ${slot.label} -> /vendor/${href[1]}`);
      }
    }
    assert.deepStrictEqual(dead, []);
  });

  it("lands every change-log marker on the record it rests on", () => {
    const log = pages.get("/changes");
    assert.ok(log, "the change log did not render");
    let landed = 0;
    for (const slot of everySlotOnEveryPage()) {
      for (const href of slot.markup.matchAll(/href="\/changes#(vendor-[a-z0-9-]+)"/g)) {
        assert.ok(log!.includes(` id="${href[1]}"`), `${slot.path}: ${slot.label} points at a missing ${href[1]}`);
        landed++;
      }
    }
    assert.ok(landed >= 2, `only ${landed} markers point at the change log`);
  });

  it("gives the change log one anchor per vendor and no more", () => {
    const ids = [...pages.get("/changes")!.matchAll(/ id="(vendor-[a-z0-9-]+)"/g)].map(m => m[1]!);
    assert.deepStrictEqual(ids.filter((id, at) => ids.indexOf(id) !== at), []);
    assert.ok(ids.length >= 400, `only ${ids.length} vendors are addressable in the change log`);
  });

  it("leaves a slot the page itself wrote as removed exactly as the page wrote it", () => {
    const written = everySlotOnEveryPage().filter(slot => REMOVAL_MARKER.test(slot.markup));
    const twiceBadged = written
      .filter(slot => (slot.markup.match(/removed-badge/g) ?? []).length > 1)
      .map(slot => `${slot.path}: ${slot.label}`);
    assert.deepStrictEqual(twiceBadged, []);
    const twiceStruck = written
      .filter(slot => /line-through[\s\S]*line-through/.test(slot.markup.split("removed-badge")[0]!))
      .map(slot => `${slot.path}: ${slot.label}`);
    assert.deepStrictEqual(twiceStruck, []);
    assert.ok(written.length >= 10, `only ${written.length} slots carry a removal marker`);
  });

  it("stops calling a free tier ended once the record that ended it no longer stands", () => {
    const standingDown = [...recordsFor.entries()]
      .filter(([slug, held]) => held.some(c => ENDS_THE_FREE_TIER.has(c.change_type)) && !endedByTheLog.has(slug))
      .map(([slug]) => slug);
    assert.ok(standingDown.length >= 1, "no ended record has been reversed, retracted or superseded");
    const marked = everySlotOnEveryPage()
      .filter(slot => standingDown.includes(slot.slug) && REMOVAL_MARKER.test(slot.markup))
      .map(slot => `${slot.path}: ${slot.label}`);
    assert.deepStrictEqual(marked, []);
  });
});

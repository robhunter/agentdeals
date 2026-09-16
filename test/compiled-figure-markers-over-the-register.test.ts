import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoversPopulation, assertPopulationFloor, pagesOnTheReviewRegister } from "./population-floor.ts";
import {
  factsOutdatedBy, newestChangeBySlug, parsePageReviews, reviewStatus, utcToday, type PageReviewRecord,
} from "../src/page-reviews.ts";

const { toSlug } = await import("../dist/vendor-slug.js");
const { vendorSlugForSubject, vendorSubjectsOnCompiledPage } = await import("../dist/compiled-figures.js");
const { isOurOwnBookkeeping } = await import("../dist/vendor-verdict.js");
const { isTrackedChange } = await import("../dist/change-census.js");
const { freeTierEndingRecord } = await import("../dist/data.js");
const { resolutionTag } = await import("../dist/change-resolution.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const TODAY = utcToday();

function registeredPages(): PageReviewRecord[] {
  return parsePageReviews(readFileSync(path.join(REPO, "data", "page-reviews.json"), "utf-8")).pages;
}

function changesTheVendorMade(): Array<{ vendor?: string; date?: string }> {
  const changes = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes;
  return changes.filter(
    (change: Parameters<typeof isOurOwnBookkeeping>[0] & Parameters<typeof isTrackedChange>[0]) =>
      isTrackedChange(change) && !isOurOwnBookkeeping(change),
  );
}

function newestChangeForSlug(): (slug: string) => string | null {
  const newest = newestChangeBySlug(changesTheVendorMade(), TODAY, toSlug);
  return slug => newest.get(slug) ?? null;
}

function slugsHoldingAWithdrawnRecord(): Set<string> {
  const changes = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes;
  const held = new Set<string>();
  for (const change of changes as Array<{ vendor?: string; resolution?: unknown }>) {
    if (change.vendor && change.resolution) held.add(toSlug(change.vendor));
  }
  return held;
}

function startServer(): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      cwd: REPO,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server startup timeout")); }, 60000);
    child.stderr!.on("data", (buffer: Buffer) => {
      const found = buffer.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (found) { clearTimeout(timer); resolve({ proc: child, port: parseInt(found[1], 10) }); }
    });
    child.on("error", err => { clearTimeout(timer); reject(err); });
  });
}

function recordMarkerSlugs(html: string): Set<string> {
  const marker = /<a href="\/(?:vendor\/([a-z0-9-]+)#changes|changes#vendor-([a-z0-9-]+))"[^>]*>(?:CHANGED [A-Z]{3} \d+|FREE REMOVED)<\/a>/g;
  const found = new Set<string>();
  for (const hit of html.matchAll(marker)) found.add(hit[1] ?? hit[2]!);
  return found;
}

function subjectsTheResolverReaches(html: string): Set<string> {
  const reached = new Set<string>();
  for (const subject of vendorSubjectsOnCompiledPage(html)) {
    const slug = vendorSlugForSubject(subject);
    if (slug) reached.add(slug);
  }
  return reached;
}

const WITHDRAWAL_TAGS = (["retracted", "reversed"] as const).map(state =>
  resolutionTag({ state, date: "0000-00-00" }).replace(" (0000-00-00).", ""),
);

function markerTooltips(html: string): string[] {
  const marker = /<a href="\/(?:vendor\/[a-z0-9-]+#changes|changes#vendor-[a-z0-9-]+)"[^>]*title="(We recorded[^"]*)"[^>]*>CHANGED /g;
  return [...html.matchAll(marker)].map(hit => hit[1]!);
}

const ENDED_MARKER =
  /<a href="\/(?:vendor\/[a-z0-9-]+#changes|changes#vendor-[a-z0-9-]+)" class="removed-badge" title="([^"]*)">FREE REMOVED<\/a>/g;
const SOURCED_TO_A_RECORD = /^Our own change log records that the (.+) free tier has ended\.$/;
const SOURCED_TO_A_TIER = /^(.+)'s offer is recorded as .+\.$/;

function endedMarkerTooltips(html: string): string[] {
  return [...html.matchAll(ENDED_MARKER)].map(hit => hit[1]!.replace(/&amp;/g, "&").replace(/&quot;/g, '"'));
}

function endingRecordWeHold(): (vendor: string) => boolean {
  const changes = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes;
  return vendor =>
    freeTierEndingRecord(
      changes.filter((change: { vendor?: string }) => (change.vendor ?? "").toLowerCase() === vendor.toLowerCase()),
    ) !== null;
}

function vendorsSourcedTo(tooltips: string[], sentence: RegExp): string[] {
  return tooltips.map(tooltip => sentence.exec(tooltip)?.[1]).filter((vendor): vendor is string => vendor !== undefined);
}

function tierTheCatalogueStores(): Map<string, string> {
  const offers = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
  const stored = new Map<string, string>();
  for (const offer of offers as Array<{ vendor: string; tier: string }>) {
    if (!stored.has(offer.vendor.toLowerCase())) stored.set(offer.vendor.toLowerCase(), offer.tier);
  }
  return stored;
}

function withdrawalsQuotedBy(tooltips: string[]): string[] {
  return tooltips.filter(tooltip => WITHDRAWAL_TAGS.some(tag => tooltip.includes(tag)));
}

interface PageSweep {
  path: string;
  reachableStale: string[];
  unmarked: string[];
  tooltips: string[];
  endedTooltips: string[];
  withdrawalsWeHold: string[];
}

describe("marking a compiled figure the change log has moved past", () => {
  let server: { proc: ChildProcess; port: number };
  let swept: PageSweep[] = [];

  before(async () => {
    server = await startServer();
    const changeDateFor = newestChangeForSlug();
    const withdrawn = slugsHoldingAWithdrawnRecord();
    for (const page of registeredPages()) {
      const response = await fetch(`http://localhost:${server.port}${page.path}`, { redirect: "manual" });
      assert.strictEqual(response.status, 200, `${page.path} is on the review register and did not serve`);
      const html = await response.text();
      const reached = subjectsTheResolverReaches(html);
      const marked = recordMarkerSlugs(html);
      const reachableStale = factsOutdatedBy(reviewStatus(page, TODAY), changeDateFor)
        .map(fact => fact.slug)
        .filter(slug => reached.has(slug));
      swept.push({
        path: page.path,
        reachableStale,
        unmarked: reachableStale.filter(slug => !marked.has(slug)),
        tooltips: markerTooltips(html),
        endedTooltips: endedMarkerTooltips(html),
        withdrawalsWeHold: [...reached].filter(slug => withdrawn.has(slug)),
      });
    }
  });

  after(() => server?.proc.kill("SIGKILL"));

  it("sweeps every page the review register holds", () => {
    assertCoversPopulation(swept.length, pagesOnTheReviewRegister(), "registered pages rendered and read for markers");
  });

  it("reads enough resolved subjects for the property to bite", () => {
    const subjects = swept.reduce((n, page) => n + page.reachableStale.length, 0);
    assertPopulationFloor(subjects, 50, "registered subjects the resolver reaches whose record post-dates the page");
  });

  it("marks every subject a page names whose record post-dates the figures it publishes", () => {
    const missing = swept.filter(page => page.unmarked.length > 0);
    assert.deepStrictEqual(
      missing.map(page => `${page.path}: ${page.unmarked.join(", ")}`),
      [],
      "a registered page names these vendors, holds a record newer than the figures it publishes, and renders no marker beside them",
    );
  });

  it("names subjects we hold a withdrawn record for, so the next assertion has a subject", () => {
    const named = swept.reduce((n, page) => n + page.withdrawalsWeHold.length, 0);
    assertPopulationFloor(named, 10, "registered subjects we hold a withdrawn record for");
  });

  it("rests no marker on a record we have withdrawn", () => {
    const quoting = swept
      .map(page => ({ path: page.path, withdrawals: withdrawalsQuotedBy(page.tooltips) }))
      .filter(page => page.withdrawals.length > 0);
    assert.deepStrictEqual(
      quoting.map(page => `${page.path}: ${page.withdrawals.length}`),
      [],
      "a marker says a figure was superseded and quotes a record we have since withdrawn",
    );
  });

  it("sources every ended marker it renders to either a record or a tier", () => {
    const unsourced = swept.flatMap(page =>
      page.endedTooltips
        .filter(tooltip => !SOURCED_TO_A_RECORD.test(tooltip) && !SOURCED_TO_A_TIER.test(tooltip))
        .map(tooltip => `${page.path}: ${tooltip}`),
    );
    assert.deepStrictEqual(unsourced, []);
  });

  it("renders enough ended markers of each kind for the next assertion to bite", () => {
    const tooltips = swept.flatMap(page => page.endedTooltips);
    assertPopulationFloor(
      vendorsSourcedTo(tooltips, SOURCED_TO_A_RECORD).length,
      9,
      "ended markers on the register that say a record of ours ends the free tier",
    );
    assertPopulationFloor(
      vendorsSourcedTo(tooltips, SOURCED_TO_A_TIER).length,
      1,
      "ended markers on the register that source the ending to the tier the catalogue stores",
    );
  });

  it("says a record of ours ends the free tier for exactly the vendors we hold such a record for", () => {
    const weHold = endingRecordWeHold();
    const misattributed = swept.flatMap(page => [
      ...vendorsSourcedTo(page.endedTooltips, SOURCED_TO_A_RECORD)
        .filter(vendor => !weHold(vendor))
        .map(vendor => `${page.path}: ${vendor} is sent to a record we do not hold`),
      ...vendorsSourcedTo(page.endedTooltips, SOURCED_TO_A_TIER)
        .filter(vendor => weHold(vendor))
        .map(vendor => `${page.path}: ${vendor} is sourced to its tier and we hold a record of the ending`),
    ]);
    assert.deepStrictEqual(misattributed, []);
  });

  it("quotes the tier the catalogue stores when it sources an ending to the tier", () => {
    const stored = tierTheCatalogueStores();
    const restated = swept.flatMap(page =>
      page.endedTooltips
        .filter(tooltip => SOURCED_TO_A_TIER.test(tooltip))
        .filter(tooltip => {
          const vendor = SOURCED_TO_A_TIER.exec(tooltip)![1]!;
          return tooltip !== `${vendor}'s offer is recorded as ${stored.get(vendor.toLowerCase())}.`;
        })
        .map(tooltip => `${page.path}: ${tooltip}`),
    );
    assert.deepStrictEqual(restated, []);
  });
});

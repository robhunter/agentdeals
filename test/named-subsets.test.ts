import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoversPopulation, assertPopulationFloor, vendorsInTheCatalogue, categoriesInTheCatalogue } from "./population-floor.ts";
import { NAMED_SUBSET_RULE, NAMED_SUBSET_FIELD_RULE, CRITERIA_PATH, wholeRankedOrderList } from "../dist/ranking.js";
import { toSlug } from "../dist/slug.js";
import {
  loadOffers,
  loadDealChanges,
  enrichOffers,
  getOfferDetails,
  checkVendorRisk,
  A_COMPLETE_LOG_NOTICE,
  A_DEMOTION_IN_FORCE_RULE,
  NO_DEMOTION_IN_FORCE_RULE,
  RECENT_CHANGE_WINDOW_DAYS,
  VERDICT_WINDOW_DAYS,
} from "../dist/data.js";
import { substitutesFor } from "../dist/product-role.js";
import { A_DATED_HEADING_MARKER, A_DATED_SECTION_MARKER, ANNOUNCED_HEADING } from "../dist/change-dates.js";
import { RECENT_CHANGES_ON_THE_HOME_PAGE, UPCOMING_DEADLINES_ON_THE_HOME_PAGE, atMostShownHere, onlyTheMostRecentShown } from "../dist/homepage-claims.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const A_DAY_IN_MS = 86400000;
const DEMOTED_HEADING = "Demoted — and exactly why";
const QUALIFIED_HEADING = "Quick Comparison";
const STATED_COUNTS = /([\d,]+) offers? meets? the criteria and ([\d,]+) offers? (?:is|are) demoted with a named reason/;
const CHANGES_STATED = /(?:across )?([\d,]+) developer tool pricing changes? tracked this week|across ([\d,]+) developer tool pricing changes?/;
const CHANGE_SECTION = /^(?:Biggest Losses|Bright Spots|Other Notable Changes) \(([\d,]+)\)$/;
const A_DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const EVERY_DATE = new RegExp(A_DATE.source, "g");
const A_ROLLING_WINDOW = /\bin the last \d+ days?\b|\bthis week\b/i;
const A_SENTENCE = /[^.!?]+[.!?]*/g;
const A_RUN_OF_DIGITS = /\d[\d,]*/g;
const LISTING_BASIS = /Of those, /;
const HOLDS_IN_ALL = /We hold ([\d,]+) /;
const EVERY_HELD_COUNT = new RegExp(HOLDS_IN_ALL.source, "g");
const CARRY_NO_DEMERIT = /([\d,]+) carr(?:y|ies) no recorded demerit/;
const DEMOTED_IN_BASIS = /([\d,]+) (?:is|are) demoted with the reason named/;
const GATED_IN_BASIS = /([\d,]+) (?:is|are) listed last behind a stated gate/;
const RECOUNTED_ELSEWHERE = [LISTING_BASIS, HOLDS_IN_ALL, STATED_COUNTS, CHANGES_STATED];
const PAGES_DATING_A_DEMOTION_FLOOR = 32;
const ROLLING_VERDICT_HEADINGS = ["At-Risk Vendors", "Stable Picks"];
const CLOCK_BASE_DAYS = Number(process.env.AGENTDEALS_CLOCK_BASE_DAYS ?? 0);

interface Surfaces {
  title: string | null;
  regions: Record<string, string[]>;
  vendors: string[];
  vendorSequence: string[];
  demotedHeadingFound: boolean;
  headings: string[];
  windowedHeadings: string[];
  datedHeadings: string[];
  datedCitationHeadings: string[];
  destinationsOf: Record<string, string[]>;
  headingAtAnchor: Record<string, string>;
  completeLogHeadings: string[];
  datesBehindEachDemotion: Record<string, string[]>;
  metaDescription: string | null;
  itemListNames: string[];
  faqAnswers: string[];
  statedCounts: { qualified: number; demoted: number } | null;
  offersHeld: number[];
  changesStated: number | null;
  changesListed: number;
}

function startServer(inventoryOut: string, clockShiftMs: number): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const args = clockShiftMs ? ["--import", path.join(REPO, "scripts", "shifted-clock.mjs")] : [];
    const proc = spawn("node", [...args, path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TZ: "UTC",
        PORT: "0",
        BASE_URL: "http://localhost",
        AGENTDEALS_PAGE_INVENTORY_OUT: inventoryOut,
        AGENTDEALS_CLOCK_SHIFT_MS: String(clockShiftMs),
      },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 60000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ proc, base: `http://localhost:${match[1]}` });
      }
    });
    proc.on("error", err => {
      clearTimeout(timeout);
      reject(err);
    });
    proc.on("exit", code => {
      clearTimeout(timeout);
      reject(new Error(`The server exited with status ${code} before reporting a port`));
    });
  });
}

function decodeEntities(text: string): string {
  return text
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&minus;/g, "−")
    .replace(/&rsaquo;/g, "›")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function asCount(text: string): number {
  return Number(text.replace(/,/g, ""));
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function headingsOf(html: string): { at: number; text: string; level: number }[] {
  return [...html.matchAll(/<h([1-4])[^>]*>([\s\S]*?)<\/h[1-4]>/g)].map(m => ({
    at: m.index!,
    text: stripTags(m[2]!),
    level: Number(m[1]!),
  }));
}

function paragraphAround(body: string, at: number): string {
  const open = body.lastIndexOf("<p", at);
  const close = body.indexOf("</p>", at);
  if (open === -1 || close === -1) return "";
  return body.slice(open, close);
}

function headingsADeclarationCovers(body: string, at: number): string[] {
  const headings = headingsOf(body);
  const own = headings.filter(heading => heading.at < at).pop();
  if (!own) return [];
  const covered = [own.text];
  for (const heading of headings) {
    if (heading.at <= own.at) continue;
    if (heading.level <= own.level) break;
    covered.push(heading.text);
  }
  return covered;
}

interface Declaration {
  headings: string[];
  destinations: string[];
}

function declarationsOf(body: string, marker: string): Declaration[] {
  const found: Declaration[] = [];
  for (let at = body.indexOf(marker); at !== -1; at = body.indexOf(marker, at + 1)) {
    const destinations = [...paragraphAround(body, at).matchAll(/href="([^"]+)"/g)].map(m => m[1]!);
    if (destinations.length === 0) continue;
    found.push({ headings: headingsADeclarationCovers(body, at), destinations });
  }
  return found;
}

function headingAtEachAnchor(body: string): Record<string, string> {
  const headings = headingsOf(body);
  const resolved: Record<string, string> = {};
  for (const anchor of body.matchAll(/\sid="([^"]+)"/g)) {
    const name = anchor[1]!;
    if (name in resolved) continue;
    const tagStart = body.lastIndexOf("<", anchor.index!);
    const own = headings.find(heading => heading.at === tagStart);
    const next = own ?? headings.find(heading => heading.at >= tagStart);
    if (next) resolved[name] = next.text;
  }
  return resolved;
}

const A_DATE_IN_A_HEADING = /\b(?:\d{4}-\d{2}-\d{2}|[A-Z]{3} \d{1,2}|\d{1,2} [A-Z][a-z]{2,8} \d{4}|[A-Z][a-z]{2,8} \d{1,2},? \d{4})\b/g;

function withoutItsDate(heading: string): string {
  return heading.replace(A_DATE_IN_A_HEADING, "").replace(/\s+/g, " ").trim();
}

const SECTIONS_GROUPED_BY_A_DATE: Array<{ page: string; heading: string; served: "always" | "when it holds one" }> = [
  { page: "/", heading: "Recent pricing changes", served: "always" },
  { page: "/ci-cd-pricing", heading: "Category Breakdown", served: "always" },
  { page: "/deadlines", heading: "Developer Tool Deadline Tracker", served: "always" },
  { page: "/expiring", heading: "Upcoming Free Tier Changes", served: "always" },
  { page: "/shutdowns", heading: "Developer Tool Shutdown Tracker 2026", served: "always" },
  { page: "/", heading: "Upcoming deal changes", served: "when it holds one" },
  { page: "/pricing-changes", heading: "Upcoming Changes", served: "when it holds one" },
  { page: "/trends/cloud-hosting", heading: ANNOUNCED_HEADING, served: "when it holds one" },
];

const DECLARED_DATED_HEADINGS_FLOOR = 126;

export function vendorsByRegion(body: string): Record<string, string[]> {
  const regions = new Map<string, Set<string>>();
  const headings = headingsOf(body);
  const headingFor = (index: number): string => {
    let current = "(above the first heading)";
    for (const heading of headings) {
      if (heading.at > index) break;
      current = heading.text;
    }
    return current;
  };
  for (const match of body.matchAll(/href="\/vendor\/([a-z0-9-]+)"/g)) {
    const region = headingFor(match.index!);
    if (!regions.has(region)) regions.set(region, new Set());
    regions.get(region)!.add(match[1]!);
  }
  return Object.fromEntries([...regions].map(([k, v]) => [k, [...v].sort()]));
}

function headingsWhoseSectionSays(body: string, says: (section: string) => boolean): string[] {
  const headings = headingsOf(body);
  return headings
    .filter((heading, at) => says(stripTags(body.slice(heading.at, headings[at + 1]?.at ?? body.length))))
    .map(heading => heading.text);
}

function headingsCoveringARollingWindow(body: string): string[] {
  return headingsWhoseSectionSays(body, section => A_ROLLING_WINDOW.test(section));
}

function headingsDeclaringACompleteLog(body: string): string[] {
  return headingsWhoseSectionSays(body, section => section.includes(A_COMPLETE_LOG_NOTICE));
}

function demotedRegionOf(body: string): string | null {
  const headings = headingsOf(body);
  const at = headings.findIndex(h => h.text === DEMOTED_HEADING);
  if (at === -1) return null;
  return body.slice(headings[at]!.at, headings[at + 1]?.at ?? body.length);
}

function datesBehindEachDemotion(body: string): Record<string, string[]> {
  const region = demotedRegionOf(body);
  if (region === null) return {};
  const cardStarts: { slug: string; at: number }[] = [];
  for (const link of region.matchAll(/href="\/vendor\/([a-z0-9-]+)"/g)) {
    if (cardStarts[cardStarts.length - 1]?.slug !== link[1]!) cardStarts.push({ slug: link[1]!, at: link.index! });
  }
  const dated: Record<string, string[]> = {};
  cardStarts.forEach((card, i) => {
    const html = region.slice(card.at, cardStarts[i + 1]?.at ?? region.length);
    const reasons = [...html.matchAll(/<ul class="demerit-list">([\s\S]*?)<\/ul>/g)].map(m => m[1]!).join(" ");
    dated[card.slug] = [...new Set([...reasons.matchAll(EVERY_DATE)].map(m => m[0]))];
  });
  return dated;
}

function jsonLdBlocks(body: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    try {
      out.push(JSON.parse(m[1]!));
    } catch {
      out.push({ unparseable: m[1] });
    }
  }
  return out;
}

function walkJsonLd(body: string, visit: (node: Record<string, unknown>) => void): void {
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    visit(node as Record<string, unknown>);
    for (const value of Object.values(node)) walk(value);
  };
  jsonLdBlocks(body).forEach(walk);
}

function surfacesOf(body: string): Surfaces {
  const itemListNames: string[] = [];
  const faqAnswers: string[] = [];
  walkJsonLd(body, node => {
    if (node["@type"] === "ItemList" && Array.isArray(node.itemListElement)) {
      for (const el of node.itemListElement as Array<Record<string, any>>) {
        const name = el?.item?.name ?? el?.name;
        if (typeof name === "string") itemListNames.push(name);
      }
    }
    if (node["@type"] === "Question" && typeof (node.acceptedAnswer as any)?.text === "string") {
      faqAnswers.push(`${node.name} :: ${(node.acceptedAnswer as any).text}`);
    }
  });
  const meta = body.match(/<meta name="description" content="([^"]*)"/);
  const title = body.match(/<title>([\s\S]*?)<\/title>/);
  const metaDescription = meta ? decodeEntities(meta[1]!) : null;
  const counts = metaDescription?.match(STATED_COUNTS) ?? null;
  const changes = metaDescription?.match(CHANGES_STATED) ?? null;
  const dated = declarationsOf(body, A_DATED_SECTION_MARKER);
  const citations = declarationsOf(body, A_DATED_HEADING_MARKER);
  const destinationsOf: Record<string, string[]> = {};
  for (const declaration of [...dated, ...citations]) {
    for (const heading of declaration.headings) {
      destinationsOf[heading] = [...new Set([...(destinationsOf[heading] ?? []), ...declaration.destinations])];
    }
  }
  return {
    changesStated: changes ? asCount(changes[1] ?? changes[2]!) : null,
    changesListed: headingsOf(body)
      .map(heading => heading.text.match(CHANGE_SECTION))
      .reduce((sum, section) => sum + (section ? asCount(section[1]!) : 0), 0),
    title: title ? decodeEntities(title[1]!) : null,
    regions: vendorsByRegion(body),
    vendors: [...new Set([...body.matchAll(/href="\/vendor\/([a-z0-9-]+)"/g)].map(m => m[1]!))].sort(),
    vendorSequence: [...body.matchAll(/href="\/vendor\/([a-z0-9-]+)"/g)].map(m => m[1]!),
    demotedHeadingFound: demotedRegionOf(body) !== null,
    headings: headingsOf(body).map(heading => heading.text),
    windowedHeadings: headingsCoveringARollingWindow(body),
    datedHeadings: [...new Set(dated.flatMap(declaration => declaration.headings))],
    datedCitationHeadings: [...new Set(citations.flatMap(declaration => declaration.headings))],
    destinationsOf,
    headingAtAnchor: headingAtEachAnchor(body),
    completeLogHeadings: headingsDeclaringACompleteLog(body),
    datesBehindEachDemotion: datesBehindEachDemotion(body),
    metaDescription,
    itemListNames: itemListNames.sort(),
    faqAnswers: faqAnswers.sort(),
    statedCounts: counts ? { qualified: asCount(counts[1]!), demoted: asCount(counts[2]!) } : null,
    offersHeld: [...stripTags(body).matchAll(EVERY_HELD_COUNT)].map(m => asCount(m[1]!)),
  };
}

function headingsNaming(surfaces: Surfaces, vendor: string): string {
  return Object.entries(surfaces.regions)
    .filter(([, vendors]) => vendors.includes(vendor))
    .map(([heading]) => heading)
    .sort()
    .join(" + ");
}

function coversADifferentDay(before: Surfaces, after: Surfaces): boolean {
  return before.title !== after.title;
}

function headingsNamingEach(surfaces: Surfaces, vendor: string): string[] {
  return Object.entries(surfaces.regions)
    .filter(([, vendors]) => vendors.includes(vendor))
    .map(([heading]) => heading);
}

function citedUndated(surfaces: Surfaces, heading: string): string {
  return surfaces.datedCitationHeadings.includes(heading) ? withoutItsDate(heading) : heading;
}

function headingsGainedAndLost(before: Surfaces, after: Surfaces, vendor: string): { lost: string[]; gained: string[] } {
  const was = new Map(headingsNamingEach(before, vendor).map(h => [citedUndated(before, h), h]));
  const now = new Map(headingsNamingEach(after, vendor).map(h => [citedUndated(after, h), h]));
  return {
    lost: [...was].filter(([stable]) => !now.has(stable)).map(([, heading]) => heading),
    gained: [...now].filter(([stable]) => !was.has(stable)).map(([, heading]) => heading),
  };
}

function headingsADeclarationSendsThemTo(surfaces: Surfaces, after: Surfaces, headings: string[]): Set<string> {
  const promised = new Set<string>();
  for (const heading of headings) {
    for (const destination of surfaces.destinationsOf[heading] ?? []) {
      if (!destination.startsWith("#")) continue;
      const lands = after.headingAtAnchor[destination.slice(1)];
      if (lands !== undefined) promised.add(lands);
    }
  }
  return promised;
}

function stableRegions(surfaces: Surfaces): Map<string, Set<string>> {
  const named = new Map<string, Set<string>>();
  for (const [heading, vendors] of Object.entries(surfaces.regions)) {
    const stable = citedUndated(surfaces, heading);
    if (!named.has(stable)) named.set(stable, new Set());
    for (const vendor of vendors) named.get(stable)!.add(vendor);
  }
  return named;
}

function destinationNames(
  destination: string,
  vendor: string,
  after: Surfaces,
  pages: Map<string, Surfaces>,
): boolean {
  if (destination.startsWith("#")) {
    const heading = after.headingAtAnchor[destination.slice(1)];
    if (heading === undefined) return false;
    return (stableRegions(after).get(citedUndated(after, heading)) ?? new Set<string>()).has(vendor);
  }
  if (!destination.startsWith("/")) return false;
  return pages.get(destination.split("#")[0]!)?.vendors.includes(vendor) ?? false;
}

function movedOnlyBetweenDatedSections(before: Surfaces, after: Surfaces, vendor: string): boolean {
  const { lost, gained } = headingsGainedAndLost(before, after, vendor);
  if (lost.length === 0 && gained.length === 0) return true;
  if (!lost.every(heading => before.datedHeadings.includes(heading))) return false;
  const sentTo = headingsADeclarationSendsThemTo(before, after, lost);
  return gained.every(heading => after.datedHeadings.includes(heading) || sentTo.has(heading));
}

function vendorsThatChangeHeading(before: Surfaces, after: Surfaces): string[] {
  return [...new Set([...before.vendors, ...after.vendors])]
    .filter(vendor => headingsNaming(before, vendor) !== headingsNaming(after, vendor))
    .sort();
}

function headingsWhoseMembershipIsAVerdict(surfaces: Surfaces, vendor: string): string[] {
  return Object.entries(surfaces.regions)
    .filter(([heading, vendors]) => vendors.includes(vendor) && !surfaces.completeLogHeadings.includes(heading))
    .map(([heading]) => heading);
}

function namedOnlyUnderARollingWindow(surfaces: Surfaces, vendor: string): boolean {
  const headings = headingsWhoseMembershipIsAVerdict(surfaces, vendor);
  return headings.length > 0 && headings.every(heading => surfaces.windowedHeadings.includes(heading));
}

function datedDemotionFor(surfaces: Surfaces, vendor: string): boolean {
  return (surfaces.datesBehindEachDemotion[vendor] ?? []).length > 0;
}

function movesWithNoDatedReason(before: Surfaces, after: Surfaces): string[] {
  if (coversADifferentDay(before, after)) return [];
  return vendorsThatChangeHeading(before, after).filter(vendor => {
    if (namedOnlyUnderARollingWindow(before, vendor) || namedOnlyUnderARollingWindow(after, vendor)) return false;
    if (movedOnlyBetweenDatedSections(before, after, vendor)) return false;
    return datedDemotionFor(before, vendor) === datedDemotionFor(after, vendor);
  });
}

function sentencesOf(text: string): string[] {
  return (text.match(A_SENTENCE) ?? [])
    .map(sentence => sentence.trim())
    .filter(sentence => sentence !== "" && !RECOUNTED_ELSEWHERE.some(recounted => recounted.test(sentence)));
}

function sentencesThatDiffer(before: string[], after: string[]): string[] {
  const said = before.flatMap(sentencesOf);
  const says = after.flatMap(sentencesOf);
  return [...said.filter(s => !says.includes(s)), ...says.filter(s => !said.includes(s))];
}

function withoutItsFigures(sentence: string): string {
  return sentence.replace(A_RUN_OF_DIGITS, "#");
}

function sentencesItChangedWithoutSayingWhy(before: Surfaces, after: Surfaces): string[] {
  const said = [before.metaDescription ?? "", ...before.faqAnswers];
  const says = [after.metaDescription ?? "", ...after.faqAnswers];
  const differing = sentencesThatDiffer(said, says);
  if (differing.length === 0) return [];
  if (differing.some(sentence => A_DATE.test(sentence) || A_ROLLING_WINDOW.test(sentence))) return [];
  return sentencesThatDiffer(said.map(withoutItsFigures), says.map(withoutItsFigures));
}

function answersByQuestion(answers: string[]): Map<string, string> {
  return new Map(answers.map(answer => {
    const at = answer.indexOf(" :: ");
    return [answer.slice(0, at), answer.slice(at + 4)] as [string, string];
  }));
}

function vendorsNoLongerNamed(before: Surfaces, after: Surfaces): string[] {
  if (coversADifferentDay(before, after)) return [];
  const gained = after.vendors.filter(vendor =>
    !before.vendors.includes(vendor)
    && !namedOnlyUnderARollingWindow(after, vendor)
    && !movedOnlyBetweenDatedSections(before, after, vendor));
  const lost = before.vendors.filter(vendor =>
    !after.vendors.includes(vendor)
    && !namedOnlyUnderARollingWindow(before, vendor)
    && !movedOnlyBetweenDatedSections(before, after, vendor)
    && !datedDemotionFor(before, vendor));
  return [...lost, ...gained].sort();
}

async function readEveryPage(base: string, paths: string[]): Promise<{ read: Map<string, Surfaces>; refused: string[] }> {
  const read = new Map<string, Surfaces>();
  const refused: string[] = [];
  for (const pagePath of paths) {
    const response = await fetch(base + pagePath);
    const body = await response.text();
    if (response.status !== 200) refused.push(`${pagePath} answered ${response.status}`);
    else read.set(pagePath, surfacesOf(body));
  }
  return { read, refused };
}

describe("what a page names changes overnight only where the page itself says why", () => {
  let served: string[] = [];
  let inventory: string[] = [];
  let today: Map<string, Surfaces>;
  let tomorrow: Map<string, Surfaces>;
  let refused: string[] = [];
  let scratch = "";

  before(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "named-subsets-"));
    const inventoryOut = path.join(scratch, "inventory.json");
    const first = await startServer(inventoryOut, CLOCK_BASE_DAYS * A_DAY_IN_MS);
    served = JSON.parse(readFileSync(inventoryOut, "utf-8"));
    const read = await readEveryPage(first.base, served);
    today = read.read;
    first.proc.kill();

    const ahead = await startServer(path.join(scratch, "inventory-ahead.json"), (CLOCK_BASE_DAYS + 1) * A_DAY_IN_MS);
    const readAhead = await readEveryPage(ahead.base, served);
    tomorrow = readAhead.read;
    ahead.proc.kill();
    refused = [...read.refused, ...readAhead.refused];
    inventory = served.filter(pagePath => today.has(pagePath) && tomorrow.has(pagePath));
  });

  after(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  const bothDays = (pagePath: string): [Surfaces, Surfaces] => [today.get(pagePath)!, tomorrow.get(pagePath)!];

  it("reads every page this server publishes, not a sample of them", () => {
    const vendorPages = inventory.filter(p => p.startsWith("/vendor/"));
    assertCoversPopulation(vendorPages.length, vendorsInTheCatalogue(), "vendor pages read against a clock a day ahead");
  });

  it("still serves tomorrow every page it serves today", () => {
    assert.deepEqual(
      refused.slice(0, 8),
      [],
      `${refused.length} of ${served.length} pages are not served on both clocks, so a reader who bookmarks one today finds nothing there tomorrow`,
    );
  });

  it("reads a server whose clock really is a day ahead", () => {
    const inADifferentOrder = inventory.filter(pagePath => {
      const before = today.get(pagePath)!.vendorSequence;
      const after = tomorrow.get(pagePath)!.vendorSequence;
      return before.length > 1 && before.join("|") !== after.join("|");
    });
    assert.ok(
      inADifferentOrder.length > 0,
      "no page lists its vendors in a different order tomorrow, so the second server is not a day ahead and every comparison here passes for the wrong reason",
    );
  });

  it("finds the heading a demoted offer is named under, and the dates printed beneath it", () => {
    const bestOfPages = inventory.filter(p => p.startsWith("/best/"));
    const carryingTheHeading = bestOfPages.filter(p => today.get(p)!.demotedHeadingFound);
    assert.equal(
      carryingTheHeading.length,
      bestOfPages.length,
      `only ${carryingTheHeading.length} of ${bestOfPages.length} best-of pages carry the heading a demoted offer is named under, so nothing below can tell a demotion from a disappearance`,
    );
    const datingADemotion = inventory.filter(p =>
      Object.values(today.get(p)!.datesBehindEachDemotion).some(dates => dates.length > 0));
    assertPopulationFloor(
      datingADemotion.length,
      PAGES_DATING_A_DEMOTION_FLOOR,
      "pages printing a date beneath a demoted offer",
    );
  });

  it("names the same vendors tomorrow, whatever heading it serves them under", () => {
    const moved = inventory
      .map(pagePath => ({ pagePath, vendors: vendorsNoLongerNamed(...bothDays(pagePath)) }))
      .filter(page => page.vendors.length > 0);
    assert.deepEqual(
      moved.slice(0, 8).map(page => `${page.pagePath}: ${page.vendors.slice(0, 4).join(", ")}`),
      [],
      `the set of vendors named is different tomorrow on ${moved.length} of ${inventory.length} pages, and nothing on those pages covers a rolling window, dates a demotion, or says in the title that the day is different`,
    );
  });

  it("moves a vendor to another heading only by demoting it, and dates the reason where it says so", () => {
    const unexplained: string[] = [];
    for (const pagePath of inventory) {
      const [before, after] = bothDays(pagePath);
      for (const vendor of movesWithNoDatedReason(before, after)) {
        unexplained.push(
          `${pagePath}: ${vendor} moves from "${headingsNaming(before, vendor)}"` +
          ` to "${headingsNaming(after, vendor)}" with no dated reason under the demoted heading on either day`,
        );
      }
    }
    assert.deepEqual(
      unexplained.slice(0, 8),
      [],
      `${unexplained.length} vendor${unexplained.length === 1 ? " is" : "s are"} named under a different heading tomorrow with nothing on the page dating the move`,
    );
  });

  it("keeps every name a section promises never to drop", () => {
    const dropped: string[] = [];
    for (const pagePath of inventory) {
      const [before, after] = bothDays(pagePath);
      for (const heading of before.completeLogHeadings) {
        const lost = (before.regions[heading] ?? []).filter(vendor => !(after.regions[heading] ?? []).includes(vendor));
        if (lost.length > 0) dropped.push(`${pagePath} "${heading}": ${lost.slice(0, 4).join(", ")}`);
      }
    }
    assert.deepEqual(
      dropped.slice(0, 8),
      [],
      `${dropped.length} section${dropped.length === 1 ? "" : "s"} told the reader a record is never removed and then stopped naming a vendor tomorrow`,
    );
  });

  it("puts a record where the section that let it go says the reader will find it", () => {
    const stranded: string[] = [];
    let declaring = 0;
    for (const pagePath of inventory) {
      const [before, after] = bothDays(pagePath);
      const declared = [...new Set([...before.datedHeadings, ...before.datedCitationHeadings])];
      declaring += declared.length;
      if (coversADifferentDay(before, after)) continue;
      const namedNow = stableRegions(after);
      for (const heading of declared) {
        const stable = citedUndated(before, heading);
        const held = namedNow.get(stable) ?? new Set<string>();
        for (const vendor of (before.regions[heading] ?? []).filter(v => !held.has(v))) {
          const destinations = before.destinationsOf[heading] ?? [];
          if (destinations.some(destination => destinationNames(destination, vendor, after, tomorrow))) continue;
          stranded.push(`${pagePath} "${heading}": ${vendor} is not at ${destinations.join(" or ") || "any destination it names"}`);
        }
      }
    }
    assertPopulationFloor(declaring, DECLARED_DATED_HEADINGS_FLOOR, "headings covered by a stated date rule");
    assert.deepEqual(
      stranded.slice(0, 8),
      [],
      `${stranded.length} record${stranded.length === 1 ? " was" : "s were"} dropped by a section that tells the reader where to look next, and are not there`,
    );
  });

  it("states the date rule in every section that re-groups a record when a date passes", () => {
    assert.deepEqual(
      [...new Set(SECTIONS_GROUPED_BY_A_DATE.map(section => section.page))].filter(p => !inventory.includes(p)),
      [],
      "a page this reads for a stated date rule is not served on both clocks, so the rule below is read on fewer sections than it names",
    );
    const silent: string[] = [];
    const rendered: string[] = [];
    const gone: string[] = [];
    for (const { page, heading, served } of SECTIONS_GROUPED_BY_A_DATE) {
      const surfaces = today.get(page)!;
      if (!surfaces.headings.includes(heading)) {
        if (served === "always") gone.push(`${page} "${heading}"`);
        continue;
      }
      rendered.push(`${page} "${heading}"`);
      if (surfaces.datedHeadings.includes(heading) || surfaces.datedCitationHeadings.includes(heading)) continue;
      silent.push(`${page} "${heading}"`);
    }
    assert.deepEqual(
      gone,
      [],
      `${gone.length} sections this reads for a stated date rule are not on the page at all, so it reads fewer than it names`,
    );
    assert.deepEqual(
      silent,
      [],
      `${silent.length} of ${rendered.length} sections re-group a record when a date passes and state no rule that would tell a reader it was going to`,
    );
  });

  it("gives two different headings two different names, so nothing is exempted by being confused with something else", () => {
    const confused: string[] = [];
    for (const pagePath of inventory) {
      const surfaces = today.get(pagePath)!;
      const byStableName = new Map<string, string[]>();
      for (const heading of Object.keys(surfaces.regions)) {
        const stable = citedUndated(surfaces, heading);
        byStableName.set(stable, [...(byStableName.get(stable) ?? []), heading]);
      }
      for (const [stable, headings] of byStableName) {
        if (headings.length > 1) confused.push(`${pagePath}: ${headings.slice(0, 3).join(" and ")} all read as "${stable}"`);
      }
    }
    assert.deepEqual(
      confused.slice(0, 8),
      [],
      `${confused.length} pages let a rule about dates in headings strip away enough that two different sections carry the same name`,
    );
  });

  it("exempts a move from the assertions above only where a section earned it", () => {
    const trendsPages = inventory.filter(p => p.startsWith("/trends/"));
    assertCoversPopulation(
      trendsPages.length,
      categoriesInTheCatalogue(),
      "category trends pages read against a clock a day ahead",
    );
    assert.deepEqual(
      trendsPages.filter(p => today.get(p)!.completeLogHeadings.length === 0).slice(0, 8),
      [],
      "a trends page declares no section a complete log, and declaring one is the only thing that keeps a heading out of the exemption's denominator",
    );
    const named = trendsPages.flatMap(pagePath => {
      const surfaces = today.get(pagePath)!;
      return ROLLING_VERDICT_HEADINGS.flatMap(heading =>
        (surfaces.regions[heading] ?? []).map(vendor => ({ pagePath, heading, vendor, surfaces })));
    });
    assert.ok(
      named.length > 0,
      `no trends page names a vendor under ${ROLLING_VERDICT_HEADINGS.join(" or ")}, so nothing below reads the exemption at all`,
    );
    const unexempted = named
      .filter(({ surfaces, vendor }) => !namedOnlyUnderARollingWindow(surfaces, vendor))
      .map(({ pagePath, heading, vendor }) => `${pagePath} "${heading}": ${vendor}`);
    assert.deepEqual(
      unexempted.slice(0, 8),
      [],
      `${unexempted.length} of ${named.length} vendors named under a heading whose membership rolls with the clock are not covered by a window that heading states`,
    );
  });

  it("names under a stated membership rule every vendor that rule qualifies, not the first few", t => {
    if (CLOCK_BASE_DAYS !== 0) return t.skip("the qualifying set is read on the real clock, which the shifted server does not share");
    const qualifyingIn = new Map<string, Set<string>>();
    const offersByCategory = new Map<string, ReturnType<typeof loadOffers>>();
    for (const offer of loadOffers()) {
      if (!offersByCategory.has(offer.category)) offersByCategory.set(offer.category, []);
      offersByCategory.get(offer.category)!.push(offer);
    }
    for (const [category, list] of offersByCategory) {
      const qualifying = enrichOffers(list).filter(o => o.risk_level === "stable" && !o.recent_change);
      qualifyingIn.set(toSlug(category), new Set(qualifying.map(o => toSlug(o.vendor))));
    }
    const withheld: string[] = [];
    for (const pagePath of inventory.filter(p => p.startsWith("/trends/"))) {
      const qualifying = qualifyingIn.get(pagePath.slice("/trends/".length));
      if (qualifying === undefined) continue;
      const named = new Set(today.get(pagePath)!.regions["Stable Picks"] ?? []);
      const unnamed = [...qualifying].filter(vendor => !named.has(vendor)).sort();
      if (unnamed.length > 0) withheld.push(`${pagePath}: ${unnamed.length} of ${qualifying.size} unnamed, ${unnamed.slice(0, 3).join(", ")}`);
    }
    assert.deepEqual(
      withheld.slice(0, 8),
      [],
      `${withheld.length} pages state the rule for being in a section and then name only some of the vendors that satisfy it, which is the named subset ${CRITERIA_PATH}#subsets publishes a promise against`,
    );
  });

  it("publishes the same names in its structured data tomorrow, save the ones it demotes", () => {
    const unaccounted: string[] = [];
    for (const pagePath of inventory) {
      const [before, after] = bothDays(pagePath);
      if (coversADifferentDay(before, after)) continue;
      const named = before.itemListNames;
      const namedTomorrow = after.itemListNames;
      if (named.join("|") === namedTomorrow.join("|")) continue;
      const moved = new Set(vendorsThatChangeHeading(before, after));
      const headingsThatMoved = new Set(
        [...Object.keys(before.regions), ...Object.keys(after.regions)]
          .filter(heading => (heading in before.regions) !== (heading in after.regions)),
      );
      const changed = [...named.filter(n => !namedTomorrow.includes(n)), ...namedTomorrow.filter(n => !named.includes(n))];
      const notMoved = changed.filter(name => !moved.has(toSlug(name)) && !headingsThatMoved.has(name));
      if (notMoved.length > 0) unaccounted.push(`${pagePath}: ${notMoved.slice(0, 4).join(", ")}`);
    }
    assert.deepEqual(
      unaccounted.slice(0, 8),
      [],
      `${unaccounted.length} of ${inventory.length} pages publish an ItemList naming someone different tomorrow who did not change heading on the page`,
    );
  });

  it("says the same words tomorrow, apart from the figures it recounts", () => {
    const moved: string[] = [];
    for (const pagePath of inventory) {
      const [before, after] = bothDays(pagePath);
      if (coversADifferentDay(before, after)) continue;
      if (vendorsThatChangeHeading(before, after).length > 0) continue;
      const rewritten = sentencesItChangedWithoutSayingWhy(before, after);
      if (rewritten.length > 0) moved.push(`${pagePath}: ${rewritten.slice(0, 2).join(" / ")}`);
    }
    assert.deepEqual(
      moved.slice(0, 8),
      [],
      `${moved.length} of ${inventory.length} pages say something different tomorrow beyond recounting a figure, without demoting anyone, covering a different day, or dating the sentence that changed`,
    );
  });

  it("adds up the figures it recounts, on both of the days it states them", () => {
    const wrong: string[] = [];
    const stating: string[] = [];
    for (const pagePath of inventory) {
      for (const [day, surfaces] of [["today", today.get(pagePath)!], ["tomorrow", tomorrow.get(pagePath)!]] as const) {
        for (const answer of surfaces.faqAnswers) {
          if (!LISTING_BASIS.test(answer)) continue;
          if (day === "today") stating.push(pagePath);
          const figure = (pattern: RegExp): number => asCount(answer.match(pattern)?.[1] ?? "0");
          const held = figure(HOLDS_IN_ALL);
          const parts = figure(CARRY_NO_DEMERIT) + figure(DEMOTED_IN_BASIS) + figure(GATED_IN_BASIS);
          if (held === parts) continue;
          wrong.push(`${pagePath} (${day}): holds ${held} and splits them into ${parts}`);
        }
      }
    }
    assertPopulationFloor(stating.length, PAGES_DATING_A_DEMOTION_FLOOR, "pages splitting the list they hold into named bands");
    assert.deepEqual(
      wrong.slice(0, 8),
      [],
      `${wrong.length} page readings split the list they hold into bands that do not add up to it`,
    );
  });

  it("counts the offers it lists, on both of the days it lists them", () => {
    const wrong: string[] = [];
    const counting: string[] = [];
    for (const pagePath of inventory) {
      for (const [day, surfaces] of [["today", today.get(pagePath)!], ["tomorrow", tomorrow.get(pagePath)!]] as const) {
        if (surfaces.statedCounts === null) continue;
        if (day === "today") counting.push(pagePath);
        const listed = {
          qualified: (surfaces.regions[QUALIFIED_HEADING] ?? []).length,
          demoted: (surfaces.regions[DEMOTED_HEADING] ?? []).length,
        };
        const held = surfaces.offersHeld.filter(n => n !== listed.qualified);
        if (surfaces.statedCounts.qualified === listed.qualified && surfaces.statedCounts.demoted === listed.demoted && held.length === 0) continue;
        wrong.push(
          `${pagePath} (${day}): says ${surfaces.statedCounts.qualified} meet the criteria and ${surfaces.statedCounts.demoted} are demoted` +
          `, and answers with ${surfaces.offersHeld.join(", ") || "no count"}, over ${listed.qualified} and ${listed.demoted} it lists`,
        );
      }
    }
    const bestOfPages = inventory.filter(p => p.startsWith("/best/"));
    assert.equal(
      counting.length,
      bestOfPages.length,
      `${bestOfPages.length - counting.length} of ${bestOfPages.length} best-of pages do not state how many offers they list, so this reads fewer pages than it claims to`,
    );
    assert.deepEqual(
      wrong.slice(0, 8),
      [],
      `${wrong.length} page readings state a count of their own offers that the headings on the same page do not bear out`,
    );
  });

  it("counts the changes it lists for the week it names, on both of the days it names one", () => {
    const wrong: string[] = [];
    const stating: string[] = [];
    for (const pagePath of inventory) {
      for (const [day, surfaces] of [["today", today.get(pagePath)!], ["tomorrow", tomorrow.get(pagePath)!]] as const) {
        if (surfaces.changesStated === null) continue;
        if (day === "today") stating.push(pagePath);
        const listedMoreThanItCounts = surfaces.changesListed > surfaces.changesStated;
        const silentAboutWhatItLists = (surfaces.changesStated === 0) !== (surfaces.changesListed === 0);
        if (!listedMoreThanItCounts && !silentAboutWhatItLists) continue;
        wrong.push(`${pagePath} (${day}): counts ${surfaces.changesStated} and lists ${surfaces.changesListed} under its own section headings`);
      }
    }
    assert.ok(stating.length > 0, "no page states how many changes it tracked for the week it names, so this reads nothing");
    assert.deepEqual(
      wrong.slice(0, 8),
      [],
      `${wrong.length} page readings state a count of changes for the week they name that their own section headings do not bear out`,
    );
  });

});

describe("what counts as a page saying why, on pages built to test it", () => {
  const DATED = "&minus;1 stale_verification We have not confirmed this offer against the vendor's pricing page since 2026-06-15 (91 days).";
  const UNDATED = "&minus;2 time_limited_offer Tier \"Free for 12 months\" is a trial, not an ongoing free tier.";

  function aPage(page: {
    title: string;
    description?: string;
    sections: { heading: string; note?: string; vendors: string[] }[];
    demoted?: { vendor: string; reason: string }[];
  }): string {
    const link = (vendor: string): string => `<a href="/vendor/${vendor}">${vendor}</a>`;
    const sections = page.sections
      .map(section => `<h2>${section.heading}</h2>${section.note ? `<p>${section.note}</p>` : ""}${section.vendors.map(link).join("")}`)
      .join("");
    const demoted = (page.demoted ?? [])
      .map(card => `${link(card.vendor)}<ul class="demerit-list"><li>${card.reason}</li></ul>${link(card.vendor)}`)
      .join("");
    return `<html><head><title>${page.title}</title>` +
      `<meta name="description" content="${page.description ?? "A page that names some vendors."}">` +
      `</head><body>${sections}<h2>Demoted &mdash; and exactly why</h2>${demoted}</body></html>`;
  }

  const listing = (vendors: string[]) => ({ heading: "Best Free Widgets", vendors });
  const TITLE = "Best Free Widgets (2026)";
  const listedTogether = surfacesOf(aPage({ title: TITLE, sections: [listing(["alfa", "bravo"])] }));

  it("reads a demotion the page dates as the page saying why", () => {
    const demotedWithADate = surfacesOf(aPage({
      title: TITLE,
      sections: [listing(["alfa"])],
      demoted: [{ vendor: "bravo", reason: DATED }],
    }));
    assert.deepEqual(vendorsThatChangeHeading(listedTogether, demotedWithADate), ["bravo"]);
    assert.deepEqual(movesWithNoDatedReason(listedTogether, demotedWithADate), []);
  });

  it("reads a demotion the page leaves undated as the page not saying why", () => {
    const demotedWithNoDate = surfacesOf(aPage({
      title: TITLE,
      sections: [listing(["alfa"])],
      demoted: [{ vendor: "bravo", reason: UNDATED }],
    }));
    assert.deepEqual(movesWithNoDatedReason(listedTogether, demotedWithNoDate), ["bravo"]);
  });

  it("reads a vendor that changes heading without being demoted as unexplained", () => {
    const rotatedIntoAnotherSection = surfacesOf(aPage({
      title: TITLE,
      sections: [listing(["alfa"]), { heading: "Also Worth Knowing", vendors: ["bravo"] }],
    }));
    assert.deepEqual(movesWithNoDatedReason(listedTogether, rotatedIntoAnotherSection), ["bravo"]);
  });

  it("reads a vendor the page stops naming at all as unexplained", () => {
    const droppedEntirely = surfacesOf(aPage({ title: TITLE, sections: [listing(["alfa"])] }));
    assert.deepEqual(movesWithNoDatedReason(listedTogether, droppedEntirely), ["bravo"]);
    assert.deepEqual(droppedEntirely.vendors, ["alfa"]);
  });

  it("reads a page whose own title covers a different day as free to name a different set", () => {
    const aDifferentDay = surfacesOf(aPage({
      title: "Best Free Widgets (2027)",
      sections: [listing(["alfa"]), { heading: "Also Worth Knowing", vendors: ["bravo"] }],
    }));
    assert.deepEqual(movesWithNoDatedReason(listedTogether, aDifferentDay), []);
  });

  it("reads a dated demotion the page lifts as explained on the day it was demoted", () => {
    const demotedWithADate = surfacesOf(aPage({
      title: TITLE,
      sections: [listing(["alfa"])],
      demoted: [{ vendor: "bravo", reason: DATED }],
    }));
    assert.deepEqual(movesWithNoDatedReason(demotedWithADate, listedTogether), []);
  });

  it("reads a section that names the window it covers as free to stop naming someone", () => {
    const windowed = (vendors: string[]) => ({
      heading: "Recently Discovered",
      note: "2 changes we found in the last 30 days whose effective date the vendor's page does not state.",
      vendors,
    });
    const inTheWindow = surfacesOf(aPage({ title: TITLE, sections: [windowed(["alfa", "bravo"])] }));
    const outOfIt = surfacesOf(aPage({ title: TITLE, sections: [windowed(["alfa"])] }));
    assert.deepEqual(vendorsNoLongerNamed(inTheWindow, outOfIt), []);
    assert.deepEqual(movesWithNoDatedReason(inTheWindow, outOfIt), []);
  });

  it("reads a dated log that never drops a record as no bar to a windowed section's exemption", () => {
    const windowed = (vendors: string[]) => ({
      heading: "At Risk",
      note: `Named here while a demotion is in force — an event in the last 180 days, or a standing condition.`,
      vendors,
    });
    const log = { heading: "Change Timeline", note: A_COMPLETE_LOG_NOTICE, vendors: ["alfa", "bravo"] };
    const inTheWindow = surfacesOf(aPage({ title: TITLE, sections: [windowed(["alfa", "bravo"]), log] }));
    const outOfIt = surfacesOf(aPage({ title: TITLE, sections: [windowed(["alfa"]), log] }));
    assert.deepEqual(movesWithNoDatedReason(inTheWindow, outOfIt), []);

    const undeclared = { ...log, note: "The changes we hold for this category, newest first." };
    const alsoNamedWithNoWindow = surfacesOf(aPage({ title: TITLE, sections: [windowed(["alfa", "bravo"]), undeclared] }));
    const droppedThere = surfacesOf(aPage({ title: TITLE, sections: [windowed(["alfa"]), undeclared] }));
    assert.deepEqual(movesWithNoDatedReason(alsoNamedWithNoWindow, droppedThere), ["bravo"]);
  });

  it("reads a name held only by a section that declares itself a log as earning no exemption", () => {
    const log = (vendors: string[]) => ({ heading: "Change Timeline", note: A_COMPLETE_LOG_NOTICE, vendors });
    const named = surfacesOf(aPage({ title: TITLE, sections: [listing(["alfa"]), log(["bravo"])] }));
    const gone = surfacesOf(aPage({ title: TITLE, sections: [listing(["alfa"])] }));
    assert.deepEqual(vendorsNoLongerNamed(named, gone), ["bravo"]);
  });

  it("reads a section that names no window as not free to stop naming someone", () => {
    const droppedEntirely = surfacesOf(aPage({ title: TITLE, sections: [listing(["alfa"])] }));
    assert.deepEqual(vendorsNoLongerNamed(listedTogether, droppedEntirely), ["bravo"]);
  });

  it("reads a vendor it demoted with a date yesterday as accounted for when it drops", () => {
    const demotedWithADate = surfacesOf(aPage({
      title: TITLE,
      sections: [listing(["alfa"])],
      demoted: [{ vendor: "bravo", reason: DATED }],
    }));
    const gone = surfacesOf(aPage({ title: TITLE, sections: [listing(["alfa"])] }));
    assert.deepEqual(vendorsNoLongerNamed(demotedWithADate, gone), []);
    assert.deepEqual(vendorsNoLongerNamed(gone, demotedWithADate), ["bravo"]);
  });

  it("reads a sentence that changes with a date in it as the page dating the change", () => {
    const said = surfacesOf(aPage({ title: TITLE, description: "We hold 2 offers here.", sections: [listing(["alfa", "bravo"])] }));
    const dated = surfacesOf(aPage({
      title: TITLE,
      description: "We hold 2 offers here. We could not read the page we cite for bravo when we last looked, on 2026-09-09.",
      sections: [listing(["alfa", "bravo"])],
    }));
    assert.deepEqual(sentencesItChangedWithoutSayingWhy(said, dated), []);
  });

  it("reads a sentence that only recounts a figure as the page recounting, not renaming", () => {
    const said = surfacesOf(aPage({ title: TITLE, description: "We hold 2 offers here.", sections: [listing(["alfa", "bravo"])] }));
    const recounted = surfacesOf(aPage({ title: TITLE, description: "We hold 3 offers here.", sections: [listing(["alfa", "bravo"])] }));
    assert.deepEqual(sentencesItChangedWithoutSayingWhy(said, recounted), []);
  });

  it("reads a sentence that says something else tomorrow as the page not saying why", () => {
    const said = surfacesOf(aPage({ title: TITLE, description: "We hold 2 offers here.", sections: [listing(["alfa", "bravo"])] }));
    const rewritten = surfacesOf(aPage({
      title: TITLE,
      description: "We hold 2 offers here. 1 of them dropped off the ranked list.",
      sections: [listing(["alfa", "bravo"])],
    }));
    assert.deepEqual(sentencesItChangedWithoutSayingWhy(said, rewritten), ["# of them dropped off the ranked list."]);
  });
});

describe("the rule that decides it is published where a reader can find it", () => {
  it("states the rule and the reason no field replaces it on /criteria", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "named-subsets-criteria-"));
    const { proc, base } = await startServer(path.join(scratch, "inventory.json"), 0);
    try {
      const body = await (await fetch(`${base}/criteria`)).text();
      const text = stripTags(body);
      assert.ok(text.includes(NAMED_SUBSET_RULE), "/criteria does not state the rule the pages follow");
      assert.ok(text.includes(NAMED_SUBSET_FIELD_RULE), "/criteria does not say why no field picks the members instead");
      assert.ok(body.includes('id="subsets"'), "nothing on a page can link to the rule it says it follows");
    } finally {
      proc.kill();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("prints on the home page as many changes as the length it states, or every one it holds", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "named-subsets-home-"));
    const { proc, base } = await startServer(path.join(scratch, "inventory.json"), 0);
    try {
      const body = await (await fetch(`${base}/`)).text();
      const onThisDay = new Date().toISOString().slice(0, 10);
      const held = loadDealChanges();
      const sections = [
        {
          id: "changing-soon",
          entry: "cs-entry",
          states: atMostShownHere(UPCOMING_DEADLINES_ON_THE_HOME_PAGE),
          cap: UPCOMING_DEADLINES_ON_THE_HOME_PAGE,
          qualifying: held.filter(change => change.date > onThisDay).length,
        },
        {
          id: "recent-changes",
          entry: "rc-entry",
          states: onlyTheMostRecentShown(RECENT_CHANGES_ON_THE_HOME_PAGE),
          cap: RECENT_CHANGES_ON_THE_HOME_PAGE,
          qualifying: held.filter(change => change.date <= onThisDay).length,
        },
      ];
      for (const section of sections) {
        const at = body.indexOf(`id="${section.id}"`);
        assert.ok(at !== -1, `the home page serves no section with id="${section.id}", so nothing below reads its stated length`);
        const ends = body.indexOf('<div class="divider">', at);
        const region = body.slice(at, ends === -1 ? undefined : ends);
        assert.ok(
          stripTags(region).includes(section.states),
          `"${section.id}" does not print "${section.states}", so a reader cannot tell a full list from a truncated one`,
        );
        const printed = [...region.matchAll(new RegExp(`class="${section.entry}"`, "g"))].length;
        assert.equal(
          printed,
          Math.min(section.cap, section.qualifying),
          `"${section.id}" states a length of ${section.cap} and holds ${section.qualifying} that qualify, and prints ${printed}`,
        );
      }
    } finally {
      proc.kill();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("publishes, in the sentence a section prints, the window that section's own filter reads", () => {
    assert.ok(
      NO_DEMOTION_IN_FORCE_RULE.includes(`in the last ${RECENT_CHANGE_WINDOW_DAYS} days`),
      "Stable Picks prints a window its own recent-change filter does not use",
    );
    assert.ok(
      A_DEMOTION_IN_FORCE_RULE.includes(`in the last ${VERDICT_WINDOW_DAYS} days`),
      "At-Risk Vendors prints a window the verdict engine does not use",
    );

    const dated = (daysAgo: number) =>
      new Date(Date.now() - daysAgo * A_DAY_IN_MS).toISOString().slice(0, 10);
    const newestChangeFor = new Map<string, string>();
    for (const change of loadDealChanges()) {
      const key = change.vendor.toLowerCase();
      if (change.date > (newestChangeFor.get(key) ?? "")) newestChangeFor.set(key, change.date);
    }
    const inside = dated(RECENT_CHANGE_WINDOW_DAYS - 1);
    const outside = dated(RECENT_CHANGE_WINDOW_DAYS + 1);
    const disagreeing = enrichOffers(loadOffers()).filter(offer => {
      const newest = newestChangeFor.get(offer.vendor.toLowerCase());
      if (newest === undefined || (newest > outside && newest < inside)) return false;
      return (newest >= inside) !== (offer.recent_change !== null);
    });
    assert.deepEqual(
      disagreeing.slice(0, 4).map(offer => `${offer.vendor}: newest ${newestChangeFor.get(offer.vendor.toLowerCase())}`),
      [],
      `${disagreeing.length} offers carry a recent_change the published ${RECENT_CHANGE_WINDOW_DAYS}-day sentence does not account for, so a section states one window and filters on another`,
    );
  });
});

const ABOVE_ANY_CAP = ["cloudflare-d1", "cloudflare-workers"];
const BELOW_EVERY_CAP = ["qdrant", "kaggle"];

interface TieBreakBlock { tie_count: number; ranked_total: number }
interface ApiDetails { offer: { vendor: string }; relatedVendors: string[]; alternatives: { vendor: string }[]; tie_break: TieBreakBlock }
interface ApiVendorRisk { alternatives: { vendor: string }[]; tie_break: TieBreakBlock }
interface ApiStack { stack: { role: string; reason: string; candidates: unknown[]; tie_break: TieBreakBlock }[] }

async function mcpSession(base: string): Promise<{ endpoint: string; headers: Record<string, string> }> {
  const endpoint = `${base}/mcp`;
  const accept = "application/json, text/event-stream";
  const init = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: accept },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "named-subsets", version: "1.0.0" } } }),
  });
  const headers = { "Content-Type": "application/json", Accept: accept, "Mcp-Session-Id": init.headers.get("mcp-session-id") ?? "" };
  await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  return { endpoint, headers };
}

function jsonRpcResult(body: string): { result?: { contents?: { text?: string }[]; content?: { text?: string }[] } } {
  const line = body.split("\n").find((l) => l.startsWith("data: ")) ?? body;
  return JSON.parse(line.replace(/^data: /, ""));
}

async function callMcpTool(base: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const { endpoint, headers } = await mcpSession(base);
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
  });
  return JSON.parse(jsonRpcResult(await res.text()).result?.content?.[0]?.text ?? "{}");
}

async function readMcpResources(base: string, uris: string[]): Promise<Map<string, string>> {
  const { endpoint, headers } = await mcpSession(base);
  const read = new Map<string, string>();
  for (const uri of uris) {
    const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri } }) });
    read.set(uri, jsonRpcResult(await res.text()).result?.contents?.[0]?.text ?? "");
  }
  return read;
}

describe("every door that names alternatives names the whole ranked order", () => {
  const namesFrom = (list: { vendor: string }[]): string[] => list.map((a) => a.vendor).sort();

  it("names every alternative it ranked, at both JSON doors, for every vendor the catalogue holds", () => {
    const offers = loadOffers();
    const vendors = [...new Map(offers.map((o) => [o.vendor.trim().toLowerCase(), o.vendor])).values()];
    const short: string[] = [];
    const disagreeing: string[] = [];
    const undercounted: string[] = [];
    let read = 0;

    for (const vendor of vendors) {
      const details = getOfferDetails(vendor, true);
      if ("error" in details) continue;
      read++;
      const ranked = details.offer.tie_break.ranked_total;
      const candidates = substitutesFor(offers, offers.find((o) => o.vendor === vendor)!).length;
      const alternatives = details.offer.alternatives ?? [];

      if (ranked !== candidates) undercounted.push(`${vendor} ranked ${ranked} of ${candidates} substitutes`);
      if (ranked < details.offer.tie_break.tie_count) undercounted.push(`${vendor} ranked ${ranked} under a tie of ${details.offer.tie_break.tie_count}`);
      if (alternatives.length !== ranked) short.push(`/api/details ${vendor} names ${alternatives.length} of ${ranked}`);
      if (details.offer.relatedVendors.length !== ranked) short.push(`relatedVendors ${vendor} names ${details.offer.relatedVendors.length} of ${ranked}`);

      const risk = checkVendorRisk(vendor);
      if ("error" in risk) continue;
      const riskRanked = risk.result.tie_break.ranked_total;
      if (risk.result.alternatives.length !== riskRanked) short.push(`/api/vendor-risk ${vendor} names ${risk.result.alternatives.length} of ${riskRanked}`);
      if (namesFrom(alternatives).join("|") !== namesFrom(risk.result.alternatives).join("|")) {
        disagreeing.push(`${vendor}: details names ${alternatives.length}, vendor-risk names ${risk.result.alternatives.length}`);
      }
    }

    assertCoversPopulation(read, vendorsInTheCatalogue(), "vendors read through both JSON doors");
    assert.deepEqual(undercounted.slice(0, 5), [], `a door ranked fewer entries than the catalogue holds substitutes for (${undercounted.length} vendors)`);
    assert.deepEqual(short.slice(0, 5), [], `a door named a prefix of the order it ranked (${short.length} doors)`);
    assert.deepEqual(disagreeing.slice(0, 5), [], `the two JSON doors named different alternatives for the same vendor (${disagreeing.length} vendors)`);
  });

  it("answers a vendor with more alternatives than any cap the same way at all three doors", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "named-subsets-doors-"));
    const { proc, base } = await startServer(path.join(scratch, "inventory.json"), 0);
    try {
      for (const slug of ABOVE_ANY_CAP) {
        const details = await (await fetch(`${base}/api/details/${slug}?alternatives=true`)).json() as ApiDetails;
        const named = details.alternatives.length;
        assert.ok(named > 5, `${slug} must hold more alternatives than the largest cap for this to be a control, got ${named}`);
        assert.equal(named, details.tie_break.ranked_total, `/api/details/${slug} names ${named} of the ${details.tie_break.ranked_total} it ranked`);
        assert.deepEqual(details.alternatives.map((a) => a.vendor), details.relatedVendors, `/api/details/${slug} disagrees with its own relatedVendors`);

        const risk = await (await fetch(`${base}/api/vendor-risk/${encodeURIComponent(details.offer.vendor)}`)).json() as ApiVendorRisk;
        assert.equal(risk.alternatives.length, risk.tie_break.ranked_total, `/api/vendor-risk/${details.offer.vendor} names ${risk.alternatives.length} of the ${risk.tie_break.ranked_total} it ranked`);
        assert.deepEqual(namesFrom(risk.alternatives), namesFrom(details.alternatives), `the two JSON doors name different alternatives for ${slug}`);

        const page = await (await fetch(`${base}/vendor/${slug}`)).text();
        const section = page.slice(page.indexOf('<h2 id="alternatives">'));
        const claim = section.match(/The list above is every one of the (\d+) entries in that order, not a prefix of it\./);
        assert.ok(claim, `/vendor/${slug} publishes no claim about how much of the order it shows`);
        assert.equal(Number(claim[1]), named, `/vendor/${slug} shows ${claim[1]} alternatives where its own JSON names ${named}`);
        const onThePage = [...section.matchAll(/<td><a href="\/vendor\/([a-z0-9.-]+)">/g)].map((m) => m[1]).sort();
        assert.deepEqual(namesFrom(details.alternatives).map(toSlug).sort(), onThePage, `/api/details/${slug} and /vendor/${slug} name different alternatives`);
      }
    } finally {
      proc.kill();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("answers a vendor holding fewer alternatives than any cap the same way at all three doors", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "named-subsets-under-"));
    const { proc, base } = await startServer(path.join(scratch, "inventory.json"), 0);
    try {
      for (const slug of BELOW_EVERY_CAP) {
        const details = await (await fetch(`${base}/api/details/${slug}?alternatives=true`)).json() as ApiDetails;
        const named = details.alternatives.length;
        assert.ok(named > 0 && named <= 3, `${slug} must hold at most the smallest cap for this to be a control, got ${named}`);
        assert.equal(named, details.tie_break.ranked_total, `/api/details/${slug} names ${named} of the ${details.tie_break.ranked_total} it ranked`);
        const risk = await (await fetch(`${base}/api/vendor-risk/${encodeURIComponent(details.offer.vendor)}`)).json() as ApiVendorRisk;
        assert.deepEqual(namesFrom(risk.alternatives), namesFrom(details.alternatives), `the two JSON doors name different alternatives for ${slug}`);
      }
    } finally {
      proc.kill();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("publishes on every stack role the same total its own reason states", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "named-subsets-stack-"));
    const { proc, base } = await startServer(path.join(scratch, "inventory.json"), 0);
    try {
      const stack = await (await fetch(`${base}/api/stack?use_case=saas`)).json() as ApiStack;
      assert.ok(stack.stack.length > 0, "/api/stack names no role, so it states no total");
      for (const role of stack.stack) {
        const stated = role.reason.match(/(\d+) of (\d+) .* carry no recorded demerit/);
        assert.ok(stated, `the ${role.role} role states no total for the order it picked from`);
        assert.equal(role.tie_break.tie_count, Number(stated[1]), `the ${role.role} role publishes a tie of ${role.tie_break.tie_count} and says ${stated[1]}`);
        assert.equal(role.tie_break.ranked_total, Number(stated[2]), `the ${role.role} role publishes a total of ${role.tie_break.ranked_total} and says ${stated[2]}`);
        assert.ok(role.tie_break.ranked_total >= role.candidates.length, `the ${role.role} role names ${role.candidates.length} out of a published total of ${role.tie_break.ranked_total}`);
      }
    } finally {
      proc.kill();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("names on the MCP search tool every alternative its own JSON door names", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "named-subsets-tool-"));
    const { proc, base } = await startServer(path.join(scratch, "inventory.json"), 0);
    try {
      for (const slug of [...ABOVE_ANY_CAP, ...BELOW_EVERY_CAP]) {
        const details = await (await fetch(`${base}/api/details/${slug}?alternatives=true`)).json() as ApiDetails;
        const answered = await callMcpTool(base, "search_deals", { vendor: details.offer.vendor }) as { alternatives?: { vendor: string }[]; tie_break: TieBreakBlock };
        const named = answered.alternatives ?? [];
        assert.equal(named.length, answered.tie_break.ranked_total, `search_deals names ${named.length} of the ${answered.tie_break.ranked_total} it ranked for ${slug}`);
        assert.deepEqual(namesFrom(named), namesFrom(details.alternatives), `search_deals and /api/details name different alternatives for ${slug}`);
      }
    } finally {
      proc.kill();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("names the whole order on the MCP vendor resource and says that is what it is", async () => {
    const offers = loadOffers();
    const slugs = [...ABOVE_ANY_CAP, ...BELOW_EVERY_CAP];
    const scratch = mkdtempSync(path.join(tmpdir(), "named-subsets-mcp-"));
    const { proc, base } = await startServer(path.join(scratch, "inventory.json"), 0);
    try {
      const read = await readMcpResources(base, slugs.map((s) => `agentdeals://vendor/${s}`));
      for (const slug of slugs) {
        const match = offers.find((o) => toSlug(o.vendor) === slug)!;
        const text = read.get(`agentdeals://vendor/${slug}`) ?? "";
        const details = getOfferDetails(match.vendor, true);
        assert.ok(!("error" in details), `${slug} is not answered by /api/details`);
        const alternatives = ("offer" in details ? details.offer.alternatives : []) ?? [];
        assert.ok(alternatives.length > 0, `${slug} names no alternatives, so the MCP resource has nothing to be read against`);
        assert.ok(text.includes(wholeRankedOrderList(alternatives.length)), `the MCP vendor resource for ${slug} does not say how much of the order it names`);
        for (const a of alternatives) {
          assert.ok(text.includes(`- **${a.vendor}**`), `the MCP vendor resource for ${slug} does not name ${a.vendor}, which its own JSON door does`);
        }
      }
    } finally {
      proc.kill();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

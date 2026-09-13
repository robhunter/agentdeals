import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoversPopulation, assertPopulationFloor, vendorsInTheCatalogue } from "./population-floor.ts";
import { NAMED_SUBSET_RULE, NAMED_SUBSET_FIELD_RULE } from "../dist/ranking.js";
import { toSlug } from "../dist/slug.js";

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
const CLOCK_BASE_DAYS = Number(process.env.AGENTDEALS_CLOCK_BASE_DAYS ?? 0);

interface Surfaces {
  title: string | null;
  regions: Record<string, string[]>;
  vendors: string[];
  vendorSequence: string[];
  demotedHeadingFound: boolean;
  windowedHeadings: string[];
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

function headingsOf(html: string): { at: number; text: string }[] {
  return [...html.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/g)].map(m => ({ at: m.index!, text: stripTags(m[1]!) }));
}

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

function headingsCoveringARollingWindow(body: string): string[] {
  const headings = headingsOf(body);
  return headings
    .filter((heading, at) => A_ROLLING_WINDOW.test(stripTags(body.slice(heading.at, headings[at + 1]?.at ?? body.length))))
    .map(heading => heading.text);
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
    windowedHeadings: headingsCoveringARollingWindow(body),
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

function vendorsThatChangeHeading(before: Surfaces, after: Surfaces): string[] {
  return [...new Set([...before.vendors, ...after.vendors])]
    .filter(vendor => headingsNaming(before, vendor) !== headingsNaming(after, vendor))
    .sort();
}

function namedOnlyUnderARollingWindow(surfaces: Surfaces, vendor: string): boolean {
  const headings = Object.entries(surfaces.regions)
    .filter(([, vendors]) => vendors.includes(vendor))
    .map(([heading]) => heading);
  return headings.length > 0 && headings.every(heading => surfaces.windowedHeadings.includes(heading));
}

function datedDemotionFor(surfaces: Surfaces, vendor: string): boolean {
  return (surfaces.datesBehindEachDemotion[vendor] ?? []).length > 0;
}

function movesWithNoDatedReason(before: Surfaces, after: Surfaces): string[] {
  if (coversADifferentDay(before, after)) return [];
  return vendorsThatChangeHeading(before, after).filter(vendor => {
    if (namedOnlyUnderARollingWindow(before, vendor) || namedOnlyUnderARollingWindow(after, vendor)) return false;
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
  const gained = after.vendors.filter(vendor => !before.vendors.includes(vendor) && !namedOnlyUnderARollingWindow(after, vendor));
  const lost = before.vendors.filter(vendor =>
    !after.vendors.includes(vendor)
    && !namedOnlyUnderARollingWindow(before, vendor)
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
      description: "We hold 2 offers here. 1 has not been re-confirmed recently enough.",
      sections: [listing(["alfa", "bravo"])],
    }));
    assert.deepEqual(sentencesItChangedWithoutSayingWhy(said, rewritten), ["# has not been re-confirmed recently enough."]);
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
});

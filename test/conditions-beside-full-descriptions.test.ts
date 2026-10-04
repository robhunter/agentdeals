import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

type Offer = import("../src/types.ts").Offer;
type DealChange = import("../src/types.ts").DealChange;
type ListingCondition = import("../src/types.ts").ListingCondition;

const { supersedingChange } = await import("../dist/superseded-description.js");
const { offerRetired } = await import("../dist/retirement.js");
const { LISTING_CONDITIONS_CLASS } = await import("../dist/listing-conditions.js");

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = new Date().toISOString().slice(0, 10);
const CONDITIONS_PAGE = "https://conditions.example/terms";

const catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
const changeLog: DealChange[] = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes;

const changesByVendor = new Map<string, DealChange[]>();
for (const change of changeLog) {
  const key = change.vendor.toLowerCase();
  changesByVendor.set(key, [...(changesByVendor.get(key) ?? []), change]);
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

function codeFor(index: number): string {
  return LETTERS[Math.floor(index / 676) % 26]! + LETTERS[Math.floor(index / 26) % 26]! + LETTERS[index % 26]!;
}

const DESCRIPTION_TOKEN = "Zqd";
const CONDITION_TOKEN = "Zqc";
const SET_ASIDE_TOKEN = "Zqs";
const ANY_DESCRIPTION_TOKEN = /Zq[ds]([a-z]{3})\.(?!\.)/g;

function withTokenAtTheEnd(description: string, token: string): string {
  return `${description.endsWith(".") ? description.slice(0, -1) : description} ${token}.`;
}

function conditionNaming(token: string): ListingCondition {
  return { text: `The free plan carries condition ${token}.`, quote: `Condition ${token} applies.`, url: CONDITIONS_PAGE, read_on: TODAY };
}

type Role = "conditions" | "set aside";

interface Planted {
  vendor: string;
  role: Role;
}

const planted = new Map<string, Planted>();

const scratchOffers: Offer[] = catalogue.offers.map((offer: Offer, index: number) => {
  const code = codeFor(index);
  if (offerRetired(offer) || supersedingChange(offer, changesByVendor.get(offer.vendor.toLowerCase()) ?? [])) {
    planted.set(code, { vendor: offer.vendor, role: "set aside" });
    return { ...offer, conditions: [conditionNaming(SET_ASIDE_TOKEN + code)] };
  }
  planted.set(code, { vendor: offer.vendor, role: "conditions" });
  return {
    ...offer,
    description: withTokenAtTheEnd(offer.description, DESCRIPTION_TOKEN + code),
    conditions: [conditionNaming(CONDITION_TOKEN + code)],
  };
});

const unconditionedOffers: Offer[] = catalogue.offers.map((offer: Offer) => {
  const { conditions: _none, ...withoutConditions } = offer;
  return withoutConditions as Offer;
});

const dir = mkdtempSync(path.join(tmpdir(), "conditions-beside-descriptions-"));

function scratchCatalogue(name: string, offers: Offer[]): string {
  const indexPath = path.join(dir, name);
  writeFileSync(indexPath, JSON.stringify({ ...catalogue, offers }));
  return indexPath;
}

const scratchIndex = scratchCatalogue("conditioned.json", scratchOffers);
const unconditionedIndex = scratchCatalogue("unconditioned.json", unconditionedOffers);

function startServer(indexPath: string): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_INDEX_PATH: indexPath },
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server startup timeout")); }, 60000);
    child.stderr!.on("data", (buffer: Buffer) => {
      const found = buffer.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (found) { clearTimeout(timer); resolve({ proc: child, base: `http://localhost:${found[1]}` }); }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

const ROUTES_NO_SITEMAP_LISTS = ["/", "/estimate", "/budget-builder", "/compare-tool", "/stack-check"];

const THE_VENDOR_PAGE = "/vendor/";

function withoutTheHeadsSummaries(body: string): string {
  return body.replace(/<title>[\s\S]*?<\/title>/g, "").replace(/<meta\b[^>]*>/g, "");
}

async function routesToRead(base: string): Promise<string[]> {
  const index = await (await fetch(`${base}/sitemap.xml`)).text();
  const routes = new Set(ROUTES_NO_SITEMAP_LISTS);
  for (const sub of index.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const xml = await (await fetch(base + new URL(sub[1]!).pathname)).text();
    for (const loc of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const route = new URL(loc[1]!).pathname;
      if (!route.startsWith(THE_VENDOR_PAGE)) routes.add(route);
    }
  }
  return [...routes].sort();
}

interface Reading {
  route: string;
  code: string;
  after: string;
}

function readingsOf(route: string, body: string): Reading[] {
  const found = [...body.matchAll(ANY_DESCRIPTION_TOKEN)];
  return found.map((match, i) => ({
    route,
    code: match[1]!,
    after: body.slice(match.index! + match[0].length, i + 1 < found.length ? found[i + 1]!.index! : body.length),
  }));
}

interface ConditionPrinted {
  route: string;
  code: string;
  after: string | null;
}

function conditionsPrintedOn(route: string, body: string): ConditionPrinted[] {
  const descriptions = [...body.matchAll(ANY_DESCRIPTION_TOKEN)].map(match => ({ at: match.index!, code: match[1]! }));
  return [...body.matchAll(new RegExp(`${CONDITION_TOKEN}([a-z]{3})`, "g"))].map(match => ({
    route,
    code: match[1]!,
    after: descriptions.filter(description => description.at < match.index!).pop()?.code ?? null,
  }));
}

const ELEMENTS_A_LIST_MAY_NOT_STAND_IN = ["p", "span", "a", "strong", "em", "small", "b", "i", "code", "label", "button", "h1", "h2", "h3", "h4", "h5", "h6"];

function elementsHoldingAList(route: string, body: string): string[] {
  const markup = body.replace(/<script\b[\s\S]*?<\/script>/g, "");
  const holding: string[] = [];
  for (const list of markup.matchAll(new RegExp(`<ul class="${LISTING_CONDITIONS_CLASS}"`, "g"))) {
    const before = markup.slice(0, list.index);
    for (const element of ELEMENTS_A_LIST_MAY_NOT_STAND_IN) {
      const opened = Math.max(before.lastIndexOf(`<${element} `), before.lastIndexOf(`<${element}>`));
      if (opened > before.lastIndexOf(`</${element}>`)) holding.push(`${route}: <${element}>`);
    }
  }
  return holding;
}

describe("every route that prints a listing's description in full prints the listing's conditions right after it", () => {
  let server: { proc: ChildProcess; base: string };
  const readings: Reading[] = [];
  const conditionsSeen: ConditionPrinted[] = [];
  const setAsideSeen: string[] = [];
  const listsMisplaced: string[] = [];
  let routesRead = 0;

  before(async () => {
    server = await startServer(scratchIndex);
    for (const route of await routesToRead(server.base)) {
      const response = await fetch(server.base + route);
      if (response.status !== 200) continue;
      routesRead += 1;
      const body = withoutTheHeadsSummaries(await response.text());
      readings.push(...readingsOf(route, body).filter(reading => planted.get(reading.code)?.role !== "set aside"));
      conditionsSeen.push(...conditionsPrintedOn(route, body));
      listsMisplaced.push(...elementsHoldingAList(route, body));
      for (const match of body.matchAll(new RegExp(`${SET_ASIDE_TOKEN}([a-z]{3})`, "g"))) setAsideSeen.push(`${route}: ${planted.get(match[1]!)?.vendor}`);
    }
  });

  after(() => server?.proc.kill());

  it("reads enough routes and full descriptions for the sweep to be able to fail", () => {
    assertPopulationFloor(routesRead, 700, "routes read for a listing's description");
    assertPopulationFloor(new Set(readings.map(reading => reading.route)).size, 500, "routes printing a listing's description in full");
    assertPopulationFloor(readings.length, 6000, "full descriptions printed of listings that carry conditions");
  });

  it("follows each full description with that listing's conditions before the next listing begins", () => {
    const missing = new Map<string, Set<string>>();
    for (const reading of readings) {
      if (planted.get(reading.code)?.role !== "conditions") continue;
      if (reading.after.includes(CONDITION_TOKEN + reading.code)) continue;
      const vendors = missing.get(reading.route) ?? new Set<string>();
      missing.set(reading.route, vendors.add(planted.get(reading.code)!.vendor));
    }
    const lines = [...missing].map(([route, vendors]) => `${route}: ${[...vendors].slice(0, 3).join(", ")}${vendors.size > 3 ? ` and ${vendors.size - 3} more` : ""}`);
    assert.deepStrictEqual(lines, [], `${lines.length} routes print a full description without its conditions`);
  });

  it("prints a listing's conditions only right after its description in full", () => {
    assertPopulationFloor(conditionsSeen.length, 6000, "conditions printed on routes that print a description in full");
    const stray = conditionsSeen.filter(one => one.after !== one.code).map(one => `${one.route}: ${planted.get(one.code)?.vendor}`);
    assert.deepStrictEqual([...new Set(stray)], []);
  });

  it("sets every list of conditions where a list may stand, never inside a paragraph, a span or a link", () => {
    assert.deepStrictEqual([...new Set(listsMisplaced)], []);
  });


  it("prints no conditions for a listing whose offer has ended or whose stored terms a later change supersedes", () => {
    assertPopulationFloor([...planted.values()].filter(one => one.role === "set aside").length, 1, "listings that have ended or whose stored terms are superseded");
    assert.deepStrictEqual([...new Set(setAsideSeen)], []);
  });
});

describe("a catalogue in which no listing states conditions", () => {
  let server: { proc: ChildProcess; base: string };
  const listed: string[] = [];
  let routesRead = 0;

  before(async () => {
    server = await startServer(unconditionedIndex);
    for (const route of await routesToRead(server.base)) {
      const response = await fetch(server.base + route);
      if (response.status !== 200) continue;
      routesRead += 1;
      if ((await response.text()).includes(`class="${LISTING_CONDITIONS_CLASS}"`)) listed.push(route);
    }
  });

  after(() => server?.proc.kill());

  it("prints no list of conditions on any route", () => {
    assertPopulationFloor(routesRead, 700, "routes read for a list of conditions");
    assert.deepStrictEqual(listed, []);
  });
});

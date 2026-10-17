import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadOffers } from "../dist/data.js";
import { assertPopulationFloor } from "./population-floor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const CARD = /<a href="\/vendor\/[^"]+" class="best-pick-name">([^<]*)<\/a>[\s\S]*?<div class="best-pick-tier">([^<]*)<\/div>\s*<p class="best-pick-review">([\s\S]*?)<\/p>/g;
const GUESSED_AUDIENCE = /Best for/;

let proc: ChildProcess | null = null;
let port = 0;

const get = async (p: string) => (await fetch(`http://localhost:${port}${p}`)).text();

before(async () => {
  const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
  });
  proc = child;
  port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve(parseInt(m[1], 10)); }
    });
  });
});

after(() => { proc?.kill(); });

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const offers = loadOffers();
const listingOf = (name: string, tier: string) => offers.find((o) => escHtml(o.vendor) === name && escHtml(o.tier) === tier);

async function bestRoutes(): Promise<string[]> {
  const locs = async (sitemap: string) => [...(await get(sitemap)).matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => new URL(loc).pathname);
  const routes: string[] = [];
  for (const sitemap of await locs("/sitemap.xml")) routes.push(...(await locs(sitemap)).filter((route) => route.startsWith("/best/")));
  return [...new Set(routes)];
}

function cardsOf(page: string): Array<{ name: string; tier: string; review: string }> {
  return [...page.matchAll(CARD)].map(([, name, tier, review]) => ({ name, tier, review }));
}

function afterTheDescription(card: { name: string; tier: string; review: string }): string | null {
  const listing = listingOf(card.name, card.tier);
  if (!listing) return null;
  const described = escHtml(listing.description);
  return card.review.startsWith(described) ? card.review.slice(described.length) : null;
}

describe("/best/ cards print each listing's own words and guess no audience from them", () => {
  it("follows no card's description with a \"Best for\" sentence on any /best/ route", async () => {
    const routes = await bestRoutes();
    assertPopulationFloor(routes.length, 50, "/best/ routes in the sitemaps");
    const guessing: string[] = [];
    let cardsReadingTheirDescription = 0;
    for (const route of routes) {
      for (const card of cardsOf(await get(route))) {
        const rest = afterTheDescription(card);
        if (rest === null) continue;
        cardsReadingTheirDescription++;
        if (GUESSED_AUDIENCE.test(rest)) guessing.push(`${route} ${card.name}: ${rest.slice(0, 80)}`);
      }
    }
    assertPopulationFloor(cardsReadingTheirDescription, 1000, "/best/ cards that print their listing's description");
    assert.deepStrictEqual(guessing, []);
  });

  it("prints Google Gemini API's description on /best/free-llm-api with no \"Best for\" after it", async () => {
    const gemini = cardsOf(await get("/best/free-llm-api")).find((card) => card.name === "Google Gemini API");
    assert.ok(gemini, "/best/free-llm-api has no Google Gemini API card");
    const rest = afterTheDescription(gemini);
    assert.notStrictEqual(rest, null, "the Google Gemini API card does not open with its listing's description");
    assert.doesNotMatch(rest!, GUESSED_AUDIENCE);
  });
});

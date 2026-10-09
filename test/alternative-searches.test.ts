import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { searchOffers, loadOffers, loadDealChanges, vendorWhoseAlternativesAQueryAsksFor } from "../dist/data.js";
import { substitutesListedFor } from "../dist/vendor-substitutes.js";
import { vendorPhraseOfAnAlternativesQuery } from "../dist/alternatives-query.js";
import { vendorSlugMap } from "../dist/vendor-slug.js";
import { sanitizeQuery } from "../dist/search-query.js";
import { assertPopulationFloor } from "./population-floor.ts";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const pagesListing = () => {
  const changes = loadDealChanges();
  const catalogue = loadOffers();
  const pages: { slug: string; vendor: string; listed: Set<string> }[] = [];
  for (const [slug, vendor] of vendorSlugMap) {
    const listed = substitutesListedFor(vendor, changes, catalogue);
    if (listed.length > 0) pages.push({ slug, vendor, listed: new Set(listed.map((o: { vendor: string }) => o.vendor)) });
  }
  return pages;
};

const vendorsFound = (query: string) => searchOffers(sanitizeQuery(query)).map((o: { vendor: string }) => o.vendor);

describe("a search that asks for a vendor's alternatives", () => {
  it("reads the vendor out of each way of asking", () => {
    assert.strictEqual(vendorPhraseOfAnAlternativesQuery("sendgrid alternative"), "sendgrid");
    assert.strictEqual(vendorPhraseOfAnAlternativesQuery("Redis Cloud alternatives"), "Redis Cloud");
    assert.strictEqual(vendorPhraseOfAnAlternativesQuery("alternative to mongodb atlas"), "mongodb atlas");
    assert.strictEqual(vendorPhraseOfAnAlternativesQuery("alternatives to  SendGrid "), "SendGrid");
    assert.strictEqual(vendorPhraseOfAnAlternativesQuery("alternatives for Heroku"), "Heroku");
  });

  it("reads nothing out of a search that does not ask for alternatives", () => {
    for (const query of ["sendgrid", "alternatives", "alternative", "free email api", "alternative email providers"]) {
      assert.strictEqual(vendorPhraseOfAnAlternativesQuery(query), null, query);
    }
  });

  it("names only a vendor we list", () => {
    assert.strictEqual(vendorWhoseAlternativesAQueryAsksFor("postmark alternative"), "Postmark");
    assert.strictEqual(vendorWhoseAlternativesAQueryAsksFor("alternative to redis cloud"), "Redis Cloud");
    assert.strictEqual(vendorWhoseAlternativesAQueryAsksFor("nosuchvendorxyz alternative"), null);
  });

  it("returns a vendor the alternatives page lists, for every vendor with an alternatives page and each way of asking", () => {
    const pages = pagesListing();
    assertPopulationFloor(pages.length, 175, "vendors with an alternatives page");
    const missed: string[] = [];
    for (const { vendor, listed } of pages) {
      for (const query of [`${vendor} alternative`, `${vendor} alternatives`, `alternative to ${vendor}`]) {
        if (!vendorsFound(query).some((found) => listed.has(found))) missed.push(query);
      }
    }
    assert.deepStrictEqual(missed, []);
  });

  it("lists the vendors the page lists ahead of other matches", () => {
    const postman = pagesListing().find((p) => p.vendor === "Postman");
    assert.ok(postman, "Postman has no alternatives page");
    const listedInTurn = vendorsFound("postman alternative").map((vendor) => postman.listed.has(vendor));
    assert.ok(listedInTurn.includes(true) && listedInTurn.includes(false), "the search no longer returns both kinds of result");
    assert.deepStrictEqual(listedInTurn, [...listedInTurn].sort((a, b) => Number(b) - Number(a)));
  });

  it("still returns what these searches returned before", () => {
    const localstack = vendorsFound("localstack alternative");
    assert.ok(localstack.includes("CloudDev") && localstack.includes("Floci"), localstack.join(", "));
    const postman = vendorsFound("postman alternative");
    assert.ok(postman.includes("Bruno") && postman.includes("Hoppscotch"), postman.join(", "));
  });

  it("keeps the other filters", () => {
    const email = searchOffers(sanitizeQuery("amazon ses alternative"), "Email").map((o: { category: string }) => o.category);
    assert.ok(email.length > 0);
    assert.deepStrictEqual([...new Set(email)], ["Email"]);
    assert.deepStrictEqual(searchOffers(sanitizeQuery("amazon ses alternative"), "Databases"), []);
  });
});

describe("the search page and the API for a search that names a vendor", () => {
  let server: ChildProcess;
  let port = 0;

  before(async () => {
    ({ child: server, port } = await new Promise<{ child: ChildProcess; port: number }>((resolve, reject) => {
      const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
      });
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
      });
      child.on("error", (e) => { clearTimeout(timeout); reject(e); });
    }));
  });

  after(() => server?.kill());

  const page = async (query: string) => (await fetch(`http://localhost:${port}/search?q=${encodeURIComponent(query)}`)).text();

  it("links the vendor's alternatives page above the results", async () => {
    for (const query of ["amazon ses alternative", "alternative to Amazon SES", "amazon ses"]) {
      const html = await page(query);
      const link = html.indexOf('<a href="/alternative-to/amazon-ses">');
      assert.ok(link >= 0, `no link to /alternative-to/amazon-ses for "${query}"`);
      assert.ok(link < html.indexOf('<div class="results">'), `the link follows the results for "${query}"`);
    }
  });

  it("links no alternatives page for a search that names no vendor", async () => {
    assert.ok(!(await page("free email api")).includes('href="/alternative-to/'));
  });

  it("links no alternatives page for a vendor that has none", async () => {
    const withPages = new Set(pagesListing().map((p) => p.slug));
    const [slug, vendor] = [...vendorSlugMap].find(([s, name]) => !withPages.has(s) && /^[A-Za-z][A-Za-z0-9 ]+$/.test(name)) ?? [];
    assert.ok(slug, "every vendor has an alternatives page");
    assert.ok(!(await page(`${vendor} alternative`)).includes(`href="/alternative-to/${slug}"`));
  });

  it("answers the API with the alternatives the page lists", async () => {
    const served = await (await fetch(`http://localhost:${port}/api/offers?q=${encodeURIComponent("amazon ses alternative")}`)).json();
    const ses = pagesListing().find((p) => p.vendor === "Amazon SES")!;
    assert.ok(served.total > 0);
    assert.ok(served.offers.some((o: { vendor: string }) => ses.listed.has(o.vendor)));
  });
});

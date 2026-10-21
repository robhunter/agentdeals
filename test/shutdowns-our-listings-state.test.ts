import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { statedShutdowns, type DeadlineText } from "../dist/stated-deadlines.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function text(value: string, statedIn: DeadlineText["statedIn"] = "description"): DeadlineText {
  return { vendor: "Example Cloud", category: "Cloud Hosting", text: value, sourceUrl: "https://example.com/pricing", statedIn };
}

function dates(value: string): string[] {
  return statedShutdowns([text(value)], "2026-10-21").map(entry => entry.date);
}

describe("shutdown dates stated in listings", () => {
  for (const event of ["shuts down", "retires", "is retired", "reaches end of life", "ends support", "reaches end-of-support", "is discontinued"]) {
    it(`includes a future event that ${event}`, () => {
      assert.deepEqual(dates(`The API ${event} on 2026-10-31.`), ["2026-10-31"]);
    });
  }

  for (const event of ["starts billing", "changes price", "limits free users to 100 calls", "stops offering free credits"]) {
    it(`excludes a deadline that ${event}`, () => {
      assert.deepEqual(dates(`The service ${event} on 2026-10-31.`), []);
    });
  }

  it("keeps a shutdown when a condition gives a different kind of deadline on the same day", () => {
    const result = statedShutdowns([
      text("The API retires on 2026-10-31."),
      text("Free through 2026-10-30, billing starts on 2026-10-31.", "condition"),
    ], "2026-10-21");
    assert.deepEqual(result.map(entry => [entry.date, entry.statedIn]), [["2026-10-31", "description"]]);
  });

  it("takes a condition's source when it duplicates the description's shutdown", () => {
    const condition = { ...text("The API retires on 2026-10-31.", "condition"), sourceUrl: "https://example.com/retirement" };
    assert.deepEqual(statedShutdowns([text(condition.text), condition], "2026-10-21").map(entry => entry.sourceUrl), [condition.sourceUrl]);
  });

  it("does not turn a later deletion clause into a second shutdown", () => {
    assert.deepEqual(dates("Workflows shuts down on 2027-03-31; Workflows data is deleted by 2027-04-30."), ["2027-03-31"]);
  });

  it("keeps shutdowns of different models on consecutive days", () => {
    assert.deepEqual(dates("The small model retires on 2026-10-31. The large model retires on 2026-11-01."), ["2026-10-31", "2026-11-01"]);
  });

  it("keeps dated members of a retirement list and stops at ordinary prose", () => {
    assert.deepEqual(dates("Retired models include these. Small: example/small on 2026-10-31. Large: example/large on 2026-11-02. The company was founded in 2020. Launch: example/new on 2026-11-03."), ["2026-10-31", "2026-11-02"]);
  });

  it("excludes past events and read, check, publication and launch dates", () => {
    assert.deepEqual(dates("The old API retired on 2026-10-20. The new API retires on 2026-10-31 (checked 2026-10-28; its post of 2026-10-27 describes the move). Read 2026-10-29, the page says the API is retired. The replacement launched on 2026-10-30."), ["2026-10-31"]);
  });
});

function listing(vendor: string, description: string, conditions: unknown[] = [], tier = "Free") {
  return { vendor, description, conditions, tier, category: "Cloud Hosting", verifiedDate: "2026-10-01", url: `https://example.com/${vendor.toLowerCase().replaceAll(" ", "-")}/pricing` };
}

function condition(text: string, name: string) {
  return { text, quote: text, read_on: "2026-10-01", url: `https://example.com/${name}` };
}

function record(vendor: string, date: string) {
  return {
    vendor, date, category: "Cloud Hosting", change_type: "product_deprecated", recorded_date: "2026-10-01",
    summary: `${vendor}'s legacy API retires on ${date}.`, source_url: `https://example.com/${vendor}/notice`,
    impact: "high", previous_state: "Available.", current_state: "Retirement announced.", alternatives: [], listing_effect: "none",
  };
}

const conditions = [condition("A business account is required.", "business")];
const listings = [
  listing("Ona", "The free tier ended.", [condition("Ona Cloud shuts down on 2026-10-31.", "ona-cloud")], "Retired"),
  listing("Mistral AI", "A free API plan. GLM 5.2 retires on 2026-10-31."),
  listing("xAI", "grok-imagine-image-quality is retired on 2026-11-02."),
  listing("Amazon Q Developer", "AWS will end support for the IDE plugins on April 30, 2027, and points IDE users to Kiro."),
  listing("Upcoming Cloud", "The API is discontinued on 2026-12-20.", conditions),
  listing("First Unlisted Cloud", "The API shuts down on 2026-11-10."),
  listing("Second Unlisted Cloud", "The API shuts down on 2026-11-10."),
  listing("Retired Listing Cloud", "The legacy console shuts down on 2026-11-05.", [], "Retired"),
  listing("Past Cloud", "The API retired on 2026-10-20."),
  listing("Checked Cloud", "Checked 2026-11-10, the page lists a retired service."),
  listing("Published Cloud", "The post of 2026-11-10 describes the retired API."),
  listing("Launched Cloud", "The replacement launched on 2026-11-10. The old API is retired."),
  listing("Billing Cloud", "Free through 2026-11-01, then costs $2 from 2026-11-02."),
  listing("Quota Cloud", "The free plan stays until 2026-11-02, then allows 100 calls."),
  listing("apiary.io", "The legacy API shuts down on 2026-10-31."),
  listing("Prisma Accelerate", "Accelerate is retired on 2026-12-01."),
  listing("Pipedream", "Workflows shuts down on 2027-03-31; its data is deleted by 2027-04-30."),
  listing("smartlook.com", "The service is discontinued on 2027-09-30."),
  listing("OpenAI", "Legacy models shut down on 2026-10-23."),
];
const records = [record("apiary.io", "2026-10-31"), record("Prisma Accelerate", "2026-12-01"), record("Pipedream", "2027-03-31"), record("smartlook.com", "2027-09-30")];
const clocks = ["2026-10-21", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"];
const pages = new Map<string, string>();
const children: ChildProcess[] = [];
let scratch = "";

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function cardsOf(html: string) {
  let section = "";
  return html.split(/(?=<h2 id=")|(?=<div class="shutdown-card")/).flatMap(piece => {
    const heading = piece.match(/^<h2 id="([^"]+)"/);
    if (heading) section = heading[1];
    if (!piece.startsWith('<div class="shutdown-card"')) return [];
    return [{
      section, html: piece,
      name: textOf(piece.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? ""),
      date: textOf(piece.match(/<span class="deadline-icon">[^<]*<\/span>\s*<span>([^<]+)<\/span>/)?.[1] ?? ""),
      what: textOf(piece.match(/<p class="shutdown-what">([\s\S]*?)<\/p>/)?.[1] ?? ""),
    }];
  });
}

async function pageAt(day: string): Promise<string> {
  const child = spawn("node", ["--import", path.join(REPO, "scripts/shifted-clock.mjs"), path.join(REPO, "dist/serve.js")], {
    cwd: REPO, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_REFERRAL_HEALTH: "off",
      AGENTDEALS_CLOCK_SHIFT_MS: String(Date.parse(`${day}T12:00:00Z`) - Date.now()),
      AGENTDEALS_INDEX_PATH: path.join(scratch, "index.json"), AGENTDEALS_CHANGES_PATH: path.join(scratch, "changes.json") },
  });
  children.push(child);
  const port = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    let stderr = "";
    child.stderr!.on("data", chunk => {
      stderr += chunk.toString();
      const port = stderr.match(/running on http:\/\/localhost:(\d+)/)?.[1];
      if (port) { clearTimeout(timeout); resolve(port); }
    });
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("exit", code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${stderr}`)); });
  });
  const response = await fetch(`http://localhost:${port}/shutdowns`, { redirect: "error" });
  assert.equal(response.status, 200);
  return response.text();
}

describe("the shutdown tracker includes shutdowns stated only by listings", () => {
  before(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "listing-shutdowns-"));
    writeFileSync(path.join(scratch, "index.json"), JSON.stringify({ offers: listings }));
    writeFileSync(path.join(scratch, "changes.json"), JSON.stringify({ changes: records }));
    for (const day of clocks) pages.set(day, await pageAt(day));
  });
  after(() => {
    for (const child of children) child.kill();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("includes retired listings and uses each shutdown's own source and profile link", () => {
    const cards = cardsOf(pages.get(clocks[0])!);
    for (const vendor of ["Ona", "Mistral AI", "xAI", "Amazon Q Developer"]) {
      const offer = listings.find(offer => offer.vendor === vendor)!;
      const found = cards.filter(card => card.name === vendor);
      assert.equal(found.length, 1, vendor);
      assert.ok(found[0].html.includes(`href="${offer.conditions[0]?.url ?? offer.url}"`), vendor);
      assert.ok(found[0].html.includes("Vendor profile"), vendor);
    }
  });

  it("marks a retired listing's URL as a citation rather than an offer", () => {
    const card = cardsOf(pages.get(clocks[0])!).find(card => card.name === "Retired Listing Cloud")!;
    const url = listings.find(offer => offer.vendor === "Retired Listing Cloud")!.url;
    const link = card.html.match(new RegExp(`<a href="${url}"[^>]*>`))?.[0] ?? "";
    assert.ok(link.includes('class="record-source"'));
    assert.ok(link.includes('rel="nofollow noopener"'));
    assert.ok(card.html.includes('class="days-badge"'));
  });

  it("puts each date in order in its urgency group", () => {
    const cards = cardsOf(pages.get(clocks[0])!);
    assert.deepEqual(["Ona", "xAI", "Upcoming Cloud", "Amazon Q Developer"].map(name => cards.find(card => card.name === name)?.section), ["imminent", "imminent", "upcoming", "later"]);
    for (const section of ["imminent", "upcoming", "later", "completed"]) {
      const dates = cards.filter(card => card.section === section).map(card => Date.parse(card.date));
      assert.deepEqual(dates, [...dates].sort((a, b) => a - b));
    }
  });

  it("keeps separate unlisted vendors on the same day", () => {
    const cards = cardsOf(pages.get(clocks[0])!);
    for (const name of ["First Unlisted Cloud", "Second Unlisted Cloud"]) assert.equal(cards.filter(card => card.name === name).length, 1);
  });

  it("adds no second card where a record or a hand-typed card already covers the event", () => {
    const cards = cardsOf(pages.get(clocks[0])!);
    for (const vendor of ["apiary.io", "Prisma Accelerate", "Pipedream", "smartlook.com"]) {
      assert.equal(cards.filter(card => card.html.includes(`https://example.com/${vendor}/notice`)).length, 1, vendor);
      assert.ok(!cards.some(card => card.html.includes(`https://example.com/${vendor.toLowerCase().replaceAll(" ", "-")}/pricing`)), vendor);
    }
    assert.ok(!cards.some(card => card.html.includes("https://example.com/openai/pricing")));
  });

  it("excludes prices, quotas and metadata, and never leaves a past listing date active", () => {
    for (const day of clocks) {
      const cards = cardsOf(pages.get(day)!);
      assert.ok(!cards.some(card => /^(Past|Checked|Published|Launched|Billing|Quota) Cloud$/.test(card.name)), day);
      for (const card of cards.filter(card => card.section !== "completed")) assert.ok(Date.parse(card.date) >= Date.parse(day), `${day}: ${card.name}`);
      for (const [name, date] of [["Ona", "2026-10-31"], ["Mistral AI", "2026-10-31"], ["xAI", "2026-11-02"]]) {
        assert.equal(cards.filter(card => card.name === name).length, date > day ? 1 : 0, `${day}: ${name}`);
      }
    }
  });

  it("states when quoted listing entries leave and keeps the recorded-shutdown archive link", () => {
    for (const day of clocks) {
      const html = pages.get(day)!;
      const notice = html.match(/<p class="subtitle dated-rule">([\s\S]*?)<\/p>/)?.[1] ?? "";
      assert.ok(textOf(notice).includes(`Entries quoted from listings appear only while the stated date is later than ${day}.`));
      assert.ok(textOf(notice).replace(/ \./g, ".").includes("Recorded shutdowns move to Recently Completed, below."));
      assert.ok(notice.includes('href="#completed"'));
      assert.ok(notice.includes('href="/changes"'));
      assert.ok(!notice.includes("Nothing is removed"));
    }
  });

  it("carries conditions beside a whole description and in its structured description", () => {
    const page = pages.get(clocks[0])!;
    const card = cardsOf(page).find(card => card.name === "Upcoming Cloud")!;
    assert.ok(textOf(card.html).includes(conditions[0].text));
    const data = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1])).find(item => item["@type"] === "ItemList");
    assert.ok(data.itemListElement.find((item: { name: string }) => item.name === "Upcoming Cloud").description.includes(conditions[0].text));
  });

  it("reconciles headline, section, tile and structured counts with the actual cards at every clock", () => {
    for (const day of clocks) {
      const page = pages.get(day)!;
      const cards = cardsOf(page);
      const counts = Object.fromEntries(["imminent", "upcoming", "later", "completed"].map(section => [section, cards.filter(card => card.section === section).length]));
      const active = cards.length - counts.completed;
      assert.equal(Number(page.match(/(\d+) active shutdowns/)?.[1]), active, day);
      const tiles = [...page.matchAll(/<div class="stat-number[^"]*">(\d+)<\/div>/g)].map(match => Number(match[1]));
      assert.deepEqual(tiles, [active, counts.imminent, counts.upcoming, counts.later], day);
      for (const [section, count] of Object.entries(counts)) {
        const shown = page.match(new RegExp(`<h2 id="${section}">[\\s\\S]*?class="section-count">\\((\\d+)\\)`))?.[1];
        assert.equal(Number(shown ?? 0), count, `${day}: ${section}`);
      }
      const data = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1])).find(item => item["@type"] === "ItemList");
      assert.equal(data.numberOfItems, cards.length, day);
      assert.deepEqual(data.itemListElement.map((item: { name: string }) => item.name).sort(), cards.map(card => card.name).sort());
    }
  });
});

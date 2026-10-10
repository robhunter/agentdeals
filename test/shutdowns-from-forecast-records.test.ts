import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const DAY_MS = 86_400_000;
const dayFromToday = (days: number): string => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
const shownDate = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

const A_DEPRECATION = {
  change_type: "product_deprecated",
  previous_state: "The product is available.",
  current_state: "The product is no longer offered.",
  impact: "high",
  category: "Developer Tools",
  alternatives: [],
  date_source: "hand_written",
  listing_effect: "ends",
};

function forecast(vendor: string, shutdownInDays: number, summary: string, extra: Record<string, unknown> = {}) {
  return {
    ...A_DEPRECATION,
    vendor,
    date: dayFromToday(shutdownInDays),
    recorded_date: dayFromToday(-20),
    summary,
    source_url: `https://example.com/notices/${summary.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "")}`,
    ...extra,
  };
}

const IMMINENT = forecast("Pipedream", 10, "Imminent fixture closes ten days from today.");
const UPCOMING = forecast("apiary.io", 60, "Upcoming fixture closes sixty days from today.");
const LATER = forecast("Smartlook.com", 200, "Later fixture closes two hundred days from today.");
const COMPLETED = forecast("OpenAI Codex", -10, "Completed fixture closed ten days ago.", { recorded_date: dayFromToday(-40) });

const WRITTEN_AFTER = forecast("Pipedream", -30, "Fixture recorded five days after it closed.", { recorded_date: dayFromToday(-5) });
const WRITTEN_ON_THE_DAY = forecast("apiary.io", -6, "Fixture recorded on the day it closed.", { recorded_date: dayFromToday(-6) });
const RETRACTED = forecast("apiary.io", 40, "Fixture withdrawn as our own error.", {
  resolution: { state: "retracted", date: dayFromToday(-1), detail: "Withdrawn: the vendor announced no such shutdown." },
});
const REVERSED = forecast("apiary.io", 41, "Fixture whose shutdown the vendor called off.", {
  resolution: { state: "reversed", date: dayFromToday(-1), detail: "The vendor called the shutdown off." },
});
const UNSOURCED = forecast("Smartlook.com", 45, "Fixture that cites no source.", { source_url: "" });
const UNCONFIRMED = forecast("Smartlook.com", 46, "Fixture no archived copy confirms.", {
  archive_check: { checked: dayFromToday(-1), outcome: "no_usable_capture" },
});

const ON_PROTONS_CARD = { ...A_DEPRECATION, vendor: "AWS", date: "2026-10-07", recorded_date: "2026-04-10", summary: "Fixture of the AWS Proton shutdown.", source_url: "https://example.com/notices/proton", listing_effect: "none" };
const COVERED_BY_TENORS_CARD = { ...A_DEPRECATION, vendor: "Google Tenor API", date: "2026-06-30", recorded_date: "2026-03-14", summary: "Fixture of the Tenor API shutdown.", source_url: "https://example.com/notices/tenor" };
const COVERED_BY_THIN_CLIENTS_CARD = { ...A_DEPRECATION, vendor: "AWS", date: "2026-04-20", recorded_date: "2026-04-10", summary: "Fixture of the end of WorkSpaces Thin Client sales.", source_url: "https://example.com/notices/thin-client", listing_effect: "none" };

const AWS_ON_ANOTHER_DATE = forecast("AWS", 75, "Fixture of an AWS shutdown no card states.", { listing_effect: "none" });
const ANOTHER_VENDOR_ON_A_CARDS_DATE = { ...A_DEPRECATION, vendor: "Pipedream", date: "2026-10-23", recorded_date: "2026-09-01", summary: "Fixture of a Pipedream shutdown on the day of an OpenAI card.", source_url: "https://example.com/notices/pipedream-october" };
const UNLISTED_ON_TENORS_DATE = { ...A_DEPRECATION, vendor: "Qwzx Clips", date: "2026-06-30", recorded_date: "2026-03-01", summary: "Fixture of an unlisted product closing on the day the Tenor API closed.", source_url: "https://example.com/notices/qwzx" };
const SAME_DAY_AS_UPCOMING = forecast("Pipedream", 60, "Fixture of a Pipedream shutdown on the day the apiary.io fixture closes.");

const RECORDED_FIRST = forecast("OpenAI Codex", 70, "Fixture of a shutdown as first recorded.", { recorded_date: dayFromToday(-30) });
const RECORDED_AGAIN = forecast("OpenAI Codex", 70, "Fixture of the same shutdown as recorded again.", { recorded_date: dayFromToday(-3) });

const DATED_IN_ITS_SUMMARY = forecast("Pipedream", -3, `Pipedream said the fixture product will shut down on ${dayFromToday(150)}.`, { recorded_date: dayFromToday(-2) });
const DATED_BY_ITS_FIELD = forecast("apiary.io", -4, `A fixture product beside the listing shuts down on ${dayFromToday(130)}.`, {
  recorded_date: dayFromToday(-2),
  discontinued_date: dayFromToday(120),
  listing_effect: "none",
});

const NAMES_WHAT_ENDS = forecast("OpenAI Codex", 25, "Fixture of a model retiring from a product that stays.", { what_ends: "Fixture Model 9" });
const LEAVES_WHAT_ENDS_BLANK = forecast("Pipedream", 26, "Fixture whose record leaves what ends blank.", { what_ends: "  " });
const CLOSES_TOMORROW = forecast("Smartlook.com", 1, "Fixture closes tomorrow.");

const FIXTURES = [
  IMMINENT, UPCOMING, LATER, COMPLETED,
  WRITTEN_AFTER, WRITTEN_ON_THE_DAY, RETRACTED, REVERSED, UNSOURCED, UNCONFIRMED,
  ON_PROTONS_CARD, COVERED_BY_TENORS_CARD, COVERED_BY_THIN_CLIENTS_CARD,
  AWS_ON_ANOTHER_DATE, ANOTHER_VENDOR_ON_A_CARDS_DATE, UNLISTED_ON_TENORS_DATE, SAME_DAY_AS_UPCOMING,
  RECORDED_FIRST, RECORDED_AGAIN,
  DATED_IN_ITS_SUMMARY, DATED_BY_ITS_FIELD,
  NAMES_WHAT_ENDS, LEAVES_WHAT_ENDS_BLANK, CLOSES_TOMORROW,
];

interface Card {
  section: string;
  title: string;
  href: string | null;
  profile: string | null;
  date: string;
  what: string;
  source: string | null;
  countsDown: boolean;
  detailRows: number;
}

function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function cardsOn(page: string): Card[] {
  const cards: Card[] = [];
  let section = "";
  for (const piece of page.split(/(?=<h2 id=")|(?=<div class="shutdown-card")/)) {
    const heading = piece.match(/^<h2 id="([^"]+)"/);
    if (heading) {
      section = heading[1];
      continue;
    }
    if (!piece.startsWith('<div class="shutdown-card"')) continue;
    cards.push({
      section,
      title: textOf(piece.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? ""),
      href: piece.match(/<h3[^>]*>\s*<a href="([^"]+)"/)?.[1] ?? null,
      profile: piece.match(/<a href="([^"]+)">Vendor profile/)?.[1] ?? null,
      date: textOf(piece.match(/<span class="deadline-icon">[^<]*<\/span>\s*<span>([^<]+)<\/span>/)?.[1] ?? ""),
      what: textOf(piece.match(/<p class="shutdown-what">([\s\S]*?)<\/p>/)?.[1] ?? ""),
      source: piece.match(/<a href="([^"]+)"[^>]*class="figure-source"/)?.[1] ?? null,
      countsDown: piece.includes('class="days-badge"'),
      detailRows: (piece.match(/class="detail-row"/g) ?? []).length,
    });
  }
  return cards;
}

const cardFor = (cards: Card[], record: { source_url: string }): Card[] => cards.filter((card) => card.source === record.source_url);
const fromFixtures = (cards: Card[]): Card[] => cards.filter((card) => card.source === null || card.source.startsWith("https://example.com/"));

describe("/shutdowns prints a card for each shutdown a record forecast and no card already states", () => {
  let dir = "";
  let proc: ChildProcess | null = null;
  let page = "";
  let cards: Card[] = [];

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "forecast-shutdowns-"));
    const changesPath = path.join(dir, "deal_changes.json");
    writeFileSync(changesPath, JSON.stringify({ changes: FIXTURES }));
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_CHANGES_PATH: changesPath },
    });
    proc = child;
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timeout); resolve(parseInt(m[1], 10)); }
      });
      child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
    page = await (await fetch(`http://localhost:${port}/shutdowns`)).text();
    cards = cardsOn(page);
  });

  after(() => {
    proc?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints a card for exactly the records its rules admit", () => {
    const admitted = [
      IMMINENT, UPCOMING, LATER, COMPLETED,
      AWS_ON_ANOTHER_DATE, ANOTHER_VENDOR_ON_A_CARDS_DATE, UNLISTED_ON_TENORS_DATE, SAME_DAY_AS_UPCOMING,
      RECORDED_AGAIN, DATED_IN_ITS_SUMMARY, DATED_BY_ITS_FIELD,
      NAMES_WHAT_ENDS, LEAVES_WHAT_ENDS_BLANK, CLOSES_TOMORROW,
    ];
    assert.deepStrictEqual(fromFixtures(cards).map((card) => card.source).sort(), admitted.map((record) => record.source_url).sort());
  });

  it("puts each forecast in the group its shutdown date falls in", () => {
    const placed = [IMMINENT, UPCOMING, LATER, COMPLETED].map((record) => cardFor(cards, record).map((card) => card.section));
    assert.deepStrictEqual(placed, [["imminent"], ["upcoming"], ["later"], ["completed"]]);
  });

  it("names the vendor as the catalogue does, links its page, dates the card and cites the record's source", () => {
    const [later] = cardFor(cards, LATER);
    assert.deepStrictEqual(
      { title: later.title, href: later.href, date: later.date, source: later.source, countsDown: later.countsDown },
      { title: "smartlook.com", href: "/vendor/smartlook-com", date: shownDate(LATER.date), source: LATER.source_url, countsDown: true },
    );
  });

  it("titles a card with what its record says ends, in the page and its structured data, and still links the vendor's page", () => {
    const listed = JSON.parse(page.match(/<script type="application\/ld\+json">(\{"@context":"https:\/\/schema.org","@type":"ItemList"[\s\S]*?)<\/script>/)![1]);
    assert.deepStrictEqual(
      {
        cards: cardFor(cards, NAMES_WHAT_ENDS).map((card) => [card.title, card.href, card.profile]),
        listed: listed.itemListElement.filter((item: { description: string }) => item.description === NAMES_WHAT_ENDS.summary).map((item: { name: string }) => item.name),
      },
      { cards: [["Fixture Model 9", "/vendor/openai-codex", "/vendor/openai-codex"]], listed: ["Fixture Model 9"] },
    );
  });

  it("titles a card with the catalogue's name when its record leaves what ends blank", () => {
    assert.deepStrictEqual(cardFor(cards, LEAVES_WHAT_ENDS_BLANK).map((card) => [card.title, card.href]), [["Pipedream", "/vendor/pipedream"]]);
  });

  it("gives a next deadline one day away as 1 day", () => {
    assert.deepStrictEqual(cardFor(cards, CLOSES_TOMORROW).map((card) => card.section), ["imminent"]);
    assert.strictEqual(page.match(/Next deadline in ([^&<]*)&middot;/)?.[1], "1 day ");
  });

  it("prints no affected, impact or migration rows the record does not carry", () => {
    const rows = [IMMINENT, UPCOMING, LATER, COMPLETED].flatMap((record) => cardFor(cards, record).map((card) => card.detailRows));
    assert.deepStrictEqual(rows, [0, 0, 0, 0]);
    const proton = cards.filter((card) => card.title === "AWS Proton");
    assert.deepStrictEqual(proton.map((card) => card.detailRows), [3]);
  });

  it("prints no card for a record written after its shutdown date, or on it", () => {
    assert.deepStrictEqual([...cardFor(cards, WRITTEN_AFTER), ...cardFor(cards, WRITTEN_ON_THE_DAY)], []);
  });

  it("prints no card for a retracted record, or for a shutdown the vendor called off", () => {
    assert.deepStrictEqual([...cardFor(cards, RETRACTED), ...cardFor(cards, REVERSED)], []);
  });

  it("prints no card for a record that cites no source or that no archived copy confirms", () => {
    assert.deepStrictEqual([...cardFor(cards, UNSOURCED), ...cardFor(cards, UNCONFIRMED)], []);
  });

  it("prints a shutdown once when a hand-typed card has the record's vendor page and date", () => {
    assert.deepStrictEqual(cardFor(cards, ON_PROTONS_CARD), []);
    assert.strictEqual(cards.filter((card) => card.title === "AWS Proton").length, 1);
  });

  it("prints a shutdown once when a hand-typed card names the record it covers", () => {
    assert.deepStrictEqual([...cardFor(cards, COVERED_BY_TENORS_CARD), ...cardFor(cards, COVERED_BY_THIN_CLIENTS_CARD)], []);
    assert.strictEqual(cards.filter((card) => card.title === "Tenor API").length, 1);
    assert.strictEqual(cards.filter((card) => card.title === "AWS WorkSpaces Thin Client").length, 1);
  });

  it("prints a card for a hand-typed card's vendor on another date, and for another vendor on a hand-typed card's date", () => {
    assert.deepStrictEqual(
      [AWS_ON_ANOTHER_DATE, ANOTHER_VENDOR_ON_A_CARDS_DATE].map((record) => cardFor(cards, record).map((card) => [card.title, card.href])),
      [[["AWS", "/vendor/aws"]], [["Pipedream", "/vendor/pipedream"]]],
    );
  });

  it("prints an unlisted product's shutdown under its recorded name, unlinked, even on the date of a card with no vendor page", () => {
    assert.deepStrictEqual(
      cardFor(cards, UNLISTED_ON_TENORS_DATE).map((card) => [card.title, card.href, card.section]),
      [["Qwzx Clips", null, "completed"]],
    );
  });

  it("prints two vendors' shutdowns on the same day as two cards", () => {
    assert.deepStrictEqual([UPCOMING, SAME_DAY_AS_UPCOMING].map((record) => cardFor(cards, record).length), [1, 1]);
  });

  it("prints a shutdown recorded twice once, in the words of the later record", () => {
    const sameShutdown = cards.filter((card) => card.title === "OpenAI Codex" && card.date === shownDate(RECORDED_FIRST.date));
    assert.deepStrictEqual(sameShutdown.map((card) => card.what), [RECORDED_AGAIN.summary]);
  });

  it("dates a card from the record's discontinued date, else the date its summary gives, else the record's date", () => {
    assert.deepStrictEqual(cardFor(cards, DATED_BY_ITS_FIELD).map((card) => [card.date, card.section]), [[shownDate(dayFromToday(120)), "later"]]);
    assert.deepStrictEqual(cardFor(cards, DATED_IN_ITS_SUMMARY).map((card) => [card.date, card.section]), [[shownDate(dayFromToday(150)), "later"]]);
    assert.deepStrictEqual(cardFor(cards, IMMINENT).map((card) => card.date), [shownDate(IMMINENT.date)]);
  });

  it("counts every card in the header, the four tiles and its section's heading", () => {
    const inSection = (id: string) => cards.filter((card) => card.section === id).length;
    const active = inSection("imminent") + inSection("upcoming") + inSection("later");
    const header = Number(page.match(/<div class="pub-date">[\s\S]*?(\d+) active shutdowns/)?.[1]);
    const tiles = Object.fromEntries(
      [...page.matchAll(/<div class="stat-number[^"]*">(\d+)<\/div><div class="stat-label">([^<]+)<\/div>/g)].map(([, n, label]) => [textOf(label), Number(n)]),
    );
    assert.deepStrictEqual(
      { header, tiles },
      {
        header: active,
        tiles: {
          "Active Shutdowns": active,
          "Imminent (<30 days)": inSection("imminent"),
          "Upcoming (30–90 days)": inSection("upcoming"),
          Later: inSection("later"),
        },
      },
    );
    for (const id of ["imminent", "upcoming", "later", "completed"]) {
      const heading = page.match(new RegExp(`<h2 id="${id}">[\\s\\S]*?class="section-count">\\((\\d+)\\)`))?.[1];
      assert.strictEqual(Number(heading), inSection(id), `the ${id} heading`);
    }
  });

  it("lists every card in the page's structured data", () => {
    const listed = JSON.parse(page.match(/<script type="application\/ld\+json">(\{"@context":"https:\/\/schema.org","@type":"ItemList"[\s\S]*?)<\/script>/)![1]);
    assert.strictEqual(listed.numberOfItems, cards.length);
    assert.deepStrictEqual(
      [IMMINENT, UPCOMING, LATER, COMPLETED].map((record) => listed.itemListElement.filter((item: { description: string }) => item.description === record.summary).length),
      [1, 1, 1, 1],
    );
  });
});

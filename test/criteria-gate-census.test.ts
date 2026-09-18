import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { GATE_TABLE, DEMERIT_TABLE, NOT_FREE_TIER_RULES, TIME_LIMITED_TIER_RULES, gateFor, utcDate } = await import("../dist/ranking.js");
const { gateCensusSentence } = await import("../dist/gate-disclosure.js");
const { loadOffers } = await import("../dist/data.js");

type Offer = import("../src/types.ts").Offer;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const A_DAY_IN_MS = 86400000;
const THE_FLOOR = "verification_lapsed";
const THE_RULE = /more than (\d+) days/;
const THE_CENSUS = /On (\d{4}-\d{2}-\d{2}), across the ([\d,]+) offers we hold, (.+?)\./;
const NO_OFFER_TRIPS_IT = "no offer trips it";
const A_COUNT_THAT_LAPSED = /^([\d,]+) (?:has|have) not been re-confirmed recently enough$/;
const DAYS_TO_SEARCH_FOR_A_SECOND_COUNT = 90;

const A_CLAIM_ABOUT_THE_CATALOGUE = [
  /\b(?:currently|at present|as of today|so far|to date|right now)\b/i,
  /\bno (?:offer|record|vendor|deal)s?\b/i,
  /\b(?:every|all|none of) (?:our |the )?(?:offer|record|vendor|deal)s?\b/i,
];

const offers: Offer[] = loadOffers();

function censusAt(date: string): number {
  return offers.filter((offer) => gateFor(offer, date)?.code === THE_FLOOR).length;
}

function dateShiftedBy(days: number): string {
  return utcDate(new Date(Date.now() + days * A_DAY_IN_MS));
}

function decodeEntities(text: string): string {
  return text
    .replace(/&mdash;/g, "—")
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

function gateRowText(html: string, code: string): string {
  const row = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map((m) => m[1]!)
    .find((cells) => cells.includes(`<code>${code}</code>`));
  assert.ok(row, `${code} has no row in the published gate table`);
  const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => decodeEntities(m[1]!.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim());
  assert.equal(cells.length, 2, `the ${code} row does not have a code cell and a description cell`);
  return cells[1]!;
}

function startServer(shiftMs: number): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const args = shiftMs ? ["--import", path.join(REPO, "scripts", "shifted-clock.mjs")] : [];
    const proc = spawn("node", [...args, path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TZ: "UTC", PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_CLOCK_SHIFT_MS: String(shiftMs) },
    });
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("Server startup timeout")); }, 60000);
    proc.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ proc, base: `http://localhost:${m[1]}` }); }
    });
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
    proc.on("exit", (code) => { clearTimeout(timeout); reject(new Error(`The server exited with status ${code} before reporting a port`)); });
  });
}

function twoDaysThatDifferInTheCensus(): { first: number; second: number } | null {
  const first = censusAt(dateShiftedBy(0));
  for (let day = 1; day <= DAYS_TO_SEARCH_FOR_A_SECOND_COUNT; day++) {
    if (censusAt(dateShiftedBy(day)) !== first) return { first: 0, second: day };
  }
  return null;
}

const A_MONTH_AHEAD = 30;

describe("the criteria page counts the offers that trip the verification floor", () => {
  const days = twoDaysThatDifferInTheCensus();
  const readOn = days ? [...new Set([days.first, days.second, A_MONTH_AHEAD])] : [];
  const served = new Map<number, string>();
  const running: ChildProcess[] = [];

  before(async () => {
    assert.ok(
      days,
      `the census of ${THE_FLOOR} is the same on every day in the next ${DAYS_TO_SEARCH_FOR_A_SECOND_COUNT}, so nothing below reads a sentence that has to move`,
    );
    for (const day of readOn) {
      const { proc, base } = await startServer(day * A_DAY_IN_MS);
      running.push(proc);
      const res = await fetch(`${base}/criteria`);
      assert.equal(res.status, 200, `/criteria answered ${res.status} on a clock ${day} days ahead`);
      served.set(day, await res.text());
    }
  });

  after(() => {
    for (const proc of running) proc.kill();
  });

  it("states a count that matches a census of the offers that gate code excludes, on every day it is read on", () => {
    assert.ok(days);
    const read = readOn.map((day) => {
      const text = gateRowText(served.get(day)!, THE_FLOOR);
      const census = THE_CENSUS.exec(text);
      assert.ok(census, `the ${THE_FLOOR} row on a clock ${day} days ahead states no census: ${text}`);
      const [, dateStated, held, claim] = census as unknown as [string, string, string, string];
      const lapsed = A_COUNT_THAT_LAPSED.exec(claim);
      const stated = claim === NO_OFFER_TRIPS_IT ? 0 : asCount(lapsed?.[1] ?? "NaN");
      assert.ok(Number.isInteger(stated), `the ${THE_FLOOR} row states a census this cannot read: "${claim}"`);
      return { day, dateStated, held: asCount(held), stated };
    });

    for (const row of read) {
      assert.equal(
        row.stated,
        censusAt(row.dateStated),
        `on ${row.dateStated} the criteria page says ${row.stated} offers trip the ${THE_FLOOR} floor and a census of the same catalogue finds ${censusAt(row.dateStated)}`,
      );
      assert.equal(
        row.held,
        offers.length,
        `the criteria page counts the floor against ${row.held} offers and we hold ${offers.length}`,
      );
      assert.ok(
        Math.abs(Date.parse(row.dateStated) - Date.parse(dateShiftedBy(row.day))) <= A_DAY_IN_MS,
        `the criteria page dates its census ${row.dateStated} on a clock set to ${dateShiftedBy(row.day)}`,
      );
    }

    const [first, second] = [read.find(r => r.day === days.first)!, read.find(r => r.day === days.second)!];
    assert.notEqual(
      first.stated,
      second.stated,
      `the criteria page states the same count on ${first.dateStated} and ${second.dateStated}, where a census of the catalogue finds ${censusAt(first.dateStated)} and ${censusAt(second.dateStated)}`,
    );
  });

  it("uses the words a category page uses for the same offers", () => {
    assert.ok(days);
    for (const day of readOn) {
      const text = gateRowText(served.get(day)!, THE_FLOOR);
      const date = THE_CENSUS.exec(text)![1]!;
      const expected = gateCensusSentence(THE_FLOOR, offers.map((offer) => gateFor(offer, date)), date);
      assert.ok(
        text.endsWith(expected),
        `on ${date} the criteria page ends its ${THE_FLOOR} row "${text.slice(-90)}" where the clause a category page prints for the same offers reads "${expected}"`,
      );
    }
  });

  it("still publishes the rule itself, on every day it is read on", () => {
    assert.ok(days);
    for (const day of readOn) {
      const text = gateRowText(served.get(day)!, THE_FLOOR);
      const rule = THE_RULE.exec(text);
      assert.ok(rule, `the ${THE_FLOOR} row on a clock ${day} days ahead no longer says how long a confirmation may go unrenewed: ${text}`);
      assert.equal(rule[1], "180", `the ${THE_FLOOR} row publishes a ${rule[1]}-day floor`);
    }
  });

  it("leaves the rows that describe only a rule identical on every day it is read on", () => {
    assert.ok(days);
    const moved = GATE_TABLE.filter((row) => row.code !== THE_FLOOR)
      .filter((row) => new Set(readOn.map((day) => gateRowText(served.get(day)!, row.code))).size > 1)
      .map((row) => row.code);
    assert.deepEqual(moved, [], `${moved.length} gate rows that state no census say something different on a clock ${readOn.join(", ")} days ahead`);
  });
});

describe("a published rule describes the rule, not the catalogue it is applied to", () => {
  const ruleText = [
    ...GATE_TABLE.map((row: { code: string; rule: string }) => ({ where: `GATE_TABLE ${row.code}`, text: row.rule })),
    ...DEMERIT_TABLE.map((row: { code: string; trigger: string }) => ({ where: `DEMERIT_TABLE ${row.code}`, text: row.trigger })),
    ...NOT_FREE_TIER_RULES.map((rule: { pattern: RegExp; note: string }) => ({ where: `NOT_FREE_TIER_RULES ${rule.pattern}`, text: rule.note })),
    ...TIME_LIMITED_TIER_RULES.map((rule: { pattern: RegExp; note: string }) => ({ where: `TIME_LIMITED_TIER_RULES ${rule.pattern}`, text: rule.note })),
  ];

  it("reads every rule we publish on the criteria page", () => {
    assert.equal(
      ruleText.length,
      GATE_TABLE.length + DEMERIT_TABLE.length + NOT_FREE_TIER_RULES.length + TIME_LIMITED_TIER_RULES.length,
      "this reads fewer published rules than the criteria page prints",
    );
    assert.ok(ruleText.length >= 22, `only ${ruleText.length} published rules were read`);
  });

  it("states no count of the catalogue in a string that cannot move when the catalogue does", () => {
    const asserting = ruleText
      .filter((rule) => A_CLAIM_ABOUT_THE_CATALOGUE.some((pattern) => pattern.test(rule.text)))
      .map((rule) => `${rule.where}: ${rule.text}`);
    assert.deepEqual(
      asserting,
      [],
      `${asserting.length} published rules describe the state of the catalogue from a fixed string, which stays on the page after the catalogue has moved under it`,
    );
  });
});

describe("the census clause agrees in number with the count it states", () => {
  const date = "2026-09-18";

  function gatesWhere(lapsed: number, clean: number): ({ code: string; reason: string } | null)[] {
    return [
      ...Array.from({ length: lapsed }, () => ({ code: THE_FLOOR, reason: "" })),
      ...Array.from({ length: clean }, () => null),
    ];
  }

  it("says no offer trips it when none does", () => {
    assert.equal(gateCensusSentence(THE_FLOOR, gatesWhere(0, 1547), date), `On ${date}, across the 1,547 offers we hold, no offer trips it.`);
  });

  it("says one offer has not been re-confirmed when one has not", () => {
    assert.equal(gateCensusSentence(THE_FLOOR, gatesWhere(1, 1546), date), `On ${date}, across the 1,547 offers we hold, 1 has not been re-confirmed recently enough.`);
  });

  it("says several have not been re-confirmed when several have not", () => {
    assert.equal(gateCensusSentence(THE_FLOOR, gatesWhere(3, 1544), date), `On ${date}, across the 1,547 offers we hold, 3 have not been re-confirmed recently enough.`);
  });

  it("counts only the offers this gate code excludes", () => {
    const mixed = [{ code: THE_FLOOR, reason: "" }, { code: "not_a_free_offer", reason: "" }, { code: "eligibility_restricted", reason: "" }, null];
    assert.equal(gateCensusSentence(THE_FLOOR, mixed, date), `On ${date}, across the 4 offers we hold, 1 has not been re-confirmed recently enough.`);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

const {
  ATTEMPT_CHANGED,
  ATTEMPT_CONFIRMED,
  ATTEMPT_FETCH_FAILED,
  ATTEMPT_LINK_OK,
  ATTEMPT_SOURCE_UNUSABLE,
  ATTEMPT_STATES_NO_PRICE,
  ATTEMPT_UNCLEAR,
  ANSWERED_OUTCOMES,
  QUARANTINE_AFTER_FAILURES,
  applyAttempt,
  attemptForSourceCheck,
  clearFailuresALaterReadingAnswered,
  failedReadingCensus,
  lastReadFailed,
  pageStatesNoPrice,
  readingSinceTheAttempt,
} = await import("../scripts/verification-state.js");
const { runAiMode, runUrlMode, summaryLines } = await import("../scripts/reverify-rolling.js");
const {
  NAMING_LAYERS_RECORDED_INSTEAD_OF_A_FINDING,
  SOURCE_CHECK_NO_AMOUNT,
  SOURCE_CHECK_NO_TERMS,
  SOURCE_CHECK_NOT_NAMED,
  SOURCE_CHECK_OK,
  SOURCE_CHECK_OUTCOMES,
  SOURCE_CHECK_UNREADABLE,
  checkRecordedAFinding,
  classifySource,
} = await import("../scripts/vendor-naming.js");
const { priceSignals } = await import("../scripts/change-gate.js");
const { NAMING_TOKENS_RECORDED_INSTEAD_OF_EVIDENCE } = await import("../dist/source-check.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, "..", "data", "index.json");
const STATE_PATH = path.join(__dirname, "..", "data", "verification_state.json");

const NOW = new Date("2026-09-10T10:00:00Z");
const TODAY = "2026-09-10";

const SILENT = "Acme Cloud. Object storage for teams. Talk to sales about a plan.";
const SILENT_AND_FREE = "Acme Cloud. Object storage for teams. Free forever. Talk to sales about a plan.";

function offerFor(vendor: string) {
  return {
    vendor,
    url: `https://${vendor.toLowerCase()}.example/pricing`,
    description: "Free tier: 10 GB",
    category: "Storage",
    verifiedDate: "2026-04-12",
  };
}

function pageOf(text: string) {
  return { ok: true, text, truncated: false };
}

async function attemptOutcomeInAiMode(text: string, status: string) {
  const offer = { ...offerFor("Acme"), vendor: "Acme" };
  const data = { offers: [{ ...offer }] };
  const result = await runAiMode([{ index: 0, offer }], data, true, NOW, {
    fetchFn: async () => pageOf(text),
    verifyFn: async () => ({ status, summary: "the page states no limits", change_type: "limits_reduced", current_state: "Free tier: 5 GB", impact: "medium" }),
    confirmFn: async () => ({ describes_change: true }),
    rateLimitMs: 0,
  });
  return result.attempts[0];
}

async function attemptOutcomeInUrlMode(text: string) {
  const offer = { ...offerFor("Acme"), vendor: "Acme" };
  const data = { offers: [{ ...offer }] };
  const result = await runUrlMode([{ index: 0, offer }], data, true, NOW, {
    batchFn: async (batch: any[]) => ({ verified: batch.map((b) => ({ index: b.index })), flagged: [] }),
    fetchFn: async () => pageOf(text),
  });
  return result.attempts[0];
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    vendor: "Acme",
    url: "https://acme.example/pricing",
    last_attempt_at: "2026-08-28",
    last_outcome: ATTEMPT_SOURCE_UNUSABLE,
    last_error: "the page names Acme but states no amount, tier or rate we can read",
    failure_category: "source_unusable",
    consecutive_failures: 1,
    last_success: "2026-07-07",
    quarantined_since: null,
    ...overrides,
  };
}

function stateOf(records: Record<string, unknown>[]) {
  return new Map(records.map((r) => [`${r.vendor}|${r.url}`, r]));
}

describe("a page our reader finds no price on reads the same whether or not it says the word free", () => {
  it("grades the two pages differently as source checks, which is the split this rule sits above", () => {
    const offer = offerFor("Acme");
    assert.strictEqual(classifySource(offer, pageOf(SILENT), priceSignals(SILENT)).outcome, SOURCE_CHECK_NO_TERMS);
    assert.strictEqual(
      classifySource(offer, pageOf(SILENT_AND_FREE), priceSignals(SILENT_AND_FREE)).outcome,
      SOURCE_CHECK_NO_AMOUNT,
    );
  });

  for (const status of ["confirmed", "changed", "unclear"]) {
    it(`records the same attempt outcome on both pages when the model says ${status}`, async () => {
      const silent = await attemptOutcomeInAiMode(SILENT, status);
      const alsoFree = await attemptOutcomeInAiMode(SILENT_AND_FREE, status);
      assert.strictEqual(silent.outcome, alsoFree.outcome);
    });
  }

  it("records the model's verdict where it gave one", async () => {
    assert.strictEqual((await attemptOutcomeInAiMode(SILENT, "confirmed")).outcome, ATTEMPT_CONFIRMED);
    assert.strictEqual((await attemptOutcomeInAiMode(SILENT, "changed")).outcome, ATTEMPT_CHANGED);
  });

  it("records that the page states no price where the model could not answer either", async () => {
    const attempt = await attemptOutcomeInAiMode(SILENT, "unclear");
    assert.strictEqual(attempt.outcome, ATTEMPT_STATES_NO_PRICE);
    assert.notStrictEqual(attempt.outcome, ATTEMPT_UNCLEAR);
  });

  it("records the same attempt outcome on both pages in URL mode, where there is no model", async () => {
    const silent = await attemptOutcomeInUrlMode(SILENT);
    const alsoFree = await attemptOutcomeInUrlMode(SILENT_AND_FREE);
    assert.strictEqual(silent.outcome, ATTEMPT_STATES_NO_PRICE);
    assert.strictEqual(alsoFree.outcome, ATTEMPT_STATES_NO_PRICE);
  });

  it("still refuses a page that never names the offer, which is a different finding", async () => {
    const stranger = { ...offerFor("Acme"), vendor: "Stranger" };
    const data = { offers: [{ ...stranger }] };
    const result = await runAiMode([{ index: 0, offer: stranger }], data, true, NOW, {
      fetchFn: async () => pageOf("A page about something else entirely, priced at $9 per month."),
      verifyFn: async () => ({ status: "confirmed" }),
      confirmFn: async () => ({ describes_change: false }),
      rateLimitMs: 0,
    });
    assert.strictEqual(result.attempts[0].outcome, ATTEMPT_SOURCE_UNUSABLE);
  });
});

describe("a page that is silent on price is a reading, not a read that failed", () => {
  it("counts as an answer, so it clears the failure count rather than adding to it", () => {
    const next = applyAttempt(record({ consecutive_failures: 2 }), {
      vendor: "Acme",
      url: "https://acme.example/pricing",
      outcome: ATTEMPT_STATES_NO_PRICE,
      date: TODAY,
    });
    assert.strictEqual(next.consecutive_failures, 0);
    assert.strictEqual(next.quarantined_since, null);
    assert.strictEqual(lastReadFailed(next), false);
  });

  it("never quarantines a record however many times we read the same silence", () => {
    let held: any = null;
    for (let pass = 0; pass < QUARANTINE_AFTER_FAILURES + 2; pass++) {
      held = applyAttempt(held, {
        vendor: "Acme",
        url: "https://acme.example/pricing",
        outcome: ATTEMPT_STATES_NO_PRICE,
        date: TODAY,
      });
    }
    assert.strictEqual(held.quarantined_since, null);
    assert.strictEqual(held.consecutive_failures, 0);
  });

  it("does not claim we confirmed the offer, so the last confirmation stands where it was", () => {
    const next = applyAttempt(record(), {
      vendor: "Acme",
      url: "https://acme.example/pricing",
      outcome: ATTEMPT_STATES_NO_PRICE,
      date: TODAY,
    });
    assert.strictEqual(next.last_success, "2026-07-07");
  });

  it("still counts a page we could not fetch and a page that is about something else", () => {
    for (const outcome of [ATTEMPT_SOURCE_UNUSABLE, ATTEMPT_FETCH_FAILED, ATTEMPT_UNCLEAR]) {
      const next = applyAttempt(record({ consecutive_failures: 2 }), {
        vendor: "Acme",
        url: "https://acme.example/pricing",
        outcome,
        date: TODAY,
      });
      assert.strictEqual(next.consecutive_failures, 3, outcome);
      assert.strictEqual(next.quarantined_since, TODAY, outcome);
    }
  });
});

describe("every source check outcome says which attempt outcome it implies", () => {
  it("maps each outcome the reader can produce, and none is left to a default", () => {
    for (const outcome of SOURCE_CHECK_OUTCOMES) {
      assert.notStrictEqual(attemptForSourceCheck(outcome), null, outcome);
    }
  });

  it("puts both of the price-silence outcomes on the same attempt outcome", () => {
    assert.strictEqual(attemptForSourceCheck(SOURCE_CHECK_NO_TERMS), ATTEMPT_STATES_NO_PRICE);
    assert.strictEqual(attemptForSourceCheck(SOURCE_CHECK_NO_AMOUNT), ATTEMPT_STATES_NO_PRICE);
    assert.ok(pageStatesNoPrice(SOURCE_CHECK_NO_TERMS) && pageStatesNoPrice(SOURCE_CHECK_NO_AMOUNT));
  });

  it("counts a page we could not read and a page that names somebody else as reads that failed", () => {
    assert.strictEqual(ANSWERED_OUTCOMES.has(attemptForSourceCheck(SOURCE_CHECK_UNREADABLE)), false);
    assert.strictEqual(ANSWERED_OUTCOMES.has(attemptForSourceCheck(SOURCE_CHECK_NOT_NAMED)), false);
    assert.strictEqual(attemptForSourceCheck(SOURCE_CHECK_OK), ATTEMPT_LINK_OK);
  });
});

describe("when a record has been read again since its attempt was written, the later reading governs", () => {
  const offer = { ...offerFor("Acme"), source_check: { checked: "2026-09-02", outcome: SOURCE_CHECK_OK, detail: 'the page names Acme as "acme" and states "$0.073"' } };

  it("takes the later reading when it recorded what it found", () => {
    const reading = readingSinceTheAttempt(record(), offer);
    assert.strictEqual(reading.date, "2026-09-02");
    assert.strictEqual(reading.outcome, ATTEMPT_LINK_OK);
  });

  it("takes nothing from a pass that recorded only which layer matched", () => {
    for (const token of NAMING_LAYERS_RECORDED_INSTEAD_OF_A_FINDING) {
      const bare = { ...offer, source_check: { ...offer.source_check, detail: token } };
      assert.strictEqual(readingSinceTheAttempt(record(), bare), null, token);
    }
  });

  it("takes nothing from a reading no newer than the attempt beside it", () => {
    const older = { ...offer, source_check: { ...offer.source_check, checked: "2026-08-28" } };
    assert.strictEqual(readingSinceTheAttempt(record(), older), null);
  });

  it("clears a stale failure and lets the record out of quarantine", () => {
    const held = record({ consecutive_failures: 4, quarantined_since: "2026-08-28" });
    const state = stateOf([held]);
    const { cleared, left } = clearFailuresALaterReadingAnswered(state, [offer]);
    assert.strictEqual(cleared.length, 1);
    assert.strictEqual(left.length, 1);
    const next = state.get(`${held.vendor}|${held.url}`) as any;
    assert.strictEqual(next.consecutive_failures, 0);
    assert.strictEqual(next.quarantined_since, null);
    assert.strictEqual(next.last_attempt_at, "2026-09-02");
  });

  it("leaves a record whose later reading did not answer either", () => {
    const unreadable = {
      ...offer,
      source_check: { checked: "2026-09-02", outcome: SOURCE_CHECK_UNREADABLE, detail: "page content too short" },
    };
    const state = stateOf([record()]);
    const { cleared } = clearFailuresALaterReadingAnswered(state, [unreadable]);
    assert.deepStrictEqual(cleared, []);
    assert.strictEqual((state.get("Acme|https://acme.example/pricing") as any).consecutive_failures, 1);
  });

  it("leaves a confirmation where it is, rather than replacing it with a later reading", () => {
    const confirmed = record({
      last_outcome: ATTEMPT_CONFIRMED,
      consecutive_failures: 0,
      failure_category: null,
      last_error: null,
    });
    const silent = {
      ...offer,
      source_check: {
        checked: "2026-09-02",
        outcome: SOURCE_CHECK_NO_TERMS,
        detail: "the page names Acme but states no amount, tier or rate we can read",
      },
    };
    const state = stateOf([confirmed]);
    const { cleared } = clearFailuresALaterReadingAnswered(state, [silent]);
    assert.deepStrictEqual(cleared, []);
    assert.strictEqual((state.get("Acme|https://acme.example/pricing") as any).last_outcome, ATTEMPT_CONFIRMED);
  });

  it("never turns an answer into a failure, whatever the later reading found", () => {
    const answered = record({ last_outcome: ATTEMPT_CONFIRMED, consecutive_failures: 0, failure_category: null });
    const unreadable = {
      ...offer,
      source_check: { checked: "2026-09-02", outcome: SOURCE_CHECK_UNREADABLE, detail: "page content too short" },
    };
    const state = stateOf([answered]);
    clearFailuresALaterReadingAnswered(state, [unreadable]);
    assert.strictEqual((state.get("Acme|https://acme.example/pricing") as any).last_outcome, ATTEMPT_CONFIRMED);
  });
});

describe("the quarantine forecast counts what a reading would find, not what an attempt recorded", () => {
  it("counts a record whose attempt answered but whose page we can no longer read", () => {
    const answered = record({ last_outcome: ATTEMPT_CONFIRMED, consecutive_failures: 0, failure_category: null });
    const unreadable = {
      ...offerFor("Acme"),
      source_check: { checked: "2026-09-02", outcome: SOURCE_CHECK_UNREADABLE, detail: "page content too short" },
    };
    const census = failedReadingCensus(stateOf([answered]), [unreadable]);
    assert.strictEqual(census.failed, 0);
    assert.strictEqual(census.readAgainWouldFail, 1);
  });

  it("does not count a record whose stale failure a reading of the page has already answered", () => {
    const silent = {
      ...offerFor("Acme"),
      source_check: {
        checked: "2026-09-02",
        outcome: SOURCE_CHECK_NO_TERMS,
        detail: "the page names Acme but states no amount, tier or rate we can read",
      },
    };
    const census = failedReadingCensus(stateOf([record()]), [silent]);
    assert.strictEqual(census.failed, 1);
    assert.strictEqual(census.readAgainWouldFail, 0);
    assert.strictEqual(census.total, 1);
  });
});

describe("a source check that passes says what it found on the page", () => {
  const passing: [string, Record<string, string>, string][] = [
    ["a page that names the vendor and states an amount", offerFor("Vercel"), "Vercel Hobby plan, free forever. Pro is $20/month."],
    ["a page that writes only the domain we cite the vendor from", { ...offerFor("Tutanota"), url: "https://tuta.com/pricing" }, "Tuta — secure email, calendar and contacts. Legend from €3/month."],
  ];

  for (const [subject, offer, text] of passing) {
    it(`records a finding rather than a naming layer on ${subject}`, () => {
      const result = classifySource(offer, pageOf(text), priceSignals(text));
      assert.strictEqual(result.outcome, SOURCE_CHECK_OK);
      assert.strictEqual(checkRecordedAFinding(result), true, result.detail);
    });
  }

  it("reads a bare naming layer as no finding at all", () => {
    for (const token of NAMING_LAYERS_RECORDED_INSTEAD_OF_A_FINDING) {
      assert.strictEqual(checkRecordedAFinding({ outcome: SOURCE_CHECK_OK, detail: token }), false, token);
    }
    assert.strictEqual(checkRecordedAFinding({ outcome: SOURCE_CHECK_OK, detail: "" }), false);
    assert.strictEqual(checkRecordedAFinding(null), false);
  });

  it("holds the same list of naming layers as the surfaces that publish a finding", () => {
    assert.deepStrictEqual(
      [...NAMING_LAYERS_RECORDED_INSTEAD_OF_A_FINDING].sort(),
      [...NAMING_TOKENS_RECORDED_INSTEAD_OF_EVIDENCE].sort(),
    );
  });
});

describe("what the catalogue reports about readings that did not answer", () => {
  const offers = JSON.parse(readFileSync(INDEX_PATH, "utf-8")).offers as any[];
  const records = JSON.parse(readFileSync(STATE_PATH, "utf-8")).records as any[];
  const state = stateOf(records);

  it("reads a real population, so the rules above are not read against an empty catalogue", () => {
    assertPopulationFloor(offers.length, 1000, "offers in the catalogue these rules are read against");
    assertPopulationFloor(records.length, 1000, "verification records these rules are read against");
  });

  it("clears every stale failure in one pass, so a second pass finds nothing left to clear", () => {
    clearFailuresALaterReadingAnswered(state, offers);
    const { cleared } = clearFailuresALaterReadingAnswered(state, offers);
    assert.deepStrictEqual(cleared, []);
  });

  it("leaves fewer records reading as failed than it was asked to judge", () => {
    const census = failedReadingCensus(state, offers);
    assert.ok(
      census.failed < census.total,
      `every one of ${census.total} readings reads as one that did not answer`,
    );
  });

  it("puts the count and the quarantine forecast in the summary the run prints", () => {
    const lines = summaryLines(
      { verified: 0, flagged: 0, changed: 0, recorded: [], suppressed: [], unclassified: [], sourceChecks: new Map() },
      {
        useAi: false,
        checked: 1,
        oldestRemaining: null,
        total: offers.length,
        failedReadings: { failed: 326, readAgainWouldFail: 279, quarantined: 59, total: 1525 },
      },
    );
    assert.ok(lines.some((line: string) => line === "Records whose last reading did not answer: 326 of 1525"));
    assert.ok(lines.some((line: string) => line.includes("bound for quarantine within 3 passes: 279")));
    assert.ok(lines.some((line: string) => line === "In quarantine now: 59"));
  });
});

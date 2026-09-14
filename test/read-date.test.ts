import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertCoversPopulation, assertPopulationFloor, assertSharesPopulation, recordsInTheCatalogue } from "./population-floor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const { ANSWERED_OUTCOMES, applyAttempt, ATTEMPT_CHANGED, ATTEMPT_CONFIRMED, ATTEMPT_FETCH_FAILED, ATTEMPT_SOURCE_UNUSABLE, ATTEMPT_UNCLEAR } =
  await import("../scripts/verification-state.js");
const { NO_CONFIRMATION_HELD, OUTCOMES_THAT_READ_THE_PAGE, UNCONFIRMED_DATE_LABEL, VERIFICATION_DATES_HEADING, attemptThatDidNotRead, confirmationDate, lastReadDate, lastReadNote, verificationDates, verificationDatesCell, verificationDatesClause, verificationDatesSentence } =
  await import("../dist/read-date.js");
const { resetVerificationStateCache } = await import("../dist/verification-state.js");

interface StateRecord {
  vendor: string;
  url: string;
  last_attempt_at: string | null;
  last_outcome: string | null;
  last_success: string | null;
  last_read_at?: string | null;
}

let scratch = "";
const originalStatePath = process.env.AGENTDEALS_VERIFICATION_STATE_PATH;

function withState(records: StateRecord[]): void {
  writeFileSync(join(scratch, "verification_state.json"), JSON.stringify({ generated_at: "2026-09-11", records }));
  resetVerificationStateCache();
}

const record = (over: Partial<StateRecord> = {}): StateRecord => ({
  vendor: "Examplebase",
  url: "https://examplebase.dev/pricing",
  last_attempt_at: null,
  last_outcome: null,
  last_success: null,
  ...over,
});

const offer = { vendor: "Examplebase", url: "https://examplebase.dev/pricing", verifiedDate: "2026-04-12" };

describe("the day we last read the page", () => {
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "read-date-"));
    process.env.AGENTDEALS_VERIFICATION_STATE_PATH = join(scratch, "verification_state.json");
  });

  after(() => {
    if (originalStatePath === undefined) delete process.env.AGENTDEALS_VERIFICATION_STATE_PATH;
    else process.env.AGENTDEALS_VERIFICATION_STATE_PATH = originalStatePath;
    resetVerificationStateCache();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("names the same outcomes the re-verification writes state from", () => {
    assert.deepEqual(
      [...OUTCOMES_THAT_READ_THE_PAGE].sort(),
      [...ANSWERED_OUTCOMES].sort(),
      "the reader's idea of a read that succeeded and the writer's have diverged",
    );
  });

  it("is the day of a read that found the terms had moved", () => {
    withState([record({ last_attempt_at: "2026-09-09", last_outcome: ATTEMPT_CHANGED, last_success: "2026-04-12" })]);
    assert.equal(lastReadDate(offer), "2026-09-09");
    assert.equal(verificationDates(offer).verified, "2026-04-12");
  });

  it("is the confirmation date where the last read failed to resolve the page", () => {
    withState([record({ last_attempt_at: "2026-09-09", last_outcome: ATTEMPT_FETCH_FAILED, last_success: "2026-04-12" })]);
    assert.equal(lastReadDate(offer), "2026-04-12");
  });

  it("is the confirmation date where the page we reached was not about this offer", () => {
    withState([record({ last_attempt_at: "2026-09-09", last_outcome: ATTEMPT_SOURCE_UNUSABLE, last_success: "2026-04-12" })]);
    assert.equal(lastReadDate(offer), "2026-04-12");
  });

  it("is the confirmation date where the read reached no verdict", () => {
    withState([record({ last_attempt_at: "2026-09-09", last_outcome: ATTEMPT_UNCLEAR, last_success: "2026-04-12" })]);
    assert.equal(lastReadDate(offer), "2026-04-12");
  });

  it("does not fall back when a failed read follows a read that succeeded", () => {
    withState([
      record({ last_attempt_at: "2026-09-10", last_outcome: ATTEMPT_FETCH_FAILED, last_success: "2026-04-12", last_read_at: "2026-09-09" }),
    ]);
    assert.equal(lastReadDate(offer), "2026-09-09");
  });

  it("is the confirmation date for a record the state file has never held", () => {
    withState([]);
    assert.equal(lastReadDate(offer), "2026-04-12");
  });

  it("publishes one date where the read and the confirmation are the same day", () => {
    withState([record({ last_attempt_at: "2026-04-12", last_outcome: ATTEMPT_CONFIRMED, last_success: "2026-04-12" })]);
    assert.equal(verificationDatesCell(offer), "2026-04-12");
    assert.equal(verificationDatesSentence(offer), "Read and confirmed 2026-04-12");
    assert.match(lastReadNote(offer), /read the vendor's page, and the day we last confirmed/);
  });

  it("publishes both dates, each labelled, where the read is later", () => {
    withState([record({ last_attempt_at: "2026-09-09", last_outcome: ATTEMPT_CHANGED, last_success: "2026-04-12" })]);
    assert.equal(verificationDatesCell(offer), "2026-09-09 / 2026-04-12");
    assert.equal(verificationDatesSentence(offer), "Read 2026-09-09 · confirmed 2026-04-12");
    assert.match(lastReadNote(offer), /last confirmed on 2026-04-12/);
  });

  it("names the catalogue date for what it is where the store holds no confirmation", () => {
    withState([record({ last_attempt_at: "2026-09-09", last_outcome: ATTEMPT_CHANGED, last_success: null })]);
    assert.equal(confirmationDate(offer), null);
    assert.equal(verificationDatesSentence(offer), `Read 2026-09-09 · ${UNCONFIRMED_DATE_LABEL.toLowerCase()} 2026-04-12`);
    assert.equal(verificationDatesClause(lastReadDate(offer), offer.verifiedDate), `read 2026-09-09, ${UNCONFIRMED_DATE_LABEL.toLowerCase()} 2026-04-12`);
  });

  it("claims nothing beyond the read where the store holds no confirmation and the catalogue date is no older", () => {
    withState([record({ last_attempt_at: "2026-04-12", last_outcome: ATTEMPT_CHANGED, last_success: null })]);
    assert.equal(confirmationDate(offer), null);
    assert.equal(verificationDatesSentence(offer), "Read 2026-04-12");
    assert.equal(verificationDatesClause(lastReadDate(offer), offer.verifiedDate), "read 2026-04-12");
  });

  it("uses one word for the catalogue date wherever it names it", () => {
    withState([record({ last_attempt_at: "2026-09-09", last_outcome: ATTEMPT_CHANGED, last_success: null })]);
    const naming = [
      VERIFICATION_DATES_HEADING,
      verificationDatesSentence(offer),
      verificationDatesClause(lastReadDate(offer), offer.verifiedDate),
    ];
    for (const text of naming) {
      assert.match(text.toLowerCase(), new RegExp(UNCONFIRMED_DATE_LABEL.toLowerCase()), `"${text}" does not name the catalogue date`);
      assert.doesNotMatch(text.toLowerCase(), /verified/, `"${text}" calls the catalogue date verified`);
    }
  });

  it("publishes the attempt that did not read the page, marked as one", () => {
    withState([record({ last_attempt_at: "2026-09-09", last_outcome: ATTEMPT_FETCH_FAILED, last_success: "2026-04-12" })]);
    assert.equal(attemptThatDidNotRead(offer), "2026-09-09");
    assert.equal(verificationDatesCell(offer), "2026-04-12 · tried 2026-09-09, no read");
    assert.equal(
      verificationDatesSentence(offer),
      "Read and confirmed 2026-04-12 · tried again 2026-09-09 and did not read the page",
    );
    assert.match(lastReadNote(offer), /that attempt confirmed nothing/);
  });

  it("publishes the attempt after a read that answered on an earlier day", () => {
    withState([
      record({ last_attempt_at: "2026-09-10", last_outcome: ATTEMPT_UNCLEAR, last_success: "2026-04-12", last_read_at: "2026-09-09" }),
    ]);
    assert.equal(verificationDatesCell(offer), "2026-09-09 / 2026-04-12 · tried 2026-09-10, no read");
  });

  it("publishes no attempt where the last one read the page", () => {
    withState([record({ last_attempt_at: "2026-09-09", last_outcome: ATTEMPT_CHANGED, last_success: "2026-04-12" })]);
    assert.equal(attemptThatDidNotRead(offer), null);
    assert.doesNotMatch(verificationDatesCell(offer), /tried/);
  });

  it("publishes no attempt for a record the state file has never held", () => {
    withState([]);
    assert.equal(attemptThatDidNotRead(offer), null);
    assert.equal(verificationDatesCell(offer), "2026-04-12");
  });

  it("reads the day the page was read, not the later date the record publishes", () => {
    withState([record({ last_attempt_at: "2026-04-10", last_outcome: ATTEMPT_CHANGED, last_success: null })]);
    assert.equal(lastReadDate(offer), "2026-04-10");
  });

  it("claims no confirmation where the store holds no success", () => {
    withState([record({ last_attempt_at: "2026-09-09", last_outcome: ATTEMPT_CHANGED, last_success: null })]);
    assert.equal(confirmationDate(offer), null);
    const note = lastReadNote(offer);
    assert.ok(note.includes(NO_CONFIRMATION_HELD), note);
    assert.doesNotMatch(note, /last confirmed on/);
    assert.match(note, /on 2026-09-09, found the page different from the terms we hold/);
    assert.match(note, /the 2026-04-12 beside this date/);
  });

  it("says what a read that reached the page without terms found", () => {
    withState([record({ last_attempt_at: "2026-09-09", last_outcome: "states_no_price", last_success: null })]);
    assert.match(lastReadNote(offer), /could read no amount, tier or rate on the page/);
  });

  it("claims no confirmation where the store has never held the record", () => {
    withState([]);
    assert.equal(confirmationDate(offer), null);
    assert.ok(lastReadNote(offer).includes(NO_CONFIRMATION_HELD));
  });

  it("publishes the confirmation the store holds, not the date the record carries", () => {
    withState([record({ last_attempt_at: "2026-09-10", last_outcome: ATTEMPT_CONFIRMED, last_success: "2026-09-10" })]);
    assert.equal(confirmationDate(offer), "2026-09-10");
    assert.match(lastReadNote(offer), /read the vendor's page, and the day we last confirmed/);
    assert.doesNotMatch(lastReadNote(offer), /2026-04-12/);
  });

  it("keeps the confirmation it holds beside a later read that disagreed", () => {
    withState([record({ last_attempt_at: "2026-09-09", last_outcome: ATTEMPT_CHANGED, last_success: "2026-08-30" })]);
    assert.match(lastReadNote(offer), /last confirmed on 2026-08-30/);
  });
});

describe("the state the re-verification writes", () => {
  it("stamps a read date on every outcome that read the page", () => {
    for (const outcome of ANSWERED_OUTCOMES) {
      const next = applyAttempt(null, { vendor: "Examplebase", url: "https://examplebase.dev", outcome, date: "2026-09-09" });
      assert.equal(next.last_read_at, "2026-09-09", `${outcome} read the page and left no read date`);
    }
  });

  it("stamps no read date on an outcome that did not read the page", () => {
    for (const outcome of [ATTEMPT_FETCH_FAILED, ATTEMPT_SOURCE_UNUSABLE, ATTEMPT_UNCLEAR]) {
      const next = applyAttempt(null, { vendor: "Examplebase", url: "https://examplebase.dev", outcome, date: "2026-09-09" });
      assert.equal(next.last_read_at, null, `${outcome} did not read the page and left a read date`);
    }
  });

  it("holds the read date through a run of failures", () => {
    let state = applyAttempt(null, { vendor: "Examplebase", url: "https://examplebase.dev", outcome: ATTEMPT_CHANGED, date: "2026-09-09" });
    for (const date of ["2026-09-10", "2026-09-11", "2026-09-12"]) {
      state = applyAttempt(state, { vendor: "Examplebase", url: "https://examplebase.dev", outcome: ATTEMPT_FETCH_FAILED, date });
    }
    assert.equal(state.last_read_at, "2026-09-09");
    assert.equal(state.last_attempt_at, "2026-09-12");
  });
});

describe("the catalogue", () => {
  const offers: Array<{ vendor: string; url: string; verifiedDate: string }> =
    JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
  const state: StateRecord[] =
    JSON.parse(readFileSync(path.join(REPO, "data", "verification_state.json"), "utf-8")).records;
  const byKey = new Map(state.map((r) => [`${r.vendor}|${r.url}`, r]));

  it("publishes a read date for every record it holds", () => {
    const dated = offers.filter((o) => /^\d{4}-\d{2}-\d{2}$/.test(lastReadDate(o)));
    assertCoversPopulation(dated.length, recordsInTheCatalogue(), "records that publish a day we read the page");
  });

  it("never publishes a confirmation later than the day it read the page", () => {
    const backwards = offers.filter((o) => {
      const confirmed = confirmationDate(o);
      return confirmed !== null && confirmed > lastReadDate(o);
    });
    assert.deepEqual(backwards.map((o) => o.vendor), [], "a record cannot be confirmed on a day we did not read it");
  });

  it("dates the read from the store's attempt and not from the date the record publishes", () => {
    const answered = offers.filter((o) => {
      const held = byKey.get(`${o.vendor}|${o.url}`);
      return Boolean(held?.last_outcome && ANSWERED_OUTCOMES.has(held.last_outcome));
    });
    assertSharesPopulation(answered.length, recordsInTheCatalogue(), 0.5, "records whose last attempt read the page");
    for (const o of answered) {
      assert.equal(
        lastReadDate(o),
        byKey.get(`${o.vendor}|${o.url}`)!.last_attempt_at,
        `${o.vendor} publishes a read date the store's own attempt does not give`,
      );
    }
    const earlierThanPublished = answered.filter((o) => lastReadDate(o) < o.verifiedDate);
    assert.ok(
      earlierThanPublished.length > 0,
      "no record was read before the date it publishes, so this control cannot tell the store's attempt from that date",
    );
  });

  it("claims a confirmation only on the records the store holds a success for", () => {
    const claiming = offers.filter((o) => /last confirmed/.test(lastReadNote(o)));
    const held = offers.filter((o) => confirmationDate(o) !== null);
    assert.deepEqual(
      claiming.filter((o) => confirmationDate(o) === null).map((o) => o.vendor),
      [],
      "a record states a confirmation date the verification store cannot source",
    );
    assert.ok(held.length > 0, "the store holds no confirmation at all, so this assertion proves nothing");
    for (const o of held) {
      assert.ok(
        lastReadNote(o).includes(confirmationDate(o)!) || !/last confirmed on/.test(lastReadNote(o)),
        `${o.vendor} states a confirmation date other than the ${confirmationDate(o)} the store holds`,
      );
    }
  });

  it("counts the catalogue in each state the verification store leaves it in", () => {
    const sourced: string[] = [];
    const none: string[] = [];
    const storeIsNewer: string[] = [];
    const noRecord: string[] = [];
    for (const o of offers) {
      const held = byKey.get(`${o.vendor}|${o.url}`);
      if (!held) noRecord.push(o.vendor);
      else if (!held.last_success) none.push(o.vendor);
      else if (held.last_success > o.verifiedDate) storeIsNewer.push(o.vendor);
      else sourced.push(o.vendor);
    }
    assert.equal(
      sourced.length + none.length + storeIsNewer.length + noRecord.length,
      offers.length,
      "the four states do not partition the catalogue",
    );
    assert.ok(
      none.length + noRecord.length < offers.length,
      `every record in the catalogue publishes a date no confirmation in the store can source: ${none.length} with a state record holding no success, ${noRecord.length} with no state record`,
    );
    assertPopulationFloor(
      sourced.length + storeIsNewer.length,
      200,
      `of ${offers.length} records can source their confirmation to the store, against ${none.length} holding no success and ${noRecord.length} with no state record`,
    );
  });

  it("gains no read date from an attempt that failed", () => {
    const failed = offers.filter((o) => {
      const held = byKey.get(`${o.vendor}|${o.url}`);
      return held && held.last_outcome !== null && !ANSWERED_OUTCOMES.has(held.last_outcome);
    });
    assertSharesPopulation(failed.length, recordsInTheCatalogue(), 0.05, "records whose last attempt failed");
    for (const o of failed) {
      const held = byKey.get(`${o.vendor}|${o.url}`)!;
      const known = [o.verifiedDate, held.last_read_at ?? ""].sort().pop();
      assert.equal(
        lastReadDate(o),
        known,
        `${o.vendor} last failed on ${held.last_attempt_at} with ${held.last_outcome} and that attempt moved the read date`,
      );
    }
  });

  it("moves the read date past the confirmation on the records a read has since answered", () => {
    const moved = offers.filter((o) => lastReadDate(o) > o.verifiedDate);
    assertSharesPopulation(moved.length, recordsInTheCatalogue(), 0.25, "records read since their terms were last confirmed");
  });
});

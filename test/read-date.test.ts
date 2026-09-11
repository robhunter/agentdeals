import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertCoversPopulation, assertSharesPopulation, recordsInTheCatalogue } from "./population-floor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const { ANSWERED_OUTCOMES, applyAttempt, ATTEMPT_CHANGED, ATTEMPT_CONFIRMED, ATTEMPT_FETCH_FAILED, ATTEMPT_SOURCE_UNUSABLE, ATTEMPT_UNCLEAR } =
  await import("../scripts/verification-state.js");
const { OUTCOMES_THAT_READ_THE_PAGE, lastReadDate, lastReadNote, verificationDates, verificationDatesCell, verificationDatesSentence } =
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
    assert.equal(verificationDatesSentence(offer), "Read and verified 2026-04-12");
    assert.match(lastReadNote(offer), /read the vendor's page, and the day we last confirmed/);
  });

  it("publishes both dates, each labelled, where the read is later", () => {
    withState([record({ last_attempt_at: "2026-09-09", last_outcome: ATTEMPT_CHANGED, last_success: "2026-04-12" })]);
    assert.equal(verificationDatesCell(offer), "2026-09-09 / 2026-04-12");
    assert.equal(verificationDatesSentence(offer), "Read 2026-09-09 · verified 2026-04-12");
    assert.match(lastReadNote(offer), /last confirmed on 2026-04-12/);
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

  it("never publishes a read date earlier than the day it confirmed the terms", () => {
    const backwards = offers.filter((o) => lastReadDate(o) < o.verifiedDate);
    assert.deepEqual(backwards.map((o) => o.vendor), [], "a record cannot be confirmed on a day we did not read it");
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

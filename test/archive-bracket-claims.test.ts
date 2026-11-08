import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { bracketStatesRecord, readBracketClaims, settleAgainstCaptures, previousValueReaderFor, statedBeforeReaderFor } = await import("../scripts/archive-captures.js");
const { archiveCheckFor } = await import("../scripts/write-settled-records.js");

const FILLER = "Compare plans and features for teams of every size. ".repeat(30);
const URL = "https://example.com/pricing";
const record = {
  date: "2026-08-28", change_type: "limits_reduced",
  summary: "The Free plan now allows 25 requests per day instead of 50 requests per day.",
  previous_state: "Free plan: 50 requests per day",
  current_state: "Free plan: 25 requests per day",
};
const capture = (day: string) => ({ timestamp: `${day.replaceAll("-", "")}120000`, original: URL });
const page = (day: string, text: string) => ({ page: `capture ${day}`, day, text: `${text}. ${FILLER}`, capture: capture(day) });
const proofReader = (status: string, fields = {}) => async () => ({ status, ...fields });
const oldValues = [{ previous: "50 requests per day", current: "25 requests per day", old: "Free plan: 50 requests per day" }];
const newValues = [{ record: "now allows 25 requests per day", old: "Free plan: 25 requests per day" }];

function readers() {
  const client = { complete: async (prompt: string) => {
    if (prompt.startsWith("You are checking whether an archived page")) {
      const text = prompt.split(/ARCHIVED PAGE \(saved [^)]*\):\n/)[1].split("\n\nFind only")[0];
      return JSON.stringify({ previous_values: text.includes("Free plan: 50 requests per day") ? oldValues.map(({ previous, current, old }) => ({ previous, current, old_page: old })) : [] });
    }
    const text = prompt.split(/OLD PAGE \(saved [^)]*\):\n/)[1].split("\n\nStep 1.")[0];
    return JSON.stringify({ changes: [{ record: "now allows 25 requests per day", old_page: text.includes("Free plan: 25 requests per day") ? "Free plan: 25 requests per day" : "" }] });
  } };
  return { readPreviousValue: previousValueReaderFor(client, record), readStatedBefore: statedBeforeReaderFor(client, record) };
}

async function settle(pages: Array<{ day: string; text: string }>, overrides = {}) {
  const stored = pages.map(({ day, text }) => page(day, text));
  return settleAgainstCaptures({
    url: URL, textDay: pages[0].day, recordDay: record.date, today: "2026-09-27", todayText: stored.at(-1)!.text,
    archive: {
      captures: async () => ({ captures: stored.map((p) => p.capture) }),
      captureHtml: async (copy: { timestamp: string }) => ({ html: `<p>${stored.find((p) => p.capture.timestamp === copy.timestamp)!.text}</p>` }),
    },
    readPair: async (older: { text: string }, newer: { text: string }) => {
      const terms = (p: { text: string }) => p.text.split(". ")[0];
      return {
        status: terms(older) === terms(newer) ? "same" : "differ",
        old_terms: [terms(older)], new_terms: [terms(newer)],
        differences: [{ old: terms(older), new: terms(newer) }],
      };
    },
    ...readers(), ...overrides,
  });
}

describe("each bracket's evidence for the record's own claim", () => {
  it("retains both endpoint readings and quoted fragments in the stored archive check", async () => {
    const settled = await settle([{ day: "2026-06-01", text: record.previous_state }, { day: "2026-07-23", text: record.current_state }]);
    assert.equal(settled.outcome, "vendor_changed");
    assert.equal(settled.date, "2026-07-23");
    assert.ok(settled.brackets.every(bracketStatesRecord));
    const check = archiveCheckFor(record, settled, "2026-09-27");
    assert.deepEqual(check.brackets[0].claim_proof, settled.brackets[0].claim_proof);
    assert.deepEqual(check.brackets[0].claim_proof.older.verdict.previous_values, oldValues);
    assert.deepEqual(check.brackets[0].claim_proof.newer.verdict.stated_then, newValues);
    assert.equal(check.brackets[0].claim_proof.older.url, check.brackets[0].last_old_capture);
    assert.equal(check.brackets[0].claim_proof.newer.url, check.brackets[0].first_new_capture);
  });

  it("refuses a newer page that changes another feature without stating the record's new claim", async () => {
    const settled = await settle([{ day: "2026-06-01", text: `${record.previous_state}; Business support retention 10 days` }, { day: "2026-07-23", text: `${record.previous_state}; Business support retention 30 days` }]);
    assert.equal(settled.outcome, "no_usable_capture");
    assert.equal(settled.unverified_brackets[0].claim_proof.older.verdict.status, "stated");
    assert.equal(settled.unverified_brackets[0].claim_proof.newer.verdict.status, "unstated");
    assert.ok(settled.differences.length > 0);
  });

  it("refuses an older page that never states the earlier value", async () => {
    const settled = await settle([{ day: "2026-06-01", text: "Business support retention 10 days" }, { day: "2026-07-23", text: record.current_state }]);
    assert.equal(settled.outcome, "no_usable_capture");
    assert.equal(settled.unverified_brackets[0].claim_proof.older.verdict.status, "not_stated");
    assert.equal(settled.unverified_brackets[0].claim_proof.newer.verdict.status, "stated");
  });

  it("keeps the 50-to-25 bracket while retaining an unrelated earlier move for review", async () => {
    const settled = await settle([
      { day: "2026-06-24", text: "Free plan: 100 requests per day" },
      { day: "2026-07-02", text: record.previous_state },
      { day: "2026-07-23", text: record.current_state },
    ]);
    assert.equal(settled.outcome, "vendor_changed");
    assert.equal(settled.brackets.length, 1);
    assert.equal(settled.brackets[0].last_old, "2026-07-02");
    assert.equal(settled.brackets[0].first_new, "2026-07-23");
    assert.equal(settled.date, "2026-07-23");
    assert.equal(settled.unverified_brackets.length, 1);
    assert.equal(settled.unverified_brackets[0].first_new, "2026-07-02");
  });

  it("never falls through to our correction when an unverified move occurs after the record", async () => {
    const settled = await settle([
      { day: "2025-01-01", text: `${record.current_state}; Business support retention 10 days` },
      { day: "2026-08-20", text: `${record.current_state}; Business support retention 10 days` },
      { day: "2026-09-19", text: `${record.current_state}; Business support retention 10 days` },
      { day: "2026-09-20", text: `${record.current_state}; Business support retention 30 days` },
    ]);
    assert.equal(settled.outcome, "no_usable_capture");
    assert.equal(settled.unverified_brackets[0].relative_to_record, "after");
  });

  it("keeps both readings when a reader is missing, fails, or returns no quoted evidence", async () => {
    for (const olderReader of [undefined, async () => { throw new Error("endpoint unavailable"); }, proofReader("stated")]) {
      const proof = await readBracketClaims(page("2026-07-02", record.previous_state), page("2026-07-23", record.current_state), olderReader, proofReader("stated", { stated_then: newValues }));
      assert.equal(bracketStatesRecord({ claim_proof: proof }), false);
      assert.deepEqual(proof.newer.verdict.stated_then, newValues);
    }
    const proof = await readBracketClaims(page("2026-07-02", record.previous_state), page("2026-07-23", "No free tier"), proofReader("stated", { previous_values: oldValues }), proofReader("removal_stated", { stated_then: [{ record: "free tier removed", old: "No free tier" }] }));
    assert.equal(bracketStatesRecord({ claim_proof: proof }), true);
  });

  it("records a failed endpoint read once and retains the successful opposite reading", async () => {
    for (const failing of ["readPreviousValue", "readStatedBefore"]) {
      const readings: Array<{ newer: string; verdict: { status: string } }> = [];
      const settled = await settle([{ day: "2026-06-01", text: record.previous_state }, { day: "2026-07-23", text: record.current_state }], {
        [failing]: async () => { throw new Error("endpoint unavailable"); },
        onRead: (reading: { newer: string; verdict: { status: string } }) => readings.push(reading),
      });
      assert.equal(settled.outcome, "no_usable_capture");
      assert.equal(settled.reads, readings.length);
      assert.equal(readings.filter((reading) => reading.verdict.status === "unknown").length, 1);
      const proof = settled.unverified_brackets[0].claim_proof;
      assert.equal(proof[failing === "readPreviousValue" ? "older" : "newer"].verdict.status, "unknown");
      assert.equal(proof[failing === "readPreviousValue" ? "newer" : "older"].verdict.status, "stated");
    }
  });
});

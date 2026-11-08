import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { judgeStatedBefore, judgePreviousValue, statedBeforePrompt, previousValuePrompt } = await import("../scripts/archive-captures.js");

const record = {
  date: "2026-09-01", change_type: "limits_increased",
  summary: "The event limit has increased from 100K to 500K, and storage from 100MB to 500MB.",
  previous_state: "100K events and 100MB storage.",
  current_state: "500K events, 500MB storage and 100K queued jobs.",
};
const page = "Free: 500k events ingested. Storage: 500MB. Queue depth: 100K.";
const changes = [
  { record: "The event limit has increased from 100K to 500K", old_page: "500k events ingested" },
  { record: "storage from 100MB to 500MB", old_page: "Storage: 500MB" },
];

describe("an archived endpoint states the resulting terms", () => {
  it("does not require an old figure that the new description repeats for another feature", () => {
    const verdict = judgeStatedBefore({ changes }, record, page);
    assert.equal(verdict.status, "stated");
    assert.deepEqual(verdict.stated_then.map((row: { old: string }) => row.old), changes.map(row => row.old_page));
    assert.equal(judgeStatedBefore({ changes: changes.slice(0, 1) }, record, page).status, "unstated");
  });

  it("still requires every distinct new figure from the summary and reading", () => {
    const distinct = { ...record, summary: "Events increase from 100K to 500K. Storage increases from 100MB to 750MB.", current_state: "500K events, 750MB storage and 100K queued jobs." };
    assert.equal(judgeStatedBefore({ changes: [{ record: "500K", old_page: "500k events ingested" }] }, distinct, page).status, "unstated");
  });

  it("ignores prior terms as separate claims while retaining each new term", () => {
    for (const prior of ["Before, Free included 100K events.", "Previously 100K events.", "down from 100K", "instead of 100K"]) {
      const row = { ...record, summary: `The free plan offers 500K events. ${prior}`, current_state: "500K events with 100K queued jobs." };
      const answer = { changes: [{ record: "500K events", old_page: "500k events ingested" }, { record: prior, old_page: "" }] };
      assert.equal(judgeStatedBefore(answer, row, page).status, "stated", prior);
      assert.equal(judgeStatedBefore({ changes: answer.changes.slice(1) }, row, page).status, "unstated", prior);
    }
  });

  it("ignores evidence commentary without dropping the resulting plan allowance", () => {
    for (const evidence of ["the Internet Archive's copy of 2025-12-23 listed 100K events", "Its changelog dates the cut to June 2026"]) {
      const row = { ...record, summary: `The free plan offers 500K events; ${evidence}.`, current_state: "500K events and a 2026 feature pack." };
      assert.equal(judgeStatedBefore({ changes: [{ record: "500K events", old_page: "500k events ingested" }, { record: evidence, old_page: "" }] }, row, page).status, "stated");
    }
  });

  it("handles decimal prices in a transition", () => {
    const row = { ...record, summary: "The price rises from $0.50 to $1.25. Previously $0.50.", current_state: "$1.25 per month, with $0.50 storage." };
    assert.equal(judgeStatedBefore({ changes: [{ record: "from $0.50 to $1.25", old_page: "$1.25 per month" }] }, row, "$1.25 per month").status, "stated");
  });

  it("requires an affirmative removal rather than an omitted plan", () => {
    const row = { ...record, change_type: "free_tier_removed", summary: "The free tier is removed. Previously 100K events.", current_state: "No free tier. Paid plans start at $10." };
    const answer = { changes: [{ record: "The free tier is removed", old_page: "No free tier." }, { record: "Previously 100K events.", old_page: "" }] };
    assert.equal(judgeStatedBefore(answer, row, "No free tier.").status, "removal_stated");
    assert.equal(judgeStatedBefore({ changes: [{ record: "The free tier is removed", old_page: "Paid plans start at $10." }] }, row, "Paid plans start at $10.").status, "unstated");
  });

  it("asks for resulting claims with the replacement description as context", () => {
    const prompt = statedBeforePrompt(record, { day: "2026-07-05", text: page });
    assert.ok(prompt.includes(record.summary));
    assert.ok(prompt.includes(record.current_state));
    for (const instruction of ["check Y, never X", "Exclude previous-term clauses", "archive copies, changelogs", "page must state the removal"]) assert.ok(prompt.includes(instruction), instruction);
  });
});

describe("a quoted earlier qualitative feature", () => {
  const row = { ...record, summary: "The free plan now offers starter models only. Before, Free included cloud models.", previous_state: "Access cloud models.", current_state: "Free includes starter models only." };
  const value = { previous: "cloud models", current: "starter models only", old_page: "Access cloud models" };

  it("accepts exact shared feature words without inventing a numeric allowance", () => {
    const verdict = judgePreviousValue({ previous_values: [value] }, row, "Free: Access cloud models. Light usage.");
    assert.equal(verdict.status, "stated");
    assert.equal(verdict.previous_values[0].previous, "cloud models");
  });

  it("refuses a single generic word, a paraphrase and an unchanged feature", () => {
    for (const patch of [{ previous: "models" }, { old_page: "Access models in the cloud" }, { current: "cloud models" }]) {
      const answer = { previous_values: [{ ...value, ...patch }] };
      assert.equal(judgePreviousValue(answer, row, "Access cloud models. Access models in the cloud.").status, "unknown");
    }
  });

  it("keeps numeric witnesses strict and asks for the smallest changed fragment", () => {
    assert.equal(judgePreviousValue({ previous_values: [{ previous: "100K events", current: "500K events", old_page: "500K events" }] }, record, "500K events").status, "unknown");
    const prompt = previousValuePrompt(row, { day: "2026-08-27", text: "Access cloud models" });
    assert.ok(prompt.includes("smallest fragment naming that value"));
    assert.ok(prompt.includes("qualitative feature can be an earlier value"));
  });
});

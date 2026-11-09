import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { judgePreviousValue, previousValuePrompt, currentValuePrompt, previousValueReaderFor, statedBeforeReaderFor, settleAgainstCaptures, bracketStatesRecord, MAX_READS_PER_BRACKET } = await import("../scripts/archive-captures.js");
const { archiveCheckFor } = await import("../scripts/write-settled-records.js");
const row = { date: "2026-09-05", change_type: "limits_increased", summary: "The Free plan now includes 3 domains instead of 1 domain.", previous_state: "Free: 1 domain and 100 emails a day", current_state: "Free: 3 domains and 100 emails a day" };
const previous = { previous: "1 domain", current: "3 domains", old_page: "Free Custom domains 1" };
const current = { ...previous, old_page: "Free plan: 3 domains" };
const filler = "Compare plans and features for teams of every size. ".repeat(30);
const oldText = `Free plan: 1 domain. Free Custom domains 1. ${filler}`;
const bothText = `Free plan: 3 domains. Free Custom domains 1. ${filler}`;
const url = "https://example.test/pricing";
const copy = (day: string) => ({ timestamp: day.replaceAll("-", "") + "120000", original: url });

function client() {
  return { complete: async (prompt: string) => {
    if (prompt.startsWith("You are checking whether an archived page")) {
      const text = prompt.split(/ARCHIVED PAGE \(saved [^)]*\):\n/)[1].split("\n\nFind only")[0];
      return JSON.stringify({ previous_values: text.includes("Free Custom domains 1") ? [previous] : [], current_values: text.includes("Free plan: 3 domains") ? [current] : [] });
    }
    const text = prompt.split(/OLD PAGE \(saved [^)]*\):\n/)[1].split("\n\nStep 1.")[0];
    return JSON.stringify({ changes: [{ record: "3 domains", old_page: text.includes("Free plan: 3 domains") ? "Free plan: 3 domains" : "" }] });
  } };
}

async function settle(pages: Record<string, string | null>, overrides = {}) {
  const c = client();
  return settleAgainstCaptures({ url, textDay: "2026-08-21", recordDay: row.date, today: "2026-11-08", todayText: bothText,
    archive: { captures: async () => ({ captures: Object.keys(pages).map(copy) }), captureHtml: async (capture: { timestamp: string }) => {
      const day = `${capture.timestamp.slice(0, 4)}-${capture.timestamp.slice(4, 6)}-${capture.timestamp.slice(6, 8)}`;
      return pages[day] === null ? { unavailable: "HTTP 403" } : { html: `<p>${pages[day]}</p>` };
    } },
    readPair: async () => ({ status: "differ", old_terms: ["Free Custom domains 1"], new_terms: ["Free Custom domains 3"], differences: [{ old: "Free Custom domains 1", new: "Free Custom domains 3" }] }),
    readPreviousValue: previousValueReaderFor(c, row), readStatedBefore: statedBeforeReaderFor(c, row), ...overrides,
  });
}

describe("an older endpoint cannot already state replacement terms", () => {
  it("rejects a stale table even when it quotes the earlier value correctly", () => {
    const verdict = judgePreviousValue({ previous_values: [previous], current_values: [current] }, row, bothText);
    assert.equal(verdict.status, "new_stated");
    assert.equal(verdict.previous_values[0].old, previous.old_page);
    assert.equal(verdict.current_values[0].old, current.old_page);
    assert.equal(bracketStatesRecord({ claim_proof: { older: { verdict }, newer: { verdict: { status: "stated", stated_then: [{}] } } } }), false);
  });

  it("requires an explicit replacement check and refuses invented, unchanged or unquoted evidence", () => {
    for (const answer of [{ previous_values: [previous] }, { previous_values: [previous], current_values: null }, { previous_values: [previous], current_values: [{ ...current, old_page: "Free plan: 9 domains" }] }, { previous_values: [previous], current_values: [{ ...current, current: "9 domains" }] }, { previous_values: [previous], current_values: [{ previous: "100 emails a day", current: "100 emails a day", old_page: "100 emails a day" }] }]) {
      assert.equal(judgePreviousValue(answer, row, `${bothText} 100 emails a day`).status, "unknown");
    }
    assert.equal(judgePreviousValue({ previous_values: [previous], current_values: [] }, row, oldText).status, "stated");
    assert.equal(bracketStatesRecord({ claim_proof: { older: { verdict: { status: "stated", previous_values: [previous] } }, newer: { verdict: { status: "stated", stated_then: [{}] } } } }), false);
  });

  it("refuses replacement quotes that name another feature or mix plan-column values", async () => {
    for (const fixture of [
      { record: row, value: previous, text: "Free Custom domains 1. Custom domains 1 3. " + filler, quote: "Custom domains 1 3" },
      { record: { ...row, summary: "Free now includes unlimited monthly active users and rooms.", previous_state: "500 monthly active rooms", current_state: "unlimited monthly active users and rooms" }, value: { previous: "500 monthly active rooms", current: "unlimited monthly active users and rooms", old_page: "500 monthly active rooms" }, text: "500 monthly active rooms. Monthly active users Unlimited. " + filler, quote: "Monthly active users Unlimited" },
    ]) {
      const c = { complete: async (prompt: string) => JSON.stringify(prompt.includes('"previous_values"') ? {previous_values:[fixture.value]} : {changes:[{record:fixture.value.current,old_page:fixture.quote}]}) };
      assert.equal((await previousValueReaderFor(c,fixture.record)({day:"2026-08-21",text:fixture.text})).status,"unknown");
    }
  });

  it("requires the complete page before certifying that no replacement is present", () => {
    const answer = { previous_values: [previous], current_values: [] };
    assert.equal(judgePreviousValue(answer, row, oldText.padEnd(100000, " ")).status, "stated");
    assert.equal(judgePreviousValue(answer, row, oldText.padEnd(100001, " ")).status, "unknown");
    assert.equal(judgePreviousValue({ ...answer, current_values: [current] }, row, bothText.padEnd(100001, " ")).status, "new_stated");
    const prompt = currentValuePrompt(row, { day: "2026-08-21", text: bothText });
    assert.ok(prompt.includes("including both plan cards and comparison tables"));
    assert.ok(prompt.includes("Exclude unchanged allowances and other plans or features"));
    assert.ok(!previousValuePrompt(row, {day:"2026-08-21",text:bothText}).includes('"current_values"'));
  });

  it("moves back past conflicting cards and tables and dates the actual first replacement", async () => {
    const result = await settle({ "2026-08-18": oldText, "2026-08-19": oldText, "2026-08-20": bothText, "2026-08-21": bothText, "2026-08-22": bothText });
    assert.equal(result.outcome, "vendor_changed");
    assert.equal(result.brackets.length, 1);
    assert.deepEqual([result.brackets[0].last_old, result.brackets[0].first_new], ["2026-08-19", "2026-08-20"]);
    assert.equal(result.date, "2026-08-20");
    assert.ok(bracketStatesRecord(result.brackets[0]));
    assert.deepEqual(result.brackets[0].rejected_older_endpoints.map((endpoint: { day: string }) => endpoint.day), ["2026-08-21", "2026-08-20"]);
    const stored = archiveCheckFor(row, result, "2026-11-08");
    assert.deepEqual(stored.brackets[0].rejected_older_endpoints, result.brackets[0].rejected_older_endpoints);
    assert.equal(stored.brackets[0].claim_proof.older.verdict.current_values_checked, true);
  });

  it("keeps the original refused proof when no eligible earlier capture establishes old terms", async () => {
    for (const earlier of [null, "A readable page with no allowance. " + filler, bothText]) {
      const result = await settle({ "2026-08-19": earlier, "2026-08-21": bothText, "2026-08-22": bothText });
      assert.equal(result.outcome, "no_usable_capture");
      const bracket = result.unverified_brackets[0];
      assert.equal(bracket.last_old, bracket.claim_proof.older.day);
      assert.equal(bracket.first_new, bracket.claim_proof.newer.day);
      assert.equal(bracket.claim_proof.older.verdict.status, "new_stated");
    }
  });

  it("refuses a failed earlier reading and bounds the backward search", async () => {
    const pages = { "2026-08-01": oldText, "2026-08-21": bothText, "2026-08-22": bothText };
    for (let day = 2; day < 21; day++) pages[`2026-08-${String(day).padStart(2, "0")}`] = bothText;
    const result = await settle(pages);
    assert.equal(result.outcome, "no_usable_capture");
    assert.equal(result.unverified_brackets[0].rejected_older_endpoints.length, MAX_READS_PER_BRACKET + 1);
    const failed = await settle({ "2026-08-19": oldText, "2026-08-21": bothText, "2026-08-22": bothText }, { readPreviousValue: async (page: { day: string; text: string }) => {
      if (page.day === "2026-08-19") throw new Error("reader unavailable");
      return judgePreviousValue({ previous_values: [previous], current_values: [current] }, row, page.text);
    } });
    assert.equal(failed.outcome, "no_usable_capture");
  });
});

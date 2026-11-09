import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { judgeStatedBefore, judgePreviousValue, statedBeforePrompt, previousValuePrompt } = await import("../scripts/archive-captures.js");
const filler = "Compare the available plans and contact our team for more details. ".repeat(12);
const row = {
  date: "2026-05-15", change_type: "free_tier_removed",
  summary: "The free tier no longer exists. Paid plans now start at €19 a month.",
  previous_state: "Free Sandbox plan with 5 monitors. Free forever.",
  current_state: "Paid plans start at €19 a month, with 5 monitors and a 14-day trial.",
};
const plan = { name: "Starter", old_page: "Starter €9 /month Billed monthly", kind: "paid" };
const answer = { changes: [], record: "The free tier no longer exists", offered_plans: [plan] };
const page = `${plan.old_page}. ${filler}`;

describe("a removed free plan's newer pricing page", () => {
  it("dates the removal without demanding current paid prices or removed allowances", () => {
    const result = judgeStatedBefore(answer, row, page);
    assert.equal(result.status, "removal_stated");
    assert.deepEqual(result.stated_then, [{ record: answer.record, old: plan.old_page }]);
    assert.deepEqual(result.offered_plans, [plan]);
  });

  it("accepts paid plans alongside a finite trial and a sales plan", () => {
    const extra = [
      { name: "Evaluation", old_page: "Evaluation 14-day free trial", kind: "trial" },
      { name: "Enterprise", old_page: "Enterprise Custom pricing Contact sales", kind: "contact_sales" },
    ];
    assert.equal(judgeStatedBefore({ ...answer, offered_plans: [plan, ...extra] }, row, `${page} ${extra.map(p => p.old_page).join(". ")}`).status, "removal_stated");
  });

  it("refuses shells, short pages, empty inventories and missing plan quotes", () => {
    for (const [response, text] of [
      [answer, plan.old_page],
      [{ ...answer, offered_plans: [] }, filler],
      [answer, filler],
      [{ ...answer, offered_plans: [{ ...plan, old_page: "Starter €19 /month" }] }, page],
      [{ ...answer, offered_plans: [{ ...plan, name: "Business" }] }, page],
      [{ ...answer, offered_plans: [plan, plan] }, page],
    ]) assert.equal(judgeStatedBefore(response, row, text).status, "unstated");
  });

  it("refuses a permanent free plan even when the reader omits or mislabels it", () => {
    const free = { name: "Free", old_page: "Free $0 /mo Free forever", kind: "free" };
    for (const offered_plans of [[plan], [plan, free], [plan, { ...free, kind: "paid" }]]) {
      assert.equal(judgeStatedBefore({ ...answer, offered_plans }, row, `${page} ${free.old_page}`).status, "unstated");
    }
  });

  it("requires a supported price or sales term and a finite trial", () => {
    for (const entry of [
      { name: "Starter", old_page: "Starter Sign up", kind: "paid" },
      { name: "Starter", old_page: "Starter $0 per month", kind: "paid" },
      { name: "Starter", old_page: "Starter Free trial", kind: "trial" },
      { name: "Starter", old_page: "Starter 14-day free trial", kind: "unknown" },
      { name: "Starter", old_page: "Starter Sign up", kind: "contact_sales" },
    ]) assert.equal(judgeStatedBefore({ ...answer, offered_plans: [entry] }, row, `${entry.old_page}. ${filler}`).status, "unstated");
    const trial = { name: "Evaluation", old_page: "Evaluation 14-day free trial", kind: "trial" };
    assert.equal(judgeStatedBefore({ ...answer, offered_plans: [trial] }, row, `${trial.old_page} ${filler}`).status, "unstated");
  });

  it("binds the quoted claim to the record's removal", () => {
    for (const record of ["No free tier", "Paid plans now start at €19 a month"]) assert.equal(judgeStatedBefore({ ...answer, record }, row, page).status, "unstated");
    const summary = "Momento ended the free allowance on its pay-as-you-go plan, the first 5 million operations each month.";
    assert.equal(judgeStatedBefore({ ...answer, record: "ended the free allowance on its pay-as-you-go plan" }, { ...row, summary }, page).status, "removal_stated");
  });

  it("asks for the complete offered-plan list while keeping paid terms as context", () => {
    const prompt = statedBeforePrompt(row, { day: "2026-05-15", text: page });
    for (const words of ["List every plan", "Paid prices, paid limits", "free trial is not a permanent free plan", "app shell", "offered_plans"]) assert.ok(prompt.includes(words), words);
  });
});

describe("the removed plan's older free terms", () => {
  it("accepts an exact permanent free offer without unrelated old numeric allowances", () => {
    const value = { previous: "Free forever", current: "Paid plans start at €19 a month", old_page: "Free forever" };
    assert.equal(judgePreviousValue({ previous_values: [value] }, row, `Sandbox $0/mo Free forever. ${filler}`).status, "stated");
    assert.equal(judgePreviousValue({ previous_values: [value] }, row, filler).status, "unknown");
    assert.equal(judgePreviousValue({ previous_values: [value] }, { ...row, change_type: "limits_reduced" }, `Free forever ${filler}`).status, "unknown");
    assert.ok(previousValuePrompt(row, { day: "2026-05-13", text: filler }).includes('exact "Free forever" fragment'));
    assert.ok(!previousValuePrompt({ ...row, previous_state: "Free: €0 a month, forever free." }, { day: "2026-05-13", text: filler }).includes('exact "Free forever" fragment'));
  });
});

const allowance = {
  ...row, change_type: "limits_increased",
  summary: "The free tier now has a limit of 3,000 emails/month (100/day) and includes 3 domains. Previously 3K emails/month (100/day) and 1 domain.",
  previous_state: "3K emails/month free (100/day cap), 1 domain",
  current_state: "3,000 emails / mo, 100 emails a day, 3 domains",
};

describe("a changed allowance alongside unchanged figures", () => {
  it("does not ask for unchanged email allowances when domains increase", () => {
    assert.equal(judgeStatedBefore({ changes: [{ record: "includes 3 domains", old_page: "3 domains" }] }, allowance, `3 domains ${filler}`).status, "stated");
  });

  it("still requires a changed allowance that reuses another feature's old figure", () => {
    const record = { ...allowance, summary: "The free tier now includes 3 domains and 100 emails/day.", previous_state: "1 domain and 100 requests/day.", current_state: "3 domains and 100 emails/day." };
    assert.equal(judgeStatedBefore({ changes: [{ record: "3 domains", old_page: "3 domains" }] }, record, `3 domains ${filler}`).status, "unstated");
  });

  it("requires a changed currency, period or new value", () => {
    for (const [before, summary, current] of [
      ["$10/month and 1 domain", "Now €10/month and 3 domains", "€10/month and 3 domains"],
      ["100 emails/month and 1 domain", "Now 100 emails/day and 3 domains", "100 emails/day and 3 domains"],
      ["3K emails/month and 1 domain", "Now 5K emails/month and 3 domains", "5K emails/month and 3 domains"],
    ]) assert.equal(judgeStatedBefore({ changes: [{ record: "3 domains", old_page: "3 domains" }] }, { ...allowance, previous_state: before, summary, current_state: current }, `3 domains ${filler}`).status, "unstated");
  });
});

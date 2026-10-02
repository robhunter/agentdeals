import { describe, it } from "node:test";
import assert from "node:assert";

const { judgeStatedBefore, parseStatedBeforeAnswer, statedBeforePrompt, statedBeforeReaderFor, settleAgainstCaptures } = await import("../scripts/archive-captures.js");

type Change = { record: string; old_page: string };
type ChangeRecord = { date: string; change_type: string; summary: string; current_state: string };

const FILLER = "Compare plans and features for teams of every size. ".repeat(30);

const ONESIGNAL: ChangeRecord = {
  date: "2026-09-25",
  change_type: "limits_reduced",
  summary: "The free tier now has limits on monthly active users for mobile push notifications (up to 1,000) and web push notifications (max 10,000 subscribers per send). Email sends are limited to 10,000/month.",
  current_state: "Free $0/mo. Access to: All channels, Basic automation & analytics, OneSignal AI & MCP, Basic personalization. Mobile Push Notifications for organizations with up to 1,000 monthly active users. Web Push Notifications Max 10,000 subscribers per send. Email 10,000 sends / month.",
};
const ONESIGNAL_CAPTURE = `Pricing. Free $0/mo Access to: All channels Mobile Push Notifications For organizations with up to 1,000 monthly active users Web Push Notifications Max 10,000 subscribers per send Email 10,000 sends / month Growth $19/mo. ${FILLER}`;
const ONESIGNAL_ANSWER: Change[] = [
  { record: "limits on monthly active users for mobile push notifications (up to 1,000)", old_page: "For organizations with up to 1,000 monthly active users" },
  { record: "web push notifications (max 10,000 subscribers per send)", old_page: "Max 10,000 subscribers per send" },
  { record: "Email sends are limited to 10,000/month", old_page: "Email 10,000 sends / month" },
];

const LOST_PIXEL: ChangeRecord = {
  date: "2026-08-28",
  change_type: "product_deprecated",
  summary: "Lost Pixel is being sunset as they are joining Figma. While a free tier still exists, it's now listed as 'Hobby Free' and offers 7,000 snapshots/month. There are also paid tiers: Startup ($100/mo), Business ($250/mo), and Scale ($670/mo).",
  current_state: "Lost Pixel is sunsetting the product and building what's next. A 'Hobby Free' tier is available with 7,000 shots per month. Paid tiers include Startup ($100/mo, 40,000 shots), Business ($250/mo, 100,000 shots), and Scale ($670/mo, 300,000 shots).",
};
const LOST_PIXEL_CAPTURE = `Holistic visual regression testing. Hobby Free Shots per Month 7,000 Startup $100/mo Business $250/mo Scale $670/mo. ${FILLER}`;
const LOST_PIXEL_ANSWER: Change[] = [
  { record: "Lost Pixel is being sunset as they are joining Figma", old_page: "" },
  { record: "it's now listed as 'Hobby Free' and offers 7,000 snapshots/month", old_page: "Hobby Free Shots per Month 7,000" },
  { record: "Startup ($100/mo), Business ($250/mo), and Scale ($670/mo)", old_page: "Startup $100/mo Business $250/mo Scale $670/mo" },
];

const IPWHO: ChangeRecord = {
  date: "2026-08-28",
  change_type: "pricing_restructured",
  summary: "The free tier now has no stated request limit, but is described as 'Free forever for side projects, learning and non-profits'. A paid tier at $2.50/month lifts the cap and allows for business use.",
  current_state: "Free forever for side projects, learning and non-profits. $2.50/mo lifts the cap and clears you for business use.",
};
const IPWHO_CAPTURE = `IP Geolocation API. Fast, enterprise grade API at non-enterprise prices. Free. No credit card required. Servers in 12+ regions. ${FILLER}`;

const statusOf = (record: ChangeRecord, changes: Change[], page: string) => judgeStatedBefore({ changes }, record, page);

describe("a line on the old capture that already states what the record calls new", () => {
  it("is found for each of OneSignal's limits on its capture from before the record, so the difference is ours", () => {
    const verdict = statusOf(ONESIGNAL, ONESIGNAL_ANSWER, ONESIGNAL_CAPTURE);
    assert.strictEqual(verdict.status, "stated");
    assert.deepStrictEqual(verdict.stated_then.map((change: { old: string }) => change.old), ONESIGNAL_ANSWER.map((change) => change.old_page));
  });

  it("is missing for lost-pixel.com's sunset, so the record goes to review although its plan lines match", () => {
    const verdict = statusOf(LOST_PIXEL, LOST_PIXEL_ANSWER, LOST_PIXEL_CAPTURE);
    assert.strictEqual(verdict.status, "unstated");
    assert.deepStrictEqual(verdict.review, [{ record: "Lost Pixel is being sunset as they are joining Figma", old: "", why: "the capture does not state it" }]);
  });

  it("is missing for ipwho.org when the reader pairs its new terms with lines on the page that state other terms", () => {
    const verdict = statusOf(
      IPWHO,
      [
        { record: "'Free forever for side projects, learning and non-profits'", old_page: "Free." },
        { record: "A paid tier at $2.50/month lifts the cap and allows for business use", old_page: "No credit card required." },
      ],
      IPWHO_CAPTURE,
    );
    assert.strictEqual(verdict.status, "unstated");
    assert.deepStrictEqual(verdict.review.map((change: { record: string; why: string }) => [change.record, change.why]), [
      ["A paid tier at $2.50/month lifts the cap and allows for business use", 'the capture\'s words do not state "2.5"'],
    ]);
  });

  it("is missing for ipwho.org when the reader says its capture states none of it", () => {
    const verdict = statusOf(
      IPWHO,
      [
        { record: "'Free forever for side projects, learning and non-profits'", old_page: "" },
        { record: "A paid tier at $2.50/month lifts the cap and allows for business use", old_page: "" },
      ],
      IPWHO_CAPTURE,
    );
    assert.strictEqual(verdict.status, "unstated");
    assert.strictEqual(verdict.review.length, 2);
  });

  it("must be on the capture word for word", () => {
    const answer = ONESIGNAL_ANSWER.map((change, at) => (at === 0 ? { ...change, old_page: "For teams with up to 1,000 monthly active users" } : change));
    const verdict = statusOf(ONESIGNAL, answer, ONESIGNAL_CAPTURE);
    assert.strictEqual(verdict.status, "unstated");
    assert.deepStrictEqual(verdict.review.map((change: { why: string }) => change.why), ["these words are not on the capture"]);
  });

  it("answers only for changes named in the record's own words", () => {
    const answer = [...ONESIGNAL_ANSWER, { record: "Growth costs $19 a month", old_page: "Growth $19/mo" }];
    const verdict = statusOf(ONESIGNAL, answer, ONESIGNAL_CAPTURE);
    assert.strictEqual(verdict.status, "unstated");
    assert.match(verdict.why, /not the record's words: "Growth costs \$19 a month"/);
  });

  it("is not found when the reader leaves out a figure that the record's summary and its reading both state", () => {
    const verdict = statusOf(ONESIGNAL, ONESIGNAL_ANSWER.slice(1), ONESIGNAL_CAPTURE);
    assert.strictEqual(verdict.status, "unstated");
    assert.match(verdict.why, /named no change stating "1000"/);
  });

  it("need not state a figure the record gives only as the earlier one", () => {
    const record = {
      date: "2026-08-28",
      change_type: "limits_increased",
      summary: "Email is now 10,000 free sends/month (previously 100/day).",
      current_state: "Free access to: 10,000/mo Free Email Sends.",
    };
    const page = `Free access to: 10,000/mo Free Email Sends. ${FILLER}`;
    assert.strictEqual(statusOf(record, [{ record: "Email is now 10,000 free sends/month", old_page: "10,000/mo Free Email Sends" }], page).status, "stated");
    assert.strictEqual(statusOf(record, [{ record: "Email is now 10,000 free sends/month (previously 100/day)", old_page: "10,000/mo Free Email Sends" }], page).status, "stated");
  });

  it("is not found when the answer cannot be read or names no change", () => {
    assert.strictEqual(judgeStatedBefore(null, ONESIGNAL, ONESIGNAL_CAPTURE).status, "unstated");
    assert.strictEqual(statusOf(ONESIGNAL, [], ONESIGNAL_CAPTURE).status, "unstated");
  });
});

const LOST_PIXEL_PLAN_LINES_ONLY = LOST_PIXEL_ANSWER.slice(1);
const LOST_PIXEL_SUNSET_CAPTURE = `Lost Pixel is joining Figma. We are sunsetting the product and building what's next. ${LOST_PIXEL_CAPTURE}`;

const WEBVIZIO: ChangeRecord = {
  date: "2026-08-28",
  change_type: "free_tier_removed",
  summary: "The deal is no longer a permanently free tier. It is now a 7-day free trial.",
  current_state: "Offers a 7-day free trial, no credit card required.",
};
const WEBVIZIO_TRIAL_LINES: Change[] = [
  { record: "The deal is no longer a permanently free tier.", old_page: "Start Free" },
  { record: "It is now a 7-day free trial.", old_page: "7-day free trial" },
];

describe("the change a record's type names, when it is not a figure", () => {
  it("is missing for lost-pixel.com when the reader leaves its sunset out and copies only its plan lines", () => {
    assert.strictEqual(statusOf({ ...LOST_PIXEL, change_type: "limits_reduced" }, LOST_PIXEL_PLAN_LINES_ONLY, LOST_PIXEL_CAPTURE).status, "stated");
    const verdict = statusOf(LOST_PIXEL, LOST_PIXEL_PLAN_LINES_ONLY, LOST_PIXEL_CAPTURE);
    assert.strictEqual(verdict.status, "unstated");
    assert.strictEqual(verdict.why, "no line copied from it reads as a deprecation");
    assert.deepStrictEqual(verdict.review, []);
  });

  it("is found for a product_deprecated record whose older capture already carries the shutdown line, as a removal older than our text", () => {
    const answer = [{ record: "Lost Pixel is being sunset as they are joining Figma", old_page: "We are sunsetting the product and building what's next." }, ...LOST_PIXEL_PLAN_LINES_ONLY];
    assert.strictEqual(statusOf(LOST_PIXEL, answer, LOST_PIXEL_SUNSET_CAPTURE).status, "removal_stated");
  });

  it("is missing for a free_tier_removed record whose copied lines offer a trial but never say there is no free tier", () => {
    const capture = `Website feedback for teams. Start Free 7-day free trial Cancel anytime No credit card required. ${FILLER}`;
    assert.strictEqual(statusOf({ ...WEBVIZIO, change_type: "pricing_restructured" }, WEBVIZIO_TRIAL_LINES, capture).status, "stated");
    const verdict = statusOf(WEBVIZIO, WEBVIZIO_TRIAL_LINES, capture);
    assert.strictEqual(verdict.status, "unstated");
    assert.strictEqual(verdict.why, "no line copied from it says there is no free tier");
  });

  it("is found for a free_tier_removed record whose older capture already says there is no free tier, as a removal older than our text", () => {
    const capture = `Website feedback for teams. No free tier. 7-day free trial Cancel anytime No credit card required. ${FILLER}`;
    const answer = [{ record: "The deal is no longer a permanently free tier.", old_page: "No free tier." }, WEBVIZIO_TRIAL_LINES[1]];
    assert.strictEqual(statusOf(WEBVIZIO, answer, capture).status, "removal_stated");
  });

  for (const changeType of ["restriction", "open_source_killed"]) {
    it(`is never found for ${changeType} records, which have no line to check`, () => {
      const verdict = statusOf({ ...ONESIGNAL, change_type: changeType }, ONESIGNAL_ANSWER, ONESIGNAL_CAPTURE);
      assert.strictEqual(verdict.status, "unstated");
      assert.strictEqual(verdict.why, `${changeType} records always go to review`);
    });
  }
});

describe("the reader asked for that line", () => {
  it("is shown the record's summary and the old capture with its day", () => {
    const prompt = statedBeforePrompt(LOST_PIXEL, { day: "2026-02-09", text: LOST_PIXEL_CAPTURE });
    assert.ok(prompt.includes(LOST_PIXEL.summary));
    assert.ok(prompt.includes("OLD PAGE (saved 2026-02-09, truncated):"));
    assert.ok(prompt.includes("Hobby Free Shots per Month 7,000"));
    assert.ok(prompt.includes('{"changes":[{"record":'));
  });

  it("answers in JSON that may come fenced", () => {
    assert.deepStrictEqual(parseStatedBeforeAnswer('```json\n{"changes":[]}\n```'), { changes: [] });
    assert.strictEqual(parseStatedBeforeAnswer('{"same":true}'), null);
  });
});

const TEXT_DAY = "2026-02-09";
const TODAY = "2026-10-01";

function settleWithOneCapture(record: ChangeRecord, capturedText: string, readStatedBefore?: unknown) {
  const reads: string[] = [];
  return {
    reads,
    settled: settleAgainstCaptures({
      url: "https://example.com/pricing",
      textDay: TEXT_DAY,
      recordDay: record.date,
      todayText: `${capturedText} Updated.`,
      today: TODAY,
      archive: {
        captures: async () => ({ captures: [{ timestamp: "20260209120000", original: "https://example.com/pricing", statuscode: "200", mimetype: "text/html" }] }),
        captureHtml: async () => ({ html: `<html><body><p>${capturedText}</p></body></html>` }),
      },
      readPair: async () => ({ status: "same", old_terms: ["Free"], new_terms: ["Free"] }),
      readStatedBefore,
      onRead: ({ older, newer }: { older: string; newer: string }) => reads.push(`${older} | ${newer}`),
    }),
  };
}

const clientAnswering = (changes: Change[], prompts: string[] = []) => ({
  complete: async (prompt: string) => {
    prompts.push(prompt);
    return JSON.stringify({ changes });
  },
});

describe("settling a record whose terms the capture and the record's day agree on", () => {
  it("calls it ours once the reader finds the line, and keeps the line in the result", async () => {
    const prompts: string[] = [];
    const { settled, reads } = settleWithOneCapture(ONESIGNAL, ONESIGNAL_CAPTURE, statedBeforeReaderFor(clientAnswering(ONESIGNAL_ANSWER, prompts), ONESIGNAL));
    const result = await settled;
    assert.strictEqual(result.outcome, "ours");
    assert.deepStrictEqual(result.stated_then.map((change: { old: string }) => change.old), ONESIGNAL_ANSWER.map((change) => change.old_page));
    assert.deepStrictEqual(reads, ["capture 2026-02-09 | today", "capture 2026-02-09 | the record"]);
    assert.strictEqual(result.reads, 2);
    assert.ok(prompts[0].includes("OLD PAGE (saved 2026-02-09, truncated):"));
  });

  it("sends lost-pixel.com to review with the change no line states, as a record with no usable capture", async () => {
    const { settled } = settleWithOneCapture(LOST_PIXEL, LOST_PIXEL_CAPTURE, statedBeforeReaderFor(clientAnswering(LOST_PIXEL_ANSWER), LOST_PIXEL));
    const result = await settled;
    assert.strictEqual(result.outcome, "no_usable_capture");
    assert.deepStrictEqual(result.review.map((change: { record: string }) => change.record), ["Lost Pixel is being sunset as they are joining Figma"]);
    assert.match(result.why, /^the capture 2026-02-09 states the plan's terms as the page did on the record's day, but no line already states "Lost Pixel is being sunset as they are joining Figma"$/);
  });

  it("sends lost-pixel.com to review when the reader leaves its sunset out, as a record with no usable capture", async () => {
    const { settled } = settleWithOneCapture(LOST_PIXEL, LOST_PIXEL_CAPTURE, statedBeforeReaderFor(clientAnswering(LOST_PIXEL_PLAN_LINES_ONLY), LOST_PIXEL));
    const result = await settled;
    assert.strictEqual(result.outcome, "no_usable_capture");
    assert.deepStrictEqual(result.review, []);
    assert.strictEqual(result.why, "the capture 2026-02-09 states the plan's terms as the page did on the record's day, but no line copied from it reads as a deprecation");
  });

  it("never calls a removal ours: one the older capture already states keeps its type and goes to review, to be dated", async () => {
    const answer = [{ record: "Lost Pixel is being sunset as they are joining Figma", old_page: "We are sunsetting the product and building what's next." }, ...LOST_PIXEL_PLAN_LINES_ONLY];
    const { settled } = settleWithOneCapture(LOST_PIXEL, LOST_PIXEL_SUNSET_CAPTURE, statedBeforeReaderFor(clientAnswering(answer), LOST_PIXEL));
    const result = await settled;
    assert.strictEqual(result.outcome, "removal_stated_before");
    assert.strictEqual(result.why, "the capture 2026-02-09 already states the removal, so it predates our text: to be dated");
    assert.deepStrictEqual(result.stated_then.map((change: { old: string }) => change.old), answer.map((change) => change.old_page));
  });

  it("never calls it ours when no reader is asked for the line", async () => {
    const result = await settleWithOneCapture(ONESIGNAL, ONESIGNAL_CAPTURE).settled;
    assert.strictEqual(result.outcome, "no_usable_capture");
    assert.match(result.why, /no reader was asked for a line that already states what the record calls new/);
  });
});

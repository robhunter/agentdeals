import { describe, it } from "node:test";
import assert from "node:assert";

const { figuresOurCheckQuotes, quotedFiguresWhoseTermsEnded } = await import("../dist/check-figures-ended.js");
const {
  CHECK_FIGURES_ENDED_CLASS,
  CHECK_FINDING_CLASS,
  checkFiguresEndedSentence,
  citedSourcesListHtml,
  freeTierSourceOf,
  readClauseHtml,
  readSourceOf,
} = await import("../dist/source-citation.js");

type DealChange = import("../src/types.ts").DealChange;

const SERVED_ON = "2026-09-30";
const FINDING = 'the page names Relaybox as "relaybox" and states "$0" and "60 requests/min"';

function record(overrides: Partial<DealChange>): DealChange {
  return {
    vendor: "Relaybox",
    change_type: "restriction",
    date: "2026-06-18",
    summary: "Relaybox stopped accepting personal accounts.",
    previous_state: "Personal accounts: 60 requests a minute at no cost",
    current_state: "Personal accounts no longer sign in. Team plans only.",
    impact: "medium",
    source_url: "https://relaybox.example/changelog",
    category: "AI Coding",
    alternatives: [],
    recorded_date: "2026-09-26",
    date_source: "hand_written",
    ...overrides,
  };
}

const identity = (text: string) => text;

describe("a figure our check quotes from terms our change log records as ended", () => {
  it("reads the figures the check quotes and not the form in which the page names the service", () => {
    assert.deepStrictEqual(figuresOurCheckQuotes(FINDING), ["$0", "60 requests/min"]);
    assert.deepStrictEqual(figuresOurCheckQuotes('the page names Relaybox as "relaybox 60 requests"'), []);
  });

  it("finds the figure a standing-condition record lists only among the terms it replaced", () => {
    const ending = record({});
    const ended = quotedFiguresWhoseTermsEnded(FINDING, [ending], SERVED_ON);
    assert.deepStrictEqual(ended, [{ figures: ["60 requests/min"], record: ending }]);
  });

  it("leaves a figure alone when a later record states it among the current terms", () => {
    const restored = record({
      change_type: "limits_increased",
      date: "2026-08-01",
      previous_state: "Team plans only",
      current_state: "Personal accounts are back: 60 requests a minute at no cost",
    });
    assert.deepStrictEqual(quotedFiguresWhoseTermsEnded(FINDING, [record({}), restored], SERVED_ON), []);
  });

  it("leaves a figure alone when the restriction that narrowed the terms keeps it among the current ones", () => {
    const cardNowRequired = record({
      previous_state: "Personal accounts: 60 requests a minute, no card needed",
      current_state: "Personal accounts: 60 requests a minute, with a card on file",
    });
    assert.deepStrictEqual(quotedFiguresWhoseTermsEnded(FINDING, [cardNowRequired], SERVED_ON), []);
  });

  it("leaves a figure alone when only a one-off change such as a limit cut replaced it", () => {
    const cut = record({ change_type: "limits_reduced" });
    assert.deepStrictEqual(quotedFiguresWhoseTermsEnded(FINDING, [cut], SERVED_ON), []);
  });

  it("leaves a figure alone when the record that ended it is retracted, reversed or our own correction", () => {
    const retracted = record({ resolution: { state: "retracted", date: "2026-09-01", detail: "never happened" } } as Partial<DealChange>);
    const reversed = record({ resolution: { state: "reversed", date: "2026-09-01", detail: "restored" } } as Partial<DealChange>);
    const correction = record({ change_type: "record_corrected" });
    for (const each of [retracted, reversed, correction]) {
      assert.deepStrictEqual(quotedFiguresWhoseTermsEnded(FINDING, [each], SERVED_ON), [], each.change_type);
    }
  });

  it("leaves a figure alone while the ending it records is still to come", () => {
    const ahead = record({ date: "2026-10-15" });
    assert.deepStrictEqual(quotedFiguresWhoseTermsEnded(FINDING, [ahead], SERVED_ON), []);
  });

  it("dates the ending the way the change log does, including a record dated the day we found it", () => {
    assert.strictEqual(
      checkFiguresEndedSentence({ figures: ["60 requests/min"], record: record({}) }),
      'Our change log records the terms behind "60 requests/min" as ended (effective 2026-06-18)',
    );
    assert.match(
      checkFiguresEndedSentence({ figures: ["60 requests/min"], record: record({ date_source: "discovered" }) }),
      /as ended \(discovered 2026-06-18 · effective date unknown\)$/,
    );
  });

  it("prints the ending in the same sentence run as the check, outside the words it attributes to the check", () => {
    const source = freeTierSourceOf(
      {
        url: "https://relaybox.example/pricing",
        tier: "Free",
        verifiedDate: "2026-08-01",
        source_check: { checked: SERVED_ON, outcome: "ok", detail: FINDING },
      },
      { changes: [record({})], servedOn: SERVED_ON },
    );
    assert.ok(source.cited);
    const html = readClauseHtml(source.readOn, [readSourceOf(source)], identity, { dateClass: "read-on" });
    const attributed = html.match(new RegExp(`<span class="${CHECK_FINDING_CLASS}">([^<]*)</span>`))?.[1] ?? "";
    assert.ok(attributed.endsWith('"60 requests/min"'), attributed);
    assert.ok(
      html.endsWith(`. <span class="${CHECK_FIGURES_ENDED_CLASS}">Our change log records the terms behind "60 requests/min" as ended (effective 2026-06-18)</span>`),
      html,
    );
  });

  it("prints the ending in a list of sources as it does beside a single read", () => {
    const source = freeTierSourceOf(
      {
        url: "https://relaybox.example/pricing",
        tier: "Free",
        verifiedDate: "2026-08-01",
        source_check: { checked: SERVED_ON, outcome: "ok", detail: FINDING },
      },
      { changes: [record({})], servedOn: SERVED_ON },
    );
    const list = citedSourcesListHtml([{ vendor: "Relaybox", slug: null, source }], identity, "read-on");
    const item = list.match(/<li\b[\s\S]*?<\/li>/)?.[0] ?? "";
    assert.match(item, new RegExp(`class="${CHECK_FIGURES_ENDED_CLASS}">[^<]*effective 2026-06-18`));
  });

  it("prints nothing extra where no record ends a quoted figure", () => {
    const source = freeTierSourceOf(
      {
        url: "https://relaybox.example/pricing",
        tier: "Free",
        verifiedDate: "2026-08-01",
        source_check: { checked: SERVED_ON, outcome: "ok", detail: FINDING },
      },
      { changes: [], servedOn: SERVED_ON },
    );
    assert.ok(source.cited);
    const html = readClauseHtml(source.readOn, [readSourceOf(source)], identity, { dateClass: "read-on" });
    assert.doesNotMatch(html, new RegExp(CHECK_FIGURES_ENDED_CLASS));
  });
});

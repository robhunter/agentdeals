import { describe, it } from "node:test";
import assert from "node:assert";
import {
  classifyStability,
  demotionForChange,
  demotionInForce,
  demotionWithheldUnconfirmed,
  stabilityWithholdingReason,
  vendorRiskAssessment,
  withheldRecordCounts,
} from "../dist/data.js";
import { changeIsUnconfirmed } from "../dist/change-confirmation.js";
import {
  changeSummaryHtml,
  changeSummaryMarkdown,
  changeSummaryText,
  ratingWithheldClause,
  ratingWithheldForNoSourceClause,
  ratingWithheldForNoSourceSentence,
  ratingWithheldSentence,
  unconfirmedChangeNotice,
} from "../dist/change-citation.js";
import type { ArchiveCheckOutcome, DealChange } from "../dist/types.js";

const NOW = Date.parse("2026-09-05T00:00:00Z");

const checkedAs = (outcome: ArchiveCheckOutcome) => ({ archive_check: { checked: "2026-09-30", outcome } });

const record = (over: Partial<DealChange> = {}): DealChange => ({
  vendor: "Fixture Vendor",
  change_type: "free_tier_removed",
  date: "2026-08-01",
  summary: "Free tier removed",
  previous_state: "Free tier: 5 GB",
  current_state: "Paid only",
  impact: "high",
  source_url: "https://example.com/pricing",
  category: "Databases",
  alternatives: [],
  date_source: "discovered",
  ...over,
});

const unconfirmed = (over: Partial<DealChange> = {}): DealChange => record({ ...checkedAs("no_usable_capture"), ...over });

describe("a change no archived copy of the vendor's page could confirm", () => {
  it("is unconfirmed only when the archive check found no usable capture", () => {
    assert.strictEqual(changeIsUnconfirmed(unconfirmed()), true);
    assert.strictEqual(changeIsUnconfirmed(record()), false);
    for (const outcome of ["vendor_changed", "ours", "removal_stated_before", "text_day_unknown", "page_unreadable_today"] as const) {
      assert.strictEqual(changeIsUnconfirmed(record(checkedAs(outcome))), false, outcome);
    }
  });

  it("carries no demotion, where the same record confirmed carries one", () => {
    assert.strictEqual(demotionForChange(record(checkedAs("vendor_changed"))), "risky");
    assert.strictEqual(demotionForChange(unconfirmed()), null);
    assert.strictEqual(demotionInForce(unconfirmed(), NOW), null);
    assert.strictEqual(demotionForChange(unconfirmed({ change_type: "limits_reduced" })), null);
  });

  it("keeps the badge of a record whose capture day or page could not be read", () => {
    assert.strictEqual(demotionForChange(record(checkedAs("text_day_unknown"))), "risky");
    assert.strictEqual(demotionForChange(record(checkedAs("page_unreadable_today"))), "risky");
  });

  it("reports the demotion it would have carried, so the withholding can be explained", () => {
    assert.strictEqual(demotionWithheldUnconfirmed(unconfirmed()), "risky");
    assert.strictEqual(demotionWithheldUnconfirmed(unconfirmed({ change_type: "limits_reduced" })), "caution");
    assert.strictEqual(demotionWithheldUnconfirmed(record()), null);
  });

  it("withholds the rating rather than reporting the vendor stable", () => {
    const assessment = vendorRiskAssessment([unconfirmed()], NOW);
    assert.strictEqual(assessment.cause, null);
    assert.deepStrictEqual(assessment.rating_withheld, { reason: "unconfirmed", records: 1 });
  });

  it("loses to a confirmed record that cites a source, which still sets the rating", () => {
    const assessment = vendorRiskAssessment(
      [unconfirmed(), record({ change_type: "limits_reduced", date: "2026-07-01" })],
      NOW,
    );
    assert.strictEqual(assessment.rating_withheld, null);
    assert.strictEqual(assessment.level, "caution");
    assert.strictEqual(assessment.cause?.change_type, "limits_reduced");
  });

  it("names the unconfirmed reason as the rule that withheld the stability class", () => {
    const withholding = {
      link_unreachable: null,
      refused_read: null,
      rating_withheld: vendorRiskAssessment([unconfirmed()], NOW).rating_withheld,
      source_check: null,
      gate: null,
    };
    assert.strictEqual(stabilityWithholdingReason(withholding, [unconfirmed()]), "unconfirmed");
  });

  it("does not make the vendor volatile or put it on the watch list", () => {
    assert.strictEqual(classifyStability([unconfirmed()], NOW), "stable");
    assert.strictEqual(classifyStability([unconfirmed({ change_type: "limits_reduced" })], NOW), "stable");
    assert.strictEqual(classifyStability([record(checkedAs("vendor_changed"))], NOW), "volatile");
  });
});

describe("a rating withheld for records of both kinds", () => {
  const uncited = (over: Partial<DealChange> = {}) => record({ source_url: "", ...over });

  it("names the kind whose record would set the more severe level, and counts both", () => {
    assert.deepStrictEqual(
      vendorRiskAssessment([uncited({ change_type: "limits_reduced" }), unconfirmed()], NOW).rating_withheld,
      { reason: "unconfirmed", records: 2 },
    );
    assert.deepStrictEqual(
      vendorRiskAssessment([uncited(), unconfirmed({ change_type: "limits_reduced" })], NOW).rating_withheld,
      { reason: "no_source", records: 2 },
    );
  });

  it("names unconfirmed when both kinds would set the same level", () => {
    assert.deepStrictEqual(
      vendorRiskAssessment([uncited({ change_type: "limits_reduced" }), unconfirmed({ change_type: "limits_reduced" })], NOW).rating_withheld,
      { reason: "unconfirmed", records: 2 },
    );
  });

  it("counts each kind for the sentence that explains the withholding", () => {
    assert.deepStrictEqual(withheldRecordCounts([uncited(), unconfirmed(), unconfirmed({ date: "2026-08-02" }), record()]), {
      unsourced: 1,
      unconfirmed: 2,
    });
  });
});

describe("the sentence a vendor page gives for a withheld rating", () => {
  const vendor = "Fixture Vendor";

  it("keeps the no-source sentence for one uncited record, and gives its plural for more", () => {
    assert.strictEqual(ratingWithheldSentence(vendor, { unsourced: 1, unconfirmed: 0 }), ratingWithheldForNoSourceSentence(vendor));
    assert.strictEqual(
      ratingWithheldSentence(vendor, { unsourced: 2, unconfirmed: 0 }),
      "The only records that would rate Fixture Vendor cite no source, so we are not publishing a rating for it.",
    );
    assert.strictEqual(ratingWithheldClause({ unsourced: 2, unconfirmed: 0 }), ratingWithheldForNoSourceClause());
  });

  it("says one unconfirmed record could not be checked against an archived copy", () => {
    assert.strictEqual(
      ratingWithheldSentence(vendor, { unsourced: 0, unconfirmed: 1 }),
      "The only record that would rate Fixture Vendor is a change we could not check against an archived copy of Fixture Vendor's page, so we are not publishing a rating for it.",
    );
    assert.strictEqual(
      ratingWithheldClause({ unsourced: 0, unconfirmed: 1 }),
      "the only record that would rate it is a change we could not check against an archived copy of its page",
    );
  });

  it("gives the plural for more than one unconfirmed record", () => {
    assert.strictEqual(
      ratingWithheldSentence(vendor, { unsourced: 0, unconfirmed: 3 }),
      "The only records that would rate Fixture Vendor are changes we could not check against archived copies of Fixture Vendor's page, so we are not publishing a rating for it.",
    );
    assert.strictEqual(
      ratingWithheldClause({ unsourced: 0, unconfirmed: 3 }),
      "the only records that would rate it are changes we could not check against archived copies of its page",
    );
  });

  it("names both reasons where the withheld records mix them", () => {
    assert.strictEqual(
      ratingWithheldSentence(vendor, { unsourced: 1, unconfirmed: 1 }),
      "The only records that would rate Fixture Vendor either cite no source or are changes we could not check against an archived copy of Fixture Vendor's page, so we are not publishing a rating for it.",
    );
    assert.strictEqual(
      ratingWithheldClause({ unsourced: 1, unconfirmed: 1 }),
      "the only records that would rate it either cite no source or are changes we could not check against an archived copy of its page",
    );
  });

  it("marks the unconfirmed record itself after its summary", () => {
    assert.strictEqual(
      unconfirmedChangeNotice(vendor),
      "Unconfirmed. We could not check this change against an archived copy of Fixture Vendor's page, so it does not count toward the rating.",
    );
  });
});

describe("an unconfirmed record wherever its summary is shown", () => {
  const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const notice = unconfirmedChangeNotice("Fixture Vendor");

  it("states it is unconfirmed right after the summary, before the source", () => {
    assert.strictEqual(changeSummaryText(unconfirmed()), `Free tier removed ${notice} Source: https://example.com/pricing`);
    assert.strictEqual(changeSummaryMarkdown(unconfirmed()), `Free tier removed ${notice} [Source](https://example.com/pricing)`);
    const html = changeSummaryHtml(unconfirmed(), esc);
    assert.ok(html.startsWith(`Free tier removed <span class="unconfirmed-note"`), html);
    assert.ok(html.indexOf(esc(notice)) < html.indexOf("https://example.com/pricing"), html);
  });

  it("leaves a confirmed record's summary as it was", () => {
    assert.strictEqual(changeSummaryText(record(checkedAs("vendor_changed"))), "Free tier removed Source: https://example.com/pricing");
    assert.ok(!changeSummaryHtml(record(), esc).includes("unconfirmed-note"));
  });

  it("keeps the no-source notice alone on a record that also cites nothing", () => {
    const both = unconfirmed({ source_url: "" });
    assert.ok(!changeSummaryText(both).includes(notice), changeSummaryText(both));
  });
});

import { it } from "node:test";
import assert from "node:assert/strict";
import { plainConditionsByVendor, withoutItsOwnConditions } from "./conditions-after-descriptions.ts";

const rule = { text: "Personal use only.", quote: "Personal use.", url: "https://example.com/terms", read_on: "2026-11-01" };
const detail = { ...rule, text: "Usage resets daily.", operating_detail: true as const };
const ruleText = " Personal use only. (From https://example.com/terms, read 2026-11-01.)";
const detailText = " Usage resets daily. (From https://example.com/terms, read 2026-11-01.)";
const terms = "Free storage.";

it("recognizes complete and filtered conditions without hiding unrelated caveats", () => {
  const own = plainConditionsByVendor([{ vendor: "Example", conditions: [detail, rule] }]).get("Example");
  for (const suffix of [detailText + ruleText, ruleText]) {
    assert.equal(withoutItsOwnConditions(terms + suffix, own), terms);
    const reason = "The stored terms are not confirmed.";
    assert.equal(withoutItsOwnConditions(`${terms} ${reason}${suffix}`, own), `${terms} ${reason}`);
    assert.equal(withoutItsOwnConditions(`${terms}${suffix} ${reason}`, own), `${terms}${suffix} ${reason}`);
    assert.equal(withoutItsOwnConditions(`${terms}${suffix} An unrelated condition.`, own), `${terms}${suffix} An unrelated condition.`);
  }
});

it("retains exact matching and collects the longest form first across a vendor's listings", () => {
  const own = plainConditionsByVendor([{ vendor: "Example", conditions: [rule] }, { vendor: "Example", conditions: [detail, rule] }]);
  assert.equal(withoutItsOwnConditions(terms + detailText + ruleText, own.get("Example")), terms);
  assert.equal(withoutItsOwnConditions(terms + ruleText.replace("Personal", "Commercial"), own.get("Example")), terms + ruleText.replace("Personal", "Commercial"));
  assert.equal(withoutItsOwnConditions(terms + ruleText, own.get("Other")), terms + ruleText);
});

it("never introduces an empty suffix when every condition is an operating detail", () => {
  const own = plainConditionsByVendor([{ vendor: "Example", conditions: [detail] }]).get("Example");
  assert.deepEqual(own, [detailText]);
  assert.equal(withoutItsOwnConditions(terms, own), terms);
  assert.equal(withoutItsOwnConditions(terms + detailText, own), terms);
});

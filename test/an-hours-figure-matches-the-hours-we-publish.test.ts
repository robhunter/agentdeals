import { describe, it } from "node:test";
import assert from "node:assert";
import { figuresWeAlsoPublish, priceSignals, quantifiedAttributes } from "../scripts/change-gate.js";
import { classifySource, SOURCE_CHECK_OK } from "../scripts/vendor-naming.js";

const KAGGLE = {
  vendor: "Kaggle",
  url: "https://www.kaggle.com/docs/efficient-gpu-usage",
  description:
    "Google's data science platform with free notebooks, datasets and competitions. Notebooks get a weekly GPU quota of 30 hours, sometimes more depending on demand (one NVIDIA Tesla P100 or two Tesla T4s), and a TPU v3-8 for up to 20 hours per week. Sessions run up to 12 hours on CPU or GPU and 9 hours on TPU, with 20 GB of auto-saved disk in /kaggle/working. Free GPUs and TPUs may queue at busy times. Datasets are capped at 200 GB each and 200 GB of private datasets in total. Kaggle's one paid service is hosting a competition.",
};

const KAGGLE_QUOTA_PAGE =
  "Efficient GPU Usage Tips. Kaggle provides free access to NVIDIA TESLA P100 GPUs. The quota resets weekly and is 30 hours or sometimes higher depending on demand and resources.";

describe("an hours figure on the page matches the same hours in the terms we publish", () => {
  it("reads a bare hours figure as a quantity of hours", () => {
    assert.deepStrictEqual(
      quantifiedAttributes("30 hours").map(({ value, words }) => ({ value, words })),
      [{ value: "30", words: ["hour"] }],
    );
  });

  it("matches the 30 hours a page states to the 30 hours the description gives", () => {
    assert.deepStrictEqual(figuresWeAlsoPublish(["30 hours"], KAGGLE.description), ["30 hours"]);
    assert.deepStrictEqual(figuresWeAlsoPublish(["30 hrs"], KAGGLE.description), ["30 hrs"]);
  });

  it("does not match a different number of hours", () => {
    assert.deepStrictEqual(figuresWeAlsoPublish(["40 hours"], KAGGLE.description), []);
  });

  it("does not match the same number of days, or the same span in minutes", () => {
    assert.deepStrictEqual(figuresWeAlsoPublish(["30 days"], KAGGLE.description), []);
    assert.deepStrictEqual(figuresWeAlsoPublish(["1,800 minutes"], KAGGLE.description), []);
    assert.deepStrictEqual(
      figuresWeAlsoPublish(["30 hours"], "Logs are kept for 30 days and builds time out after 1,800 minutes."),
      [],
    );
  });

  it("matches no hours figure against a description that gives none", () => {
    assert.deepStrictEqual(
      figuresWeAlsoPublish(["30 hours", "750 hours per month"], "Free notebooks with 20 GB of disk and 200 GB of datasets."),
      [],
    );
  });

  it("reports the hours a page states as a figure this listing gives", () => {
    const check = classifySource(KAGGLE, { ok: true, text: KAGGLE_QUOTA_PAGE }, priceSignals(KAGGLE_QUOTA_PAGE));
    assert.strictEqual(check.outcome, SOURCE_CHECK_OK);
    assert.match(check.detail, / and states "30 hours"$/);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyOfferAgainstPage, MAX_PAGE_TEXT_LENGTH } from "../scripts/verify-freshness.js";
import { excerptPrompt, readFreePlanExcerpt, textTheReaderSees } from "../scripts/free-plan-excerpt.js";
import { pairedPrompt, statedBeforePrompt } from "../scripts/archive-captures.js";

const offer = { vendor: "Google Cloud Storage", category: "Storage", tier: "Always Free", description: "5 GB storage and 50,000 Class B Operations" };
const page = readFileSync(new URL("./fixtures/vendor-pages/google-cloud-storage.txt", import.meta.url), "utf8");

async function outgoing(reader: typeof verifyOfferAgainstPage, text: string) {
  let prompt = "";
  await reader({ complete: async (sent: string) => { prompt = sent; return '{}'; } }, offer, text);
  return prompt;
}

for (const [name, reader, label] of [
  ["verifier", verifyOfferAgainstPage, "CURRENT PRICING PAGE TEXT"],
  ["excerpt reader", readFreePlanExcerpt, "PAGE TEXT"],
] as const) {
  describe(`${name} page window`, () => {
    it("receives the saved storage table past the former cut", async () => {
      assert.ok(page.indexOf("Class B Operations 50,000") > 45_000);
      const prompt = await outgoing(reader, page);
      assert.ok(prompt.includes(page));
      assert.ok(prompt.includes("Class B Operations 50,000"));
      assert.ok(prompt.includes(`${label} (whole page):\n${page}`));
    });

    it("receives terms near the end of a 100,000-character window", async () => {
      const terms = "Free plan: $0 per month, 50,000 requests and 5 GB storage.";
      const text = "x".repeat(99_900) + terms;
      const prompt = await outgoing(reader, text);
      assert.ok(prompt.includes(text));
      assert.ok(prompt.includes(`${label} (whole page):\n${text}`));
    });

    for (const size of [0, 12_001, 99_999, 100_000, 100_001]) {
      it(`labels ${size} characters according to whether text was cut`, async () => {
        const text = "x".repeat(size);
        const prompt = await outgoing(reader, text);
        const coverage = size > 100_000 ? "truncated" : "whole page";
        assert.ok(prompt.includes(`${label} (${coverage}):\n${text.slice(0, 100_000)}\n\n`));
        if (size > 100_000) assert.ok(!prompt.includes("x".repeat(100_001)));
      });
    }
  });
}

describe("prompt consumers", () => {
  it("bounds direct excerpt prompts and their verbatim-validation text alike", () => {
    assert.equal(MAX_PAGE_TEXT_LENGTH, 100_000);
    const whole = "x".repeat(100_000) + "HIDDEN";
    assert.equal(textTheReaderSees(whole), "x".repeat(100_000));
    const prompt = excerptPrompt(offer, whole);
    assert.ok(prompt.includes("PAGE TEXT (truncated):\n" + textTheReaderSees(whole)));
    assert.ok(!prompt.includes("HIDDEN"));
  });

  it("retains the archive readers' existing default windows", () => {
    const older = { day: "2026-01-01", text: "a".repeat(12_000) + "OLDER_HIDDEN" };
    const newer = { day: "2026-02-01", text: "b".repeat(12_000) + "NEWER_HIDDEN" };
    const pair = pairedPrompt(offer, older, newer);
    assert.ok(pair.includes("a".repeat(12_000)));
    assert.ok(pair.includes("b".repeat(12_000)));
    assert.ok(!pair.includes("OLDER_HIDDEN"));
    assert.ok(!pair.includes("NEWER_HIDDEN"));
    const record = { date: "2026-02-01", summary: "Storage allowance changed." };
    const before = statedBeforePrompt(record, older);
    assert.ok(before.includes("a".repeat(12_000)));
    assert.ok(!before.includes("OLDER_HIDDEN"));
  });
});

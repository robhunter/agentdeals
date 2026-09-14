import { describe, it } from "node:test";
import assert from "node:assert";

const { getFreshnessMetrics, loadOffers } = await import("../dist/data.js");
const { CONFIRMED_DATE_LABEL, UNCONFIRMED_DATE_LABEL, confirmationDate, lastAttemptDate, publishedDateLabel } =
  await import("../dist/read-date.js");
const { loadVerificationState } = await import("../dist/verification-state.js");

interface CountedOffer {
  vendor: string;
  url: string;
  verifiedDate: string;
  category: string;
}

const m = getFreshnessMetrics();
const offers: CountedOffer[] = loadOffers();
const store = loadVerificationState();

const DAY_MS = 24 * 60 * 60 * 1000;
const nowMs = Date.now();
const ageInDays = (date: string) => Math.floor((nowMs - new Date(date).getTime()) / DAY_MS);
const within = (date: string | null | undefined, days: number) =>
  Boolean(date) && ageInDays(date as string) <= days;

const storedSuccessOf = (o: CountedOffer): string | null =>
  store.get(`${o.vendor}|${o.url}`)?.last_success ?? null;

const confirmedFromTheStore = offers.filter((o) => within(storedSuccessOf(o), 90));
const stampedFromTheCatalogue = offers.filter((o) => within(o.verifiedDate, 90));

const bothCounts = () =>
  `${m.confirmed_within_90_days} of ${m.total_offers} entries can be sourced to a read that confirmed them within 90 days; ` +
  `${m.stamped_within_90_days} carry a catalogue date within 90 days. ` +
  `Recomputed from data/verification_state.json and data/index.json: ` +
  `${confirmedFromTheStore.length} confirmed, ${stampedFromTheCatalogue.length} with a catalogue date.`;

describe("the freshness figure counts confirmations and says so", () => {
  it("counts the confirmations the store holds, recomputed from the store itself", () => {
    assert.strictEqual(m.confirmed_within_90_days, confirmedFromTheStore.length, bothCounts());
  });

  it("counts the catalogue dates separately, recomputed from the catalogue itself", () => {
    assert.strictEqual(m.stamped_within_90_days, stampedFromTheCatalogue.length, bothCounts());
  });

  it("computes the headline share from the confirmations and not from the catalogue dates", () => {
    assert.strictEqual(
      m.freshness_score,
      Math.round((confirmedFromTheStore.length / offers.length) * 100),
      bothCounts(),
    );
  });

  it("still publishes the catalogue-date share, under a name of its own", () => {
    assert.strictEqual(
      m.stamp_score,
      Math.round((stampedFromTheCatalogue.length / offers.length) * 100),
      bothCounts(),
    );
  });

  it("keeps the two counts apart, so closing the gap has to be earned", () => {
    assert.ok(m.confirmed_within_90_days <= m.stamped_within_90_days, bothCounts());
    assert.ok(m.offers_holding_a_confirmation >= m.confirmed_within_90_days, bothCounts());
    assert.ok(
      m.confirmed_within_90_days < m.stamped_within_90_days,
      `the two counts are equal, so either every catalogue date is now sourced to a confirming read ` +
        `or one of the counts has been widened to match the other — ${bothCounts()}`,
    );
  });

  it("admits no confirmation the store does not hold", () => {
    const unsourced = confirmedFromTheStore.filter((o) => confirmationDate(o) === null);
    assert.deepStrictEqual(unsourced.map((o) => `${o.vendor}|${o.url}`), [], bothCounts());
  });

  it("dates the oldest confirmation it still holds, and claims nothing about when the store opened", () => {
    const held = offers
      .map((o) => confirmationDate(o))
      .filter((d): d is string => Boolean(d))
      .sort();
    assert.strictEqual(m.oldest_confirmation_held, held[0] ?? null, bothCounts());
  });
});

describe("an attempt is reported apart from a confirmation", () => {
  it("counts the re-reads the store attempted, whatever they found", () => {
    const attempted = offers.filter((o) => within(lastAttemptDate(o), 90));
    assert.strictEqual(m.attempted_within_90_days, attempted.length, bothCounts());
  });

  it("never reports more confirmations than attempts", () => {
    assert.ok(
      m.confirmed_within_90_days <= m.attempted_within_90_days,
      `${m.confirmed_within_90_days} confirmations over ${m.attempted_within_90_days} attempts — ` +
        `a confirmation the store holds must come from a read the store attempted`,
    );
  });
});

describe("every category is scored on the confirmations that category holds", () => {
  it("scores each category from its own confirmed count", () => {
    for (const c of m.by_category) {
      assert.strictEqual(
        c.freshness_score,
        Math.round((c.confirmed_within_90_days / c.count) * 100),
        `${c.category} scores ${c.freshness_score}% over ${c.confirmed_within_90_days} confirmations ` +
          `of ${c.count} entries, ${c.stamped_within_90_days} of which carry a catalogue date`,
      );
    }
  });

  it("recomputes each category's two counts from the store and the catalogue", () => {
    for (const c of m.by_category) {
      const inCategory = offers.filter((o) => o.category === c.category);
      assert.strictEqual(
        c.confirmed_within_90_days,
        inCategory.filter((o) => within(storedSuccessOf(o), 90)).length,
        `${c.category} reports ${c.confirmed_within_90_days} confirmations of ${c.count} entries`,
      );
      assert.strictEqual(
        c.stamped_within_90_days,
        inCategory.filter((o) => within(o.verifiedDate, 90)).length,
        `${c.category} reports ${c.stamped_within_90_days} catalogue dates of ${c.count} entries`,
      );
    }
  });

  it("scores no category at its catalogue-date share while its confirmations are fewer", () => {
    const scoredOnTheWrongField = m.by_category.filter(
      (c) => c.confirmed_within_90_days < c.stamped_within_90_days && c.freshness_score === c.stamp_score,
    );
    assert.deepStrictEqual(
      scoredOnTheWrongField.map((c) => `${c.category} ${c.freshness_score}%`),
      [],
      `a category holding fewer confirmations than catalogue dates cannot score the same on both`,
    );
  });
});

describe("a date the store cannot source is not labelled as a confirmation", () => {
  it("labels a published date Verified only where a confirmation backs it", () => {
    const mislabelled = offers.filter(
      (o) => publishedDateLabel(o) === CONFIRMED_DATE_LABEL && confirmationDate(o) === null,
    );
    assert.deepStrictEqual(
      mislabelled.map((o) => `${o.vendor}|${o.url}`),
      [],
      "every entry labelled Verified must have a confirmation in the store",
    );
  });

  it("keeps the date and changes only the label where no confirmation is held", () => {
    const unconfirmed = offers.filter((o) => confirmationDate(o) === null);
    assert.ok(unconfirmed.length > 0, "this assertion is vacuous unless some entry lacks a confirmation");
    for (const o of unconfirmed) {
      assert.strictEqual(publishedDateLabel(o), UNCONFIRMED_DATE_LABEL, `${o.vendor}|${o.url}`);
      assert.ok(o.verifiedDate, `${o.vendor}|${o.url} must keep its catalogue date`);
    }
  });
});

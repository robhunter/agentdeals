import { describe, it } from "node:test";
import assert from "node:assert";

const { getFreshnessMetrics } = await import("../dist/data.js");
const { CONFIRMED_DATE_LABEL, UNCONFIRMED_DATE_LABEL, confirmationDate, publishedDateLabel } =
  await import("../dist/read-date.js");
const { loadOffers } = await import("../dist/data.js");

const m = getFreshnessMetrics();

const bothCounts = () =>
  `${m.confirmed_within_90_days} of ${m.total_offers} offers hold a confirmation the store can source within 90 days; ` +
  `${m.stamped_within_90_days} carry a catalogue date within 90 days`;

describe("the freshness grade names the field it is computed from", () => {
  it("scores the confirmations the store holds, not the catalogue date", () => {
    assert.strictEqual(
      m.freshness_score,
      Math.round((m.confirmed_within_90_days / m.total_offers) * 100),
      `freshness_score must be the confirmation share — ${bothCounts()}`,
    );
  });

  it("still publishes the catalogue-date share, under its own name", () => {
    assert.strictEqual(
      m.stamp_score,
      Math.round((m.stamped_within_90_days / m.total_offers) * 100),
      `stamp_score must be the catalogue-date share — ${bothCounts()}`,
    );
  });

  it("keeps the distance between the two counts visible", () => {
    assert.ok(
      m.confirmed_within_90_days <= m.stamped_within_90_days,
      `more confirmations than catalogue dates means one of the two counts is reading the wrong field — ${bothCounts()}`,
    );
    assert.ok(
      m.offers_holding_a_confirmation >= m.confirmed_within_90_days,
      `a confirmation inside 90 days is also a confirmation — ${bothCounts()}`,
    );
  });

  it("grades every category on the confirmations that category holds", () => {
    for (const c of m.by_category) {
      assert.strictEqual(
        c.freshness_score,
        Math.round((c.confirmed_within_90_days / c.count) * 100),
        `${c.category} grades ${c.freshness_score}% over ${c.confirmed_within_90_days} confirmations of ${c.count} offers ` +
          `(${c.stamped_within_90_days} carry a catalogue date)`,
      );
      assert.ok(
        c.confirmed_within_90_days <= c.count,
        `${c.category} reports ${c.confirmed_within_90_days} confirmations over ${c.count} offers`,
      );
    }
  });

  it("cannot report coverage the store has had no time to earn", () => {
    if (m.offers_holding_a_confirmation === 0) return;
    assert.ok(
      m.confirmation_store_opened_on,
      "a store holding confirmations must say when its earliest one was recorded",
    );
    const earliest = [...m.stalest_entries, ...m.freshest_entries]
      .map((e) => e.confirmed_on)
      .filter((d): d is string => Boolean(d))
      .sort()[0];
    if (earliest) {
      assert.ok(
        m.confirmation_store_opened_on! <= earliest,
        `the store opened on ${m.confirmation_store_opened_on} but an entry reports a confirmation on ${earliest}`,
      );
    }
  });
});

describe("a date the store cannot source is not labelled as a confirmation", () => {
  it("labels a published date Verified only where a confirmation backs it", () => {
    const offers = loadOffers();
    const mislabelled = offers.filter(
      (o: { vendor: string; url: string; verifiedDate: string }) =>
        publishedDateLabel(o) === CONFIRMED_DATE_LABEL && confirmationDate(o) === null,
    );
    assert.deepStrictEqual(
      mislabelled.map((o: { vendor: string }) => o.vendor),
      [],
      "every offer labelled Verified must have a confirmation in the store",
    );
  });

  it("keeps the date and changes only the label where no confirmation is held", () => {
    const offers = loadOffers();
    const unconfirmed = offers.filter(
      (o: { vendor: string; url: string; verifiedDate: string }) => confirmationDate(o) === null,
    );
    assert.ok(
      unconfirmed.length > 0,
      "this assertion is vacuous unless some offer lacks a confirmation",
    );
    for (const o of unconfirmed) {
      assert.strictEqual(publishedDateLabel(o), UNCONFIRMED_DATE_LABEL, `${o.vendor} holds no confirmation`);
      assert.ok(o.verifiedDate, `${o.vendor} must keep its catalogue date`);
    }
  });
});

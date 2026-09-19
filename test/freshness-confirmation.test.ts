import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { getFreshnessMetrics, loadOffers } = await import("../dist/data.js");
const {
  CONFIRMED_DATE_LABEL,
  UNCONFIRMED_DATE_LABEL,
  confirmationDate,
  lastAttemptDate,
  publishedDateLabel,
  publishedDateLine,
  publishedDateValue,
  restatedReadingLine,
} = await import("../dist/read-date.js");
const { loadVerificationState } = await import("../dist/verification-state.js");

interface CountedOffer {
  vendor: string;
  url: string;
  verifiedDate: string;
  category: string;
  restated_from?: { reading_date: string } | null;
}

const m = getFreshnessMetrics();
const offers: CountedOffer[] = loadOffers();
const store = loadVerificationState();

const DAY_MS = 24 * 60 * 60 * 1000;
const nowMs = Date.now();
const ageInDays = (date: string) => Math.floor((nowMs - new Date(date).getTime()) / DAY_MS);
const within = (date: string | null | undefined, days: number) =>
  Boolean(date) && ageInDays(date as string) <= days;

const termsWeTookFromAReading = (o: CountedOffer) => Boolean(o.restated_from);

const storedSuccessOf = (o: CountedOffer): string | null =>
  termsWeTookFromAReading(o) ? null : (store.get(`${o.vendor}|${o.url}`)?.last_success ?? null);

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

  it("counts no confirmation for an entry whose terms came from a reading that disagreed with us", () => {
    const confirmed = offers.find((o) => storedSuccessOf(o) !== null);
    assert.ok(confirmed, "no entry in the catalogue holds a confirming read to build the case on");
    const restated = { ...confirmed, restated_from: { reading_date: "2026-09-07" } };
    assert.notStrictEqual(store.get(`${confirmed.vendor}|${confirmed.url}`)?.last_success, undefined);
    assert.strictEqual(storedSuccessOf(restated), null);
    assert.strictEqual(confirmationDate(restated), null);
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
      assert.strictEqual(publishedDateValue(o), o.verifiedDate, `${o.vendor}|${o.url} must keep its catalogue date`);
    }
  });

  it("publishes the confirmation itself wherever the label says Verified", () => {
    const confirmed = offers.filter((o) => confirmationDate(o) !== null);
    assert.ok(confirmed.length > 0, "this assertion is vacuous unless some entry holds a confirmation");
    for (const o of confirmed) {
      assert.strictEqual(publishedDateLabel(o), CONFIRMED_DATE_LABEL, `${o.vendor}|${o.url}`);
      assert.strictEqual(publishedDateValue(o), confirmationDate(o), `${o.vendor}|${o.url}`);
    }
  });

  it("renders one line for both MCP surfaces, and it never says Verified over a date the store cannot source", () => {
    const saysVerified = offers.filter((o) => publishedDateLine(o).startsWith(`**${CONFIRMED_DATE_LABEL}:**`));
    const unsourced = saysVerified.filter((o) => confirmationDate(o) === null);
    assert.deepStrictEqual(unsourced.map((o) => `${o.vendor}|${o.url}`), []);
    const sample = offers.find((o) => confirmationDate(o) === null);
    assert.ok(sample, "this assertion is vacuous unless some entry lacks a confirmation");
    assert.strictEqual(
      publishedDateLine(sample),
      `**${UNCONFIRMED_DATE_LABEL}:** ${sample.verifiedDate}`,
      `${sample.vendor}|${sample.url}`,
    );
  });

  it("has both MCP surfaces render that one line rather than each spelling it out", () => {
    const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    for (const file of ["src/server.ts", "src/server-remote.ts"]) {
      const source = readFileSync(path.join(repo, file), "utf8");
      assert.match(source, /publishedDateLine\(/, `${file} must render the line through the shared helper`);
      assert.ok(
        !source.includes(`**${CONFIRMED_DATE_LABEL}:**`),
        `${file} must not spell the confirmed label out beside a date the store may not hold`,
      );
    }
  });

  it("names where terms taken from a reading came from, on every surface that publishes the record's own date", () => {
    const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const reading = { vendor: "Netlify", url: "https://netlify.com/pricing", verifiedDate: "2026-08-26", restated_from: { reading_date: "2026-09-07" } };
    assert.strictEqual(publishedDateValue(reading), reading.verifiedDate, "a restatement may not stand in for the record's own date");
    assert.ok(restatedReadingLine(reading), "a restated record must publish the day its terms were read");
    for (const file of ["src/server.ts", "src/server-remote.ts", "src/serve.ts"]) {
      const source = readFileSync(path.join(repo, file), "utf8");
      assert.match(
        source,
        /restatedReading(Line|Date)\(/,
        `${file} publishes the record's own date and must say when a reading replaced its terms`,
      );
    }
  });
});

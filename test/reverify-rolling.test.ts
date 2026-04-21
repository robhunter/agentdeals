import { describe, it } from "node:test";
import assert from "node:assert";

const { pickOldestEntries, staggeredDate } = await import("../scripts/reverify-rolling.js");

describe("rolling re-verification", () => {
  describe("pickOldestEntries", () => {
    it("picks the N oldest entries by verifiedDate", () => {
      const offers = [
        { vendor: "Newest", verifiedDate: "2026-04-20" },
        { vendor: "Middle", verifiedDate: "2026-04-10" },
        { vendor: "Oldest", verifiedDate: "2026-03-01" },
        { vendor: "Newer", verifiedDate: "2026-04-15" },
      ];
      const { picked, oldestRemaining } = pickOldestEntries(offers, 2);
      assert.strictEqual(picked.length, 2);
      assert.strictEqual(picked[0].offer.vendor, "Oldest");
      assert.strictEqual(picked[1].offer.vendor, "Middle");
      assert.strictEqual(oldestRemaining, "2026-04-15");
    });

    it("treats missing verifiedDate as oldest", () => {
      const offers = [
        { vendor: "Recent", verifiedDate: "2026-04-20" },
        { vendor: "NoDate" },
        { vendor: "Old", verifiedDate: "2026-03-01" },
      ];
      const { picked } = pickOldestEntries(offers, 2);
      assert.strictEqual(picked[0].offer.vendor, "NoDate");
      assert.strictEqual(picked[1].offer.vendor, "Old");
    });

    it("preserves the original index for in-place updates", () => {
      const offers = [
        { vendor: "A", verifiedDate: "2026-04-20" },
        { vendor: "B", verifiedDate: "2026-03-01" },
        { vendor: "C", verifiedDate: "2026-04-10" },
      ];
      const { picked } = pickOldestEntries(offers, 2);
      assert.strictEqual(picked[0].index, 1);
      assert.strictEqual(picked[1].index, 2);
    });

    it("returns null oldestRemaining when limit covers everything", () => {
      const offers = [{ vendor: "Only", verifiedDate: "2026-04-20" }];
      const { picked, oldestRemaining } = pickOldestEntries(offers, 100);
      assert.strictEqual(picked.length, 1);
      assert.strictEqual(oldestRemaining, null);
    });

    it("is idempotent in selection given a fixed input", () => {
      const offers = [
        { vendor: "A", verifiedDate: "2026-04-20" },
        { vendor: "B", verifiedDate: "2026-03-01" },
        { vendor: "C", verifiedDate: "2026-04-10" },
      ];
      const first = pickOldestEntries(offers, 2);
      const second = pickOldestEntries(offers, 2);
      assert.deepStrictEqual(
        first.picked.map((p) => p.offer.vendor),
        second.picked.map((p) => p.offer.vendor)
      );
    });
  });

  describe("staggeredDate", () => {
    const now = new Date("2026-04-21T12:00:00Z");

    it("returns today's date when rand picks offset 0", () => {
      const stamp = staggeredDate(now, () => 0);
      assert.strictEqual(stamp, "2026-04-21");
    });

    it("returns yesterday when rand picks offset 1", () => {
      const stamp = staggeredDate(now, () => 0.4); // floor(0.4*3) = 1
      assert.strictEqual(stamp, "2026-04-20");
    });

    it("returns day-before when rand picks offset 2", () => {
      const stamp = staggeredDate(now, () => 0.8); // floor(0.8*3) = 2
      assert.strictEqual(stamp, "2026-04-19");
    });

    it("never produces dates outside the 3-day window", () => {
      const dates = new Set<string>();
      for (let i = 0; i < 200; i++) {
        dates.add(staggeredDate(now));
      }
      const allowed = new Set(["2026-04-21", "2026-04-20", "2026-04-19"]);
      for (const d of dates) {
        assert.ok(allowed.has(d), `unexpected stamped date ${d}`);
      }
    });

    it("distributes across all three days over many samples", () => {
      const counts: Record<string, number> = {};
      for (let i = 0; i < 600; i++) {
        const d = staggeredDate(now);
        counts[d] = (counts[d] ?? 0) + 1;
      }
      assert.ok(counts["2026-04-21"] > 100);
      assert.ok(counts["2026-04-20"] > 100);
      assert.ok(counts["2026-04-19"] > 100);
    });
  });
});

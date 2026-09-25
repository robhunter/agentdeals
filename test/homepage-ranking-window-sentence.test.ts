import { describe, it } from "node:test";
import assert from "node:assert";

const {
  AGENT_OPENS_WINDOW_DAYS,
  HOMEPAGE_GUIDE_COUNT,
  RANKED_TRAFFIC_CLASS,
  agentOpensByPath,
  agentOpensWindow,
  agentRequestAttribution,
  completeDaysInWindow,
  guideSelectionSentence,
  guidesTiedAtCut,
  opensDecidedPrefix,
  rankGuidesByAgentOpens,
  rankableDays,
} = await import("../dist/homepage-routing.js");
const { CLASS_ROUTE_SEP, OVERFLOW_PAGE_KEY } = await import("../dist/stats.js");

const POPULATION_SIZE = 97;
const POPULATION = Array.from(
  { length: POPULATION_SIZE },
  (_, i) => ({ slug: `guide-${String(i).padStart(2, "0")}`, title: `guide ${i}`, heading: "Answers" }),
);

function agentKey(path: string): string {
  return `${RANKED_TRAFFIC_CLASS}${CLASS_ROUTE_SEP}${path}`;
}

function dayWith(date: string, byClassRoute: Record<string, number>, reservedPaths: string[] = []) {
  return {
    date,
    complete: true,
    traffic: {
      by_class_route: byClassRoute,
      class_route_truncation: reservedPaths.length === 0 ? null : { reserved_paths: [...reservedPaths].sort() },
    },
  } as any;
}

function selection(over: Record<string, unknown> = {}) {
  return guideSelectionSentence({
    selectedCount: HOMEPAGE_GUIDE_COUNT,
    populationCount: POPULATION_SIZE,
    heldDays: AGENT_OPENS_WINDOW_DAYS,
    rankedWindow: { days: 14, from: "2026-09-08", to: "2026-09-21" },
    attribution: { attributed: 0, unattributed: 0, total: 0 },
    opensDecided: true,
    ...over,
  });
}

describe("the home page states the window its guide ranking actually measured (#1878)", () => {
  describe("AC-2 the window reads as English at every length it can take", () => {
    it("names the single day rather than counting one of them", () => {
      const sentence = selection({ rankedWindow: { days: 1, from: "2026-09-22", to: "2026-09-22" } });
      assert.match(sentence, /on 2026-09-22, the one complete day/);
      assert.doesNotMatch(sentence, /1 days/);
      assert.doesNotMatch(sentence, /2026-09-22 to 2026-09-22/);
    });

    it("counts the days and names both ends where the window is longer than one", () => {
      const sentence = selection({ rankedWindow: { days: 14, from: "2026-09-08", to: "2026-09-21" } });
      assert.match(sentence, /across the 14 complete days .*, 2026-09-08 to 2026-09-21\./);
    });

    it("writes no count as a plural it does not take, at any length the ranking can read", () => {
      for (let days = 1; days <= AGENT_OPENS_WINDOW_DAYS; days++) {
        const sentence = selection({
          rankedWindow: { days, from: "2026-09-08", to: "2026-09-21" },
          attribution: { attributed: 90, unattributed: 10, total: 100 },
        });
        assert.doesNotMatch(sentence, /\b1 days\b/, `a one-day window was counted as days: ${sentence}`);
        assert.doesNotMatch(sentence, /\b1 guides\b/, `one guide was counted as guides: ${sentence}`);
        if (days === 1) assert.doesNotMatch(sentence, /those days/, `a one-day window was called days: ${sentence}`);
        else assert.doesNotMatch(sentence, /that day\b/, `a ${days}-day window was called one day: ${sentence}`);
      }
    });
  });

  describe("AC-3 the sentence claims what the day was kept for", () => {
    it("says every guide had its own count rather than that every request was attributed", () => {
      const sentence = selection({ attribution: { attributed: 119, unattributed: 256, total: 375 } });
      assert.doesNotMatch(sentence, /attribute in full/);
      assert.match(sentence, /every guide we publish had its own count/);
    });

    it("keeps reporting the share that reached no path of its own beside that claim", () => {
      const sentence = selection({
        rankedWindow: { days: 1, from: "2026-09-22", to: "2026-09-22" },
        attribution: { attributed: 119, unattributed: 256, total: 375 },
      });
      assert.match(sentence, /256 of 375 agent requests that day \(68\.3%\)/);
      assert.match(sentence, /reached a shared bucket rather than a path of their own/);
    });

    it("keeps only the days the claim is true of", () => {
      const measured: Record<string, number> = { [agentKey(OVERFLOW_PAGE_KEY)]: 900 };
      for (const guide of POPULATION) measured[agentKey(`/${guide.slug}`)] = 3;
      const kept = dayWith("2026-09-22", measured);
      assert.deepEqual(rankableDays([kept], POPULATION, AGENT_OPENS_WINDOW_DAYS), [kept]);

      const keyless = { ...measured };
      delete keyless[agentKey(`/${POPULATION[4].slug}`)];
      assert.deepEqual(rankableDays([dayWith("2026-09-22", keyless)], POPULATION, AGENT_OPENS_WINDOW_DAYS), []);

      const reserved = dayWith("2026-09-22", keyless, POPULATION.map((g) => `/${g.slug}`));
      assert.deepEqual(rankableDays([reserved], POPULATION, AGENT_OPENS_WINDOW_DAYS), [reserved]);
    });
  });

  describe("AC-4 the page reports how much of its own list is a tie", () => {
    it("counts the named guides that tie on opens with the first one left out", () => {
      const ranked = POPULATION.map((guide, i) => ({ ...guide, agentOpens: i < 8 ? 9 - i : 1 }));
      assert.equal(guidesTiedAtCut(ranked, HOMEPAGE_GUIDE_COUNT), HOMEPAGE_GUIDE_COUNT - 8);
    });

    it("reports no tie where every named guide outscores the first one left out", () => {
      const ranked = POPULATION.map((guide, i) => ({ ...guide, agentOpens: POPULATION_SIZE - i }));
      assert.equal(guidesTiedAtCut(ranked, HOMEPAGE_GUIDE_COUNT), 0);
    });

    it("reports no tie where the list is the whole population", () => {
      const ranked = POPULATION.slice(0, HOMEPAGE_GUIDE_COUNT).map((guide) => ({ ...guide, agentOpens: 0 }));
      assert.equal(guidesTiedAtCut(ranked, HOMEPAGE_GUIDE_COUNT), 0);
    });

    it("nothing the page publishes ties at its own cut, on any ranking the ranker can produce", () => {
      for (const shape of [
        (i: number) => (i < 8 ? 9 - i : 1),
        (i: number) => POPULATION_SIZE - i,
        () => 0,
        (i: number) => (i === 0 ? 5 : 1),
        (i: number) => Math.max(0, 40 - i * 2),
      ]) {
        const order = rankGuidesByAgentOpens(
          POPULATION,
          new Map(POPULATION.map((guide, i) => [`/${guide.slug}`, shape(i)])),
        );
        const published = opensDecidedPrefix(order, HOMEPAGE_GUIDE_COUNT);
        assert.equal(
          guidesTiedAtCut(order, published.length),
          0,
          `${published.length} published, ${guidesTiedAtCut(order, published.length)} of them a tie`,
        );
      }
    });

    it("states the ranking and nothing else, with no tie left to disclose", () => {
      const sentence = selection();
      assert.match(sentence, /Membership is that ranking and nothing else/);
      assert.doesNotMatch(sentence, /tie on opens/);
      assert.doesNotMatch(sentence, /slug order/);
    });
  });

  describe("AC-1 opens decide membership, so a guide no agent opened is never on the page", () => {
    it("publishes the longest run whose last guide outscores the first one left out", () => {
      const order = rankGuidesByAgentOpens(
        POPULATION,
        new Map(POPULATION.map((guide, i) => [`/${guide.slug}`, i < 8 ? 9 - i : 1])),
      );
      const published = opensDecidedPrefix(order, HOMEPAGE_GUIDE_COUNT);
      assert.equal(published.length, 8);
      assert.equal(published[published.length - 1].agentOpens, 2);
      assert.equal(order[published.length].agentOpens, 1);
    });

    it("caps the run at the count the page publishes", () => {
      const order = rankGuidesByAgentOpens(
        POPULATION,
        new Map(POPULATION.map((guide, i) => [`/${guide.slug}`, POPULATION_SIZE - i])),
      );
      assert.equal(opensDecidedPrefix(order, HOMEPAGE_GUIDE_COUNT).length, HOMEPAGE_GUIDE_COUNT);
    });

    it("names no guide with no opens, whatever the ranking and whatever the cap", () => {
      for (const opened of [0, 1, 7, 20, 40, POPULATION_SIZE]) {
        const order = rankGuidesByAgentOpens(
          POPULATION,
          new Map(POPULATION.map((guide, i) => [`/${guide.slug}`, i < opened ? POPULATION_SIZE - i : 0])),
        );
        for (const cap of [1, 8, HOMEPAGE_GUIDE_COUNT, POPULATION_SIZE]) {
          const published = opensDecidedPrefix(order, cap);
          assert.deepEqual(
            published.filter((guide) => guide.agentOpens === 0).map((guide) => guide.slug),
            [],
            `${opened} guides opened, cap ${cap}`,
          );
          assert.ok(published.length <= Math.min(cap, opened), `${opened} opened, cap ${cap}, published ${published.length}`);
        }
      }
    });

    it("publishes nothing where every guide drew the same number of opens", () => {
      for (const flat of [0, 1, 9]) {
        const order = rankGuidesByAgentOpens(
          POPULATION,
          new Map(POPULATION.map((guide) => [`/${guide.slug}`, flat])),
        );
        assert.deepEqual(opensDecidedPrefix(order, HOMEPAGE_GUIDE_COUNT), []);
      }
    });

    it("reads the run off a day the ranker keeps", () => {
      const counts: Record<string, number> = { [agentKey(`/${POPULATION[0].slug}`)]: 5 };
      for (const guide of POPULATION.slice(1)) counts[agentKey(`/${guide.slug}`)] = 1;
      const ranked = rankableDays([dayWith("2026-09-22", counts)], POPULATION, AGENT_OPENS_WINDOW_DAYS);
      assert.equal(ranked.length, 1);

      const order = rankGuidesByAgentOpens(POPULATION, agentOpensByPath(ranked));
      const published = opensDecidedPrefix(order, HOMEPAGE_GUIDE_COUNT);
      assert.deepEqual(published.map((guide) => guide.slug), [POPULATION[0].slug]);

      const sentence = guideSelectionSentence({
        selectedCount: published.length,
        populationCount: POPULATION_SIZE,
        heldDays: 1,
        rankedWindow: agentOpensWindow(ranked, AGENT_OPENS_WINDOW_DAYS),
        attribution: agentRequestAttribution(ranked),
        opensDecided: published.length > 0,
      });
      assert.match(sentence, /The 1 of 97 guides AI agents opened most on 2026-09-22, the one complete day/);
      assert.doesNotMatch(sentence, /\b1 guides\b/);
    });
  });

  describe("AC-6 the fallback names the condition that put the page on it", () => {
    it("says opens separated nothing where the window is rankable and the run is empty", () => {
      const sentence = selection({
        rankedWindow: { days: 1, from: "2026-09-22", to: "2026-09-22" },
        opensDecided: false,
      });
      assert.match(sentence, /All 97 guides we publish, in the order \/guides lists them, and not a ranking\./);
      assert.match(sentence, /We can rank on 2026-09-22, the one complete day on which every guide we publish had its own count/);
      assert.match(sentence, /no guide was opened more often than the next one below it/);
      assert.doesNotMatch(sentence, /can rank on none of them/);
    });

    it("keeps the unrankable-window sentence for the case it was written for", () => {
      const sentence = selection({ rankedWindow: null, opensDecided: false });
      assert.match(sentence, /We hold 14 complete days of traffic and can rank on none of them/);
      assert.doesNotMatch(sentence, /We can rank on/);
    });

    it("states no window it could not rank on, at every length the window can take", () => {
      for (let days = 1; days <= AGENT_OPENS_WINDOW_DAYS; days++) {
        const sentence = selection({
          rankedWindow: { days, from: "2026-09-08", to: "2026-09-21" },
          opensDecided: false,
        });
        assert.doesNotMatch(sentence, /can rank on none of them/, `a rankable ${days}-day window read as unrankable`);
        assert.doesNotMatch(sentence, /\b1 days\b/, `a one-day window was counted as days: ${sentence}`);
      }
    });

    it("holds the sentence for a day we hold nothing for", () => {
      assert.equal(
        selection({ heldDays: 0, rankedWindow: null, opensDecided: false }),
        `All ${POPULATION_SIZE} guides we publish, in the order /guides lists them.`,
      );
    });
  });

  describe("AC-7 the ranking rests only on days the rollup marks complete", () => {
    function everyGuideCounted(date: string, opensForFirst = 1) {
      const counts: Record<string, number> = {};
      POPULATION.forEach((guide, i) => {
        counts[agentKey(`/${guide.slug}`)] = i === 0 ? opensForFirst : 1;
      });
      return dayWith(date, counts, POPULATION.map((g) => `/${g.slug}`));
    }

    function partial<T extends object>(day: T): T {
      return { ...day, complete: false };
    }

    it("ranks on no day the rollup has not marked complete, however well that day is counted", () => {
      const counted = everyGuideCounted("2026-09-25");
      assert.deepEqual(rankableDays([counted], POPULATION, AGENT_OPENS_WINDOW_DAYS), [counted]);
      assert.deepEqual(rankableDays([partial(counted)], POPULATION, AGENT_OPENS_WINDOW_DAYS), []);

      const noOverflow = dayWith("2026-09-25", { [agentKey(`/${POPULATION[0].slug}`)]: 4 });
      assert.deepEqual(rankableDays([noOverflow], POPULATION, AGENT_OPENS_WINDOW_DAYS), [noOverflow]);
      assert.deepEqual(rankableDays([partial(noOverflow)], POPULATION, AGENT_OPENS_WINDOW_DAYS), []);
    });

    it("reads a rollup that does not say it is complete as not complete", () => {
      const { complete: _dropped, ...unstated } = everyGuideCounted("2026-09-25");
      assert.deepEqual(rankableDays([unstated], POPULATION, AGENT_OPENS_WINDOW_DAYS), []);
    });

    it("dates the window to the last complete day, not to the day still being counted", () => {
      const days = [
        everyGuideCounted("2026-09-22"),
        everyGuideCounted("2026-09-23"),
        everyGuideCounted("2026-09-24"),
        partial(everyGuideCounted("2026-09-25")),
      ];
      const ranked = rankableDays(days, POPULATION, AGENT_OPENS_WINDOW_DAYS);
      assert.deepEqual(ranked.map((day: { date: string }) => day.date), ["2026-09-22", "2026-09-23", "2026-09-24"]);
      assert.deepEqual(agentOpensWindow(ranked, AGENT_OPENS_WINDOW_DAYS), { days: 3, from: "2026-09-22", to: "2026-09-24" });
    });

    it("lets no open from a day still being counted decide who is on the page", () => {
      const days = [everyGuideCounted("2026-09-24"), partial(everyGuideCounted("2026-09-25", 500))];
      const ranked = rankableDays(days, POPULATION, AGENT_OPENS_WINDOW_DAYS);
      const published = opensDecidedPrefix(
        rankGuidesByAgentOpens(POPULATION, agentOpensByPath(ranked)),
        HOMEPAGE_GUIDE_COUNT,
      );
      assert.deepEqual(published, [], "a guide was put ahead of the rest on opens from a day that had not finished");
    });

    it("counts as held only the complete days, so the fallback's claim covers every day it counts", () => {
      const days = [
        dayWith("2026-09-24", { [agentKey(OVERFLOW_PAGE_KEY)]: 40 }),
        partial(everyGuideCounted("2026-09-25")),
      ];
      assert.deepEqual(rankableDays(days, POPULATION, AGENT_OPENS_WINDOW_DAYS), []);
      assert.deepEqual(completeDaysInWindow(days, AGENT_OPENS_WINDOW_DAYS).map((day: { date: string }) => day.date), ["2026-09-24"]);
      const sentence = selection({ heldDays: completeDaysInWindow(days, AGENT_OPENS_WINDOW_DAYS).length, rankedWindow: null, opensDecided: false });
      assert.match(sentence, /We hold 1 complete day of traffic and can rank on none of them/);
      assert.doesNotMatch(sentence, /\b1 complete days\b/);
    });

    it("says the days it ranked on were complete, at every length the window can take", () => {
      for (let days = 1; days <= AGENT_OPENS_WINDOW_DAYS; days++) {
        const sentence = selection({ rankedWindow: { days, from: "2026-09-08", to: "2026-09-21" } });
        assert.match(sentence, days === 1 ? /the one complete day on which/ : new RegExp(`across the ${days} complete days on which`));
      }
    });
  });
});

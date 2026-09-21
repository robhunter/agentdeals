import { describe, it } from "node:test";
import assert from "node:assert";

const {
  AGENT_OPENS_WINDOW_DAYS,
  HOMEPAGE_GUIDE_COUNT,
  RANKED_TRAFFIC_CLASS,
  agentOpensByPath,
  agentOpensWindow,
  agentRequestAttribution,
  guideSelectionSentence,
  guidesTiedAtCut,
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
    tiedAtCut: 0,
    ...over,
  });
}

describe("the home page states the window its guide ranking actually measured (#1878)", () => {
  describe("AC-2 the window reads as English at every length it can take", () => {
    it("names the single day rather than counting one of them", () => {
      const sentence = selection({ rankedWindow: { days: 1, from: "2026-09-22", to: "2026-09-22" } });
      assert.match(sentence, /on 2026-09-22, the one day/);
      assert.doesNotMatch(sentence, /1 days/);
      assert.doesNotMatch(sentence, /2026-09-22 to 2026-09-22/);
    });

    it("counts the days and names both ends where the window is longer than one", () => {
      const sentence = selection({ rankedWindow: { days: 14, from: "2026-09-08", to: "2026-09-21" } });
      assert.match(sentence, /across the 14 days .*, 2026-09-08 to 2026-09-21\./);
    });

    it("writes no count as a plural it does not take, at any length the ranking can read", () => {
      for (let days = 1; days <= AGENT_OPENS_WINDOW_DAYS; days++) {
        const sentence = selection({
          rankedWindow: { days, from: "2026-09-08", to: "2026-09-21" },
          attribution: { attributed: 90, unattributed: 10, total: 100 },
          tiedAtCut: 3,
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

    it("names the tie and withholds the completeness claim where any guide ties at the cut", () => {
      const sentence = selection({ tiedAtCut: 12 });
      assert.match(sentence, /12 of the 20 tie on opens with the first guide we left out/);
      assert.match(sentence, /so slug order rather than opens put them here/);
      assert.doesNotMatch(sentence, /and nothing else/);
    });

    it("claims the ranking and nothing else only where nothing ties at the cut", () => {
      assert.match(selection(), /Membership is that ranking and nothing else/);
    });

    it("reads the same tie off the ranking the page publishes", () => {
      const counts: Record<string, number> = { [agentKey(`/${POPULATION[0].slug}`)]: 5 };
      for (const guide of POPULATION.slice(1)) counts[agentKey(`/${guide.slug}`)] = 1;
      const day = dayWith("2026-09-22", counts);
      const ranked = rankableDays([day], POPULATION, AGENT_OPENS_WINDOW_DAYS);
      assert.equal(ranked.length, 1);

      const order = rankGuidesByAgentOpens(POPULATION, agentOpensByPath(ranked));
      const tied = guidesTiedAtCut(order, HOMEPAGE_GUIDE_COUNT);
      assert.equal(tied, HOMEPAGE_GUIDE_COUNT - 1);

      const sentence = guideSelectionSentence({
        selectedCount: HOMEPAGE_GUIDE_COUNT,
        populationCount: POPULATION_SIZE,
        heldDays: 1,
        rankedWindow: agentOpensWindow(ranked, AGENT_OPENS_WINDOW_DAYS),
        attribution: agentRequestAttribution(ranked),
        tiedAtCut: tied,
      });
      assert.match(sentence, new RegExp(`${tied} of the ${HOMEPAGE_GUIDE_COUNT} tie on opens`));
      assert.match(sentence, /on 2026-09-22, the one day/);
    });
  });
});

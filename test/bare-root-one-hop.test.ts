import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ONE_HOP_PATHS,
  oneHopUrls,
  samePage,
  probeOffer,
  summarise,
  applyRepoints,
  heldPopulation,
  heldBeforeRepointing,
  repointsTheRulingTakes,
  repointsStatingAZero,
  verifiedDatesThatMoved,
  HELD_LISTINGS,
  AN_ENDED_LISTING,
  AN_OPEN_SOURCE_EDITION,
  REPOSITORIES_OF_OPEN_SOURCE_EDITIONS,
  anOpenSourceEdition,
  repointsToTheirRepository,
} from "../scripts/bare-root-one-hop-audit.mjs";
import { isBareRoot } from "../scripts/bare-root-pricing-audit.js";
import { figuresWeAlsoPublish } from "../scripts/change-gate.js";
import { statesAnAmountOfZero } from "../scripts/vendor-naming.js";
import { reportedFigures } from "../scripts/withdraw-figures-we-do-not-publish.js";

const ROOT = "https://cloud.typesense.org/";

const OFFER = {
  vendor: "Typesense Cloud",
  url: ROOT,
  description: "Free search cluster with 1 node and 64 MB RAM.",
  verifiedDate: "2026-07-28",
  source_check: {
    checked: "2026-09-14",
    outcome: "states_no_terms",
    detail: "the page names Typesense Cloud but states no amount, tier or rate we can read",
  },
};

const PRICING_PAGE =
  "Typesense Cloud pricing. Free: 64 MB RAM / month. Production clusters from $19.20 per month.";
const A_PAGE_OF_AMOUNTS_THAT_ARE_NOT_OURS =
  "Typesense Cloud pricing. Production clusters from $19.20 per month. Dedicated clusters from $99 per month.";
const A_PAGE_STATING_A_ZERO_AND_NONE_OF_OUR_FIGURES =
  "Typesense Cloud pricing. Free tier $0/mo for a starter cluster. Production clusters from $19.20 per month.";
const A_PAGE_THAT_NAMES_THE_VENDOR_AND_NO_TERMS =
  "Typesense Cloud. Search that ships in minutes. Talk to us about your workload.";
const A_PAGE_OF_PRICES_FOR_SOMEBODY_ELSE =
  "pricing — a JavaScript module for formatting money. Downloads $0 forever, Pro from $12/month.";

function servedFrom(pages: Record<string, unknown>) {
  return async (url: string) => pages[url] ?? { ok: false, error: "HTTP 404" };
}

function answering(text: string, finalUrl: string) {
  return { ok: true, text, structured: null, finalUrl };
}

describe("reading one hop out from the root we cite", () => {
  it("asks for the conventional pricing paths on the same origin", () => {
    assert.deepStrictEqual(oneHopUrls(ROOT), [
      "https://cloud.typesense.org/pricing",
      "https://cloud.typesense.org/pricing/",
      "https://cloud.typesense.org/plans",
      "https://cloud.typesense.org/pricing.html",
    ]);
  });

  it("treats a trailing slash as the same page", () => {
    assert.ok(samePage("https://a.example/", "https://a.example"));
    assert.ok(samePage("https://a.example/pricing/", "https://a.example/pricing"));
    assert.ok(!samePage("https://a.example/pricing", "https://a.example/plans"));
  });

  it("repoints to the hop that names the vendor and states an amount", async () => {
    const probe = await probeOffer(
      OFFER,
      servedFrom({
        [ROOT]: answering(A_PAGE_THAT_NAMES_THE_VENDOR_AND_NO_TERMS, ROOT),
        "https://cloud.typesense.org/pricing": answering(
          PRICING_PAGE,
          "https://cloud.typesense.org/pricing"
        ),
      })
    );
    assert.strictEqual(probe.repoint_to, "https://cloud.typesense.org/pricing");
    assert.strictEqual(probe.root.outcome, "states_no_terms");
  });

  it("refuses a hop that resolves back to the root we already read", async () => {
    const probe = await probeOffer(
      OFFER,
      servedFrom({
        [ROOT]: answering(A_PAGE_THAT_NAMES_THE_VENDOR_AND_NO_TERMS, ROOT),
        "https://cloud.typesense.org/pricing": answering(PRICING_PAGE, ROOT),
      })
    );
    assert.strictEqual(probe.repoint_to, null);
    assert.strictEqual(summarise([probe]).one_hop_redirects_to_the_root, 1);
  });

  it("refuses a hop that resolves and states no terms, so a 200 alone repoints nothing", async () => {
    const probe = await probeOffer(
      OFFER,
      servedFrom({
        [ROOT]: answering(A_PAGE_THAT_NAMES_THE_VENDOR_AND_NO_TERMS, ROOT),
        "https://cloud.typesense.org/plans": answering(
          A_PAGE_THAT_NAMES_THE_VENDOR_AND_NO_TERMS,
          "https://cloud.typesense.org/plans"
        ),
      })
    );
    assert.strictEqual(probe.repoint_to, null);
    assert.strictEqual(summarise([probe]).one_hop_readable_states_no_terms, 1);
  });

  it("refuses a hop full of prices that never names the vendor", async () => {
    const probe = await probeOffer(
      OFFER,
      servedFrom({
        [ROOT]: answering(A_PAGE_THAT_NAMES_THE_VENDOR_AND_NO_TERMS, ROOT),
        "https://cloud.typesense.org/pricing": answering(
          A_PAGE_OF_PRICES_FOR_SOMEBODY_ELSE,
          "https://cloud.typesense.org/pricing"
        ),
      })
    );
    assert.strictEqual(probe.repoint_to, null);
    assert.strictEqual(summarise([probe]).one_hop_does_not_name_vendor, 1);
  });

  it("names the paths that also answered and lost", async () => {
    const probe = await probeOffer(
      OFFER,
      servedFrom({
        [ROOT]: answering(A_PAGE_THAT_NAMES_THE_VENDOR_AND_NO_TERMS, ROOT),
        "https://cloud.typesense.org/pricing": answering(
          PRICING_PAGE,
          "https://cloud.typesense.org/pricing"
        ),
        "https://cloud.typesense.org/plans": answering(
          PRICING_PAGE,
          "https://cloud.typesense.org/plans"
        ),
      })
    );
    assert.strictEqual(probe.repoint_to, "https://cloud.typesense.org/pricing");
    assert.deepStrictEqual(probe.lost_to_the_winner, ["https://cloud.typesense.org/plans"]);
  });

  it("counts a root that answers today as needing no repoint", async () => {
    const probe = await probeOffer(
      OFFER,
      servedFrom({
        [ROOT]: answering(PRICING_PAGE, ROOT),
        "https://cloud.typesense.org/pricing": answering(
          PRICING_PAGE,
          "https://cloud.typesense.org/pricing"
        ),
      })
    );
    const summary = summarise([probe]);
    assert.strictEqual(summary.root_answers_today, 1);
    assert.strictEqual(summary.one_hop_answers, 0);
  });

  it("does not repoint an offer whose root answers today", async () => {
    const probe = await probeOffer(
      OFFER,
      servedFrom({
        [ROOT]: answering(PRICING_PAGE, ROOT),
        "https://cloud.typesense.org/pricing": answering(
          PRICING_PAGE,
          "https://cloud.typesense.org/pricing"
        ),
      })
    );
    const offers = [{ ...OFFER }];
    assert.deepStrictEqual(applyRepoints(offers, [probe]).applied, []);
    assert.strictEqual(offers[0].url, ROOT);
  });

  it("reads a root we cannot fetch as unreadable rather than as an answer", async () => {
    const probe = await probeOffer(OFFER, servedFrom({}));
    const summary = summarise([probe]);
    assert.strictEqual(summary.root_unreadable, 1);
    assert.strictEqual(summary.nothing_we_read_answers, 1);
    assert.strictEqual(ONE_HOP_PATHS.length, probe.hops.length);
  });
});

describe("applying the repoints a probe earned", () => {
  async function aProbeThatFoundAPricingPage() {
    return probeOffer(
      OFFER,
      servedFrom({
        [ROOT]: answering(A_PAGE_THAT_NAMES_THE_VENDOR_AND_NO_TERMS, ROOT),
        "https://cloud.typesense.org/pricing": answering(
          PRICING_PAGE,
          "https://cloud.typesense.org/pricing"
        ),
      }),
      "2026-09-21"
    );
  }

  it("cites the page that answered and leaves the verified date where it was", async () => {
    const probe = await aProbeThatFoundAPricingPage();
    const offers = [{ ...OFFER }];
    const { applied } = applyRepoints(offers, [probe]);
    assert.deepStrictEqual(applied, [
      { vendor: "Typesense Cloud", from: ROOT, to: "https://cloud.typesense.org/pricing" },
    ]);
    assert.strictEqual(offers[0].url, "https://cloud.typesense.org/pricing");
    assert.strictEqual(offers[0].verifiedDate, OFFER.verifiedDate);
  });

  it("stores the check taken on the page we now cite, not the one taken on the root", async () => {
    const probe = await aProbeThatFoundAPricingPage();
    const offers = [{ ...OFFER }];
    applyRepoints(offers, [probe]);
    assert.strictEqual(offers[0].source_check.outcome, "ok");
    assert.strictEqual(offers[0].source_check.checked, "2026-09-21");
    assert.match(offers[0].source_check.detail, /names Typesense Cloud/);
  });

  it("leaves an offer alone when its stored URL moved after the probe read it", async () => {
    const probe = await aProbeThatFoundAPricingPage();
    const offers = [{ ...OFFER, url: "https://cloud.typesense.org/plans" }];
    const { applied, movedSinceTheProbe } = applyRepoints(offers, [probe]);
    assert.deepStrictEqual(applied, []);
    assert.deepStrictEqual(movedSinceTheProbe, ["Typesense Cloud"]);
    assert.strictEqual(offers[0].url, "https://cloud.typesense.org/plans");
  });

  it("removes an excerpt read from the root the offer no longer cites", async () => {
    const probe = await aProbeThatFoundAPricingPage();
    const offers = [{ ...OFFER, free_plan_excerpt: { text: "Free to start.", url: ROOT, read_on: "2026-09-14" } }];
    const { excerptsLeftOnTheRoot } = applyRepoints(offers, [probe]);
    assert.deepStrictEqual(excerptsLeftOnTheRoot, ["Typesense Cloud"]);
    assert.ok(!("free_plan_excerpt" in offers[0]));
  });

  it("keeps an excerpt read from the page the offer now cites", async () => {
    const probe = await aProbeThatFoundAPricingPage();
    const fromThePricingPage = { text: "Free: 64 MB RAM.", url: "https://cloud.typesense.org/pricing", read_on: "2026-09-14" };
    const offers = [{ ...OFFER, free_plan_excerpt: fromThePricingPage }];
    const { excerptsLeftOnTheRoot } = applyRepoints(offers, [probe]);
    assert.deepStrictEqual(excerptsLeftOnTheRoot, []);
    assert.deepStrictEqual(offers[0].free_plan_excerpt, fromThePricingPage);
  });

  it("repoints neither offer when one vendor and URL carries two of them", async () => {
    const probe = await aProbeThatFoundAPricingPage();
    const offers = [{ ...OFFER }, { ...OFFER, description: "Free trial cluster, 14 days." }];
    const { applied, sharedByTwoOffers } = applyRepoints(offers, [probe]);
    assert.deepStrictEqual(applied, []);
    assert.deepStrictEqual(sharedByTwoOffers, [
      { vendor: "Typesense Cloud", url: ROOT, offers: 2 },
    ]);
    assert.deepStrictEqual(
      offers.map((offer) => offer.url),
      [ROOT, ROOT]
    );
  });
});

describe("the guard that refuses a write which moved a verified date", () => {
  const TWO_OFFERS_ONE_VENDOR = [
    { vendor: "OVHcloud", verifiedDate: "2026-08-18" },
    { vendor: "OVHcloud", verifiedDate: "2026-08-20" },
  ];

  it("says nothing moved when one vendor carries two dates and neither changed", () => {
    const before = TWO_OFFERS_ONE_VENDOR.map((offer) => offer.verifiedDate);
    assert.deepStrictEqual(verifiedDatesThatMoved(before, TWO_OFFERS_ONE_VENDOR), []);
  });

  it("names the offer whose date moved, by the position it was read at", () => {
    const before = TWO_OFFERS_ONE_VENDOR.map((offer) => offer.verifiedDate);
    const after = [TWO_OFFERS_ONE_VENDOR[0], { vendor: "OVHcloud", verifiedDate: "2026-09-22" }];
    assert.deepStrictEqual(verifiedDatesThatMoved(before, after), [
      { vendor: "OVHcloud", from: "2026-08-20", to: "2026-09-22" },
    ]);
  });
});

describe("taking only the repoints whose page quotes a figure we already publish", () => {
  async function aProbeOfAPageStating(text: string) {
    return probeOffer(
      OFFER,
      servedFrom({
        [ROOT]: answering(A_PAGE_THAT_NAMES_THE_VENDOR_AND_NO_TERMS, ROOT),
        "https://cloud.typesense.org/pricing": answering(
          text,
          "https://cloud.typesense.org/pricing"
        ),
      }),
      "2026-09-22"
    );
  }

  it("holds a page that states amounts our own terms do not contain", async () => {
    const held = await aProbeOfAPageStating(A_PAGE_OF_AMOUNTS_THAT_ARE_NOT_OURS);
    assert.strictEqual(held.repoint_to, "https://cloud.typesense.org/pricing");
    assert.deepStrictEqual(repointsTheRulingTakes([held]), []);

    const offers = [{ ...OFFER }];
    assert.deepStrictEqual(applyRepoints(offers, [held]).applied, []);
    assert.strictEqual(offers[0].url, ROOT);
    assert.strictEqual(offers[0].source_check.outcome, "states_no_terms");
  });

  it("names a held offer with the amounts its page states beside the terms we hold", async () => {
    const held = await aProbeOfAPageStating(A_PAGE_OF_AMOUNTS_THAT_ARE_NOT_OURS);
    assert.deepStrictEqual(heldPopulation([held]), [
      {
        vendor: "Typesense Cloud",
        url: ROOT,
        the_page_we_are_not_citing: "https://cloud.typesense.org/pricing",
        amounts_the_page_states: ["$19.20", "$99"],
        terms_we_hold: OFFER.description,
      },
    ]);
  });

  it("counts the three populations apart in the summary", async () => {
    const taken = await aProbeOfAPageStating(PRICING_PAGE);
    const zero = await aProbeOfAPageStating(A_PAGE_STATING_A_ZERO_AND_NONE_OF_OUR_FIGURES);
    const held = await aProbeOfAPageStating(A_PAGE_OF_AMOUNTS_THAT_ARE_NOT_OURS);
    const summary = summarise([taken, zero, held]);
    assert.strictEqual(summary.one_hop_answers, 3);
    assert.strictEqual(summary.one_hop_answers_quoting_a_figure_we_publish, 1);
    assert.strictEqual(summary.one_hop_answers_stating_a_zero_and_no_figure_of_ours, 1);
    assert.strictEqual(summary.one_hop_answers_stating_only_amounts_not_ours, 1);
    assert.strictEqual(summary.repoints_taken, 2);
    assert.strictEqual(summary.held_before_repointing, 0);
    assert.deepStrictEqual(heldPopulation([taken, zero]), []);
    assert.deepStrictEqual(heldBeforeRepointing([taken, zero, held]), []);
  });

  it("stores a check reporting only figures the repointed offer itself publishes", async () => {
    const taken = await aProbeOfAPageStating(PRICING_PAGE);
    const offers = [{ ...OFFER }];
    applyRepoints(offers, [taken]);

    const reported = reportedFigures(offers[0].source_check.detail)!.figures;
    assert.ok(reported.length > 0, offers[0].source_check.detail);
    assert.deepStrictEqual(
      reported.filter(
        (figure: string) => figuresWeAlsoPublish([figure], offers[0].description).length === 0
      ),
      []
    );
  });
});

describe("taking the repoints whose page states a price of zero and none of our figures", () => {
  const PROSE_ONLY = { ...OFFER, description: "Managed search clusters with typo tolerance and faceting." };

  async function aProbeOf(offer: typeof OFFER, text: string) {
    return probeOffer(
      offer,
      servedFrom({
        [ROOT]: answering(A_PAGE_THAT_NAMES_THE_VENDOR_AND_NO_TERMS, ROOT),
        "https://cloud.typesense.org/pricing": answering(text, "https://cloud.typesense.org/pricing"),
      }),
      "2026-10-08"
    );
  }

  it("repoints the offer and stores a check that reports the zero and nothing else", async () => {
    const zero = await aProbeOf(OFFER, A_PAGE_STATING_A_ZERO_AND_NONE_OF_OUR_FIGURES);
    const offers = [{ ...OFFER }];
    const { applied } = applyRepoints(offers, [zero]);
    assert.deepStrictEqual(applied, [
      { vendor: "Typesense Cloud", from: ROOT, to: "https://cloud.typesense.org/pricing" },
    ]);
    assert.strictEqual(offers[0].source_check.outcome, "ok");
    assert.strictEqual(offers[0].source_check.checked, "2026-10-08");
    assert.deepStrictEqual(reportedFigures(offers[0].source_check.detail)!.figures, ["$0"]);
    assert.strictEqual(offers[0].verifiedDate, OFFER.verifiedDate);
  });

  it("files a page stating a zero beside a figure we publish under the figure, not the zero", async () => {
    const both = await aProbeOf(
      OFFER,
      "Typesense Cloud pricing. Free tier $0/mo with 64 MB RAM / month. Production clusters from $19.20 per month."
    );
    const summary = summarise([both]);
    assert.strictEqual(summary.one_hop_answers_quoting_a_figure_we_publish, 1);
    assert.strictEqual(summary.one_hop_answers_stating_a_zero_and_no_figure_of_ours, 0);
    const reported = reportedFigures(both.winner_check.detail)!.figures;
    assert.ok(reported.every((figure: string) => !statesAnAmountOfZero(figure)), both.winner_check.detail);
  });

  it("names the repoints apart by whether the terms we hold state a quantity the page did not match", async () => {
    const quantified = await aProbeOf(OFFER, A_PAGE_STATING_A_ZERO_AND_NONE_OF_OUR_FIGURES);
    const prose = await aProbeOf(PROSE_ONLY, A_PAGE_STATING_A_ZERO_AND_NONE_OF_OUR_FIGURES);
    const named = repointsStatingAZero([quantified, prose]);
    assert.deepStrictEqual(named.terms_state_a_quantity_the_page_did_not_match, [
      {
        vendor: "Typesense Cloud",
        repointed_to: "https://cloud.typesense.org/pricing",
        terms_we_hold: OFFER.description,
      },
    ]);
    assert.deepStrictEqual(named.terms_state_no_quantity_we_can_read, [
      {
        vendor: "Typesense Cloud",
        repointed_to: "https://cloud.typesense.org/pricing",
        terms_we_hold: PROSE_ONLY.description,
      },
    ]);
  });

  it("takes a stored check only when every figure it reports is a zero", async () => {
    const zero = await aProbeOf(OFFER, A_PAGE_STATING_A_ZERO_AND_NONE_OF_OUR_FIGURES);
    const reportingAnotherAmount = {
      ...zero,
      winner_check: {
        ...zero.winner_check,
        detail: 'the page names Typesense Cloud as "typesense cloud" and states "$0" and "$19.20"',
      },
    };
    assert.deepStrictEqual(repointsTheRulingTakes([reportingAnotherAmount]), []);
    assert.strictEqual(summarise([reportingAnotherAmount]).one_hop_answers_stating_only_amounts_not_ours, 1);
  });

  it("leaves out of both lists a repoint that quotes a figure we publish", async () => {
    const taken = await aProbeOf(OFFER, PRICING_PAGE);
    assert.deepStrictEqual(repointsStatingAZero([taken]), {
      terms_state_a_quantity_the_page_did_not_match: [],
      terms_state_no_quantity_we_can_read: [],
    });
  });
});

describe("holding a listing named as held or that has ended", () => {
  const ZULIP = {
    vendor: "Zulip",
    url: "https://zulip.com/",
    tier: "Free",
    description: "Real-time chat. The free plan includes 10,000 messages of search history and File storage up to 5 GB.",
    verifiedDate: "2026-07-31",
    source_check: {
      checked: "2026-09-02",
      outcome: "states_no_terms",
      detail: "the page names Zulip but states no amount, tier or rate we can read",
    },
  };
  const ZULIP_PLANS =
    "Zulip Cloud plans. Free $0 forever: 10,000 messages of search history, 5 GB per user. Standard $6.67 per user per month.";

  async function aZulipProbe() {
    return probeOffer(
      ZULIP,
      servedFrom({
        "https://zulip.com/": answering("Zulip. Organized team chat.", "https://zulip.com/"),
        "https://zulip.com/plans": answering(ZULIP_PLANS, "https://zulip.com/plans"),
      }),
      "2026-10-08"
    );
  }

  it("does not repoint Zulip, whose plans page answers, and gives the reason it is held", async () => {
    const probe = await aZulipProbe();
    assert.strictEqual(probe.repoint_to, "https://zulip.com/plans");
    assert.deepStrictEqual(repointsTheRulingTakes([probe]), []);
    assert.deepStrictEqual(heldBeforeRepointing([probe]), [
      {
        vendor: "Zulip",
        url: "https://zulip.com/",
        the_page_we_are_not_citing: "https://zulip.com/plans",
        reason: HELD_LISTINGS.get("Zulip"),
      },
    ]);
    const offers = [{ ...ZULIP }];
    assert.deepStrictEqual(applyRepoints(offers, [probe]).applied, []);
    assert.deepStrictEqual(offers[0], ZULIP);
  });

  it("does not repoint an ended listing, whose root is the page that says it ended", async () => {
    const ended = { ...OFFER, tier: "Retired" };
    const probe = await probeOffer(
      ended,
      servedFrom({
        [ROOT]: answering(A_PAGE_THAT_NAMES_THE_VENDOR_AND_NO_TERMS, ROOT),
        "https://cloud.typesense.org/pricing": answering(PRICING_PAGE, "https://cloud.typesense.org/pricing"),
      }),
      "2026-10-08"
    );
    assert.deepStrictEqual(repointsTheRulingTakes([probe]), []);
    assert.deepStrictEqual(
      heldBeforeRepointing([probe]).map((held: { reason: string }) => held.reason),
      [AN_ENDED_LISTING]
    );
    assert.strictEqual(summarise([probe]).held_before_repointing, 1);
  });

  it("holds on applying a listing that ended after the probe read it", async () => {
    const probe = await probeOffer(
      OFFER,
      servedFrom({
        [ROOT]: answering(A_PAGE_THAT_NAMES_THE_VENDOR_AND_NO_TERMS, ROOT),
        "https://cloud.typesense.org/pricing": answering(PRICING_PAGE, "https://cloud.typesense.org/pricing"),
      }),
      "2026-10-08"
    );
    const offers = [{ ...OFFER, tier: "Retired" }];
    const { applied, heldOnApplying } = applyRepoints(offers, [probe]);
    assert.deepStrictEqual(applied, []);
    assert.deepStrictEqual(heldOnApplying, [{ vendor: "Typesense Cloud", reason: AN_ENDED_LISTING }]);
    assert.strictEqual(offers[0].url, ROOT);
  });
});

describe("an open-source edition cites its repository, never the hosted product's pricing page", () => {
  const UMAMI = {
    vendor: "Umami",
    url: "https://umami.is/",
    tier: "Free OSS",
    description: "Free OSS (MIT). Simple, privacy-focused web analytics. Self-hosted with no limits",
    verifiedDate: "2026-08-23",
    source_check: {
      checked: "2026-09-10",
      outcome: "states_no_terms",
      detail: "the page names Umami but states no amount, tier or rate we can read",
    },
  };
  const REPOSITORY = REPOSITORIES_OF_OPEN_SOURCE_EDITIONS.get("Umami")!;
  const HOSTED_PLANS = "Umami Cloud pricing. Hobby $0 / month for one website. Pro from $20 per month.";
  const HOSTED_PLANS_WITH_NO_ZERO = "Umami Cloud pricing. Pro from $20 per month. Business from $200 per month.";
  const README = "umami-software/umami. Umami is a privacy-focused alternative to Google Analytics. MIT license.";

  async function aProbeOf(
    listing: typeof UMAMI,
    repositoryPage: unknown,
    hostedPlans: string = HOSTED_PLANS
  ) {
    return probeOffer(
      listing,
      servedFrom({
        "https://umami.is/": answering("Umami. Empowering insights, preserving privacy.", "https://umami.is/"),
        "https://umami.is/pricing": answering(hostedPlans, "https://umami.is/pricing"),
        ...(repositoryPage ? { [REPOSITORY]: repositoryPage } : {}),
      }),
      "2026-10-08"
    );
  }

  it("cites the repository named for it, with the check taken there, and leaves the verified date where it was", async () => {
    const probe = await aProbeOf(UMAMI, answering(README, REPOSITORY));
    assert.strictEqual(probe.repoint_to, "https://umami.is/pricing");
    const offers = [{ ...UMAMI }];
    const { applied } = applyRepoints(offers, [probe]);
    assert.deepStrictEqual(applied, [{ vendor: "Umami", from: "https://umami.is/", to: REPOSITORY }]);
    assert.strictEqual(offers[0].url, REPOSITORY);
    assert.deepStrictEqual(offers[0].source_check, probe.repository.check);
    assert.strictEqual(offers[0].source_check.checked, "2026-10-08");
    assert.strictEqual(offers[0].source_check.outcome, "states_no_terms");
    assert.strictEqual(offers[0].verifiedDate, UMAMI.verifiedDate);
  });

  it("never takes the hosted product's pricing page, whose zero is the hosted plan's price", async () => {
    const probe = await aProbeOf(UMAMI, answering(README, REPOSITORY));
    assert.deepStrictEqual(repointsTheRulingTakes([probe]), []);
    assert.deepStrictEqual(repointsStatingAZero([probe]), {
      terms_state_a_quantity_the_page_did_not_match: [],
      terms_state_no_quantity_we_can_read: [],
    });
  });

  it("counts the repository repoint apart from the hops and the held", async () => {
    const summary = summarise([await aProbeOf(UMAMI, answering(README, REPOSITORY))]);
    assert.strictEqual(summary.repointed_to_their_repository, 1);
    assert.strictEqual(summary.repoints_taken, 0);
    assert.strictEqual(summary.held_before_repointing, 0);
  });

  it("holds it on its root, giving the reason, when its repository cannot be read", async () => {
    const probe = await aProbeOf(UMAMI, null);
    assert.strictEqual(probe.repository.ok, false);
    assert.deepStrictEqual(repointsToTheirRepository([probe]), []);
    assert.deepStrictEqual(heldBeforeRepointing([probe]), [
      {
        vendor: "Umami",
        url: "https://umami.is/",
        the_page_we_are_not_citing: "https://umami.is/pricing",
        reason: AN_OPEN_SOURCE_EDITION,
      },
    ]);
    const offers = [{ ...UMAMI }];
    assert.deepStrictEqual(applyRepoints(offers, [probe]).applied, []);
    assert.deepStrictEqual(offers[0], UMAMI);
  });

  it("holds it when the page at its repository never names it", async () => {
    const probe = await aProbeOf(
      UMAMI,
      answering("A privacy-focused web analytics project. MIT license.", REPOSITORY)
    );
    assert.strictEqual(probe.repository.ok, true);
    assert.deepStrictEqual(repointsToTheirRepository([probe]), []);
    const offers = [{ ...UMAMI }];
    assert.deepStrictEqual(applyRepoints(offers, [probe]).applied, []);
    assert.strictEqual(offers[0].url, UMAMI.url);
  });

  it("holds an open-source edition with no repository named, though a page one hop away states a zero", async () => {
    const edition = { ...OFFER, tier: "Free OSS" };
    const probe = await probeOffer(
      edition,
      servedFrom({
        [ROOT]: answering(A_PAGE_THAT_NAMES_THE_VENDOR_AND_NO_TERMS, ROOT),
        "https://cloud.typesense.org/pricing": answering(
          A_PAGE_STATING_A_ZERO_AND_NONE_OF_OUR_FIGURES,
          "https://cloud.typesense.org/pricing"
        ),
      }),
      "2026-10-08"
    );
    assert.strictEqual(probe.repository, null);
    assert.deepStrictEqual(repointsTheRulingTakes([probe]), []);
    assert.deepStrictEqual(
      heldBeforeRepointing([probe]).map((held: { reason: string }) => held.reason),
      [AN_OPEN_SOURCE_EDITION]
    );
    const offers = [{ ...edition }];
    assert.deepStrictEqual(applyRepoints(offers, [probe]).applied, []);
    assert.strictEqual(offers[0].url, ROOT);
  });

  it("leaves on its root an open-source edition the ruling does not cover, though its repository answers", async () => {
    const probe = await aProbeOf(UMAMI, answering(README, REPOSITORY), HOSTED_PLANS_WITH_NO_ZERO);
    assert.ok(probe.repoint_to, "the hosted plans page answers");
    assert.deepStrictEqual(repointsToTheirRepository([probe]), []);
    const offers = [{ ...UMAMI }];
    assert.deepStrictEqual(applyRepoints(offers, [probe]).applied, []);
  });

  it("keeps an ended open-source edition on its root, whatever its repository says", async () => {
    const probe = await aProbeOf({ ...UMAMI, tier: "Free OSS (retired)" }, answering(README, REPOSITORY));
    assert.deepStrictEqual(repointsToTheirRepository([probe]), []);
    assert.deepStrictEqual(
      heldBeforeRepointing([probe]).map((held: { reason: string }) => held.reason),
      [AN_ENDED_LISTING]
    );
  });

  it("holds on applying an open-source edition that ended after the probe read it", async () => {
    const probe = await aProbeOf(UMAMI, answering(README, REPOSITORY));
    const offers = [{ ...UMAMI, tier: "Free OSS (retired)" }];
    const { applied, heldOnApplying } = applyRepoints(offers, [probe]);
    assert.deepStrictEqual(applied, []);
    assert.deepStrictEqual(heldOnApplying, [{ vendor: "Umami", reason: AN_ENDED_LISTING }]);
    assert.strictEqual(offers[0].url, UMAMI.url);
  });

  it("holds on applying a listing whose tier came to name an open-source edition after the probe read it", async () => {
    const probe = await probeOffer(
      OFFER,
      servedFrom({
        [ROOT]: answering(A_PAGE_THAT_NAMES_THE_VENDOR_AND_NO_TERMS, ROOT),
        "https://cloud.typesense.org/pricing": answering(
          A_PAGE_STATING_A_ZERO_AND_NONE_OF_OUR_FIGURES,
          "https://cloud.typesense.org/pricing"
        ),
      }),
      "2026-10-08"
    );
    const offers = [{ ...OFFER, tier: "Open Source" }];
    const { applied, heldOnApplying } = applyRepoints(offers, [probe]);
    assert.deepStrictEqual(applied, []);
    assert.deepStrictEqual(heldOnApplying, [{ vendor: "Typesense Cloud", reason: AN_OPEN_SOURCE_EDITION }]);
  });

  it("reads every spelling of an open-source or self-hosted edition the catalogue's tiers use, and no hosted tier", () => {
    for (const tier of [
      "Free OSS",
      "OSS",
      "Open Source",
      "Self-Hosted",
      "Community (Self-hosted)",
      "Starter / Open Source",
      "Free (open-source library; managed cloud is paid-only)",
    ]) {
      assert.ok(anOpenSourceEdition({ tier }), tier);
    }
    for (const tier of ["Free", "Trial", "Hobby", "Community (Free)", "Free Tier", "Retired", "Startup Program"]) {
      assert.ok(!anOpenSourceEdition({ tier }), tier);
    }
  });
});

describe("the catalogue keeps a held listing on the root it cited before", () => {
  const catalogue: { vendor: string; url: string }[] = JSON.parse(
    readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "index.json"),
      "utf-8"
    )
  ).offers;

  it("cites a bare root for every held listing", () => {
    for (const vendor of HELD_LISTINGS.keys()) {
      const listings = catalogue.filter((offer) => offer.vendor === vendor);
      assert.ok(listings.length > 0, `${vendor} is in the catalogue`);
      for (const listing of listings) assert.ok(isBareRoot(listing.url), `${vendor} cites ${listing.url}`);
    }
  });

  it("cites the repository named for every open-source edition that has one", () => {
    for (const [vendor, repository] of REPOSITORIES_OF_OPEN_SOURCE_EDITIONS) {
      const listings = catalogue.filter((offer) => offer.vendor === vendor);
      assert.ok(listings.length > 0, `${vendor} is in the catalogue`);
      for (const listing of listings) assert.strictEqual(listing.url, repository, vendor);
    }
  });
});

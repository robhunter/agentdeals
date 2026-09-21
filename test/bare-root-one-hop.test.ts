import { describe, it } from "node:test";
import assert from "node:assert";
import {
  ONE_HOP_PATHS,
  oneHopUrls,
  samePage,
  probeOffer,
  summarise,
  applyRepoints,
} from "../scripts/bare-root-one-hop-audit.mjs";

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
  "Typesense Cloud pricing. Free tier $0/mo for a 64 MB cluster. Production clusters from $19.20 per month.";
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
});

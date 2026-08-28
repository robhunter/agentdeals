import { describe, it } from "node:test";
import assert from "node:assert";
import {
  vendorNameForms,
  pageNamesVendor,
  classifySource,
  SOURCE_CHECK_OK,
  SOURCE_CHECK_NOT_NAMED,
  SOURCE_CHECK_NO_TERMS,
  SOURCE_CHECK_UNREADABLE,
} from "../scripts/vendor-naming.js";
import { priceSignals, MIN_PRICE_SIGNALS } from "../scripts/change-gate.js";
import { JOINSECRET_OFFERS_PAGE, BREX_REWARDS_PAGE } from "./vendor-page-fixture.ts";

describe("does the page state terms about THIS vendor", () => {
  describe("a marketplace page saturated with other companies' prices", () => {
    it("carries the price signals that let it through the gate's first question", () => {
      assert.ok(priceSignals(JOINSECRET_OFFERS_PAGE).length >= MIN_PRICE_SIGNALS);
      assert.ok(priceSignals(BREX_REWARDS_PAGE).length >= MIN_PRICE_SIGNALS);
    });

    it("does not name the vendor whose offer we source from it", () => {
      for (const vendor of ["Cloudways", "Axonaut", "Freshdesk", "Crowdfire"]) {
        const result = pageNamesVendor(JOINSECRET_OFFERS_PAGE, vendor, {
          url: "https://www.joinsecret.com/offers",
        });
        assert.strictEqual(result.named, false, `${vendor} should not be found on the marketplace page`);
      }
    });

    it("does not name the vendors whose offers we source from a points programme", () => {
      for (const vendor of ["Aircall", "Carta", "Klaviyo"]) {
        const result = pageNamesVendor(BREX_REWARDS_PAGE, vendor, {
          url: "https://brex.com/rewards/",
        });
        assert.strictEqual(result.named, false, `${vendor} should not be found on the rewards page`);
      }
    });

    it("still names the company whose own page it is", () => {
      assert.strictEqual(pageNamesVendor(BREX_REWARDS_PAGE, "Brex", { url: "https://brex.com/rewards/" }).named, true);
    });
  });

  describe("a name the page spells differently", () => {
    it("reads a brand the page writes with a space", () => {
      const result = pageNamesVendor("Better Stack monitoring from $0", "BetterStack", {
        url: "https://betterstack.com/pricing",
      });
      assert.strictEqual(result.named, true);
    });

    it("reads a distinctive word of a multi-word name off a URL that names nobody", () => {
      const result = pageNamesVendor("1.1.1.1 — the free app that makes your Internet faster. Cloudflare", "Cloudflare WARP", {
        url: "https://one.one.one.one/",
      });
      assert.strictEqual(result.named, true);
      assert.strictEqual(result.via, "text");
    });

    it("will not read a short word of a multi-word name off a page about other companies", () => {
      const result = pageNamesVendor(BREX_REWARDS_PAGE, "Amazon AWS", { url: "https://brex.com/rewards/" });
      assert.strictEqual(result.named, false);
    });

    it("reads a product qualifier off a platform page", () => {
      const result = pageNamesVendor("Harness Pricing | Flexible Plans for DevOps", "Harness CI", {
        url: "https://www.harness.io/pricing",
      });
      assert.strictEqual(result.named, true);
    });
  });

  describe("evidence outside the page text", () => {
    it("accepts a page served from the vendor's own domain", () => {
      const result = pageNamesVendor("Sign in to continue", "PrefectCloud", {
        url: "https://www.prefect.io/",
      });
      assert.strictEqual(result.named, true);
      assert.strictEqual(result.via, "host");
    });

    it("accepts a name too short to search prose for when the host is exactly it", () => {
      const result = pageNamesVendor("Enable JavaScript to continue", "v0.dev", {
        url: "https://v0.app/",
      });
      assert.strictEqual(result.named, true);
      assert.strictEqual(result.via, "host");
    });

    it("accepts a host label that opens the stored name", () => {
      const result = pageNamesVendor("Secure email, calendar and contacts", "Tutanota", {
        url: "https://tuta.com/pricing",
      });
      assert.strictEqual(result.named, true);
      assert.strictEqual(result.via, "host");
    });

    it("accepts a vendor the URL path names", () => {
      const result = pageNamesVendor("Loading…", "SwaggerHub", {
        url: "https://swagger.io/tools/swaggerhub/pricing/",
      });
      assert.strictEqual(result.named, true);
      assert.strictEqual(result.via, "url");
    });

    it("refuses a host that merely shares a prefix with the stored name", () => {
      const result = pageNamesVendor("Free currency conversion API", "CurrencyScoop", {
        url: "https://currencybeacon.com/",
      });
      assert.strictEqual(result.named, false);
    });
  });

  describe("the forms we are willing to accept", () => {
    it("drops a product qualifier as a standalone form", () => {
      const forms = vendorNameForms("Harness CI");
      assert.ok(forms.includes("harness"));
      assert.ok(!forms.includes("ci"));
    });

    it("will not let a product qualifier match somebody else's domain", () => {
      const result = pageNamesVendor("IPFS pinning with 1 GB free storage", "Grafana Cloud", {
        url: "https://pinata.cloud/",
      });
      assert.strictEqual(result.named, false);
    });

    it("keeps the full name when every word is a qualifier", () => {
      const forms = vendorNameForms("C2 Object Storage");
      assert.ok(forms.includes("c2 object storage"));
    });

    it("reads a name written as a domain without its suffix", () => {
      const result = pageNamesVendor("Create beautiful images of your code with ray. Free.", "ray.so", {
        url: "https://dealmarket.example/offers",
      });
      assert.strictEqual(result.named, true);
      assert.strictEqual(result.via, "text");
    });

    it("does not find a name inside a longer word", () => {
      const result = pageNamesVendor("Free cartage on orders over $75", "Carta", {
        url: "https://dealmarket.example/offers",
      });
      assert.strictEqual(result.named, false);
    });

    it("reads a camelCase brand the page writes as two words, with no help from the URL", () => {
      const result = pageNamesVendor("Better Stack monitoring from $0", "BetterStack", {
        url: "https://dealmarket.example/offers",
      });
      assert.strictEqual(result.named, true);
      assert.strictEqual(result.via, "text");
    });
  });
});

describe("what a re-verification learned about the cited page", () => {
  const offer = { vendor: "Cloudways", url: "https://www.joinsecret.com/offers" };

  it("separates a page about somebody else from a page that says nothing", () => {
    const notNamed = classifySource(offer, { ok: true, text: JOINSECRET_OFFERS_PAGE }, 78);
    assert.strictEqual(notNamed.outcome, SOURCE_CHECK_NOT_NAMED);

    const noTerms = classifySource(
      { vendor: "Doczilla", url: "https://doczilla.app" },
      { ok: true, text: "Doczilla creates PDFs and screenshots." },
      0
    );
    assert.strictEqual(noTerms.outcome, SOURCE_CHECK_NO_TERMS);
  });

  it("records a fetch failure as its own outcome rather than as a naming verdict", () => {
    const result = classifySource(offer, { ok: false, error: "HTTP 503" }, 0);
    assert.strictEqual(result.outcome, SOURCE_CHECK_UNREADABLE);
    assert.match(result.detail, /503/);
  });

  it("passes a page that names the vendor and states terms", () => {
    const result = classifySource(
      { vendor: "Vercel", url: "https://vercel.com/pricing" },
      { ok: true, text: "Vercel Hobby plan, free forever. Pro is $20/month." },
      3
    );
    assert.strictEqual(result.outcome, SOURCE_CHECK_OK);
  });
});

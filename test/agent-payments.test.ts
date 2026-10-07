import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import type { ChildProcess } from "node:child_process";
import {
  BOTH_WITH_AN_UNSTATED_X402_COST,
  BUSIEST_CATEGORY,
  PAYMENT_LISTINGS,
  catalogueVendorsNamedIn,
  descriptionsOf,
  faqAnswers,
  json,
  mcpToolTexts,
  page,
  serviceRows,
  servedVendors,
  startServer,
  textOf,
  vendorsHolding,
  writeSyntheticCatalogue,
} from "./payment-protocol-fixture.ts";

const BADGE_LABEL: Record<string, string> = { x402: "x402", "stripe-mpp": "Stripe MPP" };

function badgesIn(cell: string): string[] {
  return [...cell.matchAll(/<span class="proto-badge ([^"]+)">([^<]*)<\/span>/g)].map(match => `${match[1]}:${match[2]}`);
}

function expectedBadges(protocols: readonly string[]): string[] {
  return protocols.map(protocol => `${protocol}:${BADGE_LABEL[protocol]}`);
}

function statValue(html: string, label: string): string | undefined {
  return html.match(new RegExp(`<div class="stat-value">([^<]*)</div><div class="stat-label">${label}</div>`))?.[1];
}

const holdingBoth = PAYMENT_LISTINGS.filter(listing => vendorsHolding([listing], "x402").length && vendorsHolding([listing], "stripe-mpp").length);

const holdingX402 = PAYMENT_LISTINGS.filter(listing => vendorsHolding([listing], "x402").length);

const MPP_METHODS_IN_STRIPES_WORDS = "cards through Shared Payment Tokens (SPTs) and stablecoins";

function namesIn(list: string): string[] {
  return list.split(/, | and /);
}

function withAFreeTier(listings: readonly (typeof PAYMENT_LISTINGS)[number][]): typeof listings {
  return listings.filter(listing => listing.tier === "Free");
}

describe("Agent Payments, on a catalogue whose payment listings are synthetic", () => {
  let scratch: ReturnType<typeof writeSyntheticCatalogue>;
  let server: { child: ChildProcess; base: string };

  before(async () => {
    scratch = writeSyntheticCatalogue();
    server = await startServer({ AGENTDEALS_INDEX_PATH: scratch.indexPath });
  });

  after(() => {
    server?.child.kill();
    scratch?.remove();
  });

  describe("GET /api/agent-payments", () => {
    it("counts and groups every listing with a payment entry", async () => {
      const body = await json(server.base, "/api/agent-payments");
      assert.strictEqual(body.total, PAYMENT_LISTINGS.length);
      assert.deepStrictEqual(servedVendors(body.services), vendorsHolding(PAYMENT_LISTINGS));
      assert.strictEqual(body.protocols.x402.count, vendorsHolding(PAYMENT_LISTINGS, "x402").length);
      assert.strictEqual(body.protocols["stripe-mpp"].count, vendorsHolding(PAYMENT_LISTINGS, "stripe-mpp").length);
      assert.strictEqual(body.protocols.both.count, holdingBoth.length);
      const grouped = Object.fromEntries(Object.entries(body.by_category).map(([category, services]) => [category, servedVendors(services as Array<{ vendor: string }>)]));
      const expected: Record<string, string[]> = {};
      for (const listing of PAYMENT_LISTINGS) expected[listing.category] = [...(expected[listing.category] ?? []), listing.vendor].sort();
      assert.deepStrictEqual(grouped, expected);
    });

    it("filters by protocol=x402", async () => {
      const body = await json(server.base, "/api/agent-payments?protocol=x402");
      assert.deepStrictEqual(servedVendors(body.services), vendorsHolding(PAYMENT_LISTINGS, "x402"));
      assert.strictEqual(body.total, body.services.length);
    });

    it("filters by protocol=stripe-mpp", async () => {
      const body = await json(server.base, "/api/agent-payments?protocol=stripe-mpp");
      assert.deepStrictEqual(servedVendors(body.services), vendorsHolding(PAYMENT_LISTINGS, "stripe-mpp"));
      assert.strictEqual(body.total, body.services.length);
    });

    it("filters by category", async () => {
      const body = await json(server.base, `/api/agent-payments?category=${encodeURIComponent(BUSIEST_CATEGORY)}`);
      const inCategory = PAYMENT_LISTINGS.filter(listing => listing.category === BUSIEST_CATEGORY);
      assert.deepStrictEqual(servedVendors(body.services), vendorsHolding(inCategory));
      assert.ok(inCategory.length < PAYMENT_LISTINGS.length, "every synthetic listing is in the filtered category, so the filter is not tested");
    });

    it("returns each service's details and the entries it holds", async () => {
      const body = await json(server.base, "/api/agent-payments");
      for (const listing of PAYMENT_LISTINGS) {
        const service = body.services.find((candidate: { vendor: string }) => candidate.vendor === listing.vendor);
        assert.ok(service, `${listing.vendor} is missing`);
        assert.strictEqual(service.category, listing.category);
        assert.strictEqual(service.tier, listing.tier);
        assert.strictEqual(service.description, listing.description);
        assert.strictEqual(service.url, listing.url);
        assert.ok("stability" in service, `${listing.vendor} is served without its stability field`);
        if (listing.tier === "Free") assert.ok(service.stability, `${listing.vendor} has no stability`);
        assert.deepStrictEqual(service.payment_protocols.map((entry: { protocol: string }) => entry.protocol), listing.payment_protocols!.map(entry => entry.protocol));
      }
    });

    it("returns empty result for non-matching protocol", async () => {
      const body = await json(server.base, "/api/agent-payments?protocol=bitcoin");
      assert.strictEqual(body.total, 0);
      assert.strictEqual(body.services.length, 0);
    });
  });

  describe("GET /agent-payments page", () => {
    it("returns 200 with HTML", async () => {
      const res = await fetch(`${server.base}/agent-payments`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers.get("content-type")?.includes("text/html"));
    });

    it("contains JSON-LD structured data", async () => {
      const html = await page(server.base, "/agent-payments");
      assert.ok(html.includes("application/ld+json"), "should have JSON-LD");
      assert.ok(html.includes("FAQPage"), "should have FAQ JSON-LD");
    });

    it("contains protocol comparison table", async () => {
      const html = await page(server.base, "/agent-payments");
      assert.ok(html.includes("Protocol Comparison"), "should have protocol comparison section");
    });

    it("lists every listing with a payment entry, with a badge for each protocol it holds", async () => {
      const rows = serviceRows(await page(server.base, "/agent-payments"));
      assert.deepStrictEqual([...rows.keys()].sort(), vendorsHolding(PAYMENT_LISTINGS));
      for (const listing of PAYMENT_LISTINGS) {
        assert.deepStrictEqual(badgesIn(rows.get(listing.vendor)![1]!), expectedBadges(listing.payment_protocols!.map(entry => entry.protocol)), listing.vendor);
      }
      assert.ok(holdingBoth.includes(BOTH_WITH_AN_UNSTATED_X402_COST), "no synthetic listing holds both protocols");
    });

    it("counts the listings by protocol", async () => {
      const counts = [PAYMENT_LISTINGS.length, vendorsHolding(PAYMENT_LISTINGS, "x402").length, vendorsHolding(PAYMENT_LISTINGS, "stripe-mpp").length, holdingBoth.length];
      assert.strictEqual(new Set(counts).size, counts.length, "two of the counts are equal, so a page printing one in the other's place would pass");
      const html = await page(server.base, "/agent-payments");
      assert.strictEqual(statValue(html, "Services indexed"), String(PAYMENT_LISTINGS.length));
      assert.strictEqual(statValue(html, "x402 services"), String(vendorsHolding(PAYMENT_LISTINGS, "x402").length));
      assert.strictEqual(statValue(html, "MPP services"), String(vendorsHolding(PAYMENT_LISTINGS, "stripe-mpp").length));
      assert.ok(
        html.includes(`${PAYMENT_LISTINGS.length} developer services accepting autonomous agent payments. ${vendorsHolding(PAYMENT_LISTINGS, "x402").length} via x402, ${vendorsHolding(PAYMENT_LISTINGS, "stripe-mpp").length} via Stripe MPP, ${holdingBoth.length} supporting both.`),
        "the count line does not match the listings",
      );
    });

    it("names in its x402 answer exactly the listings that hold an x402 entry", async () => {
      const answer = faqAnswers(await page(server.base, "/agent-payments")).get("Which developer services accept x402 payments?");
      const named = answer?.match(new RegExp(`^Currently ${holdingX402.length} developer services indexed on AgentDeals accept x402 payments: ([^.]*)\\.`))?.[1];
      assert.ok(named, `the answer does not count and list the x402 listings: ${answer}`);
      const alphabetical = vendorsHolding(PAYMENT_LISTINGS, "x402");
      assert.notDeepStrictEqual(holdingX402.map(listing => listing.vendor), alphabetical, "the synthetic x402 listings are catalogued alphabetically, so the answer's order is not tested");
      assert.deepStrictEqual(namesIn(named), alphabetical);
    });

    it("says how many of the x402 listings, and of all the listings, also offer a free tier", async () => {
      const free = withAFreeTier(holdingX402);
      assert.ok(free.length > 0 && free.length < holdingX402.length, "every x402 listing or none has a free tier, so the share is not tested");
      const html = await page(server.base, "/agent-payments");
      const answer = faqAnswers(html).get("Do x402 services still have free tiers?");
      const share = answer?.match(/^Not all\. (\d+) of the (\d+) x402-enabled services indexed here also offer a free tier: ([^.]*)\./);
      assert.ok(share, `the answer does not give the share of x402 listings with a free tier: ${answer}`);
      assert.deepStrictEqual([Number(share[1]), Number(share[2])], [free.length, holdingX402.length]);
      assert.deepStrictEqual(namesIn(share[3]!), vendorsHolding(free));
      const freeOfAll = withAFreeTier(PAYMENT_LISTINGS);
      assert.notStrictEqual(freeOfAll.length, free.length, "the two shares count the same listings, so one printed in the other's place would pass");
      assert.ok(
        html.includes(`<li><strong>Free tier fallback.</strong> ${freeOfAll.length} of the ${PAYMENT_LISTINGS.length} services listed here also offer a free tier.`),
        "the free tier fallback does not count the payment listings with a free tier",
      );
    });

    it("states MPP's payment methods in the words of Stripe's docs", async () => {
      const html = await page(server.base, "/agent-payments");
      const mppSection = html.match(/<p class="proto-desc">Stripe&rsquo;s Machine Payments Protocol[\s\S]*?<\/p>/)?.[0];
      assert.ok(mppSection?.includes(`Agents pay with a variety of payment methods, including ${MPP_METHODS_IN_STRIPES_WORDS}.`), `the MPP section: ${mppSection}`);
      const answer = faqAnswers(html).get("How do AI agents pay for services autonomously?");
      assert.ok(answer?.includes(`With MPP, agents pay with a variety of payment methods, including ${MPP_METHODS_IN_STRIPES_WORDS}.`), answer);
      assert.ok(html.includes("<tr><td>Account required</td><td>No &mdash; wallet only</td><td>No &mdash; a card through a Shared Payment Token, or a stablecoin wallet</td></tr>"), "the comparison table does not say what an MPP payment needs");
      assert.ok(!/managed wallet/i.test(html), "the page still says agents pay MPP from a managed wallet");
    });

    it("dates x402 to Coinbase's launch in May 2025, not the Linux Foundation's of April 2026", async () => {
      const html = await page(server.base, "/agent-payments");
      assert.ok(html.includes('<div class="proto-meta"><span>Coinbase</span><span>Launched May 2025</span><span>Linux Foundation since April 2026</span></div>'), "the x402 section does not date the protocol's launch");
      assert.ok(html.includes("<tr><td>Launched</td><td>May 2025</td><td>March 2026</td></tr>"), "the comparison table does not date x402's launch");
      assert.ok(!html.includes("Launched April 2026"), "the page dates x402's launch to April 2026");
      const answer = faqAnswers(html).get("What is the x402 payment protocol?");
      assert.ok(answer?.includes("Coinbase launched it in May 2025 and contributed it in April 2026 to the x402 Foundation"), answer);
    });
  });

  describe("both payment pages", () => {
    for (const route of ["/agent-payments", "/x402-services"]) {
      it(`${route} prints no industry-wide count of services or integrations`, async () => {
        const html = await page(server.base, route);
        const otherGuides = html.indexOf('<div class="more-guides"');
        assert.ok(otherGuides > 0, `${route} lost its list of other guides, whose blurbs this check skips`);
        const served = textOf(html.slice(0, otherGuides));
        assert.ok(served.includes("x402") && served.includes("Frequently Asked Questions"), `${route} served no text to check`);
        assert.deepStrictEqual(served.match(/\d[\d,]*\+\s*(?:services|integrations)\b|industry-wide/gi), null);
      });

      it(`${route} names no listing in its descriptions`, async () => {
        const descriptions = descriptionsOf(await page(server.base, route));
        assert.ok(descriptions.length >= 3, `${route} has ${descriptions.length} descriptions, expected its meta, Open Graph and JSON-LD ones`);
        for (const description of descriptions) {
          assert.deepStrictEqual(catalogueVendorsNamedIn(description, Object.values(BADGE_LABEL)), [], description);
        }
      });
    }
  });

  describe("MCP search_deals payment_protocol filter", () => {
    it("returns every listing with an entry for the protocol asked for, and no other", async () => {
      const [x402, mpp] = await mcpToolTexts(server.base, [
        { name: "search_deals", arguments: { payment_protocol: "x402" } },
        { name: "search_deals", arguments: { payment_protocol: "stripe-mpp" } },
      ]);
      assert.deepStrictEqual(servedVendors(JSON.parse(x402![0]!).results), vendorsHolding(PAYMENT_LISTINGS, "x402"));
      assert.deepStrictEqual(servedVendors(JSON.parse(mpp![0]!).results), vendorsHolding(PAYMENT_LISTINGS, "stripe-mpp"));
    });
  });
});

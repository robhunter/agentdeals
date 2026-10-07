import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import type { ChildProcess } from "node:child_process";
import {
  BOTH_WITH_AN_UNSTATED_X402_COST,
  MPP_WITHOUT_A_SOURCE,
  PAYMENT_LISTINGS,
  SHIPPED_OFFERS,
  STATED_MPP_COST,
  STATED_X402_COST,
  UNSOURCED_MPP_COST,
  UNSTATED_X402_COST,
  X402_WITH_A_STATED_COST,
  X402_WITHOUT_A_COST,
  json,
  mcpToolTexts,
  page,
  serviceCards,
  serviceRows,
  servedVendors,
  startServer,
  textOf,
  vendorsHolding,
  writeSyntheticCatalogue,
} from "./payment-protocol-fixture.ts";

const { sourceStatesTheCost, withPaymentCostsTheirSourcesState } = await import("../dist/payment-protocols.js");

type Offer = import("../src/types.ts").Offer;
type PaymentProtocol = import("../src/types.ts").PaymentProtocol;

function itemList(html: string): { numberOfItems: number; names: string[] } {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1]!));
  const list = blocks.find(block => block["@type"] === "ItemList");
  assert.ok(list, "the page carries no ItemList");
  return { numberOfItems: list.numberOfItems, names: list.itemListElement.map((item: { name: string }) => item.name).sort() };
}

const COSTED_ENTRY: PaymentProtocol = {
  protocol: "x402",
  chain: "Zqchain",
  settlement: "Zqcoin",
  pricing_model: "per-request",
  example_cost: "$0.05 per scrape",
  source_url: "https://costed.example/x402",
  source_quote: "Each scrape costs $0.05 per scrape in Zqcoin.",
};

function listingHolding(...entries: PaymentProtocol[]): Offer {
  return { ...X402_WITH_A_STATED_COST, payment_protocols: entries };
}

describe("a payment entry's cost is published only where its source quote states it", () => {
  it("keeps a cost its source quote contains", () => {
    assert.strictEqual(sourceStatesTheCost(COSTED_ENTRY), true);
    assert.deepStrictEqual(withPaymentCostsTheirSourcesState(listingHolding(COSTED_ENTRY)).payment_protocols, [COSTED_ENTRY]);
  });

  it("reads a cost and a quote that differ only in their spacing as the same", () => {
    const entry = { ...COSTED_ENTRY, source_quote: "Each scrape costs $0.05 per\n  scrape in Zqcoin." };
    assert.strictEqual(sourceStatesTheCost(entry), true);
  });

  it("drops a cost its source quote does not contain and keeps every other field", () => {
    const entry = { ...COSTED_ENTRY, example_cost: "$0.01-0.05/scrape" };
    const { example_cost: _dropped, ...kept } = entry;
    assert.strictEqual(sourceStatesTheCost(entry), false);
    assert.deepStrictEqual(withPaymentCostsTheirSourcesState(listingHolding(entry)).payment_protocols, [kept]);
  });

  it("drops a cost from an entry that has no source quote", () => {
    const { source_url: _url, source_quote: _quote, ...unsourced } = COSTED_ENTRY;
    const { example_cost: _dropped, ...kept } = unsourced;
    assert.strictEqual(sourceStatesTheCost(unsourced), false);
    assert.deepStrictEqual(withPaymentCostsTheirSourcesState(listingHolding(unsourced)).payment_protocols, [kept]);
  });

  it("drops an empty cost, which every quote would otherwise contain", () => {
    const entry = { ...COSTED_ENTRY, example_cost: "  " };
    const { example_cost: _dropped, ...kept } = entry;
    assert.strictEqual(sourceStatesTheCost(entry), false);
    assert.deepStrictEqual(withPaymentCostsTheirSourcesState(listingHolding(entry)).payment_protocols, [kept]);
  });

  it("judges each entry of a listing on its own quote", () => {
    const unstated = { ...COSTED_ENTRY, protocol: "stripe-mpp", example_cost: "$0.09 per session" };
    const { example_cost: _dropped, ...kept } = unstated;
    assert.deepStrictEqual(withPaymentCostsTheirSourcesState(listingHolding(COSTED_ENTRY, unstated)).payment_protocols, [COSTED_ENTRY, kept]);
  });

  it("returns a listing with nothing to drop as it was", () => {
    const { example_cost: _none, ...costless } = COSTED_ENTRY;
    for (const listing of [listingHolding(COSTED_ENTRY), listingHolding(costless), SHIPPED_OFFERS.find(offer => !offer.payment_protocols)!]) {
      assert.strictEqual(withPaymentCostsTheirSourcesState(listing), listing);
    }
  });
});

describe("payment protocol filters and pages, on a catalogue whose payment listings are synthetic", () => {
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

  it("GET /api/offers?payment_protocol=x402 returns every listing with an x402 entry and no other", async () => {
    const data = await json(server.base, "/api/offers?payment_protocol=x402&limit=100");
    assert.deepStrictEqual(servedVendors(data.offers), vendorsHolding(PAYMENT_LISTINGS, "x402"));
    assert.strictEqual(data.total, vendorsHolding(PAYMENT_LISTINGS, "x402").length);
  });

  it("GET /api/offers?payment_protocol=stripe-mpp returns every listing with a Stripe MPP entry and no other", async () => {
    const data = await json(server.base, "/api/offers?payment_protocol=stripe-mpp&limit=100");
    assert.deepStrictEqual(servedVendors(data.offers), vendorsHolding(PAYMENT_LISTINGS, "stripe-mpp"));
    assert.strictEqual(data.total, vendorsHolding(PAYMENT_LISTINGS, "stripe-mpp").length);
  });

  it("GET /api/offers without payment_protocol also returns listings that hold no payment entry", async () => {
    const everything = await json(server.base, "/api/offers?limit=1");
    const x402 = await json(server.base, "/api/offers?payment_protocol=x402&limit=1");
    const mpp = await json(server.base, "/api/offers?payment_protocol=stripe-mpp&limit=1");
    assert.ok(everything.total > x402.total + mpp.total, `unfiltered ${everything.total}, x402 ${x402.total}, stripe-mpp ${mpp.total}`);
  });

  it("GET /x402-services lists every listing with an x402 entry, in its table, its cards and its ItemList", async () => {
    const html = await page(server.base, "/x402-services");
    const expected = vendorsHolding(PAYMENT_LISTINGS, "x402");
    assert.ok(html.includes("x402 Payment Protocol"), "the page lost its title");
    assert.deepStrictEqual([...serviceRows(html).keys()].sort(), expected);
    assert.deepStrictEqual([...serviceCards(html).keys()].sort(), expected);
    assert.deepStrictEqual(itemList(html), { numberOfItems: expected.length, names: expected });
  });

  it("GET /x402-services prints the cost a source quote states, and a dash where the quote states none", async () => {
    const html = await page(server.base, "/x402-services");
    const rows = serviceRows(html);
    const cards = serviceCards(html);
    assert.strictEqual(textOf(rows.get(X402_WITH_A_STATED_COST.vendor)![2]!), STATED_X402_COST);
    assert.ok(cards.get(X402_WITH_A_STATED_COST.vendor)!.includes(`<span class="cost-tag">${STATED_X402_COST}</span>`), "the card lost the stated cost");
    for (const listing of [BOTH_WITH_AN_UNSTATED_X402_COST, X402_WITHOUT_A_COST]) {
      assert.strictEqual(textOf(rows.get(listing.vendor)![2]!), "—", listing.vendor);
      assert.ok(!cards.get(listing.vendor)!.includes("cost-tag"), `${listing.vendor}'s card prints a cost tag with no stated cost`);
    }
    assert.ok(!html.includes(UNSTATED_X402_COST), "the page prints a cost its source does not state");
  });

  it("GET /x402-services prints each x402 listing's chain and settlement", async () => {
    const rows = serviceRows(await page(server.base, "/x402-services"));
    for (const listing of PAYMENT_LISTINGS) {
      const entry = listing.payment_protocols!.find(candidate => candidate.protocol === "x402");
      if (!entry) continue;
      assert.strictEqual(textOf(rows.get(listing.vendor)![3]!), `${entry.chain} / ${entry.settlement}`);
    }
  });

  it("serves each entry's source with it, and no cost its source does not state, on the APIs and MCP", async () => {
    const routes = [
      "/api/offers?payment_protocol=x402&limit=100",
      "/api/offers?payment_protocol=stripe-mpp&limit=100",
      "/api/agent-payments",
      ...PAYMENT_LISTINGS.map(listing => `/api/details/${encodeURIComponent(listing.vendor)}`),
      `/api/compare?a=${encodeURIComponent(X402_WITH_A_STATED_COST.vendor)}&b=${encodeURIComponent(BOTH_WITH_AN_UNSTATED_X402_COST.vendor)}`,
    ];
    const surfaces: Array<{ surface: string; body: string }> = [];
    for (const route of routes) surfaces.push({ surface: route, body: JSON.stringify(await json(server.base, route)) });
    const calls = [
      { name: "search_deals", arguments: { payment_protocol: "x402" } },
      { name: "search_deals", arguments: { payment_protocol: "stripe-mpp" } },
      ...PAYMENT_LISTINGS.map(listing => ({ name: "search_deals", arguments: { vendor: listing.vendor } })),
      { name: "compare_vendors", arguments: { vendors: [X402_WITH_A_STATED_COST.vendor, BOTH_WITH_AN_UNSTATED_X402_COST.vendor] } },
    ];
    const answers = await mcpToolTexts(server.base, calls);
    calls.forEach((call, at) => surfaces.push({ surface: `${call.name} ${JSON.stringify(call.arguments)}`, body: answers[at]!.join("\n") }));

    for (const { surface, body } of surfaces) {
      assert.ok(body.includes("Zqpay"), `${surface} names none of the synthetic listings, so it checks nothing`);
      assert.ok(!body.includes(UNSTATED_X402_COST), `${surface} serves a cost its source does not state`);
      assert.ok(!body.includes(UNSOURCED_MPP_COST), `${surface} serves a cost from an entry with no source`);
      for (const listing of PAYMENT_LISTINGS) {
        if (!body.includes(listing.vendor)) continue;
        for (const entry of listing.payment_protocols!.filter(sourced => sourced.source_url !== undefined)) {
          assert.ok(body.includes(entry.source_url!), `${surface} serves ${listing.vendor} without the source of its ${entry.protocol} entry`);
          assert.ok(body.includes(JSON.stringify(entry.source_quote!).slice(1, -1)), `${surface} serves ${listing.vendor} without the quote of its ${entry.protocol} entry`);
        }
      }
      if (body.includes(X402_WITH_A_STATED_COST.vendor)) assert.ok(body.includes(STATED_X402_COST), `${surface} drops a cost its source states`);
      if (body.includes(BOTH_WITH_AN_UNSTATED_X402_COST.vendor)) assert.ok(body.includes(STATED_MPP_COST), `${surface} drops a Stripe MPP cost its source states`);
    }
    assert.ok(surfaces.some(({ body }) => body.includes(MPP_WITHOUT_A_SOURCE.vendor)), "no surface served the listing whose entry has no source");
  });

  it("GET /agent-payments and /x402-services are in the sitemap", async () => {
    const xml = await page(server.base, "/sitemap-pages.xml");
    assert.ok(xml.includes("/agent-payments"), "the sitemap lost /agent-payments");
    assert.ok(xml.includes("/x402-services"), "the sitemap lost /x402-services");
  });
});

describe("on the shipped catalogue, each payment surface lists exactly the listings that hold an entry", () => {
  let server: { child: ChildProcess; base: string };

  before(async () => {
    server = await startServer();
  });

  after(() => {
    server?.child.kill();
  });

  it("the APIs, /x402-services and /agent-payments agree with the catalogue", async () => {
    const x402 = vendorsHolding(SHIPPED_OFFERS, "x402");
    const mpp = vendorsHolding(SHIPPED_OFFERS, "stripe-mpp");
    const all = vendorsHolding(SHIPPED_OFFERS);
    assert.deepStrictEqual(servedVendors((await json(server.base, "/api/offers?payment_protocol=x402&limit=5000")).offers), x402);
    assert.deepStrictEqual(servedVendors((await json(server.base, "/api/offers?payment_protocol=stripe-mpp&limit=5000")).offers), mpp);
    assert.deepStrictEqual(servedVendors((await json(server.base, "/api/agent-payments")).services), all);
    assert.deepStrictEqual([...serviceRows(await page(server.base, "/x402-services")).keys()].sort(), x402);
    assert.deepStrictEqual([...serviceRows(await page(server.base, "/agent-payments")).keys()].sort(), all);
  });

  it("serves a cost with a shipped entry only where the entry's source quote holds it", async () => {
    const served = (await json(server.base, "/api/agent-payments")).services as Array<{ vendor: string; payment_protocols: PaymentProtocol[] }>;
    const shipped = new Map(SHIPPED_OFFERS.filter(offer => offer.payment_protocols).map(offer => [offer.vendor, offer.payment_protocols!]));
    for (const service of served) {
      service.payment_protocols.forEach((entry, at) => {
        const stored = shipped.get(service.vendor)![at]!;
        assert.strictEqual(entry.example_cost, sourceStatesTheCost(stored) ? stored.example_cost : undefined, `${service.vendor}'s ${entry.protocol} cost`);
      });
    }
  });
});

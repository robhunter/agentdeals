import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import type { ChildProcess } from "node:child_process";
import {
  BOTH_WITH_AN_UNSTATED_X402_COST,
  BUSIEST_CATEGORY,
  PAYMENT_LISTINGS,
  json,
  mcpToolTexts,
  page,
  serviceRows,
  servedVendors,
  startServer,
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
        assert.ok(service.stability, `${listing.vendor} has no stability`);
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

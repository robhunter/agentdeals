import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startLocalApi } from "./local-api.ts";

it("reading alphabetical vendors preserves the catalogue and subsequent HTTP responses", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "vendors-order-"));
  const previous = process.env.AGENTDEALS_INDEX_PATH;
  const indexPath = path.join(dir, "index.json");
  const vendors = ["Zqzulu", "Zqcharlie", "Zqalpha", "Zqbravo"];
  const offers = vendors.map(vendor => ({
    vendor,
    category: "Databases",
    tier: "Free",
    description: "Free managed database with 1 GB storage.",
    url: `https://${vendor.toLowerCase()}.example/pricing`,
    verifiedDate: new Date().toISOString().slice(0, 10),
    tags: ["databases"],
    product_subtypes: {
      taxonomy: "Databases",
      labels: [{ subtype: "relational", source_url: `https://${vendor.toLowerCase()}.example/pricing`, source_quote: "Managed relational database." }],
      reviewed: new Date().toISOString().slice(0, 10),
    },
  }));
  writeFileSync(indexPath, JSON.stringify({ offers }));
  process.env.AGENTDEALS_INDEX_PATH = indexPath;
  const client = new Client({ name: "vendors-order-test", version: "1" });
  const memoryClient = new Client({ name: "vendors-cache-test", version: "1" });
  let api: Awaited<ReturnType<typeof startLocalApi>> | undefined;
  try {
    await t.test("preserves loadOffers cache order", async () => {
      const { loadOffers } = await import("../dist/data.js");
      const { createServer } = await import("../dist/server.js");
      const cached = loadOffers();
      const original = JSON.stringify(cached);
      const server = createServer();
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await memoryClient.connect(clientTransport);
      try {
        await memoryClient.readResource({ uri: "agentdeals://vendors" });
        assert.equal(loadOffers(), cached);
        assert.equal(JSON.stringify(loadOffers()), original, "resource read preserves cached catalogue bytes");
      } finally {
        await memoryClient.close();
        await server.close();
      }

    });

    api = await startLocalApi();
    await client.connect(new StreamableHTTPClientTransport(new URL(`${api.url}/mcp`)));
    const routes = ["/api/offers?limit=5000", "/vendor/zqzulu"];
    const before = new Map<string, string>();
    for (const route of routes) {
      const response = await fetch(api.url + route);
      assert.equal(response.status, 200, route);
      before.set(route, await response.text());
    }
    const listed = JSON.parse(before.get(routes[0])!).offers.map((offer: { vendor: string }) => offer.vendor);
    assert.deepEqual(listed, vendors, "fixture starts in catalogue order");
    const vendorPage = before.get(routes[1])!;
    for (const vendor of vendors.slice(1)) assert.ok(vendorPage.includes(vendor), vendor);

    for (let read = 0; read < 2; read++) {
      const resource = await client.readResource({ uri: "agentdeals://vendors" });
      assert.equal(resource.contents.length, 1);
      const text = resource.contents[0].text as string;
      assert.deepEqual([...text.matchAll(/^- \*\*(.*?)\*\*/gm)].map(match => match[1]), [...vendors].sort((a, b) => a.localeCompare(b)));
      for (const route of routes) {
        await t.test(`read ${read + 1} preserves ${route}`, async () => {
          const response = await fetch(api!.url + route);
          assert.equal(response.status, 200, route);
          assert.equal(await response.text(), before.get(route), route);
        });
      }
    }
  } finally {
    await client.close();
    api?.stop();
    if (previous === undefined) delete process.env.AGENTDEALS_INDEX_PATH;
    else process.env.AGENTDEALS_INDEX_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

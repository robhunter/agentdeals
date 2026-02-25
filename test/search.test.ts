import { describe, it } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function sendMcpMessages(
  serverProcess: ReturnType<typeof spawn>,
  messages: object[]
): Promise<object[]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout")), 5000);
    const responses: object[] = [];
    let buffer = "";
    const expectedResponses = messages.filter(
      (m: any) => m.id !== undefined
    ).length;

    const onData = (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          try {
            responses.push(JSON.parse(line.trim()));
            if (responses.length >= expectedResponses) {
              clearTimeout(timeout);
              serverProcess.stdout!.off("data", onData);
              resolve(responses);
            }
          } catch {
            // not valid JSON yet
          }
        }
      }
    };

    serverProcess.stdout!.on("data", onData);
    for (const msg of messages) {
      serverProcess.stdin!.write(JSON.stringify(msg) + "\n");
    }
  });
}

const INIT_MESSAGES = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
];

function startServer() {
  const serverPath = path.join(__dirname, "..", "dist", "index.js");
  return spawn("node", [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("search_offers tool", () => {
  it("returns results matching a keyword query", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search_offers", arguments: { query: "postgres" } },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);
      const offers = body.results;

      assert.ok(Array.isArray(offers));
      assert.ok(offers.length >= 2);
      assert.strictEqual(body.total, offers.length);
      for (const offer of offers) {
        const searchable = [offer.vendor, offer.description, ...offer.tags]
          .join(" ")
          .toLowerCase();
        assert.ok(searchable.includes("postgres"));
      }
    } finally {
      proc.kill();
    }
  });

  it("filters by category", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_offers",
            arguments: { category: "Databases" },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);
      const offers = body.results;

      assert.ok(Array.isArray(offers));
      assert.ok(offers.length >= 2);
      assert.strictEqual(body.total, offers.length);
      for (const offer of offers) {
        assert.strictEqual(offer.category, "Databases");
      }
    } finally {
      proc.kill();
    }
  });

  it("returns empty array for non-matching query", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_offers",
            arguments: { query: "nonexistent-xyz-123" },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);

      assert.ok(Array.isArray(body.results));
      assert.strictEqual(body.results.length, 0);
      assert.strictEqual(body.total, 0);
    } finally {
      proc.kill();
    }
  });

  it("paginates with limit and offset", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_offers",
            arguments: { limit: 5, offset: 0 },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);

      assert.strictEqual(body.results.length, 5);
      assert.strictEqual(body.limit, 5);
      assert.strictEqual(body.offset, 0);
      assert.ok(body.total >= 5);
    } finally {
      proc.kill();
    }
  });

  it("paginates with offset beyond results", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_offers",
            arguments: { limit: 10, offset: 99999 },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);

      assert.strictEqual(body.results.length, 0);
      assert.strictEqual(body.offset, 99999);
      assert.ok(body.total > 0);
    } finally {
      proc.kill();
    }
  });

  it("paginates with category filter", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_offers",
            arguments: { category: "Databases", limit: 2, offset: 0 },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);

      assert.strictEqual(body.results.length, 2);
      assert.ok(body.total >= 2);
      for (const offer of body.results) {
        assert.strictEqual(offer.category, "Databases");
      }
    } finally {
      proc.kill();
    }
  });

  it("returns all results when no limit/offset provided", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_offers",
            arguments: {},
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);

      assert.strictEqual(body.results.length, body.total);
      assert.ok(body.total >= 100);
      assert.strictEqual(body.offset, 0);
    } finally {
      proc.kill();
    }
  });

  it("each offer has required fields", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_offers",
            arguments: { query: "free" },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);
      const offers = body.results;

      assert.ok(offers.length > 0);
      for (const offer of offers) {
        assert.ok(typeof offer.vendor === "string");
        assert.ok(typeof offer.description === "string");
        assert.ok(typeof offer.tier === "string");
        assert.ok(typeof offer.url === "string");
        assert.ok(typeof offer.verifiedDate === "string");
      }
    } finally {
      proc.kill();
    }
  });
});

describe("eligibility filtering", () => {
  it("filters by eligibility_type=accelerator", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_offers",
            arguments: { eligibility_type: "accelerator" },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);
      const offers = body.results;

      assert.ok(offers.length >= 5);
      for (const offer of offers) {
        assert.ok(offer.eligibility);
        assert.strictEqual(offer.eligibility.type, "accelerator");
      }
    } finally {
      proc.kill();
    }
  });

  it("filters by eligibility_type=oss", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_offers",
            arguments: { eligibility_type: "oss" },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);
      const offers = body.results;

      assert.ok(offers.length >= 3);
      for (const offer of offers) {
        assert.ok(offer.eligibility);
        assert.strictEqual(offer.eligibility.type, "oss");
        assert.ok(Array.isArray(offer.eligibility.conditions));
        assert.ok(typeof offer.eligibility.program === "string");
      }
    } finally {
      proc.kill();
    }
  });

  it("filters by eligibility_type=fintech", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_offers",
            arguments: { eligibility_type: "fintech" },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);
      const offers = body.results;

      assert.ok(offers.length >= 5);
      for (const offer of offers) {
        assert.ok(offer.eligibility);
        assert.strictEqual(offer.eligibility.type, "fintech");
      }
    } finally {
      proc.kill();
    }
  });

  it("returns all offers when eligibility_type is omitted (backwards compatible)", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_offers",
            arguments: {},
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);

      assert.ok(body.total >= 115);
      const withElig = body.results.filter((o: any) => o.eligibility);
      const withoutElig = body.results.filter((o: any) => !o.eligibility);
      assert.ok(withElig.length >= 15);
      assert.ok(withoutElig.length >= 100);
    } finally {
      proc.kill();
    }
  });

  it("combines eligibility_type with category filter", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_offers",
            arguments: { eligibility_type: "accelerator", category: "Analytics" },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);
      const offers = body.results;

      assert.ok(offers.length >= 3);
      for (const offer of offers) {
        assert.strictEqual(offer.eligibility.type, "accelerator");
        assert.strictEqual(offer.category, "Analytics");
      }
    } finally {
      proc.kill();
    }
  });
});

describe("search sorting", () => {
  it("sorts by vendor name alphabetically", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_offers",
            arguments: { sort: "vendor", limit: 10 },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);
      const vendors = body.results.map((o: any) => o.vendor);

      for (let i = 1; i < vendors.length; i++) {
        assert.ok(
          vendors[i - 1].localeCompare(vendors[i]) <= 0,
          `${vendors[i - 1]} should come before ${vendors[i]}`
        );
      }
    } finally {
      proc.kill();
    }
  });

  it("sorts by category then vendor", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_offers",
            arguments: { sort: "category", limit: 20 },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);
      const results = body.results;

      for (let i = 1; i < results.length; i++) {
        const catCmp = results[i - 1].category.localeCompare(results[i].category);
        if (catCmp === 0) {
          assert.ok(
            results[i - 1].vendor.localeCompare(results[i].vendor) <= 0,
            `Within ${results[i].category}: ${results[i - 1].vendor} should come before ${results[i].vendor}`
          );
        } else {
          assert.ok(catCmp < 0, `${results[i - 1].category} should come before ${results[i].category}`);
        }
      }
    } finally {
      proc.kill();
    }
  });

  it("sorts by newest verified date first", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_offers",
            arguments: { sort: "newest", limit: 10 },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);
      const dates = body.results.map((o: any) => o.verifiedDate);

      for (let i = 1; i < dates.length; i++) {
        assert.ok(
          dates[i - 1] >= dates[i],
          `${dates[i - 1]} should be >= ${dates[i]} (newest first)`
        );
      }
    } finally {
      proc.kill();
    }
  });

  it("preserves index order when sort is omitted", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_offers",
            arguments: { limit: 3 },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);
      // First entry in index is Vercel
      assert.strictEqual(body.results[0].vendor, "Vercel");
    } finally {
      proc.kill();
    }
  });

  it("sorting works with pagination", async () => {
    const proc = startServer();
    try {
      // Get first page sorted by vendor
      const responses1 = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_offers",
            arguments: { sort: "vendor", limit: 5, offset: 0 },
          },
        },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "search_offers",
            arguments: { sort: "vendor", limit: 5, offset: 5 },
          },
        },
      ])) as any[];

      const page1 = JSON.parse((responses1.find((r: any) => r.id === 2) as any).result.content[0].text);
      const page2 = JSON.parse((responses1.find((r: any) => r.id === 3) as any).result.content[0].text);

      // Last vendor on page 1 should come before first vendor on page 2
      const lastPage1 = page1.results[page1.results.length - 1].vendor;
      const firstPage2 = page2.results[0].vendor;
      assert.ok(
        lastPage1.localeCompare(firstPage2) <= 0,
        `Page 1 last (${lastPage1}) should come before page 2 first (${firstPage2})`
      );
    } finally {
      proc.kill();
    }
  });
});

describe("get_offer_details with eligibility", () => {
  it("includes eligibility in response for conditional deals", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "get_offer_details", arguments: { vendor: "JetBrains" } },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      assert.ok(!result.result.isError);
      const offer = JSON.parse(result.result.content[0].text);

      assert.strictEqual(offer.vendor, "JetBrains");
      assert.ok(offer.eligibility);
      assert.strictEqual(offer.eligibility.type, "oss");
      assert.ok(Array.isArray(offer.eligibility.conditions));
      assert.ok(offer.eligibility.conditions.length > 0);
      assert.strictEqual(offer.eligibility.program, "JetBrains Open Source Licenses");
    } finally {
      proc.kill();
    }
  });
});

describe("get_offer_details tool", () => {
  it("returns full details for exact vendor match", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "get_offer_details", arguments: { vendor: "Neon" } },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      assert.ok(!result.result.isError);
      const offer = JSON.parse(result.result.content[0].text);

      assert.strictEqual(offer.vendor, "Neon");
      assert.strictEqual(offer.category, "Databases");
      assert.ok(typeof offer.description === "string");
      assert.ok(typeof offer.url === "string");
      assert.ok(Array.isArray(offer.tags));
      assert.ok(Array.isArray(offer.relatedVendors));
      assert.ok(offer.relatedVendors.length > 0);
      assert.ok(!offer.relatedVendors.includes("Neon"));
    } finally {
      proc.kill();
    }
  });

  it("matches vendor name case-insensitively", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "get_offer_details", arguments: { vendor: "nEoN" } },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      assert.ok(!result.result.isError);
      const offer = JSON.parse(result.result.content[0].text);
      assert.strictEqual(offer.vendor, "Neon");
    } finally {
      proc.kill();
    }
  });

  it("returns error with suggestions for unknown vendor", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "get_offer_details", arguments: { vendor: "Cloud" } },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      assert.ok(result.result.isError);
      const text = result.result.content[0].text;
      assert.ok(text.includes("not found"));
      assert.ok(text.includes("Did you mean"));
    } finally {
      proc.kill();
    }
  });

  it("returns error with no suggestions for completely unknown vendor", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "get_offer_details", arguments: { vendor: "zzzznonexistent99999" } },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      assert.ok(result.result.isError);
      const text = result.result.content[0].text;
      assert.ok(text.includes("not found"));
      assert.ok(text.includes("No similar vendors found"));
    } finally {
      proc.kill();
    }
  });
});

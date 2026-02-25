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

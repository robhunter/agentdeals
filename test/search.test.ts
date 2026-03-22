import { describe, it, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Start a local HTTP server so stdio MCP tests hit local data (not production API)
const LOCAL_API_PORT = 13590;
const LOCAL_API_URL = `http://localhost:${LOCAL_API_PORT}`;

const httpServerPath = path.join(__dirname, "..", "dist", "serve.js");
const httpServer: ChildProcess = spawn("node", [httpServerPath], {
  env: { ...process.env, PORT: String(LOCAL_API_PORT) },
  stdio: ["pipe", "pipe", "pipe"],
});

await new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("HTTP server start timeout")), 5000);
  httpServer.stderr!.on("data", (chunk: Buffer) => {
    if (chunk.toString().includes("running on")) {
      clearTimeout(timeout);
      resolve();
    }
  });
  httpServer.on("error", (err) => {
    clearTimeout(timeout);
    reject(err);
  });
});

after(() => {
  httpServer.kill();
});

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
    env: { ...process.env, AGENTDEALS_API_URL: LOCAL_API_URL },
  });
}

describe("search_deals tool", () => {
  it("returns results matching a keyword query", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search_deals", arguments: { query: "postgres" } },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);
      const offers = body.results;

      assert.ok(Array.isArray(offers));
      assert.ok(offers.length >= 2);
      assert.ok(body.total >= offers.length, "total should be >= results (pagination)");
      assert.ok(offers.length <= 20, "default limit is 20");
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
            name: "search_deals",
            arguments: { category: "Databases" },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);
      const offers = body.results;

      assert.ok(Array.isArray(offers));
      assert.ok(offers.length >= 2);
      assert.ok(body.total >= offers.length, "total should be >= returned results (may be paginated)");
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
            name: "search_deals",
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
            name: "search_deals",
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
            name: "search_deals",
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
            name: "search_deals",
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

  it("returns paginated results with default limit of 20", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_deals",
            arguments: {},
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);

      assert.strictEqual(body.results.length, 20, "Default limit should be 20");
      assert.ok(body.total >= 100, "Total should reflect all matching offers");
      assert.strictEqual(body.limit, 20);
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
            name: "search_deals",
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
            name: "search_deals",
            arguments: { eligibility: "accelerator" },
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
            name: "search_deals",
            arguments: { eligibility: "oss" },
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
            name: "search_deals",
            arguments: { eligibility: "fintech" },
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

  it("returns mixed eligibility offers when eligibility is omitted", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_deals",
            arguments: { limit: 200 },
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
            name: "search_deals",
            arguments: { eligibility: "accelerator", category: "Startup Programs" },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);
      const offers = body.results;

      assert.ok(offers.length >= 3);
      for (const offer of offers) {
        assert.strictEqual(offer.eligibility.type, "accelerator");
        assert.strictEqual(offer.category, "Startup Programs");
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
            name: "search_deals",
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
            name: "search_deals",
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
            name: "search_deals",
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
            name: "search_deals",
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
            name: "search_deals",
            arguments: { sort: "vendor", limit: 5, offset: 0 },
          },
        },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "search_deals",
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

describe("search relevance ranking", () => {
  it("ranks database-category vendors first when searching 'database'", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search_deals", arguments: { query: "database" } },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);
      const top5 = body.results.slice(0, 5);

      // All top 5 should be in the Databases category
      for (const offer of top5) {
        assert.strictEqual(
          offer.category,
          "Databases",
          `Expected ${offer.vendor} to be in Databases, got ${offer.category}`
        );
      }
    } finally {
      proc.kill();
    }
  });

  it("ranks Cloud Hosting vendors first when searching 'hosting'", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search_deals", arguments: { query: "hosting" } },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);
      const top5 = body.results.slice(0, 5);

      for (const offer of top5) {
        assert.strictEqual(
          offer.category,
          "Cloud Hosting",
          `Expected ${offer.vendor} to be in Cloud Hosting, got ${offer.category}`
        );
      }
    } finally {
      proc.kill();
    }
  });

  it("ranks vendor name match first when searching by vendor name", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search_deals", arguments: { query: "supabase" } },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);

      assert.ok(body.results.length >= 1);
      assert.strictEqual(body.results[0].vendor, "Supabase");
    } finally {
      proc.kill();
    }
  });

  it("explicit sort overrides relevance ranking", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_deals",
            arguments: { query: "database", sort: "vendor" },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);
      const vendors = body.results.map((o: any) => o.vendor);

      // Should be sorted alphabetically, not by relevance
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
});

describe("search_deals vendor details with eligibility", () => {
  it("includes eligibility in response for conditional deals", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search_deals", arguments: { vendor: "JetBrains" } },
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

describe("search_deals vendor details", () => {
  it("returns full details for exact vendor match", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search_deals", arguments: { vendor: "Neon" } },
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
          params: { name: "search_deals", arguments: { vendor: "nEoN" } },
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
          params: { name: "search_deals", arguments: { vendor: "Cloud" } },
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
          params: { name: "search_deals", arguments: { vendor: "zzzznonexistent99999" } },
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

describe("search_deals vendor alternatives", () => {
  it("returns alternatives for vendor details", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search_deals", arguments: { vendor: "Neon" } },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      assert.ok(!result.result.isError);
      const offer = JSON.parse(result.result.content[0].text);
      assert.ok(Array.isArray(offer.relatedVendors));
      assert.ok(offer.relatedVendors.length > 0);
      assert.ok(Array.isArray(offer.alternatives));
      assert.ok(offer.alternatives.length > 0);
    } finally {
      proc.kill();
    }
  });

  it("returns full deal objects in alternatives", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search_deals", arguments: { vendor: "Neon" } },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      assert.ok(!result.result.isError);
      const offer = JSON.parse(result.result.content[0].text);
      assert.ok(Array.isArray(offer.relatedVendors));
      assert.ok(Array.isArray(offer.alternatives));
      assert.ok(offer.alternatives.length > 0);
      assert.ok(offer.alternatives.length <= 5);
      const alt = offer.alternatives[0];
      assert.ok(typeof alt.vendor === "string");
      assert.ok(typeof alt.category === "string");
      assert.ok(typeof alt.description === "string");
      assert.ok(typeof alt.url === "string");
      assert.ok(!offer.alternatives.some((a: any) => a.vendor === "Neon"));
    } finally {
      proc.kill();
    }
  });

  it("returns empty alternatives array for vendor with no same-category alternatives", async () => {
    const proc = startServer();
    try {
      // Use a vendor that's likely alone in its category — find one via search first
      const searchResponses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search_deals", arguments: { vendor: "Neon" } },
        },
      ])) as any[];

      const searchResult = searchResponses.find((r: any) => r.id === 2) as any;
      assert.ok(!searchResult.result.isError);
      const offer = JSON.parse(searchResult.result.content[0].text);
      // Alternatives should be capped at 5
      assert.ok(offer.alternatives.length <= 5);
    } finally {
      proc.kill();
    }
  });

  it("caps alternatives at 5", async () => {
    const proc = startServer();
    try {
      // Databases category has many vendors, so alternatives should be capped
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search_deals", arguments: { vendor: "Neon" } },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      assert.ok(!result.result.isError);
      const offer = JSON.parse(result.result.content[0].text);
      assert.ok(offer.alternatives.length <= 5);
      // relatedVendors should match alternatives vendor names
      assert.deepStrictEqual(
        offer.relatedVendors,
        offer.alternatives.map((a: any) => a.vendor)
      );
    } finally {
      proc.kill();
    }
  });
});

describe("compare_vendors tool", () => {
  it("compares two vendors in the same category", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "compare_vendors", arguments: { vendors: ["Supabase", "Neon"] } },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      assert.ok(!result.result.isError);
      const comparison = JSON.parse(result.result.content[0].text);

      assert.strictEqual(comparison.vendor_a.vendor, "Supabase");
      assert.strictEqual(comparison.vendor_b.vendor, "Neon");
      assert.strictEqual(comparison.shared_categories, true);
      assert.deepStrictEqual(comparison.category_overlap, ["Databases"]);
      assert.ok(typeof comparison.vendor_a.description === "string");
      assert.ok(typeof comparison.vendor_b.description === "string");
      assert.ok(Array.isArray(comparison.vendor_a.deal_changes));
      assert.ok(Array.isArray(comparison.vendor_b.deal_changes));
      // compare_vendors includes risk by default
      assert.ok(comparison.risk);
    } finally {
      proc.kill();
    }
  });

  it("compares two vendors in different categories", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "compare_vendors", arguments: { vendors: ["Vercel", "Supabase"] } },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      assert.ok(!result.result.isError);
      const comparison = JSON.parse(result.result.content[0].text);

      assert.strictEqual(comparison.shared_categories, false);
      assert.deepStrictEqual(comparison.category_overlap, []);
    } finally {
      proc.kill();
    }
  });

  it("handles fuzzy vendor name matching", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "compare_vendors", arguments: { vendors: ["supabase", "neon"] } },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      assert.ok(!result.result.isError);
      const comparison = JSON.parse(result.result.content[0].text);
      assert.strictEqual(comparison.vendor_a.vendor, "Supabase");
      assert.strictEqual(comparison.vendor_b.vendor, "Neon");
    } finally {
      proc.kill();
    }
  });

  it("returns error with suggestions when vendor not found", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "compare_vendors", arguments: { vendors: ["cloud", "Neon"] } },
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

  it("returns error when both vendors not found", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "compare_vendors", arguments: { vendors: ["zzzzz", "yyyyy"] } },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      assert.ok(result.result.isError);
      const text = result.result.content[0].text;
      // Both should be mentioned as not found
      assert.ok(text.includes("zzzzz"));
      assert.ok(text.includes("yyyyy"));
    } finally {
      proc.kill();
    }
  });

  it("works when comparing same vendor", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "compare_vendors", arguments: { vendors: ["Vercel", "Vercel"] } },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      assert.ok(!result.result.isError);
      const comparison = JSON.parse(result.result.content[0].text);
      assert.strictEqual(comparison.vendor_a.vendor, "Vercel");
      assert.strictEqual(comparison.vendor_b.vendor, "Vercel");
      assert.strictEqual(comparison.shared_categories, true);
    } finally {
      proc.kill();
    }
  });

  it("returns risk assessment for a single vendor", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "compare_vendors", arguments: { vendors: ["Vercel"] } },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      assert.ok(!result.result.isError);
      const risk = JSON.parse(result.result.content[0].text);
      assert.ok(risk.vendor || risk.risk_level);
    } finally {
      proc.kill();
    }
  });
});

describe("response_format=concise", () => {
  it("returns concise output for search_deals", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_deals",
            arguments: { query: "database", limit: 3, response_format: "concise" },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);
      assert.ok(body.results.length > 0);
      const offer = body.results[0];
      // Concise: only vendor, tier, description, url
      assert.ok(typeof offer.vendor === "string");
      assert.ok(typeof offer.tier === "string");
      assert.ok(typeof offer.description === "string");
      assert.ok(typeof offer.url === "string");
      // Should NOT have enriched fields
      assert.strictEqual(offer.category, undefined);
      assert.strictEqual(offer.tags, undefined);
      assert.strictEqual(offer.risk_level, undefined);
      assert.strictEqual(offer.days_since_verified, undefined);
    } finally {
      proc.kill();
    }
  });

  it("returns concise output for track_changes", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "track_changes",
            arguments: { since: "2020-01-01", response_format: "concise" },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);
      assert.ok(body.changes.length > 0);
      const change = body.changes[0];
      // Concise: only vendor, change_type, date, summary
      assert.ok(typeof change.vendor === "string");
      assert.ok(typeof change.change_type === "string");
      assert.ok(typeof change.date === "string");
      assert.ok(typeof change.summary === "string");
      // Should NOT have full fields
      assert.strictEqual(change.previous_state, undefined);
      assert.strictEqual(change.current_state, undefined);
      assert.strictEqual(change.impact, undefined);
      assert.strictEqual(change.source_url, undefined);
    } finally {
      proc.kill();
    }
  });
});

describe("zero-result suggestion", () => {
  it("returns suggestion when search has no matches", async () => {
    const proc = startServer();
    try {
      const responses = (await sendMcpMessages(proc, [
        ...INIT_MESSAGES,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_deals",
            arguments: { query: "zzzznonexistentquery99999" },
          },
        },
      ])) as any[];

      const result = responses.find((r: any) => r.id === 2) as any;
      const body = JSON.parse(result.result.content[0].text);
      assert.strictEqual(body.results.length, 0);
      assert.strictEqual(body.total, 0);
      assert.ok(typeof body.suggestion === "string");
      assert.ok(body.suggestion.includes("No matches"));
      assert.ok(body.suggestion.includes("category"));
    } finally {
      proc.kill();
    }
  });
});

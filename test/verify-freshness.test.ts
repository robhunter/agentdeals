import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const {
  findStaleOffers,
  fetchPageText,
  verifyOfferAgainstPage,
  parseVerifierResponse,
  createVerifierClient,
  verifyFreshness,
  VERIFIER_MODEL,
  VERIFIER_API_KEY_ENV,
  VERIFIER_BASE_URL,
} = await import("../scripts/verify-freshness.js");

function stubClient(text: string) {
  return { model: VERIFIER_MODEL, baseUrl: VERIFIER_BASE_URL, complete: async () => text };
}

describe("verify-freshness", () => {
  const now = new Date("2026-03-16T00:00:00Z");

  describe("findStaleOffers", () => {
    it("skips fresh entries", () => {
      const offers = [
        { vendor: "Fresh", category: "Hosting", url: "https://example.com", verifiedDate: "2026-03-10" },
        { vendor: "AlsoFresh", category: "CI/CD", url: "https://example.com", verifiedDate: "2026-03-15" },
      ];
      const { stale, freshCount } = findStaleOffers(offers, 25, now);
      assert.strictEqual(stale.length, 0);
      assert.strictEqual(freshCount, 2);
    });

    it("identifies stale entries beyond threshold", () => {
      const offers = [
        { vendor: "Fresh", category: "Hosting", url: "https://example.com", verifiedDate: "2026-03-10" },
        { vendor: "Stale", category: "Databases", url: "https://example.com", verifiedDate: "2026-02-01" },
        { vendor: "VeryStale", category: "CI/CD", url: "https://example.com", verifiedDate: "2025-12-01" },
      ];
      const { stale, freshCount } = findStaleOffers(offers, 25, now);
      assert.strictEqual(stale.length, 2);
      assert.strictEqual(freshCount, 1);
    });

    it("treats missing verifiedDate as stale", () => {
      const offers = [
        { vendor: "NoDate", category: "Auth", url: "https://example.com" },
      ];
      const { stale } = findStaleOffers(offers, 25, now);
      assert.strictEqual(stale.length, 1);
      assert.strictEqual(stale[0].offer.vendor, "NoDate");
    });

    it("sorts stale entries by staleness descending", () => {
      const offers = [
        { vendor: "A", category: "A", url: "https://example.com", verifiedDate: "2026-02-10" },
        { vendor: "B", category: "B", url: "https://example.com", verifiedDate: "2025-12-01" },
        { vendor: "C", category: "C", url: "https://example.com", verifiedDate: "2026-01-15" },
      ];
      const { stale } = findStaleOffers(offers, 25, now);
      assert.strictEqual(stale.length, 3);
      assert.strictEqual(stale[0].offer.vendor, "B");
      assert.strictEqual(stale[1].offer.vendor, "C");
      assert.strictEqual(stale[2].offer.vendor, "A");
    });

    it("preserves original index for data updates", () => {
      const offers = [
        { vendor: "Fresh", category: "A", url: "https://example.com", verifiedDate: "2026-03-15" },
        { vendor: "Stale", category: "B", url: "https://example.com", verifiedDate: "2026-01-01" },
        { vendor: "AlsoStale", category: "C", url: "https://example.com", verifiedDate: "2026-01-15" },
      ];
      const { stale } = findStaleOffers(offers, 25, now);
      assert.strictEqual(stale[0].index, 1);
      assert.strictEqual(stale[0].offer.vendor, "Stale");
      assert.strictEqual(stale[1].index, 2);
      assert.strictEqual(stale[1].offer.vendor, "AlsoStale");
    });

    it("respects custom threshold", () => {
      const offers = [
        { vendor: "A", category: "Hosting", url: "https://example.com", verifiedDate: "2026-03-10" },
        { vendor: "B", category: "Hosting", url: "https://example.com", verifiedDate: "2026-03-14" },
      ];
      const { stale, freshCount } = findStaleOffers(offers, 5, now);
      assert.strictEqual(stale.length, 1);
      assert.strictEqual(stale[0].offer.vendor, "A");
      assert.strictEqual(freshCount, 1);
    });
  });

  describe("fetchPageText", () => {
    it("returns error for unreachable URLs", async () => {
      const result = await fetchPageText("http://localhost:19999/nonexistent");
      assert.strictEqual(result.ok, false);
      assert.ok(result.error);
    });

    it("returns error for non-200 responses", async () => {
      const result = await fetchPageText("https://httpstat.us/404");
      assert.strictEqual(result.ok, false);
      assert.ok(result.error?.includes("404") || result.error?.includes("timeout") || result.error);
    });
  });

  describe("verifyOfferAgainstPage", () => {
    const offer = { vendor: "Test", category: "Hosting", tier: "Free", description: "Free hosting" };

    it("parses confirmed response", async () => {
      const result = await verifyOfferAgainstPage(stubClient('{"status":"confirmed"}'), offer, "Free hosting plan available");
      assert.strictEqual(result.status, "confirmed");
    });

    it("parses changed response", async () => {
      const result = await verifyOfferAgainstPage(
        stubClient('{"status":"changed","summary":"Free tier removed"}'),
        offer,
        "Paid plans start at $5/mo"
      );
      assert.strictEqual(result.status, "changed");
      assert.strictEqual(result.summary, "Free tier removed");
    });

    it("handles unclear response", async () => {
      const result = await verifyOfferAgainstPage(
        stubClient('{"status":"unclear","summary":"Page requires login"}'),
        offer,
        "Please sign in"
      );
      assert.strictEqual(result.status, "unclear");
    });

    it("sends the stored terms and the page text in the prompt", async () => {
      let seen = "";
      const client = { complete: async (prompt: string) => { seen = prompt; return '{"status":"confirmed"}'; } };
      await verifyOfferAgainstPage(client, offer, "Free hosting plan available");
      for (const fragment of [offer.vendor, offer.tier, offer.description, "Free hosting plan available"]) {
        assert.ok(seen.includes(fragment), `prompt should carry ${fragment}`);
      }
    });
  });

  describe("parseVerifierResponse", () => {
    it("handles malformed AI response gracefully", () => {
      assert.strictEqual(parseVerifierResponse("I think the deal looks correct").status, "unclear");
    });

    it("extracts JSON from verbose AI response", () => {
      assert.strictEqual(parseVerifierResponse('The deal is still valid. {"status":"confirmed"}').status, "confirmed");
    });

    it("reads a fenced code block", () => {
      const result = parseVerifierResponse('```json\n{"status":"changed","summary":"Limit cut"}\n```');
      assert.strictEqual(result.status, "changed");
      assert.strictEqual(result.summary, "Limit cut");
    });

    it("reads a fenced answer whose text contains a closing brace", () => {
      const result = parseVerifierResponse(
        '```json\n{"status":"changed","summary":"Template ${quota} removed","change_type":"limits_reduced"}\n```'
      );
      assert.strictEqual(result.status, "changed");
      assert.strictEqual(result.change_type, "limits_reduced");
    });

    it("refuses a status it does not recognise", () => {
      assert.strictEqual(parseVerifierResponse('{"status":"probably fine"}').status, "unclear");
    });

    it("refuses a non-string response", () => {
      assert.strictEqual(parseVerifierResponse(undefined).status, "unclear");
    });
  });

  describe("createVerifierClient", () => {
    it("refuses to run without a key, naming the variable", () => {
      const saved = process.env[VERIFIER_API_KEY_ENV];
      delete process.env[VERIFIER_API_KEY_ENV];
      try {
        assert.throws(() => createVerifierClient(), new RegExp(VERIFIER_API_KEY_ENV));
      } finally {
        if (saved !== undefined) process.env[VERIFIER_API_KEY_ENV] = saved;
      }
    });

    it("posts an OpenAI-shaped chat completion to the configured endpoint", async () => {
      const calls: any[] = [];
      const client = createVerifierClient({
        apiKey: "test-key",
        baseUrl: "https://openrouter.test/api/v1",
        fetchImpl: async (url: string, init: any) => {
          calls.push({ url, init });
          return {
            ok: true,
            json: async () => ({ choices: [{ message: { content: '{"status":"confirmed"}' } }] }),
          };
        },
      });
      const text = await client.complete("does this still hold?");
      assert.strictEqual(text, '{"status":"confirmed"}');
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].url, "https://openrouter.test/api/v1/chat/completions");
      assert.strictEqual(calls[0].init.method, "POST");
      assert.strictEqual(calls[0].init.headers.Authorization, "Bearer test-key");
      const body = JSON.parse(calls[0].init.body);
      assert.strictEqual(body.model, VERIFIER_MODEL);
      assert.deepStrictEqual(body.messages, [{ role: "user", content: "does this still hold?" }]);
      assert.strictEqual(body.temperature, 0);
    });

    it("defaults to the OpenRouter endpoint", () => {
      assert.strictEqual(createVerifierClient({ apiKey: "test-key" }).baseUrl, VERIFIER_BASE_URL);
      assert.match(VERIFIER_BASE_URL, /^https:\/\/openrouter\.ai\//);
    });

    it("asks the model the cost and accuracy were measured on", () => {
      assert.strictEqual(
        VERIFIER_MODEL,
        "google/gemma-3-27b-it",
        "changing the model changes both the price per record and the answer quality — measure again before moving it"
      );
    });

    it("reports the status when the endpoint rejects the request", async () => {
      const client = createVerifierClient({
        apiKey: "test-key",
        fetchImpl: async () => ({ ok: false, status: 401, text: async () => "No auth credentials found" }),
      });
      await assert.rejects(() => client.complete("hello"), /401/);
    });

    it("reports a response carrying no message content", async () => {
      const client = createVerifierClient({
        apiKey: "test-key",
        fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [] }) }),
      });
      await assert.rejects(() => client.complete("hello"), /no message content/);
    });
  });

  describe("verifyFreshness (integration with mock)", () => {
    let tmpDir;
    let indexPath;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "verify-freshness-"));
      indexPath = join(tmpDir, "index.json");
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("reports all fresh when no stale entries", async () => {
      const data = {
        offers: [
          { vendor: "Fresh", category: "Hosting", url: "https://example.com", verifiedDate: "2026-03-10", tier: "Free", description: "Free plan" },
        ],
      };
      writeFileSync(indexPath, JSON.stringify(data));

      const result = await verifyFreshness({ thresholdDays: 25, dryRun: true, indexPath, now });
      assert.strictEqual(result.verified, 0);
      assert.strictEqual(result.alreadyFresh, 1);
    });

    it("dry-run does not modify index file", async () => {
      const data = {
        offers: [
          { vendor: "Stale", category: "Hosting", url: "http://localhost:19999/fake", verifiedDate: "2025-01-01", tier: "Free", description: "Free plan" },
        ],
      };
      writeFileSync(indexPath, JSON.stringify(data));
      const before = readFileSync(indexPath, "utf-8");

      await verifyFreshness({ thresholdDays: 25, dryRun: true, indexPath, now, client: stubClient('{"status":"confirmed"}') });
      const after = readFileSync(indexPath, "utf-8");
      assert.strictEqual(before, after);
    });

    it("respects limit parameter", async () => {
      const offers = Array.from({ length: 10 }, (_, i) => ({
        vendor: `V${i}`,
        category: "Hosting",
        url: "http://localhost:19999/fake",
        verifiedDate: "2025-01-01",
        tier: "Free",
        description: "Free plan",
      }));
      writeFileSync(indexPath, JSON.stringify({ offers }));

      const result = await verifyFreshness({ thresholdDays: 25, dryRun: true, limit: 3, indexPath, now, client: stubClient('{"status":"confirmed"}') });
      assert.strictEqual(result.skipped, 7);
      assert.ok(result.failed <= 3);
    });
  });
});

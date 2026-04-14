import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REQUESTS_PATH = path.join(__dirname, "..", "data", "referral_requests.json");

const {
  logReferralRequest,
  attributeConversion,
  getRequestsByAgent,
  getRequestById,
  markConversion,
  resetReferralRequestsCache,
} = await import("../dist/referral-requests.js");

let originalData: string | null = null;

describe("referral-requests", () => {
  beforeEach(() => {
    if (fs.existsSync(REQUESTS_PATH)) {
      originalData = fs.readFileSync(REQUESTS_PATH, "utf-8");
    } else {
      originalData = null;
    }
    fs.writeFileSync(REQUESTS_PATH, JSON.stringify({ referral_requests: [] }), "utf-8");
    resetReferralRequestsCache();
  });

  afterEach(() => {
    if (originalData !== null) {
      fs.writeFileSync(REQUESTS_PATH, originalData, "utf-8");
    }
    resetReferralRequestsCache();
  });

  describe("logReferralRequest", () => {
    it("creates a request with all required fields", () => {
      const req = logReferralRequest({
        agent_id: "agent_001",
        vendor: "Railway",
        referral_code: "REF123",
        referral_url: "https://railway.app/ref/REF123",
      });
      assert.ok(req.id.startsWith("rr_"));
      assert.strictEqual(req.agent_id, "agent_001");
      assert.strictEqual(req.vendor, "Railway");
      assert.strictEqual(req.referral_code, "REF123");
      assert.strictEqual(req.referral_url, "https://railway.app/ref/REF123");
      assert.ok(req.requested_at);
      assert.strictEqual(req.conversion_id, null);
    });

    it("generates unique IDs", () => {
      const req1 = logReferralRequest({
        agent_id: "agent_001",
        vendor: "Railway",
        referral_code: "REF1",
        referral_url: "https://example.com",
      });
      const req2 = logReferralRequest({
        agent_id: "agent_001",
        vendor: "Railway",
        referral_code: "REF2",
        referral_url: "https://example.com",
      });
      assert.notStrictEqual(req1.id, req2.id);
    });

    it("persists request to file", () => {
      logReferralRequest({
        agent_id: "agent_001",
        vendor: "Vercel",
        referral_code: "V123",
        referral_url: "https://vercel.com/ref",
      });
      resetReferralRequestsCache();
      const data = JSON.parse(fs.readFileSync(REQUESTS_PATH, "utf-8"));
      assert.strictEqual(data.referral_requests.length, 1);
      assert.strictEqual(data.referral_requests[0].vendor, "Vercel");
    });
  });

  describe("getRequestsByAgent", () => {
    it("returns only requests for the specified agent", () => {
      logReferralRequest({ agent_id: "agent_A", vendor: "V1", referral_code: "C1", referral_url: "https://a.com" });
      logReferralRequest({ agent_id: "agent_B", vendor: "V2", referral_code: "C2", referral_url: "https://b.com" });
      logReferralRequest({ agent_id: "agent_A", vendor: "V3", referral_code: "C3", referral_url: "https://c.com" });
      const reqs = getRequestsByAgent("agent_A");
      assert.strictEqual(reqs.length, 2);
      assert.ok(reqs.every((r: { agent_id: string }) => r.agent_id === "agent_A"));
    });

    it("returns empty array for unknown agent", () => {
      const reqs = getRequestsByAgent("nonexistent");
      assert.strictEqual(reqs.length, 0);
    });
  });

  describe("getRequestById", () => {
    it("finds a request by ID", () => {
      const created = logReferralRequest({
        agent_id: "agent_001",
        vendor: "Railway",
        referral_code: "R1",
        referral_url: "https://r.com",
      });
      const found = getRequestById(created.id);
      assert.ok(found);
      assert.strictEqual(found.id, created.id);
      assert.strictEqual(found.vendor, "Railway");
    });

    it("returns null for unknown ID", () => {
      const result = getRequestById("rr_nonexistent");
      assert.strictEqual(result, null);
    });
  });

  describe("attributeConversion", () => {
    it("returns agent_id for last-touch attribution", () => {
      logReferralRequest({ agent_id: "agent_A", vendor: "Railway", referral_code: "A1", referral_url: "https://a.com" });
      logReferralRequest({ agent_id: "agent_B", vendor: "Railway", referral_code: "B1", referral_url: "https://b.com" });
      const result = attributeConversion("Railway", new Date());
      assert.ok(result === "agent_A" || result === "agent_B", "should attribute to one of the agents");
    });

    it("is case-insensitive on vendor name", () => {
      logReferralRequest({ agent_id: "agent_A", vendor: "railway", referral_code: "A1", referral_url: "https://a.com" });
      const result = attributeConversion("Railway", new Date());
      assert.strictEqual(result, "agent_A");
    });

    it("returns null when no matching vendor", () => {
      logReferralRequest({ agent_id: "agent_A", vendor: "Vercel", referral_code: "V1", referral_url: "https://v.com" });
      const result = attributeConversion("Railway", new Date());
      assert.strictEqual(result, null);
    });

    it("returns null when requests are outside lookback window", () => {
      const req = logReferralRequest({ agent_id: "agent_A", vendor: "Railway", referral_code: "A1", referral_url: "https://a.com" });
      const futureDate = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000);
      const result = attributeConversion("Railway", futureDate, 1);
      assert.strictEqual(result, null);
    });

    it("returns null when no requests exist", () => {
      const result = attributeConversion("Railway", new Date());
      assert.strictEqual(result, null);
    });

    it("respects custom lookback days", () => {
      logReferralRequest({ agent_id: "agent_A", vendor: "Railway", referral_code: "A1", referral_url: "https://a.com" });
      const result = attributeConversion("Railway", new Date(), 90);
      assert.strictEqual(result, "agent_A");
    });
  });

  describe("markConversion", () => {
    it("marks a request as converted", () => {
      const req = logReferralRequest({ agent_id: "agent_A", vendor: "Railway", referral_code: "A1", referral_url: "https://a.com" });
      const result = markConversion(req.id, "conv_123");
      assert.strictEqual(result, true);
      const updated = getRequestById(req.id);
      assert.strictEqual(updated!.conversion_id, "conv_123");
    });

    it("returns false for unknown request ID", () => {
      const result = markConversion("rr_nonexistent", "conv_123");
      assert.strictEqual(result, false);
    });

    it("persists conversion to file", () => {
      const req = logReferralRequest({ agent_id: "agent_A", vendor: "V1", referral_code: "C1", referral_url: "https://v.com" });
      markConversion(req.id, "conv_456");
      resetReferralRequestsCache();
      const data = JSON.parse(fs.readFileSync(REQUESTS_PATH, "utf-8"));
      assert.strictEqual(data.referral_requests[0].conversion_id, "conv_456");
    });
  });
});

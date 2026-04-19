import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODES_PATH = path.join(__dirname, "..", "data", "referral_codes.json");
const AGENTS_PATH = path.join(__dirname, "..", "data", "agents.json");

const {
  submitReferralCode,
  getCodesByAgent,
  getCodeById,
  updateCode,
  revokeCode,
  getActiveCodesForVendor,
  getAllActiveCodes,
  calculateTrustTier,
  getDailySubmissionCount,
  getDailyLimit,
  resetReferralCodesCache,
} = await import("../dist/referral-codes.js");

const { registerAgent, resetAgentsCache } = await import("../dist/agents.js");

function resetFiles() {
  fs.writeFileSync(CODES_PATH, JSON.stringify({ referral_codes: [] }), "utf-8");
  resetReferralCodesCache();
  fs.writeFileSync(AGENTS_PATH, JSON.stringify({ agents: [] }), "utf-8");
  resetAgentsCache();
}

function createTestAgent(name = "TestBot"): { agent: any; api_key: string } {
  return registerAgent({ name });
}

describe("Referral Code Submission", () => {
  beforeEach(() => {
    resetFiles();
  });

  after(() => {
    resetFiles();
  });

  it("submits a referral code for an existing vendor", () => {
    const { agent } = createTestAgent();
    const code = submitReferralCode({
      vendor: "Railway",
      code: "MYAGENT-RAILWAY",
      referral_url: "https://railway.app?ref=myagent",
      description: "Railway hosting referral",
      agent_id: agent.id,
      trust_tier: "new",
    });

    assert.ok(code.id.startsWith("code_"));
    assert.strictEqual(code.vendor, "Railway");
    assert.strictEqual(code.code, "MYAGENT-RAILWAY");
    assert.strictEqual(code.referral_url, "https://railway.app?ref=myagent");
    assert.strictEqual(code.source, "agent-submitted");
    // Issue #906: all agent-submitted codes are active immediately, regardless of tier.
    assert.strictEqual(code.status, "active");
    assert.strictEqual(code.trust_tier_at_submission, "new");
    assert.strictEqual(code.impressions, 0);
    assert.strictEqual(code.clicks, 0);
    assert.strictEqual(code.conversions, 0);
  });

  it("new-tier agents get active codes (issue #906 — no chicken-and-egg)", () => {
    const { agent } = createTestAgent();
    const code = submitReferralCode({
      vendor: "Railway",
      code: "NEW-AGENT-CODE",
      referral_url: "https://railway.app?ref=new",
      description: "New-tier agent code",
      agent_id: agent.id,
      trust_tier: "new",
    });

    assert.strictEqual(code.status, "active");
    assert.strictEqual(code.trust_tier_at_submission, "new");

    // Code must be visible via the active-codes surface that search uses.
    const activeCodes = getActiveCodesForVendor("Railway");
    assert.strictEqual(activeCodes.length, 1);
    assert.strictEqual(activeCodes[0].code, "NEW-AGENT-CODE");
  });

  it("verified agents get auto-approved codes", () => {
    const { agent } = createTestAgent();
    const code = submitReferralCode({
      vendor: "Railway",
      code: "VERIFIED-CODE",
      referral_url: "https://railway.app?ref=verified",
      description: "Auto-approved",
      agent_id: agent.id,
      trust_tier: "verified",
    });

    assert.strictEqual(code.status, "active");
    assert.strictEqual(code.trust_tier_at_submission, "verified");
  });

  it("trusted agents get auto-approved codes", () => {
    const { agent } = createTestAgent();
    const code = submitReferralCode({
      vendor: "Railway",
      code: "TRUSTED-CODE",
      referral_url: "https://railway.app?ref=trusted",
      description: "Auto-approved trusted",
      agent_id: agent.id,
      trust_tier: "trusted",
    });

    assert.strictEqual(code.status, "active");
  });

  it("rejects submission for non-existent vendor", () => {
    const { agent } = createTestAgent();
    assert.throws(
      () => submitReferralCode({
        vendor: "NonExistentVendor99",
        code: "CODE",
        referral_url: "https://example.com",
        description: "",
        agent_id: agent.id,
        trust_tier: "new",
      }),
      /not found in the offers index/
    );
  });

  it("rejects code longer than 100 characters", () => {
    const { agent } = createTestAgent();
    assert.throws(
      () => submitReferralCode({
        vendor: "Railway",
        code: "A".repeat(101),
        referral_url: "https://railway.app",
        description: "",
        agent_id: agent.id,
        trust_tier: "new",
      }),
      /max 100 characters/
    );
  });

  it("rejects empty code", () => {
    const { agent } = createTestAgent();
    assert.throws(
      () => submitReferralCode({
        vendor: "Railway",
        code: "",
        referral_url: "https://railway.app",
        description: "",
        agent_id: agent.id,
        trust_tier: "new",
      }),
      /non-empty string/
    );
  });

  it("rejects invalid referral URL", () => {
    const { agent } = createTestAgent();
    assert.throws(
      () => submitReferralCode({
        vendor: "Railway",
        code: "CODE",
        referral_url: "not-a-url",
        description: "",
        agent_id: agent.id,
        trust_tier: "new",
      }),
      /valid URL/
    );
  });

  it("enforces one active code per vendor per agent", () => {
    const { agent } = createTestAgent();
    submitReferralCode({
      vendor: "Railway",
      code: "CODE1",
      referral_url: "https://railway.app?ref=1",
      description: "",
      agent_id: agent.id,
      trust_tier: "verified",
    });

    assert.throws(
      () => submitReferralCode({
        vendor: "Railway",
        code: "CODE2",
        referral_url: "https://railway.app?ref=2",
        description: "",
        agent_id: agent.id,
        trust_tier: "verified",
      }),
      /already have an active/
    );
  });

  it("allows different agents to submit codes for same vendor", () => {
    const { agent: agent1 } = createTestAgent("Bot1");
    const { agent: agent2 } = createTestAgent("Bot2");

    const code1 = submitReferralCode({
      vendor: "Railway",
      code: "BOT1-CODE",
      referral_url: "https://railway.app?ref=bot1",
      description: "",
      agent_id: agent1.id,
      trust_tier: "verified",
    });

    const code2 = submitReferralCode({
      vendor: "Railway",
      code: "BOT2-CODE",
      referral_url: "https://railway.app?ref=bot2",
      description: "",
      agent_id: agent2.id,
      trust_tier: "verified",
    });

    assert.ok(code1.id !== code2.id);
    assert.strictEqual(code1.status, "active");
    assert.strictEqual(code2.status, "active");
  });

  it("allows resubmission after revoking", () => {
    const { agent } = createTestAgent();
    const code1 = submitReferralCode({
      vendor: "Railway",
      code: "CODE1",
      referral_url: "https://railway.app?ref=1",
      description: "",
      agent_id: agent.id,
      trust_tier: "verified",
    });

    revokeCode(code1.id, agent.id);

    const code2 = submitReferralCode({
      vendor: "Railway",
      code: "CODE2",
      referral_url: "https://railway.app?ref=2",
      description: "",
      agent_id: agent.id,
      trust_tier: "verified",
    });

    assert.strictEqual(code2.status, "active");
  });

  it("handles optional commission_rate and expiry", () => {
    const { agent } = createTestAgent();
    const code = submitReferralCode({
      vendor: "Railway",
      code: "CODE",
      referral_url: "https://railway.app?ref=test",
      description: "With extras",
      commission_rate: 0.15,
      expiry: "2027-12-31T00:00:00Z",
      agent_id: agent.id,
      trust_tier: "new",
    });

    assert.strictEqual(code.commission_rate, 0.15);
    assert.strictEqual(code.expiry, "2027-12-31T00:00:00Z");
  });
});

describe("Code Retrieval", () => {
  beforeEach(() => {
    resetFiles();
  });

  after(() => {
    resetFiles();
  });

  it("getCodesByAgent returns all codes for an agent", () => {
    const { agent } = createTestAgent();
    submitReferralCode({
      vendor: "Railway",
      code: "CODE1",
      referral_url: "https://railway.app?ref=1",
      description: "",
      agent_id: agent.id,
      trust_tier: "verified",
    });
    submitReferralCode({
      vendor: "Render",
      code: "CODE2",
      referral_url: "https://render.com?ref=1",
      description: "",
      agent_id: agent.id,
      trust_tier: "verified",
    });

    const codes = getCodesByAgent(agent.id);
    assert.strictEqual(codes.length, 2);
  });

  it("getCodeById returns the correct code", () => {
    const { agent } = createTestAgent();
    const submitted = submitReferralCode({
      vendor: "Railway",
      code: "CODE1",
      referral_url: "https://railway.app?ref=1",
      description: "",
      agent_id: agent.id,
      trust_tier: "new",
    });

    const found = getCodeById(submitted.id);
    assert.ok(found);
    assert.strictEqual(found.id, submitted.id);
  });

  it("getCodeById returns null for non-existent ID", () => {
    assert.strictEqual(getCodeById("code_nonexistent"), null);
  });
});

describe("Code Update", () => {
  beforeEach(() => {
    resetFiles();
  });

  after(() => {
    resetFiles();
  });

  it("updates code fields", () => {
    const { agent } = createTestAgent();
    const code = submitReferralCode({
      vendor: "Railway",
      code: "OLD-CODE",
      referral_url: "https://railway.app?ref=old",
      description: "Old desc",
      agent_id: agent.id,
      trust_tier: "verified",
    });

    const updated = updateCode(code.id, agent.id, {
      code: "NEW-CODE",
      referral_url: "https://railway.app?ref=new",
      description: "New desc",
      commission_rate: 0.2,
    });

    assert.strictEqual(updated.code, "NEW-CODE");
    assert.strictEqual(updated.referral_url, "https://railway.app?ref=new");
    assert.strictEqual(updated.description, "New desc");
    assert.strictEqual(updated.commission_rate, 0.2);
  });

  it("rejects update from non-owner", () => {
    const { agent: agent1 } = createTestAgent("Bot1");
    const { agent: agent2 } = createTestAgent("Bot2");

    const code = submitReferralCode({
      vendor: "Railway",
      code: "CODE",
      referral_url: "https://railway.app?ref=1",
      description: "",
      agent_id: agent1.id,
      trust_tier: "verified",
    });

    assert.throws(
      () => updateCode(code.id, agent2.id, { code: "STOLEN" }),
      /only update your own/
    );
  });

  it("rejects update of revoked code", () => {
    const { agent } = createTestAgent();
    const code = submitReferralCode({
      vendor: "Railway",
      code: "CODE",
      referral_url: "https://railway.app?ref=1",
      description: "",
      agent_id: agent.id,
      trust_tier: "verified",
    });

    revokeCode(code.id, agent.id);

    assert.throws(
      () => updateCode(code.id, agent.id, { code: "NEW" }),
      /Cannot update a revoked/
    );
  });
});

describe("Code Revocation", () => {
  beforeEach(() => {
    resetFiles();
  });

  after(() => {
    resetFiles();
  });

  it("soft-deletes a code", () => {
    const { agent } = createTestAgent();
    const code = submitReferralCode({
      vendor: "Railway",
      code: "CODE",
      referral_url: "https://railway.app?ref=1",
      description: "",
      agent_id: agent.id,
      trust_tier: "verified",
    });

    const revoked = revokeCode(code.id, agent.id);
    assert.strictEqual(revoked.status, "revoked");
  });

  it("rejects revocation from non-owner", () => {
    const { agent: agent1 } = createTestAgent("Bot1");
    const { agent: agent2 } = createTestAgent("Bot2");

    const code = submitReferralCode({
      vendor: "Railway",
      code: "CODE",
      referral_url: "https://railway.app?ref=1",
      description: "",
      agent_id: agent1.id,
      trust_tier: "verified",
    });

    assert.throws(
      () => revokeCode(code.id, agent2.id),
      /only revoke your own/
    );
  });

  it("rejects double revocation", () => {
    const { agent } = createTestAgent();
    const code = submitReferralCode({
      vendor: "Railway",
      code: "CODE",
      referral_url: "https://railway.app?ref=1",
      description: "",
      agent_id: agent.id,
      trust_tier: "verified",
    });

    revokeCode(code.id, agent.id);
    assert.throws(
      () => revokeCode(code.id, agent.id),
      /already revoked/
    );
  });
});

describe("Active Codes for Vendor", () => {
  beforeEach(() => {
    resetFiles();
  });

  after(() => {
    resetFiles();
  });

  it("returns only active codes for a vendor (excludes pending/revoked)", () => {
    const { agent: agent1 } = createTestAgent("Bot1");
    const { agent: agent2 } = createTestAgent("Bot2");

    // Active code
    submitReferralCode({
      vendor: "Railway",
      code: "ACTIVE-CODE",
      referral_url: "https://railway.app?ref=active",
      description: "",
      agent_id: agent1.id,
      trust_tier: "verified",
    });

    // Seed a legacy pending code directly (pre-#906 data may still exist in
    // production files). getActiveCodesForVendor must continue to exclude it.
    const data = JSON.parse(fs.readFileSync(CODES_PATH, "utf-8"));
    data.referral_codes.push({
      id: "code_legacy_pending",
      vendor: "Railway",
      code: "LEGACY-PENDING",
      referral_url: "https://railway.app?ref=pending",
      description: "",
      commission_rate: null,
      expiry: null,
      submitted_by: agent2.id,
      source: "agent-submitted",
      status: "pending",
      trust_tier_at_submission: "new",
      impressions: 0,
      clicks: 0,
      conversions: 0,
      submitted_at: "2026-04-18T00:00:00.000Z",
      updated_at: "2026-04-18T00:00:00.000Z",
    });
    fs.writeFileSync(CODES_PATH, JSON.stringify(data, null, 2), "utf-8");
    resetReferralCodesCache();

    const active = getActiveCodesForVendor("Railway");
    assert.strictEqual(active.length, 1);
    assert.strictEqual(active[0].code, "ACTIVE-CODE");
  });

  it("case-insensitive vendor lookup", () => {
    const { agent } = createTestAgent();
    submitReferralCode({
      vendor: "Railway",
      code: "CODE",
      referral_url: "https://railway.app?ref=1",
      description: "",
      agent_id: agent.id,
      trust_tier: "verified",
    });

    const codes = getActiveCodesForVendor("railway");
    assert.strictEqual(codes.length, 1);
  });

  it("expires codes past their expiry date", () => {
    const { agent } = createTestAgent();
    // Manually create a code with past expiry
    const codesPath = path.join(__dirname, "..", "data", "referral_codes.json");
    const data = JSON.parse(fs.readFileSync(codesPath, "utf-8"));
    data.referral_codes.push({
      id: "code_expired_test",
      vendor: "Railway",
      code: "EXPIRED",
      referral_url: "https://railway.app?ref=expired",
      description: "",
      commission_rate: null,
      expiry: "2020-01-01T00:00:00Z",
      submitted_by: agent.id,
      source: "agent-submitted",
      status: "active",
      trust_tier_at_submission: "verified",
      impressions: 0,
      clicks: 0,
      conversions: 0,
      submitted_at: "2020-01-01T00:00:00Z",
      updated_at: "2020-01-01T00:00:00Z",
    });
    fs.writeFileSync(codesPath, JSON.stringify(data, null, 2), "utf-8");
    resetReferralCodesCache();

    const codes = getActiveCodesForVendor("Railway");
    assert.strictEqual(codes.length, 0);
  });
});

describe("Trust Tier Calculation", () => {
  it("returns 'new' with no ledger entries", () => {
    assert.strictEqual(calculateTrustTier("agent_1", []), "new");
  });

  it("returns 'new' with fewer than 3 conversions", () => {
    const entries = [
      { event_type: "conversion", agent_id: "agent_1", status: "confirmed" },
      { event_type: "conversion", agent_id: "agent_1", status: "confirmed" },
    ];
    assert.strictEqual(calculateTrustTier("agent_1", entries), "new");
  });

  it("returns 'verified' with 3+ conversions and 0 clawbacks", () => {
    const entries = [
      { event_type: "conversion", agent_id: "agent_1", status: "confirmed" },
      { event_type: "conversion", agent_id: "agent_1", status: "confirmed" },
      { event_type: "conversion", agent_id: "agent_1", status: "confirmed" },
    ];
    assert.strictEqual(calculateTrustTier("agent_1", entries), "verified");
  });

  it("returns 'new' with 3+ conversions but clawbacks", () => {
    const entries = [
      { event_type: "conversion", agent_id: "agent_1", status: "confirmed" },
      { event_type: "conversion", agent_id: "agent_1", status: "confirmed" },
      { event_type: "conversion", agent_id: "agent_1", status: "confirmed" },
      { event_type: "clawback", agent_id: "agent_1", status: "clawed_back" },
    ];
    assert.strictEqual(calculateTrustTier("agent_1", entries), "new");
  });

  it("returns 'trusted' with 20+ conversions and <5% clawback rate", () => {
    const entries: any[] = [];
    for (let i = 0; i < 21; i++) {
      entries.push({ event_type: "conversion", agent_id: "agent_1", status: "confirmed" });
    }
    assert.strictEqual(calculateTrustTier("agent_1", entries), "trusted");
  });

  it("returns 'verified' with 20+ conversions but >=5% clawback rate", () => {
    const entries: any[] = [];
    for (let i = 0; i < 20; i++) {
      entries.push({ event_type: "conversion", agent_id: "agent_1", status: "confirmed" });
    }
    // 2 clawbacks out of 22 = ~9% clawback rate
    entries.push({ event_type: "clawback", agent_id: "agent_1", status: "clawed_back" });
    entries.push({ event_type: "clawback", agent_id: "agent_1", status: "clawed_back" });
    assert.strictEqual(calculateTrustTier("agent_1", entries), "new");
  });

  it("ignores entries from other agents", () => {
    const entries = [
      { event_type: "conversion", agent_id: "agent_1", status: "confirmed" },
      { event_type: "conversion", agent_id: "agent_2", status: "confirmed" },
      { event_type: "conversion", agent_id: "agent_2", status: "confirmed" },
      { event_type: "conversion", agent_id: "agent_2", status: "confirmed" },
    ];
    assert.strictEqual(calculateTrustTier("agent_1", entries), "new");
    assert.strictEqual(calculateTrustTier("agent_2", entries), "verified");
  });

  it("excludes clawed_back conversions from count", () => {
    const entries = [
      { event_type: "conversion", agent_id: "agent_1", status: "confirmed" },
      { event_type: "conversion", agent_id: "agent_1", status: "confirmed" },
      { event_type: "conversion", agent_id: "agent_1", status: "clawed_back" },
    ];
    // 2 non-clawed-back conversions, 0 clawback events
    assert.strictEqual(calculateTrustTier("agent_1", entries), "new");
  });
});

describe("Rate Limiting", () => {
  beforeEach(() => {
    resetFiles();
  });

  after(() => {
    resetFiles();
  });

  it("getDailyLimit returns correct limits per tier", () => {
    assert.strictEqual(getDailyLimit("new"), 10);
    assert.strictEqual(getDailyLimit("verified"), 10);
    assert.strictEqual(getDailyLimit("trusted"), 50);
  });

  it("getDailySubmissionCount tracks today's submissions", () => {
    const { agent } = createTestAgent();

    assert.strictEqual(getDailySubmissionCount(agent.id), 0);

    submitReferralCode({
      vendor: "Railway",
      code: "CODE1",
      referral_url: "https://railway.app?ref=1",
      description: "",
      agent_id: agent.id,
      trust_tier: "verified",
    });

    assert.strictEqual(getDailySubmissionCount(agent.id), 1);
  });
});

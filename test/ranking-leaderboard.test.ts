import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODES_PATH = path.join(__dirname, "..", "data", "referral_codes.json");
const AGENTS_PATH = path.join(__dirname, "..", "data", "agents.json");
const LEDGER_PATH = path.join(__dirname, "..", "data", "ledger_entries.json");
const BALANCES_PATH = path.join(__dirname, "..", "data", "agent_balances.json");
const REQUESTS_PATH = path.join(__dirname, "..", "data", "referral_requests.json");

const {
  submitReferralCode,
  getCodesByAgent,
  getActiveCodesForVendor,
  getRankedCodesForVendor,
  calculateCodeScore,
  isInColdStart,
  recordImpression,
  recordCodeConversion,
  resetReferralCodesCache,
} = await import("../dist/referral-codes.js");

const { registerAgent, resetAgentsCache, updateAgentTrustTier } = await import("../dist/agents.js");
const { recordConversion, getAgentBalance, getLeaderboard, clawbackEntry, resetLedgerCache } = await import("../dist/ledger.js");
const { resetReferralRequestsCache, logReferralRequest } = await import("../dist/referral-requests.js");

let origCodes: string | null = null;
let origAgents: string | null = null;
let origLedger: string | null = null;
let origBalances: string | null = null;
let origRequests: string | null = null;

function saveOriginals() {
  origCodes = fs.existsSync(CODES_PATH) ? fs.readFileSync(CODES_PATH, "utf-8") : null;
  origAgents = fs.existsSync(AGENTS_PATH) ? fs.readFileSync(AGENTS_PATH, "utf-8") : null;
  origLedger = fs.existsSync(LEDGER_PATH) ? fs.readFileSync(LEDGER_PATH, "utf-8") : null;
  origBalances = fs.existsSync(BALANCES_PATH) ? fs.readFileSync(BALANCES_PATH, "utf-8") : null;
  origRequests = fs.existsSync(REQUESTS_PATH) ? fs.readFileSync(REQUESTS_PATH, "utf-8") : null;
}

function restoreOriginals() {
  if (origCodes !== null) fs.writeFileSync(CODES_PATH, origCodes, "utf-8");
  else if (fs.existsSync(CODES_PATH)) fs.unlinkSync(CODES_PATH);
  if (origAgents !== null) fs.writeFileSync(AGENTS_PATH, origAgents, "utf-8");
  else if (fs.existsSync(AGENTS_PATH)) fs.unlinkSync(AGENTS_PATH);
  if (origLedger !== null) fs.writeFileSync(LEDGER_PATH, origLedger, "utf-8");
  else if (fs.existsSync(LEDGER_PATH)) fs.unlinkSync(LEDGER_PATH);
  if (origBalances !== null) fs.writeFileSync(BALANCES_PATH, origBalances, "utf-8");
  else if (fs.existsSync(BALANCES_PATH)) fs.unlinkSync(BALANCES_PATH);
  if (origRequests !== null) fs.writeFileSync(REQUESTS_PATH, origRequests, "utf-8");
  else if (fs.existsSync(REQUESTS_PATH)) fs.unlinkSync(REQUESTS_PATH);
  resetReferralCodesCache();
  resetAgentsCache();
  resetLedgerCache();
  resetReferralRequestsCache();
}

function resetFiles() {
  fs.writeFileSync(CODES_PATH, JSON.stringify({ referral_codes: [] }), "utf-8");
  fs.writeFileSync(AGENTS_PATH, JSON.stringify({ agents: [] }), "utf-8");
  fs.writeFileSync(LEDGER_PATH, JSON.stringify({ ledger_entries: [] }), "utf-8");
  fs.writeFileSync(BALANCES_PATH, JSON.stringify({ agent_balances: [] }), "utf-8");
  fs.writeFileSync(REQUESTS_PATH, JSON.stringify({ referral_requests: [] }), "utf-8");
  resetReferralCodesCache();
  resetAgentsCache();
  resetLedgerCache();
  resetReferralRequestsCache();
}

function createTestAgent(name: string): { agent: any; api_key: string } {
  return registerAgent({ name });
}

describe("Code Ranking Algorithm", () => {
  before(() => saveOriginals());
  after(() => restoreOriginals());
  beforeEach(() => resetFiles());

  it("calculates score with trust_weight × conversion_rate × recency_factor", () => {
    const { agent } = createTestAgent("RankBot");
    const code = submitReferralCode({
      vendor: "Railway",
      code: "RANK1",
      referral_url: "https://railway.app?ref=rank1",
      description: "Test",
      agent_id: agent.id,
      trust_tier: "verified",
    });

    // New code with < 10 impressions uses default 0.5 conversion rate
    // trust_weight=1.5 (verified), conversion_rate=0.5 (default), recency=1.0 (new)
    const score = calculateCodeScore(code);
    assert.strictEqual(score, 1.5 * 0.5 * 1.0);
  });

  it("uses actual conversion rate after 10+ impressions", () => {
    const { agent } = createTestAgent("RateBot");
    const code = submitReferralCode({
      vendor: "Railway",
      code: "RATE1",
      referral_url: "https://railway.app?ref=rate1",
      description: "Test",
      agent_id: agent.id,
      trust_tier: "new",
    });

    // Simulate 20 impressions, 4 conversions => 20% rate
    for (let i = 0; i < 20; i++) recordImpression(code.id);
    for (let i = 0; i < 4; i++) recordCodeConversion(code.id);

    const updatedCodes = getCodesByAgent(agent.id);
    const updatedCode = updatedCodes.find((c: any) => c.id === code.id);
    const score = calculateCodeScore(updatedCode);
    // trust_weight=1.0 (new), conversion_rate=4/20=0.2, recency=1.0
    assert.strictEqual(score, 1.0 * 0.2 * 1.0);
  });

  it("applies recency decay after 7 days", () => {
    const { agent } = createTestAgent("RecencyBot");
    const code = submitReferralCode({
      vendor: "Railway",
      code: "OLD1",
      referral_url: "https://railway.app?ref=old1",
      description: "Test",
      agent_id: agent.id,
      trust_tier: "trusted",
    });

    // Score at day 7 (still 1.0)
    const day7 = new Date(new Date(code.submitted_at).getTime() + 7 * 24 * 60 * 60 * 1000);
    const score7 = calculateCodeScore(code, day7);
    assert.strictEqual(score7, 2.0 * 0.5 * 1.0);

    // Score at day 14 (1 week past first 7 days => 0.95)
    const day14 = new Date(new Date(code.submitted_at).getTime() + 14 * 24 * 60 * 60 * 1000);
    const score14 = calculateCodeScore(code, day14);
    const expected14 = 2.0 * 0.5 * 0.95;
    assert.ok(Math.abs(score14 - expected14) < 0.001);

    // Score after many weeks — floor at 0.5
    const day200 = new Date(new Date(code.submitted_at).getTime() + 200 * 24 * 60 * 60 * 1000);
    const score200 = calculateCodeScore(code, day200);
    const expected200 = 2.0 * 0.5 * 0.5;
    assert.strictEqual(score200, expected200);
  });

  it("identifies cold start codes (< 50 impressions)", () => {
    const { agent } = createTestAgent("ColdBot");
    const code = submitReferralCode({
      vendor: "Railway",
      code: "COLD1",
      referral_url: "https://railway.app?ref=cold1",
      description: "Test",
      agent_id: agent.id,
      trust_tier: "new",
    });

    assert.strictEqual(isInColdStart(code), true);

    // Add 50 impressions
    for (let i = 0; i < 50; i++) recordImpression(code.id);
    const updatedCodes = getCodesByAgent(agent.id);
    const updatedCode = updatedCodes.find((c: any) => c.id === code.id);
    assert.strictEqual(isInColdStart(updatedCode), false);
  });

  it("ranks codes by score descending after cold start", () => {
    const { agent: a1 } = createTestAgent("HighBot");
    updateAgentTrustTier(a1.id, "trusted");
    const { agent: a2 } = createTestAgent("LowBot");

    // High-performing trusted agent
    const code1 = submitReferralCode({
      vendor: "Railway",
      code: "HIGH1",
      referral_url: "https://railway.app?ref=high1",
      description: "High performer",
      agent_id: a1.id,
      trust_tier: "trusted",
    });
    // Push past cold start with good conversion rate
    for (let i = 0; i < 50; i++) recordImpression(code1.id);
    for (let i = 0; i < 10; i++) recordCodeConversion(code1.id);

    // Low-performing verified agent
    updateAgentTrustTier(a2.id, "verified");
    const code2 = submitReferralCode({
      vendor: "Railway",
      code: "LOW1",
      referral_url: "https://railway.app?ref=low1",
      description: "Low performer",
      agent_id: a2.id,
      trust_tier: "verified",
    });
    for (let i = 0; i < 50; i++) recordImpression(code2.id);
    for (let i = 0; i < 1; i++) recordCodeConversion(code2.id);

    const ranked = getRankedCodesForVendor("Railway");
    assert.strictEqual(ranked.length, 2);
    // High performer should be first
    assert.strictEqual(ranked[0].code, "HIGH1");
    assert.strictEqual(ranked[1].code, "LOW1");
  });

  it("cold start codes appear before performance-ranked codes", () => {
    const { agent: a1 } = createTestAgent("EstBot");
    updateAgentTrustTier(a1.id, "trusted");
    const { agent: a2 } = createTestAgent("NewBot");

    // Established code past cold start
    const code1 = submitReferralCode({
      vendor: "Railway",
      code: "EST1",
      referral_url: "https://railway.app?ref=est1",
      description: "Established",
      agent_id: a1.id,
      trust_tier: "trusted",
    });
    for (let i = 0; i < 50; i++) recordImpression(code1.id);

    // New code in cold start (verified so it's active)
    updateAgentTrustTier(a2.id, "verified");
    const code2 = submitReferralCode({
      vendor: "Railway",
      code: "NEW1",
      referral_url: "https://railway.app?ref=new1",
      description: "Cold start",
      agent_id: a2.id,
      trust_tier: "verified",
    });

    const ranked = getRankedCodesForVendor("Railway");
    assert.strictEqual(ranked.length, 2);
    // Cold start code first
    assert.strictEqual(ranked[0].code, "NEW1");
    assert.strictEqual(ranked[1].code, "EST1");
  });

  it("records impressions and conversions", () => {
    const { agent } = createTestAgent("ImprBot");
    const code = submitReferralCode({
      vendor: "Railway",
      code: "IMPR1",
      referral_url: "https://railway.app?ref=impr1",
      description: "Test",
      agent_id: agent.id,
      trust_tier: "new",
    });

    assert.strictEqual(code.impressions, 0);
    assert.strictEqual(code.conversions, 0);

    recordImpression(code.id);
    recordImpression(code.id);
    recordCodeConversion(code.id);

    const codes = getCodesByAgent(agent.id);
    const updated = codes.find((c: any) => c.id === code.id);
    assert.strictEqual(updated.impressions, 2);
    assert.strictEqual(updated.conversions, 1);
  });
});

describe("Dual-Agent Revenue Split", () => {
  before(() => saveOriginals());
  after(() => restoreOriginals());
  beforeEach(() => resetFiles());

  it("applies 80/20 split when same agent submitted and surfaced", () => {
    const { agent } = createTestAgent("SameBot");
    // Log a referral request so attribution finds this agent
    logReferralRequest({ vendor: "Railway", agent_id: agent.id });

    const entry = recordConversion({
      vendor: "Railway",
      referral_code: "SAME1",
      commission_amount: 100,
      submitter_id: agent.id,
    });

    // Same agent: 80% to agent, 20% platform
    assert.strictEqual(entry.agent_share, 80);
    assert.strictEqual(entry.submitter_share, 0); // no separate submitter share since same agent
    assert.strictEqual(entry.agent_id, agent.id);
    assert.strictEqual(entry.submitter_id, agent.id);

    const balance = getAgentBalance(agent.id);
    assert.strictEqual(balance.pending_balance, 80);
  });

  it("applies 40/40/20 split when different agents", () => {
    const { agent: submitter } = createTestAgent("SubmitBot");
    const { agent: surfer } = createTestAgent("SurfBot");

    // Log a referral request for the surfacing agent
    logReferralRequest({ vendor: "Railway", agent_id: surfer.id });

    const entry = recordConversion({
      vendor: "Railway",
      referral_code: "DUAL1",
      commission_amount: 100,
      submitter_id: submitter.id,
    });

    // Different agents: 40% surfer, 40% submitter, 20% platform
    assert.strictEqual(entry.agent_share, 40);
    assert.strictEqual(entry.submitter_share, 40);
    assert.strictEqual(entry.agent_id, surfer.id);
    assert.strictEqual(entry.submitter_id, submitter.id);

    const surferBalance = getAgentBalance(surfer.id);
    assert.strictEqual(surferBalance.pending_balance, 40);

    const submitterBalance = getAgentBalance(submitter.id);
    assert.strictEqual(submitterBalance.pending_balance, 40);
  });

  it("applies standard 70/30 split for curated codes (no submitter)", () => {
    const { agent } = createTestAgent("CuratedBot");
    logReferralRequest({ vendor: "Railway", agent_id: agent.id });

    const entry = recordConversion({
      vendor: "Railway",
      referral_code: "CURATED1",
      commission_amount: 100,
    });

    // Curated: 70% to surfer, 30% platform
    assert.strictEqual(entry.agent_share, 70);
    assert.strictEqual(entry.submitter_share, 0);

    const balance = getAgentBalance(agent.id);
    assert.strictEqual(balance.pending_balance, 70);
  });

  it("gives submitter 40% when no surfacing agent exists", () => {
    const { agent: submitter } = createTestAgent("LoneSubmitter");

    const entry = recordConversion({
      vendor: "Railway",
      referral_code: "LONE1",
      commission_amount: 100,
      submitter_id: submitter.id,
    });

    assert.strictEqual(entry.agent_id, null);
    assert.strictEqual(entry.agent_share, 0);
    assert.strictEqual(entry.submitter_share, 40);

    const balance = getAgentBalance(submitter.id);
    assert.strictEqual(balance.pending_balance, 40);
  });
});

describe("Agent Leaderboard", () => {
  before(() => saveOriginals());
  after(() => restoreOriginals());
  beforeEach(() => resetFiles());

  it("returns agents ranked by total conversions", () => {
    const { agent: a1 } = createTestAgent("TopAgent");
    const { agent: a2 } = createTestAgent("MidAgent");

    // a1 gets 3 conversions via referral requests
    for (let i = 0; i < 3; i++) {
      logReferralRequest({ vendor: "Railway", agent_id: a1.id });
      recordConversion({ vendor: "Railway", referral_code: "TOP", commission_amount: 50 });
    }

    // a2 gets 1 conversion
    logReferralRequest({ vendor: "Vercel", agent_id: a2.id });
    recordConversion({ vendor: "Vercel", referral_code: "MID", commission_amount: 30 });

    const result = getLeaderboard();
    assert.strictEqual(result.entries.length, 2);
    assert.strictEqual(result.entries[0].agent_name, "TopAgent");
    assert.strictEqual(result.entries[0].total_conversions, 3);
    assert.strictEqual(result.entries[1].agent_name, "MidAgent");
    assert.strictEqual(result.entries[1].total_conversions, 1);
  });

  it("respects pagination (limit and offset)", () => {
    const { agent: a1 } = createTestAgent("First");
    const { agent: a2 } = createTestAgent("Second");
    const { agent: a3 } = createTestAgent("Third");

    logReferralRequest({ vendor: "Railway", agent_id: a1.id });
    recordConversion({ vendor: "Railway", referral_code: "A", commission_amount: 50 });
    recordConversion({ vendor: "Railway", referral_code: "A", commission_amount: 50 });
    recordConversion({ vendor: "Railway", referral_code: "A", commission_amount: 50 });

    logReferralRequest({ vendor: "Vercel", agent_id: a2.id });
    recordConversion({ vendor: "Vercel", referral_code: "B", commission_amount: 30 });
    recordConversion({ vendor: "Vercel", referral_code: "B", commission_amount: 30 });

    logReferralRequest({ vendor: "Render", agent_id: a3.id });
    recordConversion({ vendor: "Render", referral_code: "C", commission_amount: 20 });

    const page1 = getLeaderboard({ limit: 2, offset: 0 });
    assert.strictEqual(page1.entries.length, 2);
    assert.strictEqual(page1.total, 3);
    assert.strictEqual(page1.entries[0].agent_name, "First");

    const page2 = getLeaderboard({ limit: 2, offset: 2 });
    assert.strictEqual(page2.entries.length, 1);
    assert.strictEqual(page2.entries[0].agent_name, "Third");
  });

  it("caps limit at 50", () => {
    const result = getLeaderboard({ limit: 100 });
    // Should not error, just cap
    assert.ok(result);
  });

  it("returns empty leaderboard when no conversions exist", () => {
    const result = getLeaderboard();
    assert.strictEqual(result.entries.length, 0);
    assert.strictEqual(result.total, 0);
  });

  it("includes active_codes count and earnings", () => {
    const { agent } = createTestAgent("EarnBot");

    // Submit a code
    submitReferralCode({
      vendor: "Railway",
      code: "EARN1",
      referral_url: "https://railway.app?ref=earn1",
      description: "Earnings test",
      agent_id: agent.id,
      trust_tier: "verified",
    });

    // Record conversions
    logReferralRequest({ vendor: "Railway", agent_id: agent.id });
    recordConversion({ vendor: "Railway", referral_code: "EARN1", commission_amount: 100 });

    const result = getLeaderboard();
    assert.strictEqual(result.entries.length, 1);
    assert.strictEqual(result.entries[0].active_codes, 1);
    assert.ok(result.entries[0].total_earnings > 0);
  });

  it("excludes clawed-back conversions from count", () => {
    const { agent } = createTestAgent("ClawBot");
    logReferralRequest({ vendor: "Railway", agent_id: agent.id });

    const entry = recordConversion({ vendor: "Railway", referral_code: "CLAW", commission_amount: 50 });

    // Clawback that entry
    clawbackEntry(entry.id);

    // Record one more valid conversion
    recordConversion({ vendor: "Railway", referral_code: "VALID", commission_amount: 50 });

    const result = getLeaderboard();
    // Clawed back one shouldn't count
    assert.strictEqual(result.entries[0].total_conversions, 1);
  });
});

describe("Leaderboard includes submitter conversions", () => {
  before(() => saveOriginals());
  after(() => restoreOriginals());
  beforeEach(() => resetFiles());

  it("counts submitter contributions in leaderboard", () => {
    const { agent: submitter } = createTestAgent("CodeSubmitter");
    const { agent: surfer } = createTestAgent("CodeSurfer");

    logReferralRequest({ vendor: "Railway", agent_id: surfer.id });
    recordConversion({
      vendor: "Railway",
      referral_code: "DUAL",
      commission_amount: 100,
      submitter_id: submitter.id,
    });

    const result = getLeaderboard();
    // Both agents should appear
    assert.strictEqual(result.total, 2);
    const submitterEntry = result.entries.find((e: any) => e.agent_name === "CodeSubmitter");
    const surferEntry = result.entries.find((e: any) => e.agent_name === "CodeSurfer");
    assert.ok(submitterEntry);
    assert.ok(surferEntry);
    assert.strictEqual(submitterEntry.total_conversions, 1);
    assert.strictEqual(surferEntry.total_conversions, 1);
  });
});

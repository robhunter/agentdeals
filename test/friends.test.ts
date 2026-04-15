import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRIENDS_PATH = path.join(__dirname, "..", "data", "agent_friends.json");
const AGENTS_PATH = path.join(__dirname, "..", "data", "agents.json");
const CODES_PATH = path.join(__dirname, "..", "data", "referral_codes.json");

const { addFriend, removeFriend, getFriends, getFriendIds, isFriend, getFriendCodesForVendors, selectCodeWithFriendPreference, resetFriendsCache } = await import("../dist/friends.js");
const { registerAgent, resetAgentsCache } = await import("../dist/agents.js");
const { submitReferralCode, resetReferralCodesCache, getRankedCodesForVendor } = await import("../dist/referral-codes.js");

let savedAgents: string | null = null;
let savedCodes: string | null = null;
let savedFriends: string | null = null;

function backupFiles() {
  savedAgents = fs.existsSync(AGENTS_PATH) ? fs.readFileSync(AGENTS_PATH, "utf-8") : null;
  savedCodes = fs.existsSync(CODES_PATH) ? fs.readFileSync(CODES_PATH, "utf-8") : null;
  savedFriends = fs.existsSync(FRIENDS_PATH) ? fs.readFileSync(FRIENDS_PATH, "utf-8") : null;
}

function restoreFiles() {
  if (savedAgents !== null) fs.writeFileSync(AGENTS_PATH, savedAgents, "utf-8");
  else if (fs.existsSync(AGENTS_PATH)) fs.unlinkSync(AGENTS_PATH);
  if (savedCodes !== null) fs.writeFileSync(CODES_PATH, savedCodes, "utf-8");
  else if (fs.existsSync(CODES_PATH)) fs.unlinkSync(CODES_PATH);
  if (savedFriends !== null) fs.writeFileSync(FRIENDS_PATH, savedFriends, "utf-8");
  else if (fs.existsSync(FRIENDS_PATH)) fs.unlinkSync(FRIENDS_PATH);
  resetAgentsCache();
  resetReferralCodesCache();
  resetFriendsCache();
}

function resetAll() {
  fs.writeFileSync(AGENTS_PATH, JSON.stringify({ agents: [] }), "utf-8");
  fs.writeFileSync(CODES_PATH, JSON.stringify({ referral_codes: [] }), "utf-8");
  fs.writeFileSync(FRIENDS_PATH, JSON.stringify({ agent_friends: [] }), "utf-8");
  resetAgentsCache();
  resetReferralCodesCache();
  resetFriendsCache();
}

function createTestAgent(name: string) {
  return registerAgent({ name });
}

describe("Agent Friendship Network", () => {
  beforeEach(() => {
    backupFiles();
    resetAll();
  });

  after(() => {
    restoreFiles();
  });

  describe("addFriend", () => {
    it("creates a one-directional friendship", () => {
      const a = createTestAgent("AgentA");
      const b = createTestAgent("AgentB");
      const friendship = addFriend(a.agent.id, b.agent.id);
      assert.strictEqual(friendship.agent_id, a.agent.id);
      assert.strictEqual(friendship.friend_id, b.agent.id);
      assert.ok(friendship.created_at);
    });

    it("friendship is one-directional (A→B does not imply B→A)", () => {
      const a = createTestAgent("AgentA2");
      const b = createTestAgent("AgentB2");
      addFriend(a.agent.id, b.agent.id);
      assert.ok(isFriend(a.agent.id, b.agent.id));
      assert.ok(!isFriend(b.agent.id, a.agent.id));
    });

    it("rejects self-friending", () => {
      const a = createTestAgent("SelfBot");
      assert.throws(
        () => addFriend(a.agent.id, a.agent.id),
        /Cannot add yourself/
      );
    });

    it("rejects friending non-existent agent", () => {
      const a = createTestAgent("LoneBot");
      assert.throws(
        () => addFriend(a.agent.id, "agent_nonexistent"),
        /not found/
      );
    });

    it("rejects duplicate friendship", () => {
      const a = createTestAgent("DupA");
      const b = createTestAgent("DupB");
      addFriend(a.agent.id, b.agent.id);
      assert.throws(
        () => addFriend(a.agent.id, b.agent.id),
        /Already friends/
      );
    });

    it("allows bidirectional friendships (both directions)", () => {
      const a = createTestAgent("BiA");
      const b = createTestAgent("BiB");
      addFriend(a.agent.id, b.agent.id);
      addFriend(b.agent.id, a.agent.id);
      assert.ok(isFriend(a.agent.id, b.agent.id));
      assert.ok(isFriend(b.agent.id, a.agent.id));
    });
  });

  describe("removeFriend", () => {
    it("removes an existing friendship", () => {
      const a = createTestAgent("RemA");
      const b = createTestAgent("RemB");
      addFriend(a.agent.id, b.agent.id);
      assert.ok(isFriend(a.agent.id, b.agent.id));
      removeFriend(a.agent.id, b.agent.id);
      assert.ok(!isFriend(a.agent.id, b.agent.id));
    });

    it("throws when friendship does not exist", () => {
      const a = createTestAgent("NoFriendA");
      const b = createTestAgent("NoFriendB");
      assert.throws(
        () => removeFriend(a.agent.id, b.agent.id),
        /not found/
      );
    });
  });

  describe("getFriends / getFriendIds", () => {
    it("returns all friends for an agent", () => {
      const a = createTestAgent("ListA");
      const b = createTestAgent("ListB");
      const c = createTestAgent("ListC");
      addFriend(a.agent.id, b.agent.id);
      addFriend(a.agent.id, c.agent.id);
      const friends = getFriends(a.agent.id);
      assert.strictEqual(friends.length, 2);
      const ids = getFriendIds(a.agent.id);
      assert.ok(ids.includes(b.agent.id));
      assert.ok(ids.includes(c.agent.id));
    });

    it("returns empty array for agent with no friends", () => {
      const a = createTestAgent("NoFriendsBot");
      assert.deepStrictEqual(getFriends(a.agent.id), []);
      assert.deepStrictEqual(getFriendIds(a.agent.id), []);
    });
  });

  describe("isFriend", () => {
    it("returns true for existing friendship", () => {
      const a = createTestAgent("IsA");
      const b = createTestAgent("IsB");
      addFriend(a.agent.id, b.agent.id);
      assert.ok(isFriend(a.agent.id, b.agent.id));
    });

    it("returns false for non-existing friendship", () => {
      const a = createTestAgent("NotA");
      const b = createTestAgent("NotB");
      assert.ok(!isFriend(a.agent.id, b.agent.id));
    });
  });

  describe("selectCodeWithFriendPreference", () => {
    it("returns original ranking when agent has no friends", () => {
      const a = createTestAgent("NoFriendPref");
      const mockCodes = [{ id: "code1", submitted_by: "other" }] as any[];
      const result = selectCodeWithFriendPreference("SomeVendor", a.agent.id, mockCodes);
      assert.deepStrictEqual(result, mockCodes);
    });

    it("returns original ranking when agentId is null", () => {
      const mockCodes = [{ id: "code1" }] as any[];
      const result = selectCodeWithFriendPreference("SomeVendor", null, mockCodes);
      assert.deepStrictEqual(result, mockCodes);
    });

    it("prefers friend codes over non-friend codes", () => {
      const a = createTestAgent("PrefA");
      const b = createTestAgent("PrefB");
      const c = createTestAgent("PrefC");
      addFriend(a.agent.id, b.agent.id);

      submitReferralCode({
        vendor: "GitHub",
        code: "FRIEND-CODE",
        referral_url: "https://github.com/ref/friend",
        description: "Friend code",
        agent_id: b.agent.id,
        trust_tier: "verified",
      });

      submitReferralCode({
        vendor: "GitHub",
        code: "OTHER-CODE",
        referral_url: "https://github.com/ref/other",
        description: "Other code",
        agent_id: c.agent.id,
        trust_tier: "verified",
      });

      const rankedCodes = getRankedCodesForVendor("GitHub");
      const result = selectCodeWithFriendPreference("GitHub", a.agent.id, rankedCodes);

      assert.ok(result.length >= 2);
      assert.strictEqual(result[0].submitted_by, b.agent.id);
    });

    it("falls back to normal ranking when no friends have codes for the vendor", () => {
      const a = createTestAgent("FallbackA");
      const b = createTestAgent("FallbackB");
      const c = createTestAgent("FallbackC");
      addFriend(a.agent.id, b.agent.id);

      submitReferralCode({
        vendor: "GitHub",
        code: "NONFRIEND-CODE",
        referral_url: "https://github.com/ref/nonfriend",
        description: "Non-friend code",
        agent_id: c.agent.id,
        trust_tier: "verified",
      });

      const rankedCodes = getRankedCodesForVendor("GitHub");
      const result = selectCodeWithFriendPreference("GitHub", a.agent.id, rankedCodes);
      assert.deepStrictEqual(result, rankedCodes);
    });
  });

  describe("getFriendCodesForVendors", () => {
    it("returns vendors where friends have active codes", () => {
      const a = createTestAgent("VendorA");
      const b = createTestAgent("VendorB");
      addFriend(a.agent.id, b.agent.id);

      submitReferralCode({
        vendor: "GitHub",
        code: "GH-FRIEND",
        referral_url: "https://github.com/ref",
        description: "GitHub friend code",
        agent_id: b.agent.id,
        trust_tier: "verified",
      });

      const result = getFriendCodesForVendors(a.agent.id);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].vendor, "GitHub");
      assert.strictEqual(result[0].codes.length, 1);
      assert.strictEqual(result[0].codes[0].agent_id, b.agent.id);
    });

    it("returns empty array when no friends", () => {
      const a = createTestAgent("NoFriendVendor");
      const result = getFriendCodesForVendors(a.agent.id);
      assert.deepStrictEqual(result, []);
    });

    it("returns empty when friends have no codes", () => {
      const a = createTestAgent("NoCodeA");
      const b = createTestAgent("NoCodeB");
      addFriend(a.agent.id, b.agent.id);
      const result = getFriendCodesForVendors(a.agent.id);
      assert.deepStrictEqual(result, []);
    });
  });

  describe("persistence", () => {
    it("friendships persist across cache resets", () => {
      const a = createTestAgent("PersistA");
      const b = createTestAgent("PersistB");
      addFriend(a.agent.id, b.agent.id);
      resetFriendsCache();
      assert.ok(isFriend(a.agent.id, b.agent.id));
    });

    it("data file is valid JSON", () => {
      const a = createTestAgent("JsonA");
      const b = createTestAgent("JsonB");
      addFriend(a.agent.id, b.agent.id);
      const raw = fs.readFileSync(FRIENDS_PATH, "utf-8");
      const data = JSON.parse(raw);
      assert.ok(Array.isArray(data.agent_friends));
      assert.strictEqual(data.agent_friends.length, 1);
    });
  });
});

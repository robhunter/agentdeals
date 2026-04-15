import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentById } from "./agents.js";
import { getActiveCodesForVendor, getAllActiveCodes, calculateCodeScore, type SubmittedReferralCode } from "./referral-codes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRIENDS_PATH = path.join(__dirname, "..", "data", "agent_friends.json");

export interface AgentFriendship {
  agent_id: string;
  friend_id: string;
  created_at: string;
}

let cachedFriends: AgentFriendship[] | null = null;

function loadFriends(): AgentFriendship[] {
  if (cachedFriends) return cachedFriends;

  if (!fs.existsSync(FRIENDS_PATH)) {
    cachedFriends = [];
    return cachedFriends;
  }

  try {
    const raw = fs.readFileSync(FRIENDS_PATH, "utf-8");
    const data = JSON.parse(raw) as { agent_friends?: AgentFriendship[] };
    cachedFriends = Array.isArray(data.agent_friends) ? data.agent_friends : [];
  } catch {
    cachedFriends = [];
  }
  return cachedFriends;
}

function saveFriends(friends: AgentFriendship[]): void {
  fs.writeFileSync(FRIENDS_PATH, JSON.stringify({ agent_friends: friends }, null, 2), "utf-8");
  cachedFriends = friends;
}

export function resetFriendsCache(): void {
  cachedFriends = null;
}

const MAX_FRIENDS = 100;

export function addFriend(agentId: string, friendId: string): AgentFriendship {
  if (agentId === friendId) {
    throw new Error("Cannot add yourself as a friend");
  }

  const friend = getAgentById(friendId);
  if (!friend || friend.status !== "active") {
    throw new Error("Friend agent not found or inactive");
  }

  const friends = loadFriends();

  const existing = friends.find(f => f.agent_id === agentId && f.friend_id === friendId);
  if (existing) {
    throw new Error("Already friends with this agent");
  }

  const agentFriendCount = friends.filter(f => f.agent_id === agentId).length;
  if (agentFriendCount >= MAX_FRIENDS) {
    throw new Error("Maximum friend limit reached (" + MAX_FRIENDS + ")");
  }

  const entry: AgentFriendship = {
    agent_id: agentId,
    friend_id: friendId,
    created_at: new Date().toISOString(),
  };

  friends.push(entry);
  saveFriends(friends);
  return entry;
}

export function removeFriend(agentId: string, friendId: string): void {
  const friends = loadFriends();
  const idx = friends.findIndex(f => f.agent_id === agentId && f.friend_id === friendId);
  if (idx === -1) {
    throw new Error("Friendship not found");
  }
  friends.splice(idx, 1);
  saveFriends(friends);
}

export function getFriends(agentId: string): AgentFriendship[] {
  return loadFriends().filter(f => f.agent_id === agentId);
}

export function getFriendIds(agentId: string): string[] {
  return getFriends(agentId).map(f => f.friend_id);
}

export function isFriend(agentId: string, friendId: string): boolean {
  return loadFriends().some(f => f.agent_id === agentId && f.friend_id === friendId);
}

export interface FriendVendorCodes {
  vendor: string;
  codes: { agent_id: string; agent_name: string; code_id: string }[];
}

export function getFriendCodesForVendors(agentId: string): FriendVendorCodes[] {
  const friendIds = getFriendIds(agentId);
  if (friendIds.length === 0) return [];

  const friendSet = new Set(friendIds);
  const allCodes = getAllActiveCodes();

  const byVendor = new Map<string, FriendVendorCodes>();

  for (const code of allCodes) {
    if (!friendSet.has(code.submitted_by)) continue;

    const vendorKey = code.vendor.toLowerCase();
    let entry = byVendor.get(vendorKey);
    if (!entry) {
      entry = { vendor: code.vendor, codes: [] };
      byVendor.set(vendorKey, entry);
    }

    const agent = getAgentById(code.submitted_by);
    entry.codes.push({
      agent_id: code.submitted_by,
      agent_name: agent?.name ?? "Unknown",
      code_id: code.id,
    });
  }

  return Array.from(byVendor.values());
}

export function selectCodeWithFriendPreference(
  vendorName: string,
  agentId: string | null,
  rankedCodes: SubmittedReferralCode[],
  now?: Date,
): SubmittedReferralCode[] {
  if (!agentId) return rankedCodes;

  const friendIds = getFriendIds(agentId);
  if (friendIds.length === 0) return rankedCodes;

  const friendSet = new Set(friendIds);

  const activeCodes = getActiveCodesForVendor(vendorName);
  const friendCodes = activeCodes.filter(c => friendSet.has(c.submitted_by));

  if (friendCodes.length === 0) return rankedCodes;

  friendCodes.sort((a, b) => calculateCodeScore(b, now) - calculateCodeScore(a, now));

  const nonFriendCodes = rankedCodes.filter(c => !friendSet.has(c.submitted_by));

  return [...friendCodes, ...nonFriendCodes];
}

export interface McpToolEntry {
  name: string;
  card: string;
  brief: string;
}

export interface WithdrawnMcpTool {
  name: string;
  reason: string;
}

export const MCP_TOOLS: readonly McpToolEntry[] = [
  {
    name: "search_deals",
    card: "Find free tiers, browse categories, get vendor details with alternatives. Filter by category, eligibility, or keyword.",
    brief: "Find free tiers, startup credits, and developer deals. Search by keyword, category, vendor name, or eligibility type. Returns verified deal details with specific limits.",
  },
  {
    name: "plan_stack",
    card: "Get stack recommendations, cost estimates, or a full infrastructure audit for your project.",
    brief: "Plan a technology stack with cost-optimized choices. Per role, returns the set of free-tier offers whose terms we can stand behind today — not a single pick — with the recorded facts behind any demotion. Does not model technical fit; the caller applies that. Also estimates costs at scale and audits existing stacks for risk.",
  },
  {
    name: "compare_vendors",
    card: "Compare 2 vendors side-by-side or check a single vendor's pricing risk.",
    brief: "Compare developer tools side by side — free tier limits, pricing tiers, risk levels, and recent pricing changes.",
  },
  {
    name: "track_changes",
    card: "Track pricing changes, upcoming expirations, and new deals. Weekly digest with no params.",
    brief: "Track pricing changes across developer tools — free tier removals, limit reductions, new free tiers, and upcoming expirations.",
  },
  {
    name: "get_referral_code",
    card: "Look up the referral link we hold for a vendor, with the conditions attached to it. We hold codes for a handful of vendors.",
    brief: "Look up the referral link we hold for a vendor, with the reader benefit and every restriction attached to it. We hold codes for a handful of vendors and earn a commission on them; /disclosure lists all of them.",
  },
] as const;

export const MCP_TOOLS_WITHDRAWN: readonly WithdrawnMcpTool[] = [
  { name: "register_agent", reason: "The agent marketplace is retired. A key it issued did not survive a deploy and no capability now reads one." },
  { name: "submit_referral_code", reason: "The agent marketplace is retired. No response carries a submitted code, so accepting one publishes nothing." },
  { name: "my_referral_codes", reason: "The agent marketplace is retired. Nothing can hold a submitted code to report on." },
  { name: "check_balance", reason: "The agent marketplace is retired. No path credits a balance, so every answer was zero." },
  { name: "request_payout", reason: "The agent marketplace is retired. No transfer provider was ever configured, so no call could move money." },
  { name: "leaderboard", reason: "The agent marketplace is retired. It ranked agents by conversions and no conversion was ever recorded." },
  { name: "manage_friends", reason: "The agent marketplace is retired. Friendships routed submitted codes preferentially and no submitted code is served." },
] as const;

export const MCP_TOOL_COUNT = MCP_TOOLS.length;

export const MCP_TOOL_NAMES: readonly string[] = MCP_TOOLS.map((t) => t.name);

export function mcpToolNameList(): string {
  const names = MCP_TOOLS.map((t) => `\`${t.name}\``);
  const last = names[names.length - 1];
  return `${names.slice(0, -1).join(", ")}, and ${last}`;
}

export function isPublishedMcpTool(name: string): boolean {
  return MCP_TOOL_NAMES.includes(name);
}

export function withdrawalReason(name: string): string | null {
  return MCP_TOOLS_WITHDRAWN.find((t) => t.name === name)?.reason ?? null;
}

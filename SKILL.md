---
name: agentdeals
description: Search and compare 1,500+ developer infrastructure deals — free tiers, startup credits, and pricing changes across 54 categories.
version: 1.0.0
metadata:
  openclaw:
    emoji: "\U0001F4B0"
    homepage: https://agentdeals.dev
---

# AgentDeals — Developer Infrastructure Deals for AI Agents

Search and compare free tiers, startup credits, and pricing changes across 1,500+ developer tools and services. 54 categories covering cloud, databases, CI/CD, monitoring, auth, AI/ML, and more.

## When to Use

Use this skill when:
- Evaluating technology options and want to know what's free
- Planning a tech stack and need cost-optimized choices
- Checking if a specific service has a free tier or startup credits
- Comparing vendors side-by-side (e.g., Supabase vs Firebase, Vercel vs Netlify)
- Tracking recent pricing changes (which free tiers were removed or degraded)

## Setup

AgentDeals is a remote MCP server. Add to your MCP client config:

```json
{
  "mcpServers": {
    "agentdeals": {
      "url": "https://agentdeals.dev/mcp"
    }
  }
}
```

No API key required. No environment variables needed.

## Tools

### search_deals
Find free tiers, startup credits, and developer deals. Search by keyword, category, vendor name, or eligibility type. Returns the terms we hold, with specific limits and the day each was last read.

### plan_stack
Plan a technology stack with cost-optimized choices. Per role, returns the set of free-tier offers whose terms we can stand behind today — not a single pick — with the recorded facts behind any demotion. Does not model technical fit; the caller applies that. Also estimates costs at scale and audits existing stacks for risk.

### compare_vendors
Compare developer tools side by side — free tier limits, pricing tiers, risk levels, and recent pricing changes.

### track_changes
Track pricing changes across developer tools — free tier removals, limit reductions, new free tiers, and upcoming expirations.

### get_referral_code
Look up the referral link we hold for a vendor, with the reader benefit and every restriction attached to it. We hold codes for a handful of vendors and earn a commission on them; /disclosure lists all of them.

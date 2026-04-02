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
Find free tiers, startup credits, and developer deals. Filter by category, vendor, or keyword. Returns verified deal details including specific limits, eligibility requirements, and verification dates.

### plan_stack
Plan a technology stack with cost-optimized infrastructure. Three modes: recommend (suggest services), estimate (cost analysis), audit (find savings and risks).

### compare_vendors
Compare developer tools side by side — free tier limits, pricing tiers, stability ratings, and recent pricing changes. Pass 1 vendor for a risk check, or 2 for a full comparison.

### track_changes
Track recent pricing changes across developer tools — removed free tiers, limit cuts, improvements, and upcoming expirations. Weekly digest format.

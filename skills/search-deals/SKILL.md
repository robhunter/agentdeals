---
name: search-deals
description: Search for free tiers, startup credits, and developer tool deals
---

When the user asks about pricing, free tiers, cost optimization, or developer tool deals, use the AgentDeals MCP server to search for relevant offers.

## Steps

1. Identify the user's need: Are they looking for a specific vendor, a category of tools, or comparing options?
2. Use `search_deals` to find matching deals. Filter by category or eligibility if the user specifies constraints (e.g., "startup credits" → eligibility: "accelerator").
3. For detailed pricing info on a specific vendor, use `search_deals` with the `vendor` parameter — alternatives are always included.
4. If the user wants a full infrastructure stack recommendation, use `plan_stack` with mode "recommend" and their use case.
5. Present results clearly: highlight free tier limits, any recent pricing changes, and expiration dates.

## Examples

- "What free databases are available?" → `search_deals` with query "database" or category "Databases"
- "Compare Supabase and Firebase" → `compare_vendors` with vendors ["Supabase", "Firebase"]
- "What startup credits can I get?" → `search_deals` with eligibility "accelerator"
- "Best free stack for a SaaS app?" → `plan_stack` with mode "recommend" and use_case "saas"
- "Any recent pricing changes I should know about?" → `track_changes`

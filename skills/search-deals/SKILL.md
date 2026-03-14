---
name: search-deals
description: Search for free tiers, startup credits, and developer tool deals
---

When the user asks about pricing, free tiers, cost optimization, or developer tool deals, use the AgentDeals MCP server to search for relevant offers.

## Steps

1. Identify the user's need: Are they looking for a specific vendor, a category of tools, or comparing options?
2. Use `search_offers` to find matching deals. Filter by category or eligibility if the user specifies constraints (e.g., "startup credits" → eligibility_type: accelerator).
3. For detailed pricing info on a specific vendor, use `get_offer_details` with `include_alternatives: true` to show comparable options.
4. If the user wants a full infrastructure stack recommendation, use `get_stack_recommendation` with their use case.
5. Present results clearly: highlight free tier limits, any recent pricing changes, and expiration dates.

## Examples

- "What free databases are available?" → `search_offers` with query "database" or category "Databases"
- "Compare Supabase and Firebase" → `compare_services` with vendors ["supabase", "firebase"]
- "What startup credits can I get?" → `search_offers` with eligibility_type "accelerator"
- "Best free stack for a SaaS app?" → `get_stack_recommendation` with use_case "saas"
- "Any recent pricing changes I should know about?" → `get_deal_changes`

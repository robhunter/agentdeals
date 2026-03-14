---
name: check-pricing-changes
description: Check recent developer tool pricing changes, free tier removals, and new deals
---

When the user asks about pricing changes, vendor risk, or wants to stay updated on developer tool pricing, use the AgentDeals MCP server to check for recent changes.

## Steps

1. Use `get_deal_changes` to retrieve recent pricing changes. Filter by vendor or change_type if the user is specific.
2. For risk assessment of a specific vendor, use `check_vendor_risk` to see pricing history, change frequency, and risk level.
3. To audit an entire stack, use `audit_stack` with the list of vendors the user is using.
4. Use `get_expiring_deals` to find deals or free tiers that are ending soon.
5. Highlight high-impact changes: free tier removals, significant price increases, and service shutdowns.

## Examples

- "Has anything changed with Heroku pricing?" → `get_deal_changes` filtered to vendor "heroku"
- "Is Vercel's free tier at risk?" → `check_vendor_risk` for "vercel"
- "Audit my stack: Supabase, Vercel, Clerk" → `audit_stack` with those vendors
- "Any deals expiring soon?" → `get_expiring_deals`

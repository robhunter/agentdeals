---
name: check-pricing-changes
description: Check recent developer tool pricing changes, free tier removals, and new deals
---

When the user asks about pricing changes, vendor risk, or wants to stay updated on developer tool pricing, use the AgentDeals MCP server to check for recent changes.

## Steps

1. Use `track_changes` to retrieve recent pricing changes. Filter by vendor or change_type if the user is specific.
2. For risk assessment of a specific vendor, use `compare_vendors` with a single vendor name to see pricing history, change frequency, and risk level.
3. To audit an entire stack, use `plan_stack` with mode "audit" and the list of vendors the user is using.
4. Use `track_changes` with `include_expiring: true` to find deals or free tiers that are ending soon.
5. Highlight high-impact changes: free tier removals, significant price increases, and service shutdowns.

## Examples

- "Has anything changed with Heroku pricing?" → `track_changes` filtered to vendor "heroku"
- "Is Vercel's free tier at risk?" → `compare_vendors` with vendors ["Vercel"]
- "Audit my stack: Supabase, Vercel, Clerk" → `plan_stack` with mode "audit" and services ["Supabase", "Vercel", "Clerk"]
- "Any deals expiring soon?" → `track_changes` with include_expiring: true

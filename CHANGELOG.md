# Changelog

## 0.2.0 (2026-03-14)

### New Features
- **`get_expiring_deals` tool** — Surface deals expiring within N days, with `days_until_expiry` for each result
- **`monitor-vendor-changes` prompt template** — Proactive vendor pricing monitoring workflow, orchestrates `check_vendor_risk` + `get_deal_changes` per vendor
- **`check_vendor_risk` tool** — Pricing stability scores with risk levels (stable/caution/risky) and safer alternatives
- **`audit_stack` tool** — Infrastructure savings and risk analysis across your entire stack
- **`compare_services` tool** — Side-by-side vendor comparison with free tier details and deal change history
- **`estimate_costs` tool** — Infrastructure budget planning at hobby/startup/growth scale

### Improvements
- Landing page updated with npm/npx installation options, Claude Desktop config example, and full tool list
- README updated with npm badges, all 11 tools with parameters, and complete REST API docs
- OpenAPI 3.0 spec covers all 13 REST endpoints
- LICENSE file added (MIT)
- Search relevance ranking with category-aware scoring

### Stats
- 11 MCP tools, 5 prompt templates, 13 REST endpoints
- 1,511 vendor offers across 53 categories
- 52 tracked pricing changes
- 167 passing tests

## 0.1.0 (2026-03-13)

Initial npm release.

### Features
- 5 MCP tools: `search_offers`, `get_categories`, `get_offer_details`, `get_deal_changes`, `get_new_offers`
- `get_stack_recommendation` tool for curated free-tier infrastructure stacks
- 4 prompt templates: `find-free-alternative`, `recommend-stack`, `check-pricing-changes`, `search-deals`
- REST API with 8 endpoints
- OpenAPI 3.0 spec for discoverability
- Streamable HTTP and stdio transports
- 1,511 vendor offers across 53 categories
- 52 tracked pricing changes
- Upstash Redis telemetry persistence

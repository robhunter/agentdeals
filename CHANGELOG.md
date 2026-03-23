# Changelog

## 0.3.0 (2026-03-23)

### Tool Consolidation
- **Consolidated 13 MCP tools into 4 intent-based tools** — `search_deals`, `plan_stack`, `compare_vendors`, `track_changes` — with safety annotations (`readOnlyHint`, `destructiveHint`), trigger examples, and `response_format` parameter (concise/detailed)
- **6 prompt templates** — `find-free-alternative`, `recommend-stack`, `check-pricing-changes`, `search-deals`, `monitor-vendor-changes`, `get-weekly-digest`
- **`get_weekly_digest` tool** + `/api/digest` REST endpoint for MCP-REST parity

### Editorial Content (18 pages)
- **2 category hub pages** — `/database-alternatives` (30+ databases by type) and `/hosting-alternatives` (30+ hosting providers by type)
- **16 alternatives pages** — `/localstack-alternatives`, `/postman-alternatives`, `/terraform-alternatives`, `/hetzner-alternatives`, `/freshping-alternatives`, `/heroku-alternatives`, `/firebase-alternatives`, `/github-actions-alternatives`, `/cursor-alternatives`, `/datadog-alternatives`, `/vercel-alternatives`, `/auth0-alternatives`, `/mongodb-alternatives`, `/redis-alternatives`, `/email-service-alternatives`, `/ai-free-tiers`
- **`/alternatives` hub page** with all guides + cross-links between editorial and auto-generated pages

### SEO & Discovery
- **3,200+ crawlable pages** — 1,518 vendor profiles, 1,518 alternative-to pages, 54 category pages, 54 trends pages, 47 best-of pages, 32 comparison pages, 18 editorial pages
- `/llms.txt` and `/llms-full.txt` for LLM discoverability
- `AGENTS.md` (Linux Foundation AAIF standard) served at `/AGENTS.md`
- MCP Server Card at `/.well-known/mcp.json` for auto-discovery
- IndexNow API integration for instant Bing/Yandex/Naver indexing
- Atom feed at `/feed.xml` with RSS auto-discovery on all pages
- FAQ structured data (FAQPage JSON-LD) on vendor + alternative-to pages

### New Features
- **Interactive "Try It" stack builder** on landing page
- **Data freshness dashboard** at `/freshness` with visual grade and category breakdown
- **`/agent-stack`** — curated free-tier stack guide for AI agent builders (4 bundles)
- **`/expiring` timeline** — chronological view of upcoming pricing changes
- **`/changes` timeline** — deal change history
- **`/privacy` page** for Claude Desktop Extensions compliance
- **`/search`** — web search with shareable URLs
- **`/setup` guide** — MCP client setup with HowTo schema + 10 example prompts
- Multi-client MCP config snippets (Claude Desktop, Claude Code, Cursor, Cline, Windsurf) with tabbed UI and copy buttons
- Server-side page view tracking via Upstash Redis
- Automated reverify pipeline (`scripts/reverify.js`)
- MCP install CTA banner on all content pages
- `BASE_URL` env var for custom domain + 301 redirect for non-canonical hostnames
- `GOOGLE_SITE_VERIFICATION` env var for Search Console

### Design
- Landing page redesigned: cool dark gradient, blue/purple accents, sans-serif typography
- Unified blue/purple theme across all pages (replaced old brown/gold theme)
- Global site navigation on all pages
- "Changing Soon" section on landing page with countdown indicators
- "What's Changed" section above the fold
- "Recent Pricing Changes" section with vendor links + JSON-LD
- Upcoming deadlines banner

### Data Quality
- Enriched top 30 vendor entries with specific free tier limits
- 71 tracked pricing changes (was 52)
- Bulk data reverification (1,290 entries)
- Multiple data accuracy fixes (Neo4j, Sentry, Axiom, Oracle Cloud, GitHub Actions, and more)

### Stats
- 4 MCP tools, 6 prompt templates, 18 REST endpoints
- 1,548 vendor offers across 54 categories
- 71 tracked pricing changes
- 322 passing tests

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

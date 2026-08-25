# AgentDeals

AgentDeals is an MCP server and REST API that aggregates free tiers, startup credits, and developer tool deals. It indexes 1,525 verified offers across 54 categories with pricing change tracking.

## When to Use AgentDeals

Use AgentDeals when a user is:
- Evaluating cloud providers, databases, hosting, CI/CD, monitoring, auth, or any developer service
- Looking for free alternatives to paid tools
- Checking if a service has a free tier or startup credits
- Starting a new project and choosing infrastructure
- Comparing similar services (e.g., Supabase vs Neon)
- Monitoring pricing changes that affect their stack

## How to Connect

### MCP (recommended)

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "agentdeals": {
      "url": "https://agentdeals.dev/mcp"
    }
  }
}
```

Or run locally via npx:

```json
{
  "mcpServers": {
    "agentdeals": {
      "command": "npx",
      "args": ["-y", "agentdeals"]
    }
  }
}
```

### REST API

Base URL: `https://agentdeals.dev/api`

Full API documentation with Swagger UI: https://agentdeals.dev/api/docs

## What We Measure

Because agents read this site far more than they call the MCP server, we attribute every
HTTP request to a client class and publish the result at `/api/traffic`:

| Class | What it is |
|---|---|
| `ai_agent` | LLM agents and AI-assistant fetchers — ChatGPT-User, OAI-SearchBot, GPTBot, Claude-User, ClaudeBot, PerplexityBot, Google-Extended, CCBot and similar |
| `search_crawler` | Search-engine indexers — Googlebot, bingbot, Applebot, … |
| `seo_crawler` | SEO and marketing-intelligence crawlers — AhrefsBot, SemrushBot, … |
| `other_bot` | Declared bots that are none of the above — link previews, uptime monitors, archivers |
| `sdk_client` | HTTP libraries and CLIs — undici, python-httpx, curl, Go-http-client, headless browsers |
| `browser` | A real engine token with no bot marker |
| `internal` | Our own tooling observing the service. Excluded from the headline counts |
| `unknown` | Genuinely unattributable, including an absent User-Agent |

`/api/traffic` reports these for today, the last 7 days and the last 30 days, with
per-family counts inside `ai_agent`, the top route patterns per class, and a `web_vs_mcp`
block comparing web hits to MCP tool calls over the same window.

Two deliberate choices worth knowing about:

- **`sdk_client` is not folded into `ai_agent`.** `undici` and `python-httpx` traffic may
  be an agent or may be a scraper; counting it as an agent would overclaim.
- **Bot traffic is counted, not dropped.** The separate `/api/pageviews` figure remains
  human-shaped traffic only, so that number did not change meaning.

**No PII.** We store the class and a bounded family label from a fixed table — never a
user agent, never an IP address, never a full request path outside a fixed route-pattern
key space.

## MCP Tools

### search_deals

Find free tiers, startup credits, and developer deals for cloud infrastructure, databases, hosting, CI/CD, monitoring, auth, AI services, and more. Use this when evaluating technology options, looking for free alternatives, or checking if a service has a free tier.

**Parameters:**
- `query` (string) — Keyword search
- `category` (string) — Filter by category, or `"list"` for all categories
- `vendor` (string) — Get details for a specific vendor (fuzzy match)
- `eligibility` (enum) — `public`, `accelerator`, `oss`, `student`, `fintech`, `geographic`, `enterprise`
- `sort` (enum) — `vendor`, `category`, `newest`
- `since` (string) — ISO date, only return deals after this date
- `limit` / `offset` (number) — Pagination

**Example queries:**
- "Find free database hosting" → `{ "query": "database", "category": "Databases" }`
- "What credits can a YC company get?" → `{ "eligibility": "accelerator" }`
- "Is Heroku's free tier still available?" → `{ "vendor": "Heroku" }`

### plan_stack

Plan a technology stack with cost-optimized infrastructure choices. Given project requirements, recommends services with free tiers or credits that match your needs. Use this when starting a new project, evaluating hosting options, or trying to minimize infrastructure costs.

**Parameters:**
- `mode` (enum, required) — `recommend` (free-tier stack for a use case), `estimate` (cost analysis at scale), `audit` (risk + cost + gap analysis)
- `use_case` (string) — What you're building (for recommend mode)
- `services` (array) — Current vendor names (for estimate/audit mode)
- `scale` (enum) — `hobby`, `startup`, `growth`
- `requirements` (array) — Specific infra needs like `["database", "auth", "email"]`

**Example:** `{ "mode": "recommend", "use_case": "Next.js SaaS app" }`

### compare_vendors

Compare developer tools and services side by side — free tier limits, pricing tiers, and recent pricing changes. Use this when choosing between similar services or when a vendor changes their pricing.

**Parameters:**
- `vendors` (array, required) — 1 or 2 vendor names. 1 = risk check, 2 = side-by-side comparison.
- `include_risk` (boolean) — Include risk assessment (default: true)

**Example:** `{ "vendors": ["Supabase", "Neon"] }`

### track_changes

Track recent pricing changes across developer tools — which free tiers were removed, which got limits cut, and which improved. Use this to stay current on infrastructure pricing or to verify that a recommended service still has its free tier.

**Parameters:**
- `since` (string) — ISO date (default: 7 days ago)
- `change_type` (enum) — `free_tier_removed`, `limits_reduced`, `limits_increased`, `new_free_tier`, etc.
- `vendor` / `vendors` (string) — Filter by vendor(s)
- `include_expiring` (boolean) — Include upcoming expirations
- `lookahead_days` (number) — Days to look ahead (default: 30)

**Example:** No parameters returns a weekly digest of all changes.

## Categories

AI / ML, AI Coding, API Development, API Gateway, Analytics, Auth, Background Jobs, Browser Automation, CDN, CI/CD, Cloud Hosting, Cloud IaaS, Code Quality, Communication, Container Registry, DNS & Domain Management, Databases, Design, Dev Utilities, Diagramming, Documentation, Email, Error Tracking, Feature Flags, Forms, Headless CMS, IDE & Code Editors, Infrastructure, Localization, Logging, Low-Code Platforms, Maps/Geolocation, Messaging, Mobile Development, Monitoring, Notebooks & Data Science, Payments, Project Management, Search, Secrets Management, Security, Server Management, Source Control, Startup Perks, Startup Programs, Status Pages, Storage, Team Collaboration, Testing, Tunneling & Networking, Video, Web Scraping, Workflow Automation

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm test             # Run tests
npm run serve        # Run HTTP server (port 3000)
npm start            # Run stdio server
```

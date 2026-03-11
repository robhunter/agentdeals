# AgentDeals

An MCP server that aggregates free tiers, startup credits, and developer tool deals — so your AI agent (or you) can find the best infrastructure offers without leaving the workflow.

AgentDeals indexes real, verified pricing data from 1,500+ developer infrastructure vendors across 38 categories. Connect any MCP-compatible client and search deals by keyword, category, or eligibility.

**Live:** [agentdeals-production.up.railway.app](https://agentdeals-production.up.railway.app)

## Quick Start

### 1. Connect your MCP client

Add AgentDeals to your client config (see [Client Configuration](#client-configuration) for all clients):

```json
{
  "mcpServers": {
    "agentdeals": {
      "url": "https://agentdeals-production.up.railway.app/mcp"
    }
  }
}
```

### 2. Try these example queries

**Find free database hosting:**
```
Use the search_offers tool to find database deals:
  query: "database"
  category: "Databases"
```

Returns Neon (0.5 GiB free Postgres), Supabase (500 MB), MongoDB Atlas (512 MB shared cluster), PlanetScale alternatives, and more.

**What pricing changes happened recently?**
```
Use the get_deal_changes tool:
  since: "2025-01-01"
```

Returns tracked changes like PlanetScale free tier removal, Heroku free dynos sunset, Render pricing restructure, and other shifts.

**Show deals I qualify for as a YC company:**
```
Use the search_offers tool:
  eligibility_type: "accelerator"
```

Returns AWS Activate, Google Cloud for Startups, Microsoft Founders Hub, Stripe Atlas credits, and 150+ other startup program deals.

## Client Configuration

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentdeals": {
      "url": "https://agentdeals-production.up.railway.app/mcp"
    }
  }
}
```

Config location:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

### Cursor

Add to Cursor MCP settings (`.cursor/mcp.json` in your project or global config):

```json
{
  "mcpServers": {
    "agentdeals": {
      "url": "https://agentdeals-production.up.railway.app/mcp"
    }
  }
}
```

### VS Code (GitHub Copilot)

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "agentdeals": {
      "type": "http",
      "url": "https://agentdeals-production.up.railway.app/mcp"
    }
  }
}
```

### Claude Code

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "agentdeals": {
      "type": "url",
      "url": "https://agentdeals-production.up.railway.app/mcp"
    }
  }
}
```

### Any MCP Client

Point your client to:
```
https://agentdeals-production.up.railway.app/mcp
```

Transport: Streamable HTTP (POST/GET/DELETE on `/mcp`).

## REST API

AgentDeals also provides a REST API for programmatic access without MCP.

### Search offers

```bash
# Search by keyword
curl "https://agentdeals-production.up.railway.app/api/offers?q=database&limit=5"

# Filter by category
curl "https://agentdeals-production.up.railway.app/api/offers?category=Databases&limit=10"

# Paginate results
curl "https://agentdeals-production.up.railway.app/api/offers?limit=20&offset=40"

# Combine search + category
curl "https://agentdeals-production.up.railway.app/api/offers?q=postgres&category=Databases"
```

Response:
```json
{
  "offers": [
    {
      "vendor": "Neon",
      "category": "Databases",
      "description": "Serverless Postgres with 0.5 GiB storage, 100 CU-hours/month compute on free tier",
      "tier": "Free",
      "url": "https://neon.com/pricing",
      "tags": ["database", "postgres", "serverless"]
    }
  ],
  "total": 142
}
```

### List categories

```bash
curl "https://agentdeals-production.up.railway.app/api/categories"
```

Response:
```json
{
  "categories": [
    { "name": "Cloud Hosting", "count": 45 },
    { "name": "Databases", "count": 38 },
    { "name": "Developer Tools", "count": 414 }
  ]
}
```

### Server stats

```bash
curl "https://agentdeals-production.up.railway.app/api/stats"
```

Response:
```json
{
  "activeSessions": 1,
  "totalSessionsAllTime": 628,
  "totalApiHitsAllTime": 516,
  "totalToolCallsAllTime": 281,
  "sessionsToday": 3,
  "serverStarted": "2026-03-01T00:00:00.000Z"
}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `search_offers` | Search deals by keyword, category, eligibility, or vendor name. Supports pagination and sorting. |
| `list_categories` | List all available deal categories with offer counts. |
| `get_offer_details` | Get full details for a specific vendor, including related vendors in the same category. |
| `get_deal_changes` | Get recent pricing and free tier changes — removals, reductions, increases, restructures. |

### search_offers

**Parameters:**
- `query` (string, optional) — Keyword to search vendor names, descriptions, and tags
- `category` (string, optional) — Filter to a specific category (e.g. "Databases", "Cloud Hosting")
- `eligibility_type` (string, optional) — Filter by type: `public`, `accelerator`, `oss`, `student`, `fintech`, `geographic`, `enterprise`
- `sort` (string, optional) — Sort results: `vendor` (alphabetical), `category` (by category then vendor), `newest` (most recently verified)
- `limit` (number, optional) — Maximum results to return
- `offset` (number, optional) — Number of results to skip

### list_categories

No parameters. Returns all categories with offer counts.

### get_offer_details

**Parameters:**
- `vendor` (string, required) — Vendor name (case-insensitive match)

### get_deal_changes

**Parameters:**
- `since` (string, optional) — ISO date (YYYY-MM-DD). Only return changes on or after this date. Default: 30 days ago
- `change_type` (string, optional) — Filter: `free_tier_removed`, `limits_reduced`, `limits_increased`, `new_free_tier`, `pricing_restructured`
- `vendor` (string, optional) — Filter by vendor name (case-insensitive partial match)

## Use Cases

### Agent-assisted infrastructure selection

When your AI agent recommends infrastructure, it's usually working from training data — not current pricing. By connecting AgentDeals, the agent can:

1. **Compare free tiers**: "I'm evaluating Supabase vs Neon vs PlanetScale for a side project" — the agent searches each vendor and compares current limits
2. **Check eligibility**: "We're a YC W24 company, what credits can we get?" — the agent filters by `eligibility_type: accelerator` and returns applicable startup programs
3. **Verify before recommending**: Before suggesting a vendor, the agent checks `get_deal_changes` to ensure the free tier hasn't been removed or reduced

### Monitoring deal changes

Track pricing shifts that affect your stack:

1. **Check for changes**: Call `get_deal_changes` with `since: "2025-01-01"` to see all tracked changes in the past year
2. **Filter by vendor**: Call `get_deal_changes` with `vendor: "Vercel"` to see if Vercel's pricing has changed
3. **Filter by type**: Call `get_deal_changes` with `change_type: "free_tier_removed"` to see which vendors have eliminated free tiers

## Categories

AI / ML, Analytics, API Gateway, Auth, Background Jobs, Browser Automation, CDN, CI/CD, Cloud Hosting, Cloud IaaS, Communication, Container Registry, DNS & Domain Management, Databases, Design, Developer Tools, Documentation, Email, Error Tracking, Feature Flags, Forms, Headless CMS, Infrastructure, Logging, Maps/Geolocation, Messaging, Monitoring, Payments, Search, Secrets Management, Security, Status Pages, Storage, Startup Programs, Testing, Video, Web Scraping, Workflow Automation

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm test             # Run tests (66 passing)
npm run serve        # Run HTTP server (port 3000)
npm start            # Run stdio server
```

### Local development with stdio

```bash
npm start
```

### Local development with HTTP

```bash
npm run serve
# Server starts at http://localhost:3000
# MCP endpoint: http://localhost:3000/mcp
# Landing page: http://localhost:3000/
```

## Stats

- **1,502** vendor offers across **38** categories
- **48** tracked pricing changes
- **4** MCP tools + **2** REST API endpoints + `/api/stats`
- **66** passing tests
- Data verified as of 2026-03-03

## Registries

- [MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.robhunter%2Fagentdeals/versions)
- [Glama](https://glama.ai/mcp/connectors/io.github.robhunter/agentdeals)

## License

MIT

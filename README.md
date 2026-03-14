# AgentDeals

[![npm version](https://img.shields.io/npm/v/agentdeals.svg)](https://www.npmjs.com/package/agentdeals)
[![npm downloads](https://img.shields.io/npm/dm/agentdeals.svg)](https://www.npmjs.com/package/agentdeals)

An MCP server that aggregates free tiers, startup credits, and developer tool deals — so your AI agent (or you) can find the best infrastructure offers without leaving the workflow.

AgentDeals indexes real, verified pricing data from 1,500+ developer infrastructure vendors across 53 categories. Available on [npm](https://www.npmjs.com/package/agentdeals) for local use or as a hosted remote server. Connect any MCP-compatible client and search deals by keyword, category, or eligibility.

**Live:** [agentdeals-production.up.railway.app](https://agentdeals-production.up.railway.app)

## Install

### Option A: Claude Code Plugin (one-click)

Install AgentDeals in Claude Code with a single command:

```bash
claude plugin install robhunter/agentdeals
```

This auto-configures the remote MCP server — no local setup needed. All 12 tools, 5 prompt templates, and 2 skills are immediately available.

### Option B: Claude Desktop Extension (one-click)

Install AgentDeals directly in Claude Desktop — no configuration needed:

1. Download the latest `agentdeals.mcpb` from [Releases](https://github.com/robhunter/agentdeals/releases)
2. Double-click the file to install in Claude Desktop
3. All 12 tools and 5 prompt templates are immediately available

Or browse for AgentDeals in Claude Desktop under **Settings > Extensions**.

### Option C: npx (local stdio)

No server needed. Runs locally via stdin/stdout:

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

### Option D: Remote HTTP

Connect to the hosted instance — no install required:

```json
{
  "mcpServers": {
    "agentdeals": {
      "url": "https://agentdeals-production.up.railway.app/mcp"
    }
  }
}
```

## Quick Start

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

Each client supports both **local stdio** (via npx) and **remote HTTP**. Stdio is recommended for reliability and speed.

### Claude Desktop

Add to `claude_desktop_config.json`:

**Stdio (recommended):**
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

**Remote HTTP:**
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

Add to `.cursor/mcp.json` in your project or global config:

**Stdio (recommended):**
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

**Remote HTTP:**
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

**Stdio (recommended):**
```json
{
  "servers": {
    "agentdeals": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "agentdeals"]
    }
  }
}
```

**Remote HTTP:**
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

**Stdio (recommended):**
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

**Remote HTTP:**
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

### More endpoints

```bash
# Recently added offers
curl "https://agentdeals-production.up.railway.app/api/new?days=7"

# Pricing changes
curl "https://agentdeals-production.up.railway.app/api/changes?since=2025-01-01"

# Vendor details
curl "https://agentdeals-production.up.railway.app/api/details/Supabase?alternatives=true"

# Stack recommendation
curl "https://agentdeals-production.up.railway.app/api/stack?use_case=saas"

# Cost estimation
curl "https://agentdeals-production.up.railway.app/api/costs?services=Vercel,Supabase&scale=startup"

# Compare vendors
curl "https://agentdeals-production.up.railway.app/api/compare?a=Supabase&b=Neon"

# Vendor risk check
curl "https://agentdeals-production.up.railway.app/api/vendor-risk/Heroku"

# Stack audit
curl "https://agentdeals-production.up.railway.app/api/audit-stack?services=Vercel,Supabase,Clerk"

# Server stats
curl "https://agentdeals-production.up.railway.app/api/stats"

# OpenAPI spec
curl "https://agentdeals-production.up.railway.app/api/openapi.json"
```

## Available Tools

| Tool | Description |
|------|-------------|
| `search_offers` | Search deals by keyword, category, eligibility, or vendor name. Supports pagination and sorting. |
| `list_categories` | List all available deal categories with offer counts. |
| `get_offer_details` | Get full details for a specific vendor, including related vendors in the same category. |
| `get_new_offers` | Check recently added or updated deals, sorted newest first. |
| `get_deal_changes` | Get recent pricing and free tier changes — removals, reductions, increases, restructures. |
| `get_stack_recommendation` | Get a curated free-tier infrastructure stack for your project type (SaaS, API backend, static site, etc.). |
| `estimate_costs` | Estimate infrastructure costs for your stack at hobby, startup, or growth scale. |
| `compare_services` | Side-by-side comparison of two vendor free tiers, pricing, and differentiators. |
| `check_vendor_risk` | Check if a vendor's free tier pricing is stable — risk level, change history, and safer alternatives. |
| `audit_stack` | Audit your infrastructure stack for cost savings, pricing risks, and coverage gaps. |

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

### get_new_offers

**Parameters:**
- `days` (number, optional) — Number of days to look back. Default: 7

### get_deal_changes

**Parameters:**
- `since` (string, optional) — ISO date (YYYY-MM-DD). Only return changes on or after this date. Default: 30 days ago
- `change_type` (string, optional) — Filter: `free_tier_removed`, `limits_reduced`, `limits_increased`, `new_free_tier`, `pricing_restructured`
- `vendor` (string, optional) — Filter by vendor name (case-insensitive partial match)

### get_stack_recommendation

**Parameters:**
- `use_case` (string, required) — Project type: `saas`, `api`, `static`, `mobile`, `ai_ml`, `ecommerce`, `devops`
- `requirements` (string, optional) — Additional requirements or preferences

### estimate_costs

**Parameters:**
- `services` (string, required) — Comma-separated list of vendor names (e.g. "Vercel,Supabase,Clerk")
- `scale` (string, optional) — Scale tier: `hobby`, `startup`, `growth`. Default: `hobby`

### compare_services

**Parameters:**
- `vendor_a` (string, required) — First vendor name
- `vendor_b` (string, required) — Second vendor name

### check_vendor_risk

**Parameters:**
- `vendor` (string, required) — Vendor name to check

### audit_stack

**Parameters:**
- `services` (string, required) — Comma-separated list of vendor names currently in use

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

AI / ML, AI Coding, API Development, API Gateway, Analytics, Auth, Background Jobs, Browser Automation, CDN, CI/CD, Cloud Hosting, Cloud IaaS, Code Quality, Communication, Container Registry, DNS & Domain Management, Databases, Design, Dev Utilities, Diagramming, Documentation, Email, Error Tracking, Feature Flags, Forms, Headless CMS, IDE & Code Editors, Infrastructure, Localization, Logging, Low-Code Platforms, Maps/Geolocation, Messaging, Mobile Development, Monitoring, Notebooks & Data Science, Payments, Project Management, Search, Secrets Management, Security, Server Management, Source Control, Startup Perks, Startup Programs, Status Pages, Storage, Team Collaboration, Testing, Tunneling & Networking, Video, Web Scraping, Workflow Automation

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm test             # Run tests (159 passing)
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

- **1,511** vendor offers across **53** categories
- **52** tracked pricing changes
- **10** MCP tools + **4** prompt templates + **12** REST API endpoints
- **159** passing tests
- Data verified as of 2026-03-14

## Registries

- [MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.robhunter%2Fagentdeals/versions)
- [Glama](https://glama.ai/mcp/connectors/io.github.robhunter/agentdeals)

## License

MIT

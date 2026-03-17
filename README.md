# AgentDeals

[![npm version](https://img.shields.io/npm/v/agentdeals.svg)](https://www.npmjs.com/package/agentdeals)
[![npm downloads](https://img.shields.io/npm/dm/agentdeals.svg)](https://www.npmjs.com/package/agentdeals)

An MCP server that aggregates free tiers, startup credits, and developer tool deals — so your AI agent (or you) can find the best infrastructure offers without leaving the workflow.

AgentDeals indexes real, verified pricing data from 1,500+ developer infrastructure vendors across 54 categories. Available on [npm](https://www.npmjs.com/package/agentdeals) for local use or as a hosted remote server. Connect any MCP-compatible client and search deals by keyword, category, or eligibility.

**Live:** [agentdeals.dev](https://agentdeals.dev)

## Install

### Option A: Claude Code Plugin (one-click)

Install AgentDeals in Claude Code with a single command:

```bash
claude plugin install robhunter/agentdeals
```

This auto-configures the remote MCP server — no local setup needed. All 4 tools and 6 prompt templates are immediately available.

### Option B: Claude Desktop Extension (one-click)

Install AgentDeals directly in Claude Desktop — no configuration needed:

1. Download the latest `agentdeals.mcpb` from [Releases](https://github.com/robhunter/agentdeals/releases)
2. Double-click the file to install in Claude Desktop
3. All 4 tools and 6 prompt templates are immediately available

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
      "url": "https://agentdeals.dev/mcp"
    }
  }
}
```

## Quick Start

### Try these example queries

**Find free database hosting:**
```
Use the search_deals tool:
  query: "database"
  category: "Databases"
```

Returns Neon (0.5 GiB free Postgres), Supabase (500 MB), MongoDB Atlas (512 MB shared cluster), PlanetScale alternatives, and more.

**What pricing changes happened recently?**
```
Use the track_changes tool (no params for weekly digest, or filter):
  since: "2025-01-01"
```

Returns tracked changes like PlanetScale free tier removal, Heroku free dynos sunset, Render pricing restructure, and other shifts.

**Show deals I qualify for as a YC company:**
```
Use the search_deals tool:
  eligibility: "accelerator"
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
      "url": "https://agentdeals.dev/mcp"
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
      "url": "https://agentdeals.dev/mcp"
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
      "url": "https://agentdeals.dev/mcp"
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
      "url": "https://agentdeals.dev/mcp"
    }
  }
}
```

## REST API

AgentDeals also provides a REST API for programmatic access without MCP.

### Search offers

```bash
# Search by keyword
curl "https://agentdeals.dev/api/offers?q=database&limit=5"

# Filter by category
curl "https://agentdeals.dev/api/offers?category=Databases&limit=10"

# Paginate results
curl "https://agentdeals.dev/api/offers?limit=20&offset=40"

# Combine search + category
curl "https://agentdeals.dev/api/offers?q=postgres&category=Databases"
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
curl "https://agentdeals.dev/api/categories"
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
curl "https://agentdeals.dev/api/new?days=7"

# Pricing changes
curl "https://agentdeals.dev/api/changes?since=2025-01-01"

# Vendor details
curl "https://agentdeals.dev/api/details/Supabase?alternatives=true"

# Stack recommendation
curl "https://agentdeals.dev/api/stack?use_case=saas"

# Cost estimation
curl "https://agentdeals.dev/api/costs?services=Vercel,Supabase&scale=startup"

# Compare vendors
curl "https://agentdeals.dev/api/compare?a=Supabase&b=Neon"

# Vendor risk check
curl "https://agentdeals.dev/api/vendor-risk/Heroku"

# Stack audit
curl "https://agentdeals.dev/api/audit-stack?services=Vercel,Supabase,Clerk"

# Server stats
curl "https://agentdeals.dev/api/stats"

# OpenAPI spec
curl "https://agentdeals.dev/api/openapi.json"
```

## Available Tools

| Tool | Description |
|------|-------------|
| `search_deals` | Find free tiers, browse categories, get vendor details with alternatives. Search by keyword, category, eligibility, or vendor name. |
| `plan_stack` | Get stack recommendations, cost estimates, or a full infrastructure audit for your project. |
| `compare_vendors` | Compare 2 vendors side-by-side or check a single vendor's pricing risk. |
| `track_changes` | Track pricing changes, upcoming expirations, and new deals. Weekly digest with no params. |

### search_deals

**Parameters:**
- `query` (string, optional) — Keyword search (vendor names, descriptions, tags)
- `category` (string, optional) — Filter by category. Pass `"list"` to get all categories with counts.
- `vendor` (string, optional) — Get full details for a specific vendor (fuzzy match). Returns alternatives.
- `eligibility` (string, optional) — Filter: `public`, `accelerator`, `oss`, `student`, `fintech`, `geographic`, `enterprise`
- `sort` (string, optional) — Sort: `vendor` (A-Z), `category`, `newest` (recently verified first)
- `since` (string, optional) — ISO date. Only return deals verified/added after this date.
- `limit` (number, optional) — Max results (default: 20)
- `offset` (number, optional) — Pagination offset

### plan_stack

**Parameters:**
- `mode` (string, required) — `recommend`, `estimate`, or `audit`
- `use_case` (string, optional) — What you're building (for recommend mode)
- `services` (array, optional) — Current vendor names (for estimate/audit mode)
- `scale` (string, optional) — `hobby`, `startup`, `growth` (for estimate mode, default: hobby)
- `requirements` (array, optional) — Specific infra needs (for recommend mode)

### compare_vendors

**Parameters:**
- `vendors` (array, required) — 1 or 2 vendor names. 1 = risk check, 2 = side-by-side comparison.
- `include_risk` (boolean, optional) — Include risk assessment (default: true)

### track_changes

**Parameters:**
- `since` (string, optional) — ISO date. Default: 7 days ago.
- `change_type` (string, optional) — Filter: `free_tier_removed`, `limits_reduced`, `limits_increased`, `new_free_tier`, `pricing_restructured`, etc.
- `vendor` (string, optional) — Filter to one vendor
- `vendors` (string, optional) — Comma-separated vendor names to filter
- `include_expiring` (boolean, optional) — Include upcoming expirations (default: true)
- `lookahead_days` (number, optional) — Days to look ahead for expirations (default: 30)

## Use Cases

### Agent-assisted infrastructure selection

When your AI agent recommends infrastructure, it's usually working from training data — not current pricing. By connecting AgentDeals, the agent can:

1. **Compare free tiers**: "I'm evaluating Supabase vs Neon for a side project" — use `compare_vendors` with both names
2. **Check eligibility**: "We're a YC W24 company, what credits can we get?" — use `search_deals` with `eligibility: "accelerator"`
3. **Verify before recommending**: Use `track_changes` to ensure the free tier hasn't been removed or reduced

### Monitoring deal changes

Track pricing shifts that affect your stack:

1. **Weekly digest**: Call `track_changes` with no params for a curated summary
2. **Filter by vendor**: Call `track_changes` with `vendor: "Vercel"` to see if Vercel's pricing has changed
3. **Filter by type**: Call `track_changes` with `change_type: "free_tier_removed"` to see which vendors have eliminated free tiers

## Categories

AI / ML, AI Coding, API Development, API Gateway, Analytics, Auth, Background Jobs, Browser Automation, CDN, CI/CD, Cloud Hosting, Cloud IaaS, Code Quality, Communication, Container Registry, DNS & Domain Management, Databases, Design, Dev Utilities, Diagramming, Documentation, Email, Error Tracking, Feature Flags, Forms, Headless CMS, IDE & Code Editors, Infrastructure, Localization, Logging, Low-Code Platforms, Maps/Geolocation, Messaging, Mobile Development, Monitoring, Notebooks & Data Science, Payments, Project Management, Search, Secrets Management, Security, Server Management, Source Control, Startup Perks, Startup Programs, Status Pages, Storage, Team Collaboration, Testing, Tunneling & Networking, Video, Web Scraping, Workflow Automation

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm test             # Run tests (266 passing)
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

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `3000` |
| `BASE_URL` | Base URL for canonical links, OG tags, sitemaps, and feeds | `https://agentdeals.dev` |
| `GOOGLE_SITE_VERIFICATION` | Google Search Console verification code | _(none)_ |

## Stats

- **1,525** vendor offers across **54** categories
- **57** tracked pricing changes
- **4** MCP tools + **6** prompt templates + **17** REST API endpoints
- **266** passing tests
- Data verified as of 2026-03-14

## Registries

- [MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.robhunter%2Fagentdeals/versions)
- [Glama](https://glama.ai/mcp/connectors/io.github.robhunter/agentdeals)

## License

MIT

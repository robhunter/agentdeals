# AgentDeals

An MCP server that aggregates free tiers, startup credits, and developer tool deals — so your AI agent (or you) can find the best infrastructure offers without leaving the workflow.

AgentDeals indexes real, verified pricing data from 100 developer infrastructure vendors across 22 categories. Connect any MCP-compatible client and search deals by keyword or category.

## Quick Start — Remote (Recommended)

AgentDeals is hosted and ready to use. Add it to your MCP client config:

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "agentdeals": {
      "url": "https://agentdeals-production.up.railway.app/mcp"
    }
  }
}
```

**Any MCP client** — point to:
```
https://agentdeals-production.up.railway.app/mcp
```

## Quick Start — Local (stdio)

```bash
git clone https://github.com/robhunter/agentdeals.git
cd agentdeals
npm install && npm run build
npm start
```

Once published to npm, you'll be able to run:
```bash
npx agentdeals
```

## Available Tools

| Tool | Description |
|------|-------------|
| `search_offers` | Search deals by keyword, category, or vendor name. Supports pagination via limit/offset. |
| `list_categories` | List all available deal categories (Cloud Hosting, Databases, CI/CD, etc.). |
| `get_offer_details` | Get full details for a specific vendor, including related vendors in the same category. |

### search_offers

**Parameters:**
- `query` (string, optional) — Keyword to search vendor names, descriptions, and tags
- `category` (string, optional) — Filter to a specific category
- `limit` (number, optional) — Maximum results to return
- `offset` (number, optional) — Number of results to skip

### list_categories

No parameters. Returns all categories with offer counts.

### get_offer_details

**Parameters:**
- `vendor` (string, required) — Vendor name (case-insensitive match)

## Example

**Request:** Search for free database offers
```json
{
  "method": "tools/call",
  "params": {
    "name": "search_offers",
    "arguments": {
      "query": "database",
      "category": "Databases"
    }
  }
}
```

**Response:**
```json
[
  {
    "vendor": "Neon",
    "category": "Databases",
    "description": "Serverless Postgres with 0.5 GiB storage, 100 CU-hours/month compute on free tier",
    "tier": "Free",
    "url": "https://neon.com/pricing",
    "tags": ["database", "postgres", "serverless"]
  },
  {
    "vendor": "MongoDB Atlas",
    "category": "Databases",
    "description": "512 MB shared cluster (M0) free forever, supports replica sets",
    "tier": "Free",
    "url": "https://www.mongodb.com/pricing",
    "tags": ["database", "nosql", "document", "mongodb"]
  }
]
```

## Categories

AI / ML, Analytics, Auth, Background Jobs, CDN, CI/CD, Cloud Hosting, Cloud IaaS, DNS & Domain Management, Databases, Developer Tools, Email, Feature Flags, Headless CMS, Infrastructure, Logging, Messaging, Monitoring, Payments, Search, Storage, Web Scraping

## Stats

- **100** vendor offers across **22** categories
- Data verified as of 2026-02-25

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm test             # Run tests (30 passing)
npm run serve        # Run HTTP server (port 3000)
npm start            # Run stdio server
```

## License

MIT

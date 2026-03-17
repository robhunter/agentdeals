# AgentDeals

## Project Goals

A remote MCP server that aggregates publicly available discounts, free tiers, startup programs, and promotional offers from developer infrastructure companies. AI agents (and humans) can query it to find deals relevant to their projects.

## Success Criteria

- Working MCP server responding to `search_deals`, `plan_stack`, `compare_vendors`, and `track_changes` tools
- Index of real vendor offers with verified data
- Deployed and accessible (ngrok for dev, hosted service for launch)
- Registered on MCP registries

## Mode

**Fast-moving toy project.** Bias toward speed over correctness. Ship early, iterate. This may become a production project if it gains traction.

## Tech Stack

- **Language:** TypeScript
- **Framework:** MCP SDK (`@modelcontextprotocol/sdk`)
- **Runtime:** Node.js (>=20)
- **Index:** JSON file loaded into memory on server start
- **Deploy:** ngrok for dev, hosted service (Railway/Render/Fly) when approaching launch

## Conventions

- Tests: Node.js built-in test runner (`node --test`)
- PRs: Squash merge preferred
- Branches: `<issue-number>-<short-description>`
- Index data: `data/index.json` — structured vendor offer entries

## Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run dev          # Run in development mode
npm test             # Run tests
npm start            # Run compiled server (stdio transport)
npm run serve        # Run HTTP server (streamable-http transport)
```

### HTTP Transport

The server supports two transport modes:

- **stdio** (`npm start`): For local MCP clients that communicate over stdin/stdout
- **HTTP** (`npm run serve`): For remote access via streamable-http transport at `/mcp`

The HTTP server port defaults to 3000 and can be configured via the `PORT` environment variable:

```bash
PORT=8080 npm run serve
```

Endpoints:
- `POST /mcp` — MCP JSON-RPC requests (requires `Accept: application/json, text/event-stream` header)
- `GET /mcp` — SSE stream for server-initiated notifications
- `DELETE /mcp` — Session termination
- `GET /health` — Health check
- `GET /.well-known/glama.json` — Glama registry ownership verification

## Current Status

MCP server is functional with stdio and HTTP transports. 4 intent-based tools (search_deals, plan_stack, compare_vendors, track_changes) + 6 prompt templates. 1,525 offers across 54 categories with eligibility schema (accelerator, oss, fintech, student types). 57 tracked pricing changes. 17 REST API endpoints. HTML landing page with interactive deal browser and OG meta tags. 266 passing tests. Multi-session HTTP support with idle timeout cleanup and structured connection logging. Deployed on Railway. Listed on Official MCP Registry and Glama. Registry manifests in place (server.json, glama.json, smithery.yaml). Staleness detection, pricing change monitor, bulk ingestion scripts, and category recategorization script available.

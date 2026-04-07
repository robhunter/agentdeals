# Free Tier Monitor GitHub Action

Monitor the free tier status and stability of your project's dependencies. Get alerts when vendor pricing changes could affect your stack.

## How It Works

1. Parses your `package.json` to identify dependencies
2. Maps npm packages to vendor names (e.g., `@supabase/*` -> Supabase)
3. Queries the [AgentDeals API](https://agentdeals.dev) for each matched vendor
4. Reports: free tier description, stability rating, and recent pricing changes

## Quick Start

Add this workflow to `.github/workflows/free-tier-monitor.yml`:

```yaml
name: Free Tier Monitor
on:
  schedule:
    - cron: '0 9 * * 1'  # Weekly on Monday at 9am
  pull_request:

jobs:
  check-free-tiers:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: robhunter/agentdeals/packages/github-action@main
        with:
          package-json-path: './package.json'
          post-pr-comment: true
          alert-threshold: 'watch'
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Input | Description | Default |
|-------|-------------|---------|
| `package-json-path` | Path to your package.json file | `./package.json` |
| `post-pr-comment` | Post a PR comment when vendors have elevated stability ratings | `true` |
| `alert-threshold` | Minimum stability rating for alerts (`watch` or `volatile`) | `watch` |

## Outputs

| Output | Description |
|--------|-------------|
| `vendor-count` | Number of recognized vendors found in dependencies |
| `alert-count` | Number of vendors with elevated stability ratings |

## Example Output

### Job Summary

> ## Free Tier Monitor Report
>
> Found **8** vendors from your dependencies:
>
> | Vendor | Free Tier | Stability | Recent Change |
> |--------|-----------|-----------|---------------|
> | Supabase (@supabase/supabase-js) | 500 MB Postgres, 50K MAU | Watch | Project pause policy tightened |
> | Vercel (next) | Hobby plan, 100 GB/mo | Watch | -- |
> | Cloudflare Workers (wrangler) | 100K requests/day | Stable | -- |
> | Stripe (stripe) | No free tier (2.9% + 30c) | Stable | -- |
>
> 2 vendors have an elevated stability rating. Review before committing to long-term use.

### PR Comment (when threshold is met)

When a pull request adds or modifies dependencies with `watch` or `volatile` stability, the action posts a comment highlighting affected vendors.

## Stability Ratings

| Rating | Meaning |
|--------|---------|
| Stable | Free tier has been consistent, low risk of changes |
| Improving | Vendor has recently expanded their free tier |
| Watch | Some recent pricing changes detected |
| Volatile | Frequent or significant pricing changes |

## Vendor Coverage

The action ships with a curated mapping of 90+ npm package patterns to vendor names, covering:

- Cloud platforms (AWS, GCP, Azure, Vercel, Netlify, Cloudflare, Railway, Render, Fly.io)
- Databases (Supabase, Neon, MongoDB Atlas, Turso, Upstash, Redis, Fauna, CockroachDB)
- Auth (Auth0, Clerk)
- Payments (Stripe)
- Email (Resend, Postmark, SendGrid)
- Monitoring (Sentry, Datadog, Grafana, Highlight.io, Better Stack)
- AI/ML (OpenAI, Anthropic, Cohere, Hugging Face)
- Analytics (PostHog, Segment)
- Search (Algolia, Meilisearch, Typesense)
- Messaging (Slack, Discord)
- And more

Unrecognized packages are silently skipped.

## Tests

```bash
node --test index.test.cjs
```

## Data Source

All data comes from [AgentDeals](https://agentdeals.dev), which tracks 1,600+ vendor free tiers with verification within 30 days.

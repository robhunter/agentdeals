# Contributing to AgentDeals

Thanks for helping expand the index! AgentDeals tracks free tiers, startup programs, and developer deals across 52+ categories.

## How to Submit a Deal

1. Fork the repo and create a branch
2. Add your entry to `data/index.json` (see schema below)
3. Run `npm run validate` to check your entry
4. Open a PR with a brief description of what you added

## Offer Entry Schema

Each entry in `data/index.json` has these **required** fields:

| Field | Type | Description |
|-------|------|-------------|
| `vendor` | string | Company or product name (e.g. "Vercel", "Supabase") |
| `category` | string | One of the [valid categories](#valid-categories) |
| `description` | string | What the free tier includes (min 30 characters). Be specific about limits. |
| `tier` | string | Plan name (e.g. "Free", "Hobby", "OSS", "Startup Program") |
| `url` | string | Link to the vendor's pricing or product page |
| `tags` | string[] | Relevant keywords for search (e.g. `["hosting", "serverless"]`) |
| `verifiedDate` | string | ISO date (YYYY-MM-DD) when you personally verified the deal on the vendor's site |

### Optional fields

| Field | Type | Description |
|-------|------|-------------|
| `eligibility` | object | For conditional deals (startup programs, OSS sponsorships). See example below. |

### Example: Standard free tier entry

```json
{
  "vendor": "Supabase",
  "category": "Databases",
  "description": "Postgres database with 500 MB storage, 2 GB bandwidth, 50K monthly active users, 1 GB file storage, 200 concurrent Realtime connections",
  "tier": "Free",
  "url": "https://supabase.com/pricing",
  "tags": ["database", "postgres", "auth", "storage", "realtime"],
  "verifiedDate": "2026-02-24"
}
```

### Example: Conditional deal (startup program)

```json
{
  "vendor": "AWS",
  "category": "Startup Programs",
  "description": "Activate Founders: $1,000 in credits for self-funded startups. Activate: up to $100K credits for funded startups with approved VC/accelerator backing",
  "tier": "Activate",
  "url": "https://aws.amazon.com/activate/",
  "tags": ["cloud", "iaas", "startup-credits"],
  "verifiedDate": "2026-02-25",
  "eligibility": {
    "type": "accelerator",
    "conditions": ["Self-funded or backed by approved VC/accelerator"],
    "program": "AWS Activate"
  }
}
```

## Deal Changes Entry Schema

If a vendor has changed their free tier (removed it, reduced limits, etc.), add an entry to `data/deal_changes.json`:

```json
{
  "vendor": "PlanetScale",
  "change_type": "free_tier_removed",
  "date": "2024-04-08",
  "summary": "Free Hobby database plan removed entirely. All databases now require paid Scaler plan ($39/mo minimum)",
  "previous_state": "Free Hobby plan: 1 database, 5GB storage, 1B row reads/mo",
  "current_state": "No free tier. Scaler plan starts at $39/month",
  "impact": "high",
  "source_url": "https://planetscale.com/blog/planetscale-forever",
  "category": "Databases",
  "alternatives": ["Neon", "Supabase", "TiDB Cloud"]
}
```

## Valid Categories

AgentDeals uses a fixed set of 52 categories. Your entry's `category` must be one of:

AI / ML, API Development, API Gateway, Analytics, Auth, Background Jobs, Browser Automation, CDN, CI/CD, Cloud Hosting, Cloud IaaS, Code Quality, Communication, Container Registry, DNS & Domain Management, Databases, Design, Dev Utilities, Diagramming, Documentation, Email, Error Tracking, Feature Flags, Forms, Headless CMS, IDE & Code Editors, Infrastructure, Localization, Logging, Low-Code Platforms, Maps/Geolocation, Messaging, Mobile Development, Monitoring, Notebooks & Data Science, Payments, Project Management, Search, Secrets Management, Security, Server Management, Source Control, Startup Perks, Startup Programs, Status Pages, Storage, Team Collaboration, Testing, Tunneling & Networking, Video, Web Scraping, Workflow Automation

## Validation

Run `npm run validate` before submitting your PR. It checks:

- All required fields are present
- No duplicate entries (same vendor + category)
- URLs are valid format
- Descriptions are at least 30 characters
- `verifiedDate` is a valid ISO date (YYYY-MM-DD)
- Category is in the valid set

The script must exit cleanly (exit code 0) for your PR to be accepted.

## Guidelines

- **Verify before adding.** Visit the vendor's pricing page and confirm the free tier exists. Set `verifiedDate` to today's date.
- **Be specific in descriptions.** "Free tier available" is not enough. Include actual limits (storage, requests, users, etc.).
- **Genuine free tiers only.** No time-limited trials (14-day, 30-day). Credits with expiration are OK if clearly noted.
- **One entry per vendor per category.** If a vendor offers both a free tier and a startup program, use different categories (e.g. "Databases" for the free tier, "Startup Programs" for the startup deal).
